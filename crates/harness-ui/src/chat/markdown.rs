use super::ChatView;
use super::code_extensions::code_file_extension;
use crate::chrome;
use crate::motion_icon::motion_icon;
use crate::theme::{
    RADIUS_MD, RADIUS_SM, Theme, ThemeMode, github_highlight_theme_for_language,
    native_syntax_language, web_ease_out,
};
use crate::tracked_text::{TrackedText, TrackedTextLayout, tracked_text};
use crate::zoom::px;
use ::markdown::{ParseOptions, mdast::Node};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use futures::AsyncReadExt as _;
use gpui::{
    Animation, AnimationExt, AnyElement, App, BorderStyle, Bounds, ClipboardItem, CursorStyle,
    Edges, Element, ElementId, Entity, FocusHandle, FontWeight, GlobalElementId, HighlightStyle,
    Hitbox, HitboxBehavior, Image, ImageFormat, ImageSource, InspectorElementId, LayoutId,
    MouseButton, ObjectFit, Pixels, Point, SharedString, StyleRefinement, Styled, StyledImage,
    StyledText, TextLayout, Window, div, img, point, prelude::*, quad, relative, rems,
};
use gpui_component::Rope;
use gpui_component::highlighter::SyntaxHighlighter;
use gpui_component::scroll::ScrollableElement;
use gpui_component::text::{TextView, TextViewStyle};
use html5ever::{parse_document, tendril::TendrilSink as _};
use markup5ever_rcdom::{Handle as HtmlHandle, NodeData as HtmlNodeData, RcDom};
use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

const STREAM_WORD_DURATION_MS: u64 = 160;
const STREAM_WORD_STAGGER_MS: u64 = 14;
const STREAM_CLEANUP_PADDING: Duration = Duration::from_millis(80);
const SPACE_WIDTH: f32 = 3.7;
const MARKDOWN_MAX_WIDTH_CH: f32 = 72.0;
const SYNTAX_HIGHLIGHT_CACHE_LIMIT: usize = 128;

thread_local! {
    static MARKDOWN_MAX_WIDTHS: RefCell<HashMap<(SharedString, u32), Pixels>> =
        RefCell::new(HashMap::new());
}

#[derive(Clone, Copy)]
struct InlineTracking {
    letter_spacing_em: f32,
    space_width: f32,
}

#[derive(Clone, Debug)]
pub(super) struct StreamRevealBatch {
    generation: u64,
    from: usize,
    to: usize,
    expires_at: Instant,
}

impl ChatView {
    pub(super) fn reset_stream_reveals(&mut self) {
        self.stream_reveal_generation = self.stream_reveal_generation.wrapping_add(1);
        self.stream_reveal_batches.clear();
    }

    pub(super) fn start_stream_reveal(
        &mut self,
        item_id: String,
        from: usize,
        to: usize,
        text: &str,
        cx: &mut gpui::Context<Self>,
    ) {
        if from >= to || self.theme.reduced_motion {
            return;
        }
        let word_count = text.split_whitespace().count().max(1) as u64;
        let duration = stream_batch_duration(word_count);
        self.stream_reveal_generation = self.stream_reveal_generation.wrapping_add(1);
        self.stream_reveal_batches
            .entry(item_id)
            .or_default()
            .push(StreamRevealBatch {
                generation: self.stream_reveal_generation,
                from,
                to,
                expires_at: Instant::now() + duration + STREAM_CLEANUP_PADDING,
            });
        self.schedule_stream_reveal_cleanup(cx);
    }

    fn schedule_stream_reveal_cleanup(&mut self, cx: &mut gpui::Context<Self>) {
        if self.stream_reveal_cleanup_scheduled || self.stream_reveal_batches.is_empty() {
            return;
        }
        self.stream_reveal_cleanup_scheduled = true;
        cx.spawn(async move |view, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(STREAM_WORD_DURATION_MS))
                .await;
            let _ = view.update(cx, |this, cx| {
                this.stream_reveal_cleanup_scheduled = false;
                let now = Instant::now();
                let before = this
                    .stream_reveal_batches
                    .values()
                    .map(Vec::len)
                    .sum::<usize>();
                this.stream_reveal_batches.retain(|_, batches| {
                    batches.retain(|batch| batch.expires_at > now);
                    !batches.is_empty()
                });
                let after = this
                    .stream_reveal_batches
                    .values()
                    .map(Vec::len)
                    .sum::<usize>();
                if before != after {
                    cx.notify();
                }
                this.schedule_stream_reveal_cleanup(cx);
            });
        })
        .detach();
    }

    pub(super) fn close_markdown_table_overlay(&mut self, cx: &mut gpui::Context<Self>) {
        if self.markdown_table_overlay.take().is_some() {
            cx.notify();
        }
    }

    fn scroll_markdown_anchor(&mut self, distance: Pixels, cx: &mut gpui::Context<Self>) {
        self.transcript_scroll_mode
            .set(super::TranscriptScrollMode::Free);
        self.list_state.scroll_by(distance);
        cx.notify();
    }

    pub(super) fn markdown_table_overlay(
        &self,
        window: &mut Window,
        cx: &mut gpui::Context<Self>,
    ) -> Option<AnyElement> {
        let overlay = self.markdown_table_overlay.as_ref()?;
        let definitions = HashMap::new();
        let footnote_numbers = HashMap::new();
        let footnote_reference_offsets = HashMap::new();
        let view = cx.entity();
        let selection = window.use_keyed_state(
            SharedString::from(format!(
                "markdown-table-fullscreen-selection:{}",
                overlay.id
            )),
            cx,
            |_, cx| MarkdownSelectionState::new(overlay.source.clone(), cx),
        );
        selection.update(cx, |selection, _| {
            selection.set_source(&overlay.source);
        });
        let context = RenderContext {
            id: "markdown-table-fullscreen",
            raw: "",
            streaming: false,
            reveals: &[],
            definitions: &definitions,
            footnote_numbers: &footnote_numbers,
            footnote_reference_offsets: &footnote_reference_offsets,
            theme: self.theme,
            interface_font: self.interface_font.clone(),
            view: view.clone(),
            selection: selection.clone(),
            reveal_ordinals: RefCell::new(HashMap::new()),
        };
        let rows = render_table_rows(&overlay.table, &context);
        let group: SharedString = "markdown-table-fullscreen-group".into();
        let controls_state = window.use_keyed_state(
            SharedString::from(format!(
                "markdown-table-fullscreen-controls-state:{}",
                overlay.id
            )),
            cx,
            |_, _| TableControlsState::default(),
        );
        let fullscreen_id = format!("markdown-table-fullscreen:{}", overlay.id);
        let controls = table_controls(
            &fullscreen_id,
            overlay.data.clone(),
            TableControlStyle {
                group: group.clone(),
                theme: self.theme,
                enabled: true,
            },
            controls_state,
            None,
            cx,
        );
        let close = table_control_button(
            "markdown-table-fullscreen-close".into(),
            "icons/x.svg",
            group.clone(),
            self.theme,
            true,
            true,
            move |cx| {
                view.update(cx, |this, cx| this.close_markdown_table_overlay(cx));
            },
        );
        let table = selectable_markdown_region(
            div()
                .id("markdown-table-fullscreen-scroll")
                .flex_1()
                .min_h(px(0.0))
                .overflow_scroll()
                .px(px(16.0))
                .pb(px(16.0))
                .text_size(px(12.5))
                .child(div().w_full().children(rows)),
            selection,
            cx,
        );

        Some(
            div()
                .id("markdown-table-fullscreen")
                .group(group)
                .occlude()
                .absolute()
                .inset(px(0.0))
                .flex()
                .flex_col()
                .bg(self.theme.background.hsla())
                .child(
                    div()
                        .h(px(56.0))
                        .flex_none()
                        .flex()
                        .items_center()
                        .justify_end()
                        .gap(px(3.0))
                        .px(px(16.0))
                        .child(controls)
                        .child(close),
                )
                .child(table)
                .into_any_element(),
        )
    }
}

fn stream_batch_duration(word_count: u64) -> Duration {
    Duration::from_millis(
        STREAM_WORD_DURATION_MS
            + STREAM_WORD_STAGGER_MS.saturating_mul(word_count.saturating_sub(1)),
    )
}

pub(super) fn markdown_view(
    id: String,
    text: String,
    streaming: bool,
    reveals: &[StreamRevealBatch],
    view: Entity<ChatView>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let view_state = view.read(cx);
    let theme = view_state.theme;
    let interface_font = view_state.interface_font.clone();
    let max_width = markdown_max_width(&interface_font, window);
    let selection = window.use_keyed_state(
        SharedString::from(format!("{id}/selection")),
        cx,
        |_, cx| MarkdownSelectionState::new(text.clone(), cx),
    );
    selection.update(cx, |selection, _| selection.set_source(&text));
    let parsed = selection.read(cx).document.root.clone();
    let Some(root) = parsed.as_deref() else {
        return fallback_markdown(id, text, theme, interface_font, window, cx);
    };
    let definitions = collect_definitions(&root.children);
    let footnotes = collect_footnotes(&root.children);
    let context = RenderContext {
        id: &id,
        raw: &text,
        streaming,
        reveals,
        definitions: &definitions,
        footnote_numbers: &footnotes.numbers,
        footnote_reference_offsets: &footnotes.reference_offsets,
        theme,
        interface_font: interface_font.clone(),
        view,
        selection: selection.clone(),
        reveal_ordinals: RefCell::new(HashMap::new()),
    };
    let mut blocks = Vec::with_capacity(root.children.len());
    let visible_count = root
        .children
        .iter()
        .filter(|node| !matches!(node, Node::Definition(_) | Node::FootnoteDefinition(_)))
        .count();
    let has_footnotes = footnotes.has_visible_definitions();
    let mut visible_index = 0;
    for node in &root.children {
        if matches!(node, Node::Definition(_) | Node::FootnoteDefinition(_)) {
            continue;
        }
        blocks.push(render_block(
            node,
            visible_index == 0,
            visible_index + 1 == visible_count && !has_footnotes,
            0,
            &context,
            window,
            cx,
        ));
        visible_index += 1;
    }
    if has_footnotes {
        blocks.push(render_footnotes(&footnotes, &context, window, cx));
    }

    selectable_markdown_region(
        div()
            .id(SharedString::from(id))
            .w_full()
            .max_w(max_width)
            .font_family(interface_font)
            .text_size(px(15.0))
            .line_height(relative(1.52))
            .text_color(theme.response_text.hsla())
            .children(blocks),
        selection,
        cx,
    )
    .into_any_element()
}

fn markdown_max_width(interface_font: &SharedString, window: &mut Window) -> Pixels {
    let zoom = crate::zoom::factor();
    let key = (interface_font.clone(), zoom.to_bits());
    if let Some(width) = MARKDOWN_MAX_WIDTHS.with(|widths| widths.borrow().get(&key).copied()) {
        return width;
    }

    let zero = SharedString::from("0");
    let run = gpui::TextRun {
        len: zero.len(),
        font: gpui::font(interface_font.clone()),
        color: gpui::black(),
        background_color: None,
        underline: None,
        strikethrough: None,
    };
    let zero_width = window
        .text_system()
        .shape_line(zero, px(15.0), std::slice::from_ref(&run), None)
        .width;
    let width = gpui::px(f32::from(zero_width) * MARKDOWN_MAX_WIDTH_CH);
    MARKDOWN_MAX_WIDTHS.with(|widths| widths.borrow_mut().insert(key, width));
    width
}

#[derive(Clone)]
struct MarkdownSelectionSegment {
    source_start: usize,
    source_end: usize,
    text: SharedString,
    selected: Option<Range<usize>>,
    space_after: bool,
}

struct MarkdownSelectionState {
    focus: FocusHandle,
    document: MarkdownDocument,
    syntax_highlights: SyntaxHighlightCache,
    start: Option<Point<Pixels>>,
    end: Option<Point<Pixels>>,
    is_selecting: bool,
    segments: BTreeMap<String, MarkdownSelectionSegment>,
    anchors: HashMap<String, Bounds<Pixels>>,
}

impl MarkdownSelectionState {
    fn new(source: String, cx: &mut gpui::Context<Self>) -> Self {
        Self {
            focus: cx.focus_handle(),
            document: MarkdownDocument::new(source),
            syntax_highlights: SyntaxHighlightCache::default(),
            start: None,
            end: None,
            is_selecting: false,
            segments: BTreeMap::new(),
            anchors: HashMap::new(),
        }
    }

    fn set_source(&mut self, source: &str) {
        if self.document.set_source(source) {
            self.clear();
            self.segments.clear();
            self.anchors.clear();
        }
    }

    fn start(&mut self, position: Point<Pixels>) {
        self.start = Some(position);
        self.end = Some(position);
        self.is_selecting = true;
        for segment in self.segments.values_mut() {
            segment.selected = None;
        }
    }

    fn update(&mut self, position: Point<Pixels>) {
        if self.is_selecting {
            self.end = Some(position);
        }
    }

    fn finish(&mut self) {
        self.is_selecting = false;
    }

    fn clear(&mut self) {
        self.start = None;
        self.end = None;
        self.is_selecting = false;
        for segment in self.segments.values_mut() {
            segment.selected = None;
        }
    }

    fn has_selection(&self) -> bool {
        self.start
            .zip(self.end)
            .is_some_and(|(start, end)| start != end)
    }

    fn selection_bounds(&self) -> Option<Bounds<Pixels>> {
        let (start, end) = self.start.zip(self.end)?;
        (start != end).then(|| {
            Bounds::from_corners(
                point(start.x.min(end.x), start.y.min(end.y)),
                point(start.x.max(end.x), start.y.max(end.y)),
            )
        })
    }

    fn update_segment(
        &mut self,
        key: String,
        source_start: usize,
        source_end: usize,
        text: SharedString,
        selected: Option<Range<usize>>,
        space_after: bool,
    ) {
        self.segments.insert(
            key,
            MarkdownSelectionSegment {
                source_start,
                source_end,
                text,
                selected,
                space_after,
            },
        );
    }

    fn selected_text(&self) -> Option<String> {
        if !self.has_selection() {
            return None;
        }
        selected_markdown_text(&self.document.source, self.segments.values())
    }

    fn update_anchor(&mut self, key: String, bounds: Bounds<Pixels>) {
        self.anchors.insert(key, bounds);
    }

    fn anchor_distance(&self, from: &str, to: &str) -> Option<Pixels> {
        let from = self.anchors.get(from)?;
        let to = self.anchors.get(to)?;
        Some(to.top() - from.top())
    }
}

#[derive(Clone)]
struct SyntaxHighlightCacheEntry {
    language: SharedString,
    source_revision: u64,
    source_ptr: usize,
    source_hash: u64,
    source_len: usize,
    highlights: Vec<(Range<usize>, HighlightStyle)>,
}

impl SyntaxHighlightCacheEntry {
    fn new(
        language: &str,
        source_revision: u64,
        source_hash: u64,
        source: &str,
        highlights: Vec<(Range<usize>, HighlightStyle)>,
    ) -> Self {
        Self {
            language: language.to_owned().into(),
            source_revision,
            source_ptr: source.as_ptr() as usize,
            source_hash,
            source_len: source.len(),
            highlights,
        }
    }
}

#[derive(Default)]
struct SyntaxHighlightCache {
    entries: HashMap<(usize, bool), SyntaxHighlightCacheEntry>,
}

impl SyntaxHighlightCache {
    fn lookup(
        &mut self,
        start: usize,
        dark: bool,
        language: &str,
        source_revision: u64,
        source: &str,
    ) -> Result<Vec<(Range<usize>, HighlightStyle)>, u64> {
        let source_ptr = source.as_ptr() as usize;
        let Some(entry) = self.entries.get_mut(&(start, dark)) else {
            return Err(stable_hash(source));
        };
        if entry.language.as_ref() != language || entry.source_len != source.len() {
            return Err(stable_hash(source));
        }
        if entry.source_revision == source_revision && entry.source_ptr == source_ptr {
            return Ok(entry.highlights.clone());
        }
        let source_hash = stable_hash(source);
        if entry.source_hash != source_hash {
            return Err(source_hash);
        }
        entry.source_revision = source_revision;
        entry.source_ptr = source_ptr;
        Ok(entry.highlights.clone())
    }

    fn insert(&mut self, start: usize, dark: bool, entry: SyntaxHighlightCacheEntry) {
        let key = (start, dark);
        if self.entries.len() >= SYNTAX_HIGHLIGHT_CACHE_LIMIT
            && !self.entries.contains_key(&key)
            && let Some(eviction_key) = self.entries.keys().next().copied()
        {
            self.entries.remove(&eviction_key);
        }
        self.entries.insert(key, entry);
    }
}

