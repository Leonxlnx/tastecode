use super::HarnessApp;
use crate::chat::terminal::{
    CELL_HEIGHT, CELL_WIDTH, DEFAULT_ROWS, EngineEvent, TerminalEngine, TerminalSelection,
    ansi_index_rgb, render_terminal_run, terminal_input_for_keystroke, terminal_paste_data,
};
use crate::chrome;
use crate::client_state::{AuthTarget, ProviderTerminalKind};
use crate::theme::Theme;
use crate::zoom::px;
use gpui::{
    AnyElement, Bounds, ClipboardItem, Context, EventEmitter, FocusHandle, KeyDownEvent,
    MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, Pixels, Render, ScrollDelta,
    ScrollWheelEvent, SharedString, Window, canvas, div, prelude::*,
};
use std::time::Duration;
use url::Url;

const INSTALL_COLUMNS: u16 = 100;
const LOGIN_COLUMNS: u16 = 320;
const TERMINAL_ROWS: u16 = 30;
const LOG_LIMIT: usize = 200_000;
const OUTPUT_FLUSH_INTERVAL: Duration = Duration::from_millis(16);
const CURSOR_BLINK_INTERVAL: Duration = Duration::from_millis(530);

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) struct ProviderTerminalKey {
    pub(super) target: AuthTarget,
    pub(super) kind: ProviderTerminalKind,
}

impl ProviderTerminalKey {
    pub(super) fn new(target: AuthTarget, kind: ProviderTerminalKind) -> Self {
        Self { target, kind }
    }

