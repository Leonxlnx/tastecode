use super::HarnessApp;
use crate::chrome;
use crate::client_state::SessionSearchRequest;
use crate::motion_icon::motion_icon;
use crate::zoom::px;
use chrono::{DateTime, Local};
use gpui::{
    Animation, AnimationExt, AnyElement, Context, Entity, FontWeight, SharedString, Window, div,
    prelude::*, relative,
};
use gpui_component::input::{Input, InputState};
use harness_protocol::{ProviderId, SessionSearchResult};
use std::time::Duration;

const SEARCH_DEBOUNCE: Duration = Duration::from_millis(220);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum SearchFilterMenu {
    Project,
    Provider,
}

pub(super) struct SessionSearchState {
    pub(super) open: bool,
    pub(super) input: Entity<InputState>,
    pub(super) reset_input: bool,
    pub(super) focus_pending: bool,
    pub(super) open_transition: u64,
    pub(super) revision: u64,
    pub(super) loading: bool,
    pub(super) error: Option<String>,
    pub(super) results: Vec<SessionSearchResult>,
    pub(super) next_cursor: Option<String>,
    pub(super) project_path: Option<String>,
    pub(super) provider: Option<ProviderId>,
    pub(super) filter_menu: Option<SearchFilterMenu>,
}

impl SessionSearchState {
    pub(super) fn new(input: Entity<InputState>) -> Self {
        Self {
            open: false,
            input,
            reset_input: false,
            focus_pending: false,
            open_transition: 0,
            revision: 0,
            loading: false,
            error: None,
            results: Vec::new(),
            next_cursor: None,
            project_path: None,
            provider: None,
            filter_menu: None,
        }
    }
}

impl HarnessApp {
    pub(super) fn open_session_search(
        &mut self,
        project_path: Option<String>,
        cx: &mut Context<Self>,
    ) {
        if self.sidebar_controls.is_open() {
            self.close_sidebar_controls(cx);
        }
        self.close_rollback(cx);
        self.account_menu_open = false;
        self.settings_open = false;
        self.session_search.open = true;
        self.session_search.open_transition = self.session_search.open_transition.wrapping_add(1);
        self.session_search.project_path = project_path;
        self.session_search.provider = None;
        self.session_search.filter_menu = None;
        self.session_search.results.clear();
        self.session_search.next_cursor = None;
        self.session_search.error = None;
        self.session_search.loading = false;
        self.session_search.revision = self.session_search.revision.wrapping_add(1);
        self.session_search.reset_input = true;
        self.session_search.focus_pending = true;
        cx.notify();
    }

    pub(super) fn close_session_search(&mut self, cx: &mut Context<Self>) {
        self.session_search.open = false;
        self.session_search.filter_menu = None;
        self.session_search.revision = self.session_search.revision.wrapping_add(1);
        cx.notify();
    }

    pub(super) fn prepare_session_search_input(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.session_search.reset_input {
            self.session_search.input.update(cx, |input, cx| {
                input.set_value("", window, cx);
            });
            self.session_search.reset_input = false;
        }
        if self.session_search.focus_pending {
            self.session_search
                .input
                .update(cx, |input, cx| input.focus(window, cx));
            self.session_search.focus_pending = false;
        }
    }

    pub(super) fn schedule_session_search(&mut self, cx: &mut Context<Self>) {
        if !self.session_search.open {
            return;
        }
        self.session_search.revision = self.session_search.revision.wrapping_add(1);
        let revision = self.session_search.revision;
        self.session_search.results.clear();
        self.session_search.next_cursor = None;
        self.session_search.error = None;
        self.session_search.loading = false;
        if self.session_search.input.read(cx).value().trim().is_empty() {
            cx.notify();
            return;
        }
        cx.notify();
        cx.spawn(async move |view, cx| {
            cx.background_executor().timer(SEARCH_DEBOUNCE).await;
            let _ = view.update(cx, |this, cx| {
                if this.session_search.open && this.session_search.revision == revision {
                    this.request_session_search(false, cx);
                }
            });
        })
        .detach();
    }