struct MarkdownDocument {
    source: String,
    root: Option<Arc<::markdown::mdast::Root>>,
    revision: u64,
}

impl MarkdownDocument {
    fn new(source: String) -> Self {
        let root = parse_markdown_root(&source);
        Self {
            source,
            root,
            revision: 0,
        }
    }

    fn set_source(&mut self, source: &str) -> bool {
        if self.source == source {
            return false;
        }
        self.source.clear();
        self.source.push_str(source);
        self.root = parse_markdown_root(source);
        self.revision = self.revision.wrapping_add(1);
        true
    }
}

fn parse_markdown_root(source: &str) -> Option<Arc<::markdown::mdast::Root>> {
    match ::markdown::to_mdast(source, &ParseOptions::gfm()).ok()? {
        Node::Root(root) => Some(Arc::new(root)),
        _ => None,
    }
}

fn selectable_markdown_region(
    region: gpui::Stateful<gpui::Div>,
    selection: Entity<MarkdownSelectionState>,
    cx: &mut App,
) -> gpui::Stateful<gpui::Div> {
    let focus = selection.read(cx).focus.clone();
    let focus_for_down = focus.clone();
    let selection_for_down = selection.clone();
    let selection_for_move = selection.clone();
    let selection_for_up = selection.clone();
    let selection_for_up_out = selection.clone();
    let selection_for_down_out = selection.clone();
    let selection_for_key = selection;
    region
        .track_focus(&focus)
        .on_mouse_down(MouseButton::Left, move |event, window, cx| {
            focus_for_down.focus(window);
            selection_for_down.update(cx, |selection, _| {
                selection.start(event.position);
            });
            cx.notify(window.current_view());
        })
        .on_mouse_move(move |event, window, cx| {
            let selecting = selection_for_move.read(cx).is_selecting;
            if selecting {
                selection_for_move.update(cx, |selection, _| {
                    selection.update(event.position);
                });
                cx.notify(window.current_view());
            }
        })
        .on_mouse_up(MouseButton::Left, move |_event, window, cx| {
            let selecting = selection_for_up.read(cx).is_selecting;
            if selecting {
                selection_for_up.update(cx, |selection, _| selection.finish());
                cx.notify(window.current_view());
            }
        })
        .on_mouse_up_out(MouseButton::Left, move |event, window, cx| {
            let selecting = selection_for_up_out.read(cx).is_selecting;
            if selecting {
                selection_for_up_out.update(cx, |selection, _| {
                    selection.update(event.position);
                    selection.finish();
                });
                cx.notify(window.current_view());
            }
        })
        .on_mouse_down_out(move |_event, window, cx| {
            let had_selection = selection_for_down_out.read(cx).has_selection();
            if had_selection {
                selection_for_down_out.update(cx, |selection, _| selection.clear());
                cx.notify(window.current_view());
            }
        })
        .on_key_down(move |event, _window, cx| {
            if event.keystroke.modifiers.secondary()
                && event.keystroke.key.eq_ignore_ascii_case("c")
                && let Some(text) = selection_for_key.read(cx).selected_text()
            {
                cx.write_to_clipboard(ClipboardItem::new_string(text));
                cx.stop_propagation();
            }
        })
}

struct RenderContext<'a> {
    id: &'a str,
    raw: &'a str,
    streaming: bool,
    reveals: &'a [StreamRevealBatch],
    definitions: &'a HashMap<String, String>,
    footnote_numbers: &'a HashMap<String, usize>,
    footnote_reference_offsets: &'a HashMap<String, Vec<usize>>,
    theme: Theme,
    interface_font: SharedString,
    view: Entity<ChatView>,
    selection: Entity<MarkdownSelectionState>,
    reveal_ordinals: RefCell<HashMap<u64, usize>>,
}

struct FootnoteData<'a> {
    definitions: HashMap<String, &'a ::markdown::mdast::FootnoteDefinition>,
    order: Vec<String>,
    numbers: HashMap<String, usize>,
    reference_counts: HashMap<String, usize>,
    reference_offsets: HashMap<String, Vec<usize>>,
}

impl FootnoteData<'_> {
    fn has_visible_definitions(&self) -> bool {
        self.order
            .iter()
            .any(|identifier| self.definitions.contains_key(identifier))
    }
}

fn render_footnotes(
    footnotes: &FootnoteData<'_>,
    context: &RenderContext<'_>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let first_definition_start = footnotes
        .order
        .iter()
        .filter_map(|identifier| footnotes.definitions.get(identifier))
        .filter_map(|definition| definition.position.as_ref())
        .map(|position| position.start.offset)
        .min()
        .unwrap_or(context.raw.len());
    let heading_key = format!("{}:footnotes-heading", context.id);
    let heading = SelectableText::plain(
        "Footnotes",
        SelectableTextSpec {
            key: heading_key,
            source_start: first_definition_start,
            source_end: first_definition_start,
            space_after: false,
        },
        context.selection.clone(),
        context.theme,
    );
    let rows = footnotes
        .order
        .iter()
        .filter_map(|identifier| {
            let definition = *footnotes.definitions.get(identifier)?;
            let number = *footnotes.numbers.get(identifier)?;
            let reference_count = *footnotes.reference_counts.get(identifier).unwrap_or(&1);
            Some(render_footnote_definition(
                definition,
                identifier,
                number,
                reference_count,
                context,
                window,
                cx,
            ))
        })
        .collect::<Vec<_>>();

    div()
        .w_full()
        .child(
            div()
                .mt(px(18.0))
                .mb(px(6.0))
                .font_weight(FontWeight(580.0))
                .text_size(px(15.0))
                .line_height(relative(1.3))
                .child(heading),
        )
        .child(div().w_full().children(rows))
        .into_any_element()
}

fn render_footnote_definition(
    definition: &::markdown::mdast::FootnoteDefinition,
    identifier: &str,
    number: usize,
    reference_count: usize,
    context: &RenderContext<'_>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let mut contents = Vec::with_capacity(definition.children.len().max(1));
    let mut backlinks_rendered = false;
    for (index, child) in definition.children.iter().enumerate() {
        let last = index + 1 == definition.children.len();
        if last
            && let Node::Paragraph(paragraph) = child
            && !contains_media(&paragraph.children)
        {
            contents.push(render_footnote_paragraph(
                &paragraph.children,
                definition,
                identifier,
                reference_count,
                context,
            ));
            backlinks_rendered = true;
        } else {
            contents.push(render_block(
                child,
                index == 0,
                last,
                1,
                context,
                window,
                cx,
            ));
        }
    }
    if !backlinks_rendered {
        contents.push(
            div()
                .w_full()
                .flex()
                .flex_wrap()
                .items_baseline()
                .children(render_footnote_backlinks(
                    definition,
                    identifier,
                    reference_count,
                    context,
                ))
                .into_any_element(),
        );
    }

    let row = div()
        .w_full()
        .flex()
        .items_start()
        .child(
            div()
                .w(px(20.0))
                .flex_none()
                .text_color(context.theme.text_3.hsla())
                .child(format!("{number}.")),
        )
        .child(div().min_w(px(0.0)).flex_1().children(contents));
    let anchor_key = footnote_definition_anchor_key(identifier);
    MarkdownAnchor::new(
        SharedString::from(format!("{}:{anchor_key}", context.id)),
        anchor_key,
        row,
        context.selection.clone(),
    )
    .into_any_element()
}

fn render_footnote_paragraph(
    children: &[Node],
    definition: &::markdown::mdast::FootnoteDefinition,
    identifier: &str,
    reference_count: usize,
    context: &RenderContext<'_>,
) -> AnyElement {
    let mut builder = InlineBuilder::default();
    collect_inline(children, &InlineStyle::default(), context, &mut builder);
    div()
        .w_full()
        .flex()
        .flex_wrap()
        .items_baseline()
        .children(
            builder
                .units
                .into_iter()
                .map(|unit| render_inline_unit(unit, context, None)),
        )
        .children(render_footnote_backlinks(
            definition,
            identifier,
            reference_count,
            context,
        ))
        .into_any_element()
}

fn render_footnote_backlinks(
    definition: &::markdown::mdast::FootnoteDefinition,
    identifier: &str,
    count: usize,
    context: &RenderContext<'_>,
) -> Vec<AnyElement> {
    let source_end = definition
        .position
        .as_ref()
        .map_or(context.raw.len(), |position| position.end.offset);
    (1..=count)
        .map(|occurrence| {
            let key = format!("{}:footnote-backlink:{identifier}:{occurrence}", context.id);
            let arrow = SelectableText::plain(
                "↩",
                SelectableTextSpec {
                    key,
                    source_start: source_end,
                    source_end,
                    space_after: occurrence < count,
                },
                context.selection.clone(),
                context.theme,
            );
            let reference_start = context
                .footnote_reference_offsets
                .get(identifier)
                .and_then(|offsets| offsets.get(occurrence - 1))
                .copied();
            let from = footnote_definition_anchor_key(identifier);
            let to =
                reference_start.map(|offset| footnote_reference_anchor_key(identifier, offset));
            let selection = context.selection.clone();
            let view = context.view.clone();
            div()
                .id(SharedString::from(format!(
                    "{}:footnote-backlink-click:{identifier}:{occurrence}",
                    context.id
                )))
                .flex_none()
                .ml(px(SPACE_WIDTH))
                .underline()
                .cursor_pointer()
                .on_click(move |_event, _window, cx| {
                    if let Some(to) = to.as_deref() {
                        jump_to_markdown_anchor(&selection, &view, &from, to, cx);
                    }
                })
                .child(arrow)
                .when(occurrence > 1, |backlink| {
                    let key = format!(
                        "{}:footnote-backlink-number:{identifier}:{occurrence}",
                        context.id
                    );
                    backlink.child(div().relative().top(px(-4.0)).text_size(px(9.0)).child(
                        SelectableText::plain(
                            occurrence.to_string(),
                            SelectableTextSpec {
                                key,
                                source_start: source_end,
                                source_end,
                                space_after: false,
                            },
                            context.selection.clone(),
                            context.theme,
                        ),
                    ))
                })
                .into_any_element()
        })
        .collect()
}

fn footnote_definition_anchor_key(identifier: &str) -> String {
    format!("footnote-definition:{identifier}")
}

fn footnote_reference_anchor_key(identifier: &str, source_start: usize) -> String {
    format!("footnote-reference:{identifier}:{source_start}")
}

fn jump_to_markdown_anchor(
    selection: &Entity<MarkdownSelectionState>,
    view: &Entity<ChatView>,
    from: &str,
    to: &str,
    cx: &mut App,
) {
    if selection.read(cx).has_selection() {
        return;
    }
    let Some(distance) = selection.read(cx).anchor_distance(from, to) else {
        return;
    };
    view.update(cx, |this, cx| {
        this.scroll_markdown_anchor(distance, cx);
    });
}

fn render_block(
    node: &Node,
    first: bool,
    last: bool,
    depth: usize,
    context: &RenderContext<'_>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    match node {
        Node::Paragraph(paragraph) if contains_media(&paragraph.children) => {
            render_media_paragraph(paragraph, last, context, window, cx)
        }
        Node::Paragraph(paragraph) if !contains_media(&paragraph.children) => div()
            .w_full()
            .when(!last, |paragraph| paragraph.mb(px(8.0)))
            .child(render_inline_flow(&paragraph.children, context))
            .into_any_element(),
        Node::Heading(heading) if !contains_media(&heading.children) => {
            let size = match heading.depth {
                1 => 20.0,
                2 => 15.0,
                _ => 13.5,
            };
            div()
                .w_full()
                .when(!first, |heading| heading.mt(px(18.0)))
                .when(!last, |heading| heading.mb(px(6.0)))
                .font_weight(FontWeight(580.0))
                .text_size(px(size))
                .line_height(relative(1.3))
                .child(render_tracked_inline_flow(
                    &heading.children,
                    context,
                    size,
                    -0.014,
                ))
                .into_any_element()
        }
        Node::Blockquote(blockquote) => {
            let mut children = Vec::with_capacity(blockquote.children.len());
            for (index, child) in blockquote.children.iter().enumerate() {
                children.push(render_block(
                    child,
                    index == 0,
                    index + 1 == blockquote.children.len(),
                    depth + 1,
                    context,
                    window,
                    cx,
                ));
            }
            div()
                .w_full()
                .when(!last, |quote| quote.mb(px(8.0)))
                .border_l(px(2.0))
                .border_color(context.theme.line_strong.hsla())
                .pl(px(12.0))
                .text_color(context.theme.text_2.hsla())
                .children(children)
                .into_any_element()
        }
        Node::List(list) => render_list(list, last, depth, context, window, cx),
        Node::Code(code) => render_code_block(code, last, context, window, cx),
        Node::Math(math) => render_code_block(
            &::markdown::mdast::Code {
                value: math.value.clone(),
                position: math.position.clone(),
                lang: None,
                meta: None,
            },
            last,
            context,
            window,
            cx,
        ),
        Node::Table(table) => render_table(table, last, context, window, cx),
        Node::ThematicBreak(_) => div()
            .w_full()
            .h(px(1.0))
            .when(!first, |rule| rule.mt(px(14.0)))
            .when(!last, |rule| rule.mb(px(14.0)))
            .bg(context.theme.line.hsla())
            .into_any_element(),
        Node::Definition(_) => div().into_any_element(),
        _ => fallback_node(node, last, context, window, cx),
    }
}

