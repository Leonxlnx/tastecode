use super::*;
use crate::motion_icon::motion_icon;
use alacritty_terminal::Term;
use alacritty_terminal::event::{Event as TerminalEvent, EventListener, WindowSize};
use alacritty_terminal::grid::Scroll;
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::test::TermSize;
use alacritty_terminal::term::{Config as TerminalConfig, TermMode};
use alacritty_terminal::vte::ansi::{
    Color, CursorShape, NamedColor, Processor, Rgb as TerminalRgb,
};
use gpui::{
    Bounds, ClipboardItem, FocusHandle, KeyDownEvent, Keystroke, MouseButton, MouseDownEvent,
    MouseMoveEvent, MouseUpEvent, Pixels, ScrollDelta, ScrollWheelEvent, canvas, rgb,
};
use harness_client::ConnectionState;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

pub(crate) const DEFAULT_COLUMNS: u16 = 100;
pub(crate) const DEFAULT_ROWS: u16 = 14;
const DEFAULT_HEIGHT: f32 = 260.0;
const MIN_HEIGHT: f32 = 160.0;
pub(crate) const CELL_WIDTH: f32 = 7.5;
pub(crate) const CELL_HEIGHT: f32 = 15.625;
const EARLY_OUTPUT_LIMIT: usize = 512 * 1024;
const EARLY_TERMINAL_LIMIT: usize = 128 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TerminalStatus {
    Connecting,
    Open,
    Reconnecting,
    Exited(Option<i32>),
    Error,
}

pub(crate) enum EngineEvent {
    Input(String),
    ClipboardStore(String),
    ClipboardLoad(Arc<dyn Fn(&str) -> String + Sync + Send + 'static>),
    ColorRequest(
        usize,
        Arc<dyn Fn(TerminalRgb) -> String + Sync + Send + 'static>,
    ),
}

#[derive(Clone)]
struct TerminalEventProxy {
    state: Arc<Mutex<TerminalEventState>>,
}

struct TerminalEventState {
    columns: u16,
    rows: u16,
    events: Vec<EngineEvent>,
}

impl EventListener for TerminalEventProxy {
    fn send_event(&self, event: TerminalEvent) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        match event {
            TerminalEvent::PtyWrite(data) => state.events.push(EngineEvent::Input(data)),
            TerminalEvent::TextAreaSizeRequest(format) => {
                let size = WindowSize {
                    num_lines: state.rows,
                    num_cols: state.columns,
                    cell_width: (CELL_WIDTH * crate::zoom::factor()).round() as u16,
                    cell_height: (CELL_HEIGHT * crate::zoom::factor()).round() as u16,
                };
                state.events.push(EngineEvent::Input(format(size)));
            }
            TerminalEvent::ClipboardStore(_, text) => {
                state.events.push(EngineEvent::ClipboardStore(text));
            }
            TerminalEvent::ClipboardLoad(_, format) => {
                state.events.push(EngineEvent::ClipboardLoad(format));
            }
            TerminalEvent::ColorRequest(index, format) => {
                state.events.push(EngineEvent::ColorRequest(index, format));
            }
            TerminalEvent::MouseCursorDirty
            | TerminalEvent::Title(_)
            | TerminalEvent::ResetTitle
            | TerminalEvent::CursorBlinkingChange
            | TerminalEvent::Wakeup
            | TerminalEvent::Bell
            | TerminalEvent::Exit
            | TerminalEvent::ChildExit(_) => {}
        }
    }
}

pub(crate) struct TerminalEngine {
    term: Term<TerminalEventProxy>,
    processor: Processor,
    events: Arc<Mutex<TerminalEventState>>,
    columns: u16,
    rows: u16,
}

impl TerminalEngine {
    pub(crate) fn new(columns: u16, rows: u16) -> Self {
        let events = Arc::new(Mutex::new(TerminalEventState {
            columns,
            rows,
            events: Vec::new(),
        }));
        let proxy = TerminalEventProxy {
            state: events.clone(),
        };
        let config = TerminalConfig {
            scrolling_history: 5_000,
            ..TerminalConfig::default()
        };
        let size = TermSize::new(usize::from(columns), usize::from(rows));
        Self {
            term: Term::new(config, &size, proxy),
            processor: Processor::new(),
            events,
            columns,
            rows,
        }
    }

    pub(crate) fn advance(&mut self, data: &str) {
        self.processor.advance(&mut self.term, data.as_bytes());
    }

    pub(crate) fn resize(&mut self, columns: u16, rows: u16) {
        if self.columns == columns && self.rows == rows {
            return;
        }
        self.columns = columns;
        self.rows = rows;
        self.term
            .resize(TermSize::new(usize::from(columns), usize::from(rows)));
        if let Ok(mut events) = self.events.lock() {
            events.columns = columns;
            events.rows = rows;
        }
    }

    pub(crate) fn scroll(&mut self, lines: i32) {
        if lines != 0 && !self.term.mode().intersects(TermMode::ALT_SCREEN) {
            self.term.scroll_display(Scroll::Delta(lines));
        }
    }

    pub(crate) fn application_cursor(&self) -> bool {
        self.term.mode().contains(TermMode::APP_CURSOR)
    }

    pub(crate) fn bracketed_paste(&self) -> bool {
        self.term.mode().contains(TermMode::BRACKETED_PASTE)
    }

    pub(crate) fn drain_events(&self) -> Vec<EngineEvent> {
        self.events
            .lock()
            .map(|mut state| std::mem::take(&mut state.events))
            .unwrap_or_default()
    }

    pub(crate) fn frame(
        &self,
        theme: Theme,
        selection: Option<TerminalSelection>,
        cursor_visible: bool,
    ) -> TerminalFrame {
        let content = self.term.renderable_content();
        let cursor = content.cursor;
        let cursor_shape =
            (cursor_visible && cursor.shape != CursorShape::Hidden).then_some(cursor.shape);
        let mut rows = Vec::<Vec<TerminalRun>>::new();
        let mut current_line = None;
        let mut row_index = 0usize;

        for indexed in content.display_iter {
            if current_line != Some(indexed.point.line.0) {
                if current_line.is_some() {
                    row_index += 1;
                }
                current_line = Some(indexed.point.line.0);
                rows.push(Vec::new());
            }

            let column = indexed.point.column.0;
            let selected = selection.is_some_and(|selection| selection.contains(row_index, column));
            let cursor_here = (indexed.point == cursor.point)
                .then_some(cursor_shape)
                .flatten();
            let style = terminal_style(indexed.cell, theme, selected, cursor_here);
            let mut text = String::new();
            if !indexed
                .cell
                .flags
                .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
            {
                text.push(if indexed.cell.flags.contains(Flags::HIDDEN) {
                    ' '
                } else {
                    indexed.cell.c
                });
                for character in indexed.cell.zerowidth().into_iter().flatten() {
                    text.push(*character);
                }
            }

            let row = rows.last_mut().expect("a terminal row was just created");
            if let Some(run) = row.last_mut()
                && run.style == style
            {
                run.text.push_str(&text);
                run.columns += 1;
            } else {
                row.push(TerminalRun {
                    text,
                    columns: 1,
                    style,
                });
            }
        }

        TerminalFrame { rows }
    }