    fn element_suffix(&self) -> String {
        let provider = format!("{:?}", self.target.provider).to_ascii_lowercase();
        let target = self.target.agent.as_deref().unwrap_or(&provider);
        let kind = match self.kind {
            ProviderTerminalKind::Install => "install",
            ProviderTerminalKind::SignIn => "sign-in",
        };
        format!("{kind}-{target}")
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ProviderTerminalPhase {
    Starting,
    Running,
    Succeeded,
    Failed,
    Error,
}

#[derive(Clone, Debug)]
pub(super) struct ProviderTerminalSnapshot {
    pub(super) phase: ProviderTerminalPhase,
    pub(super) visible: bool,
    pub(super) note: String,
    pub(super) device_code: Option<String>,
    pub(super) last_line: String,
    pub(super) opened_auth_url: Option<String>,
}

pub(super) enum ProviderTerminalEvent {
    Input {
        terminal_id: String,
        data: String,
    },
    Resize {
        terminal_id: String,
        columns: u16,
        rows: u16,
    },
    Changed,
}

pub(super) struct ProviderTerminalView {
    key: ProviderTerminalKey,
    title: String,
    theme: Theme,
    phase: ProviderTerminalPhase,
    status_message: Option<String>,
    exit_code: Option<i32>,
    terminal_id: Option<String>,
    engine: TerminalEngine,
    columns: u16,
    rows: u16,
    pending_output: Vec<String>,
    output_flush_scheduled: bool,
    focus: FocusHandle,
    focus_when_ready: bool,
    viewport_bounds: Option<Bounds<Pixels>>,
    selection: Option<TerminalSelection>,
    selecting: bool,
    cursor_visible: bool,
    blink_generation: u64,
    visible: bool,
    log: String,
    last_line: String,
    opened_auth_url: Option<String>,
}

impl EventEmitter<ProviderTerminalEvent> for ProviderTerminalView {}

impl ProviderTerminalView {
    pub(super) fn new(
        key: ProviderTerminalKey,
        title: String,
        theme: Theme,
        cx: &mut Context<Self>,
    ) -> Self {
        let (columns, rows) = initial_size(key.kind);
        Self {
            key,
            title,
            theme,
            phase: ProviderTerminalPhase::Starting,
            status_message: None,
            exit_code: None,
            terminal_id: None,
            engine: TerminalEngine::new(columns, rows),
            columns,
            rows,
            pending_output: Vec::new(),
            output_flush_scheduled: false,
            focus: cx.focus_handle(),
            focus_when_ready: false,
            viewport_bounds: None,
            selection: None,
            selecting: false,
            cursor_visible: true,
            blink_generation: 0,
            visible: false,
            log: String::new(),
            last_line: String::new(),
            opened_auth_url: None,
        }
    }

    pub(super) fn initial_size(&self) -> (u16, u16) {
        (self.columns, self.rows)
    }

    pub(super) fn terminal_id(&self) -> Option<&str> {
        self.terminal_id.as_deref()
    }

    pub(super) fn is_visible(&self) -> bool {
        self.visible
    }

    pub(super) fn snapshot(&self, idle_note: &str) -> ProviderTerminalSnapshot {
        let note = match self.phase {
            ProviderTerminalPhase::Starting => match self.key.kind {
                ProviderTerminalKind::Install => "Starting installer…".into(),
                ProviderTerminalKind::SignIn => "Starting provider CLI…".into(),
            },
            ProviderTerminalPhase::Running => {
                if self.key.kind == ProviderTerminalKind::SignIn {
                    if self.opened_auth_url.is_some() {
                        "Browser opened — approve the sign-in there. The terminal follows along."
                            .into()
                    } else {
                        "Complete the sign-in in the terminal below, then exit the CLI.".into()
                    }
                } else if self.last_line.is_empty() {
                    "Installing…".into()
                } else {
                    self.last_line.clone()
                }
            }
            ProviderTerminalPhase::Succeeded => match self.key.kind {
                ProviderTerminalKind::Install => "Installed · refreshing…".into(),
                ProviderTerminalKind::SignIn => "Sign-in completed · refreshing…".into(),
            },
            ProviderTerminalPhase::Failed => {
                let exit = self
                    .exit_code
                    .map(|code| format!(" (exit {code})"))
                    .unwrap_or_default();
                match self.key.kind {
                    ProviderTerminalKind::Install => {
                        format!("Install failed{exit} — finish it in the terminal below, or retry.")
                    }
                    ProviderTerminalKind::SignIn => {
                        format!("The CLI exited{exit} — check the terminal, or retry.")
                    }
                }
            }
            ProviderTerminalPhase::Error => self
                .status_message
                .clone()
                .unwrap_or_else(|| "The provider terminal is unavailable.".into()),
        };
        ProviderTerminalSnapshot {
            phase: self.phase,
            visible: self.visible,
            note: if note.is_empty() {
                idle_note.to_owned()
            } else {
                note
            },
            device_code: (self.key.kind == ProviderTerminalKind::SignIn)
                .then(|| device_code(&self.log))
                .flatten(),
            last_line: self.last_line.clone(),
            opened_auth_url: self.opened_auth_url.clone(),
        }
    }

    pub(super) fn set_theme(&mut self, theme: Theme, cx: &mut Context<Self>) {
        if self.theme != theme {
            self.theme = theme;
            cx.notify();
        }
    }

    pub(super) fn prepare_retry(&mut self, title: String, cx: &mut Context<Self>) {
        let (columns, rows) = initial_size(self.key.kind);
        self.title = title;
        self.phase = ProviderTerminalPhase::Starting;
        self.status_message = None;
        self.exit_code = None;
        self.terminal_id = None;
        self.engine = TerminalEngine::new(columns, rows);
        self.columns = columns;
        self.rows = rows;
        self.pending_output.clear();
        self.output_flush_scheduled = false;
        self.viewport_bounds = None;
        self.selection = None;
        self.selecting = false;
        self.cursor_visible = true;
        self.blink_generation = self.blink_generation.wrapping_add(1);
        self.visible = false;
        self.log.clear();
        self.last_line.clear();
        self.opened_auth_url = None;
        cx.emit(ProviderTerminalEvent::Changed);
        cx.notify();
    }

    pub(super) fn toggle_visibility(&mut self, cx: &mut Context<Self>) {
        self.visible = !self.visible;
        if self.visible && self.phase == ProviderTerminalPhase::Running {
            self.focus_when_ready = true;
        }
        cx.emit(ProviderTerminalEvent::Changed);
        cx.notify();
    }

    pub(super) fn apply_opened(
        &mut self,
        terminal_id: String,
        buffered_output: Vec<String>,
        cx: &mut Context<Self>,
    ) {
        self.terminal_id = Some(terminal_id);
        self.phase = ProviderTerminalPhase::Running;
        self.status_message = None;
        self.exit_code = None;
        self.visible = false;
        self.focus_when_ready = false;
        self.pending_output.extend(buffered_output);
        self.flush_output(cx);
        self.start_cursor_blink(cx);
        cx.emit(ProviderTerminalEvent::Changed);
        cx.notify();
    }

    pub(super) fn apply_output(&mut self, data: String, cx: &mut Context<Self>) {
        if self.phase != ProviderTerminalPhase::Running {
            return;
        }
        self.pending_output.push(data);
        if self.output_flush_scheduled {
            return;
        }
        self.output_flush_scheduled = true;
        cx.spawn(async move |view, cx| {
            cx.background_executor().timer(OUTPUT_FLUSH_INTERVAL).await;
            let _ = view.update(cx, |this, cx| this.flush_output(cx));
        })
        .detach();
    }

    pub(super) fn apply_exit(&mut self, exit_code: Option<i32>, cx: &mut Context<Self>) {
        self.flush_output(cx);
        self.terminal_id = None;
        self.exit_code = exit_code;
        self.phase = if exit_code == Some(0) {
            ProviderTerminalPhase::Succeeded
        } else {
            ProviderTerminalPhase::Failed
        };
        if self.phase == ProviderTerminalPhase::Failed {
            self.visible = true;
        }
        self.blink_generation = self.blink_generation.wrapping_add(1);
        self.cursor_visible = true;
        cx.emit(ProviderTerminalEvent::Changed);
        cx.notify();
    }

    pub(super) fn apply_error(&mut self, message: String, cx: &mut Context<Self>) {
        self.phase = ProviderTerminalPhase::Error;
        self.status_message = Some(message);
        self.visible = true;
        self.blink_generation = self.blink_generation.wrapping_add(1);
        cx.emit(ProviderTerminalEvent::Changed);
        cx.notify();
    }

    pub(super) fn apply_closed(&mut self, cx: &mut Context<Self>) {
        self.terminal_id = None;
        if self.phase == ProviderTerminalPhase::Running {
            self.phase = ProviderTerminalPhase::Error;
            self.status_message = Some("The provider terminal closed unexpectedly.".into());
            self.visible = true;
        }
        self.blink_generation = self.blink_generation.wrapping_add(1);
        cx.emit(ProviderTerminalEvent::Changed);
        cx.notify();
    }

    fn flush_output(&mut self, cx: &mut Context<Self>) {
        self.output_flush_scheduled = false;
        if self.pending_output.is_empty() {
            return;
        }
        for chunk in std::mem::take(&mut self.pending_output) {
            self.engine.advance(&chunk);
            self.log.push_str(&chunk);
        }
        if self.log.len() > LOG_LIMIT {
            self.log = utf8_tail(std::mem::take(&mut self.log), LOG_LIMIT);
        }
        self.last_line = last_printable_line(&self.log);
        if self.key.kind == ProviderTerminalKind::SignIn
            && self.opened_auth_url.is_none()
            && let Some(url) = first_auth_url(&self.log)
        {
            self.opened_auth_url = Some(url.clone());
            cx.open_url(&url);
        }
        self.cursor_visible = true;
        self.handle_engine_events(cx);
        cx.emit(ProviderTerminalEvent::Changed);
        cx.notify();
    }

    fn handle_engine_events(&mut self, cx: &mut Context<Self>) {
        let Some(terminal_id) = self.terminal_id.clone() else {
            return;
        };
        for event in self.engine.drain_events() {
            match event {
                EngineEvent::Input(data) => cx.emit(ProviderTerminalEvent::Input {
                    terminal_id: terminal_id.clone(),
                    data,
                }),
                EngineEvent::ClipboardStore(text) => {
                    cx.write_to_clipboard(ClipboardItem::new_string(text));
                }
                EngineEvent::ClipboardLoad(format) => {
                    if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
                        cx.emit(ProviderTerminalEvent::Input {
                            terminal_id: terminal_id.clone(),
                            data: format(&text),
                        });
                    }
                }
                EngineEvent::ColorRequest(index, format) => {
                    cx.emit(ProviderTerminalEvent::Input {
                        terminal_id: terminal_id.clone(),
                        data: format(ansi_index_rgb(index, self.theme)),
                    });
                }
            }
        }
    }

    fn start_cursor_blink(&mut self, cx: &mut Context<Self>) {
        self.blink_generation = self.blink_generation.wrapping_add(1);
        let generation = self.blink_generation;
        cx.spawn(async move |view, cx| {
            loop {
                cx.background_executor().timer(CURSOR_BLINK_INTERVAL).await;
                let keep_blinking = view.update(cx, |this, cx| {
                    if this.blink_generation != generation
                        || this.phase != ProviderTerminalPhase::Running
                    {
                        return false;
                    }
                    this.cursor_visible = !this.cursor_visible;
                    cx.notify();
                    true
                });
                if !matches!(keep_blinking, Ok(true)) {
                    break;
                }
            }
        })
        .detach();
    }

    fn has_selection(&self) -> bool {
        self.selection
            .is_some_and(|selection| !selection.is_empty())
    }

    fn cell_at(&self, position: gpui::Point<Pixels>) -> Option<(usize, usize)> {
        let bounds = self.viewport_bounds?;
        if !bounds.contains(&position) {
            return None;
        }
        let column = ((position.x - bounds.origin.x) / px(CELL_WIDTH)).floor() as usize;
        let row = ((position.y - bounds.origin.y) / px(CELL_HEIGHT)).floor() as usize;
        Some((
            row.min(usize::from(self.rows.saturating_sub(1))),
            column.min(usize::from(self.columns.saturating_sub(1))),
        ))
    }

    fn key_down(&mut self, event: &KeyDownEvent, _window: &mut Window, cx: &mut Context<Self>) {
        if self.phase != ProviderTerminalPhase::Running {
            return;
        }
        let key = event.keystroke.key.to_ascii_lowercase();
        if event.keystroke.modifiers.secondary() && key == "c" && self.has_selection() {
            self.copy_selection(cx);
            cx.stop_propagation();
            return;
        }
        if event.keystroke.modifiers.secondary() && key == "v" {
            if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
                let data = terminal_paste_data(text, self.engine.bracketed_paste());
                self.send_input(data, cx);
            }
            cx.stop_propagation();
            return;
        }
        if let Some(data) =
            terminal_input_for_keystroke(&event.keystroke, self.engine.application_cursor())
        {
            self.send_input(data, cx);
            cx.stop_propagation();
        }
    }