#[derive(Default)]
struct CopyFeedbackState {
    copied: bool,
    generation: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TableMenu {
    Copy,
    Download,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TableFormat {
    Markdown,
    Csv,
    Tsv,
}

#[derive(Default)]
struct TableControlsState {
    menu: Option<TableMenu>,
    copied: bool,
    generation: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct TableData {
    headers: Vec<String>,
    rows: Vec<Vec<String>>,
}

struct TableControlStyle {
    group: SharedString,
    theme: Theme,
    enabled: bool,
}

#[derive(Clone)]
pub(super) struct MarkdownTableOverlay {
    id: String,
    table: ::markdown::mdast::Table,
    data: TableData,
    source: String,
}

type TableAction = Rc<dyn Fn(&mut App)>;

fn render_media_paragraph(
    paragraph: &::markdown::mdast::Paragraph,
    last: bool,
    context: &RenderContext<'_>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let mut parts = Vec::new();
    let mut inline = Vec::new();
    for node in &paragraph.children {
        if contains_media(std::slice::from_ref(node)) {
            if !inline.is_empty() {
                parts.push(render_inline_flow_sized(&inline, context, false));
                inline.clear();
            }
            parts.push(render_media_node(node, None, context, window, cx));
        } else {
            inline.push(node.clone());
        }
    }
    if !inline.is_empty() {
        parts.push(render_inline_flow_sized(&inline, context, false));
    }

    div()
        .w_full()
        .flex()
        .flex_wrap()
        .items_center()
        .when(!last, |paragraph| paragraph.mb(px(8.0)))
        .children(parts)
        .into_any_element()
}

fn render_media_node(
    node: &Node,
    link: Option<String>,
    context: &RenderContext<'_>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    match node {
        Node::Image(image) => render_markdown_image(
            &image.url,
            &image.alt,
            link,
            node_start(node).unwrap_or_default(),
            context,
            cx,
        ),
        Node::ImageReference(image) => context.definitions.get(&image.identifier).map_or_else(
            || image_fallback(context.theme),
            |url| {
                render_markdown_image(
                    url,
                    &image.alt,
                    link,
                    node_start(node).unwrap_or_default(),
                    context,
                    cx,
                )
            },
        ),
        Node::Html(html) => parse_raw_html_tag(&html.value).map_or_else(
            || div().into_any_element(),
            |tag| {
                if tag.closing || tag.name != "img" {
                    return div().into_any_element();
                }
                let url = tag
                    .attributes
                    .get("src")
                    .and_then(Option::as_deref)
                    .unwrap_or_default();
                let Some(url) = safe_html_image_url(url) else {
                    return image_fallback(context.theme);
                };
                let alt = tag
                    .attributes
                    .get("alt")
                    .and_then(Option::as_deref)
                    .unwrap_or_default();
                render_markdown_image(
                    &url,
                    alt,
                    link,
                    node_start(node).unwrap_or_default(),
                    context,
                    cx,
                )
            },
        ),
        Node::Link(node) => {
            render_media_children(&node.children, Some(node.url.clone()), context, window, cx)
        }
        Node::LinkReference(node) => render_media_children(
            &node.children,
            context.definitions.get(&node.identifier).cloned(),
            context,
            window,
            cx,
        ),
        Node::Strong(node) => render_media_children(&node.children, link, context, window, cx),
        Node::Emphasis(node) => render_media_children(&node.children, link, context, window, cx),
        Node::Delete(node) => render_media_children(&node.children, link, context, window, cx),
        _ => render_inline_flow_sized(std::slice::from_ref(node), context, false),
    }
}

fn render_media_children(
    nodes: &[Node],
    link: Option<String>,
    context: &RenderContext<'_>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    div()
        .w_auto()
        .max_w(relative(1.0))
        .flex()
        .flex_wrap()
        .children(
            nodes
                .iter()
                .map(|node| render_media_node(node, link.clone(), context, window, cx)),
        )
        .into_any_element()
}

fn render_markdown_image(
    url: &str,
    alt: &str,
    link: Option<String>,
    start: usize,
    context: &RenderContext<'_>,
    cx: &mut App,
) -> AnyElement {
    if url.is_empty() {
        return div().into_any_element();
    }
    let project_path = context
        .view
        .read(cx)
        .session
        .as_ref()
        .map(|session| session.project_path.clone());
    let Some(source) = markdown_image_source(url, project_path.as_deref()) else {
        return image_fallback(context.theme);
    };
    let id = format!("{}:image:{start}", context.id);
    let group: SharedString = format!("markdown-image-group:{id}").into();
    let download_hover_group: SharedString = format!("{id}:download-hover").into();
    let fallback_theme = context.theme;
    let image = img(source)
        .id(SharedString::from(format!("{id}:content")))
        .max_w(relative(1.0))
        .rounded(px(RADIUS_MD))
        .object_fit(ObjectFit::Contain)
        .with_fallback(move || image_fallback(fallback_theme));
    let source_url = url.to_owned();
    let source_alt = alt.to_owned();
    let download_project_path = project_path.clone();
    let download_view = context.view.clone();

    div()
        .id(SharedString::from(format!("{id}:wrapper")))
        .group(group.clone())
        .relative()
        .w_auto()
        .max_w(relative(1.0))
        .flex()
        .overflow_hidden()
        .rounded(px(RADIUS_MD))
        .when_some(safe_markdown_image_link_url(link), |wrapper, link| {
            wrapper
                .cursor_pointer()
                .on_click(move |_event, _window, cx| cx.open_url(&link))
        })
        .child(image)
        .child(
            div()
                .absolute()
                .inset(px(0.0))
                .rounded(px(RADIUS_MD))
                .bg(gpui::black().opacity(0.1))
                .opacity(0.0)
                .group_hover(group.clone(), |overlay| overlay.opacity(1.0)),
        )
        .child(
            div()
                .id(SharedString::from(format!("{id}:download")))
                .group(download_hover_group.clone())
                .absolute()
                .right(px(8.0))
                .bottom(px(8.0))
                .size(px(32.0))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(6.0))
                .border_1()
                .border_color(context.theme.line.hsla())
                .bg(context.theme.background.hsla().opacity(0.9))
                .text_color(context.theme.text_2.hsla())
                .shadow_md()
                .opacity(0.0)
                .group_hover(group, |button| button.opacity(1.0))
                .cursor_pointer()
                .hover(move |button| {
                    button
                        .bg(context.theme.background.hsla())
                        .text_color(context.theme.text.hsla())
                })
                .on_click(move |_event, _window, cx| {
                    cx.stop_propagation();
                    download_markdown_image(
                        source_url.clone(),
                        source_alt.clone(),
                        download_project_path.clone(),
                        download_view.clone(),
                        cx,
                    );
                })
                .child(motion_icon(
                    SharedString::from(format!("{id}:download-icon")),
                    "icons/download.svg",
                    14.0,
                    download_hover_group,
                    context.theme,
                )),
        )
        .into_any_element()
}

fn image_fallback(theme: Theme) -> AnyElement {
    div()
        .text_size(px(11.0))
        .italic()
        .text_color(theme.text_3.hsla())
        .child("Image not available")
        .into_any_element()
}

fn markdown_image_source(url: &str, project_path: Option<&str>) -> Option<ImageSource> {
    if url.starts_with("data:") {
        let (format, bytes) = decode_data_image(url)?;
        return Some(Arc::new(Image::from_bytes(format, bytes)).into());
    }
    if let Some(path) = markdown_image_path(url, project_path) {
        return Some(path.into());
    }
    if url.starts_with("//") {
        return Some(format!("https:{url}").into());
    }
    let parsed = url::Url::parse(url).ok()?;
    matches!(parsed.scheme(), "http" | "https").then(|| url.to_owned().into())
}

fn markdown_image_path(url: &str, project_path: Option<&str>) -> Option<PathBuf> {
    if url
        .get(..7)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("file://"))
    {
        return url::Url::parse(url).ok()?.to_file_path().ok();
    }
    let decoded = percent_decode(url).unwrap_or_else(|| url.to_owned());
    let path = decoded.split(['?', '#']).next().unwrap_or(decoded.as_str());
    if Path::new(path).is_absolute() || path.starts_with("\\\\") || is_windows_absolute_path(path) {
        return Some(PathBuf::from(path));
    }
    let external = url::Url::parse(url)
        .ok()
        .is_some_and(|url| !url.scheme().is_empty());
    if external || path.is_empty() {
        return None;
    }
    project_path.map(|project_path| Path::new(project_path).join(path))
}

fn decode_data_image(source: &str) -> Option<(ImageFormat, Vec<u8>)> {
    let (metadata, payload) = source.strip_prefix("data:")?.split_once(',')?;
    let mime = metadata.split(';').next().unwrap_or_default();
    let format = ImageFormat::from_mime_type(mime)?;
    let bytes = if metadata
        .split(';')
        .any(|part| part.eq_ignore_ascii_case("base64"))
    {
        STANDARD.decode(payload).ok()?
    } else {
        percent_decode_bytes(payload)?
    };
    Some((format, bytes))
}

fn download_markdown_image(
    source: String,
    alt: String,
    project_path: Option<String>,
    view: Entity<ChatView>,
    cx: &mut App,
) {
    let client = cx.http_client();
    let fallback_source = source.clone();
    let load = cx.background_spawn(async move {
        markdown_image_bytes(&source, project_path.as_deref(), client).await
    });
    cx.spawn(async move |cx| match load.await {
        Ok(download) => {
            let filename = image_download_filename(&fallback_source, &alt, download.extension);
            let _ = view.update(cx, |_this, cx| {
                download_bytes(filename, download.bytes, cx);
            });
        }
        Err(_) if is_external_image_url(&fallback_source) => {
            let _ = view.update(cx, |_this, cx| cx.open_url(&fallback_source));
        }
        Err(_) => {}
    })
    .detach();
}

struct DownloadedImage {
    bytes: Vec<u8>,
    extension: Option<&'static str>,
}

async fn markdown_image_bytes(
    source: &str,
    project_path: Option<&str>,
    client: Arc<dyn gpui::http_client::HttpClient>,
) -> anyhow::Result<DownloadedImage> {
    if source.starts_with("data:") {
        return decode_data_image(source)
            .map(|(format, bytes)| DownloadedImage {
                bytes,
                extension: Some(image_format_extension(format)),
            })
            .ok_or_else(|| anyhow::anyhow!("invalid image data URL"));
    }
    if let Some(path) = markdown_image_path(source, project_path) {
        let bytes = std::fs::read(path)?;
        let extension = detect_image_extension(&bytes);
        return Ok(DownloadedImage { bytes, extension });
    }
    let request_url = if source.starts_with("//") {
        format!("https:{source}")
    } else {
        source.to_owned()
    };
    if !is_external_image_url(&request_url) {
        anyhow::bail!("unsupported image URL");
    }
    let mut response = client.get(&request_url, ().into(), true).await?;
    if !response.status().is_success() {
        anyhow::bail!("image request failed with {}", response.status());
    }
    let extension = response
        .headers()
        .get(gpui::http_client::http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(image_mime_extension);
    let mut bytes = Vec::new();
    response.body_mut().read_to_end(&mut bytes).await?;
    let extension = extension.or_else(|| detect_image_extension(&bytes));
    Ok(DownloadedImage { bytes, extension })
}

fn is_external_image_url(source: &str) -> bool {
    url::Url::parse(source)
        .ok()
        .is_some_and(|url| matches!(url.scheme(), "http" | "https"))
}

fn image_download_filename(source: &str, alt: &str, detected_extension: Option<&str>) -> String {
    let source_path = if source.starts_with("data:") {
        String::new()
    } else {
        url::Url::parse(source)
            .ok()
            .filter(|url| matches!(url.scheme(), "http" | "https" | "file"))
            .map(|url| url.path().to_owned())
            .unwrap_or_else(|| source.split(['?', '#']).next().unwrap_or(source).to_owned())
    };
    let segment = source_path
        .rsplit(['/', '\\'])
        .next()
        .and_then(|segment| percent_decode(segment).or_else(|| Some(segment.to_owned())))
        .unwrap_or_default();
    if let Some((_, extension)) = segment.rsplit_once('.')
        && !extension.is_empty()
        && extension.len() <= 4
    {
        return sanitize_download_name(&segment);
    }
    let extension = detected_extension
        .or_else(|| {
            source
                .strip_prefix("data:")
                .and_then(|data| data.split([';', ',']).next())
                .and_then(image_mime_extension)
        })
        .unwrap_or("png");
    let base = if alt.trim().is_empty() {
        if segment.is_empty() {
            "image"
        } else {
            &segment
        }
    } else {
        alt.trim()
    };
    let base = base
        .rsplit_once('.')
        .map_or(base, |(without_extension, _)| without_extension);
    format!("{}.{}", sanitize_download_name(base), extension)
}

fn image_mime_extension(mime: &str) -> Option<&'static str> {
    match mime.split(';').next()?.trim().to_ascii_lowercase().as_str() {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        "image/svg+xml" => Some("svg"),
        "image/bmp" => Some("bmp"),
        "image/tiff" | "image/tif" => Some("tiff"),
        "image/avif" => Some("avif"),
        "image/x-icon" | "image/vnd.microsoft.icon" => Some("ico"),
        _ => None,
    }
}

fn detect_image_extension(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("jpg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("gif")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("webp")
    } else if bytes.starts_with(b"BM") {
        Some("bmp")
    } else if bytes.starts_with(b"II*\0") || bytes.starts_with(b"MM\0*") {
        Some("tiff")
    } else if bytes.get(4..12) == Some(b"ftypavif") {
        Some("avif")
    } else if std::str::from_utf8(bytes)
        .ok()
        .map(str::trim_start)
        .is_some_and(|text| text.starts_with("<svg") || text.starts_with("<?xml"))
    {
        Some("svg")
    } else {
        None
    }
}

fn image_format_extension(format: ImageFormat) -> &'static str {
    match format {
        ImageFormat::Png => "png",
        ImageFormat::Jpeg => "jpg",
        ImageFormat::Webp => "webp",
        ImageFormat::Gif => "gif",
        ImageFormat::Svg => "svg",
        ImageFormat::Bmp => "bmp",
        ImageFormat::Tiff => "tiff",
    }
}

fn sanitize_download_name(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|character| {
            if character.is_control() || matches!(character, '/' | '\\' | ':') {
                '_'
            } else {
                character
            }
        })
        .collect::<String>();
    if sanitized.trim().is_empty() {
        "image".into()
    } else {
        sanitized
    }
}

fn render_code_block(
    code: &::markdown::mdast::Code,
    last: bool,
    context: &RenderContext<'_>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let start = code
        .position
        .as_ref()
        .map_or(0, |position| position.start.offset);
    let end = code
        .position
        .as_ref()
        .map_or(start + code.value.len(), |position| position.end.offset);
    let block_id = format!("{}:code:{start}", context.id);
    let group: SharedString = format!("markdown-code-group:{block_id}").into();
    let mut code_foreground = context.theme.text.hsla();
    let highlights = if let Some(language) = code.lang.as_deref() {
        let native_language = native_syntax_language(language);
        let highlight_theme =
            github_highlight_theme_for_language(context.theme.mode, native_language.as_ref());
        let dark = context.theme.mode == ThemeMode::Dark;
        let cached = context.selection.update(cx, |selection, _| {
            let source_revision = selection.document.revision;
            selection.syntax_highlights.lookup(
                start,
                dark,
                native_language.as_ref(),
                source_revision,
                &code.value,
            )
        });
        let highlights = cached.unwrap_or_else(|source_hash| {
            let rope = Rope::from(code.value.as_str());
            let mut highlighter = SyntaxHighlighter::new(native_language.as_ref());
            highlighter.update(None, &rope);
            let highlights = highlighter.styles(&(0..code.value.len()), &highlight_theme);
            context.selection.update(cx, |selection, _| {
                let source_revision = selection.document.revision;
                selection.syntax_highlights.insert(
                    start,
                    dark,
                    SyntaxHighlightCacheEntry::new(
                        native_language.as_ref(),
                        source_revision,
                        source_hash,
                        &code.value,
                        highlights.clone(),
                    ),
                );
            });
            highlights
        });
        if highlights.iter().any(|(_, style)| style.color.is_some()) {
            code_foreground = highlight_theme
                .style
                .editor_foreground
                .unwrap_or(code_foreground);
        }
        highlights
    } else {
        Vec::new()
    };
    let content = if highlights.is_empty() {
        StyledText::new(code.value.clone())
    } else {
        StyledText::new(code.value.clone()).with_highlights(highlights)
    };
    let selectable_content = SelectableText::styled(
        code.value.clone(),
        content,
        SelectableTextSpec {
            key: format!("{block_id}:selection"),
            source_start: start,
            source_end: end,
            space_after: false,
        },
        context.selection.clone(),
        context.theme,
    );
    let copy = copy_control(
        format!("{block_id}:copy"),
        code.value.clone(),
        group.clone(),
        context.theme,
        !context.streaming,
        window,
        cx,
    );
    let filename = format!(
        "file.{}",
        code.lang.as_deref().map_or("txt", code_file_extension)
    );
    let download = download_control(
        format!("{block_id}:download"),
        filename,
        code.value.clone(),
        group.clone(),
        context.theme,
        !context.streaming,
    );

    div()
        .group(group)
        .w_full()
        .when(!last, |block| block.mb(px(14.0)))
        .child(
            div()
                .h(px(26.0))
                .px(px(2.0))
                .flex()
                .items_center()
                .justify_between()
                .gap(px(8.0))
                .font_family("Geist Mono")
                .text_size(px(11.5))
                .text_color(context.theme.text_3.hsla())
                .child(code.lang.clone().unwrap_or_default())
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(3.0))
                        .child(download)
                        .child(copy),
                ),
        )
        .child(
            div()
                .id(SharedString::from(format!("{block_id}:scroll")))
                .w_full()
                .overflow_x_scrollbar()
                .rounded(px(RADIUS_MD))
                .border_1()
                .border_color(context.theme.line.hsla())
                .bg(context.theme.surface.hsla())
                .px(px(13.0))
                .py(px(11.0))
                .font_family("Geist Mono")
                .text_size(px(12.5))
                .line_height(relative(1.52))
                .text_color(code_foreground)
                .whitespace_nowrap()
                .child(selectable_content),
        )
        .into_any_element()
}

fn render_table(
    table: &::markdown::mdast::Table,
    last: bool,
    context: &RenderContext<'_>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let start = table
        .position
        .as_ref()
        .map_or(0, |position| position.start.offset);
    let table_id = format!("{}:table:{start}", context.id);
    let group: SharedString = format!("markdown-table-group:{table_id}").into();
    let controls_state = window.use_keyed_state(
        SharedString::from(format!("{table_id}:controls-state")),
        cx,
        |_, _| TableControlsState::default(),
    );
    let data = table_data(table);
    let overlay = MarkdownTableOverlay {
        id: table_id.clone(),
        table: table.clone(),
        data: data.clone(),
        source: context.raw.to_owned(),
    };
    let view = context.view.clone();
    let fullscreen_action: TableAction = Rc::new(move |cx| {
        view.update(cx, |this, cx| {
            this.markdown_table_overlay = Some(overlay.clone());
            cx.notify();
        });
    });
    let controls = table_controls(
        &table_id,
        data,
        TableControlStyle {
            group: group.clone(),
            theme: context.theme,
            enabled: !context.streaming,
        },
        controls_state,
        Some(fullscreen_action),
        cx,
    );
    let rows = render_table_rows(table, context);

    div()
        .group(group)
        .relative()
        .w_full()
        .when(!last, |table| table.mb(px(14.0)))
        .text_size(px(12.5))
        .child(
            div()
                .id(SharedString::from(format!("{table_id}:scroll")))
                .w_full()
                .overflow_x_scrollbar()
                .children(rows),
        )
        .child(div().absolute().top(px(3.0)).right(px(3.0)).child(controls))
        .into_any_element()
}