    fn request_session_search(&mut self, append: bool, cx: &mut Context<Self>) {
        let query = self.session_search.input.read(cx).value().trim().to_owned();
        if query.is_empty() || self.session_search.loading {
            return;
        }
        let cursor = append
            .then(|| self.session_search.next_cursor.clone())
            .flatten();
        if append && cursor.is_none() {
            return;
        }
        self.session_search.loading = true;
        self.session_search.error = None;
        let update = self.state.search_sessions(SessionSearchRequest {
            query,
            project_path: self.session_search.project_path.clone(),
            provider: self.session_search.provider,
            cursor,
            revision: self.session_search.revision,
            append,
        });
        self.apply_client_update(update, cx);
        cx.notify();
    }

    fn select_session_search_result(
        &mut self,
        thread_id: String,
        turn_id: String,
        cx: &mut Context<Self>,
    ) {
        self.pending_reveal_turn = Some((thread_id.clone(), turn_id));
        self.close_session_search(cx);
        self.select_session(thread_id, cx);
    }

    fn set_search_project(&mut self, project_path: Option<String>, cx: &mut Context<Self>) {
        self.session_search.project_path = project_path;
        self.session_search.filter_menu = None;
        self.schedule_session_search(cx);
    }

    fn set_search_provider(&mut self, provider: Option<ProviderId>, cx: &mut Context<Self>) {
        self.session_search.provider = provider;
        self.session_search.filter_menu = None;
        self.schedule_session_search(cx);
    }