    fn send_input(&mut self, data: String, cx: &mut Context<Self>) {
        let Some(terminal_id) = self.terminal_id.clone() else {
            return;
        };
        self.selection = None;
        self.cursor_visible = true;
        cx.emit(ProviderTerminalEvent::Input { terminal_id, data });
        cx.notify();
    }

    fn copy_selection(&self, cx: &mut Context<Self>) {
        let Some(selection) = self.selection else {
            return;
        };
        if let Some(text) = self.engine.selected_text(selection)
            && !text.is_empty()
        {
            cx.write_to_clipboard(ClipboardItem::new_string(text));
        }
    }

    fn mouse_down(&mut self, event: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        self.focus.focus(window);
        let Some(cell) = self.cell_at(event.position) else {
            return;
        };
        self.selecting = true;
        let anchor = if event.modifiers.shift {
            self.selection.map_or(cell, |selection| selection.anchor)
        } else {
            cell
        };
        self.selection = Some(TerminalSelection {
            anchor,
            focus: cell,
        });
        cx.notify();
    }

    fn mouse_move(&mut self, event: &MouseMoveEvent, cx: &mut Context<Self>) {
        if !self.selecting || !event.dragging() {
            return;
        }
        let Some(cell) = self.cell_at(event.position) else {
            return;
        };
        if let Some(selection) = &mut self.selection {
            selection.focus = cell;
            cx.notify();
        }
    }