fn render_table_rows(
    table: &::markdown::mdast::Table,
    context: &RenderContext<'_>,
) -> Vec<AnyElement> {
    let column_count = table
        .children
        .iter()
        .filter_map(|row| match row {
            Node::TableRow(row) => Some(row.children.len()),
            _ => None,
        })
        .max()
        .unwrap_or_default();
    let mut rows = Vec::with_capacity(table.children.len());
    for (row_index, row) in table.children.iter().enumerate() {
        let Node::TableRow(row) = row else {
            continue;
        };
        let mut cells = Vec::with_capacity(row.children.len());
        for (column_index, cell) in row.children.iter().enumerate() {
            let Node::TableCell(cell) = cell else {
                continue;
            };
            cells.push(
                div()
                    .min_w(px(120.0))
                    .flex_1()
                    .border_l_1()
                    .border_b_1()
                    .when(row_index == 0, |cell| cell.border_t_1())
                    .when(column_index + 1 == row.children.len(), |cell| {
                        cell.border_r_1()
                    })
                    .border_color(context.theme.line.hsla())
                    .when(row_index == 0, |cell| {
                        cell.bg(context.theme.surface.hsla())
                            .font_weight(FontWeight(540.0))
                    })
                    .px(px(9.0))
                    .py(px(5.0))
                    .child(render_inline_flow(&cell.children, context)),
            );
        }
        rows.push(
            div()
                .w_full()
                .min_w(px(column_count as f32 * 120.0))
                .flex()
                .children(cells)
                .into_any_element(),
        );
    }
    rows
}

fn table_controls(
    table_id: &str,
    data: TableData,
    style: TableControlStyle,
    state: Entity<TableControlsState>,
    fullscreen_action: Option<TableAction>,
    cx: &mut App,
) -> AnyElement {
    let TableControlStyle {
        group,
        theme,
        enabled,
    } = style;
    let open_menu = state.read(cx).menu;
    let copied = state.read(cx).copied;
    let copy_menu = table_menu(
        format!("{table_id}:copy-menu"),
        &[
            ("Markdown", TableFormat::Markdown),
            ("CSV", TableFormat::Csv),
            ("TSV", TableFormat::Tsv),
        ],
        data.clone(),
        false,
        theme,
        state.clone(),
    );
    let download_menu = table_menu(
        format!("{table_id}:download-menu"),
        &[
            ("CSV", TableFormat::Csv),
            ("Markdown", TableFormat::Markdown),
        ],
        data,
        true,
        theme,
        state.clone(),
    );
    let copy_state = state.clone();
    let download_state = state.clone();

    div()
        .flex()
        .items_center()
        .gap(px(3.0))
        .child(
            div()
                .relative()
                .child(table_control_button(
                    format!("{table_id}:copy"),
                    if copied {
                        "icons/check.svg"
                    } else {
                        "icons/copy.svg"
                    },
                    group.clone(),
                    theme,
                    enabled,
                    open_menu == Some(TableMenu::Copy),
                    move |cx| {
                        copy_state.update(cx, |state, cx| {
                            state.menu = if state.menu == Some(TableMenu::Copy) {
                                None
                            } else {
                                Some(TableMenu::Copy)
                            };
                            cx.notify();
                        });
                    },
                ))
                .when(open_menu == Some(TableMenu::Copy), |control| {
                    control.child(copy_menu)
                }),
        )
        .child(
            div()
                .relative()
                .child(table_control_button(
                    format!("{table_id}:download"),
                    "icons/download.svg",
                    group.clone(),
                    theme,
                    enabled,
                    open_menu == Some(TableMenu::Download),
                    move |cx| {
                        download_state.update(cx, |state, cx| {
                            state.menu = if state.menu == Some(TableMenu::Download) {
                                None
                            } else {
                                Some(TableMenu::Download)
                            };
                            cx.notify();
                        });
                    },
                ))
                .when(open_menu == Some(TableMenu::Download), |control| {
                    control.child(download_menu)
                }),
        )
        .when_some(fullscreen_action, |controls, fullscreen_action| {
            controls.child(table_control_button(
                format!("{table_id}:fullscreen"),
                "icons/maximize-2.svg",
                group,
                theme,
                enabled,
                false,
                move |cx| fullscreen_action(cx),
            ))
        })
        .into_any_element()
}

fn table_control_button(
    id: String,
    icon: &'static str,
    group: SharedString,
    theme: Theme,
    enabled: bool,
    open: bool,
    on_click: impl Fn(&mut App) + 'static,
) -> AnyElement {
    let id = SharedString::from(id);
    div()
        .id(id.clone())
        .group(id.clone())
        .size(px(24.0))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(3.0))
        .border_1()
        .border_color(theme.line.hsla())
        .bg(theme.surface_2.hsla())
        .text_color(theme.text_3.hsla())
        .opacity(if open { 1.0 } else { 0.0 })
        .group_hover(group, move |control| {
            control.opacity(if enabled { 1.0 } else { 0.5 })
        })
        .when(enabled, |control| {
            control
                .cursor_pointer()
                .hover(move |control| control.text_color(theme.text.hsla()))
                .on_click(move |_event, _window, cx| {
                    cx.stop_propagation();
                    on_click(cx);
                })
        })
        .child(motion_icon(
            SharedString::from(format!("{id}:icon")),
            icon,
            13.0,
            id,
            theme,
        ))
        .into_any_element()
}

fn table_menu(
    id: String,
    options: &[(&'static str, TableFormat)],
    data: TableData,
    download: bool,
    theme: Theme,
    state: Entity<TableControlsState>,
) -> AnyElement {
    div()
        .id(SharedString::from(id.clone()))
        .occlude()
        .absolute()
        .top(px(28.0))
        .right(px(0.0))
        .w(px(120.0))
        .overflow_hidden()
        .rounded(px(6.0))
        .border_1()
        .border_color(theme.line.hsla())
        .bg(theme.background.hsla())
        .shadow(chrome::flyout_shadows(theme))
        .py(px(3.0))
        .children(options.iter().enumerate().map(|(index, (label, format))| {
            let state = state.clone();
            let data = data.clone();
            let label = *label;
            let format = *format;
            div()
                .id(SharedString::from(format!("{id}:option:{index}")))
                .h(px(30.0))
                .w_full()
                .flex()
                .items_center()
                .px(px(9.0))
                .text_size(px(12.5))
                .text_color(theme.text_2.hsla())
                .cursor_pointer()
                .hover(move |option| {
                    option
                        .bg(theme.surface_2.hsla())
                        .text_color(theme.text.hsla())
                })
                .on_click(move |_event, _window, cx| {
                    cx.stop_propagation();
                    let value = format_table(&data, format);
                    if download {
                        let (filename, value) = match format {
                            TableFormat::Csv => ("table.csv", format!("\u{feff}{value}")),
                            TableFormat::Markdown => ("table.md", value),
                            TableFormat::Tsv => ("table.tsv", value),
                        };
                        download_value(filename.to_owned(), value, cx);
                        state.update(cx, |state, cx| {
                            state.menu = None;
                            cx.notify();
                        });
                    } else {
                        cx.write_to_clipboard(ClipboardItem::new_string(value));
                        state.update(cx, |state, cx| {
                            state.menu = None;
                            state.copied = true;
                            state.generation = state.generation.wrapping_add(1);
                            cx.notify();
                        });
                        let generation = state.read(cx).generation;
                        let state = state.clone();
                        cx.spawn(async move |cx| {
                            cx.background_executor().timer(Duration::from_secs(2)).await;
                            let _ = state.update(cx, |state, cx| {
                                if state.generation == generation {
                                    state.copied = false;
                                    cx.notify();
                                }
                            });
                        })
                        .detach();
                    }
                })
                .child(label)
        }))
        .into_any_element()
}

fn copy_control(
    id: String,
    value: String,
    group: SharedString,
    theme: Theme,
    enabled: bool,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let control_id = SharedString::from(id.clone());
    let state = window.use_keyed_state(SharedString::from(format!("{id}:state")), cx, |_, _| {
        CopyFeedbackState::default()
    });
    let copied = state.read(cx).copied;
    div()
        .id(control_id.clone())
        .group(control_id.clone())
        .size(px(24.0))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(RADIUS_SM))
        .border_1()
        .border_color(theme.line.hsla())
        .bg(theme.surface_2.hsla())
        .text_color(theme.text_3.hsla())
        .opacity(0.0)
        .group_hover(group, move |control| {
            control.opacity(if enabled { 1.0 } else { 0.5 })
        })
        .when(enabled, |control| {
            control
                .cursor_pointer()
                .hover(move |control| control.text_color(theme.text.hsla()))
                .on_click(move |_event, _window, cx| {
                    cx.stop_propagation();
                    cx.write_to_clipboard(ClipboardItem::new_string(value.clone()));
                    state.update(cx, |state, cx| {
                        state.copied = true;
                        state.generation = state.generation.wrapping_add(1);
                        cx.notify();
                    });
                    let generation = state.read(cx).generation;
                    let state = state.clone();
                    cx.spawn(async move |cx| {
                        cx.background_executor().timer(Duration::from_secs(2)).await;
                        let _ = state.update(cx, |state, cx| {
                            if state.generation == generation {
                                state.copied = false;
                                cx.notify();
                            }
                        });
                    })
                    .detach();
                })
        })
        .child(motion_icon(
            SharedString::from(format!("{id}:icon")),
            if copied {
                "icons/check.svg"
            } else {
                "icons/copy.svg"
            },
            13.0,
            control_id,
            theme,
        ))
        .into_any_element()
}

fn download_control(
    id: String,
    filename: String,
    value: String,
    group: SharedString,
    theme: Theme,
    enabled: bool,
) -> AnyElement {
    let id = SharedString::from(id);
    div()
        .id(id.clone())
        .group(id.clone())
        .size(px(24.0))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(RADIUS_SM))
        .border_1()
        .border_color(theme.line.hsla())
        .bg(theme.surface_2.hsla())
        .text_color(theme.text_3.hsla())
        .opacity(0.0)
        .group_hover(group, move |control| {
            control.opacity(if enabled { 1.0 } else { 0.5 })
        })
        .when(enabled, |control| {
            control
                .cursor_pointer()
                .hover(move |control| control.text_color(theme.text.hsla()))
                .on_click(move |_event, _window, cx| {
                    cx.stop_propagation();
                    download_value(filename.clone(), value.clone(), cx);
                })
        })
        .child(motion_icon(
            SharedString::from(format!("{id}:icon")),
            "icons/download.svg",
            13.0,
            id,
            theme,
        ))
        .into_any_element()
}

fn download_value(filename: String, value: String, cx: &mut App) {
    download_bytes(filename, value.into_bytes(), cx);
}

fn download_bytes(filename: String, value: Vec<u8>, cx: &mut App) {
    let directory = dirs::download_dir().unwrap_or_else(std::env::temp_dir);
    let save = cx.background_spawn(async move {
        crate::downloads::save_bytes(&directory, &filename, "download", &value)
    });
    cx.spawn(async move |_cx| {
        let _ = save.await;
    })
    .detach();
}

fn table_data(table: &::markdown::mdast::Table) -> TableData {
    let mut rows = table.children.iter().filter_map(|row| match row {
        Node::TableRow(row) => Some(
            row.children
                .iter()
                .filter_map(|cell| match cell {
                    Node::TableCell(cell) => {
                        Some(flatten_inline_text(&cell.children).trim().to_owned())
                    }
                    _ => None,
                })
                .collect::<Vec<_>>(),
        ),
        _ => None,
    });
    TableData {
        headers: rows.next().unwrap_or_default(),
        rows: rows.collect(),
    }
}

fn format_table(data: &TableData, format: TableFormat) -> String {
    match format {
        TableFormat::Markdown => format_table_markdown(data),
        TableFormat::Csv => format_table_csv(data),
        TableFormat::Tsv => format_table_tsv(data),
    }
}

fn format_table_csv(data: &TableData) -> String {
    fn escape(value: &str) -> String {
        let quoted = value
            .chars()
            .any(|character| matches!(character, '"' | ',' | '\n'));
        if !quoted {
            return value.to_owned();
        }
        format!("\"{}\"", value.replace('"', "\"\""))
    }

    let mut lines = Vec::with_capacity(data.rows.len() + usize::from(!data.headers.is_empty()));
    if !data.headers.is_empty() {
        lines.push(
            data.headers
                .iter()
                .map(|value| escape(value))
                .collect::<Vec<_>>()
                .join(","),
        );
    }
    lines.extend(data.rows.iter().map(|row| {
        row.iter()
            .map(|value| escape(value))
            .collect::<Vec<_>>()
            .join(",")
    }));
    lines.join("\n")
}

fn format_table_tsv(data: &TableData) -> String {
    fn escape(value: &str) -> String {
        value
            .replace('\t', "\\t")
            .replace('\n', "\\n")
            .replace('\r', "\\r")
    }

    let mut lines = Vec::with_capacity(data.rows.len() + usize::from(!data.headers.is_empty()));
    if !data.headers.is_empty() {
        lines.push(
            data.headers
                .iter()
                .map(|value| escape(value))
                .collect::<Vec<_>>()
                .join("\t"),
        );
    }
    lines.extend(data.rows.iter().map(|row| {
        row.iter()
            .map(|value| escape(value))
            .collect::<Vec<_>>()
            .join("\t")
    }));
    lines.join("\n")
}

fn format_table_markdown(data: &TableData) -> String {
    fn escape(value: &str) -> String {
        value.replace('\\', "\\\\").replace('|', "\\|")
    }

    if data.headers.is_empty() {
        return String::new();
    }
    let mut lines = Vec::with_capacity(data.rows.len() + 2);
    lines.push(format!(
        "| {} |",
        data.headers
            .iter()
            .map(|value| escape(value))
            .collect::<Vec<_>>()
            .join(" | ")
    ));
    lines.push(format!(
        "| {} |",
        vec!["---"; data.headers.len()].join(" | ")
    ));
    for row in &data.rows {
        let cells = if row.len() < data.headers.len() {
            (0..data.headers.len())
                .map(|index| row.get(index).map_or(String::new(), |value| escape(value)))
                .collect::<Vec<_>>()
        } else {
            row.iter().map(|value| escape(value)).collect::<Vec<_>>()
        };
        lines.push(format!("| {} |", cells.join(" | ")));
    }
    lines.join("\n")
}

fn render_list(
    list: &::markdown::mdast::List,
    last: bool,
    depth: usize,
    context: &RenderContext<'_>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let mut rows = Vec::with_capacity(list.children.len());
    let start = list.start.unwrap_or(1);
    for (index, child) in list.children.iter().enumerate() {
        let Node::ListItem(item) = child else {
            continue;
        };
        let marker = match item.checked {
            Some(true) => "✓".to_owned(),
            Some(false) => "□".to_owned(),
            None if list.ordered => format!("{}.", start + index as u32),
            None => "•".to_owned(),
        };
        let mut contents = Vec::with_capacity(item.children.len());
        for (child_index, child) in item.children.iter().enumerate() {
            let content = match child {
                Node::Paragraph(paragraph) if !contains_media(&paragraph.children) => {
                    render_inline_flow(&paragraph.children, context).into_any_element()
                }
                _ => render_block(
                    child,
                    child_index == 0,
                    child_index + 1 == item.children.len(),
                    depth + 1,
                    context,
                    window,
                    cx,
                ),
            };
            contents.push(content);
        }
        rows.push(
            div()
                .w_full()
                .flex()
                .items_start()
                .when(index > 0, |row| row.mt(px(1.0)))
                .child(
                    div()
                        .w(px(20.0))
                        .flex_none()
                        .text_color(context.theme.text_3.hsla())
                        .child(marker),
                )
                .child(div().min_w(px(0.0)).flex_1().children(contents)),
        );
    }
    div()
        .w_full()
        .when(depth > 0, |list| list.ml(px(20.0)))
        .when(!last, |list| list.mb(px(8.0)))
        .children(rows)
        .into_any_element()
}

fn fallback_node(
    node: &Node,
    last: bool,
    context: &RenderContext<'_>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let Some(position) = node.position() else {
        return div().into_any_element();
    };
    let Some(raw) = context.raw.get(position.start.offset..position.end.offset) else {
        return div().into_any_element();
    };
    let node_id = format!("{}:fallback:{}", context.id, position.start.offset);
    let content = if matches!(node, Node::Html(_)) {
        fallback_html(
            node_id,
            raw,
            context.theme,
            context.interface_font.clone(),
            window,
            cx,
        )
    } else {
        fallback_markdown(
            node_id,
            raw.to_owned(),
            context.theme,
            context.interface_font.clone(),
            window,
            cx,
        )
    };
    div()
        .w_full()
        .when(!last && matches!(node, Node::Paragraph(_)), |block| {
            block.mb(px(8.0))
        })
        .when(
            !last && matches!(node, Node::Code(_) | Node::Math(_)),
            |block| block.mb(px(14.0)),
        )
        .child(content)
        .into_any_element()
}