    pub(crate) fn selected_text(&self, selection: TerminalSelection) -> Option<String> {
        if selection.is_empty() {
            return None;
        }
        let content = self.term.renderable_content();
        let mut cells = Vec::<Vec<String>>::new();
        let mut current_line = None;
        for indexed in content.display_iter {
            if current_line != Some(indexed.point.line.0) {
                current_line = Some(indexed.point.line.0);
                cells.push(Vec::new());
            }
            let mut text = String::new();
            if !indexed
                .cell
                .flags
                .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
            {
                text.push(if indexed.cell.flags.contains(Flags::HIDDEN) {
                    ' '
                } else {
                    indexed.cell.c
                });
                for character in indexed.cell.zerowidth().into_iter().flatten() {
                    text.push(*character);
                }
            }
            cells.last_mut()?.push(text);
        }

        let (start, end) = selection.ordered();
        let mut selected = String::new();
        let last_row = end.0.min(cells.len().saturating_sub(1));
        for (row, row_cells) in cells.iter().enumerate().take(last_row + 1).skip(start.0) {
            let first = if row == start.0 { start.1 } else { 0 };
            let last = if row == end.0 {
                end.1
            } else {
                row_cells.len().saturating_sub(1)
            };
            for cell in row_cells.iter().take(last + 1).skip(first) {
                selected.push_str(cell);
            }
            if row != last_row {
                while selected.ends_with(' ') {
                    selected.pop();
                }
                selected.push('\n');
            }
        }
        Some(selected)
    }
}

#[derive(Clone, Copy)]
pub(crate) struct TerminalSelection {
    pub(crate) anchor: (usize, usize),
    pub(crate) focus: (usize, usize),
}

impl TerminalSelection {
    fn ordered(self) -> ((usize, usize), (usize, usize)) {
        if self.anchor <= self.focus {
            (self.anchor, self.focus)
        } else {
            (self.focus, self.anchor)
        }
    }

    pub(crate) fn contains(self, row: usize, column: usize) -> bool {
        let (start, end) = self.ordered();
        (row, column) >= start && (row, column) <= end
    }

    pub(crate) fn is_empty(self) -> bool {
        self.anchor == self.focus
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct TerminalTextStyle {
    foreground: u32,
    background: Option<u32>,
    bold: bool,
    italic: bool,
    underline: bool,
    cursor: Option<TerminalCursorStyle>,
    cursor_color: u32,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TerminalCursorStyle {
    Block,
    HollowBlock,
    Underline,
    Beam,
}

pub(crate) struct TerminalRun {
    text: String,
    columns: usize,
    style: TerminalTextStyle,
}

pub(crate) struct TerminalFrame {
    pub(crate) rows: Vec<Vec<TerminalRun>>,
}

#[derive(Default)]
struct EarlyOutput {
    by_terminal: HashMap<String, VecDeque<String>>,
    order: VecDeque<String>,
    bytes: usize,
}

impl EarlyOutput {
    fn push(&mut self, terminal_id: String, mut data: String) {
        if data.len() > EARLY_TERMINAL_LIMIT {
            data = utf8_tail(data, EARLY_TERMINAL_LIMIT);
        }
        if !self.by_terminal.contains_key(&terminal_id) {
            self.order.push_back(terminal_id.clone());
        }
        while self.bytes + data.len() > EARLY_OUTPUT_LIMIT {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if let Some(chunks) = self.by_terminal.remove(&oldest) {
                self.bytes = self
                    .bytes
                    .saturating_sub(chunks.iter().map(String::len).sum::<usize>());
            }
        }

        let chunks = self.by_terminal.entry(terminal_id).or_default();
        let mut terminal_bytes = chunks.iter().map(String::len).sum::<usize>();
        while terminal_bytes + data.len() > EARLY_TERMINAL_LIMIT {
            let Some(removed) = chunks.pop_front() else {
                break;
            };
            terminal_bytes = terminal_bytes.saturating_sub(removed.len());
            self.bytes = self.bytes.saturating_sub(removed.len());
        }
        self.bytes += data.len();
        chunks.push_back(data);
    }

    fn take(&mut self, terminal_id: &str) -> Vec<String> {
        let chunks = self.by_terminal.remove(terminal_id).unwrap_or_default();
        self.bytes = self
            .bytes
            .saturating_sub(chunks.iter().map(String::len).sum::<usize>());
        self.clear();
        chunks.into_iter().collect()
    }

    fn clear(&mut self) {
        self.by_terminal.clear();
        self.order.clear();
        self.bytes = 0;
    }
}

fn utf8_tail(value: String, maximum: usize) -> String {
    let mut start = value.len().saturating_sub(maximum);
    while !value.is_char_boundary(start) {
        start += 1;
    }
    value[start..].to_owned()
}

struct ResizeDrag {
    start_y: Pixels,
    start_height: Pixels,
}

pub(super) struct TerminalUiState {
    visible: bool,
    status: TerminalStatus,
    status_message: Option<String>,
    terminal_id: Option<String>,
    opening: bool,
    connection: ConnectionState,
    engine: TerminalEngine,
    early_output: EarlyOutput,
    pending_output: Vec<String>,
    output_flush_scheduled: bool,
    focus: FocusHandle,
    focus_when_ready: bool,
    viewport_bounds: Option<Bounds<Pixels>>,
    height: Pixels,
    resize_drag: Option<ResizeDrag>,
    selection: Option<TerminalSelection>,
    selecting: bool,
    cursor_visible: bool,
    blink_generation: u64,
    open_generation: u64,
}

impl TerminalUiState {
    pub(super) fn new(cx: &mut Context<ChatView>) -> Self {
        Self {
            visible: false,
            status: TerminalStatus::Connecting,
            status_message: None,
            terminal_id: None,
            opening: false,
            connection: ConnectionState::Connecting,
            engine: TerminalEngine::new(DEFAULT_COLUMNS, DEFAULT_ROWS),
            early_output: EarlyOutput::default(),
            pending_output: Vec::new(),
            output_flush_scheduled: false,
            focus: cx.focus_handle(),
            focus_when_ready: false,
            viewport_bounds: None,
            height: px(DEFAULT_HEIGHT),
            resize_drag: None,
            selection: None,
            selecting: false,
            cursor_visible: true,
            blink_generation: 0,
            open_generation: 0,
        }
    }

    pub(super) fn is_focused(&self, window: &Window) -> bool {
        self.focus.is_focused(window)
    }

    fn reset_engine(&mut self) {
        self.engine = TerminalEngine::new(self.engine.columns, self.engine.rows);
        self.pending_output.clear();
        self.output_flush_scheduled = false;
        self.early_output.clear();
        self.selection = None;
        self.cursor_visible = true;
    }

    fn status_text(&self) -> String {
        match self.status {
            TerminalStatus::Connecting => "Connecting…".into(),
            TerminalStatus::Open => "Connected".into(),
            TerminalStatus::Reconnecting => "Reconnecting…".into(),
            TerminalStatus::Exited(Some(code)) => format!("Exited ({code})"),
            TerminalStatus::Exited(None) => "Exited".into(),
            TerminalStatus::Error => self
                .status_message
                .clone()
                .unwrap_or_else(|| "Terminal unavailable".into()),
        }
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
            row.min(usize::from(self.engine.rows.saturating_sub(1))),
            column.min(usize::from(self.engine.columns.saturating_sub(1))),
        ))
    }
}

impl ChatView {
    pub(crate) fn terminal_visible(&self) -> bool {
        self.terminal_ui.visible
    }