    fn mouse_up(&mut self, cx: &mut Context<Self>) {
        self.selecting = false;
        if self.selection.is_some_and(TerminalSelection::is_empty) {
            self.selection = None;
        }
        cx.notify();
    }

    fn scroll(&mut self, event: &ScrollWheelEvent, cx: &mut Context<Self>) {
        let lines = match event.delta {
            ScrollDelta::Lines(delta) => delta.y.round() as i32,
            ScrollDelta::Pixels(delta) => (delta.y / px(CELL_HEIGHT)).round() as i32,
        };
        self.engine.scroll(lines);
        self.selection = None;
        cx.notify();
    }

    fn viewport_bounds_changed(&mut self, bounds: Bounds<Pixels>, cx: &mut Context<Self>) {
        self.viewport_bounds = Some(bounds);
        let columns = ((bounds.size.width / px(CELL_WIDTH)).floor() as u16).clamp(2, 1_000);
        let rows = ((bounds.size.height / px(CELL_HEIGHT)).floor() as u16).clamp(2, 1_000);
        if columns == self.columns && rows == self.rows {
            return;
        }
        self.columns = columns;
        self.rows = rows;
        self.engine.resize(columns, rows);
        self.selection = None;
        if let Some(terminal_id) = self.terminal_id.clone() {
            cx.emit(ProviderTerminalEvent::Resize {
                terminal_id,
                columns,
                rows,
            });
        }
        cx.notify();
    }
}