fn fallback_markdown(
    id: String,
    text: String,
    theme: Theme,
    interface_font: SharedString,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let text_style = fallback_text_style(theme);

    TextView::markdown(SharedString::from(id), text, window, cx)
        .style(text_style)
        .selectable(true)
        .w_full()
        .font_family(interface_font)
        .text_size(px(15.0))
        .line_height(relative(1.52))
        .text_color(theme.response_text.hsla())
        .code_block_actions(move |block, _window, _cx| {
            let code = block.code().to_string();
            fallback_code_copy_button(code, theme)
        })
        .into_any_element()
}

fn fallback_html(
    id: String,
    html: &str,
    theme: Theme,
    interface_font: SharedString,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    TextView::html(
        SharedString::from(id),
        sanitize_html_fragment(html),
        window,
        cx,
    )
    .style(fallback_text_style(theme))
    .selectable(true)
    .w_full()
    .font_family(interface_font)
    .text_size(px(15.0))
    .line_height(relative(1.52))
    .text_color(theme.response_text.hsla())
    .code_block_actions(move |block, _window, _cx| {
        fallback_code_copy_button(block.code().to_string(), theme)
    })
    .into_any_element()
}

fn fallback_text_style(theme: Theme) -> TextViewStyle {
    let code_style = StyleRefinement::default()
        .bg(theme.surface.hsla())
        .border_1()
        .border_color(theme.line.hsla())
        .rounded(px(RADIUS_MD))
        .px(px(13.0))
        .py(px(11.0))
        .font_family("Geist Mono")
        .text_size(px(12.5));
    let mut text_style = TextViewStyle::default()
        .paragraph_gap(rems(0.5))
        .heading_font_size(|level, _base| match level {
            1 => px(20.0),
            2 => px(15.0),
            _ => px(13.5),
        })
        .code_block(code_style);
    text_style.heading_base_font_size = px(15.0);
    text_style.is_dark = theme.mode == ThemeMode::Dark;
    text_style
}

fn fallback_code_copy_button(code: String, theme: Theme) -> AnyElement {
    let id = SharedString::from(format!("copy-code:{}", stable_hash(&code)));
    div()
        .id(id.clone())
        .group(id.clone())
        .size(px(24.0))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(RADIUS_SM))
        .border_1()
        .border_color(theme.line.hsla())
        .bg(theme.surface_2.hsla())
        .text_color(theme.text_3.hsla())
        .cursor_pointer()
        .hover(move |style| style.text_color(theme.text.hsla()))
        .on_click(move |_event, _window, cx| {
            cx.write_to_clipboard(ClipboardItem::new_string(code.clone()));
        })
        .child(motion_icon(
            SharedString::from(format!("{id}:icon")),
            "icons/copy.svg",
            13.0,
            id,
            theme,
        ))
        .into_any_element()
}

fn sanitize_html_fragment(source: &str) -> String {
    let dom = parse_document(RcDom::default(), Default::default()).one(source);
    let mut output = String::with_capacity(source.len());
    write_sanitized_html(&dom.document, &mut output);
    output
}

fn write_sanitized_html(node: &HtmlHandle, output: &mut String) {
    match &node.data {
        HtmlNodeData::Text { contents } => escape_html_text(&contents.borrow(), output),
        HtmlNodeData::Element { name, attrs, .. } => {
            let tag = name.local.as_ref().to_ascii_lowercase();
            if is_dangerous_html_tag(&tag) {
                return;
            }
            let allowed = is_allowed_html_tag(&tag);
            if allowed {
                if tag == "input"
                    && !attrs.borrow().iter().any(|attribute| {
                        attribute.name.local.as_ref().eq_ignore_ascii_case("type")
                            && attribute.value.as_ref().eq_ignore_ascii_case("checkbox")
                    })
                {
                    return;
                }
                output.push('<');
                output.push_str(&tag);
                for attribute in attrs.borrow().iter() {
                    let name = attribute.name.local.as_ref().to_ascii_lowercase();
                    let value = attribute.value.as_ref();
                    if let Some(value) = sanitized_html_attribute(&tag, &name, value) {
                        output.push(' ');
                        output.push_str(&name);
                        if let Some(value) = value {
                            output.push_str("=\"");
                            escape_html_attribute(&value, output);
                            output.push('"');
                        }
                    }
                }
                if tag == "input" && !output.ends_with(" disabled") {
                    output.push_str(" disabled");
                }
                output.push('>');
            }
            for child in node.children.borrow().iter() {
                write_sanitized_html(child, output);
            }
            if allowed && !is_void_html_tag(&tag) {
                output.push_str("</");
                output.push_str(&tag);
                output.push('>');
            }
        }
        HtmlNodeData::Document => {
            for child in node.children.borrow().iter() {
                write_sanitized_html(child, output);
            }
        }
        _ => {}
    }
}

fn is_allowed_html_tag(tag: &str) -> bool {
    matches!(
        tag,
        "a" | "b"
            | "blockquote"
            | "br"
            | "code"
            | "dd"
            | "del"
            | "details"
            | "div"
            | "dl"
            | "dt"
            | "em"
            | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
            | "hr"
            | "i"
            | "img"
            | "input"
            | "ins"
            | "kbd"
            | "li"
            | "ol"
            | "p"
            | "picture"
            | "pre"
            | "q"
            | "rp"
            | "rt"
            | "ruby"
            | "s"
            | "samp"
            | "section"
            | "source"
            | "span"
            | "strike"
            | "strong"
            | "sub"
            | "summary"
            | "sup"
            | "table"
            | "tbody"
            | "td"
            | "tfoot"
            | "th"
            | "thead"
            | "tr"
            | "tt"
            | "ul"
            | "var"
    )
}

fn is_dangerous_html_tag(tag: &str) -> bool {
    matches!(
        tag,
        "applet"
            | "base"
            | "embed"
            | "form"
            | "frame"
            | "frameset"
            | "head"
            | "iframe"
            | "link"
            | "meta"
            | "noscript"
            | "object"
            | "script"
            | "style"
            | "template"
    )
}

fn is_void_html_tag(tag: &str) -> bool {
    matches!(tag, "br" | "hr" | "img" | "input" | "source")
}

fn sanitized_html_attribute(tag: &str, name: &str, value: &str) -> Option<Option<String>> {
    match (tag, name) {
        ("a", "href") => safe_markdown_link_url(value).map(Some),
        ("img" | "source", "src") => safe_html_image_url(value).map(Some),
        ("img", "alt" | "title" | "width" | "height")
        | ("a", "title")
        | ("ol", "start")
        | ("td" | "th", "align" | "colspan" | "rowspan")
        | (_, "dir" | "lang") => Some(Some(value.to_owned())),
        ("details", "open") | ("input", "checked" | "disabled") => Some(None),
        ("input", "type") if value.eq_ignore_ascii_case("checkbox") => {
            Some(Some("checkbox".into()))
        }
        _ => None,
    }
}

fn safe_html_image_url(value: &str) -> Option<String> {
    let value = value.trim();
    if value.starts_with("data:") {
        return decode_data_image(value).map(|_| value.to_owned());
    }
    if value.starts_with("//") {
        return Some(format!("https:{value}"));
    }
    let scheme_end = value.find(':');
    if scheme_end.is_some_and(|end| value[..end].contains('&')) {
        return None;
    }
    let first_path_delimiter = value.find(['/', '?', '#']).unwrap_or(value.len());
    if let Some(scheme_end) = scheme_end
        && scheme_end < first_path_delimiter
        && !matches!(
            value[..scheme_end].to_ascii_lowercase().as_str(),
            "http" | "https"
        )
    {
        return None;
    }
    (!value.is_empty() && !value.chars().any(char::is_control)).then(|| value.to_owned())
}

fn escape_html_text(value: &str, output: &mut String) {
    for character in value.chars() {
        match character {
            '&' => output.push_str("&amp;"),
            '<' => output.push_str("&lt;"),
            '>' => output.push_str("&gt;"),
            _ => output.push(character),
        }
    }
}

fn escape_html_attribute(value: &str, output: &mut String) {
    for character in value.chars() {
        match character {
            '&' => output.push_str("&amp;"),
            '"' => output.push_str("&quot;"),
            '<' => output.push_str("&lt;"),
            '>' => output.push_str("&gt;"),
            _ => output.push(character),
        }
    }
}

fn selected_markdown_text<'a>(
    source: &str,
    segments: impl Iterator<Item = &'a MarkdownSelectionSegment>,
) -> Option<String> {
    let mut segments = segments
        .filter_map(|segment| {
            let selected = segment.selected.clone()?;
            (!selected.is_empty()
                && selected.end <= segment.text.len()
                && segment.text.is_char_boundary(selected.start)
                && segment.text.is_char_boundary(selected.end))
            .then_some((segment, selected))
        })
        .collect::<Vec<_>>();
    segments.sort_by_key(|(segment, _)| (segment.source_start, segment.source_end));

    let mut output = String::new();
    let mut previous: Option<(&MarkdownSelectionSegment, Range<usize>)> = None;
    for (segment, selected) in segments {
        if let Some((prior, prior_selection)) = previous.as_ref()
            && prior_selection.end == prior.text.len()
            && selected.start == 0
        {
            if prior.space_after {
                output.push(' ');
            } else if let Some(gap) = source
                .get(prior.source_end.min(source.len())..segment.source_start.min(source.len()))
            {
                let newline_count = gap.bytes().filter(|byte| *byte == b'\n').count();
                if newline_count > 0 {
                    output.push('\n');
                    if newline_count > 1 {
                        output.push('\n');
                    }
                } else if gap.contains('|') {
                    output.push('\t');
                }
            }
        }
        output.push_str(&segment.text[selected.clone()]);
        previous = Some((segment, selected));
    }

    (!output.is_empty()).then_some(output)
}

struct SelectableText {
    id: ElementId,
    key: String,
    text: SharedString,
    content: SelectableTextContent,
    source_start: usize,
    source_end: usize,
    space_after: bool,
    selection: Entity<MarkdownSelectionState>,
    theme: Theme,
}

enum SelectableTextContent {
    Styled(StyledText),
    Tracked(TrackedText),
}

pub(crate) enum SelectableTextLayout {
    Styled,
    Tracked(TrackedTextLayout),
}

struct SelectableTextSpec {
    key: String,
    source_start: usize,
    source_end: usize,
    space_after: bool,
}

impl SelectableText {
    fn plain(
        text: impl Into<SharedString>,
        spec: SelectableTextSpec,
        selection: Entity<MarkdownSelectionState>,
        theme: Theme,
    ) -> Self {
        let text = text.into();
        Self {
            id: ElementId::Name(SharedString::from(spec.key.clone())),
            key: spec.key,
            content: SelectableTextContent::Styled(StyledText::new(text.clone())),
            text,
            source_start: spec.source_start,
            source_end: spec.source_end,
            space_after: spec.space_after,
            selection,
            theme,
        }
    }

    fn plain_tracked(
        text: impl Into<SharedString>,
        letter_spacing_em: f32,
        spec: SelectableTextSpec,
        selection: Entity<MarkdownSelectionState>,
        theme: Theme,
    ) -> Self {
        let text = text.into();
        Self {
            id: ElementId::Name(SharedString::from(spec.key.clone())),
            key: spec.key,
            content: SelectableTextContent::Tracked(tracked_text(text.clone(), letter_spacing_em)),
            text,
            source_start: spec.source_start,
            source_end: spec.source_end,
            space_after: spec.space_after,
            selection,
            theme,
        }
    }

    fn styled(
        text: impl Into<SharedString>,
        styled_text: StyledText,
        spec: SelectableTextSpec,
        selection: Entity<MarkdownSelectionState>,
        theme: Theme,
    ) -> Self {
        Self {
            id: ElementId::Name(SharedString::from(spec.key.clone())),
            key: spec.key,
            text: text.into(),
            content: SelectableTextContent::Styled(styled_text),
            source_start: spec.source_start,
            source_end: spec.source_end,
            space_after: spec.space_after,
            selection,
            theme,
        }
    }
}

impl Element for SelectableText {
    type RequestLayoutState = SelectableTextLayout;
    type PrepaintState = Hitbox;

    fn id(&self) -> Option<ElementId> {
        Some(self.id.clone())
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        global_id: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        match &mut self.content {
            SelectableTextContent::Styled(text) => {
                let (layout_id, ()) = text.request_layout(global_id, inspector_id, window, cx);
                (layout_id, SelectableTextLayout::Styled)
            }
            SelectableTextContent::Tracked(text) => {
                let (layout_id, state) = text.request_layout(global_id, inspector_id, window, cx);
                (layout_id, SelectableTextLayout::Tracked(state))
            }
        }
    }

    fn prepaint(
        &mut self,
        global_id: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        state: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        match (&mut self.content, state) {
            (SelectableTextContent::Styled(text), SelectableTextLayout::Styled) => {
                text.prepaint(global_id, inspector_id, bounds, &mut (), window, cx);
            }
            (SelectableTextContent::Tracked(text), SelectableTextLayout::Tracked(state)) => {
                text.prepaint(global_id, inspector_id, bounds, state, window, cx);
            }
            _ => unreachable!("selectable text layout must match its content"),
        }
        window.insert_hitbox(bounds, HitboxBehavior::Normal)
    }

    fn paint(
        &mut self,
        global_id: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        request_layout: &mut Self::RequestLayoutState,
        hitbox: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let selection_bounds = self.selection.read(cx).selection_bounds();
        let selected =
            selection_bounds.and_then(|selection_bounds| match (&self.content, &*request_layout) {
                (SelectableTextContent::Styled(text), SelectableTextLayout::Styled) => {
                    selection_for_text_layout(&self.text, text.layout(), &selection_bounds)
                }
                (SelectableTextContent::Tracked(_), SelectableTextLayout::Tracked(layout)) => {
                    selection_for_tracked_text(&self.text, layout, &selection_bounds)
                }
                _ => unreachable!("selectable text layout must match its content"),
            });
        self.selection.update(cx, |selection, _| {
            selection.update_segment(
                self.key.clone(),
                self.source_start,
                self.source_end,
                self.text.clone(),
                selected.clone(),
                self.space_after,
            );
        });

        if let Some(selected) = selected.as_ref() {
            match (&self.content, &*request_layout) {
                (SelectableTextContent::Styled(text), SelectableTextLayout::Styled) => {
                    paint_text_selection(
                        selected,
                        text.layout(),
                        &bounds,
                        self.theme.attention.hsla().opacity(0.3),
                        window,
                    );
                }
                (SelectableTextContent::Tracked(_), SelectableTextLayout::Tracked(layout)) => {
                    paint_tracked_text_selection(
                        selected,
                        layout,
                        &bounds,
                        self.theme.attention.hsla().opacity(0.3),
                        window,
                    );
                }
                _ => unreachable!("selectable text layout must match its content"),
            }
        }
        window.set_cursor_style(CursorStyle::IBeam, hitbox);
        match (&mut self.content, request_layout) {
            (SelectableTextContent::Styled(text), SelectableTextLayout::Styled) => text.paint(
                global_id,
                inspector_id,
                bounds,
                &mut (),
                &mut (),
                window,
                cx,
            ),
            (SelectableTextContent::Tracked(text), SelectableTextLayout::Tracked(state)) => {
                text.paint(global_id, inspector_id, bounds, state, &mut (), window, cx)
            }
            _ => unreachable!("selectable text layout must match its content"),
        }
    }
}

impl IntoElement for SelectableText {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

struct MarkdownAnchor<E> {
    id: ElementId,
    key: String,
    element: Option<E>,
    state: Entity<MarkdownSelectionState>,
}

impl<E> MarkdownAnchor<E> {
    fn new(
        id: impl Into<ElementId>,
        key: String,
        element: E,
        state: Entity<MarkdownSelectionState>,
    ) -> Self {
        Self {
            id: id.into(),
            key,
            element: Some(element),
            state,
        }
    }
}

impl<E: IntoElement + 'static> Element for MarkdownAnchor<E> {
    type RequestLayoutState = AnyElement;
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        Some(self.id.clone())
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _global_id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let mut element = self
            .element
            .take()
            .expect("markdown anchor should only request layout once")
            .into_any_element();
        (element.request_layout(window, cx), element)
    }

    fn prepaint(
        &mut self,
        _global_id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        element: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        element.prepaint(window, cx);
        self.state.update(cx, |state, _| {
            state.update_anchor(self.key.clone(), bounds);
        });
    }

    fn paint(
        &mut self,
        _global_id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: Bounds<Pixels>,
        element: &mut Self::RequestLayoutState,
        _prepaint: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        element.paint(window, cx);
    }
}

