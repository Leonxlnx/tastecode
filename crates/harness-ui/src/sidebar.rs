use crate::chrome;
use crate::motion_icon::{IconTransformation, motion_icon};
use crate::shortcuts::{
    NEW_CHAT, NEW_PROJECT, SETTINGS, is_button_activation, label as shortcut_label,
};
use crate::theme::{ColorToken, RADIUS_MD, RADIUS_SM, Theme, ThemeMode};
use crate::zoom::px;
use chrono::{DateTime, Datelike, Local};
use gpui::{
    Animation, AnimationExt, AnyElement, App, Background, Bounds, BoxShadow, Entity, FocusHandle,
    FontWeight, Hsla, KeyDownEvent, Pixels, Point, SharedString, Window, canvas, div,
    linear_color_stop, linear_gradient, point, prelude::*, relative,
};
use gpui_component::Sizable as _;
use gpui_component::input::{Input, InputState};
use harness_client::ConnectionState;
use harness_protocol::{
    ProjectSummary, ProviderId, SessionSummary, SidebarMode, ThreadInboxStatus, ThreadLifecycle,
    UsageLimit,
};
use std::cell::Cell;
use std::collections::HashMap;
use std::rc::Rc;
use std::time::{SystemTime, UNIX_EPOCH};

const BRAILLE_SPINNER_FRAMES: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

pub(crate) type SelectSession = Rc<dyn Fn(String, &mut App)>;
pub(crate) type ChooseSession = Rc<dyn Fn(String, SelectionModifiers, &mut App)>;
pub(crate) type SidebarAction = Rc<dyn Fn(&mut App)>;
pub(crate) type SelectScope = Rc<dyn Fn(Option<String>, &mut App)>;
pub(crate) type ProjectAction = Rc<dyn Fn(String, &mut App)>;
pub(crate) type OpenSidebarMenu = Rc<dyn Fn(SidebarMenuRequest, SidebarMenuAnchor, &mut App)>;
pub(crate) type BeginSessionDrag = Rc<dyn Fn(String, &mut Window, &mut App)>;
pub(crate) type ReorderSession = Rc<dyn Fn(String, String, String, SessionDropPosition, &mut App)>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum SidebarMenuRequest {
    Project(String),
    Thread(String),
    ThreadSelection {
        target: String,
        thread_ids: Vec<String>,
    },
    Snooze(String),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum SidebarMenuAnchor {
    Context(Point<Pixels>),
    Trigger(Bounds<Pixels>),
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct SelectionModifiers {
    pub(crate) shift: bool,
    pub(crate) additive: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SessionDropPosition {
    Before,
    After,
}

#[derive(Clone)]
pub(crate) struct SidebarActions {
    pub(crate) select_session: SelectSession,
    pub(crate) choose_session: ChooseSession,
    pub(crate) new_chat: SidebarAction,
    pub(crate) new_project: SidebarAction,
    pub(crate) open_search: SidebarAction,
    pub(crate) open_settings: SidebarAction,
    pub(crate) toggle_scope: SidebarAction,
    pub(crate) select_scope: SelectScope,
    pub(crate) toggle_project: ProjectAction,
    pub(crate) toggle_project_sessions: ProjectAction,
    pub(crate) new_chat_in_project: ProjectAction,
    pub(crate) settle_thread: ProjectAction,
    pub(crate) wake_thread: ProjectAction,
    pub(crate) unsettle_thread: ProjectAction,
    pub(crate) rename_thread: ProjectAction,
    pub(crate) begin_session_drag: BeginSessionDrag,
    pub(crate) reorder_session: ReorderSession,
    pub(crate) archive_thread: ProjectAction,
    pub(crate) open_menu: OpenSidebarMenu,
    pub(crate) toggle_snoozed: SidebarAction,
    pub(crate) toggle_settled: SidebarAction,
    pub(crate) show_more_settled: SidebarAction,
    pub(crate) toggle_account: SidebarAction,
}

pub(crate) struct SidebarProps<'a> {
    pub(crate) theme: Theme,
    pub(crate) projects: &'a [ProjectSummary],
    pub(crate) connection: ConnectionState,
    pub(crate) loaded: bool,
    pub(crate) fixture: bool,
    pub(crate) mode: SidebarMode,
    pub(crate) selected_thread_id: Option<&'a str>,
    pub(crate) selected_scope: Option<&'a str>,
    pub(crate) query: &'a str,
    pub(crate) search_focused: bool,
    pub(crate) search_input: Entity<InputState>,
    pub(crate) rename_input: Entity<InputState>,
    pub(crate) renaming_project: Option<&'a str>,
    pub(crate) renaming_thread: Option<&'a str>,
    pub(crate) dragging_thread: Option<&'a str>,
    pub(crate) scope_open: bool,
    pub(crate) collapsed_projects: &'a std::collections::HashSet<String>,
    pub(crate) expanded_project_sessions: &'a std::collections::HashSet<String>,
    pub(crate) status_clocks: &'a HashMap<String, (ThreadInboxStatus, f64)>,
    pub(crate) selected_ids: &'a std::collections::HashSet<String>,
    pub(crate) row_focus: &'a HashMap<String, gpui::FocusHandle>,
    pub(crate) snoozed_expanded: bool,
    pub(crate) settled_expanded: bool,
    pub(crate) settled_limit: usize,
    pub(crate) account_menu_open: bool,
    pub(crate) provider_name: &'a str,
    pub(crate) account_email: Option<&'a str>,
    pub(crate) usage_limits: &'a [UsageLimit],
    pub(crate) glass: u8,
    pub(crate) width: f32,
}

#[derive(Clone, Copy)]
struct SidebarRowState<'a> {
    renaming_project: Option<&'a str>,
    renaming_thread: Option<&'a str>,
    rename_input: &'a Entity<InputState>,
    dragging_thread: Option<&'a str>,
    classic_row_width: f32,
}

struct SidebarSearch<'a> {
    query: &'a str,
    focused: bool,
    input: &'a Entity<InputState>,
}

#[derive(Clone)]
struct SessionDrag {
    project_path: String,
    session_id: String,
    title: String,
    width: f32,
    theme: Theme,
}

struct SessionDragPreview(SessionDrag);

impl gpui::Render for SessionDragPreview {
    fn render(&mut self, _window: &mut Window, _cx: &mut gpui::Context<Self>) -> impl IntoElement {
        div()
            .h(px(28.0))
            .w(px(self.0.width))
            .flex()
            .items_center()
            .pl(px(32.0))
            .pr(px(8.0))
            .rounded(px(RADIUS_MD))
            .bg(classic_session_active_background(self.0.theme))
            .shadow(classic_session_active_shadows(self.0.theme))
            .text_size(px(12.5))
            .text_color(self.0.theme.text.hsla())
            .opacity(0.94)
            .child(
                div()
                    .min_w(px(0.0))
                    .flex_1()
                    .truncate()
                    .child(self.0.title.clone()),
            )
    }
}

pub fn sidebar(props: SidebarProps<'_>, actions: SidebarActions) -> impl IntoElement {
    let SidebarProps {
        theme,
        projects,
        connection,
        loaded,
        fixture,
        mode,
        selected_thread_id,
        selected_scope,
        query,
        search_focused,
        search_input,
        rename_input,
        renaming_project,
        renaming_thread,
        dragging_thread,
        scope_open,
        collapsed_projects,
        expanded_project_sessions,
        status_clocks,
        selected_ids,
        row_focus,
        snoozed_expanded,
        settled_expanded,
        settled_limit,
        account_menu_open,
        provider_name,
        account_email,
        usage_limits,
        glass,
        width,
    } = props;
    let row_state = SidebarRowState {
        renaming_project,
        renaming_thread,
        rename_input: &rename_input,
        dragging_thread,
        classic_row_width: (width - 16.0).max(0.0),
    };
    div()
        .relative()
        .w(px(width))
        .h_full()
        .flex_none()
        .flex()
        .flex_col()
        .bg(chrome::rail_background_with_opacity(
            theme,
            rail_opacity(glass),
        ))
        .child(if mode == SidebarMode::Inbox {
            sidebar_actions(
                theme,
                projects,
                selected_scope,
                scope_open,
                SidebarSearch {
                    query,
                    focused: search_focused,
                    input: &search_input,
                },
                &actions,
            )
            .into_any_element()
        } else {
            classic_sidebar_actions(theme, &actions).into_any_element()
        })
        .child(if fixture {
            fixture_sidebar_body(theme).into_any_element()
        } else if mode == SidebarMode::Classic {
            classic_sidebar_body(
                theme,
                projects,
                connection,
                loaded,
                selected_thread_id,
                collapsed_projects,
                expanded_project_sessions,
                row_state,
                actions.clone(),
            )
            .into_any_element()
        } else {
            sidebar_body(
                theme,
                projects,
                connection,
                loaded,
                selected_thread_id,
                selected_scope,
                query,
                status_clocks,
                selected_ids,
                row_focus,
                snoozed_expanded,
                settled_expanded,
                settled_limit,
                row_state,
                actions.clone(),
            )
            .into_any_element()
        })
        .child(sidebar_footer(
            theme,
            provider_name,
            account_email,
            usage_limits,
            account_menu_open,
            &actions,
        ))
}

fn rail_opacity(glass: u8) -> f32 {
    (1.0 - f32::from(glass.min(60)) * 0.013).max(0.0)
}

pub(crate) fn sidebar_bloom(theme: Theme, glass: u8) -> AnyElement {
    let enabled = glass > 0;
    let strength = f32::from(glass.min(60)) / 100.0;
    div()
        .absolute()
        .inset_0()
        .overflow_hidden()
        .opacity(if enabled { 0.25 + strength * 1.4 } else { 0.0 })
        .when(enabled, |layer| {
            layer
                .child(radial_bloom(
                    -0.51,
                    -0.30,
                    1.30,
                    0.68,
                    theme.attention.hsla(),
                    0.34,
                ))
                .child(radial_bloom(
                    -0.61,
                    0.14,
                    1.10,
                    0.60,
                    theme.effort.hsla(),
                    0.22,
                ))
                .child(radial_bloom(
                    -0.30,
                    0.68,
                    1.20,
                    0.64,
                    theme.file_reference.hsla(),
                    0.24,
                ))
        })
        .into_any_element()
}

fn radial_bloom(
    left: f32,
    top: f32,
    width: f32,
    height: f32,
    color: Hsla,
    opacity: f32,
) -> AnyElement {
    div()
        .absolute()
        .left(relative(left))
        .top(relative(top))
        .w(relative(width))
        .h(relative(height))
        .flex()
        .items_center()
        .justify_center()
        .rounded_full()
        .bg(color.opacity(opacity * 0.15))
        .shadow(vec![BoxShadow {
            color: color.opacity(opacity * 0.08),
            offset: point(px(0.0), px(0.0)),
            blur_radius: px(28.0),
            spread_radius: px(8.0),
        }])
        .child(
            div()
                .w(relative(0.68))
                .h(relative(0.68))
                .flex()
                .items_center()
                .justify_center()
                .rounded_full()
                .bg(color.opacity(opacity * 0.25))
                .child(
                    div()
                        .w(relative(0.44))
                        .h(relative(0.44))
                        .rounded_full()
                        .bg(color.opacity(opacity * 0.60)),
                ),
        )
        .into_any_element()
}

const ACCOUNT_MENU_ENTRY_SCALE_FROM: f32 = 0.97;

fn account_menu_entry_scale(progress: f32) -> f32 {
    ACCOUNT_MENU_ENTRY_SCALE_FROM + (1.0 - ACCOUNT_MENU_ENTRY_SCALE_FROM) * progress
}

fn account_menu_entry_animation(theme: Theme) -> Animation {
    Animation::new(theme.motion.fast).with_easing(crate::theme::web_ease_out)
}

fn sidebar_footer(
    theme: Theme,
    provider_name: &str,
    account_email: Option<&str>,
    usage_limits: &[UsageLimit],
    account_menu_open: bool,
    actions: &SidebarActions,
) -> AnyElement {
    let toggle = actions.toggle_account.clone();
    let initial = account_email
        .unwrap_or(provider_name)
        .chars()
        .next()
        .map(|character| character.to_uppercase().to_string())
        .unwrap_or_else(|| "H".into());
    div()
        .relative()
        .flex_none()
        .border_t_1()
        .border_color(theme.line.hsla())
        .px(px(10.0))
        .pt(px(8.0))
        .pb(px(10.0))
        .when(account_menu_open, |footer| {
            footer.child(
                div()
                    .absolute()
                    .left(px(10.0))
                    .right(px(10.0))
                    .bottom(px(54.0))
                    .flex()
                    .justify_center()
                    .child(
                        div()
                            .id("account-menu")
                            .occlude()
                            .relative()
                            .w_full()
                            .rounded(px(8.0))
                            .border_1()
                            .border_color(chrome::menu_border(theme))
                            .bg(chrome::menu_background(theme))
                            .shadow(chrome::flyout_shadows(theme))
                            .p(px(4.0))
                            .child(account_limits(provider_name, usage_limits, theme))
                            .child(footer_menu_action(
                                "account-settings",
                                "Settings",
                                shortcut_label(SETTINGS),
                                theme,
                                actions.open_settings.clone(),
                            ))
                            .with_animation(
                                "account-menu",
                                Animation::new(theme.motion.fast)
                                    .with_easing(crate::theme::web_ease_out),
                                |menu, delta| {
                                    let scale = account_menu_entry_scale(delta);
                                    menu.w(relative(scale))
                                        .top(px(2.0 * (1.0 - delta)))
                                        .rounded(px(8.0 * scale))
                                        .p(px(4.0 * scale))
                                        .opacity(delta)
                                },
                            ),
                    ),
            )
        })
        .child(
            div()
                .id("account-trigger")
                .group("account-trigger")
                .relative()
                .h(px(38.0))
                .w_full()
                .flex()
                .items_center()
                .gap(px(8.0))
                .px(px(8.0))
                .rounded(px(8.0))
                .border_1()
                .border_color(chrome::border(theme))
                .bg(chrome::raised(theme))
                .shadow(chrome::shadows(theme))
                .text_size(px(12.5))
                .text_color(theme.text_2.hsla())
                .cursor_pointer()
                .hover(move |style| {
                    style
                        .bg(chrome::raised_hover(theme))
                        .border_color(chrome::hover_border(theme))
                        .text_color(theme.text.hsla())
                })
                .active(|style| style.top(px(1.0)).shadow(Vec::new()))
                .on_click(move |_event, _window, cx| toggle(cx))
                .child(account_trigger_top_highlight(theme))
                .child(account_trigger_inset_shade(theme))
                .child(
                    div()
                        .size(px(22.0))
                        .flex_none()
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(11.0))
                        .bg(theme.surface_3.hsla())
                        .text_size(px(11.5))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(theme.text_2.hsla())
                        .group_hover("account-trigger", move |avatar| {
                            avatar
                                .bg(theme.text_3.mix_srgb(theme.surface_3, 0.24).hsla())
                                .text_color(theme.text.hsla())
                        })
                        .child(initial),
                )
                .child(
                    div()
                        .min_w(px(0.0))
                        .flex_1()
                        .truncate()
                        .child(provider_name.to_owned()),
                ),
        )
        .into_any_element()
}