impl Render for ProviderTerminalView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.focus_when_ready && self.visible {
            self.focus.focus(window);
            self.focus_when_ready = false;
        }
        let theme = self.theme;
        let focused = self.focus.is_focused(window);
        let frame = self
            .engine
            .frame(theme, self.selection, self.cursor_visible);
        let entity = cx.entity();
        let suffix = self.key.element_suffix();
        let grid_id = SharedString::from(format!("provider-terminal-grid-{suffix}"));
        let viewport_id = SharedString::from(format!("provider-terminal-viewport-{suffix}"));
        let rows = frame.rows.into_iter().map(|runs| {
            div()
                .h(px(CELL_HEIGHT))
                .min_h(px(CELL_HEIGHT))
                .w_full()
                .flex()
                .items_center()
                .children(runs.into_iter().map(render_terminal_run))
        });
        let grid = div()
            .id(grid_id)
            .relative()
            .size_full()
            .overflow_hidden()
            .child(
                canvas(
                    move |bounds, _, cx| {
                        entity.update(cx, |this, cx| {
                            this.viewport_bounds_changed(bounds, cx);
                        });
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .inset_0(),
            )
            .child(div().size_full().overflow_hidden().children(rows));

        div()
            .id(viewport_id)
            .h(px(240.0))
            .w_auto()
            .mx(px(12.0))
            .mb(px(10.0))
            .px(px(12.0))
            .py(px(8.0))
            .relative()
            .overflow_hidden()
            .rounded(px(5.0))
            .border_1()
            .border_color(if focused {
                theme
                    .line
                    .hsla()
                    .blend(theme.attention.hsla().opacity(0.45))
            } else {
                theme.line.hsla()
            })
            .bg(theme.background.hsla())
            .font_family("Geist Mono")
            .text_size(px(12.0))
            .line_height(px(CELL_HEIGHT))
            .cursor_text()
            .track_focus(&self.focus)
            .on_key_down(cx.listener(Self::key_down))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::mouse_down))
            .on_mouse_move(cx.listener(|this, event, _window, cx| {
                this.mouse_move(event, cx);
            }))
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, _event: &MouseUpEvent, _window, cx| {
                    this.mouse_up(cx);
                }),
            )
            .on_scroll_wheel(cx.listener(|this, event, _window, cx| {
                this.scroll(event, cx);
            }))
            .child(chrome::top_highlight(theme))
            .child(grid)
    }
}