impl<E: IntoElement + 'static> IntoElement for MarkdownAnchor<E> {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

fn selection_for_text_layout(
    text: &str,
    layout: &TextLayout,
    selection_bounds: &Bounds<Pixels>,
) -> Option<Range<usize>> {
    selection_for_text_positions(text, layout.line_height(), selection_bounds, |index| {
        layout.position_for_index(index)
    })
}

fn selection_for_tracked_text(
    text: &str,
    layout: &TrackedTextLayout,
    selection_bounds: &Bounds<Pixels>,
) -> Option<Range<usize>> {
    selection_for_text_positions(text, layout.line_height(), selection_bounds, |index| {
        layout.position_for_index(index)
    })
}

fn selection_for_text_positions(
    text: &str,
    line_height: Pixels,
    selection_bounds: &Bounds<Pixels>,
    mut position_for_index: impl FnMut(usize) -> Option<Point<Pixels>>,
) -> Option<Range<usize>> {
    let mut selected = None::<Range<usize>>;
    for (offset, character) in text.char_indices() {
        let next_offset = offset + character.len_utf8();
        let Some(position) = position_for_index(offset) else {
            continue;
        };
        let width = position_for_index(next_offset)
            .filter(|next| next.y == position.y)
            .map_or(line_height / 2.0, |next| next.x - position.x);
        if point_in_text_selection(position, width, selection_bounds, line_height) {
            selected.get_or_insert_with(|| offset..offset).end = next_offset;
        }
    }
    selected
}

fn point_in_text_selection(
    position: Point<Pixels>,
    character_width: Pixels,
    selection: &Bounds<Pixels>,
    line_height: Pixels,
) -> bool {
    if position.y + line_height < selection.top() || position.y >= selection.bottom() {
        return false;
    }
    let midpoint = position.x + character_width / 2.0;
    if selection.size.height <= line_height {
        midpoint >= selection.left() && midpoint <= selection.right()
    } else if position.y <= selection.top() {
        midpoint >= selection.left()
    } else if position.y + line_height >= selection.bottom() {
        midpoint <= selection.right()
    } else {
        true
    }
}

fn paint_text_selection(
    selection: &Range<usize>,
    layout: &TextLayout,
    bounds: &Bounds<Pixels>,
    color: gpui::Hsla,
    window: &mut Window,
) {
    paint_text_selection_positions(
        selection,
        bounds,
        layout.line_height(),
        color,
        |index| layout.position_for_index(index),
        window,
    );
}

fn paint_tracked_text_selection(
    selection: &Range<usize>,
    layout: &TrackedTextLayout,
    bounds: &Bounds<Pixels>,
    color: gpui::Hsla,
    window: &mut Window,
) {
    paint_text_selection_positions(
        selection,
        bounds,
        layout.line_height(),
        color,
        |index| layout.position_for_index(index),
        window,
    );
}

fn paint_text_selection_positions(
    selection: &Range<usize>,
    bounds: &Bounds<Pixels>,
    line_height: Pixels,
    color: gpui::Hsla,
    mut position_for_index: impl FnMut(usize) -> Option<Point<Pixels>>,
    window: &mut Window,
) {
    let (Some(start), Some(end)) = (
        position_for_index(selection.start),
        position_for_index(selection.end),
    ) else {
        return;
    };
    let paint = |bounds, window: &mut Window| {
        window.paint_quad(quad(
            bounds,
            px(0.0),
            color,
            Edges::default(),
            gpui::transparent_black(),
            BorderStyle::default(),
        ));
    };
    if start.y == end.y {
        paint(
            Bounds::from_corners(start, point(end.x, end.y + line_height)),
            window,
        );
        return;
    }
    paint(
        Bounds::from_corners(start, point(bounds.right(), start.y + line_height)),
        window,
    );
    if end.y > start.y + line_height {
        paint(
            Bounds::from_corners(
                point(bounds.left(), start.y + line_height),
                point(bounds.right(), end.y),
            ),
            window,
        );
    }
    paint(
        Bounds::from_corners(
            point(bounds.left(), end.y),
            point(end.x, end.y + line_height),
        ),
        window,
    );
}

#[derive(Clone, Default)]
struct InlineStyle {
    bold: bool,
    italic: bool,
    strikethrough: bool,
    underline: bool,
    inline_code: bool,
    keyboard: bool,
    highlight: bool,
    superscript: bool,
    subscript: bool,
    small: bool,
    link: Option<String>,
}

enum InlineUnitKind {
    Text(String),
    Code(String),
    FileReference { path: String, label: String },
    FootnoteReference { identifier: String, number: usize },
    Break,
}

struct InlineUnit {
    kind: InlineUnitKind,
    style: InlineStyle,
    start: usize,
    end: usize,
    space_after: bool,
}

#[derive(Default)]
struct InlineBuilder {
    units: Vec<InlineUnit>,
}

impl InlineBuilder {
    fn push_text(&mut self, value: &str, source_start: usize, style: &InlineStyle) {
        let mut run_start = None;
        for (offset, character) in value.char_indices() {
            if character.is_whitespace() {
                if let Some(start) = run_start.take() {
                    self.push_text_run(value, source_start, start, offset, style);
                }
                if let Some(last) = self.units.last_mut()
                    && !matches!(last.kind, InlineUnitKind::Break)
                {
                    last.space_after = true;
                }
            } else if run_start.is_none() {
                run_start = Some(offset);
            }
        }
        if let Some(start) = run_start {
            self.push_text_run(value, source_start, start, value.len(), style);
        }
    }

    fn push_text_run(
        &mut self,
        value: &str,
        source_start: usize,
        start: usize,
        end: usize,
        style: &InlineStyle,
    ) {
        self.units.push(InlineUnit {
            kind: InlineUnitKind::Text(value[start..end].to_owned()),
            style: style.clone(),
            start: source_start + start,
            end: source_start + end,
            space_after: false,
        });
    }

    fn push_atomic(&mut self, kind: InlineUnitKind, start: usize, end: usize, style: &InlineStyle) {
        self.units.push(InlineUnit {
            kind,
            style: style.clone(),
            start,
            end,
            space_after: false,
        });
    }

    fn push_break(&mut self, start: usize) {
        self.units.push(InlineUnit {
            kind: InlineUnitKind::Break,
            style: InlineStyle::default(),
            start,
            end: start,
            space_after: false,
        });
    }
}

fn render_inline_flow(children: &[Node], context: &RenderContext<'_>) -> AnyElement {
    render_inline_flow_with_tracking(children, context, true, None)
}

fn render_inline_flow_sized(
    children: &[Node],
    context: &RenderContext<'_>,
    full_width: bool,
) -> AnyElement {
    render_inline_flow_with_tracking(children, context, full_width, None)
}

fn render_tracked_inline_flow(
    children: &[Node],
    context: &RenderContext<'_>,
    font_size: f32,
    letter_spacing_em: f32,
) -> AnyElement {
    let space_width =
        (SPACE_WIDTH * font_size / 15.0 + 2.0 * font_size * letter_spacing_em).max(0.0);
    render_inline_flow_with_tracking(
        children,
        context,
        true,
        Some(InlineTracking {
            letter_spacing_em,
            space_width,
        }),
    )
}

fn render_inline_flow_with_tracking(
    children: &[Node],
    context: &RenderContext<'_>,
    full_width: bool,
    tracking: Option<InlineTracking>,
) -> AnyElement {
    let mut builder = InlineBuilder::default();
    let style = InlineStyle::default();
    collect_inline(children, &style, context, &mut builder);
    let units = builder
        .units
        .into_iter()
        .map(|unit| render_inline_unit(unit, context, tracking));
    div()
        .when(full_width, |flow| flow.w_full())
        .when(!full_width, |flow| flow.w_auto())
        .flex()
        .flex_wrap()
        .items_baseline()
        .children(units)
        .into_any_element()
}

