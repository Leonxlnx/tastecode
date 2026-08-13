use super::*;
use gpui_component::scroll::ScrollableElement;
use harness_protocol::{DiffFile, DiffFileStatus, DiffHunk, DiffLine, PlanStepStatus, SessionDiff};

#[derive(Default)]
pub(super) struct DiffUiState {
    source: Option<String>,
    summary: Option<DiffSummary>,
    reviewing: bool,
    snapshot: Option<SessionDiff>,
    loading: bool,
    show_slow_load: bool,
    busy: bool,
    status: Option<String>,
    stale_refresh: bool,
    show_all_files: bool,
    files_toggle_transition: u64,
}

impl DiffUiState {
    pub(super) fn has_summary(&self) -> bool {
        self.summary.is_some()
    }

    pub(super) fn reset(&mut self) {
        *self = Self::default();
    }

    fn sync_summary(&mut self, source: Option<&str>) {
        if self.source.as_deref() == source {
            return;
        }
        self.source = source.map(str::to_owned);
        self.summary = source.and_then(parse_diff_summary);
        self.reviewing = false;
        self.snapshot = None;
        self.loading = false;
        self.show_slow_load = false;
        self.busy = false;
        self.status = None;
        self.stale_refresh = false;
        self.show_all_files = false;
        self.files_toggle_transition = 0;
    }

    pub(super) fn apply_snapshot(&mut self, diff: SessionDiff) {
        self.snapshot = Some(diff);
        self.loading = false;
        self.show_slow_load = false;
        self.busy = false;
        self.status = self
            .stale_refresh
            .then(|| "The diff changed and was refreshed. Choose the hunk decision again.".into());
        self.stale_refresh = false;
    }