fn account_limits(provider_name: &str, limits: &[UsageLimit], theme: Theme) -> AnyElement {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |duration| duration.as_secs_f64() * 1_000.0);
    div()
        .flex()
        .flex_col()
        .gap(px(7.0))
        .px(px(9.0))
        .pt(px(7.0))
        .pb(px(9.0))
        .mb(px(4.0))
        .border_b_1()
        .border_color(chrome::menu_border(theme))
        .text_size(px(12.5))
        .text_color(theme.text_2.hsla())
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(8.0))
                .text_size(px(13.5))
                .child(
                    div()
                        .size(px(14.0))
                        .flex_none()
                        .text_color(theme.text_3.hsla())
                        .child(
                            motion_icon(
                                "account-limits-icon",
                                "icons/gauge.svg",
                                14.0,
                                "account-limits-icon-direct-hover",
                                theme,
                            )
                            .size_full(),
                        )
                        .with_animation(
                            "account-limits-icon-in",
                            account_menu_entry_animation(theme),
                            |icon, delta| icon.size(px(14.0 * account_menu_entry_scale(delta))),
                        ),
                )
                .child("Limits")
                .with_animation(
                    "account-limits-head-in",
                    account_menu_entry_animation(theme),
                    |head, delta| {
                        let scale = account_menu_entry_scale(delta);
                        head.gap(px(8.0 * scale)).text_size(px(13.5 * scale))
                    },
                ),
        )
        .when(limits.is_empty(), |usage| {
            usage.child(
                div()
                    .text_color(theme.text_3.hsla())
                    .child(format!("{provider_name} reports no limits")),
            )
        })
        .children(
            limits
                .iter()
                .enumerate()
                .map(|(index, limit)| usage_limit(limit, index, now_ms, theme)),
        )
        .with_animation(
            "account-limits-in",
            account_menu_entry_animation(theme),
            |limits, delta| {
                let scale = account_menu_entry_scale(delta);
                limits
                    .gap(px(7.0 * scale))
                    .px(px(9.0 * scale))
                    .pt(px(7.0 * scale))
                    .pb(px(9.0 * scale))
                    .mb(px(4.0 * scale))
                    .text_size(px(12.5 * scale))
            },
        )
        .into_any_element()
}

fn usage_limit(limit: &UsageLimit, index: usize, now_ms: f64, theme: Theme) -> AnyElement {
    let (left_percent, left) = usage_left(limit.used_percent);
    div()
        .flex()
        .flex_col()
        .gap(px(4.0))
        .child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .gap(px(8.0))
                .child(
                    div()
                        .text_color(theme.text.hsla())
                        .child(limit.label.clone()),
                )
                .child(format!("{left}% left"))
                .with_animation(
                    ("account-limit-row-in", index),
                    account_menu_entry_animation(theme),
                    |row, delta| row.gap(px(8.0 * account_menu_entry_scale(delta))),
                ),
        )
        .child(
            div()
                .h(px(4.0))
                .w_full()
                .overflow_hidden()
                .rounded(px(2.0))
                .bg(theme.surface_3.hsla())
                .child(
                    div()
                        .h_full()
                        .w(relative(left_percent / 100.0))
                        .rounded(px(2.0))
                        .bg(theme.running.hsla()),
                )
                .with_animation(
                    ("account-limit-bar-in", index),
                    account_menu_entry_animation(theme),
                    |bar, delta| {
                        let scale = account_menu_entry_scale(delta);
                        bar.h(px(4.0 * scale)).rounded(px(2.0 * scale))
                    },
                ),
        )
        .when_some(limit.resets_at, |window, resets_at| {
            window.child(
                div()
                    .text_size(px(11.5))
                    .text_color(theme.text_3.hsla())
                    .child(format!("Resets {}", reset_label(resets_at, now_ms)))
                    .with_animation(
                        ("account-limit-reset-in", index),
                        account_menu_entry_animation(theme),
                        |reset, delta| reset.text_size(px(11.5 * account_menu_entry_scale(delta))),
                    ),
            )
        })
        .with_animation(
            ("account-limit-in", index),
            account_menu_entry_animation(theme),
            |limit, delta| limit.gap(px(4.0 * account_menu_entry_scale(delta))),
        )
        .into_any_element()
}

fn usage_left(used_percent: f64) -> (f32, u8) {
    let left = (100.0 - used_percent).clamp(0.0, 100.0);
    (left as f32, left.round() as u8)
}

fn reset_label(timestamp_ms: f64, now_ms: f64) -> String {
    let timestamp = timestamp_ms.round() as i64;
    DateTime::from_timestamp_millis(timestamp).map_or_else(
        || "later".into(),
        |date| {
            let local = date.with_timezone(&Local);
            if timestamp_ms - now_ms < 6.0 * 86_400_000.0 {
                local.format("%a %H:%M").to_string()
            } else {
                format!("{} {}", local.format("%b"), local.day())
            }
        },
    )
}

fn footer_menu_action(
    id: &'static str,
    label: &'static str,
    shortcut: String,
    theme: Theme,
    action: SidebarAction,
) -> AnyElement {
    div()
        .id(id)
        .group("account-menu-action")
        .w_full()
        .flex()
        .items_center()
        .justify_between()
        .gap(px(6.0))
        .px(px(9.0))
        .py(px(7.0))
        .rounded(px(5.0))
        .text_size(px(13.5))
        .text_color(theme.text.hsla())
        .cursor_pointer()
        .hover(move |style| style.bg(chrome::menu_hover_background(theme)))
        .on_click(move |_event, _window, cx| action(cx))
        .child(label)
        .child(
            div()
                .ml_auto()
                .opacity(0.0)
                .font_family("Geist Mono")
                .text_size(px(10.5))
                .font_weight(FontWeight(450.0))
                .text_color(theme.text_3.hsla())
                .group_hover("account-menu-action", |hint| hint.opacity(1.0))
                .child(shortcut)
                .with_animation(
                    "account-settings-shortcut-in",
                    account_menu_entry_animation(theme),
                    |hint, delta| hint.text_size(px(10.5 * account_menu_entry_scale(delta))),
                ),
        )
        .with_animation(
            "account-settings-in",
            account_menu_entry_animation(theme),
            |action, delta| {
                let scale = account_menu_entry_scale(delta);
                action
                    .gap(px(6.0 * scale))
                    .px(px(9.0 * scale))
                    .py(px(7.0 * scale))
                    .rounded(px(5.0 * scale))
                    .text_size(px(13.5 * scale))
            },
        )
        .into_any_element()
}

fn classic_sidebar_actions(theme: Theme, actions: &SidebarActions) -> impl IntoElement {
    div()
        .flex_none()
        .flex()
        .flex_col()
        .gap(px(1.0))
        .px(px(10.0))
        .pt(px(12.0))
        .pb(px(10.0))
        .child(
            div()
                .min_w(px(0.0))
                .flex()
                .items_center()
                .gap(px(2.0))
                .child(nav_item(
                    "new-chat",
                    ("icons/plus.svg", 15.0),
                    "New chat",
                    shortcut_label(NEW_CHAT),
                    theme,
                    true,
                    Some(actions.new_chat.clone()),
                ))
                .child(
                    div()
                        .id("classic-search-chats")
                        .group("classic-search-chats-hover")
                        .relative()
                        .size(px(28.0))
                        .flex_none()
                        .flex()
                        .items_center()
                        .justify_center()
                        .overflow_hidden()
                        .rounded(px(RADIUS_MD))
                        .text_color(theme.text_3.hsla())
                        .cursor_pointer()
                        .hover(move |style| {
                            style
                                .bg(chrome::control_hover_background(theme))
                                .text_color(theme.text.hsla())
                        })
                        .on_click({
                            let open_search = actions.open_search.clone();
                            move |_event, _window, cx| open_search(cx)
                        })
                        .child(
                            div()
                                .id("classic-search-chats-icon-press")
                                .size(px(14.0))
                                .child(
                                    motion_icon(
                                        "classic-search-chats-icon",
                                        "icons/search.svg",
                                        14.0,
                                        "classic-search-chats-hover",
                                        theme,
                                    )
                                    .size_full(),
                                ),
                        ),
                ),
        )
        .child(nav_item(
            "new-project",
            ("icons/folder-pen.svg", 15.0),
            "New project",
            shortcut_label(NEW_PROJECT),
            theme,
            false,
            Some(actions.new_project.clone()),
        ))
}

fn sidebar_actions(
    theme: Theme,
    projects: &[ProjectSummary],
    selected_scope: Option<&str>,
    scope_open: bool,
    search: SidebarSearch<'_>,
    actions: &SidebarActions,
) -> impl IntoElement {
    let clear_input = search.input.clone();
    let keyboard_clear_input = clear_input.clone();
    div()
        .flex_none()
        .flex()
        .flex_col()
        .gap(px(5.0))
        .px(px(10.0))
        .pt(px(10.0))
        .pb(px(9.0))
        .border_b_1()
        .border_color(theme.line.hsla())
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(3.0))
                .child(
                    div()
                        .id("search-chats")
                        .h(px(32.0))
                        .w_full()
                        .flex()
                        .items_center()
                        .gap(px(7.0))
                        .px(px(9.0))
                        .rounded(px(RADIUS_MD))
                        .border_1()
                        .border_color(if search.focused {
                            theme.text_3.hsla()
                        } else {
                            chrome::border(theme)
                        })
                        .bg(chrome::recessed(theme))
                        .text_color(theme.text_3.hsla())
                        .hover(move |style| {
                            style
                                .border_color(if search.focused {
                                    theme.text_3.hsla()
                                } else {
                                    inbox_search_hover_border(theme)
                                })
                                .text_color(theme.text.hsla())
                        })
                        .child(motion_icon(
                            "search-chats-icon",
                            "icons/search.svg",
                            14.0,
                            "search-chats-icon-direct-hover",
                            theme,
                        ))
                        .child(
                            Input::new(search.input)
                                .xsmall()
                                .appearance(false)
                                .bordered(false)
                                .focus_bordered(false)
                                .cleanable(false)
                                .min_w(px(0.0))
                                .flex_1()
                                .px(px(0.0))
                                .py(px(0.0))
                                .line_height(relative(1.55))
                                .text_size(px(12.5))
                                .text_color(theme.text.hsla()),
                        )
                        .when(!search.query.is_empty(), |field| {
                            field.child(
                                div()
                                    .id("clear-thread-list-search")
                                    .group("clear-thread-list-search-hover")
                                    .tab_index(0)
                                    .size(px(20.0))
                                    .flex_none()
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .rounded(px(RADIUS_SM))
                                    .cursor_pointer()
                                    .hover(move |style| {
                                        style
                                            .bg(theme.surface_3.hsla())
                                            .text_color(theme.text.hsla())
                                    })
                                    .on_key_down(move |event, window, cx| {
                                        if is_button_activation(event) {
                                            cx.stop_propagation();
                                            keyboard_clear_input.update(cx, |input, cx| {
                                                input.set_value("", window, cx);
                                                input.focus(window, cx);
                                            });
                                        }
                                    })
                                    .on_click(move |_event, window, cx| {
                                        clear_input.update(cx, |input, cx| {
                                            input.set_value("", window, cx);
                                            input.focus(window, cx);
                                        });
                                    })
                                    .child(motion_icon(
                                        "clear-thread-list-search-icon",
                                        "icons/x.svg",
                                        12.0,
                                        "clear-thread-list-search-hover",
                                        theme,
                                    )),
                            )
                        }),
                )
                .child(
                    div()
                        .id("new-chat")
                        .group("new-chat-hover")
                        .h(px(34.0))
                        .w_full()
                        .flex()
                        .items_center()
                        .gap(px(8.0))
                        .px(px(8.0))
                        .rounded(px(RADIUS_MD))
                        .text_size(px(13.5))
                        .text_color(theme.text.hsla())
                        .cursor_pointer()
                        .hover(move |style| style.bg(chrome::control_hover_background(theme)))
                        .active(|style| {
                            style
                                .w(relative(0.985))
                                .h(px(33.49))
                                .mx(relative(0.0075))
                                .my(px(0.255))
                                .gap(px(7.88))
                                .px(px(7.88))
                                .rounded(px(7.88))
                                .text_size(px(13.2975))
                        })
                        .on_click({
                            let new_chat = actions.new_chat.clone();
                            move |_event, _window, cx| new_chat(cx)
                        })
                        .child(
                            div()
                                .id("new-chat-icon-press")
                                .size(px(16.0))
                                .flex_none()
                                .text_color(theme.text_2.hsla())
                                .group_active("new-chat-hover", |style| style.size(px(15.76)))
                                .child(
                                    motion_icon(
                                        "new-chat-icon",
                                        "icons/square-pen.svg",
                                        16.0,
                                        "new-chat-hover",
                                        theme,
                                    )
                                    .size_full(),
                                ),
                        )
                        .child("New chat"),
                ),
        )
        .child(
            div()
                .mt(px(1.0))
                .h(px(29.0))
                .w_full()
                .flex()
                .items_center()
                .gap(px(5.0))
                .child(scope_control(
                    theme,
                    projects,
                    selected_scope,
                    scope_open,
                    actions.toggle_scope.clone(),
                    actions.select_scope.clone(),
                ))
                .child(
                    div()
                        .id("new-project")
                        .group("new-project-hover")
                        .h(px(29.0))
                        .flex_none()
                        .flex()
                        .items_center()
                        .justify_center()
                        .gap(px(6.0))
                        .px(px(8.0))
                        .rounded(px(RADIUS_MD))
                        .border_1()
                        .border_color(theme.line_strong.hsla())
                        .text_size(px(10.5))
                        .text_color(theme.text_3.hsla())
                        .cursor_pointer()
                        .hover(move |style| {
                            style
                                .border_color(theme.text_3.hsla().opacity(0.72))
                                .text_color(theme.text.hsla())
                        })
                        .on_click({
                            let new_project = actions.new_project.clone();
                            move |_event, _window, cx| new_project(cx)
                        })
                        .child(motion_icon(
                            "new-project-icon",
                            "icons/folder-plus.svg",
                            13.0,
                            "new-project-hover",
                            theme,
                        ))
                        .child("Add Project"),
                ),
        )
}