fn collect_inline(
    children: &[Node],
    style: &InlineStyle,
    context: &RenderContext<'_>,
    builder: &mut InlineBuilder,
) {
    let mut current = style.clone();
    let mut html_stack = Vec::<(String, InlineStyle)>::new();
    for node in children {
        match node {
            Node::Text(text) => {
                let start = node_start(node).unwrap_or_default();
                if current.inline_code {
                    builder.push_atomic(
                        InlineUnitKind::Text(text.value.clone()),
                        start,
                        start + text.value.len(),
                        &current,
                    );
                } else {
                    builder.push_text(&text.value, start, &current);
                }
            }
            Node::Strong(strong) => {
                let mut nested = current.clone();
                nested.bold = true;
                collect_inline(&strong.children, &nested, context, builder);
            }
            Node::Emphasis(emphasis) => {
                let mut nested = current.clone();
                nested.italic = true;
                collect_inline(&emphasis.children, &nested, context, builder);
            }
            Node::Delete(delete) => {
                let mut nested = current.clone();
                nested.strikethrough = true;
                collect_inline(&delete.children, &nested, context, builder);
            }
            Node::InlineCode(code) => {
                let (start, end) = node_range(node);
                let kind = if is_file_reference(&code.value) {
                    InlineUnitKind::FileReference {
                        path: code.value.clone(),
                        label: code.value.clone(),
                    }
                } else {
                    InlineUnitKind::Code(code.value.clone())
                };
                builder.push_atomic(kind, start, end, &current);
            }
            Node::InlineMath(math) => {
                let (start, end) = node_range(node);
                builder.push_atomic(
                    InlineUnitKind::Code(math.value.clone()),
                    start,
                    end,
                    &current,
                );
            }
            Node::Link(link) => {
                if let Some(path) = local_file_reference_path(&link.url) {
                    let (start, end) = node_range(node);
                    builder.push_atomic(
                        InlineUnitKind::FileReference {
                            path,
                            label: flatten_inline_text(&link.children),
                        },
                        start,
                        end,
                        &current,
                    );
                } else {
                    let mut nested = current.clone();
                    nested.underline = true;
                    nested.link = safe_markdown_link_url(&link.url);
                    collect_inline(&link.children, &nested, context, builder);
                }
            }
            Node::LinkReference(link) => {
                let mut nested = current.clone();
                nested.underline = true;
                nested.link = context
                    .definitions
                    .get(&link.identifier)
                    .and_then(|url| safe_markdown_link_url(url));
                collect_inline(&link.children, &nested, context, builder);
            }
            Node::Break(_) => builder.push_break(node_start(node).unwrap_or_default()),
            Node::Html(html) => {
                apply_inline_html(html, &mut current, &mut html_stack, builder);
            }
            Node::FootnoteReference(reference) => {
                let (start, end) = node_range(node);
                if let Some(number) = context.footnote_numbers.get(&reference.identifier) {
                    builder.push_atomic(
                        InlineUnitKind::FootnoteReference {
                            identifier: reference.identifier.clone(),
                            number: *number,
                        },
                        start,
                        end,
                        &current,
                    );
                } else {
                    builder.push_text(&format!("[^{}]", reference.identifier), start, &current);
                }
            }
            _ => {}
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct RawHtmlTag {
    name: String,
    closing: bool,
    self_closing: bool,
    attributes: HashMap<String, Option<String>>,
}

fn parse_raw_html_tag(value: &str) -> Option<RawHtmlTag> {
    let value = value.trim();
    if !value.starts_with('<')
        || !value.ends_with('>')
        || value.starts_with("<!--")
        || value.starts_with("<!")
        || value.starts_with("<?")
    {
        return None;
    }
    let bytes = value.as_bytes();
    let mut index = 1;
    let closing = bytes.get(index) == Some(&b'/');
    if closing {
        index += 1;
    }
    while bytes.get(index).is_some_and(u8::is_ascii_whitespace) {
        index += 1;
    }
    let name_start = index;
    while bytes
        .get(index)
        .is_some_and(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':'))
    {
        index += 1;
    }
    if name_start == index {
        return None;
    }
    let name = value[name_start..index].to_ascii_lowercase();
    let mut attributes = HashMap::new();
    while index < bytes.len() - 1 {
        while bytes.get(index).is_some_and(u8::is_ascii_whitespace) {
            index += 1;
        }
        if bytes
            .get(index)
            .is_none_or(|byte| matches!(byte, b'/' | b'>'))
        {
            break;
        }
        let attribute_start = index;
        while bytes
            .get(index)
            .is_some_and(|byte| !byte.is_ascii_whitespace() && !matches!(byte, b'=' | b'/' | b'>'))
        {
            index += 1;
        }
        if attribute_start == index {
            index += 1;
            continue;
        }
        let attribute = value[attribute_start..index].to_ascii_lowercase();
        while bytes.get(index).is_some_and(u8::is_ascii_whitespace) {
            index += 1;
        }
        let attribute_value = if bytes.get(index) == Some(&b'=') {
            index += 1;
            while bytes.get(index).is_some_and(u8::is_ascii_whitespace) {
                index += 1;
            }
            if let Some(quote @ (b'\'' | b'"')) = bytes.get(index).copied() {
                index += 1;
                let value_start = index;
                while bytes.get(index).is_some_and(|byte| *byte != quote) {
                    index += 1;
                }
                let result = value[value_start..index].to_owned();
                if bytes.get(index) == Some(&quote) {
                    index += 1;
                }
                Some(result)
            } else {
                let value_start = index;
                while bytes
                    .get(index)
                    .is_some_and(|byte| !byte.is_ascii_whitespace() && !matches!(byte, b'/' | b'>'))
                {
                    index += 1;
                }
                Some(value[value_start..index].to_owned())
            }
        } else {
            None
        };
        attributes.insert(attribute, attribute_value);
    }
    Some(RawHtmlTag {
        name,
        closing,
        self_closing: value[..value.len() - 1].trim_end().ends_with('/'),
        attributes,
    })
}

fn apply_inline_html(
    html: &::markdown::mdast::Html,
    current: &mut InlineStyle,
    stack: &mut Vec<(String, InlineStyle)>,
    builder: &mut InlineBuilder,
) {
    let Some(tag) = parse_raw_html_tag(&html.value) else {
        return;
    };
    let start = html
        .position
        .as_ref()
        .map_or(0, |position| position.start.offset);
    let end = html
        .position
        .as_ref()
        .map_or(start + html.value.len(), |position| position.end.offset);
    if tag.closing {
        if tag.name == "q" {
            builder.push_atomic(InlineUnitKind::Text("”".into()), start, end, current);
        }
        if let Some(index) = stack.iter().rposition(|(name, _)| name == &tag.name) {
            *current = stack[index].1.clone();
            stack.truncate(index);
        }
        return;
    }

    match tag.name.as_str() {
        "br" => {
            builder.push_break(start);
            return;
        }
        "wbr" | "img" => return,
        "input" => {
            if tag
                .attributes
                .get("type")
                .and_then(Option::as_deref)
                .is_some_and(|value| value.eq_ignore_ascii_case("checkbox"))
            {
                let checked = tag.attributes.contains_key("checked");
                builder.push_atomic(
                    InlineUnitKind::Text(if checked { "☑" } else { "☐" }.into()),
                    start,
                    end,
                    current,
                );
            }
            return;
        }
        "q" => builder.push_atomic(InlineUnitKind::Text("“".into()), start, end, current),
        _ => {}
    }

    stack.push((tag.name.clone(), current.clone()));
    match tag.name.as_str() {
        "b" | "strong" => current.bold = true,
        "em" | "i" => current.italic = true,
        "del" | "s" | "strike" => current.strikethrough = true,
        "u" | "ins" | "abbr" => current.underline = true,
        "code" => current.inline_code = true,
        "kbd" | "samp" | "var" => current.keyboard = true,
        "mark" => current.highlight = true,
        "sup" => current.superscript = true,
        "sub" => current.subscript = true,
        "small" => current.small = true,
        "a" => {
            current.underline = true;
            current.link = tag
                .attributes
                .get("href")
                .and_then(Option::as_deref)
                .and_then(safe_markdown_link_url);
        }
        _ => {}
    }
    if tag.self_closing {
        *current = stack.pop().expect("HTML style frame should exist").1;
    }
}

fn render_inline_unit(
    unit: InlineUnit,
    context: &RenderContext<'_>,
    tracking: Option<InlineTracking>,
) -> AnyElement {
    let InlineUnit {
        kind,
        style,
        start,
        end,
        space_after,
    } = unit;
    if matches!(kind, InlineUnitKind::Break) {
        return div().w_full().h(px(0.0)).flex_none().into_any_element();
    }
    let reveal = context.streaming.then(|| {
        context
            .reveals
            .iter()
            .rev()
            .find(|batch| end > batch.from && start < batch.to)
    });
    let reveal = reveal.flatten().map(|batch| {
        let mut reveal_ordinals = context.reveal_ordinals.borrow_mut();
        let ordinal = reveal_ordinals.entry(batch.generation).or_default();
        let result = (batch.generation, *ordinal);
        *ordinal += 1;
        result
    });
    let token_id = format!("markdown-token:{}:{start}:{end}", context.id);
    let selectable = |text: String, suffix: &str| {
        let key = format!("{token_id}:{suffix}:{}", stable_hash(&text));
        let spec = SelectableTextSpec {
            key,
            source_start: start,
            source_end: end,
            space_after,
        };
        if let Some(tracking) = tracking {
            SelectableText::plain_tracked(
                text,
                tracking.letter_spacing_em,
                spec,
                context.selection.clone(),
                context.theme,
            )
        } else {
            SelectableText::plain(text, spec, context.selection.clone(), context.theme)
        }
    };
    let element = match kind {
        InlineUnitKind::Text(text) => div().flex_none().child(selectable(text, "text")),
        InlineUnitKind::Code(code) => div()
            .flex_none()
            .rounded(px(RADIUS_SM))
            .bg(context.theme.surface_2.hsla())
            .px(px(5.0))
            .py(px(1.0))
            .font_family("Geist Mono")
            .text_size(px(13.5))
            .child(selectable(code, "code")),
        InlineUnitKind::FileReference { path, label } => render_file_reference(
            &token_id,
            &path,
            selectable(label, "file-reference").into_any_element(),
            context.theme,
            context.interface_font.clone(),
        ),
        InlineUnitKind::FootnoteReference { identifier, number } => {
            let reference_key = footnote_reference_anchor_key(&identifier, start);
            let click_from = reference_key.clone();
            let click_to = footnote_definition_anchor_key(&identifier);
            let selection = context.selection.clone();
            let view = context.view.clone();
            let reference = div()
                .id(SharedString::from(format!(
                    "{}:footnote-reference-click:{identifier}:{start}",
                    context.id
                )))
                .flex_none()
                .relative()
                .top(px(-4.0))
                .text_size(px(10.5))
                .underline()
                .cursor_pointer()
                .on_click(move |_event, _window, cx| {
                    jump_to_markdown_anchor(&selection, &view, &click_from, &click_to, cx);
                })
                .child(selectable(
                    number.to_string(),
                    &format!("footnote-{identifier}"),
                ));
            div().flex_none().child(MarkdownAnchor::new(
                SharedString::from(format!("{}:{reference_key}", context.id)),
                reference_key,
                reference,
                context.selection.clone(),
            ))
        }
        InlineUnitKind::Break => unreachable!(),
    };
    let mut element = element.id(SharedString::from(token_id));
    if space_after {
        element = element.mr(px(
            tracking.map_or(SPACE_WIDTH, |tracking| tracking.space_width)
        ));
    }
    if style.bold {
        element = element.font_weight(FontWeight::BOLD);
    }
    if style.italic {
        element = element.italic();
    }
    if style.strikethrough {
        element = element.line_through();
    }
    if style.underline {
        element = element.underline();
    }
    if style.inline_code {
        element = element
            .rounded(px(RADIUS_SM))
            .bg(context.theme.surface_2.hsla())
            .px(px(5.0))
            .py(px(1.0))
            .font_family("Geist Mono")
            .text_size(px(13.5))
            .whitespace_nowrap();
    } else if style.keyboard {
        element = element.font_family("Geist Mono").text_size(px(13.5));
    }
    if style.highlight {
        element = element
            .bg(gpui::rgb(0xffff00))
            .text_color(gpui::rgb(0x000000));
    }
    if style.superscript {
        element = element.relative().top(px(-4.0)).text_size(px(10.5));
    } else if style.subscript {
        element = element.relative().top(px(3.0)).text_size(px(10.5));
    } else if style.small {
        element = element.text_size(px(12.5));
    }
    if let Some(url) = style.link {
        let selection = context.selection.clone();
        element = element
            .underline()
            .cursor_pointer()
            .on_click(move |_event, _window, cx| {
                if !selection.read(cx).has_selection() {
                    cx.open_url(&url);
                }
            });
    }
    if let Some((generation, ordinal)) = reveal {
        let delay = STREAM_WORD_STAGGER_MS * ordinal as u64;
        let total = STREAM_WORD_DURATION_MS + delay;
        let animation_id = SharedString::from(format!(
            "markdown-word:{}:{generation}:{}",
            context.id, start
        ));
        element
            .with_animation(
                animation_id,
                Animation::new(context.theme.motion_duration(Duration::from_millis(total))),
                move |word, delta| {
                    let elapsed = delta * total as f32;
                    let local =
                        ((elapsed - delay as f32) / STREAM_WORD_DURATION_MS as f32).clamp(0.0, 1.0);
                    word.opacity(web_ease_out(local))
                },
            )
            .into_any_element()
    } else {
        element.into_any_element()
    }
}

fn render_file_reference(
    id: &str,
    path: &str,
    label: AnyElement,
    theme: Theme,
    interface_font: SharedString,
) -> gpui::Div {
    let spec = file_icon_spec(path);
    let icon = if let Some(path) = spec.icon {
        motion_icon(
            SharedString::from(format!("{id}:file-icon")),
            path,
            15.0,
            "file-reference-icon-direct-hover",
            theme,
        )
        .into_any_element()
    } else {
        div()
            .size(px(15.0))
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(2.0))
            .border_1()
            .border_color(theme.file_reference.hsla())
            .font_family(interface_font)
            .font_weight(FontWeight(680.0))
            .text_size(px(7.2))
            .line_height(relative(1.0))
            .child(tracked_text(spec.label.unwrap_or(""), -0.06))
            .into_any_element()
    };
    div()
        .flex_none()
        .flex()
        .items_center()
        .whitespace_nowrap()
        .text_color(theme.file_reference.hsla())
        .child(div().relative().top(px(1.2)).mr(px(3.0)).child(icon))
        .child(label)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct FileIconSpec {
    kind: &'static str,
    icon: Option<&'static str>,
    label: Option<&'static str>,
}

fn file_icon_spec(path: &str) -> FileIconSpec {
    let kind = icon_kind(path).unwrap_or("code");
    match kind {
        "react" => icon_spec(kind, "icons/atom.svg"),
        "typescript" => label_spec(kind, "TS"),
        "javascript" => label_spec(kind, "JS"),
        "style" => icon_spec(kind, "icons/hash.svg"),
        "markup" => icon_spec(kind, "icons/code-xml.svg"),
        "data" => icon_spec(kind, "icons/braces.svg"),
        "markdown" => icon_spec(kind, "icons/pilcrow.svg"),
        "text" => icon_spec(kind, "icons/file-text.svg"),
        "database" => icon_spec(kind, "icons/database.svg"),
        "shell" => icon_spec(kind, "icons/square-terminal.svg"),
        "python" => label_spec(kind, "PY"),
        "rust" => icon_spec(kind, "icons/cog.svg"),
        "ruby" => icon_spec(kind, "icons/gem.svg"),
        "java" => icon_spec(kind, "icons/coffee.svg"),
        "kotlin" => label_spec(kind, "K"),
        "go" => label_spec(kind, "GO"),
        "swift" => icon_spec(kind, "icons/bird.svg"),
        "php" => label_spec(kind, "PHP"),
        "c" => label_spec(kind, "C"),
        "cpp" => label_spec(kind, "C++"),
        "csharp" => label_spec(kind, "C#"),
        "vue" => label_spec(kind, "V"),
        "svelte" => label_spec(kind, "S"),
        "image" => icon_spec(kind, "icons/image.svg"),
        "config" => icon_spec(kind, "icons/settings-2.svg"),
        "docker" => icon_spec(kind, "icons/container.svg"),
        _ => icon_spec("code", "icons/file-code-2.svg"),
    }
}

fn icon_spec(kind: &'static str, icon: &'static str) -> FileIconSpec {
    FileIconSpec {
        kind,
        icon: Some(icon),
        label: None,
    }
}

fn label_spec(kind: &'static str, label: &'static str) -> FileIconSpec {
    FileIconSpec {
        kind,
        icon: None,
        label: Some(label),
    }
}

pub(super) fn is_file_reference(path: &str) -> bool {
    icon_kind(path).is_some()
}

fn icon_kind(path: &str) -> Option<&'static str> {
    let without_position = strip_file_position(path);
    let filename = without_position
        .rsplit(['/', '\\'])
        .next()?
        .to_ascii_lowercase();
    let named = match filename.as_str() {
        "dockerfile" => Some("docker"),
        "makefile" | "procfile" => Some("shell"),
        ".gitignore" | ".gitattributes" => Some("config"),
        "license" => Some("text"),
        "readme" => Some("markdown"),
        _ => None,
    };
    if named.is_some() {
        return named;
    }
    let extension = filename
        .rsplit_once('.')
        .map_or("", |(_, extension)| extension);
    match extension {
        "tsx" | "jsx" => Some("react"),
        "ts" | "mts" | "cts" => Some("typescript"),
        "js" | "mjs" | "cjs" => Some("javascript"),
        "css" | "scss" | "sass" | "less" => Some("style"),
        "html" | "htm" | "xml" | "svg" => Some("markup"),
        "json" | "jsonc" | "yaml" | "yml" | "toml" | "csv" => Some("data"),
        "md" | "mdx" | "adoc" => Some("markdown"),
        "txt" => Some("text"),
        "sql" | "prisma" => Some("database"),
        "sh" | "bash" | "zsh" | "fish" | "ps1" | "bat" | "cmd" => Some("shell"),
        "py" => Some("python"),
        "rs" => Some("rust"),
        "rb" => Some("ruby"),
        "java" => Some("java"),
        "kt" | "kts" => Some("kotlin"),
        "go" => Some("go"),
        "swift" => Some("swift"),
        "php" => Some("php"),
        "c" | "h" => Some("c"),
        "cc" | "cpp" | "cxx" | "hpp" => Some("cpp"),
        "cs" => Some("csharp"),
        "vue" => Some("vue"),
        "svelte" => Some("svelte"),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "avif" | "ico" | "bmp" => Some("image"),
        "ini" | "conf" | "env" => Some("config"),
        "graphql" | "gql" | "dart" | "ex" | "exs" | "lua" => Some("code"),
        _ => None,
    }
}

fn strip_file_position(path: &str) -> &str {
    let bytes = path.as_bytes();
    let mut end = bytes.len();
    for _ in 0..2 {
        let Some(colon) = path[..end].rfind(':') else {
            break;
        };
        if colon + 1 < end
            && path[colon + 1..end]
                .bytes()
                .all(|byte| byte.is_ascii_digit())
        {
            end = colon;
        } else {
            break;
        }
    }
    &path[..end]
}

fn local_file_reference_path(href: &str) -> Option<String> {
    let decoded = percent_decode(href).unwrap_or_else(|| href.to_owned());
    let local = decoded.starts_with('/')
        || decoded.starts_with("\\\\")
        || decoded
            .get(..7)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("file://"))
        || is_windows_absolute_path(&decoded);
    if !local {
        return None;
    }
    let without_anchor = decoded.split(['?', '#']).next().unwrap_or(decoded.as_str());
    is_file_reference(without_anchor).then(|| without_anchor.to_owned())
}

fn safe_markdown_link_url(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().any(char::is_control) {
        return None;
    }
    if value.starts_with("//") {
        return Some(format!("https:{value}"));
    }
    let scheme_end = value.find(':');
    if scheme_end.is_some_and(|end| value[..end].contains('&')) {
        return None;
    }
    let first_path_delimiter = value.find(['/', '?', '#']).unwrap_or(value.len());
    if let Some(scheme_end) = scheme_end
        && scheme_end < first_path_delimiter
    {
        let scheme = &value[..scheme_end];
        if scheme.is_empty()
            || !scheme.bytes().enumerate().all(|(index, byte)| {
                if index == 0 {
                    byte.is_ascii_alphabetic()
                } else {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-' | b'.')
                }
            })
            || !matches!(
                scheme.to_ascii_lowercase().as_str(),
                "http" | "https" | "mailto" | "tel" | "irc" | "ircs" | "xmpp"
            )
        {
            return None;
        }
    }
    Some(value.to_owned())
}

fn safe_markdown_image_link_url(link: Option<String>) -> Option<String> {
    link.and_then(|link| safe_markdown_link_url(&link))
}

fn is_windows_absolute_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\')
}

fn percent_decode(value: &str) -> Option<String> {
    String::from_utf8(percent_decode_bytes(value)?).ok()
}

fn percent_decode_bytes(value: &str) -> Option<Vec<u8>> {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = *bytes.get(index + 1)?;
            let low = *bytes.get(index + 2)?;
            output.push(hex_value(high)? * 16 + hex_value(low)?);
            index += 3;
        } else {
            output.push(bytes[index]);
            index += 1;
        }
    }
    Some(output)
}

fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn contains_media(nodes: &[Node]) -> bool {
    nodes.iter().any(|node| match node {
        Node::Image(_) | Node::ImageReference(_) => true,
        Node::Html(html) => {
            parse_raw_html_tag(&html.value).is_some_and(|tag| !tag.closing && tag.name == "img")
        }
        Node::Strong(node) => contains_media(&node.children),
        Node::Emphasis(node) => contains_media(&node.children),
        Node::Delete(node) => contains_media(&node.children),
        Node::Link(node) => contains_media(&node.children),
        Node::LinkReference(node) => contains_media(&node.children),
        _ => false,
    })
}

fn flatten_inline_text(nodes: &[Node]) -> String {
    let mut output = String::new();
    for node in nodes {
        match node {
            Node::Text(node) => output.push_str(&node.value),
            Node::InlineCode(node) => output.push_str(&node.value),
            Node::Strong(node) => output.push_str(&flatten_inline_text(&node.children)),
            Node::Emphasis(node) => output.push_str(&flatten_inline_text(&node.children)),
            Node::Delete(node) => output.push_str(&flatten_inline_text(&node.children)),
            Node::Break(_) => output.push(' '),
            _ => {}
        }
    }
    output
}

fn collect_definitions(nodes: &[Node]) -> HashMap<String, String> {
    nodes
        .iter()
        .filter_map(|node| match node {
            Node::Definition(definition) => {
                Some((definition.identifier.clone(), definition.url.clone()))
            }
            _ => None,
        })
        .collect()
}

fn collect_footnotes(nodes: &[Node]) -> FootnoteData<'_> {
    let definitions = nodes
        .iter()
        .filter_map(|node| match node {
            Node::FootnoteDefinition(definition) => {
                Some((definition.identifier.clone(), definition))
            }
            _ => None,
        })
        .collect::<HashMap<_, _>>();
    let mut order = Vec::new();
    let mut numbers = HashMap::new();
    let mut reference_counts = HashMap::new();
    let mut reference_offsets = HashMap::<String, Vec<usize>>::new();

    fn visit(
        node: &Node,
        definitions: &HashMap<String, &::markdown::mdast::FootnoteDefinition>,
        order: &mut Vec<String>,
        numbers: &mut HashMap<String, usize>,
        reference_counts: &mut HashMap<String, usize>,
        reference_offsets: &mut HashMap<String, Vec<usize>>,
    ) {
        if let Node::FootnoteReference(reference) = node
            && definitions.contains_key(&reference.identifier)
        {
            if !numbers.contains_key(&reference.identifier) {
                let number = order.len() + 1;
                numbers.insert(reference.identifier.clone(), number);
                order.push(reference.identifier.clone());
            }
            *reference_counts
                .entry(reference.identifier.clone())
                .or_default() += 1;
            if let Some(position) = reference.position.as_ref() {
                reference_offsets
                    .entry(reference.identifier.clone())
                    .or_default()
                    .push(position.start.offset);
            }
        }
        if let Some(children) = node.children() {
            for child in children {
                visit(
                    child,
                    definitions,
                    order,
                    numbers,
                    reference_counts,
                    reference_offsets,
                );
            }
        }
    }

    for node in nodes {
        visit(
            node,
            &definitions,
            &mut order,
            &mut numbers,
            &mut reference_counts,
            &mut reference_offsets,
        );
    }
    FootnoteData {
        definitions,
        order,
        numbers,
        reference_counts,
        reference_offsets,
    }
}

fn node_start(node: &Node) -> Option<usize> {
    node.position().map(|position| position.start.offset)
}

fn node_range(node: &Node) -> (usize, usize) {
    node.position().map_or((0, 0), |position| {
        (position.start.offset, position.end.offset)
    })
}