impl HarnessApp {
    pub(super) fn start_provider_terminal(
        &mut self,
        target: AuthTarget,
        kind: ProviderTerminalKind,
        title: String,
        cx: &mut Context<Self>,
    ) {
        if self.state.provider_terminal_busy.is_some() {
            return;
        }
        if kind == ProviderTerminalKind::SignIn {
            self.copied_provider_code = None;
        }
        let key = ProviderTerminalKey::new(target.clone(), kind);
        let terminal = if let Some(existing) = self.provider_terminals.get(&key).cloned() {
            if let Some(terminal_id) = existing.read(cx).terminal_id().map(str::to_owned) {
                let update = self.state.close_terminal(&terminal_id);
                self.apply_client_update(update, cx);
                self.provider_terminal_ids.remove(&terminal_id);
            }
            existing.update(cx, |terminal, cx| terminal.prepare_retry(title, cx));
            existing
        } else {
            let terminal =
                cx.new(|cx| ProviderTerminalView::new(key.clone(), title, self.theme, cx));
            cx.subscribe(&terminal, |this, _terminal, event, cx| match event {
                ProviderTerminalEvent::Input { terminal_id, data } => {
                    let update = this.state.write_terminal(terminal_id, data.clone());
                    this.apply_client_update(update, cx);
                }
                ProviderTerminalEvent::Resize {
                    terminal_id,
                    columns,
                    rows,
                } => {
                    let update = this.state.resize_terminal(terminal_id, *columns, *rows);
                    this.apply_client_update(update, cx);
                }
                ProviderTerminalEvent::Changed => cx.notify(),
            })
            .detach();
            self.provider_terminals
                .insert(key.clone(), terminal.clone());
            terminal
        };
        let (columns, rows) = terminal.read(cx).initial_size();
        let update = self
            .state
            .start_provider_terminal(target, kind, columns, rows);
        self.apply_client_update(update, cx);
    }

    pub(super) fn toggle_provider_terminal(
        &mut self,
        key: &ProviderTerminalKey,
        cx: &mut Context<Self>,
    ) {
        if let Some(terminal) = self.provider_terminals.get(key) {
            terminal.update(cx, |terminal, cx| terminal.toggle_visibility(cx));
            cx.notify();
        }
    }

    pub(super) fn provider_terminal_snapshot(
        &self,
        key: &ProviderTerminalKey,
        idle_note: &str,
        cx: &Context<Self>,
    ) -> Option<ProviderTerminalSnapshot> {
        self.provider_terminals
            .get(key)
            .map(|terminal| terminal.read(cx).snapshot(idle_note))
    }

    pub(super) fn provider_terminal_element(
        &self,
        key: &ProviderTerminalKey,
        cx: &Context<Self>,
    ) -> Option<AnyElement> {
        let terminal = self.provider_terminals.get(key)?;
        terminal
            .read(cx)
            .is_visible()
            .then(|| terminal.clone().into_any_element())
    }

    pub(super) fn apply_provider_terminal_opened(
        &mut self,
        target: AuthTarget,
        kind: ProviderTerminalKind,
        terminal_id: String,
        buffered_output: Vec<String>,
        early_exit: Option<Option<i32>>,
        cx: &mut Context<Self>,
    ) {
        let key = ProviderTerminalKey::new(target, kind);
        let Some(terminal) = self.provider_terminals.get(&key).cloned() else {
            let update = self.state.close_terminal(&terminal_id);
            self.apply_client_update(update, cx);
            return;
        };
        self.provider_terminal_ids
            .insert(terminal_id.clone(), key.clone());
        terminal.update(cx, |terminal, cx| {
            terminal.apply_opened(terminal_id.clone(), buffered_output, cx);
        });
        if let Some(exit_code) = early_exit {
            self.provider_terminal_ids.remove(&terminal_id);
            self.finish_provider_terminal(key, terminal, exit_code, cx);
        }
    }