    pub(super) fn session_search_overlay(
        &self,
        window: &Window,
        cx: &Context<Self>,
    ) -> Option<AnyElement> {
        if !self.session_search.open {
            return None;
        }
        let theme = self.theme;
        let term_empty = self.session_search.input.read(cx).value().trim().is_empty();
        let panel_top = (window.viewport_size().height * 0.13).min(px(104.0));
        let results_height = (window.viewport_size().height - px(230.0))
            .max(px(0.0))
            .min(px(460.0));
        let project_label = self
            .session_search
            .project_path
            .as_deref()
            .and_then(|path| {
                self.state
                    .projects
                    .iter()
                    .find(|project| project.path == path)
            })
            .map_or_else(
                || SharedString::from("All projects"),
                |project| SharedString::from(project.name.clone()),
            );
        let provider_label = self
            .session_search
            .provider
            .map_or("All agents", search_provider_label);
        let project_open = self.session_search.filter_menu == Some(SearchFilterMenu::Project);
        let provider_open = self.session_search.filter_menu == Some(SearchFilterMenu::Provider);
        let close_group: SharedString = "session-search-close-hover".into();

        let search_row = div()
            .relative()
            .h(px(44.0))
            .flex()
            .items_center()
            .gap(px(9.0))
            .px(px(12.0))
            .border_b_1()
            .border_color(theme.line.hsla())
            .text_color(theme.text_3.hsla())
            .child(chrome::inset_top_shade(theme))
            .child(motion_icon(
                "session-search-icon",
                "icons/search.svg",
                15.0,
                "session-search-icon-direct-hover",
                theme,
            ))
            .child(
                Input::new(&self.session_search.input)
                    .appearance(false)
                    .bordered(false)
                    .focus_bordered(false)
                    .min_w(px(0.0))
                    .flex_1()
                    .px(px(0.0))
                    .py(px(0.0))
                    .line_height(relative(1.55))
                    .text_size(px(13.5))
                    .text_color(theme.text.hsla()),
            )
            .child(
                div()
                    .id("session-search-close")
                    .group(close_group.clone())
                    .size(px(22.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(3.0))
                    .cursor_pointer()
                    .hover(move |style| {
                        style
                            .bg(theme.surface_2.hsla())
                            .text_color(theme.text.hsla())
                    })
                    .active(|style| style.size(px(20.68)).m(px(0.66)))
                    .on_click(cx.listener(|this, _event, _window, cx| {
                        this.close_session_search(cx);
                    }))
                    .child(
                        div()
                            .id("session-search-close-icon-press")
                            .size(px(13.0))
                            .group_active(close_group.clone(), |style| {
                                style.size(px(12.22)).m(px(0.39))
                            })
                            .child(
                                motion_icon(
                                    "session-search-close-icon",
                                    "icons/x.svg",
                                    13.0,
                                    close_group,
                                    theme,
                                )
                                .size_full(),
                            ),
                    ),
            );

        let filters = div()
            .h(px(45.0))
            .flex()
            .items_center()
            .gap(px(8.0))
            .px(px(12.0))
            .border_b_1()
            .border_color(theme.line.hsla())
            .child(search_filter(
                "session-search-project",
                "Project",
                project_label,
                project_open,
                theme,
                cx.listener(|this, _event, _window, cx| {
                    this.session_search.filter_menu =
                        if this.session_search.filter_menu == Some(SearchFilterMenu::Project) {
                            None
                        } else {
                            Some(SearchFilterMenu::Project)
                        };
                    cx.notify();
                }),
            ))
            .child(search_filter(
                "session-search-provider",
                "Agent",
                provider_label.into(),
                provider_open,
                theme,
                cx.listener(|this, _event, _window, cx| {
                    this.session_search.filter_menu =
                        if this.session_search.filter_menu == Some(SearchFilterMenu::Provider) {
                            None
                        } else {
                            Some(SearchFilterMenu::Provider)
                        };
                    cx.notify();
                }),
            ));

        let mut result_rows = Vec::new();
        if let Some(error) = self.session_search.error.clone() {
            result_rows.push(
                div()
                    .min_h(px(42.0))
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(8.0))
                    .px(px(10.0))
                    .text_size(px(12.5))
                    .text_color(theme.error.hsla())
                    .child(div().min_w(px(0.0)).flex_1().child(error))
                    .child(
                        div()
                            .id("session-search-retry")
                            .h(px(28.0))
                            .px(px(8.0))
                            .flex()
                            .items_center()
                            .rounded(px(3.0))
                            .text_size(px(12.5))
                            .text_color(theme.text_2.hsla())
                            .cursor_pointer()
                            .hover(move |style| {
                                style
                                    .bg(theme.surface_2.hsla())
                                    .text_color(theme.text.hsla())
                            })
                            .on_click(cx.listener(|this, _event, _window, cx| {
                                this.schedule_session_search(cx);
                            }))
                            .child("Retry"),
                    )
                    .into_any_element(),
            );
        }
        if term_empty {
            result_rows.push(search_empty(
                "Search messages and tool output across projects.",
                theme,
            ));
        } else if self.session_search.results.is_empty() && self.session_search.error.is_none() {
            result_rows.push(search_empty(
                if self.session_search.loading {
                    "Searching…"
                } else {
                    "No matches found."
                },
                theme,
            ));
        } else {
            result_rows.extend(self.session_search.results.iter().cloned().enumerate().map(
                |(index, result)| {
                    let thread_id = result.thread_id.clone();
                    let turn_id = result.turn_id.clone();
                    search_result_row(
                        index,
                        result,
                        theme,
                        cx.listener(move |this, _event, _window, cx| {
                            this.select_session_search_result(
                                thread_id.clone(),
                                turn_id.clone(),
                                cx,
                            );
                        }),
                    )
                },
            ));
        }
        if self.session_search.next_cursor.is_some() {
            result_rows.push(
                div()
                    .w_full()
                    .flex()
                    .justify_center()
                    .py(px(5.0))
                    .child(
                        div()
                            .id("session-search-more")
                            .h(px(30.0))
                            .px(px(10.0))
                            .flex()
                            .items_center()
                            .rounded(px(3.0))
                            .text_size(px(12.5))
                            .text_color(theme.text_2.hsla())
                            .opacity(if self.session_search.loading {
                                0.5
                            } else {
                                1.0
                            })
                            .when(!self.session_search.loading, |button| {
                                button
                                    .cursor_pointer()
                                    .hover(move |style| {
                                        style
                                            .bg(theme.surface_2.hsla())
                                            .text_color(theme.text.hsla())
                                    })
                                    .on_click(cx.listener(|this, _event, _window, cx| {
                                        this.request_session_search(true, cx);
                                    }))
                            })
                            .child(if self.session_search.loading {
                                "Loading…"
                            } else {
                                "Load more results"
                            }),
                    )
                    .into_any_element(),
            );
        }

        let project_menu = project_open.then(|| {
            let all = search_filter_option(
                "search-project-all".into(),
                "All projects".into(),
                self.session_search.project_path.is_none(),
                theme,
                cx.listener(|this, _event, _window, cx| {
                    this.set_search_project(None, cx);
                }),
            );
            div()
                .id("session-search-project-options")
                .absolute()
                .top(px(88.0))
                .left(px(72.0))
                .w(px(220.0))
                .max_h(px(250.0))
                .overflow_y_scroll()
                .rounded(px(8.0))
                .border_1()
                .border_color(chrome::border(theme))
                .bg(chrome::menu_background(theme))
                .shadow(chrome::panel_shadows(theme))
                .p(px(4.0))
                .child(all)
                .children(
                    self.state
                        .projects
                        .iter()
                        .enumerate()
                        .map(|(index, project)| {
                            let path = project.path.clone();
                            search_filter_option(
                                format!("search-project-{index}").into(),
                                project.name.clone().into(),
                                self.session_search.project_path.as_deref()
                                    == Some(project.path.as_str()),
                                theme,
                                cx.listener(move |this, _event, _window, cx| {
                                    this.set_search_project(Some(path.clone()), cx);
                                }),
                            )
                        }),
                )
                .into_any_element()
        });
        let provider_menu = provider_open.then(|| {
            let all = search_filter_option(
                "search-provider-all".into(),
                "All agents".into(),
                self.session_search.provider.is_none(),
                theme,
                cx.listener(|this, _event, _window, cx| {
                    this.set_search_provider(None, cx);
                }),
            );
            div()
                .id("session-search-provider-options")
                .absolute()
                .top(px(88.0))
                .left(px(315.0))
                .w(px(220.0))
                .rounded(px(8.0))
                .border_1()
                .border_color(chrome::border(theme))
                .bg(chrome::menu_background(theme))
                .shadow(chrome::panel_shadows(theme))
                .p(px(4.0))
                .child(all)
                .children(search_providers().into_iter().enumerate().map(
                    |(index, (provider, label))| {
                        search_filter_option(
                            format!("search-provider-{index}").into(),
                            label.into(),
                            self.session_search.provider == Some(provider),
                            theme,
                            cx.listener(move |this, _event, _window, cx| {
                                this.set_search_provider(Some(provider), cx);
                            }),
                        )
                    },
                ))
                .into_any_element()
        });

        let panel = div()
            .relative()
            .w_full()
            .max_w(px(700.0))
            .rounded(px(8.0))
            .border_1()
            .border_color(chrome::border(theme))
            .bg(chrome::rail_background(theme))
            .shadow(chrome::panel_shadows(theme))
            .child(chrome::top_highlight(theme))
            .child(search_row)
            .child(filters)
            .child(
                div()
                    .id("session-search-results")
                    .max_h(results_height)
                    .overflow_y_scroll()
                    .p(px(5.0))
                    .children(result_rows),
            )
            .when_some(project_menu, |panel, menu| panel.child(menu))
            .when_some(provider_menu, |panel, menu| panel.child(menu))
            .with_animation(
                ("session-search-panel", self.session_search.open_transition),
                Animation::new(theme.motion_duration(Duration::from_millis(220)))
                    .with_easing(crate::theme::web_ease_out),
                |panel, delta| {
                    let scale = 0.99 + 0.01 * delta;
                    panel
                        .w(relative(scale))
                        .max_w(px(700.0 * scale))
                        .top(px(10.0 * (1.0 - delta)))
                        .opacity(delta)
                },
            );

        Some(
            div()
                .absolute()
                .inset(px(0.0))
                .flex()
                .items_start()
                .justify_center()
                .pt(panel_top)
                .px(px(16.0))
                .child(
                    div()
                        .id("session-search-scrim")
                        .absolute()
                        .inset(px(0.0))
                        .bg(gpui::black().opacity(0.55))
                        .cursor_default()
                        .on_click(cx.listener(|this, _event, _window, cx| {
                            this.close_session_search(cx);
                        }))
                        .with_animation(
                            "session-search-scrim-in",
                            Animation::new(theme.motion.fast)
                                .with_easing(crate::theme::web_ease_out),
                            |scrim, delta| scrim.opacity(delta),
                        ),
                )
                .child(panel)
                .into_any_element(),
        )
    }
}