fn inbox_search_hover_border(theme: Theme) -> Hsla {
    let border = match theme.mode {
        ThemeMode::Dark => ColorToken(0x303030),
        ThemeMode::Light => ColorToken(0xe3e3e6),
    };
    theme.text_3.mix_srgb(border, 0.35).hsla()
}

fn fixture_sidebar_body(theme: Theme) -> impl IntoElement {
    div()
        .id("sidebar-scroll")
        .flex_1()
        .overflow_y_scroll()
        .px(px(8.0))
        .pb(px(12.0))
        .child(section_label("Active".into(), theme))
        .child(inbox_row(
            "fixture-working".into(),
            "Finish Sidebar v2".into(),
            "personalharness · Codex · codex/sidebar-v2".into(),
            Status::Working,
            theme,
            false,
            None,
            None,
            None,
        ))
        .child(inbox_row(
            "fixture-approval".into(),
            "Review lifecycle contract".into(),
            "personalharness · Codex · 9m ago".into(),
            Status::Approval,
            theme,
            false,
            None,
            None,
            None,
        ))
        .child(inbox_row(
            "fixture-input".into(),
            "Connect remote desktop".into(),
            "mobile-harness · Claude Code · 20m ago".into(),
            Status::Input,
            theme,
            false,
            None,
            None,
            None,
        ))
        .child(inbox_row(
            "fixture-ready".into(),
            "Verify macOS terminal behavior".into(),
            "personalharness · Codex · 36m ago".into(),
            Status::Ready,
            theme,
            false,
            None,
            None,
            None,
        ))
        .child(inbox_row(
            "fixture-failed".into(),
            "Run device smoke test".into(),
            "mobile-harness · Gemini · 1h ago".into(),
            Status::Failed,
            theme,
            false,
            None,
            None,
            None,
        ))
        .child(collapsed_group(
            "Projects · 2".into(),
            None,
            false,
            theme,
            None,
        ))
        .child(collapsed_group(
            "Snoozed".into(),
            Some("2".into()),
            false,
            theme,
            None,
        ))
        .child(collapsed_group(
            "Settled".into(),
            Some("3".into()),
            true,
            theme,
            None,
        ))
        .child(settled_row(
            "fixture-settled-1".into(),
            "Persist sidebar settings".into(),
            "personalharness · 40m ago".into(),
            theme,
            false,
            None,
            None,
        ))
        .child(settled_row(
            "fixture-settled-2".into(),
            "Add lifecycle event routing".into(),
            "personalharness · 1h ago".into(),
            theme,
            false,
            None,
            None,
        ))
}

#[allow(clippy::too_many_arguments)]
fn sidebar_body(
    theme: Theme,
    projects: &[ProjectSummary],
    connection: ConnectionState,
    loaded: bool,
    selected_thread_id: Option<&str>,
    selected_scope: Option<&str>,
    query: &str,
    status_clocks: &HashMap<String, (ThreadInboxStatus, f64)>,
    selected_ids: &std::collections::HashSet<String>,
    row_focus: &HashMap<String, gpui::FocusHandle>,
    snoozed_expanded: bool,
    settled_expanded: bool,
    settled_limit: usize,
    row_state: SidebarRowState<'_>,
    actions: SidebarActions,
) -> impl IntoElement {
    let normalized_query = query.trim().to_lowercase();
    let mut active = Vec::new();
    let mut snoozed = Vec::new();
    let mut settled = Vec::new();
    for project in projects {
        if selected_scope.is_some_and(|scope| scope != project.path) {
            continue;
        }
        for session in &project.sessions {
            if !title_matches_query(&session.title, &normalized_query) {
                continue;
            }
            match session.lifecycle.as_ref() {
                Some(ThreadLifecycle::Snoozed { .. }) => snoozed.push((project, session)),
                Some(ThreadLifecycle::Settled { .. }) => settled.push((project, session)),
                Some(ThreadLifecycle::Active { .. }) | None => active.push((project, session)),
            }
        }
    }
    active.sort_by(|(_, left), (_, right)| newest_first(left, right));
    snoozed.sort_by_key(|(_, session)| wake_at(session).unwrap_or(u64::MAX));
    settled.sort_by(|(_, left), (_, right)| {
        settled_at(right)
            .unwrap_or(right.created_at)
            .partial_cmp(&settled_at(left).unwrap_or(left.created_at))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let now = current_time_ms();
    let ordered_ids = ordered_inbox_ids(projects, selected_scope, query);
    let selection_count = selected_ids.len();

    let query_active = !normalized_query.is_empty();
    let active_count = active.len();
    let active_empty = active.is_empty();
    let has_matches = !active.is_empty() || !snoozed.is_empty() || !settled.is_empty();
    let selected_snoozed = snoozed
        .iter()
        .any(|(_, session)| selected_thread_id == Some(session.id.as_str()));
    let selected_settled = settled
        .iter()
        .find(|(_, session)| selected_thread_id == Some(session.id.as_str()))
        .copied();
    let snoozed_open = query_active || snoozed_expanded || selected_snoozed;
    let settled_open = query_active || settled_expanded || selected_settled.is_some();
    let settled_count = settled.len();
    let mut visible_settled = if query_active {
        settled.clone()
    } else {
        settled
            .iter()
            .copied()
            .take(settled_limit)
            .collect::<Vec<_>>()
    };
    if let Some(selected) = selected_settled
        && !visible_settled
            .iter()
            .any(|(_, session)| session.id == selected.1.id)
    {
        visible_settled.push(selected);
    }

    let status = match connection {
        ConnectionState::Connecting => Some("Connecting to server…"),
        ConnectionState::Reconnecting => Some("Reconnecting…"),
        ConnectionState::Closed => Some("Server unavailable"),
        ConnectionState::Open if !loaded => Some("Loading threads…"),
        ConnectionState::Open if projects.is_empty() => Some("Nothing here yet."),
        ConnectionState::Open => None,
    };
    let show_empty_active = !query_active && active_empty && status.is_none();

    div()
        .id("sidebar-scroll")
        .flex_1()
        .flex()
        .flex_col()
        .gap(px(4.0))
        .overflow_y_scroll()
        .px(px(8.0))
        .pt(px(8.0))
        .pb(px(12.0))
        .when_some(status, |body, label| {
            body.child(empty_state(SharedString::from(label), theme))
        })
        .when(selection_count > 1, |body| {
            body.child(
                div()
                    .mb(px(2.0))
                    .px(px(8.0))
                    .py(px(4.0))
                    .text_size(px(11.5))
                    .text_color(theme.text_2.hsla())
                    .child(format!("{selection_count} threads selected")),
            )
        })
        .when(!query_active || !active_empty, |body| {
            body.child(section_heading("Active", active_count, theme))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(3.0))
                        .children(active.into_iter().map(|(project, session)| {
                            active_inbox_row(
                                project,
                                session,
                                status_clocks
                                    .get(&session.id)
                                    .map_or(session.created_at, |clock| clock.1),
                                now,
                                theme,
                                selected_thread_id == Some(session.id.as_str()),
                                selected_ids.contains(&session.id),
                                thread_menu_request(&session.id, selected_ids, &ordered_ids),
                                row_navigation(&session.id, &ordered_ids, row_focus),
                                row_state,
                                &actions,
                            )
                        })),
                )
                .when(show_empty_active, |body| {
                    body.child(empty_state(
                        "No active threads in this project.".into(),
                        theme,
                    ))
                })
        })
        .when(!snoozed.is_empty(), |body| {
            body.child(
                div()
                    .flex()
                    .flex_col()
                    .child(collapsed_group(
                        "Snoozed".into(),
                        Some(snoozed.len().to_string().into()),
                        snoozed_open,
                        theme,
                        Some(actions.toggle_snoozed.clone()),
                    ))
                    .when(snoozed_open, |section| {
                        section.children(snoozed.into_iter().map(|(_project, session)| {
                            inbox_shelf_row(
                                session,
                                format_wake_time(session, now),
                                "icons/bell.svg",
                                theme,
                                selected_thread_id == Some(session.id.as_str()),
                                selected_ids.contains(&session.id),
                                thread_menu_request(&session.id, selected_ids, &ordered_ids),
                                row_navigation(&session.id, &ordered_ids, row_focus),
                                actions.wake_thread.clone(),
                                row_state,
                                &actions,
                            )
                        }))
                    }),
            )
        })
        .when(settled_count > 0, |body| {
            body.child(
                div()
                    .flex()
                    .flex_col()
                    .child(collapsed_group(
                        "Settled".into(),
                        Some(settled_count.to_string().into()),
                        settled_open,
                        theme,
                        Some(actions.toggle_settled.clone()),
                    ))
                    .when(settled_open, |section| {
                        section
                            .children(visible_settled.into_iter().map(|(project, session)| {
                                inbox_shelf_row(
                                    session,
                                    format!(
                                        "{} · {}",
                                        project.name,
                                        relative_time_at(
                                            settled_at(session).unwrap_or(session.created_at),
                                            now,
                                        )
                                    ),
                                    "icons/check-check.svg",
                                    theme,
                                    selected_thread_id == Some(session.id.as_str()),
                                    selected_ids.contains(&session.id),
                                    thread_menu_request(&session.id, selected_ids, &ordered_ids),
                                    row_navigation(&session.id, &ordered_ids, row_focus),
                                    actions.unsettle_thread.clone(),
                                    row_state,
                                    &actions,
                                )
                            }))
                            .when(!query_active && settled_count > settled_limit, |section| {
                                section.child(show_more_settled(
                                    theme,
                                    actions.show_more_settled.clone(),
                                ))
                            })
                    }),
            )
        })
        .when(query_active && !has_matches, |body| {
            body.child(empty_state(
                format!("No threads match “{}”.", query.trim()).into(),
                theme,
            ))
        })
}

