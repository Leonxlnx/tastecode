use super::HarnessApp;
use crate::chrome;
use crate::motion_icon::motion_icon;
use crate::shortcuts::{
    COMMAND_PALETTE, FOCUS_COMPOSER, NEW_CHAT, NEW_PROJECT, SEARCH_SESSIONS, SETTINGS,
    SWITCH_PROJECT, TOGGLE_SIDEBAR, label, matches,
};
use crate::zoom::px;
use gpui::{
    Animation, AnimationExt, AnyElement, Context, Entity, Focusable, FontWeight, KeyDownEvent,
    ScrollHandle, SharedString, Window, div, prelude::*, relative,
};
use gpui_component::input::{Input, InputState};
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum CommandScope {
    All,
    Projects,
    NewThread,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CommandGroup {
    Actions,
    Projects,
    Chats,
}

impl CommandGroup {
    fn label(self) -> &'static str {
        match self {
            Self::Actions => "Actions",
            Self::Projects => "Projects",
            Self::Chats => "Chats",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum PaletteAction {
    SearchSessions,
    StartNewChat,
    OpenProjects,
    AddProject,
    FocusComposer,
    ToggleSidebar,
    OpenSettings,
    SelectProject(String),
    NewChat(String),
    SelectSession(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PaletteCommand {
    id: String,
    title: String,
    detail: Option<String>,
    group: CommandGroup,
    keywords: String,
    shortcut: Option<String>,
    project_command: bool,
    new_thread_project: bool,
    action: PaletteAction,
}

impl PaletteCommand {
    fn searchable_text(&self) -> String {
        format!(
            "{} {} {} {}",
            self.title,
            self.detail.as_deref().unwrap_or_default(),
            self.group.label(),
            self.keywords
        )
        .to_lowercase()
    }
}

pub(super) struct CommandPaletteState {
    pub(super) scope: Option<CommandScope>,
    pub(super) input: Entity<InputState>,
    pub(super) reset_input: bool,
    pub(super) focus_pending: bool,
    pub(super) selected: usize,
    pub(super) open_transition: u64,
    pub(super) preferred_project: Option<String>,
    pub(super) results_scroll: ScrollHandle,
}

impl CommandPaletteState {
    pub(super) fn new(input: Entity<InputState>) -> Self {
        Self {
            scope: None,
            input,
            reset_input: false,
            focus_pending: false,
            selected: 0,
            open_transition: 0,
            preferred_project: None,
            results_scroll: ScrollHandle::new(),
        }
    }

    pub(super) fn is_open(&self) -> bool {
        self.scope.is_some()
    }
}

impl HarnessApp {
    pub(super) fn toggle_sidebar(&mut self, cx: &mut Context<Self>) {
        if self.sidebar_collapsed {
            self.expand_sidebar(cx);
        } else {
            self.collapse_sidebar(true, cx);
        }
    }

    pub(super) fn handle_global_shortcut(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.handle_zoom_shortcut(event, window, cx) {
            return;
        }
        if self.image_viewer.is_some() {
            if event.keystroke.key.eq_ignore_ascii_case("escape") {
                cx.stop_propagation();
                self.close_image_viewer(cx);
            }
            return;
        }
        if event.is_held {
            return;
        }
        if matches(event, SEARCH_SESSIONS) {
            cx.stop_propagation();
            self.command_palette.scope = None;
            self.command_palette.preferred_project = None;
            self.open_session_search(None, cx);
            return;
        }
        if self.settings_open {
            if matches(event, SETTINGS) {
                cx.stop_propagation();
                self.close_settings(cx);
            }
            return;
        }
        let palette_input_focused = self
            .command_palette
            .input
            .read(cx)
            .focus_handle(cx)
            .is_focused(window);
        let search_input_focused = self
            .session_search
            .input
            .read(cx)
            .focus_handle(cx)
            .is_focused(window);
        let sidebar_input_focused = self
            .sidebar_controls
            .input
            .read(cx)
            .focus_handle(cx)
            .is_focused(window);
        let inbox_search_focused = self
            .sidebar_search
            .read(cx)
            .focus_handle(cx)
            .is_focused(window);
        if palette_input_focused
            || search_input_focused
            || sidebar_input_focused
            || inbox_search_focused
            || self.chat.read(cx).text_input_focused(window, cx)
        {
            return;
        }

        if matches(event, COMMAND_PALETTE) {
            cx.stop_propagation();
            self.open_command_palette(CommandScope::All, None, cx);
        } else if matches(event, SWITCH_PROJECT) {
            cx.stop_propagation();
            self.open_command_palette(CommandScope::Projects, None, cx);
        } else if matches(event, NEW_CHAT) {
            cx.stop_propagation();
            self.start_new_chat(cx);
        } else if matches(event, NEW_PROJECT) {
            cx.stop_propagation();
            self.pick_project(cx);
        } else if matches(event, SETTINGS) {
            cx.stop_propagation();
            self.command_palette.scope = None;
            self.command_palette.preferred_project = None;
            self.open_settings(cx);
        } else if matches(event, FOCUS_COMPOSER) && self.active_project_path.is_some() {
            cx.stop_propagation();
            self.command_palette.scope = None;
            self.command_palette.preferred_project = None;
            self.focus_composer_pending = true;
            cx.notify();
        } else if matches(event, TOGGLE_SIDEBAR) {
            cx.stop_propagation();
            self.toggle_sidebar(cx);
        }
    }

    pub(super) fn open_command_palette(
        &mut self,
        scope: CommandScope,
        preferred_project: Option<String>,
        cx: &mut Context<Self>,
    ) {
        if self.session_search.open {
            self.close_session_search(cx);
        }
        if self.sidebar_controls.is_open() {
            self.close_sidebar_controls(cx);
        }
        self.close_rollback(cx);
        self.account_menu_open = false;
        self.settings_open = false;
        self.command_palette.scope = Some(scope);
        self.command_palette.preferred_project = preferred_project;
        self.command_palette.selected = 0;
        self.command_palette.reset_input = true;
        self.command_palette.focus_pending = true;
        self.command_palette.open_transition = self.command_palette.open_transition.wrapping_add(1);
        self.command_palette.results_scroll.scroll_to_top_of_item(0);
        cx.notify();
    }

    pub(super) fn close_command_palette(&mut self, cx: &mut Context<Self>) {
        self.command_palette.scope = None;
        self.command_palette.preferred_project = None;
        self.command_palette.focus_pending = false;
        cx.notify();
    }

    pub(super) fn prepare_command_palette_input(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.command_palette.reset_input {
            let placeholder = match self.command_palette.scope {
                Some(CommandScope::All) | None => "Search commands, projects, chats…",
                Some(CommandScope::Projects) => "Switch project…",
                Some(CommandScope::NewThread) => "Choose a project…",
            };
            self.command_palette.input.update(cx, |input, cx| {
                input.set_value("", window, cx);
                input.set_placeholder(placeholder, window, cx);
            });
            self.command_palette.reset_input = false;
        }
        if self.command_palette.focus_pending {
            self.command_palette
                .input
                .update(cx, |input, cx| input.focus(window, cx));
            self.command_palette.focus_pending = false;
        }
    }

    pub(super) fn command_palette_query_changed(&mut self, cx: &mut Context<Self>) {
        if !self.command_palette.is_open() {
            return;
        }
        self.command_palette.selected = 0;
        self.command_palette.results_scroll.scroll_to_top_of_item(0);
        cx.notify();
    }

    pub(super) fn handle_command_palette_key(
        &mut self,
        event: &KeyDownEvent,
        cx: &mut Context<Self>,
    ) {
        if !self.command_palette.is_open() {
            return;
        }
        if event.keystroke.key.eq_ignore_ascii_case("escape") {
            cx.stop_propagation();
            self.close_command_palette(cx);
        } else if event.keystroke.key.eq_ignore_ascii_case("down") {
            cx.stop_propagation();
            self.move_command_selection(1, cx);
        } else if event.keystroke.key.eq_ignore_ascii_case("up") {
            cx.stop_propagation();
            self.move_command_selection(-1, cx);
        }
    }

    fn move_command_selection(&mut self, direction: isize, cx: &mut Context<Self>) {
        let command_count = self.command_palette_commands(cx).len();
        if command_count == 0 {
            return;
        }
        self.command_palette.selected = (self.command_palette.selected as isize + direction)
            .rem_euclid(command_count as isize) as usize;
        self.command_palette
            .results_scroll
            .scroll_to_item(self.command_palette.selected);
        cx.notify();
    }

    pub(super) fn run_selected_palette_command(&mut self, cx: &mut Context<Self>) {
        let command = self
            .command_palette_commands(cx)
            .get(self.command_palette.selected)
            .cloned();
        if let Some(command) = command {
            self.run_palette_action(command.action, cx);
        }
    }

    fn run_palette_action(&mut self, action: PaletteAction, cx: &mut Context<Self>) {
        self.command_palette.scope = None;
        self.command_palette.preferred_project = None;
        self.command_palette.focus_pending = false;
        match action {
            PaletteAction::SearchSessions => self.open_session_search(None, cx),
            PaletteAction::StartNewChat => self.start_new_chat(cx),
            PaletteAction::OpenProjects => {
                self.open_command_palette(CommandScope::Projects, None, cx)
            }
            PaletteAction::AddProject => self.pick_project(cx),
            PaletteAction::FocusComposer => {
                self.focus_composer_pending = true;
                cx.notify();
            }
            PaletteAction::ToggleSidebar => self.toggle_sidebar(cx),
            PaletteAction::OpenSettings => self.open_settings(cx),
            PaletteAction::SelectProject(path) => {
                if self.active_project_path.as_deref() != Some(path.as_str()) {
                    self.begin_new_chat(path, cx);
                } else {
                    cx.notify();
                }
            }
            PaletteAction::NewChat(path) => self.begin_new_chat(path, cx),
            PaletteAction::SelectSession(thread_id) => self.select_session(thread_id, cx),
        }
    }

    fn command_palette_commands(&self, cx: &Context<Self>) -> Vec<PaletteCommand> {
        let Some(scope) = self.command_palette.scope else {
            return Vec::new();
        };
        let active_name = self.active_project_path.as_deref().and_then(|path| {
            self.state
                .projects
                .iter()
                .find(|project| project.path == path)
                .map(|project| project.name.as_str())
        });
        let mut commands = vec![
            PaletteCommand {
                id: "search-sessions".into(),
                title: "Search all chats".into(),
                detail: Some("Messages and tool output across projects".into()),
                group: CommandGroup::Actions,
                keywords: String::new(),
                shortcut: Some(label(SEARCH_SESSIONS)),
                project_command: false,
                new_thread_project: false,
                action: PaletteAction::SearchSessions,
            },
            PaletteCommand {
                id: "new-chat".into(),
                title: "New chat".into(),
                detail: Some(active_name.map_or_else(
                    || "Choose a project folder".into(),
                    |name| format!("Start in {name}"),
                )),
                group: CommandGroup::Actions,
                keywords: "session conversation".into(),
                shortcut: Some(label(NEW_CHAT)),
                project_command: false,
                new_thread_project: false,
                action: PaletteAction::StartNewChat,
            },
            PaletteCommand {
                id: "switch-project".into(),
                title: "Switch project…".into(),
                detail: Some("Choose another workspace".into()),
                group: CommandGroup::Actions,
                keywords: "folder workspace".into(),
                shortcut: Some(label(SWITCH_PROJECT)),
                project_command: false,
                new_thread_project: false,
                action: PaletteAction::OpenProjects,
            },
            PaletteCommand {
                id: "new-project".into(),
                title: "New project".into(),
                detail: Some("Add a folder to the sidebar".into()),
                group: CommandGroup::Actions,
                keywords: "add open folder workspace".into(),
                shortcut: Some(label(NEW_PROJECT)),
                project_command: true,
                new_thread_project: false,
                action: PaletteAction::AddProject,
            },
        ];
        if self.active_project_path.is_some() {
            commands.push(PaletteCommand {
                id: "focus-composer".into(),
                title: "Focus composer".into(),
                detail: Some("Move the cursor to your prompt".into()),
                group: CommandGroup::Actions,
                keywords: "prompt message type".into(),
                shortcut: Some(label(FOCUS_COMPOSER)),
                project_command: false,
                new_thread_project: false,
                action: PaletteAction::FocusComposer,
            });
        }
        commands.extend([
            PaletteCommand {
                id: "toggle-sidebar".into(),
                title: if self.sidebar_collapsed {
                    "Show sidebar".into()
                } else {
                    "Hide sidebar".into()
                },
                detail: None,
                group: CommandGroup::Actions,
                keywords: "rail navigation".into(),
                shortcut: Some(label(TOGGLE_SIDEBAR)),
                project_command: false,
                new_thread_project: false,
                action: PaletteAction::ToggleSidebar,
            },
            PaletteCommand {
                id: "open-settings".into(),
                title: "Settings".into(),
                detail: Some("Providers, appearance, storage".into()),
                group: CommandGroup::Actions,
                keywords: String::new(),
                shortcut: Some(label(SETTINGS)),
                project_command: false,
                new_thread_project: false,
                action: PaletteAction::OpenSettings,
            },
        ]);
        for project in &self.state.projects {
            commands.push(PaletteCommand {
                id: format!("project-{}", project.path),
                title: project.name.clone(),
                detail: Some(project.path.clone()),
                group: CommandGroup::Projects,
                keywords: "switch folder workspace".into(),
                shortcut: None,
                project_command: true,
                new_thread_project: false,
                action: PaletteAction::SelectProject(project.path.clone()),
            });
        }
        for project in &self.state.projects {
            commands.push(PaletteCommand {
                id: format!("new-chat-{}", project.path),
                title: format!("New thread in {}", project.name),
                detail: Some(project.path.clone()),
                group: CommandGroup::Projects,
                keywords: "session conversation".into(),
                shortcut: None,
                project_command: false,
                new_thread_project: true,
                action: PaletteAction::NewChat(project.path.clone()),
            });
        }
        for project in &self.state.projects {
            for session in &project.sessions {
                commands.push(PaletteCommand {
                    id: format!("chat-{}", session.id),
                    title: session.title.clone(),
                    detail: Some(project.name.clone()),
                    group: CommandGroup::Chats,
                    keywords: format!("{} open session conversation", project.path),
                    shortcut: None,
                    project_command: false,
                    new_thread_project: false,
                    action: PaletteAction::SelectSession(session.id.clone()),
                });
            }
        }

        visible_commands(
            commands,
            scope,
            self.command_palette.preferred_project.as_deref(),
            &self.command_palette.input.read(cx).value(),
        )
    }

    pub(super) fn command_palette_overlay(
        &self,
        window: &Window,
        cx: &Context<Self>,
    ) -> Option<AnyElement> {
        self.command_palette.scope?;
        let theme = self.theme;
        let commands = self.command_palette_commands(cx);
        let selected = self
            .command_palette
            .selected
            .min(commands.len().saturating_sub(1));
        let panel_top = (window.viewport_size().height * 0.13).min(px(104.0));
        let results_height = (window.viewport_size().height - px(200.0))
            .max(px(0.0))
            .min(px(360.0));
        let search = div()
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
                "command-palette-search-icon",
                "icons/search.svg",
                15.0,
                "command-palette-search-icon-direct-hover",
                theme,
            ))
            .child(
                Input::new(&self.command_palette.input)
                    .w_full()
                    .appearance(false)
                    .bordered(false)
                    .cleanable(false)
                    .px(px(0.0))
                    .py(px(0.0))
                    .line_height(relative(1.55))
                    .text_size(px(13.5)),
            );

        let results = if commands.is_empty() {
            div()
                .id("command-palette-results")
                .max_h(results_height)
                .overflow_y_scroll()
                .p(px(4.0))
                .child(
                    div()
                        .px(px(10.0))
                        .py(px(24.0))
                        .text_center()
                        .text_size(px(12.5))
                        .text_color(theme.text_3.hsla())
                        .child("No matching commands."),
                )
                .into_any_element()
        } else {
            let groups: Vec<_> = commands.iter().map(|command| command.group).collect();
            div()
                .id("command-palette-results")
                .max_h(results_height)
                .overflow_y_scroll()
                .track_scroll(&self.command_palette.results_scroll)
                .p(px(4.0))
                .children(commands.into_iter().enumerate().map(|(index, command)| {
                    let starts_group = index == 0 || groups[index - 1] != command.group;
                    let action = command.action.clone();
                    let hover_index = index;
                    let title = SharedString::from(command.title);
                    let detail = command.detail.map(SharedString::from);
                    let shortcut = command.shortcut.map(SharedString::from);
                    div()
                        .when(starts_group, |wrapper| {
                            wrapper.child(
                                div()
                                    .mt(px(6.0))
                                    .mb(px(2.0))
                                    .px(px(8.0))
                                    .text_size(px(11.5))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(theme.text_3.hsla())
                                    .child(command.group.label()),
                            )
                        })
                        .child(
                            div()
                                .id(("command-palette-item", index))
                                .min_h(px(42.0))
                                .w_full()
                                .flex()
                                .items_center()
                                .gap(px(10.0))
                                .px(px(8.0))
                                .py(px(7.0))
                                .rounded(px(5.0))
                                .when(index == selected, |row| {
                                    row.bg(palette_item_background(theme))
                                        .shadow(palette_item_shadows(theme))
                                })
                                .cursor_pointer()
                                .hover(move |style| {
                                    style
                                        .bg(palette_item_background(theme))
                                        .shadow(palette_item_shadows(theme))
                                })
                                .on_mouse_move(cx.listener(move |this, _event, _window, cx| {
                                    if this.command_palette.selected != hover_index {
                                        this.command_palette.selected = hover_index;
                                        cx.notify();
                                    }
                                }))
                                .on_click(cx.listener(move |this, _event, _window, cx| {
                                    this.run_palette_action(action.clone(), cx);
                                }))
                                .child(
                                    div()
                                        .min_w(px(0.0))
                                        .flex_1()
                                        .flex()
                                        .flex_col()
                                        .child(div().truncate().text_size(px(13.5)).child(title))
                                        .when_some(detail, |copy, detail| {
                                            copy.child(
                                                div()
                                                    .truncate()
                                                    .text_size(px(11.5))
                                                    .text_color(theme.text_3.hsla())
                                                    .child(detail),
                                            )
                                        }),
                                )
                                .when_some(shortcut, |row, shortcut| {
                                    row.child(
                                        div()
                                            .flex_none()
                                            .ml_auto()
                                            .font_family("Geist Mono")
                                            .text_size(px(10.5))
                                            .font_weight(FontWeight(450.0))
                                            .text_color(theme.text_3.hsla())
                                            .child(shortcut),
                                    )
                                }),
                        )
                }))
                .into_any_element()
        };
        let panel = div()
            .id("command-palette-panel")
            .occlude()
            .relative()
            .w_full()
            .max_w(px(560.0))
            .overflow_hidden()
            .rounded(px(8.0))
            .border_1()
            .border_color(chrome::border(theme))
            .bg(chrome::rail_background(theme))
            .shadow(chrome::panel_shadows(theme))
            .child(chrome::top_highlight(theme))
            .child(search)
            .child(results)
            .with_animation(
                (
                    "command-palette-panel",
                    self.command_palette.open_transition,
                ),
                Animation::new(theme.motion_duration(Duration::from_millis(220)))
                    .with_easing(crate::theme::web_ease_out),
                |panel, delta| {
                    let scale = 0.99 + 0.01 * delta;
                    panel
                        .w(relative(scale))
                        .max_w(px(560.0 * scale))
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
                        .id("command-palette-scrim")
                        .absolute()
                        .inset(px(0.0))
                        .bg(gpui::black().opacity(0.55))
                        .cursor_default()
                        .on_click(cx.listener(|this, _event, _window, cx| {
                            this.close_command_palette(cx);
                        }))
                        .with_animation(
                            "command-palette-scrim-in",
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

fn palette_item_background(theme: crate::Theme) -> gpui::Background {
    if theme.mode == crate::ThemeMode::Light {
        chrome::raised_hover(theme)
    } else {
        theme.surface_2.hsla().into()
    }
}

fn palette_item_shadows(theme: crate::Theme) -> Vec<gpui::BoxShadow> {
    if theme.mode == crate::ThemeMode::Light {
        chrome::shadows(theme)
    } else {
        Vec::new()
    }
}

fn visible_commands(
    commands: Vec<PaletteCommand>,
    scope: CommandScope,
    preferred_project: Option<&str>,
    query: &str,
) -> Vec<PaletteCommand> {
    let mut available: Vec<_> = commands
        .into_iter()
        .filter(|command| match scope {
            CommandScope::All => true,
            CommandScope::Projects => command.project_command,
            CommandScope::NewThread => command.new_thread_project,
        })
        .collect();
    if scope == CommandScope::NewThread
        && let Some(preferred) = preferred_project
        && let Some(index) = available.iter().position(
            |command| matches!(&command.action, PaletteAction::NewChat(path) if path == preferred),
        )
    {
        let preferred = available.remove(index);
        available.insert(0, preferred);
    }
    let query = query.to_lowercase();
    let terms: Vec<_> = query.split_whitespace().collect();
    if terms.is_empty() {
        return available;
    }
    available
        .into_iter()
        .filter(|command| {
            let searchable = command.searchable_text();
            terms.iter().all(|term| searchable.contains(term))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command(
        title: &str,
        detail: Option<&str>,
        group: CommandGroup,
        keywords: &str,
    ) -> PaletteCommand {
        PaletteCommand {
            id: title.into(),
            title: title.into(),
            detail: detail.map(str::to_owned),
            group,
            keywords: keywords.into(),
            shortcut: None,
            project_command: false,
            new_thread_project: false,
            action: PaletteAction::OpenSettings,
        }
    }

    fn new_thread_command(project: &str) -> PaletteCommand {
        PaletteCommand {
            id: project.into(),
            title: format!("New thread in {project}"),
            detail: Some(format!("/{project}")),
            group: CommandGroup::Projects,
            keywords: "session conversation".into(),
            shortcut: None,
            project_command: false,
            new_thread_project: true,
            action: PaletteAction::NewChat(format!("/{project}")),
        }
    }

    #[test]
    fn searchable_text_covers_every_legacy_filter_field() {
        let command = command(
            "Open report",
            Some("Workspace Alpha"),
            CommandGroup::Projects,
            "folder review",
        );
        let searchable = command.searchable_text();
        for term in ["report", "alpha", "projects", "review"] {
            assert!(searchable.contains(term));
        }
    }

    #[test]
    fn command_groups_keep_the_legacy_labels() {
        assert_eq!(CommandGroup::Actions.label(), "Actions");
        assert_eq!(CommandGroup::Projects.label(), "Projects");
        assert_eq!(CommandGroup::Chats.label(), "Chats");
    }

    #[test]
    fn filtering_requires_every_term_across_all_search_fields() {
        let commands = vec![
            command(
                "Open report",
                Some("Workspace Alpha"),
                CommandGroup::Projects,
                "folder review",
            ),
            command(
                "Search chats",
                Some("Every workspace"),
                CommandGroup::Actions,
                "messages",
            ),
        ];
        let visible = visible_commands(commands, CommandScope::All, None, "alpha review");
        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].title, "Open report");
    }

    #[test]
    fn new_thread_scope_moves_the_preferred_project_first() {
        let visible = visible_commands(
            vec![new_thread_command("alpha"), new_thread_command("beta")],
            CommandScope::NewThread,
            Some("/beta"),
            "",
        );
        assert_eq!(visible[0].title, "New thread in beta");
        assert!(visible.iter().all(|command| command.new_thread_project));
    }
}