fn search_filter(
    id: &'static str,
    label: &'static str,
    value: SharedString,
    open: bool,
    theme: crate::Theme,
    listener: impl Fn(&gpui::ClickEvent, &mut Window, &mut gpui::App) + 'static,
) -> AnyElement {
    let hover_group: SharedString = format!("{id}:hover").into();
    let icon_id: SharedString = format!("{id}:icon").into();
    div()
        .flex()
        .items_center()
        .gap(px(6.0))
        .text_size(px(11.5))
        .text_color(theme.text_3.hsla())
        .child(label)
        .child(
            div()
                .id(id)
                .group(hover_group.clone())
                .relative()
                .h(px(27.0))
                .max_w(px(180.0))
                .flex()
                .items_center()
                .gap(px(7.0))
                .px(px(7.0))
                .rounded(px(3.0))
                .border_1()
                .border_color(if open {
                    theme.line_strong.hsla()
                } else {
                    chrome::border(theme)
                })
                .bg(chrome::raised(theme))
                .shadow(chrome::shadows(theme))
                .overflow_hidden()
                .text_size(px(11.5))
                .text_color(theme.text_2.hsla())
                .cursor_pointer()
                .hover(move |style| {
                    style
                        .border_color(chrome::hover_border(theme))
                        .text_color(theme.text.hsla())
                })
                .on_click(listener)
                .child(chrome::top_highlight(theme))
                .child(div().min_w(px(0.0)).flex_1().truncate().child(value))
                .child(motion_icon(
                    icon_id,
                    "icons/chevron-down.svg",
                    14.0,
                    hover_group,
                    theme,
                )),
        )
        .into_any_element()
}