fn nav_item(
    id: &'static str,
    icon: (&'static str, f32),
    label: &'static str,
    shortcut: impl Into<SharedString>,
    theme: Theme,
    grow: bool,
    action: Option<SidebarAction>,
) -> impl IntoElement {
    let (icon_path, icon_size) = icon;
    let shortcut = shortcut.into();
    let hover_group: SharedString = format!("{id}:hover").into();
    let icon_id: SharedString = format!("{id}:icon").into();
    let icon_press_id: SharedString = format!("{id}:icon-press").into();
    let icon_box_id: SharedString = format!("{id}:icon-box").into();
    let label_id: SharedString = format!("{id}:label").into();
    let shortcut_id: SharedString = format!("{id}:shortcut").into();
    div()
        .id(id)
        .group(hover_group.clone())
        .h(px(32.0))
        .w_full()
        .when(grow, |item| item.min_w(px(0.0)).flex_1())
        .flex()
        .items_center()
        .px(px(8.0))
        .rounded(px(RADIUS_MD))
        .text_color(theme.text_2.hsla())
        .cursor_pointer()
        .hover(move |style| {
            style
                .bg(chrome::control_hover_background(theme))
                .text_color(theme.text.hsla())
        })
        .active(|style| {
            style
                .w(relative(0.98))
                .h(px(31.36))
                .mx(relative(0.01))
                .my(px(0.32))
                .px(px(7.84))
                .rounded(px(RADIUS_MD * 0.98))
        })
        .when_some(action, |item, action| {
            item.on_click(move |_event, _window, cx| action(cx))
        })
        .child(
            div()
                .id(icon_box_id)
                .size(px(16.0))
                .flex()
                .items_center()
                .justify_center()
                .text_color(theme.text_3.hsla())
                .group_active(hover_group.clone(), |style| style.size(px(15.68)))
                .child(
                    div()
                        .id(icon_press_id)
                        .size(px(icon_size))
                        .group_active(hover_group.clone(), move |style| {
                            style.size(px(icon_size * 0.98))
                        })
                        .child(
                            motion_icon(icon_id, icon_path, icon_size, hover_group.clone(), theme)
                                .size_full(),
                        ),
                ),
        )
        .child(
            div()
                .id(label_id)
                .ml(px(9.0))
                .min_w(px(0.0))
                .flex_1()
                .truncate()
                .text_size(px(13.5))
                .group_active(hover_group.clone(), |style| {
                    style.ml(px(8.82)).text_size(px(13.23))
                })
                .child(label),
        )
        .child(
            div()
                .id(shortcut_id)
                .opacity(0.0)
                .font_family("Geist Mono")
                .text_size(px(10.5))
                .font_weight(FontWeight(450.0))
                .text_color(theme.text_3.hsla())
                .group_hover(hover_group.clone(), |style| style.opacity(1.0))
                .group_active(hover_group, |style| style.text_size(px(10.29)))
                .child(shortcut),
        )
}

#[allow(clippy::too_many_arguments)]
fn classic_sidebar_body(
    theme: Theme,
    projects: &[ProjectSummary],
    connection: ConnectionState,
    loaded: bool,
    selected_thread_id: Option<&str>,
    collapsed_projects: &std::collections::HashSet<String>,
    expanded_project_sessions: &std::collections::HashSet<String>,
    row_state: SidebarRowState<'_>,
    actions: SidebarActions,
) -> impl IntoElement {
    let mut pinned_sessions = projects
        .iter()
        .flat_map(|project| project.sessions.iter().filter(|session| session.pinned))
        .collect::<Vec<_>>();
    pinned_sessions.sort_by(|left, right| newest_first(left, right));
    let mut ordered_projects = projects.iter().collect::<Vec<_>>();
    ordered_projects.sort_by_key(|project| !project.pinned);
    let status = match connection {
        ConnectionState::Connecting => Some("Connecting to server…"),
        ConnectionState::Reconnecting => Some("Reconnecting…"),
        ConnectionState::Closed => Some("Server unavailable"),
        ConnectionState::Open if !loaded => Some("Loading projects…"),
        ConnectionState::Open if projects.is_empty() => Some("Nothing here yet."),
        ConnectionState::Open => None,
    };

    div()
        .id("classic-sidebar-scroll")
        .flex_1()
        .overflow_y_scroll()
        .px(px(8.0))
        .pb(px(12.0))
        .when_some(status, |body, label| {
            body.child(empty_state(SharedString::from(label), theme))
        })
        .when(!pinned_sessions.is_empty(), |body| {
            body.child(section_label("Pinned".into(), theme)).children(
                pinned_sessions.into_iter().map(|session| {
                    classic_session_row(
                        session,
                        None,
                        selected_thread_id == Some(session.id.as_str()),
                        true,
                        row_state,
                        theme,
                        &actions,
                    )
                }),
            )
        })
        .child(section_label("Projects".into(), theme))
        .children(ordered_projects.into_iter().map(|project| {
            classic_project(
                project,
                selected_thread_id,
                !collapsed_projects.contains(&project.path),
                expanded_project_sessions.contains(&project.path),
                row_state,
                theme,
                &actions,
            )
        }))
}

fn classic_project(
    project: &ProjectSummary,
    selected_thread_id: Option<&str>,
    expanded: bool,
    show_all: bool,
    row_state: SidebarRowState<'_>,
    theme: Theme,
    actions: &SidebarActions,
) -> AnyElement {
    const COLLAPSED_SESSION_COUNT: usize = 5;
    let path = project.path.clone();
    let toggle_path = path.clone();
    let menu_path = path.clone();
    let menu_button_path = path.clone();
    let new_chat_path = path.clone();
    let show_path = path.clone();
    let sessions = project
        .sessions
        .iter()
        .filter(|session| !session.pinned)
        .collect::<Vec<_>>();
    let has_more = sessions.len() > COLLAPSED_SESSION_COUNT;
    let visible = if show_all {
        sessions.as_slice()
    } else {
        &sessions[..sessions.len().min(COLLAPSED_SESSION_COUNT)]
    };
    let drawer_height = classic_project_drawer_height(visible.len(), has_more);
    let drawer_open = expanded && !sessions.is_empty();
    let header =
        if row_state.renaming_project == Some(project.path.as_str()) {
            div()
                .w_full()
                .flex()
                .items_center()
                .child(sidebar_inline_rename(row_state.rename_input, theme, false))
                .into_any_element()
        } else {
            div()
                .group("classic-project")
                .w_full()
                .flex()
                .items_center()
                .gap(px(1.0))
                .child(
                    div()
                        .id(SharedString::from(format!(
                            "classic-project:{}",
                            project.path
                        )))
                        .group("classic-project-main-hover")
                        .min_w(px(0.0))
                        .flex_1()
                        .flex()
                        .items_center()
                        .gap(px(8.0))
                        .px(px(8.0))
                        .py(px(5.0))
                        .rounded(px(RADIUS_MD))
                        .text_size(px(13.5))
                        .text_color(theme.text.hsla())
                        .cursor_pointer()
                        .hover(move |style| {
                            style.bg(chrome_raised(theme)).shadow(chrome_shadows(theme))
                        })
                        .on_click({
                            let toggle = actions.toggle_project.clone();
                            let open_menu = actions.open_menu.clone();
                            move |event, _window, cx| {
                                if event.is_right_click() {
                                    cx.stop_propagation();
                                    open_menu(
                                        SidebarMenuRequest::Project(menu_path.clone()),
                                        SidebarMenuAnchor::Context(event.position()),
                                        cx,
                                    );
                                } else if event.standard_click() {
                                    toggle(toggle_path.clone(), cx);
                                }
                            }
                        })
                        .child(div().flex_none().text_color(theme.text_3.hsla()).child(
                            motion_icon(
                                SharedString::from(format!(
                                    "classic-project-icon:{}",
                                    project.path
                                )),
                                "icons/folder.svg",
                                12.0,
                                "classic-project-main-hover",
                                theme,
                            ),
                        ))
                        .child(
                            div()
                                .min_w(px(0.0))
                                .flex_1()
                                .truncate()
                                .child(project.name.clone()),
                        ),
                )
                .child(classic_project_menu_button(
                    format!("project-menu:{}", project.path).into(),
                    SidebarMenuRequest::Project(menu_button_path),
                    theme,
                    actions.open_menu.clone(),
                ))
                .child(
                    div()
                        .id(SharedString::from(format!("new-chat:{}", project.path)))
                        .group("classic-project-new-chat-hover")
                        .size(px(22.0))
                        .flex_none()
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(RADIUS_SM))
                        .text_color(theme.text_3.hsla())
                        .opacity(0.0)
                        .group_hover("classic-project", |button| button.opacity(1.0))
                        .cursor_pointer()
                        .hover(move |style| {
                            style
                                .bg(theme.surface_2.hsla())
                                .text_color(theme.text.hsla())
                        })
                        .on_click({
                            let new_chat = actions.new_chat_in_project.clone();
                            move |_event, _window, cx| {
                                cx.stop_propagation();
                                new_chat(new_chat_path.clone(), cx);
                            }
                        })
                        .active(|style| style.size(px(20.68)).m(px(0.66)))
                        .child(
                            div()
                                .id(SharedString::from(format!(
                                    "classic-project-new-chat-icon-press:{}",
                                    project.path
                                )))
                                .size(px(13.0))
                                .group_active("classic-project-new-chat-hover", |style| {
                                    style.size(px(12.22)).m(px(0.39))
                                })
                                .child(
                                    motion_icon(
                                        SharedString::from(format!(
                                            "classic-project-new-chat-icon:{}",
                                            project.path
                                        )),
                                        "icons/plus.svg",
                                        13.0,
                                        "classic-project-new-chat-hover",
                                        theme,
                                    )
                                    .size_full(),
                                ),
                        ),
                )
                .into_any_element()
        };

    let mut drawer_rows = visible
        .iter()
        .map(|session| {
            classic_session_row(
                session,
                Some(project.path.as_str()),
                selected_thread_id == Some(session.id.as_str()),
                false,
                row_state,
                theme,
                actions,
            )
        })
        .collect::<Vec<_>>();
    if has_more {
        drawer_rows.push(
            div()
                .id(SharedString::from(format!("show-project:{}", project.path)))
                .h(px(28.0))
                .w_full()
                .flex()
                .items_center()
                .pl(px(32.0))
                .pr(px(8.0))
                .rounded(px(RADIUS_MD))
                .text_size(px(12.5))
                .text_color(theme.text_3.hsla())
                .cursor_pointer()
                .hover(move |style| style.text_color(theme.text.hsla()))
                .on_click({
                    let toggle = actions.toggle_project_sessions.clone();
                    move |_event, _window, cx| toggle(show_path.clone(), cx)
                })
                .child(if show_all { "Show less" } else { "Show more" })
                .into_any_element(),
        );
    }
    let drawer = div()
        .w_full()
        .overflow_hidden()
        .h(px(if drawer_open { drawer_height } else { 0.0 }))
        .opacity(if drawer_open { 1.0 } else { 0.0 })
        .child(
            div()
                .min_h(px(0.0))
                .mt(px(1.0))
                .mb(px(4.0))
                .children(drawer_rows),
        )
        .with_animation(
            SharedString::from(format!(
                "classic-project-drawer:{}:{drawer_open}",
                project.path
            )),
            Animation::new(theme.motion_duration(std::time::Duration::from_millis(260)))
                .with_easing(crate::theme::web_ease_out),
            move |drawer, delta| {
                let (height, opacity) =
                    classic_project_drawer_state(drawer_open, drawer_height, delta);
                drawer.h(px(height)).opacity(opacity)
            },
        );

    div()
        .w_full()
        .flex()
        .flex_col()
        .mb(px(1.0))
        .child(header)
        .child(drawer)
        .into_any_element()
}

fn classic_project_drawer_height(visible_sessions: usize, has_more: bool) -> f32 {
    5.0 + visible_sessions as f32 * 28.0 + if has_more { 28.0 } else { 0.0 }
}

fn classic_project_drawer_state(open: bool, height: f32, progress: f32) -> (f32, f32) {
    let progress = progress.clamp(0.0, 1.0);
    let height_progress = if open { progress } else { 1.0 - progress };
    let opacity_progress = (progress * (260.0 / 180.0)).min(1.0);
    let opacity = if open {
        opacity_progress
    } else {
        1.0 - opacity_progress
    };
    (height * height_progress, opacity)
}

fn sidebar_inline_rename(input: &Entity<InputState>, theme: Theme, shelf: bool) -> AnyElement {
    div()
        .h(px(29.375))
        .w_full()
        .when(shelf, |rename| rename.flex_1().mx(px(4.0)).my(px(2.0)))
        .flex()
        .items_center()
        .px(px(8.0))
        .py(px(4.0))
        .rounded(px(RADIUS_MD))
        .border_1()
        .border_color(theme.line_strong.hsla())
        .bg(theme.surface_2.hsla())
        .child(
            Input::new(input)
                .xsmall()
                .appearance(false)
                .bordered(false)
                .focus_bordered(false)
                .min_w(px(0.0))
                .flex_1()
                .px(px(0.0))
                .py(px(0.0))
                .line_height(relative(1.55))
                .text_size(px(12.5))
                .text_color(theme.text.hsla()),
        )
        .into_any_element()
}

fn classic_project_menu_button(
    id: SharedString,
    request: SidebarMenuRequest,
    theme: Theme,
    open_menu: OpenSidebarMenu,
) -> AnyElement {
    let hover_group: SharedString = format!("{id}:hover").into();
    let icon_id: SharedString = format!("{id}:icon").into();
    let (trigger_bounds, bounds_probe) = sidebar_menu_trigger_probe();
    div()
        .id(id)
        .group(hover_group.clone())
        .relative()
        .size(px(26.0))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(RADIUS_SM))
        .text_color(theme.text_3.hsla())
        .opacity(0.0)
        .group_hover("classic-project", |button| button.opacity(1.0))
        .cursor_pointer()
        .hover(move |style| style.text_color(theme.text.hsla()))
        .on_click(move |event, _window, cx| {
            cx.stop_propagation();
            let anchor = trigger_bounds
                .get()
                .map(SidebarMenuAnchor::Trigger)
                .unwrap_or_else(|| SidebarMenuAnchor::Context(event.position()));
            open_menu(request.clone(), anchor, cx);
        })
        .child(bounds_probe)
        .child(motion_icon(
            icon_id,
            "icons/ellipsis.svg",
            16.0,
            hover_group,
            theme,
        ))
        .into_any_element()
}

fn sidebar_menu_trigger_probe() -> (Rc<Cell<Option<Bounds<Pixels>>>>, AnyElement) {
    let bounds = Rc::new(Cell::new(None));
    let captured_bounds = bounds.clone();
    let probe = canvas(
        move |value, _, _| captured_bounds.set(Some(value)),
        |_, _, _, _| {},
    )
    .absolute()
    .inset_0()
    .into_any_element();
    (bounds, probe)
}

fn classic_session_row(
    session: &SessionSummary,
    project_path: Option<&str>,
    active: bool,
    standalone: bool,
    row_state: SidebarRowState<'_>,
    theme: Theme,
    actions: &SidebarActions,
) -> AnyElement {
    if row_state.renaming_thread == Some(session.id.as_str()) {
        return div()
            .h(px(28.0))
            .w_full()
            .flex()
            .items_center()
            .child(sidebar_inline_rename(row_state.rename_input, theme, false))
            .into_any_element();
    }
    let thread_id = session.id.clone();
    let select_id = thread_id.clone();
    let menu_id = thread_id.clone();
    let rename_id = thread_id.clone();
    let archive_id = thread_id.clone();
    let status = status_for(session);
    let status_element = classic_session_status(status, &thread_id, theme);
    let action_background = classic_session_action_background(theme, active);
    let row = div()
        .id(SharedString::from(format!(
            "classic-session:{}",
            session.id
        )))
        .group("classic-session")
        .relative()
        .h(px(28.0))
        .w_full()
        .flex()
        .items_center()
        .rounded(px(RADIUS_MD))
        .when(active, |row| {
            row.bg(classic_session_active_background(theme))
                .shadow(classic_session_active_shadows(theme))
        })
        .hover(move |style| style.bg(classic_session_hover_background(theme, active)))
        .cursor_pointer()
        .on_click({
            let select = actions.select_session.clone();
            let open_menu = actions.open_menu.clone();
            let rename = actions.rename_thread.clone();
            move |event, _window, cx| {
                if event.is_right_click() {
                    cx.stop_propagation();
                    open_menu(
                        SidebarMenuRequest::Thread(menu_id.clone()),
                        SidebarMenuAnchor::Context(event.position()),
                        cx,
                    );
                } else if event.standard_click() {
                    if event.click_count() == 2 {
                        rename(rename_id.clone(), cx);
                    } else {
                        select(select_id.clone(), cx);
                    }
                }
            }
        })
        .when(active, |row| {
            row.child(
                div()
                    .absolute()
                    .top_0()
                    .left(px(1.0))
                    .right(px(1.0))
                    .h(px(1.0))
                    .rounded_t(px(RADIUS_MD))
                    .bg(chrome_highlight(theme)),
            )
        })
        .child(
            div()
                .h_full()
                .w_full()
                .min_w(px(0.0))
                .flex()
                .items_center()
                .gap(px(7.0))
                .pl(px(if standalone { 8.0 } else { 32.0 }))
                .pr(px(16.0))
                .text_size(px(12.5))
                .text_color(if active {
                    theme.text.hsla()
                } else {
                    theme.text_2.hsla()
                })
                .child(
                    div()
                        .min_w(px(0.0))
                        .flex_1()
                        .truncate()
                        .child(session.title.clone()),
                )
                .when_some(status_element, |row, status| row.child(status)),
        )
        .when(
            matches!(status, Status::Starting | Status::Working),
            |row| row.child(classic_session_spinner(&thread_id, theme)),
        )
        .child(
            div()
                .absolute()
                .top(px(3.0))
                .right(px(4.0))
                .h(px(22.0))
                .flex()
                .items_center()
                .gap(px(1.0))
                .pl(px(12.0))
                .opacity(0.0)
                .group_hover("classic-session", |actions| actions.opacity(1.0))
                .child(div().absolute().top_0().bottom_0().left_0().w(px(12.0)).bg(
                    linear_gradient(
                        90.0,
                        linear_color_stop(gpui::transparent_black(), 0.0),
                        linear_color_stop(action_background, 1.0),
                    ),
                ))
                .child(
                    div()
                        .absolute()
                        .top_0()
                        .right_0()
                        .bottom_0()
                        .left(px(12.0))
                        .bg(action_background),
                )
                .child(classic_session_action_button(
                    format!("rename-session:{thread_id}").into(),
                    "icons/pencil.svg",
                    13.0,
                    thread_id.clone(),
                    actions.rename_thread.clone(),
                    theme,
                ))
                .child(classic_session_action_button(
                    format!("archive-session:{thread_id}").into(),
                    "icons/archive.svg",
                    14.0,
                    archive_id,
                    actions.archive_thread.clone(),
                    theme,
                )),
        );
    if standalone {
        return row.into_any_element();
    }

    let project_path = project_path.expect("project sessions always carry their project path");
    let drag = SessionDrag {
        project_path: project_path.into(),
        session_id: thread_id.clone(),
        title: session.title.clone(),
        width: row_state.classic_row_width,
        theme,
    };
    let begin_drag = actions.begin_session_drag.clone();
    row.cursor_grab()
        .when(
            row_state.dragging_thread == Some(session.id.as_str()),
            |row| row.opacity(0.45).cursor_grabbing(),
        )
        .on_drag(drag, move |drag, _offset, window, cx| {
            begin_drag(drag.session_id.clone(), window, cx);
            cx.new(|_| SessionDragPreview(drag.clone()))
        })
        .child(classic_session_drop_zone(
            project_path,
            session.id.as_str(),
            SessionDropPosition::Before,
            theme,
            actions.reorder_session.clone(),
        ))
        .child(classic_session_drop_zone(
            project_path,
            session.id.as_str(),
            SessionDropPosition::After,
            theme,
            actions.reorder_session.clone(),
        ))
        .into_any_element()
}

