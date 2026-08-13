use gpui::{
    App, AvailableSpace, Bounds, Element, ElementId, FontFeatures, GlobalElementId,
    InspectorElementId, IntoElement, LayoutId, Pixels, SharedString, Size, StrikethroughStyle,
    TextAlign, TextOverflow, TextRun, UnderlineStyle, WhiteSpace, Window, point, size,
};
use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

/// Paints uniformly styled text with CSS-compatible letter spacing.
///
/// GPUI 0.2.2 does not expose tracking in `TextStyle`, but its shaped glyph
/// positions are public. Keeping the adjustment here preserves GPUI's native
/// shaping, font fallback, glyph cache, wrapping, and rasterization while
/// matching the handful of tracked labels in the web oracle.
pub(crate) fn tracked_text(text: impl Into<SharedString>, letter_spacing_em: f32) -> TrackedText {
    TrackedText {
        text: text.into(),
        letter_spacing_em,
    }
}

pub(crate) struct TrackedText {
    text: SharedString,
    letter_spacing_em: f32,
}

#[derive(Clone, Default)]
pub(crate) struct TrackedTextLayout(Rc<RefCell<Option<TrackedTextLayoutState>>>);

struct TrackedTextLayoutState {
    line: gpui::ShapedLine,
    clusters: Vec<TrackedCluster>,
    visual_lines: Vec<TrackedVisualLine>,
    line_height: Pixels,
    letter_spacing: Pixels,
    color: gpui::Hsla,
    underline: Option<UnderlineStyle>,
    strikethrough: Option<StrikethroughStyle>,
    align: TextAlign,
    bounds: Option<Bounds<Pixels>>,
}

impl TrackedTextLayout {
    pub(crate) fn line_height(&self) -> Pixels {
        self.0
            .borrow()
            .as_ref()
            .expect("tracked text must be measured")
            .line_height
    }