    pub(crate) fn restore_terminal_preferences(
        &mut self,
        visible: bool,
        height: u16,
        window: &Window,
    ) {
        let maximum = (window.viewport_size().height * 0.72).max(px(MIN_HEIGHT));
        self.terminal_ui.visible = visible;
        self.terminal_ui.height =
            px(f32::from(height) * crate::zoom::factor()).clamp(px(MIN_HEIGHT), maximum);
    }

    pub(crate) fn terminal_preference_height(&self) -> u16 {
        terminal_preference_height(self.terminal_ui.height, crate::zoom::factor())
    }

    pub(crate) fn reset_terminal_preferences(&mut self, cx: &mut Context<Self>) {
        self.set_terminal_closed(cx);
        self.terminal_ui.height = px(DEFAULT_HEIGHT * crate::zoom::factor());
        self.terminal_ui.resize_drag = None;
        self.terminal_ui.viewport_bounds = None;
        cx.notify();
    }

    pub(crate) fn toggle_terminal_from_shell(&mut self, cx: &mut Context<Self>) {
        self.toggle_terminal(cx);
    }

    pub(super) fn scale_terminal_for_app_zoom(&mut self, ratio: f32) {
        self.terminal_ui.height *= ratio;
        self.terminal_ui.resize_drag = None;
        self.terminal_ui.viewport_bounds = None;
    }

    pub(super) fn release_terminal_for_session_change(&mut self, cx: &mut Context<Self>) {
        if let Some(terminal_id) = self.terminal_ui.terminal_id.take() {
            cx.emit(ChatEvent::TerminalClose { terminal_id });
        }
        self.terminal_ui.opening = false;
        self.terminal_ui.reset_engine();
        self.terminal_ui.blink_generation += 1;
    }

    pub(super) fn reopen_visible_terminal(&mut self, cx: &mut Context<Self>) {
        if self.terminal_ui.visible
            && self
                .session
                .as_ref()
                .is_some_and(|session| session.thread_id.is_some())
        {
            self.request_terminal_open(cx);
        }
    }

    fn toggle_terminal(&mut self, cx: &mut Context<Self>) {
        if self.terminal_ui.visible {
            self.close_terminal(cx);
        } else {
            self.terminal_ui.visible = true;
            self.terminal_ui.open_generation += 1;
            self.terminal_ui.reset_engine();
            self.request_terminal_open(cx);
            self.emit_terminal_preferences(cx);
        }
        cx.notify();
    }

    fn close_terminal(&mut self, cx: &mut Context<Self>) {
        self.set_terminal_closed(cx);
        self.emit_terminal_preferences(cx);
    }

    fn set_terminal_closed(&mut self, cx: &mut Context<Self>) {
        self.terminal_ui.visible = false;
        self.terminal_ui.opening = false;
        self.terminal_ui.blink_generation += 1;
        if let Some(terminal_id) = self.terminal_ui.terminal_id.take() {
            cx.emit(ChatEvent::TerminalClose { terminal_id });
        }
        self.terminal_ui.early_output.clear();
        self.terminal_ui.pending_output.clear();
    }

    fn emit_terminal_preferences(&self, cx: &mut Context<Self>) {
        cx.emit(ChatEvent::TerminalPreferencesChanged {
            visible: self.terminal_ui.visible,
            height: self.terminal_preference_height(),
        });
    }

    fn request_terminal_open(&mut self, cx: &mut Context<Self>) {
        if self.terminal_ui.opening || !self.terminal_ui.visible {
            return;
        }
        let Some(thread_id) = self
            .session
            .as_ref()
            .and_then(|session| session.thread_id.clone())
        else {
            return;
        };
        self.terminal_ui.opening = true;
        self.terminal_ui.status = TerminalStatus::Connecting;
        self.terminal_ui.status_message = None;
        cx.emit(ChatEvent::TerminalOpen {
            thread_id,
            columns: self.terminal_ui.engine.columns,
            rows: self.terminal_ui.engine.rows,
        });
    }

    fn restart_terminal(&mut self, cx: &mut Context<Self>) {
        if let Some(terminal_id) = self.terminal_ui.terminal_id.take() {
            cx.emit(ChatEvent::TerminalClose { terminal_id });
        }
        self.terminal_ui.opening = false;
        self.terminal_ui.reset_engine();
        self.request_terminal_open(cx);
        cx.notify();
    }

    pub(super) fn apply_terminal_connection(
        &mut self,
        connection: ConnectionState,
        cx: &mut Context<Self>,
    ) {
        self.terminal_ui.connection = connection;
        if !self.terminal_ui.visible {
            return;
        }
        match connection {
            ConnectionState::Open => {
                self.terminal_ui.opening = false;
                self.terminal_ui.terminal_id = None;
                self.terminal_ui.reset_engine();
                self.request_terminal_open(cx);
            }
            ConnectionState::Connecting | ConnectionState::Reconnecting => {
                self.terminal_ui.opening = false;
                self.terminal_ui.terminal_id = None;
                self.terminal_ui.status = TerminalStatus::Reconnecting;
                self.terminal_ui.status_message = None;
                self.terminal_ui.blink_generation += 1;
            }
            ConnectionState::Closed => {
                self.terminal_ui.opening = false;
                self.terminal_ui.terminal_id = None;
                self.terminal_ui.status = TerminalStatus::Error;
                self.terminal_ui.status_message = Some("The TasteCode server is unavailable.".into());
                self.terminal_ui.blink_generation += 1;
            }
        }
        cx.notify();
    }