fn stable_hash(value: &str) -> u64 {
    use std::hash::{DefaultHasher, Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    value.hash(&mut hasher);
    hasher.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assets::HarnessAssets;
    use gpui::AssetSource;

    #[test]
    fn file_reference_detection_matches_the_web_component() {
        assert_eq!(icon_kind("Sidebar.tsx"), Some("react"));
        assert_eq!(icon_kind("app.css"), Some("style"));
        assert_eq!(icon_kind("README.md:12:4"), Some("markdown"));
        assert_eq!(icon_kind(r"C:\\work\\main.rs:9"), Some("rust"));
        assert_eq!(icon_kind("Dockerfile"), Some("docker"));
        assert_eq!(icon_kind("pnpm typecheck"), None);
        assert!(is_file_reference("schema.sql"));
        assert!(!is_file_reference("no-extension"));
        assert_eq!(file_icon_spec("view.tsx").kind, "react");
        assert_eq!(file_icon_spec("script.ts").label, Some("TS"));
    }

    #[test]
    fn common_web_syntax_languages_are_registered_natively() {
        crate::theme::register_native_syntax_languages();
        let registered = gpui_component::highlighter::LanguageRegistry::singleton().languages();
        for (language, source) in [
            ("typescript", "const answer: number = 42;"),
            ("tsx", "const view = <button>Save</button>;"),
            ("javascript", "const answer = 42;"),
            ("jsx", "const view = <button>Save</button>;"),
            ("json", r#"{"enabled": true}"#),
            ("bash", "echo \"hello\""),
            ("shell", "echo \"hello\""),
            ("python", "def greet(name: str): return name"),
            ("css", ".button { color: red; }"),
            ("html", "<button disabled>Save</button>"),
            ("markdown", "# Heading"),
            ("yaml", "enabled: true"),
            ("diff", "-old\n+new"),
            ("sql", "SELECT id FROM users;"),
            ("rust", "fn answer() -> u32 { 42 }"),
            ("go", "func answer() int { return 42 }"),
        ] {
            let native = native_syntax_language(language);
            assert!(
                registered
                    .iter()
                    .any(|candidate| candidate.as_ref() == native.as_ref()),
                "{language} should resolve to the registered {native} grammar"
            );
            let rope = Rope::from(source);
            let mut highlighter = SyntaxHighlighter::new(native.as_ref());
            highlighter.update(None, &rope);
            let highlights = highlighter.styles(
                &(0..source.len()),
                &github_highlight_theme_for_language(ThemeMode::Dark, language),
            );
            assert!(
                highlights.iter().any(|(_, style)| style.color.is_some()),
                "{language} should produce colored native highlight spans: {highlights:?}"
            );
        }
        assert_eq!(native_syntax_language("jsx"), "jsx");
        assert_eq!(native_syntax_language("shell"), "bash");
    }

    #[test]
    fn syntax_highlight_cache_reuses_only_matching_content_and_theme() {
        let mut cache = SyntaxHighlightCache::default();
        let highlights = vec![(0..4, HighlightStyle::default())];
        let source = "code".to_owned();
        let source_hash = stable_hash(&source);
        cache.insert(
            12,
            true,
            SyntaxHighlightCacheEntry::new("rust", 1, source_hash, &source, highlights.clone()),
        );

        assert_eq!(
            cache.lookup(12, true, "rust", 1, &source),
            Ok(highlights.clone())
        );
        let reparsed = source.clone();
        assert_eq!(cache.lookup(12, true, "rust", 2, &reparsed), Ok(highlights));
        assert!(cache.lookup(12, false, "rust", 2, &source).is_err());
        assert!(cache.lookup(12, true, "python", 2, &source).is_err());
        assert!(cache.lookup(12, true, "rust", 2, "edit").is_err());
        assert!(cache.lookup(12, true, "rust", 2, "longer").is_err());
    }

    #[test]
    fn file_reference_icons_are_embedded_native_assets() {
        let assets = HarnessAssets;
        for filename in [
            "view.tsx",
            "app.css",
            "index.html",
            "data.json",
            "README.md",
            "notes.txt",
            "schema.sql",
            "build.sh",
            "main.rs",
            "script.rb",
            "Main.java",
            "App.swift",
            "image.png",
            ".gitignore",
            "Dockerfile",
            "unknown.extension",
        ] {
            let spec = file_icon_spec(filename);
            let Some(icon) = spec.icon else {
                continue;
            };
            assert!(
                assets
                    .load(icon)
                    .expect("asset lookup should succeed")
                    .is_some(),
                "{icon} for {filename} must be registered in HarnessAssets"
            );
        }
    }

    #[test]
    fn local_file_links_are_decoded_but_malformed_escapes_are_preserved() {
        assert_eq!(
            local_file_reference_path("/Users/blue/My%20App/Sidebar.tsx:119#L2"),
            Some("/Users/blue/My App/Sidebar.tsx:119".into())
        );
        assert_eq!(
            local_file_reference_path(r"C:\\work\\main.rs:9"),
            Some(r"C:\\work\\main.rs:9".into())
        );
        assert_eq!(
            local_file_reference_path("https://example.com/app.ts"),
            None
        );
        assert_eq!(
            local_file_reference_path("/tmp/bad%2G.rs"),
            Some("/tmp/bad%2G.rs".into())
        );
    }

    #[test]
    fn markdown_links_reject_active_and_local_protocols() {
        assert_eq!(
            safe_markdown_link_url("HTTPS://example.com/path"),
            Some("HTTPS://example.com/path".into())
        );
        assert_eq!(
            safe_markdown_link_url("//example.com/path"),
            Some("https://example.com/path".into())
        );
        assert_eq!(
            safe_markdown_link_url("mailto:test@example.com"),
            Some("mailto:test@example.com".into())
        );
        assert_eq!(safe_markdown_link_url("javascript:alert(1)"), None);
        assert_eq!(safe_markdown_link_url("file:///tmp/private.txt"), None);
        assert_eq!(safe_markdown_link_url("java&#x73;cript:alert(1)"), None);
    }

    #[test]
    fn linked_markdown_images_use_the_same_url_safety_boundary() {
        assert_eq!(
            safe_markdown_image_link_url(Some("//example.com/full.png".into())),
            Some("https://example.com/full.png".into())
        );
        assert_eq!(
            safe_markdown_image_link_url(Some("javascript:alert(1)".into())),
            None
        );
        assert_eq!(
            safe_markdown_image_link_url(Some("file:///tmp/private.png".into())),
            None
        );
    }

    #[test]
    fn raw_inline_html_updates_native_text_styles_without_showing_tags() {
        let opening = ::markdown::mdast::Html {
            value: "<strong data-ignored='yes'>".into(),
            position: None,
        };
        let closing = ::markdown::mdast::Html {
            value: "</strong>".into(),
            position: None,
        };
        let mut style = InlineStyle::default();
        let mut stack = Vec::new();
        let mut builder = InlineBuilder::default();

        apply_inline_html(&opening, &mut style, &mut stack, &mut builder);
        assert!(style.bold);
        assert!(builder.units.is_empty());
        apply_inline_html(&closing, &mut style, &mut stack, &mut builder);
        assert!(!style.bold);
        assert!(stack.is_empty());
    }

    #[test]
    fn raw_html_sanitizer_matches_the_streamdown_safety_boundary() {
        let sanitized = sanitize_html_fragment(
            "<script>alert(1)</script><p><strong>Safe</strong> <a href='javascript:bad'>bad</a> <a href='https://example.com'>good</a><input type='checkbox' checked></p>",
        );

        assert!(!sanitized.contains("script"));
        assert!(!sanitized.contains("alert"));
        assert!(!sanitized.contains("javascript"));
        assert!(sanitized.contains("<strong>Safe</strong>"));
        assert!(sanitized.contains("href=\"https://example.com\""));
        assert!(sanitized.contains("type=\"checkbox\""));
        assert!(sanitized.contains(" checked"));
        assert!(sanitized.contains(" disabled"));
    }

    #[test]
    fn markdown_images_decode_data_and_resolve_project_paths() {
        let (format, bytes) =
            decode_data_image("data:image/png;base64,iVBORw0KGgo=").expect("valid data image");
        assert_eq!(format, ImageFormat::Png);
        assert_eq!(bytes, b"\x89PNG\r\n\x1a\n");
        assert_eq!(
            markdown_image_path("shots/result%201.png#preview", Some("/work/project")),
            Some(PathBuf::from("/work/project/shots/result 1.png"))
        );
        assert_eq!(markdown_image_path("https://example.com/a.png", None), None);
    }

    #[test]
    fn markdown_image_download_names_match_streamdown_rules() {
        assert_eq!(
            image_download_filename(
                "https://example.com/shots/result.webp?raw=1",
                "ignored",
                Some("png")
            ),
            "result.webp"
        );
        assert_eq!(
            image_download_filename("data:image/svg+xml,%3Csvg%2F%3E", "System diagram", None),
            "System diagram.svg"
        );
        assert_eq!(
            image_download_filename("https://example.com/render", "", Some("jpg")),
            "render.jpg"
        );
    }

    #[test]
    fn stream_motion_uses_the_streamdown_timing_contract() {
        assert_eq!(stream_batch_duration(1), Duration::from_millis(160));
        assert_eq!(stream_batch_duration(4), Duration::from_millis(202));
        assert_eq!(STREAM_WORD_STAGGER_MS, 14);
    }

    #[test]
    fn selected_markdown_text_preserves_visual_separators_without_markup() {
        let source = "Hello **bold** world\n\n| A | B |";
        let segments = [
            MarkdownSelectionSegment {
                source_start: 8,
                source_end: 12,
                text: "bold".into(),
                selected: Some(0..4),
                space_after: true,
            },
            MarkdownSelectionSegment {
                source_start: 0,
                source_end: 5,
                text: "Hello".into(),
                selected: Some(0..5),
                space_after: true,
            },
            MarkdownSelectionSegment {
                source_start: 15,
                source_end: 20,
                text: "world".into(),
                selected: Some(0..5),
                space_after: false,
            },
            MarkdownSelectionSegment {
                source_start: 24,
                source_end: 25,
                text: "A".into(),
                selected: Some(0..1),
                space_after: false,
            },
            MarkdownSelectionSegment {
                source_start: 28,
                source_end: 29,
                text: "B".into(),
                selected: Some(0..1),
                space_after: false,
            },
        ];

        assert_eq!(
            selected_markdown_text(source, segments.iter()),
            Some("Hello bold world\n\nA\tB".into())
        );
    }

    #[test]
    fn selected_markdown_text_does_not_invent_space_after_partial_word() {
        let segments = [
            MarkdownSelectionSegment {
                source_start: 0,
                source_end: 5,
                text: "Hello".into(),
                selected: Some(1..4),
                space_after: true,
            },
            MarkdownSelectionSegment {
                source_start: 6,
                source_end: 11,
                text: "world".into(),
                selected: Some(0..3),
                space_after: false,
            },
        ];

        assert_eq!(
            selected_markdown_text("Hello world", segments.iter()),
            Some("ellwor".into())
        );
    }

    #[test]
    fn incomplete_markdown_remains_renderable_while_streaming() {
        let parsed = ::markdown::to_mdast(
            "A **partial reply\n\n```rust\nfn main(",
            &ParseOptions::gfm(),
        );
        assert!(matches!(parsed, Ok(Node::Root(_))));
    }

    #[test]
    fn markdown_document_reuses_unchanged_ast_and_reparses_changes() {
        let mut document = MarkdownDocument::new("First **answer**".into());
        let first = document.root.clone().expect("parse first document");

        assert!(!document.set_source("First **answer**"));
        assert!(Arc::ptr_eq(
            &first,
            document.root.as_ref().expect("retain cached document")
        ));
        assert!(document.set_source("Second `answer`"));
        assert_eq!(document.source, "Second `answer`");
        assert!(!Arc::ptr_eq(
            &first,
            document.root.as_ref().expect("parse changed document")
        ));
    }

    #[test]
    #[ignore = "performance benchmark"]
    fn benchmark_repeated_markdown_parse() {
        const SAMPLES: usize = 9;
        const ITERATIONS: usize = 50;
        let text = (0..80)
            .map(|index| {
                format!(
                    "## Result {index}\n\nA response with **formatted text**, [a link](https://example.com), and `inline code`.\n\n- first item\n- second item\n\n```rust\nfn result_{index}() -> usize {{ {index} }}\n```\n\n| Name | Value |\n| --- | ---: |\n| row | {index} |\n\n"
                )
            })
            .collect::<String>();
        let mut samples = Vec::with_capacity(SAMPLES);
        for _ in 0..SAMPLES {
            let started = Instant::now();
            for _ in 0..ITERATIONS {
                std::hint::black_box(
                    ::markdown::to_mdast(&text, &ParseOptions::gfm()).expect("parse markdown"),
                );
            }
            samples.push(started.elapsed());
        }
        samples.sort_unstable();
        let median = samples[SAMPLES / 2];
        let p95 = samples[((SAMPLES as f64 * 0.95).ceil() as usize - 1).min(SAMPLES - 1)];
        println!(
            "markdown_parse bytes={} iterations={ITERATIONS} median_ns={} p95_ns={} median_ns_per_parse={:.2} p95_ns_per_parse={:.2}",
            text.len(),
            median.as_nanos(),
            p95.as_nanos(),
            median.as_nanos() as f64 / ITERATIONS as f64,
            p95.as_nanos() as f64 / ITERATIONS as f64,
        );

        let mut document = MarkdownDocument::new(text.clone());
        let mut cache_samples = Vec::with_capacity(SAMPLES);
        for _ in 0..SAMPLES {
            let started = Instant::now();
            for _ in 0..ITERATIONS {
                std::hint::black_box(document.set_source(std::hint::black_box(text.as_str())));
                std::hint::black_box(document.root.as_ref());
            }
            cache_samples.push(started.elapsed());
        }
        cache_samples.sort_unstable();
        let median = cache_samples[SAMPLES / 2];
        let p95 = cache_samples[((SAMPLES as f64 * 0.95).ceil() as usize - 1).min(SAMPLES - 1)];
        println!(
            "markdown_cache_hit bytes={} iterations={ITERATIONS} median_ns={} p95_ns={} median_ns_per_hit={:.2} p95_ns_per_hit={:.2}",
            text.len(),
            median.as_nanos(),
            p95.as_nanos(),
            median.as_nanos() as f64 / ITERATIONS as f64,
            p95.as_nanos() as f64 / ITERATIONS as f64,
        );
    }

    #[test]
    fn footnotes_follow_first_reference_order_and_track_backlinks() {
        let parsed = ::markdown::to_mdast(
            "First[^b], second[^a], and first again[^b].\n\n[^a]: Alpha\n[^b]: Beta",
            &ParseOptions::gfm(),
        )
        .expect("GFM footnotes should parse");
        let Node::Root(root) = parsed else {
            panic!("expected a Markdown root");
        };
        let footnotes = collect_footnotes(&root.children);

        assert_eq!(footnotes.order, ["b", "a"]);
        assert_eq!(footnotes.numbers.get("b"), Some(&1));
        assert_eq!(footnotes.numbers.get("a"), Some(&2));
        assert_eq!(footnotes.reference_counts.get("b"), Some(&2));
        assert_eq!(footnotes.reference_counts.get("a"), Some(&1));
        assert_eq!(footnotes.reference_offsets.get("b"), Some(&vec![5, 38]));
        assert!(footnotes.has_visible_definitions());
    }

    #[test]
    fn table_copy_uses_tsv_without_markdown_delimiters() {
        let parsed = ::markdown::to_mdast(
            "| Name | Count |\n| --- | ---: |\n| A | 2 |",
            &ParseOptions::gfm(),
        )
        .expect("GFM table should parse");
        let Node::Root(root) = parsed else {
            panic!("expected a Markdown root");
        };
        let table = root.children.iter().find_map(|node| match node {
            Node::Table(table) => Some(table),
            _ => None,
        });
        let data = table.map(table_data);

        assert_eq!(
            data.as_ref().map(format_table_tsv),
            Some("Name\tCount\nA\t2".into())
        );
    }

    #[test]
    fn table_exports_match_streamdown_escaping() {
        let data = TableData {
            headers: vec!["A|B".into(), "Count".into()],
            rows: vec![
                vec![r"x\y".into(), "2".into()],
                vec!["quoted, \"value\"".into(), "line\nbreak".into()],
            ],
        };

        assert_eq!(
            format_table_markdown(&data),
            "| A\\|B | Count |\n| --- | --- |\n| x\\\\y | 2 |\n| quoted, \"value\" | line\nbreak |"
        );
        assert_eq!(
            format_table_csv(&data),
            "A|B,Count\nx\\y,2\n\"quoted, \"\"value\"\"\",\"line\nbreak\""
        );
        assert_eq!(
            format_table_tsv(&TableData {
                headers: vec!["A\tB".into()],
                rows: vec![vec!["line\r\nbreak".into()]],
            }),
            "A\\tB\nline\\r\\nbreak"
        );
    }
}