fn search_filter_option(
    id: SharedString,
    label: SharedString,
    selected: bool,
    theme: crate::Theme,
    listener: impl Fn(&gpui::ClickEvent, &mut Window, &mut gpui::App) + 'static,
) -> AnyElement {
    let hover_group: SharedString = format!("{id}:hover").into();
    let icon_id: SharedString = format!("{id}:icon").into();
    div()
        .id(id)
        .group(hover_group.clone())
        .h(px(30.0))
        .w_full()
        .flex()
        .items_center()
        .px(px(8.0))
        .rounded(px(6.0))
        .when(selected, |row| row.bg(theme.surface_3.hsla()))
        .text_size(px(11.5))
        .text_color(if selected {
            theme.text.hsla()
        } else {
            theme.text_2.hsla()
        })
        .cursor_pointer()
        .hover(move |style| {
            style
                .bg(theme.surface_3.hsla())
                .text_color(theme.text.hsla())
        })
        .on_click(listener)
        .child(div().min_w(px(0.0)).flex_1().truncate().child(label))
        .when(selected, |row| {
            row.child(motion_icon(
                icon_id,
                "icons/check.svg",
                11.0,
                hover_group,
                theme,
            ))
        })
        .into_any_element()
}

fn search_empty(label: &'static str, theme: crate::Theme) -> AnyElement {
    div()
        .w_full()
        .py(px(24.0))
        .px(px(10.0))
        .text_center()
        .text_size(px(12.5))
        .text_color(theme.text_3.hsla())
        .child(label)
        .into_any_element()
}