    pub(super) fn apply_terminal_opened(
        &mut self,
        thread_id: String,
        terminal_id: String,
        cx: &mut Context<Self>,
    ) {
        let owns_response = self.terminal_ui.visible && self.is_selected(&thread_id);
        if !owns_response {
            cx.emit(ChatEvent::TerminalClose { terminal_id });
            return;
        }
        self.terminal_ui.opening = false;
        self.terminal_ui.terminal_id = Some(terminal_id.clone());
        self.terminal_ui.status = TerminalStatus::Open;
        self.terminal_ui.status_message = None;
        self.terminal_ui.focus_when_ready = true;
        for data in self.terminal_ui.early_output.take(&terminal_id) {
            self.terminal_ui.pending_output.push(data);
        }
        self.flush_terminal_output(cx);
        self.start_terminal_cursor_blink(cx);
        cx.notify();
    }

    pub(super) fn apply_terminal_output(
        &mut self,
        terminal_id: String,
        data: String,
        cx: &mut Context<Self>,
    ) {
        if self.terminal_ui.terminal_id.as_deref() == Some(terminal_id.as_str()) {
            self.terminal_ui.pending_output.push(data);
            if !self.terminal_ui.output_flush_scheduled {
                self.terminal_ui.output_flush_scheduled = true;
                cx.spawn(async move |view, cx| {
                    cx.background_executor().timer(LIVE_FLUSH_INTERVAL).await;
                    let _ = view.update(cx, |this, cx| this.flush_terminal_output(cx));
                })
                .detach();
            }
        } else if self.terminal_ui.terminal_id.is_none() && self.terminal_ui.opening {
            self.terminal_ui.early_output.push(terminal_id, data);
        }
    }

    fn flush_terminal_output(&mut self, cx: &mut Context<Self>) {
        self.terminal_ui.output_flush_scheduled = false;
        if self.terminal_ui.pending_output.is_empty() {
            return;
        }
        for chunk in std::mem::take(&mut self.terminal_ui.pending_output) {
            self.terminal_ui.engine.advance(&chunk);
        }
        self.terminal_ui.cursor_visible = true;
        self.handle_terminal_engine_events(cx);
        cx.notify();
    }

    fn handle_terminal_engine_events(&mut self, cx: &mut Context<Self>) {
        let Some(terminal_id) = self.terminal_ui.terminal_id.clone() else {
            return;
        };
        for event in self.terminal_ui.engine.drain_events() {
            match event {
                EngineEvent::Input(data) => {
                    cx.emit(ChatEvent::TerminalInput {
                        terminal_id: terminal_id.clone(),
                        data,
                    });
                }
                EngineEvent::ClipboardStore(text) => {
                    cx.write_to_clipboard(ClipboardItem::new_string(text));
                }
                EngineEvent::ClipboardLoad(format) => {
                    if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
                        cx.emit(ChatEvent::TerminalInput {
                            terminal_id: terminal_id.clone(),
                            data: format(&text),
                        });
                    }
                }
                EngineEvent::ColorRequest(index, format) => {
                    cx.emit(ChatEvent::TerminalInput {
                        terminal_id: terminal_id.clone(),
                        data: format(ansi_index_rgb(index, self.theme)),
                    });
                }
            }
        }
    }

    pub(super) fn apply_terminal_exit(
        &mut self,
        terminal_id: String,
        exit_code: Option<i32>,
        cx: &mut Context<Self>,
    ) {
        if self.terminal_ui.terminal_id.as_deref() != Some(terminal_id.as_str()) {
            return;
        }
        self.flush_terminal_output(cx);
        self.terminal_ui.terminal_id = None;
        self.terminal_ui.early_output.clear();
        self.terminal_ui.status = TerminalStatus::Exited(exit_code);
        self.terminal_ui.status_message = None;
        self.terminal_ui.blink_generation += 1;
        cx.notify();
    }

    pub(super) fn apply_terminal_open_error(
        &mut self,
        thread_id: String,
        message: String,
        cx: &mut Context<Self>,
    ) {
        if !self.is_selected(&thread_id) || !self.terminal_ui.visible {
            return;
        }
        self.terminal_ui.opening = false;
        self.terminal_ui.status = TerminalStatus::Error;
        self.terminal_ui.status_message = Some(message);
        self.terminal_ui.early_output.clear();
        self.terminal_ui.blink_generation += 1;
        cx.notify();
    }

    pub(super) fn apply_terminal_error(
        &mut self,
        terminal_id: String,
        message: String,
        cx: &mut Context<Self>,
    ) {
        if self.terminal_ui.terminal_id.as_deref() != Some(terminal_id.as_str()) {
            return;
        }
        self.terminal_ui.status = TerminalStatus::Error;
        self.terminal_ui.status_message = Some(message);
        self.terminal_ui.blink_generation += 1;
        cx.notify();
    }