fn classic_session_drop_zone(
    project_path: &str,
    target_id: &str,
    position: SessionDropPosition,
    theme: Theme,
    reorder: ReorderSession,
) -> AnyElement {
    let group: SharedString = format!(
        "session-drop:{}:{target_id}:{}",
        project_path,
        match position {
            SessionDropPosition::Before => "before",
            SessionDropPosition::After => "after",
        }
    )
    .into();
    let zone_project = project_path.to_owned();
    let zone_target = target_id.to_owned();
    let line_project = zone_project.clone();
    let line_target = zone_target.clone();
    let drop_project = zone_project.clone();
    let drop_target = zone_target.clone();

    div()
        .group(group.clone())
        .absolute()
        .left_0()
        .right_0()
        .h(relative(0.5))
        .when(position == SessionDropPosition::Before, |zone| zone.top_0())
        .when(position == SessionDropPosition::After, |zone| {
            zone.bottom_0()
        })
        .can_drop(move |value, _window, _cx| {
            value
                .downcast_ref::<SessionDrag>()
                .is_some_and(|drag| session_drop_is_valid(drag, &zone_project, &zone_target))
        })
        .on_drop(move |drag: &SessionDrag, _window, cx| {
            reorder(
                drop_project.clone(),
                drag.session_id.clone(),
                drop_target.clone(),
                position,
                cx,
            );
        })
        .child(
            div()
                .absolute()
                .left(px(26.0))
                .right(px(6.0))
                .h(px(2.0))
                .rounded_full()
                .bg(theme.text.hsla())
                .opacity(0.0)
                .when(position == SessionDropPosition::Before, |line| {
                    line.top(px(-1.0))
                })
                .when(position == SessionDropPosition::After, |line| {
                    line.bottom(px(-1.0))
                })
                .can_drop(move |value, _window, _cx| {
                    value.downcast_ref::<SessionDrag>().is_some_and(|drag| {
                        session_drop_is_valid(drag, &line_project, &line_target)
                    })
                })
                .group_drag_over::<SessionDrag>(group, |line| line.opacity(1.0)),
        )
        .into_any_element()
}

fn session_drop_is_valid(drag: &SessionDrag, project_path: &str, target_id: &str) -> bool {
    drag.project_path == project_path && drag.session_id != target_id
}

fn classic_session_active_background(theme: Theme) -> Background {
    if theme.mode == crate::theme::ThemeMode::Light {
        chrome_raised(theme)
    } else {
        theme.surface_2.hsla().into()
    }
}

fn classic_session_hover_background(theme: Theme, active: bool) -> Background {
    if active {
        classic_session_active_background(theme)
    } else {
        theme.surface.hsla().into()
    }
}

fn classic_session_active_shadows(theme: Theme) -> Vec<BoxShadow> {
    if theme.mode == crate::theme::ThemeMode::Light {
        chrome_shadows(theme)
    } else {
        Vec::new()
    }
}

fn classic_session_action_background(theme: Theme, active: bool) -> Hsla {
    match (theme.mode, active) {
        (crate::theme::ThemeMode::Light, true) => gpui::rgb(0xfafafa).into(),
        (_, true) => theme.surface_2.hsla(),
        (_, false) => theme.surface.hsla(),
    }
}

fn classic_session_status(status: Status, thread_id: &str, theme: Theme) -> Option<AnyElement> {
    let (color, id) = match status {
        Status::Queued | Status::Approval | Status::Input => (
            theme.attention.hsla(),
            format!("session-attention:{thread_id}"),
        ),
        Status::Failed => (theme.error.hsla(), format!("session-failed:{thread_id}")),
        Status::Starting | Status::Working | Status::Ready | Status::Idle => return None,
    };
    Some(
        div()
            .id(SharedString::from(id))
            .mx(px(3.0))
            .size(px(6.0))
            .flex_none()
            .rounded_full()
            .bg(color)
            .into_any_element(),
    )
}

fn classic_session_spinner(thread_id: &str, theme: Theme) -> AnyElement {
    let spinner = div()
        .absolute()
        .top(relative(0.5))
        .left(px(8.0))
        .mt(px(-7.0))
        .w(px(12.0))
        .h(px(14.0))
        .flex()
        .items_center()
        .justify_center()
        .font_family("Geist Mono")
        .text_size(px(14.0))
        .line_height(relative(1.0))
        .text_color(theme.running.hsla());
    if theme.reduced_motion {
        return spinner.child(BRAILLE_SPINNER_FRAMES[0]).into_any_element();
    }
    spinner
        .with_animation(
            SharedString::from(format!("session-spinner:{thread_id}")),
            theme.repeating_animation(std::time::Duration::from_millis(800)),
            |spinner, delta| spinner.child(BRAILLE_SPINNER_FRAMES[braille_frame_index(delta)]),
        )
        .into_any_element()
}

fn braille_frame_index(progress: f32) -> usize {
    ((progress.clamp(0.0, 0.999_999) * BRAILLE_SPINNER_FRAMES.len() as f32).floor() as usize)
        .min(BRAILLE_SPINNER_FRAMES.len() - 1)
}

fn classic_session_action_button(
    id: SharedString,
    icon_path: &'static str,
    icon_size: f32,
    thread_id: String,
    action: ProjectAction,
    theme: Theme,
) -> AnyElement {
    let hover_group: SharedString = format!("{id}:hover").into();
    let icon_id: SharedString = format!("{id}:icon").into();
    let icon_press_id: SharedString = format!("{id}:icon-press").into();
    div()
        .id(id)
        .group(hover_group.clone())
        .relative()
        .size(px(22.0))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(RADIUS_SM))
        .text_color(theme.text_3.hsla())
        .cursor_pointer()
        .hover(move |style| {
            style
                .bg(theme.surface_3.hsla())
                .text_color(theme.text.hsla())
        })
        .active(|style| style.size(px(20.68)).m(px(0.66)))
        .on_click(move |_event, _window, cx| {
            cx.stop_propagation();
            action(thread_id.clone(), cx);
        })
        .child(
            div()
                .id(icon_press_id)
                .size(px(icon_size))
                .group_active(hover_group.clone(), move |style| {
                    style.size(px(icon_size * 0.94)).m(px(icon_size * 0.03))
                })
                .child(motion_icon(icon_id, icon_path, icon_size, hover_group, theme).size_full()),
        )
        .into_any_element()
}

fn sidebar_menu_button(
    id: SharedString,
    request: SidebarMenuRequest,
    theme: Theme,
    open_menu: OpenSidebarMenu,
) -> AnyElement {
    let (trigger_bounds, bounds_probe) = sidebar_menu_trigger_probe();
    div()
        .id(id)
        .relative()
        .ml(px(4.0))
        .size(px(25.0))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(6.0))
        .text_size(px(13.0))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(theme.text_3.hsla())
        .opacity(0.62)
        .cursor_pointer()
        .hover(move |style| {
            style
                .bg(theme.surface_2.hsla())
                .text_color(theme.text.hsla())
                .opacity(1.0)
        })
        .on_click(move |event, _window, cx| {
            cx.stop_propagation();
            let anchor = trigger_bounds
                .get()
                .map(SidebarMenuAnchor::Trigger)
                .unwrap_or_else(|| SidebarMenuAnchor::Context(event.position()));
            open_menu(request.clone(), anchor, cx);
        })
        .child(bounds_probe)
        .child("•••")
        .into_any_element()
}

#[allow(clippy::too_many_arguments)]
fn scope_control(
    theme: Theme,
    projects: &[ProjectSummary],
    selected_scope: Option<&str>,
    open: bool,
    on_toggle: SidebarAction,
    on_select: SelectScope,
) -> impl IntoElement {
    let selected_name = selected_scope
        .and_then(|path| projects.iter().find(|project| project.path == path))
        .map_or_else(
            || SharedString::from("All projects"),
            |project| SharedString::from(project.name.clone()),
        );
    let all_action = on_select.clone();

    div()
        .relative()
        .min_w(px(0.0))
        .flex_1()
        .flex()
        .flex_col()
        .child(
            div()
                .id("sidebar-scope")
                .group("sidebar-scope-hover")
                .h(px(29.0))
                .w_full()
                .flex()
                .items_center()
                .min_w(px(0.0))
                .px(px(8.0))
                .rounded(px(RADIUS_MD))
                .border_1()
                .border_color(if open {
                    theme.text_3.hsla()
                } else {
                    theme.line_strong.hsla()
                })
                .bg(theme.background.hsla())
                .text_size(px(11.5))
                .text_color(theme.text_2.hsla())
                .cursor_pointer()
                .hover(move |style| {
                    style
                        .border_color(theme.text_3.hsla().opacity(0.72))
                        .text_color(theme.text.hsla())
                })
                .on_click(move |_event, _window, cx| on_toggle(cx))
                .child(
                    div()
                        .min_w(px(0.0))
                        .flex_1()
                        .truncate()
                        .child(selected_name),
                )
                .child(
                    div()
                        .ml(px(5.0))
                        .text_color(theme.text_3.hsla())
                        .child(motion_icon(
                            "sidebar-scope-icon",
                            "icons/chevron-down.svg",
                            11.0,
                            "sidebar-scope-hover",
                            theme,
                        )),
                ),
        )
        .when(open, |control| {
            control.child(
                div()
                    .id("scope-options")
                    .occlude()
                    .absolute()
                    .top(px(33.0))
                    .left(px(0.0))
                    .right(px(0.0))
                    .max_h(px(220.0))
                    .overflow_y_scroll()
                    .rounded(px(8.0))
                    .border_1()
                    .border_color(theme.line_strong.hsla())
                    .bg(theme.surface_2.hsla())
                    .p(px(4.0))
                    .child(scope_option(
                        "scope:all".into(),
                        "All projects".into(),
                        selected_scope.is_none(),
                        theme,
                        Rc::new(move |cx| all_action(None, cx)),
                    ))
                    .children(projects.iter().map(|project| {
                        let path = project.path.clone();
                        let option_action = on_select.clone();
                        scope_option(
                            format!("scope:{}", project.path).into(),
                            project.name.clone().into(),
                            selected_scope == Some(project.path.as_str()),
                            theme,
                            Rc::new(move |cx| option_action(Some(path.clone()), cx)),
                        )
                    })),
            )
        })
}

fn scope_option(
    id: SharedString,
    label: SharedString,
    selected: bool,
    theme: Theme,
    action: SidebarAction,
) -> impl IntoElement {
    let hover_group: SharedString = format!("{id}:hover").into();
    let icon_id: SharedString = format!("{id}:icon").into();
    div()
        .id(id)
        .group(hover_group.clone())
        .h(px(29.0))
        .w_full()
        .flex()
        .items_center()
        .px(px(7.0))
        .rounded(px(6.0))
        .when(selected, |item| item.bg(theme.surface_3.hsla()))
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
        .on_click(move |_event, _window, cx| action(cx))
        .child(div().min_w(px(0.0)).flex_1().truncate().child(label))
        .when(selected, |item| {
            item.child(motion_icon(
                icon_id,
                "icons/check.svg",
                11.0,
                hover_group,
                theme,
            ))
        })
}

fn section_label(label: SharedString, theme: Theme) -> impl IntoElement {
    div()
        .h(px(31.0))
        .flex()
        .items_end()
        .px(px(8.0))
        .pb(px(7.0))
        .text_size(px(11.5))
        .font_weight(FontWeight::MEDIUM)
        .text_color(theme.text_3.hsla())
        .child(label)
}

fn section_heading(label: &'static str, count: usize, theme: Theme) -> impl IntoElement {
    div()
        .flex()
        .items_center()
        .justify_between()
        .px(px(8.0))
        .pt(px(3.0))
        .pb(px(5.0))
        .text_size(px(11.5))
        .font_weight(FontWeight::MEDIUM)
        .text_color(theme.text_3.hsla())
        .child(label)
        .child(count.to_string())
}

#[derive(Clone)]
struct RowNavigation {
    current: FocusHandle,
    previous: FocusHandle,
    next: FocusHandle,
}