    pub(super) fn apply_error(&mut self, message: String, stale: bool) -> bool {
        self.busy = false;
        if stale {
            self.loading = true;
            self.show_slow_load = false;
            self.stale_refresh = true;
            self.status = None;
            true
        } else {
            self.loading = false;
            self.show_slow_load = false;
            self.status = Some(message);
            false
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct DiffSummary {
    added: usize,
    removed: usize,
    files: Vec<DiffSummaryFile>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct DiffSummaryFile {
    path: String,
    added: usize,
    removed: usize,
}

impl ChatView {
    pub(super) fn sync_diff_summary(&mut self) {
        self.diff_ui
            .sync_summary(self.state.diff.as_ref().map(|(_, source)| source.as_str()));
    }

    pub(super) fn control_surface(&self, weak: &gpui::WeakEntity<Self>) -> Option<AnyElement> {
        if self.state.running {
            let steps = &self.state.plan.as_ref()?.1;
            let current = steps
                .iter()
                .find(|step| step.status == PlanStepStatus::Running)
                .or_else(|| {
                    steps
                        .iter()
                        .find(|step| step.status == PlanStepStatus::Pending)
                })?;
            return Some(
                div()
                    .flex_none()
                    .w_full()
                    .pt(px(1.0))
                    .pb(px(4.0))
                    .text_size(px(15.0))
                    .text_color(self.theme.text_3.hsla())
                    .child(current.text.clone())
                    .into_any_element(),
            );
        }
        self.diff_card(weak)
    }

    fn toggle_diff_review(&mut self, cx: &mut Context<Self>) {
        if self.diff_ui.summary.is_none() || self.state.running {
            return;
        }
        self.diff_ui.reviewing = !self.diff_ui.reviewing;
        self.diff_ui.status = None;
        if self.diff_ui.reviewing {
            self.request_diff_snapshot(cx);
        } else {
            self.diff_ui.loading = false;
            self.diff_ui.show_slow_load = false;
            self.diff_ui.busy = false;
        }
        self.remeasure_transcript_footer();
        cx.notify();
    }

    fn request_diff_snapshot(&mut self, cx: &mut Context<Self>) {
        let Some(thread_id) = self
            .session
            .as_ref()
            .and_then(|session| session.thread_id.clone())
        else {
            return;
        };
        self.diff_ui.loading = true;
        self.diff_ui.show_slow_load = false;
        self.remeasure_transcript_footer();
        cx.emit(ChatEvent::RequestDiff { thread_id });
        cx.spawn(async move |view, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(200))
                .await;
            let _ = view.update(cx, |this, cx| {
                if this.diff_ui.reviewing && this.diff_ui.loading && this.diff_ui.snapshot.is_none()
                {
                    this.diff_ui.show_slow_load = true;
                    this.remeasure_transcript_footer();
                    cx.notify();
                }
            });
        })
        .detach();
    }

    fn refresh_diff(&mut self, cx: &mut Context<Self>) {
        if self.diff_ui.busy {
            return;
        }
        self.diff_ui.status = None;
        self.request_diff_snapshot(cx);
        cx.notify();
    }

    fn decide_hunk(
        &mut self,
        path: String,
        hunk_id: String,
        decision: DiffDecision,
        cx: &mut Context<Self>,
    ) {
        if self.diff_ui.busy {
            return;
        }
        let Some(snapshot) = &self.diff_ui.snapshot else {
            return;
        };
        let version = snapshot.version.clone();
        let Some(thread_id) = self
            .session
            .as_ref()
            .and_then(|session| session.thread_id.clone())
        else {
            return;
        };
        self.diff_ui.busy = true;
        self.diff_ui.status = None;
        self.remeasure_transcript_footer();
        cx.emit(ChatEvent::ReviewHunk {
            thread_id,
            version,
            path,
            hunk_id,
            decision,
        });
        cx.notify();
    }

    fn toggle_all_diff_files(&mut self, cx: &mut Context<Self>) {
        self.diff_ui.show_all_files = !self.diff_ui.show_all_files;
        self.diff_ui.files_toggle_transition = self.diff_ui.files_toggle_transition.wrapping_add(1);
        self.remeasure_transcript_footer();
        cx.notify();
    }

    fn diff_card(&self, weak: &gpui::WeakEntity<Self>) -> Option<AnyElement> {
        let summary = self.diff_ui.summary.as_ref()?;
        let theme = self.theme;
        let visible_files = if self.diff_ui.show_all_files {
            summary.files.len()
        } else {
            summary.files.len().min(3)
        };
        let file_rows = summary
            .files
            .iter()
            .take(visible_files)
            .map(|file| diff_summary_file(file, theme));
        let hidden = summary.files.len().saturating_sub(visible_files);
        let reviewing = self.diff_ui.reviewing;

        Some(
            div()
                .flex_none()
                .w_full()
                .child(
                    div()
                        .w_full()
                        .overflow_hidden()
                        .rounded(px(8.0))
                        .border_1()
                        .border_color(theme.line.hsla())
                        .child(
                            div()
                                .min_h(px(76.0))
                                .flex()
                                .items_center()
                                .gap(px(12.0))
                                .px(px(14.0))
                                .py(px(12.0))
                                .child(
                                    div()
                                        .size(px(42.0))
                                        .flex_none()
                                        .flex()
                                        .items_center()
                                        .justify_center()
                                        .rounded(px(5.0))
                                        .bg(theme.surface.hsla())
                                        .text_color(theme.text_2.hsla())
                                        .child(motion_icon(
                                            "diff-summary-icon",
                                            "icons/file-diff.svg",
                                            20.0,
                                            "diff-summary-icon-direct-hover",
                                            theme,
                                        )),
                                )
                                .child(
                                    div()
                                        .min_w(px(0.0))
                                        .flex_1()
                                        .flex()
                                        .flex_col()
                                        .child(
                                            div()
                                                .text_size(px(15.0))
                                                .font_weight(FontWeight(560.0))
                                                .child(format!(
                                                    "Edited {} file{}",
                                                    summary.files.len(),
                                                    if summary.files.len() == 1 { "" } else { "s" }
                                                )),
                                        )
                                        .child(diff_stat(summary.added, summary.removed, theme)),
                                )
                                .child(diff_pill_button(
                                    "diff-toggle-review",
                                    "diff-toggle-review-hover",
                                    if reviewing { "Close" } else { "Review" },
                                    None,
                                    false,
                                    theme,
                                    Some({
                                        let weak = weak.clone();
                                        Rc::new(move |cx: &mut App| {
                                            let _ = weak.update(cx, |this, cx| {
                                                this.toggle_diff_review(cx);
                                            });
                                        })
                                    }),
                                )),
                        )
                        .child(
                            div()
                                .border_t_1()
                                .border_color(theme.line.hsla())
                                .px(px(18.0))
                                .pt(px(11.0))
                                .pb(px(13.0))
                                .flex()
                                .flex_col()
                                .gap(px(9.0))
                                .children(file_rows)
                                .when(summary.files.len() > 3, |list| {
                                    let weak = weak.clone();
                                    list.child(
                                        div()
                                            .id("diff-toggle-files")
                                            .group("diff-toggle-files-hover")
                                            .h(px(30.0))
                                            .flex()
                                            .items_center()
                                            .gap(px(7.0))
                                            .text_size(px(15.0))
                                            .text_color(theme.text_2.hsla())
                                            .cursor_pointer()
                                            .hover(move |style| style.text_color(theme.text.hsla()))
                                            .on_click(move |_event, _window, cx| {
                                                let _ = weak.update(cx, |this, cx| {
                                                    this.toggle_all_diff_files(cx);
                                                });
                                            })
                                            .child(if self.diff_ui.show_all_files {
                                                "Show fewer files".into()
                                            } else {
                                                format!(
                                                    "Show {hidden} more file{}",
                                                    if hidden == 1 { "" } else { "s" }
                                                )
                                            })
                                            .child(diff_files_chevron(
                                                self.diff_ui.show_all_files,
                                                self.diff_ui.files_toggle_transition,
                                                theme,
                                            )),
                                    )
                                }),
                        )
                        .when(reviewing, |card| card.child(self.diff_review(weak))),
                )
                .into_any_element(),
        )
    }

    fn diff_review(&self, weak: &gpui::WeakEntity<Self>) -> AnyElement {
        let theme = self.theme;
        let refresh_action: Option<UiAction> = (!self.diff_ui.busy).then(|| {
            let weak = weak.clone();
            Rc::new(move |cx: &mut App| {
                let _ = weak.update(cx, |this, cx| this.refresh_diff(cx));
            }) as UiAction
        });
        let snapshot = self.diff_ui.snapshot.as_ref();
        let file_count = snapshot.map_or(0, |snapshot| snapshot.files.len());

        div()
            .id("diff-review-scroll")
            .max_h(px(520.0))
            .overflow_y_scroll()
            .border_t_1()
            .border_color(theme.line.hsla())
            .child(
                div()
                    .min_h(px(42.0))
                    .flex()
                    .items_center()
                    .gap(px(12.0))
                    .px(px(14.0))
                    .py(px(7.0))
                    .text_size(px(12.5))
                    .text_color(theme.text_3.hsla())
                    .child(div().flex_1().child(if snapshot.is_some() {
                        format!(
                            "{file_count} file{} in current snapshot",
                            if file_count == 1 { "" } else { "s" }
                        )
                    } else {
                        "Review unavailable".into()
                    }))
                    .child(diff_pill_button(
                        "diff-refresh",
                        "diff-refresh-hover",
                        "Refresh",
                        Some("icons/refresh-cw.svg"),
                        false,
                        theme,
                        refresh_action,
                    )),
            )
            .when_some(self.diff_ui.status.clone(), |review, status| {
                review.child(diff_review_status(status, theme))
            })
            .when(
                snapshot.is_none() && self.diff_ui.loading && self.diff_ui.show_slow_load,
                |review| review.child(diff_review_status("Loading review…", theme)),
            )
            .when(
                snapshot.is_some_and(|snapshot| snapshot.files.is_empty()),
                |review| review.child(diff_review_status("No changed files remain.", theme)),
            )
            .when_some(snapshot, |review, snapshot| {
                review.children(
                    snapshot
                        .files
                        .iter()
                        .enumerate()
                        .map(|(index, file)| self.diff_review_file(file, index, weak)),
                )
            })
            .into_any_element()
    }

    fn diff_review_file(
        &self,
        file: &DiffFile,
        file_index: usize,
        weak: &gpui::WeakEntity<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let status = if let Some(previous) = &file.previous_path {
            format!("{previous} → {}", diff_file_status(file.status))
        } else {
            diff_file_status(file.status).into()
        };
        div()
            .border_t_1()
            .border_color(theme.line.hsla())
            .child(
                div()
                    .min_h(px(54.0))
                    .flex()
                    .items_center()
                    .gap(px(12.0))
                    .px(px(14.0))
                    .py(px(7.0))
                    .child(
                        div()
                            .min_w(px(0.0))
                            .flex_1()
                            .truncate()
                            .font_family("Geist Mono")
                            .text_size(px(12.5))
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(file.path.clone()),
                    )
                    .child(
                        div()
                            .text_size(px(11.5))
                            .text_color(theme.text_3.hsla())
                            .child(status),
                    ),
            )
            .when(file.binary, |section| {
                section.child(diff_review_status("Binary file", theme))
            })
            .children(file.hunks.iter().enumerate().map(|(hunk_index, hunk)| {
                self.diff_hunk(&file.path, hunk, file_index, hunk_index, weak)
            }))
            .into_any_element()
    }

    fn diff_hunk(
        &self,
        path: &str,
        hunk: &DiffHunk,
        file_index: usize,
        hunk_index: usize,
        weak: &gpui::WeakEntity<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let busy = self.diff_ui.busy;
        let highlights = word_highlights(&hunk.lines);
        let decisions = [
            ("Accept", "icons/check.svg", DiffDecision::Accept),
            ("Reject", "icons/x.svg", DiffDecision::Reject),
        ]
        .into_iter()
        .enumerate()
        .map(|(index, (label, icon, decision))| {
            let selected = hunk.decision == Some(decision);
            let enabled = !busy && !selected;
            let action: Option<UiAction> = enabled.then(|| {
                let weak = weak.clone();
                let path = path.to_owned();
                let hunk_id = hunk.id.clone();
                Rc::new(move |cx: &mut App| {
                    let path = path.clone();
                    let hunk_id = hunk_id.clone();
                    let _ = weak.update(cx, |this, cx| {
                        this.decide_hunk(path, hunk_id, decision, cx);
                    });
                }) as UiAction
            });
            diff_pill_button(
                (
                    if index == 0 {
                        "diff-accept"
                    } else {
                        "diff-reject"
                    },
                    file_index * 1_000 + hunk_index,
                ),
                SharedString::from(format!(
                    "diff-hunk-action-hover:{file_index}:{hunk_index}:{index}"
                )),
                label,
                Some(icon),
                selected,
                theme,
                action,
            )
            .into_any_element()
        });
        let reviewed = hunk.decision.is_some();

        div()
            .id(("diff-hunk", file_index * 1_000 + hunk_index))
            .relative()
            .border_t_1()
            .border_color(theme.line.hsla())
            .bg(theme.background.hsla())
            .child(
                div()
                    .min_h(px(42.0))
                    .flex()
                    .items_center()
                    .gap(px(10.0))
                    .px(px(14.0))
                    .py(px(7.0))
                    .bg(theme.surface_2.hsla())
                    .child(
                        div()
                            .min_w(px(0.0))
                            .flex_1()
                            .truncate()
                            .font_family("Geist Mono")
                            .text_size(px(11.5))
                            .text_color(theme.text_3.hsla())
                            .child(hunk.header.clone()),
                    )
                    .child(div().flex().items_center().gap(px(6.0)).children(decisions)),
            )
            .children(
                hunk.lines
                    .iter()
                    .enumerate()
                    .map(|(index, line)| diff_line(line, highlights.get(&index), theme)),
            )
            .when(reviewed, |section| {
                section.child(
                    div()
                        .absolute()
                        .top_0()
                        .bottom_0()
                        .left_0()
                        .w(px(3.0))
                        .bg(theme.line_strong.hsla()),
                )
            })
            .into_any_element()
    }
}

fn diff_files_chevron(open: bool, transition: u64, theme: Theme) -> AnyElement {
    let icon = motion_icon(
        "diff-files-chevron-icon",
        "icons/chevron-down.svg",
        14.0,
        "diff-toggle-files-hover",
        theme,
    );
    if transition == 0 {
        return icon
            .with_transformation(IconTransformation::rotate(if open { 180.0 } else { 0.0 }))
            .into_any_element();
    }
    icon.with_animation(
        ("diff-files-chevron", transition),
        Animation::new(theme.motion.fast).with_easing(crate::theme::web_ease_out),
        move |icon, delta| {
            let rotation_degrees = if open {
                delta * 180.0
            } else {
                (1.0 - delta) * 180.0
            };
            icon.with_transformation(IconTransformation::rotate(rotation_degrees))
        },
    )
    .into_any_element()
}

fn diff_summary_file(file: &DiffSummaryFile, theme: Theme) -> AnyElement {
    let (directory, name) = split_path(&file.path);
    div()
        .min_h(px(30.0))
        .flex()
        .items_center()
        .gap(px(14.0))
        .text_size(px(13.5))
        .child(
            div()
                .min_w(px(0.0))
                .flex_1()
                .flex()
                .truncate()
                .text_color(theme.text_2.hsla())
                .when(!directory.is_empty(), |path| {
                    path.child(div().text_color(theme.text_3.hsla()).child(directory))
                })
                .child(name),
        )
        .child(diff_stat(file.added, file.removed, theme))
        .into_any_element()
}

fn diff_stat(added: usize, removed: usize, theme: Theme) -> impl IntoElement {
    div()
        .flex()
        .items_center()
        .gap(px(6.0))
        .font_family("Geist Mono")
        .text_size(px(12.5))
        .child(
            div()
                .text_color(theme.success.hsla())
                .child(format!("+{added}")),
        )
        .child(
            div()
                .text_color(theme.error.hsla())
                .child(format!("−{removed}")),
        )
}

fn diff_pill_button(
    id: impl Into<gpui::ElementId>,
    hover_group: impl Into<SharedString>,
    label: &'static str,
    icon: Option<&'static str>,
    selected: bool,
    theme: Theme,
    action: Option<UiAction>,
) -> impl IntoElement {
    let enabled = action.is_some();
    let reject = label.contains("Reject");
    let hover_group = hover_group.into();
    let icon_id = SharedString::from(format!("{hover_group}-icon"));
    div()
        .id(id)
        .group(hover_group.clone())
        .h(px(30.0))
        .px(px(12.0))
        .flex()
        .items_center()
        .justify_center()
        .gap(px(5.0))
        .rounded(px(15.0))
        .border_1()
        .border_color(if selected && reject {
            theme.error.mix_oklab(theme.line, 0.45).hsla()
        } else if selected {
            theme.success.mix_oklab(theme.line, 0.45).hsla()
        } else {
            theme.line_strong.hsla()
        })
        .when(selected, |button| {
            button.bg(if reject {
                theme.error.hsla().opacity(0.12)
            } else {
                theme.success.hsla().opacity(0.12)
            })
        })
        .text_color(if selected && reject {
            theme.error.hsla()
        } else if selected {
            theme.success.hsla()
        } else {
            theme.text.hsla()
        })
        .when(enabled, |button| {
            button
                .cursor_pointer()
                .hover(move |style| style.bg(theme.surface.hsla()))
        })
        .when_some(action, |button, action| {
            button.on_click(move |_event, _window, cx| action(cx))
        })
        .when_some(icon, |button, icon| {
            button.child(motion_icon(icon_id, icon, 13.0, hover_group, theme))
        })
        .child(label)
}

fn diff_review_status(status: impl Into<SharedString>, theme: Theme) -> impl IntoElement {
    div()
        .px(px(14.0))
        .py(px(12.0))
        .text_size(px(12.5))
        .text_color(theme.text_3.hsla())
        .child(status.into())
}

fn diff_line(line: &DiffLine, highlight: Option<&DiffWordHighlight>, theme: Theme) -> AnyElement {
    let (old_line, new_line, marker, text, background, color) = match line {
        DiffLine::Context {
            old_line,
            new_line,
            text,
            ..
        } => (
            Some(*old_line),
            Some(*new_line),
            " ",
            text,
            theme.background.hsla(),
            theme.text_2.hsla(),
        ),
        DiffLine::Addition { new_line, text, .. } => (
            None,
            Some(*new_line),
            "+",
            text,
            theme.success.hsla().opacity(0.10),
            theme.text.hsla(),
        ),
        DiffLine::Deletion { old_line, text, .. } => (
            Some(*old_line),
            None,
            "−",
            text,
            theme.error.hsla().opacity(0.10),
            theme.text.hsla(),
        ),
    };
    div()
        .min_h(px(22.0))
        .w_full()
        .flex()
        .items_center()
        .bg(background)
        .font_family("Geist Mono")
        .text_size(px(11.5))
        .child(diff_line_number(old_line, theme))
        .child(diff_line_number(new_line, theme))
        .child(
            div()
                .min_w(px(0.0))
                .flex_1()
                .flex()
                .items_center()
                .overflow_x_scrollbar()
                .px(px(10.0))
                .text_color(color)
                .whitespace_nowrap()
                .child(
                    div()
                        .w(px(16.0))
                        .flex_none()
                        .text_color(if marker == "+" {
                            theme.success.hsla()
                        } else if marker == "−" {
                            theme.error.hsla()
                        } else {
                            theme.text_3.hsla()
                        })
                        .child(marker),
                )
                .child(diff_line_text(text, highlight, theme)),
        )
        .into_any_element()
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct DiffWordHighlight {
    before: String,
    changed: String,
    after: String,
    addition: bool,
}

fn diff_line_text(text: &str, highlight: Option<&DiffWordHighlight>, theme: Theme) -> AnyElement {
    let fallback = if text.is_empty() { " " } else { text };
    let Some(highlight) = highlight else {
        return div()
            .flex_none()
            .child(fallback.to_owned())
            .into_any_element();
    };
    div()
        .flex_none()
        .flex()
        .whitespace_nowrap()
        .child(div().flex_none().child(highlight.before.clone()))
        .child(
            div()
                .flex_none()
                .bg(if highlight.addition {
                    theme.success.hsla().opacity(0.28)
                } else {
                    theme.error.hsla().opacity(0.28)
                })
                .child(highlight.changed.clone()),
        )
        .child(div().flex_none().child(highlight.after.clone()))
        .into_any_element()
}

fn word_highlights(lines: &[DiffLine]) -> HashMap<usize, DiffWordHighlight> {
    let mut result = HashMap::new();
    let mut start = 0;
    while start < lines.len() {
        if matches!(lines[start], DiffLine::Context { .. }) {
            start += 1;
            continue;
        }
        let mut end = start;
        while end < lines.len() && !matches!(lines[end], DiffLine::Context { .. }) {
            end += 1;
        }
        let deleted = (start..end)
            .filter(|index| matches!(lines[*index], DiffLine::Deletion { .. }))
            .collect::<Vec<_>>();
        let added = (start..end)
            .filter(|index| matches!(lines[*index], DiffLine::Addition { .. }))
            .collect::<Vec<_>>();
        for (deleted_index, added_index) in deleted.into_iter().zip(added) {
            let before = diff_line_source(&lines[deleted_index]);
            let after = diff_line_source(&lines[added_index]);
            let (old_highlight, new_highlight) = changed_words(before, after);
            result.insert(deleted_index, old_highlight);
            result.insert(added_index, new_highlight);
        }
        start = end;
    }
    result
}

fn diff_line_source(line: &DiffLine) -> &str {
    match line {
        DiffLine::Context { text, .. }
        | DiffLine::Addition { text, .. }
        | DiffLine::Deletion { text, .. } => text,
    }
}

fn changed_words(before: &str, after: &str) -> (DiffWordHighlight, DiffWordHighlight) {
    let old_words = diff_words(before);
    let new_words = diff_words(after);
    let mut prefix = 0;
    while prefix < old_words.len()
        && prefix < new_words.len()
        && old_words[prefix] == new_words[prefix]
    {
        prefix += 1;
    }
    let mut suffix = 0;
    while suffix < old_words.len().saturating_sub(prefix)
        && suffix < new_words.len().saturating_sub(prefix)
        && old_words[old_words.len() - 1 - suffix] == new_words[new_words.len() - 1 - suffix]
    {
        suffix += 1;
    }
    let highlight = |words: &[String], addition| DiffWordHighlight {
        before: words[..prefix].concat(),
        changed: words[prefix..words.len() - suffix].concat(),
        after: words[words.len() - suffix..].concat(),
        addition,
    };
    (highlight(&old_words, false), highlight(&new_words, true))
}

fn diff_words(text: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut start = 0;
    while start < text.len() {
        let character = text[start..].chars().next().expect("valid UTF-8 boundary");
        let word = character.is_ascii_alphanumeric() || character == '_';
        let whitespace = character.is_whitespace();
        let mut end = start + character.len_utf8();
        while end < text.len() {
            let next = text[end..].chars().next().expect("valid UTF-8 boundary");
            let same_group = if word {
                next.is_ascii_alphanumeric() || next == '_'
            } else if whitespace {
                next.is_whitespace()
            } else {
                !(next.is_ascii_alphanumeric() || next == '_')
            };
            if !same_group {
                break;
            }
            end += next.len_utf8();
        }
        words.push(text[start..end].to_owned());
        start = end;
    }
    words
}

fn diff_line_number(line: Option<u32>, theme: Theme) -> impl IntoElement {
    div()
        .w(px(38.0))
        .flex_none()
        .flex()
        .justify_end()
        .pr(px(8.0))
        .text_color(theme.text_3.hsla())
        .child(line.map_or_else(String::new, |line| line.to_string()))
}

fn diff_file_status(status: DiffFileStatus) -> &'static str {
    match status {
        DiffFileStatus::Added => "added",
        DiffFileStatus::Modified => "modified",
        DiffFileStatus::Deleted => "deleted",
        DiffFileStatus::Renamed => "renamed",
    }
}

fn split_path(path: &str) -> (String, String) {
    let separator = path.rfind(['/', '\\']);
    match separator {
        Some(index) => (path[..=index].into(), path[index + 1..].into()),
        None => (String::new(), path.into()),
    }
}

fn parse_diff_summary(diff: &str) -> Option<DiffSummary> {
    let mut files = Vec::<DiffSummaryFile>::new();
    let mut current = None;
    let mut in_hunk = false;

    for line in diff.lines() {
        if line.starts_with("diff --git ") {
            let path = path_from_git_header(line);
            files.push(DiffSummaryFile {
                path,
                added: 0,
                removed: 0,
            });
            current = Some(files.len() - 1);
            in_hunk = false;
        } else if !in_hunk
            && (line.starts_with("+++ ") || line.starts_with("--- ") || line.starts_with("index "))
        {
            if let Some(index) = current
                && let Some(destination) = line.strip_prefix("+++ ")
            {
                let destination = destination.trim();
                if destination != "/dev/null" {
                    files[index].path = strip_git_prefix(destination);
                }
            }
        } else if line.starts_with("@@") {
            in_hunk = true;
        } else if line.starts_with('+') {
            let index = *current.get_or_insert_with(|| {
                files.push(DiffSummaryFile {
                    path: "Changes".into(),
                    added: 0,
                    removed: 0,
                });
                files.len() - 1
            });
            files[index].added += 1;
        } else if line.starts_with('-') {
            let index = *current.get_or_insert_with(|| {
                files.push(DiffSummaryFile {
                    path: "Changes".into(),
                    added: 0,
                    removed: 0,
                });
                files.len() - 1
            });
            files[index].removed += 1;
        }
    }

    if files.is_empty() {
        return None;
    }
    let added = files.iter().map(|file| file.added).sum();
    let removed = files.iter().map(|file| file.removed).sum();
    Some(DiffSummary {
        added,
        removed,
        files,
    })
}

fn path_from_git_header(line: &str) -> String {
    if let Some(marker) = line.rfind(" b/") {
        return strip_git_prefix(&line[marker + 1..]);
    }
    if let Some(marker) = line.rfind(" \"b/") {
        return strip_git_prefix(line[marker + 2..].trim_end_matches('"'));
    }
    "Changes".into()
}

fn strip_git_prefix(path: &str) -> String {
    let path = path.trim_matches('"');
    path.strip_prefix("a/")
        .or_else(|| path.strip_prefix("b/"))
        .unwrap_or(path)
        .into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summary_distinguishes_headers_from_changes_inside_hunks() {
        let summary = parse_diff_summary(
            "diff --git a/src/app.ts b/src/app.ts\nindex 123..456 100644\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,2 @@\n--- reset the sequence\n+++ continue the sequence\n context",
        )
        .unwrap();

        assert_eq!(summary.added, 1);
        assert_eq!(summary.removed, 1);
        assert_eq!(summary.files[0].path, "src/app.ts");
    }

    #[test]
    fn summary_counts_each_file_independently() {
        let summary = parse_diff_summary(
            "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -0,0 +1 @@\n+added",
        )
        .unwrap();

        assert_eq!(summary.files.len(), 2);
        assert_eq!((summary.added, summary.removed), (2, 1));
        assert_eq!((summary.files[1].added, summary.files[1].removed), (1, 0));
    }

    #[test]
    fn review_highlights_only_the_changed_words() {
        let lines = vec![
            DiffLine::Deletion {
                old_line: 1,
                text: "const host = process.env.HARNESS_HOST ?? '127.0.0.1'".into(),
                no_newline_at_end: None,
            },
            DiffLine::Addition {
                new_line: 1,
                text: "const host = configuredHost ?? '127.0.0.1'".into(),
                no_newline_at_end: None,
            },
        ];

        let highlights = word_highlights(&lines);
        assert_eq!(
            highlights.get(&0),
            Some(&DiffWordHighlight {
                before: "const host = ".into(),
                changed: "process.env.HARNESS_HOST".into(),
                after: " ?? '127.0.0.1'".into(),
                addition: false,
            })
        );
        assert_eq!(
            highlights.get(&1),
            Some(&DiffWordHighlight {
                before: "const host = ".into(),
                changed: "configuredHost".into(),
                after: " ?? '127.0.0.1'".into(),
                addition: true,
            })
        );
    }

    #[test]
    fn review_pairs_deletions_and_additions_within_each_change_block() {
        let lines = vec![
            DiffLine::Deletion {
                old_line: 1,
                text: "old one".into(),
                no_newline_at_end: None,
            },
            DiffLine::Addition {
                new_line: 1,
                text: "new one".into(),
                no_newline_at_end: None,
            },
            DiffLine::Context {
                old_line: 2,
                new_line: 2,
                text: "same".into(),
                no_newline_at_end: None,
            },
            DiffLine::Deletion {
                old_line: 3,
                text: "old two".into(),
                no_newline_at_end: None,
            },
            DiffLine::Addition {
                new_line: 3,
                text: "new two".into(),
                no_newline_at_end: None,
            },
        ];

        let highlights = word_highlights(&lines);
        assert_eq!(highlights.len(), 4);
        assert_eq!(highlights[&0].changed, "old");
        assert_eq!(highlights[&1].changed, "new");
        assert_eq!(highlights[&3].changed, "old");
        assert_eq!(highlights[&4].changed, "new");
    }
}