    pub(super) fn apply_provider_terminal_output(
        &mut self,
        terminal_id: String,
        data: String,
        cx: &mut Context<Self>,
    ) {
        let Some(key) = self.provider_terminal_ids.get(&terminal_id) else {
            return;
        };
        if let Some(terminal) = self.provider_terminals.get(key) {
            terminal.update(cx, |terminal, cx| terminal.apply_output(data, cx));
        }
    }

    pub(super) fn apply_provider_terminal_exit(
        &mut self,
        terminal_id: String,
        exit_code: Option<i32>,
        cx: &mut Context<Self>,
    ) {
        let Some(key) = self.provider_terminal_ids.remove(&terminal_id) else {
            return;
        };
        let Some(terminal) = self.provider_terminals.get(&key).cloned() else {
            return;
        };
        self.finish_provider_terminal(key, terminal, exit_code, cx);
    }

    fn finish_provider_terminal(
        &mut self,
        key: ProviderTerminalKey,
        terminal: gpui::Entity<ProviderTerminalView>,
        exit_code: Option<i32>,
        cx: &mut Context<Self>,
    ) {
        terminal.update(cx, |terminal, cx| terminal.apply_exit(exit_code, cx));
        if exit_code == Some(0) {
            self.state.auth_error = None;
            self.state.refresh_model_catalog();
            if key.kind == ProviderTerminalKind::SignIn {
                self.provider_terminals.remove(&key);
            }
        }
        cx.notify();
    }

    pub(super) fn apply_provider_terminal_error(
        &mut self,
        target: Option<AuthTarget>,
        kind: Option<ProviderTerminalKind>,
        terminal_id: Option<String>,
        message: String,
        cx: &mut Context<Self>,
    ) {
        let key = terminal_id
            .as_ref()
            .and_then(|terminal_id| self.provider_terminal_ids.get(terminal_id).cloned())
            .or_else(|| match (target, kind) {
                (Some(target), Some(kind)) => Some(ProviderTerminalKey::new(target, kind)),
                (Some(target), None) => self
                    .provider_terminals
                    .keys()
                    .find(|key| key.target == target)
                    .cloned(),
                _ => None,
            });
        let Some(key) = key else {
            return;
        };
        if let Some(terminal) = self.provider_terminals.get(&key) {
            terminal.update(cx, |terminal, cx| terminal.apply_error(message, cx));
        }
        cx.notify();
    }

    pub(super) fn apply_provider_terminal_closed(
        &mut self,
        terminal_id: String,
        cx: &mut Context<Self>,
    ) {
        let Some(key) = self.provider_terminal_ids.remove(&terminal_id) else {
            return;
        };
        if let Some(terminal) = self.provider_terminals.get(&key) {
            terminal.update(cx, |terminal, cx| terminal.apply_closed(cx));
        }
        cx.notify();
    }

    pub(super) fn update_provider_terminal_themes(&mut self, cx: &mut Context<Self>) {
        for terminal in self.provider_terminals.values() {
            terminal.update(cx, |terminal, cx| terminal.set_theme(self.theme, cx));
        }
    }
}

fn initial_size(kind: ProviderTerminalKind) -> (u16, u16) {
    let columns = match kind {
        ProviderTerminalKind::Install => INSTALL_COLUMNS,
        ProviderTerminalKind::SignIn => LOGIN_COLUMNS,
    };
    (columns, TERMINAL_ROWS.max(DEFAULT_ROWS))
}