fn row_navigation(
    thread_id: &str,
    ordered_ids: &[String],
    row_focus: &HashMap<String, FocusHandle>,
) -> Option<RowNavigation> {
    let index = ordered_ids.iter().position(|id| id == thread_id)?;
    let count = ordered_ids.len();
    if count == 0 {
        return None;
    }
    let previous_id = &ordered_ids[(index + count - 1) % count];
    let next_id = &ordered_ids[(index + 1) % count];
    Some(RowNavigation {
        current: row_focus.get(thread_id)?.clone(),
        previous: row_focus.get(previous_id)?.clone(),
        next: row_focus.get(next_id)?.clone(),
    })
}

fn thread_menu_request(
    thread_id: &str,
    selected_ids: &std::collections::HashSet<String>,
    ordered_ids: &[String],
) -> SidebarMenuRequest {
    let thread_ids = if selected_ids.len() > 1 && selected_ids.contains(thread_id) {
        ordered_ids
            .iter()
            .filter(|id| selected_ids.contains(id.as_str()))
            .cloned()
            .collect()
    } else {
        vec![thread_id.to_owned()]
    };
    SidebarMenuRequest::ThreadSelection {
        target: thread_id.to_owned(),
        thread_ids,
    }
}

fn navigate_row(
    event: &KeyDownEvent,
    window: &mut Window,
    cx: &mut App,
    previous: &FocusHandle,
    next: &FocusHandle,
) {
    if event.keystroke.key.eq_ignore_ascii_case("down") {
        cx.stop_propagation();
        next.focus(window);
    } else if event.keystroke.key.eq_ignore_ascii_case("up") {
        cx.stop_propagation();
        previous.focus(window);
    }
}

#[derive(Clone, Copy)]
enum Status {
    Starting,
    Working,
    Queued,
    Approval,
    Input,
    Ready,
    Failed,
    Idle,
}