    fn start_terminal_cursor_blink(&mut self, cx: &mut Context<Self>) {
        self.terminal_ui.blink_generation += 1;
        let generation = self.terminal_ui.blink_generation;
        cx.spawn(async move |view, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(530))
                    .await;
                let keep_blinking = view.update(cx, |this, cx| {
                    if this.terminal_ui.blink_generation != generation
                        || !this.terminal_ui.visible
                        || this.terminal_ui.status != TerminalStatus::Open
                    {
                        return false;
                    }
                    this.terminal_ui.cursor_visible = !this.terminal_ui.cursor_visible;
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

    fn send_terminal_input(&mut self, data: String, cx: &mut Context<Self>) {
        let Some(terminal_id) = self.terminal_ui.terminal_id.clone() else {
            return;
        };
        self.terminal_ui.selection = None;
        self.terminal_ui.cursor_visible = true;
        cx.emit(ChatEvent::TerminalInput { terminal_id, data });
    }

    fn terminal_key_down(
        &mut self,
        event: &KeyDownEvent,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.terminal_ui.status != TerminalStatus::Open {
            return;
        }
        let key = event.keystroke.key.to_ascii_lowercase();
        if event.keystroke.modifiers.secondary() && key == "c" && self.terminal_ui.has_selection() {
            self.copy_terminal_selection(cx);
            return;
        }
        if event.keystroke.modifiers.secondary() && key == "v" {
            if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
                let data = terminal_paste_data(text, self.terminal_ui.engine.bracketed_paste());
                self.send_terminal_input(data, cx);
            }
            return;
        }
        if let Some(data) = terminal_input_for_keystroke(
            &event.keystroke,
            self.terminal_ui.engine.application_cursor(),
        ) {
            self.send_terminal_input(data, cx);
        }
    }

    fn copy_terminal_selection(&self, cx: &mut Context<Self>) {
        let Some(selection) = self.terminal_ui.selection else {
            return;
        };
        if let Some(text) = self.terminal_ui.engine.selected_text(selection)
            && !text.is_empty()
        {
            cx.write_to_clipboard(ClipboardItem::new_string(text));
        }
    }

    fn terminal_mouse_down(
        &mut self,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.terminal_ui.focus.focus(window);
        let Some(cell) = self.terminal_ui.cell_at(event.position) else {
            return;
        };
        self.terminal_ui.selecting = true;
        let anchor = if event.modifiers.shift {
            self.terminal_ui
                .selection
                .map_or(cell, |selection| selection.anchor)
        } else {
            cell
        };
        self.terminal_ui.selection = Some(TerminalSelection {
            anchor,
            focus: cell,
        });
        cx.notify();
    }

    fn terminal_mouse_move(&mut self, event: &MouseMoveEvent, cx: &mut Context<Self>) {
        if !self.terminal_ui.selecting || !event.dragging() {
            return;
        }
        let Some(cell) = self.terminal_ui.cell_at(event.position) else {
            return;
        };
        if let Some(selection) = &mut self.terminal_ui.selection {
            selection.focus = cell;
            cx.notify();
        }
    }

    fn terminal_mouse_up(
        &mut self,
        _event: &MouseUpEvent,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.terminal_ui.selecting = false;
        if self
            .terminal_ui
            .selection
            .is_some_and(TerminalSelection::is_empty)
        {
            self.terminal_ui.selection = None;
        }
        cx.notify();
    }

    fn terminal_scroll(&mut self, event: &ScrollWheelEvent, cx: &mut Context<Self>) {
        let lines = match event.delta {
            ScrollDelta::Lines(delta) => delta.y.round() as i32,
            ScrollDelta::Pixels(delta) => (delta.y / px(CELL_HEIGHT)).round() as i32,
        };
        self.terminal_ui.engine.scroll(lines);
        self.terminal_ui.selection = None;
        cx.notify();
    }

    fn terminal_viewport_bounds_changed(&mut self, bounds: Bounds<Pixels>, cx: &mut Context<Self>) {
        self.terminal_ui.viewport_bounds = Some(bounds);
        let columns = ((bounds.size.width / px(CELL_WIDTH)).floor() as u16).clamp(1, 1_000);
        let rows = ((bounds.size.height / px(CELL_HEIGHT)).floor() as u16).clamp(1, 1_000);
        if columns == self.terminal_ui.engine.columns && rows == self.terminal_ui.engine.rows {
            return;
        }
        self.terminal_ui.engine.resize(columns, rows);
        self.terminal_ui.selection = None;
        if let Some(terminal_id) = self.terminal_ui.terminal_id.clone() {
            cx.emit(ChatEvent::TerminalResize {
                terminal_id,
                columns,
                rows,
            });
        }
        cx.notify();
    }

    fn begin_terminal_resize(&mut self, event: &MouseDownEvent, cx: &mut Context<Self>) {
        self.terminal_ui.resize_drag = Some(ResizeDrag {
            start_y: event.position.y,
            start_height: self.terminal_ui.height,
        });
        cx.stop_propagation();
    }

    pub(super) fn update_terminal_resize(
        &mut self,
        event: &MouseMoveEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(drag) = &self.terminal_ui.resize_drag else {
            return;
        };
        if !event.dragging() {
            self.terminal_ui.resize_drag = None;
            return;
        }
        let maximum = (window.viewport_size().height * 0.72).max(px(MIN_HEIGHT));
        self.terminal_ui.height =
            (drag.start_height + drag.start_y - event.position.y).clamp(px(MIN_HEIGHT), maximum);
        cx.notify();
    }

    pub(super) fn finish_terminal_resize(&mut self, cx: &mut Context<Self>) {
        if self.terminal_ui.resize_drag.take().is_some() {
            self.emit_terminal_preferences(cx);
            cx.notify();
        }
    }

    pub(super) fn terminal_pane(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        if !self.terminal_ui.visible
            || self
                .session
                .as_ref()
                .is_none_or(|session| session.thread_id.is_none())
        {
            return None;
        }
        if self.terminal_ui.focus_when_ready {
            self.terminal_ui.focus.focus(window);
            self.terminal_ui.focus_when_ready = false;
        }

        let theme = self.theme;
        let frame = self.terminal_ui.engine.frame(
            theme,
            self.terminal_ui.selection,
            self.terminal_ui.cursor_visible,
        );
        let status = self.terminal_ui.status;
        let status_text = self.terminal_ui.status_text();
        let can_restart = matches!(status, TerminalStatus::Exited(_) | TerminalStatus::Error);
        let has_selection = self.terminal_ui.has_selection();
        let focused = self.terminal_ui.focus.is_focused(window);
        let open_generation = self.terminal_ui.open_generation;
        let entity = cx.entity();

        let rows = frame.rows.into_iter().map(|runs| {
            div()
                .h(px(CELL_HEIGHT))
                .min_h(px(CELL_HEIGHT))
                .w_full()
                .flex()
                .items_center()
                .children(runs.into_iter().map(render_terminal_run))
        });

        let terminal_grid = div()
            .id("terminal-grid")
            .relative()
            .size_full()
            .overflow_hidden()
            .child(
                canvas(
                    move |bounds, _, cx| {
                        entity.update(cx, |this, cx| {
                            this.terminal_viewport_bounds_changed(bounds, cx);
                        });
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .inset_0(),
            )
            .child(div().size_full().overflow_hidden().children(rows));

        let viewport = div()
            .id("terminal-viewport")
            .relative()
            .min_h(px(0.0))
            .flex_1()
            .flex()
            .overflow_hidden()
            .pl(px(14.0))
            .pr(px(12.0))
            .pb(px(8.0))
            .font_family("Geist Mono")
            .text_size(px(12.5))
            .line_height(px(CELL_HEIGHT))
            .cursor_text()
            .track_focus(&self.terminal_ui.focus)
            .on_key_down(cx.listener(Self::terminal_key_down))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::terminal_mouse_down))
            .on_mouse_move(cx.listener(|this, event, _window, cx| {
                this.terminal_mouse_move(event, cx);
            }))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::terminal_mouse_up))
            .on_scroll_wheel(cx.listener(|this, event, _window, cx| {
                this.terminal_scroll(event, cx);
            }))
            .child(terminal_grid)
            .when(focused, |viewport| {
                viewport.child(
                    div()
                        .absolute()
                        .top_0()
                        .bottom_0()
                        .left_0()
                        .w(px(2.0))
                        .bg(theme.attention.hsla().opacity(0.55)),
                )
            });

        let header = div()
            .h(px(32.0))
            .min_h(px(32.0))
            .flex()
            .items_center()
            .gap(px(8.0))
            .pl(px(14.0))
            .pr(px(10.0))
            .pt(px(3.0))
            .pb(px(2.0))
            .child(
                div()
                    .text_size(px(12.5))
                    .font_weight(FontWeight(520.0))
                    .text_color(theme.text_2.hsla())
                    .child("Terminal"),
            )
            .child(
                div()
                    .max_w(px(360.0))
                    .truncate()
                    .text_size(px(11.5))
                    .text_color(match status {
                        TerminalStatus::Open => theme.success.hsla(),
                        TerminalStatus::Error => theme.error.hsla(),
                        TerminalStatus::Connecting
                        | TerminalStatus::Reconnecting
                        | TerminalStatus::Exited(_) => theme.text_3.hsla(),
                    })
                    .child(status_text),
            )
            .child(
                div()
                    .ml_auto()
                    .flex()
                    .items_center()
                    .gap(px(1.0))
                    .when(can_restart, |actions| {
                        actions.child(terminal_action_button(
                            "terminal-restart",
                            "icons/rotate-ccw.svg",
                            13.0,
                            true,
                            theme,
                            cx.listener(|this, _event, _window, cx| {
                                this.restart_terminal(cx);
                            }),
                        ))
                    })
                    .child(terminal_action_button(
                        "terminal-copy",
                        "icons/copy.svg",
                        13.0,
                        has_selection,
                        theme,
                        cx.listener(|this, _event, _window, cx| {
                            this.copy_terminal_selection(cx);
                        }),
                    ))
                    .child(terminal_action_button(
                        "terminal-close",
                        "icons/x.svg",
                        14.0,
                        true,
                        theme,
                        cx.listener(|this, _event, _window, cx| {
                            this.close_terminal(cx);
                            cx.notify();
                        }),
                    )),
            );

        Some(
            div()
                .id("terminal-pane")
                .relative()
                .h(self.terminal_ui.height)
                .min_h(px(MIN_HEIGHT))
                .w_full()
                .flex_none()
                .flex()
                .flex_col()
                .overflow_hidden()
                .border_t_1()
                .border_color(theme.line.hsla())
                .bg(theme.background.hsla())
                .child(
                    div()
                        .id("terminal-resize")
                        .absolute()
                        .top(px(-3.0))
                        .left_0()
                        .w_full()
                        .h(px(7.0))
                        .group("terminal-resize")
                        .cursor_ns_resize()
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(|this, event, _window, cx| {
                                this.begin_terminal_resize(event, cx);
                            }),
                        )
                        .child(
                            div()
                                .absolute()
                                .top(px(3.0))
                                .left(relative(0.5))
                                .ml(px(-15.0))
                                .w(px(30.0))
                                .h(px(1.0))
                                .bg(theme.line_strong.hsla())
                                .opacity(0.0)
                                .group_hover("terminal-resize", |handle| handle.opacity(1.0)),
                        ),
                )
                .child(header)
                .child(viewport)
                .with_animation(
                    ("terminal-in", open_generation),
                    Animation::new(theme.motion_duration(Duration::from_millis(200)))
                        .with_easing(crate::theme::web_ease_out),
                    |pane, delta| pane.bottom(px(-8.0 * (1.0 - delta))).opacity(delta),
                )
                .into_any_element(),
        )
    }
}