fn utf8_tail(value: String, maximum: usize) -> String {
    let mut start = value.len().saturating_sub(maximum);
    while !value.is_char_boundary(start) {
        start += 1;
    }
    value[start..].to_owned()
}

fn first_auth_url(log: &str) -> Option<String> {
    let printable = strip_terminal_controls(log);
    let mut candidates = printable
        .match_indices("https://")
        .chain(printable.match_indices("http://"))
        .collect::<Vec<_>>();
    candidates.sort_by_key(|(index, _)| *index);
    for (start, _) in candidates {
        let tail = &printable[start..];
        let end = tail
            .char_indices()
            .skip_while(|(offset, _)| *offset < "http://".len())
            .find_map(|(offset, character)| {
                (character.is_whitespace() || "'\"<>)".contains(character)).then_some(offset)
            })?;
        let candidate = &tail[..end];
        if Url::parse(candidate).is_ok() {
            return Some(candidate.to_owned());
        }
    }
    None
}

fn last_printable_line(log: &str) -> String {
    strip_terminal_controls(log)
        .split(['\r', '\n'])
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default()
        .to_owned()
}

fn device_code(log: &str) -> Option<String> {
    let printable = strip_terminal_controls(log);
    let tokens = printable
        .split(|character: char| !(character.is_ascii_alphanumeric() || character == '-'))
        .filter(|token| !token.is_empty())
        .collect::<Vec<_>>();
    for (index, token) in tokens.iter().enumerate() {
        let labeled = index > 0 && tokens[index - 1].eq_ignore_ascii_case("code");
        if (labeled && is_device_code(token)) || is_dashed_device_code(token) {
            return Some((*token).to_owned());
        }
    }
    None
}

fn is_device_code(value: &str) -> bool {
    ((6..=9).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_digit()))
        || is_dashed_device_code(value)
}

fn is_dashed_device_code(value: &str) -> bool {
    let Some((left, right)) = value.split_once('-') else {
        return false;
    };
    (3..=5).contains(&left.len())
        && left.len() == right.len()
        && left
            .bytes()
            .chain(right.bytes())
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
}

fn strip_terminal_controls(value: &str) -> String {
    #[derive(Clone, Copy)]
    enum State {
        Text,
        Escape,
        Csi,
        Osc,
        OscEscape,
    }

    let mut state = State::Text;
    let mut output = String::with_capacity(value.len());
    for character in value.chars() {
        state = match state {
            State::Text if character == '\u{1b}' => State::Escape,
            State::Text => {
                if character == '\n' || character == '\r' || !character.is_control() {
                    output.push(character);
                }
                State::Text
            }
            State::Escape if character == '[' => State::Csi,
            State::Escape if character == ']' => State::Osc,
            State::Escape => State::Text,
            State::Csi if ('@'..='~').contains(&character) => State::Text,
            State::Csi => State::Csi,
            State::Osc if character == '\u{7}' => State::Text,
            State::Osc if character == '\u{1b}' => State::OscEscape,
            State::Osc => State::Osc,
            State::OscEscape if character == '\\' => State::Text,
            State::OscEscape => State::Osc,
        };
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_url_requires_a_terminated_url() {
        assert_eq!(first_auth_url("Open https://example.com/oauth"), None);
        assert_eq!(
            first_auth_url("Open https://example.com/oauth now"),
            Some("https://example.com/oauth".into())
        );
    }

    #[test]
    fn printable_line_ignores_terminal_control_sequences() {
        assert_eq!(
            last_printable_line("\u{1b}[32mInstalling\u{1b}[0m\r\nDone\r\n"),
            "Done"
        );
    }

    #[test]
    fn device_codes_match_labeled_and_dashed_cli_output() {
        assert_eq!(
            device_code("Verification code: 12345678\r\n"),
            Some("12345678".into())
        );
        assert_eq!(
            device_code("Enter ABCD-EFGH in the browser"),
            Some("ABCD-EFGH".into())
        );
        assert_eq!(device_code("https://example.com/oauth"), None);
    }
}