    pub(crate) fn position_for_index(&self, index: usize) -> Option<gpui::Point<Pixels>> {
        let layout = self.0.borrow();
        let state = layout.as_ref().expect("tracked text must be measured");
        let bounds = state.bounds.expect("tracked text must be prepainted");
        let cluster_ordinal = state
            .clusters
            .iter()
            .position(|cluster| cluster.source_index >= index)
            .unwrap_or(state.clusters.len());
        for (line_ordinal, visual_line) in state.visual_lines.iter().enumerate() {
            if cluster_ordinal < visual_line.start_cluster
                || cluster_ordinal > visual_line.end_cluster
            {
                continue;
            }
            let horizontal_offset =
                aligned_offset(state.align, bounds.size.width, visual_line.width);
            let x = if cluster_ordinal == visual_line.end_cluster {
                visual_line.width
            } else {
                tracked_cluster_x(&state.clusters, cluster_ordinal, state.letter_spacing)
                    - visual_line.start_x
            };
            return Some(point(
                bounds.origin.x + horizontal_offset + x,
                bounds.origin.y + state.line_height * line_ordinal as f32,
            ));
        }
        None
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct TrackedVisualLine {
    start_cluster: usize,
    end_cluster: usize,
    start_x: Pixels,
    width: Pixels,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct TrackedCluster {
    source_index: usize,
    x: Pixels,
}

impl Element for TrackedText {
    type RequestLayoutState = TrackedTextLayout;
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _global_id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        _cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        debug_assert!(
            !self.text.contains('\n'),
            "tracked text does not accept hard line breaks"
        );
        let layout = TrackedTextLayout::default();
        let layout_for_measure = layout.clone();
        let text = self.text.clone();
        let text_style = window.text_style();
        let font_size = text_style.font_size.to_pixels(window.rem_size());
        let line_height = text_style
            .line_height
            .to_pixels(font_size.into(), window.rem_size());
        let letter_spacing = font_size * self.letter_spacing_em;
        let mut run = text_style.to_run(text.len());
        disable_spacing_ligatures(&mut run);
        let color = text_style.color;
        let align = text_style.text_align;
        let underline = text_style.underline;
        let strikethrough = text_style.strikethrough;
        let white_space = text_style.white_space;
        let text_overflow = text_style.text_overflow.clone();

        let layout_id = window.request_measured_layout(
            Default::default(),
            move |known_dimensions, available_space, window, _cx| {
                let available_width = known_dimensions.width.or(match available_space.width {
                    AvailableSpace::Definite(width) => Some(width),
                    AvailableSpace::MinContent | AvailableSpace::MaxContent => None,
                });
                let (mut line, mut clusters, mut unwrapped_width) =
                    shape_tracked_text(text.clone(), font_size, &run, letter_spacing, window);
                let mut display_text = text.clone();
                if let (Some(TextOverflow::Truncate(suffix)), Some(width)) =
                    (text_overflow.as_ref(), available_width)
                    && unwrapped_width > width
                {
                    display_text = truncate_tracked_text(
                        &text,
                        suffix,
                        width,
                        font_size,
                        &run,
                        letter_spacing,
                        window,
                    );
                    (line, clusters, unwrapped_width) = shape_tracked_text(
                        display_text.clone(),
                        font_size,
                        &run,
                        letter_spacing,
                        window,
                    );
                }
                let wrap_width = (white_space == WhiteSpace::Normal)
                    .then_some(available_width)
                    .flatten();
                let visual_lines = wrap_tracked_clusters(
                    &display_text,
                    &clusters,
                    unwrapped_width,
                    letter_spacing,
                    wrap_width,
                );
                let content_width = wrap_width
                    .map(|width| unwrapped_width.min(width))
                    .unwrap_or(unwrapped_width);
                let intrinsic = size(
                    content_width.ceil(),
                    (line_height * visual_lines.len() as f32).ceil(),
                );
                let measured = Size {
                    width: known_dimensions.width.unwrap_or(intrinsic.width),
                    height: known_dimensions.height.unwrap_or(intrinsic.height),
                };
                layout_for_measure
                    .0
                    .borrow_mut()
                    .replace(TrackedTextLayoutState {
                        line,
                        clusters,
                        visual_lines,
                        line_height,
                        letter_spacing,
                        color,
                        underline,
                        strikethrough,
                        align,
                        bounds: None,
                    });
                measured
            },
        );
        (layout_id, layout)
    }

    fn prepaint(
        &mut self,
        _global_id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        layout: &mut Self::RequestLayoutState,
        _window: &mut Window,
        _cx: &mut App,
    ) -> Self::PrepaintState {
        layout
            .0
            .borrow_mut()
            .as_mut()
            .expect("tracked text must be measured before prepaint")
            .bounds = Some(bounds);
    }

    fn paint(
        &mut self,
        _global_id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: Bounds<Pixels>,
        layout: &mut Self::RequestLayoutState,
        _prepaint: &mut Self::PrepaintState,
        window: &mut Window,
        _cx: &mut App,
    ) {
        let layout = layout.0.borrow();
        let state = layout
            .as_ref()
            .expect("tracked text must be measured before paint");
        let bounds = state
            .bounds
            .expect("tracked text must be prepainted before paint");
        let padding_top = (state.line_height - state.line.ascent - state.line.descent) / 2.0;
        window.paint_layer(bounds, |window| {
            for (line_ordinal, visual_line) in state.visual_lines.iter().enumerate() {
                let horizontal_offset =
                    aligned_offset(state.align, bounds.size.width, visual_line.width);
                let baseline_y = bounds.origin.y
                    + state.line_height * line_ordinal as f32
                    + padding_top
                    + state.line.ascent;
                let mut cluster_ordinal = 0usize;
                let mut previous_cluster = None;

                for run in &state.line.runs {
                    for glyph in &run.glyphs {
                        if previous_cluster.is_some_and(|index| index != glyph.index) {
                            cluster_ordinal += 1;
                        }
                        previous_cluster = Some(glyph.index);
                        if cluster_ordinal < visual_line.start_cluster
                            || cluster_ordinal >= visual_line.end_cluster
                        {
                            continue;
                        }
                        let origin = point(
                            bounds.origin.x
                                + horizontal_offset
                                + glyph.position.x
                                + state.letter_spacing * cluster_ordinal as f32
                                - visual_line.start_x,
                            baseline_y,
                        );
                        if glyph.is_emoji {
                            let _ = window.paint_emoji(
                                origin,
                                run.font_id,
                                glyph.id,
                                state.line.font_size,
                            );
                        } else {
                            let _ = window.paint_glyph(
                                origin,
                                run.font_id,
                                glyph.id,
                                state.line.font_size,
                                state.color,
                            );
                        }
                    }
                }
                let line_origin_x = bounds.origin.x + horizontal_offset;
                if let Some(mut underline) = state.underline {
                    underline.color = Some(underline.color.unwrap_or(state.color));
                    window.paint_underline(
                        point(line_origin_x, baseline_y + state.line.descent * 0.618),
                        visual_line.width,
                        &underline,
                    );
                }
                if let Some(mut strikethrough) = state.strikethrough {
                    strikethrough.color = Some(strikethrough.color.unwrap_or(state.color));
                    window.paint_strikethrough(
                        point(
                            line_origin_x,
                            bounds.origin.y
                                + state.line_height * line_ordinal as f32
                                + ((state.line.ascent * 0.5 + padding_top + state.line.ascent)
                                    * 0.5),
                        ),
                        visual_line.width,
                        &strikethrough,
                    );
                }
            }
        });
    }
}

impl IntoElement for TrackedText {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

fn shape_tracked_text(
    text: SharedString,
    font_size: Pixels,
    run: &TextRun,
    letter_spacing: Pixels,
    window: &mut Window,
) -> (gpui::ShapedLine, Vec<TrackedCluster>, Pixels) {
    let mut display_run = run.clone();
    display_run.len = text.len();
    let line =
        window
            .text_system()
            .shape_line(text, font_size, std::slice::from_ref(&display_run), None);
    let clusters = shaped_clusters(&line);
    let width = tracked_width(line.width, letter_spacing, clusters.len());
    (line, clusters, width)
}

fn truncate_tracked_text(
    text: &str,
    suffix: &str,
    max_width: Pixels,
    font_size: Pixels,
    run: &TextRun,
    letter_spacing: Pixels,
    window: &mut Window,
) -> SharedString {
    truncate_to_width(text, suffix, max_width, |candidate| {
        let (_, _, width) = shape_tracked_text(
            candidate.to_owned().into(),
            font_size,
            run,
            letter_spacing,
            window,
        );
        width
    })
    .into()
}

fn truncate_to_width(
    text: &str,
    suffix: &str,
    max_width: Pixels,
    mut measure: impl FnMut(&str) -> Pixels,
) -> String {
    let mut boundaries = text
        .char_indices()
        .map(|(index, _)| index)
        .chain(std::iter::once(text.len()))
        .collect::<Vec<_>>();
    boundaries.dedup();
    let mut low = 0usize;
    let mut high = boundaries.len();
    let mut best = suffix.to_owned();
    while low < high {
        let middle = low + (high - low) / 2;
        let candidate = format!("{}{}", &text[..boundaries[middle]], suffix);
        if measure(&candidate) <= max_width {
            best = candidate;
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    best
}

fn shaped_clusters(line: &gpui::ShapedLine) -> Vec<TrackedCluster> {
    let mut clusters = Vec::new();
    let mut previous = None;
    for glyph in line.runs.iter().flat_map(|run| &run.glyphs) {
        if previous != Some(glyph.index) {
            clusters.push(TrackedCluster {
                source_index: glyph.index,
                x: glyph.position.x,
            });
            previous = Some(glyph.index);
        }
    }
    clusters
}

fn tracked_width(base: Pixels, letter_spacing: Pixels, cluster_count: usize) -> Pixels {
    let gaps = cluster_count.saturating_sub(1) as f32;
    (base + letter_spacing * gaps).max(Pixels::ZERO)
}

fn tracked_cluster_x(
    clusters: &[TrackedCluster],
    cluster: usize,
    letter_spacing: Pixels,
) -> Pixels {
    clusters
        .get(cluster)
        .map(|cluster_position| cluster_position.x + letter_spacing * cluster as f32)
        .unwrap_or(Pixels::ZERO)
}

fn aligned_offset(align: TextAlign, bounds_width: Pixels, content_width: Pixels) -> Pixels {
    match align {
        TextAlign::Left => Pixels::ZERO,
        TextAlign::Center => (bounds_width - content_width) / 2.0,
        TextAlign::Right => bounds_width - content_width,
    }
}

fn wrap_tracked_clusters(
    text: &str,
    clusters: &[TrackedCluster],
    unwrapped_width: Pixels,
    letter_spacing: Pixels,
    wrap_width: Option<Pixels>,
) -> Vec<TrackedVisualLine> {
    let words = tracked_words(text, clusters);
    if words.is_empty() {
        return vec![TrackedVisualLine {
            start_cluster: 0,
            end_cluster: 0,
            start_x: Pixels::ZERO,
            width: Pixels::ZERO,
        }];
    }

    let adjusted_x = |cluster: usize| {
        if let Some(cluster_position) = clusters.get(cluster) {
            cluster_position.x + letter_spacing * cluster as f32
        } else {
            unwrapped_width
        }
    };
    let Some(wrap_width) = wrap_width else {
        let start_cluster = words[0].0;
        let end_cluster = words.last().expect("non-empty words").1;
        let start_x = adjusted_x(start_cluster);
        return vec![TrackedVisualLine {
            start_cluster,
            end_cluster,
            start_x,
            width: (adjusted_x(end_cluster) - start_x).max(Pixels::ZERO),
        }];
    };

    let mut lines = Vec::new();
    let mut line_start = words[0].0;
    let mut line_end = words[0].1;
    for &(word_start, word_end) in words.iter().skip(1) {
        let candidate_width = adjusted_x(word_end) - adjusted_x(line_start);
        if candidate_width > wrap_width {
            let start_x = adjusted_x(line_start);
            lines.push(TrackedVisualLine {
                start_cluster: line_start,
                end_cluster: line_end,
                start_x,
                width: (adjusted_x(line_end) - start_x).max(Pixels::ZERO),
            });
            line_start = word_start;
        }
        line_end = word_end;
    }
    let start_x = adjusted_x(line_start);
    lines.push(TrackedVisualLine {
        start_cluster: line_start,
        end_cluster: line_end,
        start_x,
        width: (adjusted_x(line_end) - start_x).max(Pixels::ZERO),
    });
    lines
}

fn tracked_words(text: &str, clusters: &[TrackedCluster]) -> Vec<(usize, usize)> {
    let mut words = Vec::new();
    let mut cluster = 0;
    while cluster < clusters.len() {
        while cluster < clusters.len() && cluster_is_whitespace(text, clusters[cluster]) {
            cluster += 1;
        }
        let start = cluster;
        while cluster < clusters.len() && !cluster_is_whitespace(text, clusters[cluster]) {
            cluster += 1;
        }
        if start < cluster {
            words.push((start, cluster));
        }
    }
    words
}

fn cluster_is_whitespace(text: &str, cluster: TrackedCluster) -> bool {
    text.get(cluster.source_index..)
        .and_then(|text| text.chars().next())
        .is_some_and(char::is_whitespace)
}

fn disable_spacing_ligatures(run: &mut TextRun) {
    let mut features = run.font.features.tag_value_list().to_vec();
    for tag in ["liga", "clig", "dlig", "hlig", "calt"] {
        if let Some((_, value)) = features.iter_mut().find(|(feature, _)| feature == tag) {
            *value = 0;
        } else {
            features.push((tag.into(), 0));
        }
    }
    run.font.features = FontFeatures(Arc::new(features));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracking_changes_only_inter_cluster_gaps() {
        assert_eq!(
            tracked_width(gpui::px(100.0), gpui::px(2.0), 0),
            gpui::px(100.0)
        );
        assert_eq!(
            tracked_width(gpui::px(100.0), gpui::px(2.0), 1),
            gpui::px(100.0)
        );
        assert_eq!(
            tracked_width(gpui::px(100.0), gpui::px(2.0), 4),
            gpui::px(106.0)
        );
        assert_eq!(
            tracked_width(gpui::px(100.0), gpui::px(-2.0), 4),
            gpui::px(94.0)
        );
    }

    #[test]
    fn excessive_negative_tracking_never_reports_a_negative_width() {
        assert_eq!(
            tracked_width(gpui::px(4.0), gpui::px(-8.0), 3),
            Pixels::ZERO
        );
    }

    #[test]
    fn truncation_keeps_utf8_boundaries_and_the_configured_suffix() {
        let result = truncate_to_width("Ångström", "…", gpui::px(40.0), |candidate| {
            gpui::px(candidate.chars().count() as f32 * 10.0)
        });
        assert_eq!(result, "Ång…");

        let suffix_only = truncate_to_width("alpha", "…", gpui::px(5.0), |candidate| {
            gpui::px(candidate.chars().count() as f32 * 10.0)
        });
        assert_eq!(suffix_only, "…");
    }

    #[test]
    fn wrapping_breaks_before_the_word_that_exceeds_the_available_width() {
        let text = "alpha beta";
        let clusters = text
            .char_indices()
            .enumerate()
            .map(|(ordinal, (source_index, _))| TrackedCluster {
                source_index,
                x: gpui::px(ordinal as f32 * 10.0),
            })
            .collect::<Vec<_>>();

        assert_eq!(
            wrap_tracked_clusters(
                text,
                &clusters,
                gpui::px(100.0),
                Pixels::ZERO,
                Some(gpui::px(55.0)),
            ),
            vec![
                TrackedVisualLine {
                    start_cluster: 0,
                    end_cluster: 5,
                    start_x: gpui::px(0.0),
                    width: gpui::px(50.0),
                },
                TrackedVisualLine {
                    start_cluster: 6,
                    end_cluster: 10,
                    start_x: gpui::px(60.0),
                    width: gpui::px(40.0),
                },
            ]
        );
    }

    #[test]
    fn wrapping_keeps_an_overwide_word_intact() {
        let text = "alpha";
        let clusters = text
            .char_indices()
            .enumerate()
            .map(|(ordinal, (source_index, _))| TrackedCluster {
                source_index,
                x: gpui::px(ordinal as f32 * 10.0),
            })
            .collect::<Vec<_>>();

        assert_eq!(
            wrap_tracked_clusters(
                text,
                &clusters,
                gpui::px(50.0),
                Pixels::ZERO,
                Some(gpui::px(30.0)),
            ),
            vec![TrackedVisualLine {
                start_cluster: 0,
                end_cluster: 5,
                start_x: gpui::px(0.0),
                width: gpui::px(50.0),
            }]
        );
    }

    #[test]
    fn word_boundaries_follow_utf8_cluster_indices() {
        let text = "Ångström beta";
        let clusters = text
            .char_indices()
            .enumerate()
            .map(|(ordinal, (source_index, _))| TrackedCluster {
                source_index,
                x: gpui::px(ordinal as f32),
            })
            .collect::<Vec<_>>();

        assert_eq!(tracked_words(text, &clusters), vec![(0, 8), (9, 13)]);
    }

    #[test]
    fn tracked_runs_disable_ligatures_that_would_hide_character_gaps() {
        let mut run = gpui::TextStyle::default().to_run(5);
        disable_spacing_ligatures(&mut run);
        for tag in ["liga", "clig", "dlig", "hlig", "calt"] {
            assert_eq!(
                run.font
                    .features
                    .tag_value_list()
                    .iter()
                    .find(|(feature, _)| feature == tag)
                    .map(|(_, value)| *value),
                Some(0)
            );
        }
    }
}