fn terminal_preference_height(height: Pixels, zoom: f32) -> u16 {
    (f32::from(height) / zoom)
        .round()
        .clamp(MIN_HEIGHT, f32::from(u16::MAX)) as u16
}

fn terminal_action_button(
    id: &'static str,
    icon: &'static str,
    icon_size: f32,
    enabled: bool,
    theme: Theme,
    action: impl Fn(&gpui::ClickEvent, &mut Window, &mut App) + 'static,
) -> AnyElement {
    let hover_group = SharedString::from(id);
    let icon_id = SharedString::from(format!("{id}-icon"));
    let icon_press_id = SharedString::from(format!("{id}-icon-press"));
    div()
        .id(id)
        .group(hover_group.clone())
        .size(px(22.0))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(3.0))
        .text_color(theme.text_3.hsla())
        .opacity(0.0)
        .hover(move |style| {
            style
                .bg(theme.surface_2.hsla())
                .text_color(theme.text.hsla())
                .opacity(1.0)
        })
        .when(enabled, |button| {
            button
                .cursor_pointer()
                .active(|style| style.size(px(20.68)).m(px(0.66)))
                .on_click(action)
        })
        .child(
            div()
                .id(icon_press_id)
                .size(px(icon_size))
                .when(enabled, |icon_wrapper| {
                    icon_wrapper.group_active(hover_group.clone(), move |style| {
                        style.size(px(icon_size * 0.94)).m(px(icon_size * 0.03))
                    })
                })
                .child(motion_icon(icon_id, icon, icon_size, hover_group, theme).size_full()),
        )
        .into_any_element()
}

pub(crate) fn render_terminal_run(run: TerminalRun) -> AnyElement {
    let style = run.style;
    div()
        .h_full()
        .w(px(run.columns as f32 * CELL_WIDTH))
        .min_w(px(run.columns as f32 * CELL_WIDTH))
        .overflow_hidden()
        .whitespace_nowrap()
        .text_color(rgb(style.foreground))
        .when_some(style.background, |run, background| run.bg(rgb(background)))
        .when(style.bold, |run| run.font_weight(FontWeight::SEMIBOLD))
        .when(style.italic, |run| run.italic())
        .when(style.underline, |run| run.underline())
        .when(
            style.cursor == Some(TerminalCursorStyle::HollowBlock),
            |run| run.border_1().border_color(rgb(style.cursor_color)),
        )
        .when(
            style.cursor == Some(TerminalCursorStyle::Underline),
            |run| run.border_b_2().border_color(rgb(style.cursor_color)),
        )
        .when(style.cursor == Some(TerminalCursorStyle::Beam), |run| {
            run.border_l_2().border_color(rgb(style.cursor_color))
        })
        .child(run.text)
        .into_any_element()
}