impl Status {
    fn label(self) -> &'static str {
        match self {
            Self::Starting => "Starting",
            Self::Working => "Working",
            Self::Queued => "Queued",
            Self::Approval => "Approval",
            Self::Input => "Input",
            Self::Ready => "Ready",
            Self::Failed => "Failed",
            Self::Idle => "Idle",
        }
    }

    fn color(self, theme: Theme) -> Hsla {
        match self {
            Self::Starting | Self::Working => theme.running.hsla(),
            Self::Queued | Self::Idle => theme.text_3.hsla(),
            Self::Approval | Self::Input => theme.attention.hsla(),
            Self::Ready => theme.success.hsla(),
            Self::Failed => theme.error.hsla(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StatusTone {
    Quiet,
    Working,
    Attention,
    Failed,
    Done,
    Woke,
}

struct StatusPresentation {
    label: String,
    tone: StatusTone,
}

#[allow(clippy::too_many_arguments)]
fn active_inbox_row(
    project: &ProjectSummary,
    session: &SessionSummary,
    status_since: f64,
    now: f64,
    theme: Theme,
    current: bool,
    multi_selected: bool,
    menu_request: SidebarMenuRequest,
    navigation: Option<RowNavigation>,
    row_state: SidebarRowState<'_>,
    actions: &SidebarActions,
) -> AnyElement {
    if row_state.renaming_thread == Some(session.id.as_str()) {
        return div()
            .min_h(px(76.0))
            .w_full()
            .border_1()
            .border_color(gpui::transparent_black())
            .rounded(px(RADIUS_MD))
            .bg(chrome_raised(theme))
            .shadow(chrome_shadows(theme))
            .child(sidebar_inline_rename(row_state.rename_input, theme, false))
            .into_any_element();
    }
    let thread_id = session.id.clone();
    let select_id = thread_id.clone();
    let context_id = thread_id.clone();
    let context_request = menu_request.clone();
    let context_menu = actions.open_menu.clone();
    let choose = actions.choose_session.clone();
    let begin_rename = actions.rename_thread.clone();
    let settle = actions.settle_thread.clone();
    let status = status_presentation(session, status_since, now);
    let eligible = can_hide_session(session);
    let normalized_status = status_for(session);
    let woke_after_activity = matches!(
        session.lifecycle.as_ref(),
        Some(ThreadLifecycle::Active {
            woke_at: Some(_),
            ..
        })
    ) && !matches!(normalized_status, Status::Idle);
    let branch = session.worktree_branch.clone();
    let provider = inbox_provider_name(session);
    let pinned = session.pinned;
    let chrome_border = chrome_border(theme);

    div()
        .id(SharedString::from(format!("inbox:{thread_id}")))
        .group("inbox-card")
        .relative()
        .min_h(px(76.0))
        .w_full()
        .border_1()
        .border_color(if multi_selected {
            theme
                .attention
                .mix_oklab(chrome_border_token(theme), 0.35)
                .hsla()
        } else if current {
            chrome_border
        } else {
            gpui::transparent_black()
        })
        .rounded(px(RADIUS_MD))
        .when(current || multi_selected, |card| {
            card.bg(inbox_card_background(theme, multi_selected))
                .shadow(chrome_shadows(theme))
        })
        .hover(move |style| {
            style
                .bg(inbox_card_background(theme, multi_selected))
                .shadow(chrome_shadows(theme))
        })
        .child(
            div()
                .absolute()
                .top(px(0.0))
                .left(px(1.0))
                .right(px(1.0))
                .h(px(1.0))
                .rounded_t(px(RADIUS_MD))
                .bg(chrome_highlight(theme))
                .opacity(if current || multi_selected { 1.0 } else { 0.0 })
                .group_hover("inbox-card", |line| line.opacity(1.0)),
        )
        .child(
            div()
                .id(SharedString::from(format!("inbox-main:{thread_id}")))
                .w_full()
                .min_w(px(0.0))
                .flex()
                .flex_col()
                .gap(px(5.0))
                .pt(px(8.0))
                .px(px(9.0))
                .pb(px(9.0))
                .cursor_pointer()
                .on_click(move |event, _window, cx| {
                    if event.is_right_click() {
                        cx.stop_propagation();
                        context_menu(
                            context_request.clone(),
                            SidebarMenuAnchor::Context(event.position()),
                            cx,
                        );
                    } else if event.standard_click() {
                        if event.click_count() == 2 {
                            cx.stop_propagation();
                            begin_rename(context_id.clone(), cx);
                            return;
                        }
                        let modifiers = event.modifiers();
                        choose(
                            select_id.clone(),
                            SelectionModifiers {
                                shift: modifiers.shift,
                                additive: modifiers.platform || modifiers.control,
                            },
                            cx,
                        );
                    }
                })
                .when_some(navigation, |main, navigation| {
                    let previous = navigation.previous.clone();
                    let next = navigation.next.clone();
                    main.track_focus(&navigation.current)
                        .tab_index(0)
                        .on_key_down(move |event, window, cx| {
                            navigate_row(event, window, cx, &previous, &next);
                        })
                })
                .child(
                    div()
                        .w_full()
                        .min_w(px(0.0))
                        .flex()
                        .items_center()
                        .justify_between()
                        .gap(px(8.0))
                        .child(
                            div()
                                .min_w(px(0.0))
                                .truncate()
                                .text_size(px(10.5))
                                .font_weight(FontWeight(520.0))
                                .text_color(theme.text_3.hsla())
                                .child(project.name.clone()),
                        )
                        .child(
                            status_badge(status, theme)
                                .group_hover("inbox-card", |badge| badge.opacity(0.0)),
                        ),
                )
                .child(
                    div()
                        .w_full()
                        .truncate()
                        .text_size(px(11.5))
                        .font_weight(FontWeight(530.0))
                        .line_height(relative(1.2))
                        .text_color(theme.text.hsla())
                        .child(session.title.clone()),
                )
                .child(
                    div()
                        .max_w(relative(0.99))
                        .min_w(px(0.0))
                        .flex()
                        .items_center()
                        .gap(px(5.0))
                        .overflow_hidden()
                        .text_size(px(11.5))
                        .text_color(theme.text_3.hsla())
                        .child(if let Some(branch) = branch {
                            div()
                                .max_w(relative(0.52))
                                .min_w(px(0.0))
                                .flex()
                                .items_center()
                                .gap(px(3.0))
                                .truncate()
                                .child(motion_icon(
                                    SharedString::from(format!("inbox-branch-icon:{thread_id}")),
                                    "icons/git-branch.svg",
                                    10.0,
                                    "inbox-card",
                                    theme,
                                ))
                                .child(branch)
                                .into_any_element()
                        } else {
                            div()
                                .flex_none()
                                .child("Default checkout")
                                .into_any_element()
                        })
                        .child(div().flex_none().child("·"))
                        .child(div().flex_none().child(provider))
                        .when(pinned, |meta| {
                            meta.child(div().flex_none().child("·"))
                                .child(div().flex_none().child("Pinned"))
                        })
                        .when(woke_after_activity, |meta| {
                            meta.child(
                                div()
                                    .ml_auto()
                                    .flex_none()
                                    .text_color(theme.attention.hsla())
                                    .child("Woke"),
                            )
                        }),
                ),
        )
        .child(
            div()
                .absolute()
                .top(px(5.0))
                .right(px(6.0))
                .min_h(px(25.0))
                .flex()
                .items_center()
                .gap(px(1.0))
                .pl(px(8.0))
                .bg(inbox_card_background(theme, multi_selected))
                .opacity(0.0)
                .group_hover("inbox-card", |quick| quick.opacity(1.0))
                .when(eligible, |quick| {
                    quick
                        .child(inbox_quick_menu_button(
                            format!("snooze-menu:{thread_id}").into(),
                            "icons/clock-3.svg",
                            SidebarMenuRequest::Snooze(thread_id.clone()),
                            theme,
                            actions.open_menu.clone(),
                        ))
                        .child(inbox_quick_action_button(
                            format!("settle:{thread_id}").into(),
                            "icons/check-check.svg",
                            theme,
                            Rc::new({
                                let id = thread_id.clone();
                                move |cx| settle(id.clone(), cx)
                            }),
                        ))
                })
                .child(inbox_quick_menu_button(
                    format!("inbox-menu:{thread_id}").into(),
                    "icons/ellipsis.svg",
                    menu_request,
                    theme,
                    actions.open_menu.clone(),
                )),
        )
        .into_any_element()
}

fn status_badge(status: StatusPresentation, theme: Theme) -> gpui::Stateful<gpui::Div> {
    let color = match status.tone {
        StatusTone::Quiet => theme.text_3.hsla(),
        StatusTone::Working => theme.running.hsla(),
        StatusTone::Attention | StatusTone::Woke => theme.attention.hsla(),
        StatusTone::Failed => theme.error.hsla(),
        StatusTone::Done => theme.success.hsla(),
    };
    div()
        .id(SharedString::from(format!("inbox-status:{}", status.label)))
        .flex_none()
        .px(px(5.0))
        .py(px(1.0))
        .rounded(px(99.0))
        .when(
            matches!(
                status.tone,
                StatusTone::Attention | StatusTone::Failed | StatusTone::Done | StatusTone::Woke
            ),
            |badge| badge.bg(color.opacity(0.10)),
        )
        .text_size(px(10.5))
        .font_weight(FontWeight(520.0))
        .text_color(color)
        .child(status.label)
}

fn status_presentation(
    session: &SessionSummary,
    status_since: f64,
    now: f64,
) -> StatusPresentation {
    let status = status_for(session);
    let woke = matches!(
        session.lifecycle.as_ref(),
        Some(ThreadLifecycle::Active {
            woke_at: Some(_),
            ..
        })
    );
    match status {
        Status::Approval => StatusPresentation {
            label: "Approval".into(),
            tone: StatusTone::Attention,
        },
        Status::Input => StatusPresentation {
            label: "Needs input".into(),
            tone: StatusTone::Attention,
        },
        Status::Failed => StatusPresentation {
            label: "Failed".into(),
            tone: StatusTone::Failed,
        },
        Status::Ready => StatusPresentation {
            label: "Done".into(),
            tone: StatusTone::Done,
        },
        Status::Queued => StatusPresentation {
            label: "Queued".into(),
            tone: StatusTone::Attention,
        },
        Status::Starting | Status::Working => StatusPresentation {
            label: format!("Working · {}", elapsed_time(status_since, now)),
            tone: StatusTone::Working,
        },
        Status::Idle if woke => StatusPresentation {
            label: "Woke".into(),
            tone: StatusTone::Woke,
        },
        Status::Idle => StatusPresentation {
            label: relative_time_at(status_since, now),
            tone: StatusTone::Quiet,
        },
    }
}

fn can_hide_session(session: &SessionSummary) -> bool {
    !session.running
        && !matches!(
            status_for(session),
            Status::Starting | Status::Working | Status::Queued | Status::Approval | Status::Input
        )
}

fn inbox_provider_name(session: &SessionSummary) -> String {
    match session.provider {
        ProviderId::ClaudeCode => "Claude Code".into(),
        ProviderId::Acp => session.agent.clone().unwrap_or_else(|| "Agent".into()),
        ProviderId::Codex => "Codex".into(),
        ProviderId::OpenCode => "OpenCode".into(),
        ProviderId::Antigravity => "Antigravity".into(),
        ProviderId::Grok => "grok".into(),
        ProviderId::Cursor => "cursor".into(),
        ProviderId::Api => "api".into(),
    }
}

fn inbox_quick_action_button(
    id: SharedString,
    icon_path: &'static str,
    theme: Theme,
    action: SidebarAction,
) -> AnyElement {
    let hover_group: SharedString = format!("{id}:hover").into();
    let icon_id: SharedString = format!("{id}:icon").into();
    div()
        .id(id)
        .group(hover_group.clone())
        .size(px(23.0))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(3.0))
        .text_color(theme.text_3.hsla())
        .cursor_pointer()
        .hover(move |style| {
            style
                .bg(theme.surface_3.hsla())
                .text_color(theme.text.hsla())
        })
        .on_click(move |_event, _window, cx| {
            cx.stop_propagation();
            action(cx);
        })
        .child(motion_icon(icon_id, icon_path, 13.0, hover_group, theme))
        .into_any_element()
}

fn inbox_quick_menu_button(
    id: SharedString,
    icon_path: &'static str,
    request: SidebarMenuRequest,
    theme: Theme,
    open_menu: OpenSidebarMenu,
) -> AnyElement {
    let hover_group: SharedString = format!("{id}:hover").into();
    let icon_id: SharedString = format!("{id}:icon").into();
    let (trigger_bounds, bounds_probe) = sidebar_menu_trigger_probe();
    div()
        .id(id)
        .group(hover_group.clone())
        .relative()
        .size(px(23.0))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(3.0))
        .text_color(theme.text_3.hsla())
        .cursor_pointer()
        .hover(move |style| {
            style
                .bg(theme.surface_3.hsla())
                .text_color(theme.text.hsla())
        })
        .on_click(move |event, _window, cx| {
            cx.stop_propagation();
            let anchor = trigger_bounds
                .get()
                .map(SidebarMenuAnchor::Trigger)
                .unwrap_or_else(|| SidebarMenuAnchor::Context(event.position()));
            open_menu(request.clone(), anchor, cx);
        })
        .child(bounds_probe)
        .child(motion_icon(icon_id, icon_path, 13.0, hover_group, theme))
        .into_any_element()
}

fn chrome_raised(theme: Theme) -> Background {
    let (from, to): (Hsla, Hsla) = if theme.mode == crate::theme::ThemeMode::Dark {
        (gpui::rgb(0x242424).into(), gpui::rgb(0x1b1b1b).into())
    } else {
        (gpui::white(), gpui::rgb(0xfafafa).into())
    };
    linear_gradient(
        180.0,
        linear_color_stop(from, 0.0),
        linear_color_stop(to, 1.0),
    )
}

fn inbox_card_background(theme: Theme, multi_selected: bool) -> Background {
    if !multi_selected {
        return chrome_raised(theme);
    }
    let (from, to) = if theme.mode == crate::theme::ThemeMode::Dark {
        (ColorToken(0x242424), ColorToken(0x1b1b1b))
    } else {
        (ColorToken(0xffffff), ColorToken(0xfafafa))
    };
    linear_gradient(
        180.0,
        linear_color_stop(theme.attention.mix_oklab(from, 0.07).hsla(), 0.0),
        linear_color_stop(theme.attention.mix_oklab(to, 0.07).hsla(), 1.0),
    )
}

fn chrome_border(theme: Theme) -> Hsla {
    chrome_border_token(theme).hsla()
}

fn chrome_border_token(theme: Theme) -> ColorToken {
    if theme.mode == crate::theme::ThemeMode::Dark {
        ColorToken(0x303030)
    } else {
        ColorToken(0xe3e3e6)
    }
}

fn chrome_highlight(theme: Theme) -> Hsla {
    if theme.mode == crate::theme::ThemeMode::Dark {
        gpui::white().opacity(0.05)
    } else {
        gpui::white().opacity(0.96)
    }
}

fn account_trigger_top_highlight(theme: Theme) -> AnyElement {
    div()
        .id("account-trigger-highlight")
        .absolute()
        .top_0()
        .left_0()
        .right_0()
        .h(px(1.0))
        .bg(chrome_highlight(theme))
        .group_active("account-trigger", |highlight| highlight.opacity(0.0))
        .into_any_element()
}

fn account_trigger_inset_shade(theme: Theme) -> AnyElement {
    let (from, to): (Hsla, Hsla) = match theme.mode {
        ThemeMode::Dark => (gpui::black().opacity(0.34), gpui::transparent_black()),
        ThemeMode::Light => (gpui::rgba(0x18181b14).into(), gpui::transparent_black()),
    };
    div()
        .id("account-trigger-inset")
        .absolute()
        .top_0()
        .left_0()
        .right_0()
        .h(px(3.0))
        .bg(linear_gradient(
            180.0,
            linear_color_stop(from, 0.0),
            linear_color_stop(to, 1.0),
        ))
        .opacity(0.0)
        .group_active("account-trigger", |shade| shade.opacity(1.0))
        .into_any_element()
}

fn chrome_shadows(theme: Theme) -> Vec<BoxShadow> {
    if theme.mode == crate::theme::ThemeMode::Dark {
        vec![BoxShadow {
            color: gpui::black().opacity(0.28),
            offset: point(px(0.0), px(1.0)),
            blur_radius: px(2.0),
            spread_radius: px(0.0),
        }]
    } else {
        vec![
            BoxShadow {
                color: gpui::rgba(0x18181b14).into(),
                offset: point(px(0.0), px(1.0)),
                blur_radius: px(2.0),
                spread_radius: px(0.0),
            },
            BoxShadow {
                color: gpui::rgba(0x18181b29).into(),
                offset: point(px(0.0), px(4.0)),
                blur_radius: px(10.0),
                spread_radius: px(-8.0),
            },
        ]
    }
}

#[allow(clippy::too_many_arguments)]
fn inbox_row(
    thread_id: SharedString,
    title: SharedString,
    meta: SharedString,
    status: Status,
    theme: Theme,
    active: bool,
    on_select: Option<SelectSession>,
    open_menu: Option<OpenSidebarMenu>,
    settle: Option<ProjectAction>,
) -> impl IntoElement {
    let status_color = status.color(theme);
    let event_thread_id = thread_id.clone();
    let context_thread_id = thread_id.clone();
    let context_menu = open_menu.clone();
    let can_hide = matches!(status, Status::Ready | Status::Failed | Status::Idle);
    let settle_hover_group: SharedString = format!("settle-hover:{thread_id}").into();
    let settle_icon_id: SharedString = format!("settle-icon:{thread_id}").into();
    div()
        .id(SharedString::from(format!("inbox:{thread_id}")))
        .min_h(px(64.0))
        .w_full()
        .flex()
        .flex_col()
        .justify_center()
        .px(px(8.0))
        .rounded(px(8.0))
        .when(active, |row| row.bg(theme.surface_2.hsla()))
        .cursor_pointer()
        .hover(move |style| style.bg(theme.surface.hsla()))
        .on_click(move |event, _window, cx| {
            if event.is_right_click() {
                if let Some(open_menu) = &context_menu {
                    cx.stop_propagation();
                    open_menu(
                        SidebarMenuRequest::Thread(context_thread_id.to_string()),
                        SidebarMenuAnchor::Context(event.position()),
                        cx,
                    );
                }
            } else if event.standard_click()
                && let Some(handler) = &on_select
            {
                handler(event_thread_id.to_string(), cx);
            }
        })
        .child(
            div()
                .w_full()
                .flex()
                .items_center()
                .child(
                    div()
                        .flex_1()
                        .truncate()
                        .text_size(px(12.5))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(theme.response_text.hsla())
                        .child(title),
                )
                .when_some(
                    can_hide.then_some((open_menu.clone(), settle)),
                    |line, (open_menu, settle)| {
                        line.when_some(open_menu, |line, open_menu| {
                            line.child(sidebar_menu_button(
                                format!("snooze-menu:{thread_id}").into(),
                                SidebarMenuRequest::Snooze(thread_id.to_string()),
                                theme,
                                open_menu,
                            ))
                        })
                        .when_some(settle, |line, settle| {
                            let id = thread_id.to_string();
                            line.child(
                                div()
                                    .id(SharedString::from(format!("settle:{thread_id}")))
                                    .group(settle_hover_group.clone())
                                    .ml(px(2.0))
                                    .size(px(25.0))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .rounded(px(6.0))
                                    .text_color(theme.text_3.hsla())
                                    .cursor_pointer()
                                    .hover(move |style| {
                                        style
                                            .bg(theme.surface_2.hsla())
                                            .text_color(theme.text.hsla())
                                    })
                                    .on_click(move |_event, _window, cx| {
                                        cx.stop_propagation();
                                        settle(id.clone(), cx);
                                    })
                                    .child(motion_icon(
                                        settle_icon_id,
                                        "icons/check.svg",
                                        11.0,
                                        settle_hover_group,
                                        theme,
                                    )),
                            )
                        })
                    },
                )
                .when_some(open_menu, |line, open_menu| {
                    line.child(sidebar_menu_button(
                        format!("inbox-menu:{thread_id}").into(),
                        SidebarMenuRequest::Thread(thread_id.to_string()),
                        theme,
                        open_menu,
                    ))
                })
                .child(
                    div()
                        .ml(px(6.0))
                        .px(px(5.0))
                        .h(px(18.0))
                        .flex()
                        .items_center()
                        .rounded(px(9.0))
                        .bg(status_color.opacity(0.12))
                        .text_color(status_color)
                        .text_size(px(10.5))
                        .font_weight(FontWeight::MEDIUM)
                        .child(status.label()),
                ),
        )
        .child(
            div()
                .mt(px(5.0))
                .truncate()
                .text_size(px(11.5))
                .text_color(theme.text_3.hsla())
                .child(meta),
        )
}

fn collapsed_group(
    label: SharedString,
    count: Option<SharedString>,
    expanded: bool,
    theme: Theme,
    action: Option<SidebarAction>,
) -> impl IntoElement {
    let id = SharedString::from(format!("sidebar-group:{label}"));
    let animation_id = SharedString::from(format!("sidebar-group-chevron:{label}:{expanded}"));
    let hover_group: SharedString = format!("sidebar-group-hover:{label}").into();
    let icon_id: SharedString = format!("sidebar-group-chevron-icon:{label}").into();
    let chevron = motion_icon(
        icon_id,
        "icons/chevron-right.svg",
        11.0,
        hover_group.clone(),
        theme,
    )
    .with_animation(
        animation_id,
        Animation::new(theme.motion.fast).with_easing(crate::theme::web_ease_out),
        move |icon, delta| {
            let rotation_degrees = if expanded {
                delta * 90.0
            } else {
                (1.0 - delta) * 90.0
            };
            icon.with_transformation(IconTransformation::rotate(rotation_degrees))
        },
    );
    div()
        .mt(px(5.0))
        .w_full()
        .border_t_1()
        .border_color(theme.line.hsla())
        .pt(px(3.0))
        .child(
            div()
                .id(id)
                .group(hover_group)
                .w_full()
                .flex()
                .items_center()
                .gap(px(6.0))
                .px(px(8.0))
                .py(px(5.0))
                .rounded(px(RADIUS_MD))
                .text_color(theme.text_3.hsla())
                .text_size(px(11.5))
                .when(action.is_some(), |row| {
                    row.cursor_pointer().hover(move |style| {
                        style
                            .bg(theme.surface.hsla())
                            .text_color(theme.text_2.hsla())
                    })
                })
                .when_some(action, |row, action| {
                    row.on_click(move |_event, _window, cx| action(cx))
                })
                .child(chevron)
                .child(div().flex_1().child(label))
                .when_some(count, |row, count| row.child(count)),
        )
}

#[allow(clippy::too_many_arguments)]
fn inbox_shelf_row(
    session: &SessionSummary,
    detail: String,
    action_icon: &'static str,
    theme: Theme,
    current: bool,
    multi_selected: bool,
    menu_request: SidebarMenuRequest,
    navigation: Option<RowNavigation>,
    direct_action: ProjectAction,
    row_state: SidebarRowState<'_>,
    actions: &SidebarActions,
) -> AnyElement {
    let thread_id = session.id.clone();
    let choose_id = thread_id.clone();
    let rename_id = thread_id.clone();
    let context_request = menu_request.clone();
    let choose = actions.choose_session.clone();
    let begin_rename = actions.rename_thread.clone();
    let open_context_menu = actions.open_menu.clone();
    let action_id = thread_id.clone();
    let row_background = if multi_selected {
        theme.attention.mix_oklab(theme.surface, 0.07).hsla()
    } else {
        theme.surface.hsla()
    };
    let renaming = row_state.renaming_thread == Some(session.id.as_str());

    div()
        .id(SharedString::from(format!("shelf:{thread_id}")))
        .group("inbox-shelf-row")
        .min_h(px(30.0))
        .min_w(px(0.0))
        .w_full()
        .flex()
        .items_center()
        .gap(px(1.0))
        .border_1()
        .border_color(if multi_selected {
            theme.attention.hsla().opacity(0.30)
        } else {
            gpui::transparent_black()
        })
        .rounded(px(RADIUS_MD))
        .when(current || multi_selected, |row| row.bg(row_background))
        .hover(move |style| style.bg(row_background))
        .child(if renaming {
            sidebar_inline_rename(row_state.rename_input, theme, true)
        } else {
            div()
                .id(SharedString::from(format!("shelf-main:{thread_id}")))
                .min_w(px(0.0))
                .flex_1()
                .flex()
                .items_baseline()
                .gap(px(7.0))
                .px(px(8.0))
                .py(px(6.0))
                .text_size(px(11.5))
                .text_color(theme.text_2.hsla())
                .cursor_pointer()
                .on_click(move |event, _window, cx| {
                    if event.is_right_click() {
                        cx.stop_propagation();
                        open_context_menu(
                            context_request.clone(),
                            SidebarMenuAnchor::Context(event.position()),
                            cx,
                        );
                    } else if event.standard_click() {
                        if event.click_count() == 2 {
                            cx.stop_propagation();
                            begin_rename(rename_id.clone(), cx);
                            return;
                        }
                        let modifiers = event.modifiers();
                        choose(
                            choose_id.clone(),
                            SelectionModifiers {
                                shift: modifiers.shift,
                                additive: modifiers.platform || modifiers.control,
                            },
                            cx,
                        );
                    }
                })
                .when_some(navigation, |main, navigation| {
                    let previous = navigation.previous.clone();
                    let next = navigation.next.clone();
                    main.track_focus(&navigation.current)
                        .tab_index(0)
                        .on_key_down(move |event, window, cx| {
                            navigate_row(event, window, cx, &previous, &next);
                        })
                })
                .child(
                    div()
                        .min_w(px(0.0))
                        .flex_1()
                        .truncate()
                        .child(session.title.clone()),
                )
                .child(
                    div()
                        .max_w(relative(0.45))
                        .flex_none()
                        .truncate()
                        .text_size(px(10.5))
                        .text_color(theme.text_3.hsla())
                        .child(detail),
                )
                .into_any_element()
        })
        .child(inbox_quick_action_button(
            format!("shelf-action:{thread_id}").into(),
            action_icon,
            theme,
            Rc::new(move |cx| direct_action(action_id.clone(), cx)),
        ))
        .when(!renaming, |row| {
            row.child(
                div()
                    .opacity(0.0)
                    .group_hover("inbox-shelf-row", |menu| menu.opacity(1.0))
                    .child(inbox_quick_menu_button(
                        format!("shelf-menu:{thread_id}").into(),
                        "icons/ellipsis.svg",
                        menu_request,
                        theme,
                        actions.open_menu.clone(),
                    )),
            )
        })
        .into_any_element()
}

fn settled_row(
    thread_id: SharedString,
    title: SharedString,
    meta: SharedString,
    theme: Theme,
    active: bool,
    on_select: Option<SelectSession>,
    open_menu: Option<OpenSidebarMenu>,
) -> impl IntoElement {
    let event_thread_id = thread_id.clone();
    let context_thread_id = thread_id.clone();
    let context_menu = open_menu.clone();
    let hover_group: SharedString = format!("settled-hover:{thread_id}").into();
    let icon_id: SharedString = format!("settled-icon:{thread_id}").into();
    div()
        .id(SharedString::from(format!("settled:{thread_id}")))
        .group(hover_group.clone())
        .min_h(px(44.0))
        .w_full()
        .flex()
        .items_center()
        .px(px(8.0))
        .rounded(px(8.0))
        .when(active, |row| row.bg(theme.surface_2.hsla()))
        .cursor_pointer()
        .hover(move |style| style.bg(theme.surface.hsla()))
        .on_click(move |event, _window, cx| {
            if event.is_right_click() {
                if let Some(open_menu) = &context_menu {
                    cx.stop_propagation();
                    open_menu(
                        SidebarMenuRequest::Thread(context_thread_id.to_string()),
                        SidebarMenuAnchor::Context(event.position()),
                        cx,
                    );
                }
            } else if event.standard_click()
                && let Some(handler) = &on_select
            {
                handler(event_thread_id.to_string(), cx);
            }
        })
        .child(
            div()
                .min_w(px(0.0))
                .flex_1()
                .flex()
                .flex_col()
                .child(
                    div()
                        .truncate()
                        .text_size(px(11.5))
                        .text_color(theme.text_2.hsla())
                        .child(title),
                )
                .child(
                    div()
                        .mt(px(2.0))
                        .truncate()
                        .text_size(px(10.5))
                        .text_color(theme.text_3.hsla())
                        .child(meta),
                ),
        )
        .child(
            div()
                .ml(px(6.0))
                .text_color(theme.text_3.hsla())
                .child(motion_icon(
                    icon_id,
                    "icons/check.svg",
                    11.0,
                    hover_group,
                    theme,
                )),
        )
        .when_some(open_menu, |row, open_menu| {
            row.child(sidebar_menu_button(
                format!("shelf-menu:{thread_id}").into(),
                SidebarMenuRequest::Thread(thread_id.to_string()),
                theme,
                open_menu,
            ))
        })
}

fn show_more_settled(theme: Theme, action: SidebarAction) -> impl IntoElement {
    div()
        .id("show-more-settled")
        .h(px(30.0))
        .flex()
        .items_center()
        .px(px(8.0))
        .rounded(px(RADIUS_MD))
        .text_size(px(11.5))
        .text_color(theme.text_3.hsla())
        .cursor_pointer()
        .hover(move |style| style.bg(theme.surface.hsla()).text_color(theme.text.hsla()))
        .on_click(move |_event, _window, cx| action(cx))
        .child("Show 25 more")
}

fn empty_state(label: SharedString, theme: Theme) -> impl IntoElement {
    div()
        .px(px(8.0))
        .py(px(18.0))
        .text_size(px(11.5))
        .text_color(theme.text_3.hsla())
        .child(label)
}

fn status_for(session: &SessionSummary) -> Status {
    match session.status.unwrap_or(if session.running {
        ThreadInboxStatus::Working
    } else {
        ThreadInboxStatus::Idle
    }) {
        ThreadInboxStatus::Starting => Status::Starting,
        ThreadInboxStatus::Working => Status::Working,
        ThreadInboxStatus::Queued => Status::Queued,
        ThreadInboxStatus::Approval => Status::Approval,
        ThreadInboxStatus::Input => Status::Input,
        ThreadInboxStatus::Failed => Status::Failed,
        ThreadInboxStatus::Ready => Status::Ready,
        ThreadInboxStatus::Idle => Status::Idle,
    }
}

fn newest_first(left: &SessionSummary, right: &SessionSummary) -> std::cmp::Ordering {
    right
        .created_at
        .partial_cmp(&left.created_at)
        .unwrap_or(std::cmp::Ordering::Equal)
}

pub(crate) fn ordered_inbox_ids(
    projects: &[ProjectSummary],
    selected_scope: Option<&str>,
    query: &str,
) -> Vec<String> {
    let normalized_query = query.trim().to_lowercase();
    let mut active = Vec::new();
    let mut snoozed = Vec::new();
    let mut settled = Vec::new();
    for project in projects {
        if selected_scope.is_some_and(|scope| scope != project.path) {
            continue;
        }
        for session in &project.sessions {
            if !title_matches_query(&session.title, &normalized_query) {
                continue;
            }
            match session.lifecycle.as_ref() {
                Some(ThreadLifecycle::Snoozed { .. }) => snoozed.push(session),
                Some(ThreadLifecycle::Settled { .. }) => settled.push(session),
                Some(ThreadLifecycle::Active { .. }) | None => active.push(session),
            }
        }
    }
    active.sort_by(|left, right| newest_first(left, right));
    snoozed.sort_by_key(|session| wake_at(session).unwrap_or(u64::MAX));
    settled.sort_by(|left, right| {
        settled_at(right)
            .unwrap_or(right.created_at)
            .partial_cmp(&settled_at(left).unwrap_or(left.created_at))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    active
        .into_iter()
        .chain(snoozed)
        .chain(settled)
        .map(|session| session.id.clone())
        .collect()
}

fn title_matches_query(title: &str, normalized_query: &str) -> bool {
    normalized_query.is_empty() || title.to_lowercase().contains(normalized_query)
}

fn settled_at(session: &SessionSummary) -> Option<f64> {
    match session.lifecycle.as_ref() {
        Some(ThreadLifecycle::Settled { settled_at, .. }) => Some(*settled_at as f64),
        _ => None,
    }
}

fn wake_at(session: &SessionSummary) -> Option<u64> {
    match session.lifecycle.as_ref() {
        Some(ThreadLifecycle::Snoozed { wake_at, .. }) => Some(*wake_at),
        _ => None,
    }
}

fn format_wake_time(session: &SessionSummary, now: f64) -> String {
    let Some(ThreadLifecycle::Snoozed { wake_at, .. }) = session.lifecycle.as_ref() else {
        return "Later".into();
    };
    let target = DateTime::<Local>::from(UNIX_EPOCH + std::time::Duration::from_millis(*wake_at));
    let current =
        DateTime::<Local>::from(UNIX_EPOCH + std::time::Duration::from_millis(now.max(0.0) as u64));
    let tomorrow = current.date_naive().succ_opt();
    let time = target.format("%-I:%M %p");
    if target.date_naive() == current.date_naive() {
        format!("Today · {time}")
    } else if tomorrow == Some(target.date_naive()) {
        format!("Tomorrow · {time}")
    } else {
        target.format("%a, %-I:%M %p").to_string()
    }
}

fn current_time_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |duration| duration.as_secs_f64() * 1_000.0)
}

fn elapsed_time(from: f64, now: f64) -> String {
    let seconds = ((now - from).max(0.0) / 1_000.0).floor() as u64;
    if seconds < 60 {
        return format!("{seconds}s");
    }
    let minutes = seconds / 60;
    if minutes < 60 {
        return format!("{minutes}m");
    }
    format!("{}h {}m", minutes / 60, minutes % 60)
}

fn relative_time_at(timestamp: f64, now: f64) -> String {
    let seconds = ((now - timestamp).max(0.0) / 1_000.0).round() as u64;
    if seconds < 60 {
        return "now".into();
    }
    let minutes = (seconds as f64 / 60.0).round() as u64;
    if minutes < 60 {
        return format!("{minutes}m ago");
    }
    let hours = (minutes as f64 / 60.0).round() as u64;
    if hours < 24 {
        return format!("{hours}h ago");
    }
    format!("{}d ago", (hours as f64 / 24.0).round() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use harness_protocol::SettleReason;

    #[test]
    fn classic_sidebar_spinner_uses_the_web_ten_frame_cadence() {
        assert_eq!(braille_frame_index(0.0), 0);
        assert_eq!(braille_frame_index(0.099), 0);
        assert_eq!(braille_frame_index(0.1), 1);
        assert_eq!(braille_frame_index(0.5), 5);
        assert_eq!(braille_frame_index(0.999), 9);
        assert_eq!(braille_frame_index(1.0), 9);
        assert_eq!(BRAILLE_SPINNER_FRAMES[0], "⠋");
        assert_eq!(BRAILLE_SPINNER_FRAMES[9], "⠏");
    }

    #[test]
    fn classic_project_drawer_uses_real_row_height_and_split_motion_durations() {
        let height = classic_project_drawer_height(5, true);
        assert_eq!(height, 173.0);
        assert_eq!(classic_project_drawer_height(2, false), 61.0);

        let opening = classic_project_drawer_state(true, height, 0.5);
        assert!((opening.0 - 86.5).abs() < f32::EPSILON);
        assert!((opening.1 - (0.5 * 260.0_f32 / 180.0)).abs() < f32::EPSILON);
        let closing = classic_project_drawer_state(false, height, 0.5);
        assert!((closing.0 - 86.5).abs() < f32::EPSILON);
        assert!((closing.1 - (1.0 - 0.5 * 260.0_f32 / 180.0)).abs() < f32::EPSILON);
        assert_eq!(
            classic_project_drawer_state(true, height, 1.0),
            (height, 1.0)
        );
        assert_eq!(classic_project_drawer_state(false, height, 1.0), (0.0, 0.0));
    }

    #[test]
    fn classic_sidebar_drop_targets_stay_inside_the_source_project() {
        let drag = SessionDrag {
            project_path: "/work/harness".into(),
            session_id: "thread-1".into(),
            title: "Thread 1".into(),
            width: 232.0,
            theme: Theme::dark(),
        };

        assert!(session_drop_is_valid(&drag, "/work/harness", "thread-2"));
        assert!(!session_drop_is_valid(&drag, "/work/other", "thread-2"));
        assert!(!session_drop_is_valid(&drag, "/work/harness", "thread-1"));
    }

    #[test]
    fn inbox_query_matches_titles_case_insensitively() {
        assert!(title_matches_query("Ship Native Sidebar", "native"));
        assert!(title_matches_query("Ship Native Sidebar", ""));
        assert!(!title_matches_query("Ship Native Sidebar", "electron"));
    }

    #[test]
    fn account_limit_bar_displays_the_remaining_percentage() {
        assert_eq!(usage_left(28.4), (71.6, 72));
        assert_eq!(usage_left(-5.0), (100.0, 100));
        assert_eq!(usage_left(120.0), (0.0, 0));
    }

    #[test]
    fn inbox_status_copy_and_elapsed_time_match_the_web_contract() {
        let mut session = test_session(
            "working",
            1_000.0,
            ThreadInboxStatus::Working,
            ThreadLifecycle::Active {
                keep_active: false,
                woke_at: None,
            },
        );
        let working = status_presentation(&session, 1_000.0, 66_000.0);
        assert_eq!(working.label, "Working · 1m");
        assert_eq!(working.tone, StatusTone::Working);

        session.status = Some(ThreadInboxStatus::Input);
        assert_eq!(
            status_presentation(&session, 1_000.0, 66_000.0).label,
            "Needs input"
        );
        session.status = Some(ThreadInboxStatus::Ready);
        assert_eq!(
            status_presentation(&session, 1_000.0, 66_000.0).label,
            "Done"
        );
        session.status = Some(ThreadInboxStatus::Idle);
        session.lifecycle = Some(ThreadLifecycle::Active {
            keep_active: false,
            woke_at: Some(60_000),
        });
        assert_eq!(
            status_presentation(&session, 1_000.0, 66_000.0).label,
            "Woke"
        );
    }

    #[test]
    fn inbox_keyboard_order_spans_active_snoozed_and_settled_rows() {
        let project = ProjectSummary {
            path: "/work/harness".into(),
            name: "TasteCode".into(),
            pinned: false,
            created_at: 0.0,
            sessions: vec![
                test_session(
                    "active-old",
                    100.0,
                    ThreadInboxStatus::Idle,
                    ThreadLifecycle::Active {
                        keep_active: false,
                        woke_at: None,
                    },
                ),
                test_session(
                    "settled-new",
                    10.0,
                    ThreadInboxStatus::Idle,
                    ThreadLifecycle::Settled {
                        settled_at: 5_000,
                        reason: SettleReason::Manual,
                    },
                ),
                test_session(
                    "snoozed-late",
                    20.0,
                    ThreadInboxStatus::Idle,
                    ThreadLifecycle::Snoozed {
                        snoozed_at: 1,
                        wake_at: 3_000,
                    },
                ),
                test_session(
                    "active-new",
                    200.0,
                    ThreadInboxStatus::Ready,
                    ThreadLifecycle::Active {
                        keep_active: false,
                        woke_at: None,
                    },
                ),
                test_session(
                    "snoozed-early",
                    30.0,
                    ThreadInboxStatus::Idle,
                    ThreadLifecycle::Snoozed {
                        snoozed_at: 1,
                        wake_at: 2_000,
                    },
                ),
                test_session(
                    "settled-old",
                    40.0,
                    ThreadInboxStatus::Idle,
                    ThreadLifecycle::Settled {
                        settled_at: 4_000,
                        reason: SettleReason::Manual,
                    },
                ),
            ],
        };
        assert_eq!(
            ordered_inbox_ids(&[project], None, ""),
            [
                "active-new",
                "active-old",
                "snoozed-early",
                "snoozed-late",
                "settled-new",
                "settled-old",
            ]
        );
    }

    fn test_session(
        id: &str,
        created_at: f64,
        status: ThreadInboxStatus,
        lifecycle: ThreadLifecycle,
    ) -> SessionSummary {
        SessionSummary {
            id: id.into(),
            title: id.into(),
            provider: ProviderId::Codex,
            agent: None,
            created_at,
            running: matches!(
                status,
                ThreadInboxStatus::Starting | ThreadInboxStatus::Working
            ),
            pinned: false,
            status: Some(status),
            unread: Some(false),
            lifecycle: Some(lifecycle),
            closed_at: None,
            worktree_branch: None,
        }
    }
}