fn search_result_row(
    index: usize,
    result: SessionSearchResult,
    theme: crate::Theme,
    listener: impl Fn(&gpui::ClickEvent, &mut Window, &mut gpui::App) + 'static,
) -> AnyElement {
    let interaction_group: SharedString = format!("session-search-result:{index}").into();
    let snippet = result.snippet.into_iter().enumerate().map(|(index, part)| {
        div()
            .id(("search-snippet", index))
            .flex_none()
            .when(part.highlighted, |fragment| {
                fragment
                    .px(px(2.0))
                    .rounded(px(2.0))
                    .bg(theme.text.hsla().opacity(0.18))
                    .text_color(theme.text.hsla())
            })
            .child(part.text)
    });
    div()
        .id(("session-search-result", index))
        .group(interaction_group.clone())
        .relative()
        .w_full()
        .flex()
        .flex_col()
        .gap(px(3.0))
        .px(px(10.0))
        .py(px(9.0))
        .rounded(px(5.0))
        .text_color(theme.text.hsla())
        .cursor_pointer()
        .hover(move |style| {
            style
                .bg(chrome::raised(theme))
                .shadow(chrome::shadows(theme))
        })
        .active(move |style| style.top(px(1.0)).shadow(Vec::new()))
        .on_click(listener)
        .child(chrome::interactive_top_highlight(
            theme,
            interaction_group.clone(),
            false,
        ))
        .child(chrome::interactive_inset_shade(theme, interaction_group))
        .child(
            div()
                .truncate()
                .text_size(px(13.5))
                .font_weight(FontWeight(540.0))
                .child(result.thread_title),
        )
        .child(
            div()
                .truncate()
                .text_size(px(11.5))
                .text_color(theme.text_3.hsla())
                .child(format!(
                    "{} · {} · {}",
                    result.project_name,
                    search_provider_label(result.provider),
                    search_date(result.created_at)
                )),
        )
        .child(
            div()
                .mt(px(3.0))
                .min_w(px(0.0))
                .flex()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_size(px(12.5))
                .line_height(relative(1.45))
                .text_color(theme.text_2.hsla())
                .children(snippet),
        )
        .into_any_element()
}

fn search_providers() -> [(ProviderId, &'static str); 3] {
    [
        (ProviderId::Codex, "Codex"),
        (ProviderId::ClaudeCode, "Claude Code"),
        (ProviderId::Grok, "Grok"),
    ]
}

fn search_provider_label(provider: ProviderId) -> &'static str {
    match provider {
        ProviderId::Codex => "Codex",
        ProviderId::ClaudeCode => "Claude Code",
        ProviderId::Grok => "Grok",
        ProviderId::Cursor => "Cursor",
        ProviderId::OpenCode => "OpenCode",
        ProviderId::Antigravity => "antigravity",
        ProviderId::Acp => "Gemini, Kimi & Qwen",
        ProviderId::Api => "api",
    }
}

fn search_date(created_at: f64) -> String {
    DateTime::from_timestamp_millis(created_at.max(0.0) as i64)
        .map(|date| date.with_timezone(&Local).format("%x").to_string())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_filter_matches_the_public_beta_roster() {
        assert_eq!(
            search_providers(),
            [
                (ProviderId::Codex, "Codex"),
                (ProviderId::ClaudeCode, "Claude Code"),
                (ProviderId::Grok, "Grok"),
            ]
        );
    }
}