fn terminal_style(
    cell: &alacritty_terminal::term::cell::Cell,
    theme: Theme,
    selected: bool,
    cursor: Option<CursorShape>,
) -> TerminalTextStyle {
    let inverse = cell.flags.contains(Flags::INVERSE);
    let mut foreground = terminal_color(
        if inverse { cell.bg } else { cell.fg },
        true,
        cell.flags,
        theme,
    );
    let mut background = if !inverse && matches!(cell.bg, Color::Named(NamedColor::Background)) {
        None
    } else {
        Some(terminal_color(
            if inverse { cell.fg } else { cell.bg },
            false,
            cell.flags,
            theme,
        ))
    };
    if selected {
        foreground = theme.text.0;
        background = Some(theme.surface_3.0);
    }
    if cursor == Some(CursorShape::Block) {
        foreground = theme.background.0;
        background = Some(theme.text_2.0);
    }
    TerminalTextStyle {
        foreground,
        background,
        bold: cell.flags.contains(Flags::BOLD),
        italic: cell.flags.contains(Flags::ITALIC),
        underline: cell.flags.intersects(Flags::ALL_UNDERLINES),
        cursor: match cursor {
            Some(CursorShape::Block) => Some(TerminalCursorStyle::Block),
            Some(CursorShape::HollowBlock) => Some(TerminalCursorStyle::HollowBlock),
            Some(CursorShape::Underline) => Some(TerminalCursorStyle::Underline),
            Some(CursorShape::Beam) => Some(TerminalCursorStyle::Beam),
            Some(CursorShape::Hidden) | None => None,
        },
        cursor_color: theme.text_2.0,
    }
}

fn terminal_color(color: Color, foreground: bool, flags: Flags, theme: Theme) -> u32 {
    let color = match color {
        Color::Named(named) if foreground && flags.contains(Flags::BOLD) => {
            Color::Named(named.to_bright())
        }
        Color::Named(named) if flags.contains(Flags::DIM) => Color::Named(named.to_dim()),
        color => color,
    };
    match color {
        Color::Spec(color) => rgb_u32(if flags.contains(Flags::DIM) {
            dim_rgb(color)
        } else {
            color
        }),
        Color::Indexed(index) => rgb_u32(ansi_index_rgb(usize::from(index), theme)),
        Color::Named(named) => named_color(named, theme),
    }
}

fn named_color(color: NamedColor, theme: Theme) -> u32 {
    match color {
        NamedColor::Foreground | NamedColor::BrightForeground => theme.text.0,
        NamedColor::DimForeground => theme.text_2.0,
        NamedColor::Background => theme.background.0,
        NamedColor::Cursor => theme.text_2.0,
        color => {
            let (index, dim) = match color {
                NamedColor::Black => (0, false),
                NamedColor::Red => (1, false),
                NamedColor::Green => (2, false),
                NamedColor::Yellow => (3, false),
                NamedColor::Blue => (4, false),
                NamedColor::Magenta => (5, false),
                NamedColor::Cyan => (6, false),
                NamedColor::White => (7, false),
                NamedColor::BrightBlack => (8, false),
                NamedColor::BrightRed => (9, false),
                NamedColor::BrightGreen => (10, false),
                NamedColor::BrightYellow => (11, false),
                NamedColor::BrightBlue => (12, false),
                NamedColor::BrightMagenta => (13, false),
                NamedColor::BrightCyan => (14, false),
                NamedColor::BrightWhite => (15, false),
                NamedColor::DimBlack => (0, true),
                NamedColor::DimRed => (1, true),
                NamedColor::DimGreen => (2, true),
                NamedColor::DimYellow => (3, true),
                NamedColor::DimBlue => (4, true),
                NamedColor::DimMagenta => (5, true),
                NamedColor::DimCyan => (6, true),
                NamedColor::DimWhite => (7, true),
                NamedColor::Foreground
                | NamedColor::Background
                | NamedColor::Cursor
                | NamedColor::BrightForeground
                | NamedColor::DimForeground => unreachable!(),
            };
            let color = ansi_index_rgb(index, theme);
            rgb_u32(if dim { dim_rgb(color) } else { color })
        }
    }
}

pub(crate) fn ansi_index_rgb(index: usize, theme: Theme) -> TerminalRgb {
    let palette = match theme.mode {
        crate::theme::ThemeMode::Dark => [
            0x282c34, 0xe06c75, 0x98c379, 0xd8b26e, 0x61afef, 0xc678dd, 0x56b6c2, 0xd7dae0,
            0x5c6370, 0xef8189, 0xa9d38c, 0xe6c384, 0x7cc0f4, 0xd48fe6, 0x6fc9d4, 0xeceef2,
        ],
        crate::theme::ThemeMode::Light => [
            0x383a42, 0xca4a55, 0x4f8a3d, 0xa3841c, 0x2f6fdb, 0xa24bb5, 0x0d7f8f, 0xc9cdd4,
            0x6b6f78, 0xe05561, 0x5fa14c, 0xb9962e, 0x4a84e6, 0xb563c8, 0x1f97a8, 0xe8eaee,
        ],
    };
    let value = match index {
        0..=15 => palette[index],
        16..=231 => {
            let index = index - 16;
            let component = |value: usize| if value == 0 { 0 } else { 55 + value * 40 };
            let red = component(index / 36);
            let green = component((index / 6) % 6);
            let blue = component(index % 6);
            ((red as u32) << 16) | ((green as u32) << 8) | blue as u32
        }
        232..=255 => {
            let gray = 8 + (index - 232) * 10;
            ((gray as u32) << 16) | ((gray as u32) << 8) | gray as u32
        }
        256 => theme.text.0,
        257 => theme.background.0,
        258 => theme.text_2.0,
        259..=266 => rgb_u32(dim_rgb(TerminalRgb {
            r: (palette[index - 259] >> 16) as u8,
            g: (palette[index - 259] >> 8) as u8,
            b: palette[index - 259] as u8,
        })),
        267 => theme.text.0,
        268 => theme.text_2.0,
        _ => theme.text.0,
    };
    TerminalRgb {
        r: (value >> 16) as u8,
        g: (value >> 8) as u8,
        b: value as u8,
    }
}

fn dim_rgb(color: TerminalRgb) -> TerminalRgb {
    TerminalRgb {
        r: (f32::from(color.r) * 0.66) as u8,
        g: (f32::from(color.g) * 0.66) as u8,
        b: (f32::from(color.b) * 0.66) as u8,
    }
}

fn rgb_u32(color: TerminalRgb) -> u32 {
    (u32::from(color.r) << 16) | (u32::from(color.g) << 8) | u32::from(color.b)
}

pub(crate) fn terminal_input_for_keystroke(
    keystroke: &Keystroke,
    application_cursor: bool,
) -> Option<String> {
    let key = keystroke.key.to_ascii_lowercase();
    if keystroke.modifiers.platform {
        return None;
    }
    let modifier = 1
        + u8::from(keystroke.modifiers.shift)
        + 2 * u8::from(keystroke.modifiers.alt)
        + 4 * u8::from(keystroke.modifiers.control);
    let cursor_key = |final_byte: char| {
        if modifier > 1 {
            format!("\u{1b}[1;{modifier}{final_byte}")
        } else if application_cursor {
            format!("\u{1b}O{final_byte}")
        } else {
            format!("\u{1b}[{final_byte}")
        }
    };
    let tilde_key = |number: u8| {
        if modifier > 1 {
            format!("\u{1b}[{number};{modifier}~")
        } else {
            format!("\u{1b}[{number}~")
        }
    };
    let function_key = |final_byte: char| {
        if modifier > 1 {
            format!("\u{1b}[1;{modifier}{final_byte}")
        } else {
            format!("\u{1b}O{final_byte}")
        }
    };

    let special = match key.as_str() {
        "up" => Some(cursor_key('A')),
        "down" => Some(cursor_key('B')),
        "right" => Some(cursor_key('C')),
        "left" => Some(cursor_key('D')),
        "home" => Some(cursor_key('H')),
        "end" => Some(cursor_key('F')),
        "insert" => Some(tilde_key(2)),
        "delete" => Some(tilde_key(3)),
        "pageup" => Some(tilde_key(5)),
        "pagedown" => Some(tilde_key(6)),
        "f1" => Some(function_key('P')),
        "f2" => Some(function_key('Q')),
        "f3" => Some(function_key('R')),
        "f4" => Some(function_key('S')),
        "f5" => Some(tilde_key(15)),
        "f6" => Some(tilde_key(17)),
        "f7" => Some(tilde_key(18)),
        "f8" => Some(tilde_key(19)),
        "f9" => Some(tilde_key(20)),
        "f10" => Some(tilde_key(21)),
        "f11" => Some(tilde_key(23)),
        "f12" => Some(tilde_key(24)),
        _ => None,
    };
    if let Some(special) = special {
        return Some(special);
    }
    let basic = match key.as_str() {
        "enter" => Some("\r"),
        "backspace" => Some("\u{7f}"),
        "tab" => Some(if keystroke.modifiers.shift {
            "\u{1b}[Z"
        } else {
            "\t"
        }),
        "escape" => Some("\u{1b}"),
        _ => None,
    };
    if let Some(basic) = basic {
        return Some(if keystroke.modifiers.alt {
            format!("\u{1b}{basic}")
        } else {
            basic.into()
        });
    }
    if keystroke.modifiers.control {
        let byte = match key.as_str() {
            "@" | "space" => 0,
            value if value.len() == 1 && value.as_bytes()[0].is_ascii_lowercase() => {
                value.as_bytes()[0] - b'a' + 1
            }
            "[" => 27,
            "\\" => 28,
            "]" => 29,
            "^" => 30,
            "_" => 31,
            "?" => 127,
            _ => return None,
        };
        let control = char::from(byte);
        return Some(if keystroke.modifiers.alt {
            format!("\u{1b}{control}")
        } else {
            control.to_string()
        });
    }

    keystroke.key_char.as_ref().map(|character| {
        if keystroke.modifiers.alt {
            format!("\u{1b}{character}")
        } else {
            character.clone()
        }
    })
}

pub(crate) fn terminal_paste_data(text: String, bracketed: bool) -> String {
    let text = text.replace("\r\n", "\r").replace('\n', "\r");
    if bracketed {
        let text = text.replace("\u{1b}[201~", "");
        format!("\u{1b}[200~{text}\u{1b}[201~")
    } else {
        text
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::Modifiers;

    #[test]
    fn ansi_chunks_are_applied_incrementally() {
        let mut engine = TerminalEngine::new(12, 2);
        engine.advance("hello\r");
        engine.advance("\u{1b}[31mR\u{1b}[0m");
        let frame = engine.frame(Theme::dark(), None, false);

        assert_eq!(frame.rows[0][0].text, "R");
        assert_eq!(frame.rows[0][0].style.foreground, 0xe06c75);
        assert!(frame.rows[0].iter().map(|run| run.columns).sum::<usize>() >= 12);
    }

    #[test]
    fn early_output_is_isolated_and_bounded() {
        let mut output = EarlyOutput::default();
        output.push("other".into(), "wrong".into());
        output.push("ours".into(), "first".into());
        output.push("ours".into(), " second".into());

        assert_eq!(output.take("ours"), vec!["first", " second"]);
        assert!(output.by_terminal.is_empty());

        output.push("large".into(), "x".repeat(EARLY_OUTPUT_LIMIT * 2));
        assert!(output.bytes <= EARLY_TERMINAL_LIMIT);
    }

    #[test]
    fn terminal_keys_match_common_pty_sequences() {
        let key = |key: &str, key_char: Option<&str>, modifiers: Modifiers| Keystroke {
            key: key.into(),
            key_char: key_char.map(str::to_owned),
            modifiers,
        };

        assert_eq!(
            terminal_input_for_keystroke(&key("up", None, Modifiers::default()), false).as_deref(),
            Some("\u{1b}[A")
        );
        assert_eq!(
            terminal_input_for_keystroke(
                &key(
                    "c",
                    Some("c"),
                    Modifiers {
                        control: true,
                        ..Modifiers::default()
                    }
                ),
                false
            )
            .as_deref(),
            Some("\u{3}")
        );
        assert_eq!(
            terminal_input_for_keystroke(
                &key(
                    "x",
                    None,
                    Modifiers {
                        platform: true,
                        ..Modifiers::default()
                    }
                ),
                false
            ),
            None
        );
        assert_eq!(
            terminal_input_for_keystroke(&key("up", None, Modifiers::default()), true).as_deref(),
            Some("\u{1b}OA")
        );
        assert_eq!(
            terminal_paste_data("first\nsecond".into(), true),
            "\u{1b}[200~first\rsecond\u{1b}[201~"
        );
    }

    #[test]
    fn restored_terminal_height_persists_in_unscaled_app_units() {
        assert_eq!(terminal_preference_height(px(260.0), 1.0), 260);
        assert_eq!(terminal_preference_height(px(520.0), 2.0), 260);
        assert_eq!(terminal_preference_height(px(120.0), 1.0), 160);
    }
}
