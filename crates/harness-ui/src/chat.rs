mod code_extensions;
mod diff;
mod markdown;
mod presentation;
mod search;
pub(crate) mod terminal;
mod thinking_orb;
mod transcript;
mod voice;

use crate::chrome;
use crate::client_state::{ChatUpdate, ModelChoice};
use crate::model_selection::{
    fast_service_tier, filter_model_choices_by_query, is_fast_mode_enabled, source_key,
};
use crate::motion_icon::{IconTransformation, motion_icon};
use crate::provider_icon::{provider_mark, provider_mark_path};
use crate::shortcuts::is_button_activation;
use crate::theme::{CHAT_WIDTH, RADIUS_XL, Theme, ThemeMode, cubic_bezier_timing};
use crate::tracked_text::tracked_text;
use crate::zoom::px;
use diff::DiffUiState;
use gpui::{
    Animation, AnimationExt, AnyElement, App, Background, Bounds, BoxShadow, ClipboardEntry,
    Context, Entity, EventEmitter, ExternalPaths, FocusHandle, Focusable, FontWeight,
    HighlightStyle, Image, ImageFormat, IntoElement, KeyDownEvent, LineFragment, ListAlignment,
    ListOffset, ListState, ObjectFit, PathBuilder, Pixels, Point, Render, RenderOnce, Rgba,
    ScrollWheelEvent, SharedString, StyledImage, StyledText, WeakEntity, Window, canvas, deferred,
    div, fill, img, linear_color_stop, linear_gradient, point, prelude::*, relative, size, svg,
};
use gpui_component::input::{Input, InputEvent, InputState};
use gpui_component::{RopeExt, Sizable as _};
use harness_protocol::{
    ApprovalDecision, ApprovalKind, ApprovalMode, ApprovalReview, ApprovalReviewStatus,
    CheckpointSummary, DiffDecision, DomainEvent, Item, ItemStatus, ItemType, MessageRole,
    ProviderId, QueueDirection, QueuedTurn, RiskLevel, ThreadEventPush, ThreadQueueResult, Turn,
    TurnStatus, Usage, UserInputQuestion, VoiceMimeType, VoiceTranscribeParams,
};
use harness_state::{ApplyOutcome, HistoryError, ThreadState};
use markdown::StreamRevealBatch;
use presentation::TranscriptPresentation;
use search::ThreadSearchState;
use std::cell::Cell;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs::OpenOptions;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use terminal::TerminalUiState;
use voice::{MAX_RECORDING_DURATION, VOICE_SAMPLE_RATE, VoiceRecorder};

const LIVE_FLUSH_INTERVAL: Duration = Duration::from_millis(16);
const VOICE_LEVEL_INTERVAL: Duration = Duration::from_millis(45);
const MAX_WAVEFORM_LEVELS: usize = 160;
const MAX_PASTED_IMAGE_BYTES: usize = 25 * 1024 * 1024;
const TRANSCRIPT_BOTTOM_SLACK: f32 = 80.0;
const DESIGN_BEAM_DURATION: Duration = Duration::from_millis(2_400);
const SEND_BEAM_DURATION: Duration = Duration::from_millis(1_960);
const COMPOSER_DOCK_DURATION: Duration = Duration::from_millis(180);
const COMPOSER_TOOLS_HEIGHT: f32 = 46.0;
const BRIEF_CARD_GAP: f32 = 8.0;
const BRIEF_STATUS_GAP: f32 = 6.0;
const BRIEF_ENTRY_OFFSET: f32 = 8.0;
const COMPOSER_MENU_GAP: f32 = 6.0;
const COMPOSER_MENU_VIEWPORT_GUTTER: f32 = 8.0;
const COMPOSER_MENU_MAX_HEIGHT: f32 = 340.0;
const MODEL_MENU_TRANSLATE_X: f32 = 28.0;
const COMPOSER_DOCKED_BOTTOM_PADDING: f32 = 12.0;
const MODEL_PICKER_WIDTH: f32 = 382.0;
const MODEL_PICKER_PANEL_HEIGHT: f32 = 337.0;
const MODEL_CONTROLS_PADDING: f32 = 8.0;
const EFFORT_SLIDER_HEIGHT: f32 = 36.0;
const EFFORT_SLIDER_INSET: f32 = 2.0;
const EFFORT_SLIDER_MIN_FILL: f32 = 44.0;
const EFFORT_DITHER_FADE_IN: Duration = Duration::from_millis(150);
const EFFORT_DITHER_FADE_OUT: Duration = Duration::from_millis(140);
const MENU_ENTRY_SCALE_FROM: f32 = 0.97;
pub(crate) const DESIGN_BRIEF_ATTACHMENT: &str = "personal-harness://design-brief-v1";

fn menu_entry_scale(progress: f32) -> f32 {
    MENU_ENTRY_SCALE_FROM + (1.0 - MENU_ENTRY_SCALE_FROM) * progress
}

fn menu_entry_animation(theme: Theme) -> Animation {
    Animation::new(theme.motion.fast).with_easing(crate::theme::web_ease_out)
}

fn menu_entry_icon(
    animation_id: impl Into<gpui::ElementId>,
    icon_id: impl Into<gpui::ElementId>,
    icon_path: &'static str,
    size: f32,
    hover_group: impl Into<SharedString>,
    theme: Theme,
) -> AnyElement {
    div()
        .size(px(size))
        .flex_none()
        .child(motion_icon(icon_id, icon_path, size, hover_group, theme).size_full())
        .with_animation(
            animation_id,
            menu_entry_animation(theme),
            move |icon, delta| icon.size(px(size * menu_entry_scale(delta))),
        )
        .into_any_element()
}

#[derive(Clone)]
pub(crate) struct SessionContext {
    pub(crate) thread_id: Option<String>,
    pub(crate) title: String,
    pub(crate) project_path: String,
    pub(crate) project_name: String,
    pub(crate) provider: Option<ProviderId>,
}

pub(crate) enum ChatEvent {
    ProjectRequired,
    NeedHistory {
        thread_id: String,
        after_seq: Option<u64>,
    },
    Submit {
        thread_id: String,
        text: String,
        attachments: Vec<String>,
        steer: bool,
        model: Option<String>,
        effort: Option<String>,
        service_tier: Option<String>,
        optimistic_queue_id: Option<String>,
        steer_echo_after_row: Option<usize>,
        started_echo_after_row: Option<usize>,
    },
    Interrupt {
        thread_id: String,
    },
    DeleteQueuedTurn {
        thread_id: String,
        queued_turn_id: String,
    },
    MoveQueuedTurn {
        thread_id: String,
        queued_turn_id: String,
        direction: QueueDirection,
    },
    SteerQueuedTurn {
        thread_id: String,
        queued_turn_id: String,
    },
    Create {
        project_path: String,
        text: String,
        attachments: Vec<String>,
    },
    SelectModel {
        key: String,
    },
    SelectEffort {
        effort: String,
    },
    ToggleFast,
    SelectApproval {
        approval: ApprovalMode,
    },
    ToggleIsolation,
    ToggleDesign,
    SelectProject {
        path: String,
    },
    SelectBranch {
        branch: String,
    },
    OpenCheckpoint {
        checkpoint_id: u64,
    },
    OpenImage {
        image: Arc<Image>,
        path: Option<String>,
        name: String,
    },
    PickAttachments,
    TranscribeVoice {
        params: VoiceTranscribeParams,
    },
    CancelVoice {
        request_id: String,
    },
    RespondApproval {
        thread_id: String,
        approval_id: String,
        decision: ApprovalDecision,
    },
    RespondUserInput {
        thread_id: String,
        request_id: String,
        answers: HashMap<String, Vec<String>>,
    },
    RequestDiff {
        thread_id: String,
    },
    ReviewHunk {
        thread_id: String,
        version: String,
        path: String,
        hunk_id: String,
        decision: DiffDecision,
    },
    TerminalOpen {
        thread_id: String,
        columns: u16,
        rows: u16,
    },
    TerminalInput {
        terminal_id: String,
        data: String,
    },
    TerminalResize {
        terminal_id: String,
        columns: u16,
        rows: u16,
    },
    TerminalClose {
        terminal_id: String,
    },
    TerminalPreferencesChanged {
        visible: bool,
        height: u16,
    },
}

impl EventEmitter<ChatEvent> for ChatView {}

#[derive(Clone)]
pub(crate) struct ComposerSettings {
    pub(crate) models: Vec<ModelChoice>,
    pub(crate) selected_model_key: Option<String>,
    pub(crate) effort: Option<String>,
    pub(crate) service_tier: Option<String>,
    pub(crate) approval: ApprovalMode,
    pub(crate) auto_review_supported: bool,
    pub(crate) isolate: bool,
    pub(crate) design_mode: bool,
    pub(crate) voice_available: bool,
}

impl Default for ComposerSettings {
    fn default() -> Self {
        Self {
            models: Vec::new(),
            selected_model_key: None,
            effort: None,
            service_tier: None,
            approval: ApprovalMode::Ask,
            auto_review_supported: false,
            isolate: false,
            design_mode: false,
            voice_available: false,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StageProject {
    pub(crate) path: String,
    pub(crate) name: String,
}

#[derive(Clone, Default)]
pub(crate) struct StageSettings {
    pub(crate) projects_loaded: bool,
    pub(crate) projects: Vec<StageProject>,
    pub(crate) workspace_branch: Option<String>,
    pub(crate) branches: Vec<String>,
    pub(crate) checkpoints: Vec<CheckpointSummary>,
    pub(crate) branch_switching: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ComposerMenu {
    Permissions,
    Model,
    Project,
    Branch,
}

#[derive(Clone, Copy)]
enum ComposerMenuAlignment {
    Left,
    RightShiftedLeft(f32),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ComposerMenuDrop {
    Up,
    Down,
}

#[derive(Clone, Copy)]
struct ComposerMenuPlacement {
    left: Pixels,
    vertical: Pixels,
    drop: ComposerMenuDrop,
}

struct InputFieldSync {
    value: String,
    masked: bool,
}

#[derive(Clone)]
struct ModelSourceGroup {
    key: String,
    name: String,
    provider: ProviderId,
    entries: Vec<ModelChoice>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum VoicePhase {
    #[default]
    Idle,
    Recording,
    Transcribing,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum TranscriptScrollMode {
    #[default]
    FollowEnd,
    AnchorTurn {
        start_row: usize,
    },
    Free,
}

struct PendingTranscript {
    text: String,
    cursor: usize,
    send_after: bool,
}

#[derive(Clone)]
pub(crate) struct PendingDraftTurn {
    pub(crate) text: String,
    pub(crate) attachments: Vec<String>,
    pub(crate) steer: bool,
    pub(crate) model: Option<String>,
    pub(crate) effort: Option<String>,
    pub(crate) service_tier: Option<String>,
}

#[derive(Clone)]
struct OptimisticActiveTurn {
    turn_id: String,
    item_id: String,
    text: String,
    created_at: f64,
    after_seq: u64,
}

#[derive(Clone, Copy)]
struct ComposerDockPending {
    box_bounds: Bounds<Pixels>,
    field_height: Pixels,
    started: Instant,
}

#[derive(Clone, Copy)]
struct ComposerDockMotion {
    offset_y: Pixels,
    generation: u64,
}

#[derive(Clone)]
struct ComposerAttachment {
    id: String,
    name: String,
    path: Option<String>,
    preview: Option<Arc<Image>>,
}

impl ComposerAttachment {
    fn file(path: String) -> Self {
        Self {
            id: path.clone(),
            name: path_label(&path).to_owned(),
            path: Some(path),
            preview: None,
        }
    }
}

pub(crate) struct ChatView {
    theme: Theme,
    interface_font: SharedString,
    session: Option<SessionContext>,
    state: ThreadState,
    queue: ThreadQueueResult,
    loading: bool,
    error: Option<String>,
    list_state: ListState,
    transcript_scroll_mode: Rc<Cell<TranscriptScrollMode>>,
    pending_anchor_turn: Option<String>,
    presentation: TranscriptPresentation,
    entering_transcript_items: HashSet<String>,
    transcript_motion_epoch: u64,
    settled_turn_id: Option<String>,
    settle_generation: u64,
    working_rail_entering_turn_id: Option<String>,
    working_rail_entry_generation: u64,
    stream_reveal_batches: HashMap<String, Vec<StreamRevealBatch>>,
    stream_reveal_generation: u64,
    stream_reveal_cleanup_scheduled: bool,
    markdown_table_overlay: Option<markdown::MarkdownTableOverlay>,
    expanded_transcript_items: HashSet<String>,
    expanded_activities: HashSet<String>,
    copied_transcript_item: Option<String>,
    copy_generation: u64,
    working_tick_scheduled: bool,
    last_work_turn_id: Option<String>,
    last_specific_work_label: Option<String>,
    thread_search: ThreadSearchState,
    composer: Entity<InputState>,
    composer_box_bounds: Option<Bounds<Pixels>>,
    composer_field_bounds: Option<Bounds<Pixels>>,
    project_trigger_bounds: Option<Bounds<Pixels>>,
    branch_trigger_bounds: Option<Bounds<Pixels>>,
    permission_trigger_bounds: Option<Bounds<Pixels>>,
    model_trigger_bounds: Option<Bounds<Pixels>>,
    composer_dock_pending: Option<ComposerDockPending>,
    composer_dock_motion: Option<ComposerDockMotion>,
    composer_dock_generation: u64,
    model_search: Entity<InputState>,
    model_search_reset: bool,
    model_search_focus_pending: bool,
    active_model_source_key: Option<String>,
    user_input_custom: Entity<InputState>,
    clear_composer: bool,
    restore_composer: Option<String>,
    creating: bool,
    pending_draft_turns: Vec<PendingDraftTurn>,
    optimistic_draft_turn_id: Option<String>,
    optimistic_active_turn: Option<OptimisticActiveTurn>,
    sending: bool,
    send_motion_generation: u64,
    interrupt_pending: bool,
    history_in_flight: bool,
    pending_live: Vec<ThreadEventPush>,
    delta_flush_scheduled: bool,
    composer_settings: ComposerSettings,
    design_hovered: bool,
    effort_focus: FocusHandle,
    effort_slider_bounds: Option<Bounds<Pixels>>,
    effort_pointer: Option<Point<Pixels>>,
    effort_dragging: bool,
    effort_preview_index: Option<usize>,
    effort_dither_fading: bool,
    effort_dither_generation: u64,
    stage_settings: StageSettings,
    composer_menu: Option<ComposerMenu>,
    attachments: Vec<ComposerAttachment>,
    attachment_error: Option<String>,
    active_user_input_id: Option<String>,
    user_input_step: usize,
    user_input_answers: HashMap<String, String>,
    user_input_custom_question: Option<String>,
    user_input_field_sync: Option<InputFieldSync>,
    last_user_input_wheel: Option<Instant>,
    pending_approvals: HashSet<String>,
    pending_user_inputs: HashSet<String>,
    action_errors: HashMap<String, String>,
    diff_ui: DiffUiState,
    terminal_ui: TerminalUiState,
    voice_recorder: VoiceRecorder,
    voice_phase: VoicePhase,
    voice_error: Option<String>,
    voice_request_id: Option<String>,
    voice_cursor: usize,
    voice_send_after: bool,
    voice_levels: Vec<f32>,
    voice_tick_scheduled: bool,
    pending_transcript: Option<PendingTranscript>,
}

impl ChatView {
    pub(crate) fn new(
        theme: Theme,
        interface_font: SharedString,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        thinking_orb::initialize_clock();
        let composer = cx.new(|cx| InputState::new(window, cx).auto_grow(2, 10).placeholder(""));
        let model_search = cx.new(|cx| InputState::new(window, cx).placeholder("Search models"));
        let user_input_custom =
            cx.new(|cx| InputState::new(window, cx).placeholder("Type your answer…"));
        let thread_search = ThreadSearchState::new(window, cx);
        cx.subscribe(&composer, |this, _composer, event, cx| match event {
            InputEvent::PressEnter { secondary } => this.submit(*secondary, cx),
            InputEvent::Change | InputEvent::Focus | InputEvent::Blur => cx.notify(),
        })
        .detach();
        cx.subscribe(&model_search, |_this, _input, _event: &InputEvent, cx| {
            cx.notify()
        })
        .detach();
        cx.subscribe(&user_input_custom, |this, input, event, cx| match event {
            InputEvent::PressEnter { .. } => this.advance_user_input(cx),
            InputEvent::Change => {
                if let Some(question_id) = this.user_input_custom_question.clone() {
                    let value = input.read(cx).value().to_string();
                    this.user_input_answers.insert(question_id, value);
                }
                cx.notify();
            }
            InputEvent::Focus | InputEvent::Blur => cx.notify(),
        })
        .detach();
        let transcript_scroll_mode = Rc::new(Cell::new(TranscriptScrollMode::FollowEnd));
        let list_state = ListState::new(0, ListAlignment::Bottom, px(500.0));
        let effort_focus = cx.focus_handle();
        let scroll_mode = transcript_scroll_mode.clone();
        let scroll_list = list_state.clone();
        list_state.set_scroll_handler(move |event, window, cx| {
            scroll_mode.set(if event.is_scrolled {
                TranscriptScrollMode::Free
            } else {
                TranscriptScrollMode::FollowEnd
            });
            let list = scroll_list.clone();
            let mode = scroll_mode.clone();
            window.defer(cx, move |_window, _cx| {
                let maximum = list.max_offset_for_scrollbar().height;
                let current = (-list.scroll_px_offset_for_scrollbar().y)
                    .max(px(0.0))
                    .min(maximum);
                let next = transcript_mode_for_bottom_gap(maximum - current);
                if next == TranscriptScrollMode::FollowEnd {
                    list.scroll_to(ListOffset {
                        item_ix: list.item_count(),
                        offset_in_item: px(0.0),
                    });
                }
                mode.set(next);
            });
        });

        Self {
            theme,
            interface_font,
            session: None,
            state: ThreadState::default(),
            queue: ThreadQueueResult {
                items: Vec::new(),
                can_steer: false,
            },
            loading: false,
            error: None,
            list_state,
            transcript_scroll_mode,
            pending_anchor_turn: None,
            presentation: TranscriptPresentation::default(),
            entering_transcript_items: HashSet::new(),
            transcript_motion_epoch: 0,
            settled_turn_id: None,
            settle_generation: 0,
            working_rail_entering_turn_id: None,
            working_rail_entry_generation: 0,
            stream_reveal_batches: HashMap::new(),
            stream_reveal_generation: 0,
            stream_reveal_cleanup_scheduled: false,
            markdown_table_overlay: None,
            expanded_transcript_items: HashSet::new(),
            expanded_activities: HashSet::new(),
            copied_transcript_item: None,
            copy_generation: 0,
            working_tick_scheduled: false,
            last_work_turn_id: None,
            last_specific_work_label: None,
            thread_search,
            composer,
            composer_box_bounds: None,
            composer_field_bounds: None,
            project_trigger_bounds: None,
            branch_trigger_bounds: None,
            permission_trigger_bounds: None,
            model_trigger_bounds: None,
            composer_dock_pending: None,
            composer_dock_motion: None,
            composer_dock_generation: 0,
            model_search,
            model_search_reset: false,
            model_search_focus_pending: false,
            active_model_source_key: None,
            user_input_custom,
            clear_composer: false,
            restore_composer: None,
            creating: false,
            pending_draft_turns: Vec::new(),
            optimistic_draft_turn_id: None,
            optimistic_active_turn: None,
            sending: false,
            send_motion_generation: 0,
            interrupt_pending: false,
            history_in_flight: false,
            pending_live: Vec::new(),
            delta_flush_scheduled: false,
            composer_settings: ComposerSettings::default(),
            design_hovered: false,
            effort_focus,
            effort_slider_bounds: None,
            effort_pointer: None,
            effort_dragging: false,
            effort_preview_index: None,
            effort_dither_fading: false,
            effort_dither_generation: 0,
            stage_settings: StageSettings::default(),
            composer_menu: None,
            attachments: Vec::new(),
            attachment_error: None,
            active_user_input_id: None,
            user_input_step: 0,
            user_input_answers: HashMap::new(),
            user_input_custom_question: None,
            user_input_field_sync: None,
            last_user_input_wheel: None,
            pending_approvals: HashSet::new(),
            pending_user_inputs: HashSet::new(),
            action_errors: HashMap::new(),
            diff_ui: DiffUiState::default(),
            terminal_ui: TerminalUiState::new(cx),
            voice_recorder: VoiceRecorder::default(),
            voice_phase: VoicePhase::Idle,
            voice_error: None,
            voice_request_id: None,
            voice_cursor: 0,
            voice_send_after: false,
            voice_levels: Vec::new(),
            voice_tick_scheduled: false,
            pending_transcript: None,
        }
    }

    pub(crate) fn focus_composer(&self, window: &mut Window, cx: &mut Context<Self>) {
        self.composer
            .update(cx, |composer, cx| composer.focus(window, cx));
    }

    pub(crate) fn text_input_focused(&self, window: &Window, cx: &App) -> bool {
        self.composer.read(cx).focus_handle(cx).is_focused(window)
            || self
                .model_search
                .read(cx)
                .focus_handle(cx)
                .is_focused(window)
            || self
                .user_input_custom
                .read(cx)
                .focus_handle(cx)
                .is_focused(window)
            || self
                .thread_search
                .input
                .read(cx)
                .focus_handle(cx)
                .is_focused(window)
            || self.terminal_ui.is_focused(window)
    }

    pub(crate) fn begin_session(&mut self, session: SessionContext, cx: &mut Context<Self>) {
        self.reset_session(Some(session), cx);
    }

    fn reset_session(&mut self, session: Option<SessionContext>, cx: &mut Context<Self>) {
        self.release_terminal_for_session_change(cx);
        self.session = session;
        self.state = ThreadState::default();
        self.queue.items.clear();
        self.queue.can_steer = false;
        self.loading = true;
        self.error = None;
        self.list_state.reset(0);
        self.transcript_scroll_mode
            .set(TranscriptScrollMode::FollowEnd);
        self.pending_anchor_turn = None;
        self.presentation.clear();
        self.reset_transcript_motion();
        self.markdown_table_overlay = None;
        self.expanded_transcript_items.clear();
        self.expanded_activities.clear();
        self.copied_transcript_item = None;
        self.copy_generation = self.copy_generation.wrapping_add(1);
        self.working_tick_scheduled = false;
        self.last_work_turn_id = None;
        self.last_specific_work_label = None;
        self.thread_search.close();
        // React keeps one Composer mounted while navigation replaces the thread
        // around it, so draft text, attachments, voice capture, and pending
        // restoration survive project and session changes. Submission owns the
        // only normal clear; a provider capability change can still cancel voice.
        self.composer_box_bounds = None;
        self.composer_field_bounds = None;
        self.project_trigger_bounds = None;
        self.branch_trigger_bounds = None;
        self.permission_trigger_bounds = None;
        self.model_trigger_bounds = None;
        self.composer_dock_pending = None;
        self.composer_dock_motion = None;
        self.composer_dock_generation = self.composer_dock_generation.wrapping_add(1);
        self.creating = false;
        self.pending_draft_turns.clear();
        self.optimistic_draft_turn_id = None;
        self.optimistic_active_turn = None;
        self.sending = false;
        self.send_motion_generation = self.send_motion_generation.wrapping_add(1);
        self.interrupt_pending = false;
        self.history_in_flight = self
            .session
            .as_ref()
            .is_some_and(|session| session.thread_id.is_some());
        self.pending_live.clear();
        self.delta_flush_scheduled = false;
        self.composer_menu = None;
        self.model_search_reset = false;
        self.model_search_focus_pending = false;
        self.active_model_source_key = None;
        self.reset_effort_interaction();
        self.active_user_input_id = None;
        self.user_input_step = 0;
        self.user_input_answers.clear();
        self.user_input_custom_question = None;
        self.last_user_input_wheel = None;
        self.user_input_field_sync = Some(InputFieldSync {
            value: String::new(),
            masked: false,
        });
        self.pending_approvals.clear();
        self.pending_user_inputs.clear();
        self.action_errors.clear();
        self.diff_ui.reset();
        self.reopen_visible_terminal(cx);
        cx.notify();
    }

    pub(crate) fn begin_draft(&mut self, session: SessionContext, cx: &mut Context<Self>) {
        debug_assert!(session.thread_id.is_none());
        self.reset_session(Some(session), cx);
        self.loading = false;
    }

    pub(crate) fn begin_empty_draft(&mut self, cx: &mut Context<Self>) {
        self.reset_session(None, cx);
        self.loading = false;
    }

    pub(crate) fn promote_draft(
        &mut self,
        session: SessionContext,
        cx: &mut Context<Self>,
    ) -> Vec<PendingDraftTurn> {
        debug_assert!(session.thread_id.is_some());
        let pending_turns = std::mem::take(&mut self.pending_draft_turns);
        self.session = Some(session);
        self.creating = false;
        self.optimistic_draft_turn_id = None;
        self.loading = true;
        self.history_in_flight = true;
        self.error = None;
        self.reopen_visible_terminal(cx);
        cx.notify();
        pending_turns
    }

    pub(crate) fn update_composer_settings(
        &mut self,
        settings: ComposerSettings,
        cx: &mut Context<Self>,
    ) {
        self.composer_settings = settings;
        if !self.effort_dragging
            && self.effort_preview_index.is_some_and(|preview| {
                self.selected_model().is_some_and(|choice| {
                    selected_reasoning_effort(
                        &choice.model,
                        self.composer_settings.effort.as_deref(),
                    )
                    .and_then(|effort| {
                        choice
                            .model
                            .reasoning_efforts
                            .iter()
                            .position(|candidate| candidate == effort)
                    }) == Some(preview)
                })
            })
        {
            self.effort_preview_index = None;
        }
        if !self.composer_settings.voice_available && self.voice_phase != VoicePhase::Idle {
            self.cancel_voice(cx);
        }
        cx.notify();
    }

    pub(crate) fn update_stage_settings(
        &mut self,
        settings: StageSettings,
        cx: &mut Context<Self>,
    ) {
        self.stage_settings = settings;
        cx.notify();
    }

    pub(crate) fn update_theme(&mut self, theme: Theme, cx: &mut Context<Self>) {
        if self.theme != theme {
            if theme.reduced_motion && !self.theme.reduced_motion {
                self.reset_transcript_motion();
            }
            self.theme = theme;
            cx.notify();
        }
    }

    pub(crate) fn update_interface_font(
        &mut self,
        interface_font: SharedString,
        cx: &mut Context<Self>,
    ) {
        if self.interface_font != interface_font {
            self.interface_font = interface_font;
            cx.notify();
        }
    }

    pub(crate) fn update_draft_provider(&mut self, provider: ProviderId, cx: &mut Context<Self>) {
        if let Some(session) = &mut self.session
            && session.thread_id.is_none()
        {
            session.provider = Some(provider);
            cx.notify();
        }
    }

    pub(crate) fn add_attachments(&mut self, paths: Vec<String>, cx: &mut Context<Self>) {
        for path in paths {
            if !self
                .attachments
                .iter()
                .any(|attachment| attachment.path.as_deref() == Some(path.as_str()))
            {
                self.attachments.push(ComposerAttachment::file(path));
            }
        }
        self.attachment_error = None;
        cx.notify();
    }

    pub(crate) fn reveal_turn(&mut self, turn_id: &str, cx: &mut Context<Self>) {
        if let Some(row) = self.state.first_row_for_turn(turn_id) {
            self.transcript_scroll_mode.set(TranscriptScrollMode::Free);
            self.list_state.scroll_to_reveal_item(row);
            cx.notify();
        }
    }

    fn jump_to_latest(&mut self, cx: &mut Context<Self>) {
        self.transcript_scroll_mode
            .set(TranscriptScrollMode::FollowEnd);
        self.list_state.scroll_to(ListOffset {
            item_ix: self.list_state.item_count(),
            offset_in_item: px(0.0),
        });
        cx.notify();
    }

    pub(crate) fn app_zoom_changed(&mut self, previous: f32, next: f32, cx: &mut Context<Self>) {
        self.scale_terminal_for_app_zoom(next / previous);
        let mode = self.transcript_scroll_mode.get();
        let logical_scroll = self.list_state.logical_scroll_top();
        self.list_state.reset(self.transcript_list_len());
        match mode {
            TranscriptScrollMode::FollowEnd => {}
            TranscriptScrollMode::AnchorTurn { start_row } => {
                self.list_state.scroll_to(ListOffset {
                    item_ix: start_row,
                    offset_in_item: px(0.0),
                });
            }
            TranscriptScrollMode::Free => {
                self.list_state.scroll_to(ListOffset {
                    item_ix: logical_scroll.item_ix,
                    offset_in_item: logical_scroll.offset_in_item * (next / previous),
                });
            }
        }
        cx.notify();
    }

    pub(crate) fn rename_session(
        &mut self,
        thread_id: &str,
        title: String,
        cx: &mut Context<Self>,
    ) {
        if let Some(session) = &mut self.session
            && session.thread_id.as_deref() == Some(thread_id)
        {
            session.title = title;
            cx.notify();
        }
    }

    pub(crate) fn apply_update(&mut self, update: ChatUpdate, cx: &mut Context<Self>) {
        match update {
            ChatUpdate::History {
                thread_id,
                mut history,
                replace,
            } if self.is_selected(&thread_id) => {
                let optimistic_confirmation = self.optimistic_active_turn.as_ref().map(|pending| {
                    let mut canonical_turn_id = None;
                    let mut canonical_user_arrived = false;
                    for entry in history
                        .events
                        .iter_mut()
                        .filter(|entry| entry.seq > pending.after_seq)
                    {
                        match &mut entry.event {
                            DomainEvent::TurnStarted { turn }
                                if !turn.id.starts_with("local-turn:") =>
                            {
                                turn.created_at = pending.created_at;
                                canonical_turn_id = Some(turn.id.clone());
                            }
                            DomainEvent::ItemStarted { item }
                            | DomainEvent::ItemCompleted { item }
                                if item.role == Some(MessageRole::User)
                                    && item
                                        .text
                                        .as_deref()
                                        .is_none_or(|text| text == pending.text) =>
                            {
                                canonical_user_arrived = true;
                            }
                            _ => {}
                        }
                    }
                    (canonical_turn_id, canonical_user_arrived)
                });
                let old_len = self.state.timeline_len();
                let was_footer_visible = self.transcript_footer_visible();
                let was_running = self.state.running;
                let previous_active_turn_id =
                    self.state.active_turn().map(|turn| turn.turn.id.clone());
                let result = if replace {
                    self.state.replace_history(history)
                } else {
                    self.state.merge_history(history.events)
                };
                match result {
                    Ok(()) => {
                        if let Some((canonical_turn_id, canonical_user_arrived)) =
                            optimistic_confirmation
                        {
                            self.reconcile_optimistic_active_turn_after_history(
                                &thread_id,
                                canonical_turn_id,
                                canonical_user_arrived,
                            );
                        }
                        if !self.state.running {
                            self.interrupt_pending = false;
                        }
                        let new_len = self.state.timeline_len();
                        let presentation_rows = self.presentation.rebuild(&self.state);
                        if !was_running
                            && self.state.running
                            && let Some(turn_id) =
                                self.state.active_turn().map(|turn| turn.turn.id.clone())
                        {
                            self.start_working_rail_entry(turn_id, cx);
                        } else if was_running
                            && !self.state.running
                            && let Some(turn_id) = previous_active_turn_id
                        {
                            self.start_turn_settle(turn_id, cx);
                        }
                        if replace {
                            self.reset_transcript_item_entries();
                            self.list_state.reset(new_len);
                            self.transcript_scroll_mode
                                .set(TranscriptScrollMode::FollowEnd);
                            self.pending_anchor_turn = None;
                        } else if new_len > old_len {
                            let item_ids = (old_len..new_len)
                                .filter_map(|row| {
                                    self.state.item_at_row(row).map(|item| item.id.clone())
                                })
                                .collect();
                            self.start_transcript_item_entries(item_ids, cx);
                            self.list_state.splice(old_len..old_len, new_len - old_len);
                            for row in presentation_rows.into_iter().filter(|row| *row < old_len) {
                                self.list_state.splice(row..row + 1, 1);
                            }
                        } else {
                            for row in presentation_rows {
                                self.list_state.splice(row..row + 1, 1);
                            }
                        }
                        self.loading = false;
                        self.history_in_flight = false;
                        self.error = None;
                        self.sync_structured_requests();
                        self.sync_diff_summary();
                        if replace {
                            self.list_state.reset(self.transcript_list_len());
                        } else {
                            self.reconcile_transcript_footer(was_footer_visible);
                        }
                        self.refresh_work_label();
                        self.refresh_thread_search_hits(cx);
                        self.flush_pending_live(cx);
                    }
                    Err(error) => self.reconcile_after_error(error, cx),
                }
                cx.notify();
            }
            ChatUpdate::Queue { thread_id, queue } if self.is_selected(&thread_id) => {
                self.queue = reconcile_queue_snapshot(&self.queue, queue);
                cx.notify();
            }
            ChatUpdate::QueueSubmissionResolved {
                thread_id,
                optimistic_queue_id,
                queued_turn,
            } if self.is_selected(&thread_id) => {
                if optimistic_queue_id.is_none() && queued_turn.is_some() {
                    self.rollback_optimistic_active_turn();
                }
                resolve_queue_submission(
                    &mut self.queue,
                    optimistic_queue_id.as_deref(),
                    queued_turn,
                );
                cx.notify();
            }
            ChatUpdate::RunningSubmissionStarted {
                thread_id,
                turn_id,
                optimistic_queue_id,
                text,
                created_at,
                echo_after_row,
            } if self.is_selected(&thread_id) => {
                resolve_queue_submission(&mut self.queue, optimistic_queue_id.as_deref(), None);
                self.append_started_prompt_if_missing(
                    &thread_id,
                    &turn_id,
                    text,
                    created_at,
                    echo_after_row,
                    cx,
                );
                cx.notify();
            }
            ChatUpdate::SteerAccepted {
                thread_id,
                text,
                created_at,
                echo_after_row,
            } if self.is_selected(&thread_id) => {
                self.append_steered_prompt_if_missing(
                    &thread_id,
                    text,
                    created_at,
                    echo_after_row,
                    cx,
                );
            }
            ChatUpdate::Event(push) if self.is_selected(&push.thread_id) => {
                if self.history_in_flight {
                    self.pending_live.push(push);
                } else if matches!(&push.event, harness_protocol::DomainEvent::ItemDelta { .. }) {
                    self.queue_delta(push, cx);
                } else {
                    self.flush_pending_live(cx);
                    self.apply_live_events(vec![push], cx);
                }
            }
            ChatUpdate::Refresh => {
                if let Some(thread_id) = self
                    .session
                    .as_ref()
                    .and_then(|session| session.thread_id.as_ref())
                {
                    self.history_in_flight = true;
                    cx.emit(ChatEvent::NeedHistory {
                        thread_id: thread_id.clone(),
                        after_seq: Some(self.state.last_seq()),
                    });
                }
            }
            ChatUpdate::Error { thread_id, message } if self.is_selected(&thread_id) => {
                self.loading = false;
                self.history_in_flight = false;
                self.interrupt_pending = false;
                self.error = Some(message);
                self.flush_pending_live(cx);
                cx.notify();
            }
            ChatUpdate::DraftError {
                message,
                restore_text,
                restore_attachments,
            } if self
                .session
                .as_ref()
                .is_some_and(|session| session.thread_id.is_none()) =>
            {
                let pending_restore = self.pending_draft_turns.last().cloned();
                let session = self.session.clone();
                self.reset_session(session, cx);
                self.loading = false;
                self.error = Some(message);
                self.restore_composer = Some(
                    pending_restore
                        .as_ref()
                        .map_or(restore_text, |pending| pending.text.clone()),
                );
                self.attachments = restored_composer_attachments(
                    pending_restore.map_or(restore_attachments, |pending| pending.attachments),
                );
                cx.notify();
            }
            ChatUpdate::TurnError {
                thread_id,
                message,
                restore_text,
                restore_attachments,
                optimistic_queue_id,
            } if self.is_selected(&thread_id) => {
                resolve_queue_submission(&mut self.queue, optimistic_queue_id.as_deref(), None);
                self.rollback_optimistic_active_turn();
                self.loading = false;
                self.interrupt_pending = false;
                self.error = Some(message);
                self.restore_composer = Some(restore_text);
                self.attachments = restored_composer_attachments(restore_attachments);
                cx.notify();
            }
            ChatUpdate::ApprovalError {
                thread_id,
                approval_id,
                message,
            } if self.is_selected(&thread_id) => {
                self.pending_approvals.remove(&approval_id);
                self.action_errors.insert(approval_id, message);
                self.remeasure_transcript_footer();
                cx.notify();
            }
            ChatUpdate::UserInputError {
                thread_id,
                request_id,
                message,
            } if self.is_selected(&thread_id) => {
                self.pending_user_inputs.remove(&request_id);
                self.action_errors.insert(request_id, message);
                cx.notify();
            }
            ChatUpdate::DiffSnapshot { thread_id, diff } if self.is_selected(&thread_id) => {
                self.diff_ui.apply_snapshot(diff);
                self.remeasure_transcript_footer();
                cx.notify();
            }
            ChatUpdate::DiffError {
                thread_id,
                message,
                stale,
            } if self.is_selected(&thread_id) => {
                let refresh = self.diff_ui.apply_error(message, stale);
                self.remeasure_transcript_footer();
                if refresh {
                    cx.emit(ChatEvent::RequestDiff { thread_id });
                }
                cx.notify();
            }
            ChatUpdate::VoiceTranscribed { request_id, text }
                if self.voice_request_id.as_deref() == Some(request_id.as_str()) =>
            {
                self.voice_request_id = None;
                self.voice_phase = VoicePhase::Idle;
                self.pending_transcript = Some(PendingTranscript {
                    text,
                    cursor: self.voice_cursor,
                    send_after: self.voice_send_after,
                });
                cx.notify();
            }
            ChatUpdate::VoiceTranscriptionError {
                request_id,
                message,
            } if self.voice_request_id.as_deref() == Some(request_id.as_str()) => {
                self.voice_request_id = None;
                self.voice_phase = VoicePhase::Idle;
                self.voice_error = Some(message);
                cx.notify();
            }
            ChatUpdate::Connection(connection) => {
                self.apply_terminal_connection(connection, cx);
            }
            ChatUpdate::TerminalOpened {
                thread_id,
                terminal_id,
            } => self.apply_terminal_opened(thread_id, terminal_id, cx),
            ChatUpdate::TerminalOutput(push) => {
                self.apply_terminal_output(push.terminal_id, push.data, cx);
            }
            ChatUpdate::TerminalExit(push) => {
                self.apply_terminal_exit(push.terminal_id, push.exit_code, cx);
            }
            ChatUpdate::TerminalOpenError { thread_id, message } => {
                self.apply_terminal_open_error(thread_id, message, cx);
            }
            ChatUpdate::TerminalError {
                terminal_id,
                message,
            } => self.apply_terminal_error(terminal_id, message, cx),
            ChatUpdate::History { .. }
            | ChatUpdate::Queue { .. }
            | ChatUpdate::QueueSubmissionResolved { .. }
            | ChatUpdate::RunningSubmissionStarted { .. }
            | ChatUpdate::SteerAccepted { .. }
            | ChatUpdate::Event(_)
            | ChatUpdate::Error { .. }
            | ChatUpdate::DraftError { .. }
            | ChatUpdate::TurnError { .. }
            | ChatUpdate::ApprovalError { .. }
            | ChatUpdate::UserInputError { .. }
            | ChatUpdate::DiffSnapshot { .. }
            | ChatUpdate::DiffError { .. }
            | ChatUpdate::VoiceTranscribed { .. }
            | ChatUpdate::VoiceTranscriptionError { .. } => {}
        }
    }

    fn queue_delta(&mut self, push: ThreadEventPush, cx: &mut Context<Self>) {
        self.pending_live.push(push);
        if self.delta_flush_scheduled {
            return;
        }
        self.delta_flush_scheduled = true;
        cx.spawn(async move |view, cx| {
            cx.background_executor().timer(LIVE_FLUSH_INTERVAL).await;
            let _ = view.update(cx, |this, cx| this.flush_pending_live(cx));
        })
        .detach();
    }

    fn flush_pending_live(&mut self, cx: &mut Context<Self>) {
        self.delta_flush_scheduled = false;
        if self.history_in_flight || self.pending_live.is_empty() {
            return;
        }
        let events = std::mem::take(&mut self.pending_live);
        self.apply_live_events(events, cx);
    }

    fn apply_live_events(&mut self, events: Vec<ThreadEventPush>, cx: &mut Context<Self>) {
        let old_len = self.state.timeline_len();
        let was_footer_visible = self.transcript_footer_visible();
        let mut changed_items = HashSet::new();
        let mut transcript_changed = false;
        let mut presentation_turns = HashSet::new();
        let mut applied = false;
        let mut reconcile_after = None;
        let mut finished_turn_id = None;
        let mut streamed_bytes: HashMap<(String, String), usize> = HashMap::new();
        let mut started_stream_items = HashSet::new();

        let mut events = events.into_iter();
        while let Some(push) = events.next() {
            let replay = push.clone();
            let started_turn = match &push.event {
                DomainEvent::TurnStarted { turn } => Some(turn.id.clone()),
                _ => None,
            };
            let confirms_optimistic_turn = started_turn
                .as_deref()
                .is_some_and(|turn_id| !turn_id.starts_with("local-turn:"))
                && self.optimistic_active_turn.is_some();
            let finishing_turn = if self.state.running {
                match &push.event {
                    DomainEvent::TurnCompleted { turn_id, .. } => Some(turn_id.clone()),
                    DomainEvent::ThreadError { .. } => {
                        self.state.active_turn().map(|turn| turn.turn.id.clone())
                    }
                    _ => None,
                }
            } else {
                None
            };
            let stream_delta = match &push.event {
                DomainEvent::ItemDelta {
                    turn_id,
                    item_id,
                    text_delta,
                } if !text_delta.is_empty() => {
                    Some(((turn_id.clone(), item_id.clone()), text_delta.len()))
                }
                _ => None,
            };
            let started_stream_item = match &push.event {
                DomainEvent::ItemStarted { item }
                    if item.item_type == harness_protocol::ItemType::Message
                        && item.role == Some(harness_protocol::MessageRole::Assistant)
                        && item.status == harness_protocol::ItemStatus::Started
                        && item.text.as_ref().is_some_and(|text| !text.is_empty()) =>
                {
                    Some((item.turn_id.clone(), item.id.clone()))
                }
                _ => None,
            };
            match &push.event {
                DomainEvent::TurnStarted { turn } => {
                    presentation_turns.insert(turn.id.clone());
                }
                DomainEvent::ItemStarted { item } | DomainEvent::ItemCompleted { item } => {
                    presentation_turns.insert(item.turn_id.clone());
                }
                DomainEvent::TurnCompleted { turn_id, .. } => {
                    presentation_turns.insert(turn_id.clone());
                }
                DomainEvent::ThreadError { .. } => {
                    if let Some(turn) = self.state.active_turn() {
                        presentation_turns.insert(turn.turn.id.clone());
                    }
                }
                _ => {}
            }
            let changed_item = match &push.event {
                DomainEvent::ItemDelta {
                    turn_id, item_id, ..
                }
                | DomainEvent::ItemCompleted {
                    item:
                        Item {
                            turn_id,
                            id: item_id,
                            ..
                        },
                } => Some((turn_id.clone(), item_id.clone())),
                _ => None,
            };
            match self.state.apply_live(push.seq, push.event) {
                ApplyOutcome::Applied(changes) => {
                    applied = true;
                    transcript_changed |= changes.transcript;
                    if confirms_optimistic_turn {
                        self.optimistic_active_turn = None;
                    }
                    if let Some(turn_id) = started_turn
                        && !confirms_optimistic_turn
                    {
                        self.start_working_rail_entry(turn_id.clone(), cx);
                        if self.transcript_scroll_mode.get() != TranscriptScrollMode::Free {
                            self.pending_anchor_turn = Some(turn_id);
                        }
                    }
                    if !self.state.running
                        && let Some(turn_id) = finishing_turn
                    {
                        finished_turn_id = Some(turn_id);
                    }
                    if changes.transcript
                        && let Some(changed_item) = changed_item
                    {
                        changed_items.insert(changed_item);
                    }
                    if changes.transcript {
                        if let Some((item, bytes)) = stream_delta {
                            *streamed_bytes.entry(item).or_default() += bytes;
                        }
                        if let Some(item) = started_stream_item {
                            started_stream_items.insert(item);
                        }
                    }
                }
                ApplyOutcome::Duplicate => {}
                ApplyOutcome::NeedsHistory { after_seq } => {
                    reconcile_after = Some(after_seq);
                    self.history_in_flight = true;
                    self.pending_live.push(replay);
                    self.pending_live.extend(events);
                    break;
                }
            }
        }

        if applied {
            if !self.state.running {
                self.interrupt_pending = false;
            }
            let new_len = self.state.timeline_len();
            let reveal_keys = streamed_bytes
                .keys()
                .chain(started_stream_items.iter())
                .cloned()
                .collect::<HashSet<_>>();
            let reveal_specs = reveal_keys
                .into_iter()
                .filter_map(|(turn_id, item_id)| {
                    let row = self.state.row_for_item(&turn_id, &item_id)?;
                    let item = self.state.item_at_row(row)?;
                    if item.item_type != harness_protocol::ItemType::Message
                        || item.role != Some(harness_protocol::MessageRole::Assistant)
                    {
                        return None;
                    }
                    let text = item.text.as_deref()?;
                    let to = text.len();
                    let from = if started_stream_items.contains(&(turn_id.clone(), item_id.clone()))
                    {
                        0
                    } else {
                        to.saturating_sub(
                            streamed_bytes
                                .get(&(turn_id, item_id.clone()))
                                .copied()
                                .unwrap_or_default(),
                        )
                    };
                    Some((item.id.clone(), from, to, text.get(from..to)?.to_owned()))
                })
                .collect::<Vec<_>>();
            for (item_id, from, to, text) in reveal_specs {
                self.start_stream_reveal(item_id, from, to, &text, cx);
            }
            let item_ids = (old_len..new_len)
                .filter_map(|row| self.state.item_at_row(row).map(|item| item.id.clone()))
                .collect();
            self.start_transcript_item_entries(item_ids, cx);
            if let Some(turn_id) = finished_turn_id {
                self.start_turn_settle(turn_id, cx);
            }
            let presentation_rows = if presentation_turns.is_empty() {
                Vec::new()
            } else {
                self.presentation
                    .refresh_turns(&self.state, &presentation_turns)
            };
            let mut changed_rows = BTreeSet::new();
            if new_len > old_len {
                self.list_state.splice(old_len..old_len, new_len - old_len);
                changed_rows.extend(old_len..new_len);
            }
            if transcript_changed {
                changed_rows.extend(
                    changed_items.into_iter().filter_map(|(turn_id, item_id)| {
                        self.state.row_for_item(&turn_id, &item_id)
                    }),
                );
            }
            changed_rows.extend(presentation_rows);
            for row in changed_rows.iter().copied().filter(|row| *row < old_len) {
                self.list_state.splice(row..row + 1, 1);
            }
            self.anchor_pending_turn();
            let search_rows = changed_rows.into_iter().collect::<Vec<_>>();
            self.loading = false;
            self.error = None;
            self.sync_structured_requests();
            self.sync_diff_summary();
            self.reconcile_transcript_footer(was_footer_visible);
            self.refresh_work_label();
            self.refresh_thread_search_rows(&search_rows, cx);
            cx.notify();
        }

        if let Some(after_seq) = reconcile_after
            && let Some(thread_id) = self
                .session
                .as_ref()
                .and_then(|session| session.thread_id.as_ref())
        {
            cx.emit(ChatEvent::NeedHistory {
                thread_id: thread_id.clone(),
                after_seq: Some(after_seq),
            });
        }
    }

    fn anchor_pending_turn(&mut self) {
        let Some(turn_id) = self.pending_anchor_turn.clone() else {
            return;
        };
        if self.transcript_scroll_mode.get() == TranscriptScrollMode::Free {
            self.pending_anchor_turn = None;
            return;
        }
        let Some(start_row) = self.state.first_row_for_turn(&turn_id) else {
            return;
        };
        self.list_state.scroll_to(ListOffset {
            item_ix: start_row,
            offset_in_item: px(0.0),
        });
        self.transcript_scroll_mode
            .set(TranscriptScrollMode::AnchorTurn { start_row });
        self.pending_anchor_turn = None;
    }

    fn release_transcript_anchor_if_needed(&mut self, cx: &mut Context<Self>) {
        let TranscriptScrollMode::AnchorTurn { start_row } = self.transcript_scroll_mode.get()
        else {
            return;
        };
        let viewport = self.list_state.viewport_bounds();
        if viewport.size.height <= px(0.0) {
            return;
        }
        let Some(start_item) = self.state.item_at_row(start_row) else {
            return;
        };
        let turn_id = start_item.turn_id.as_str();
        let Some(last_row) = (start_row..self.state.timeline_len()).rev().find(|row| {
            self.state
                .item_at_row(*row)
                .is_some_and(|item| item.turn_id == turn_id)
        }) else {
            return;
        };
        let Some(start_bounds) = self.list_state.bounds_for_item(start_row) else {
            return;
        };
        let outgrew_viewport = self
            .list_state
            .bounds_for_item(last_row)
            .map_or(last_row > start_row, |last_bounds| {
                last_bounds.bottom() - start_bounds.top() > viewport.size.height
            });
        if outgrew_viewport {
            self.jump_to_latest(cx);
        }
    }

    fn reconcile_after_error(&mut self, error: HistoryError, cx: &mut Context<Self>) {
        self.error = Some(error.to_string());
        self.history_in_flight = true;
        if let Some(thread_id) = self
            .session
            .as_ref()
            .and_then(|session| session.thread_id.as_ref())
        {
            cx.emit(ChatEvent::NeedHistory {
                thread_id: thread_id.clone(),
                after_seq: None,
            });
        }
    }

    fn is_selected(&self, thread_id: &str) -> bool {
        self.session.as_ref().is_some_and(|session| {
            session
                .thread_id
                .as_deref()
                .is_some_and(|id| id == thread_id)
        })
    }

    fn sync_structured_requests(&mut self) {
        let live_ids = self
            .state
            .approvals
            .iter()
            .map(|request| request.id.as_str())
            .chain(
                self.state
                    .user_inputs
                    .iter()
                    .map(|request| request.id.as_str()),
            )
            .collect::<HashSet<_>>();
        self.pending_approvals
            .retain(|request_id| live_ids.contains(request_id.as_str()));
        self.pending_user_inputs
            .retain(|request_id| live_ids.contains(request_id.as_str()));
        self.action_errors
            .retain(|request_id, _| live_ids.contains(request_id.as_str()));

        let next_id = self
            .state
            .user_inputs
            .first()
            .map(|request| request.id.clone());
        if self.active_user_input_id != next_id {
            self.active_user_input_id = next_id;
            self.user_input_step = 0;
            self.user_input_answers.clear();
            self.user_input_custom_question = None;
            self.last_user_input_wheel = None;
            self.user_input_field_sync = Some(InputFieldSync {
                value: String::new(),
                masked: false,
            });
        }
    }

    fn active_user_input(&self) -> Option<&harness_protocol::UserInputRequest> {
        let request_id = self.active_user_input_id.as_deref()?;
        self.state
            .user_inputs
            .iter()
            .find(|request| request.id == request_id)
    }

    fn current_user_input_question(&self) -> Option<&UserInputQuestion> {
        self.active_user_input()?
            .questions
            .get(self.user_input_step)
    }

    fn prepare_user_input_field(&mut self) {
        let Some(question) = self.current_user_input_question().cloned() else {
            self.user_input_custom_question = None;
            return;
        };
        let answer = self.user_input_answers.get(&question.id).cloned();
        let is_option = answer.as_ref().is_some_and(|answer| {
            question
                .options
                .as_ref()
                .is_some_and(|options| options.iter().any(|option| option.label == *answer))
        });
        if answer.is_some() && !is_option {
            self.user_input_custom_question = Some(question.id);
            self.user_input_field_sync = Some(InputFieldSync {
                value: answer.unwrap_or_default(),
                masked: question.secret,
            });
        } else {
            self.user_input_custom_question = None;
        }
    }

    fn select_user_input_option(
        &mut self,
        question_id: String,
        answer: String,
        cx: &mut Context<Self>,
    ) {
        if self
            .current_user_input_question()
            .is_none_or(|question| question.id != question_id)
        {
            return;
        }
        self.user_input_answers.insert(question_id, answer);
        self.user_input_custom_question = None;
        if let Some(request_id) = &self.active_user_input_id {
            self.action_errors.remove(request_id);
        }
        cx.notify();
    }

    fn select_user_input_custom(&mut self, question_id: String, cx: &mut Context<Self>) {
        let Some(question) = self.current_user_input_question().cloned() else {
            return;
        };
        if question.id != question_id {
            return;
        }
        if self.user_input_custom_question.as_deref() == Some(question.id.as_str()) {
            return;
        }
        let value =
            self.user_input_answers
                .get(&question.id)
                .filter(|answer| {
                    question.options.as_ref().is_none_or(|options| {
                        !options.iter().any(|option| option.label == **answer)
                    })
                })
                .cloned()
                .unwrap_or_default();
        self.user_input_answers
            .insert(question.id.clone(), value.clone());
        self.user_input_custom_question = Some(question.id);
        self.user_input_field_sync = Some(InputFieldSync {
            value,
            masked: question.secret,
        });
        if let Some(request_id) = &self.active_user_input_id {
            self.action_errors.remove(request_id);
        }
        cx.notify();
    }

    fn back_user_input(&mut self, cx: &mut Context<Self>) {
        if self.user_input_step == 0 || self.pending_user_input() {
            return;
        }
        self.user_input_step -= 1;
        self.prepare_user_input_field();
        cx.notify();
    }

    fn advance_user_input(&mut self, cx: &mut Context<Self>) {
        let Some(request) = self.active_user_input().cloned() else {
            return;
        };
        if self.pending_user_inputs.contains(&request.id) {
            return;
        }
        let Some(question) = request.questions.get(self.user_input_step) else {
            return;
        };
        let Some(_answer) = self
            .user_input_answers
            .get(&question.id)
            .map(|answer| answer.trim())
            .filter(|answer| !answer.is_empty())
        else {
            return;
        };
        if self.user_input_step + 1 < request.questions.len() {
            self.user_input_step += 1;
            self.prepare_user_input_field();
            cx.notify();
            return;
        }

        let answers = request
            .questions
            .iter()
            .map(|question| {
                self.user_input_answers
                    .get(&question.id)
                    .map(|answer| (question.id.clone(), vec![answer.trim().to_owned()]))
                    .filter(|(_, answers)| !answers[0].is_empty())
            })
            .collect::<Option<HashMap<_, _>>>();
        let Some(answers) = answers else {
            return;
        };
        let Some(thread_id) = self
            .session
            .as_ref()
            .and_then(|session| session.thread_id.clone())
        else {
            return;
        };
        self.pending_user_inputs.insert(request.id.clone());
        self.action_errors.remove(&request.id);
        cx.emit(ChatEvent::RespondUserInput {
            thread_id,
            request_id: request.id,
            answers,
        });
        cx.notify();
    }

    fn pending_user_input(&self) -> bool {
        self.active_user_input_id
            .as_ref()
            .is_some_and(|request_id| self.pending_user_inputs.contains(request_id))
    }

    fn navigate_user_input_wheel(&mut self, event: &ScrollWheelEvent, cx: &mut Context<Self>) {
        if self.pending_user_input() {
            return;
        }
        let delta_y = f32::from(event.delta.pixel_delta(px(40.0)).y);
        if delta_y.abs() < f32::from(px(28.0)) {
            return;
        }
        let now = Instant::now();
        if self
            .last_user_input_wheel
            .is_some_and(|last| now.duration_since(last) < Duration::from_millis(360))
        {
            return;
        }
        let can_advance = self
            .current_user_input_question()
            .and_then(|question| self.user_input_answers.get(&question.id))
            .is_some_and(|answer| !answer.trim().is_empty())
            && self
                .active_user_input()
                .is_some_and(|request| self.user_input_step + 1 < request.questions.len());
        let moved = if delta_y > 0.0 && self.user_input_step > 0 {
            self.back_user_input(cx);
            true
        } else if delta_y < 0.0 && can_advance {
            self.advance_user_input(cx);
            true
        } else {
            false
        };
        if moved {
            self.last_user_input_wheel = Some(now);
            cx.stop_propagation();
        }
    }

    fn decide_approval(
        &mut self,
        approval_id: String,
        decision: ApprovalDecision,
        cx: &mut Context<Self>,
    ) {
        if self.pending_approvals.contains(&approval_id)
            || !self
                .state
                .approvals
                .iter()
                .any(|request| request.id == approval_id)
        {
            return;
        }
        let Some(thread_id) = self
            .session
            .as_ref()
            .and_then(|session| session.thread_id.clone())
        else {
            return;
        };
        self.pending_approvals.insert(approval_id.clone());
        self.action_errors.remove(&approval_id);
        cx.emit(ChatEvent::RespondApproval {
            thread_id,
            approval_id,
            decision,
        });
        cx.notify();
    }

    fn submit(&mut self, steer: bool, cx: &mut Context<Self>) {
        let text = self.composer.read(cx).value().trim().to_owned();
        if text.is_empty() {
            return;
        }
        if self
            .attachments
            .iter()
            .any(|attachment| attachment.path.is_none())
        {
            return;
        }
        let Some(session) = &self.session else {
            cx.emit(ChatEvent::ProjectRequired);
            return;
        };
        if !self.creating && session.thread_id.is_none() && self.selected_model().is_none() {
            return;
        }
        let thread_id = session.thread_id.clone();
        let project_path = session.project_path.clone();
        if thread_id.is_none()
            && !self.creating
            && let (Some(box_bounds), Some(field_bounds)) =
                (self.composer_box_bounds, self.composer_field_bounds)
        {
            self.composer_dock_pending = Some(ComposerDockPending {
                box_bounds,
                field_height: field_bounds.size.height,
                started: Instant::now(),
            });
        }
        self.clear_composer = true;
        self.composer_menu = None;
        self.sending = true;
        self.send_motion_generation = self.send_motion_generation.wrapping_add(1);
        let send_motion_generation = self.send_motion_generation;
        cx.spawn(async move |view, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(180))
                .await;
            let _ = view.update(cx, |this, cx| {
                if this.send_motion_generation == send_motion_generation {
                    this.sending = false;
                    cx.notify();
                }
            });
        })
        .detach();
        let attachments = std::mem::take(&mut self.attachments)
            .into_iter()
            .filter_map(|attachment| attachment.path)
            .collect::<Vec<_>>();
        self.attachment_error = None;
        let model = self
            .selected_model()
            .map(|choice| choice.model.id.clone())
            .filter(|model| !model.is_empty());
        let effort = self.composer_settings.effort.clone();
        let service_tier = self.composer_settings.service_tier.clone();
        if self.creating {
            let attachments = design_attachments(attachments, self.composer_settings.design_mode);
            self.pending_draft_turns.push(PendingDraftTurn {
                text: text.clone(),
                attachments,
                steer,
                model,
                effort,
                service_tier,
            });
            self.append_optimistic_draft_prompt(text, cx);
        } else if let Some(thread_id) = thread_id {
            let started_echo_after_row = self.state.running.then_some(self.state.timeline_len());
            let steer_echo_after_row =
                (self.state.running && steer).then_some(self.state.timeline_len());
            let optimistic_queue_id = if self.state.running && !steer {
                Some(self.append_optimistic_queue_prompt(text.clone(), attachments.clone()))
            } else {
                None
            };
            if !self.state.running {
                self.append_optimistic_active_prompt(&thread_id, text.clone(), cx);
            }
            cx.emit(ChatEvent::Submit {
                thread_id,
                text,
                attachments: design_attachments(attachments, self.composer_settings.design_mode),
                steer,
                model,
                effort,
                service_tier,
                optimistic_queue_id,
                steer_echo_after_row,
                started_echo_after_row,
            });
        } else {
            self.creating = true;
            self.loading = false;
            self.append_optimistic_draft_prompt(text.clone(), cx);
            cx.emit(ChatEvent::Create {
                project_path,
                text,
                attachments,
            });
        }
        cx.notify();
    }

    fn append_optimistic_draft_prompt(&mut self, text: String, cx: &mut Context<Self>) {
        let now = unix_time_ms();
        let (turn_id, started) = self.optimistic_draft_turn_id.clone().map_or_else(
            || {
                let turn_id = format!("local-turn:{}", uuid::Uuid::new_v4());
                self.optimistic_draft_turn_id = Some(turn_id.clone());
                (turn_id, true)
            },
            |turn_id| (turn_id, false),
        );
        self.apply_live_events(
            optimistic_prompt_events(
                "",
                &turn_id,
                format!("optimistic:{}", uuid::Uuid::new_v4()),
                text,
                now,
                started,
            ),
            cx,
        );
    }

    fn append_optimistic_active_prompt(
        &mut self,
        thread_id: &str,
        text: String,
        cx: &mut Context<Self>,
    ) {
        let pending = OptimisticActiveTurn {
            turn_id: format!("local-turn:{}", uuid::Uuid::new_v4()),
            item_id: format!("optimistic:{}", uuid::Uuid::new_v4()),
            text,
            created_at: unix_time_ms(),
            after_seq: self.state.last_seq(),
        };
        self.apply_live_events(
            optimistic_prompt_events(
                thread_id,
                &pending.turn_id,
                pending.item_id.clone(),
                pending.text.clone(),
                pending.created_at,
                true,
            ),
            cx,
        );
        self.optimistic_active_turn = Some(pending);
    }

    fn append_optimistic_queue_prompt(&mut self, text: String, attachments: Vec<String>) -> String {
        let id = format!("pending:{}", uuid::Uuid::new_v4());
        self.queue.items.push(QueuedTurn {
            id: id.clone(),
            text,
            attachments,
            created_at: unix_time_ms(),
        });
        id
    }

    fn append_steered_prompt_if_missing(
        &mut self,
        thread_id: &str,
        text: String,
        created_at: f64,
        echo_after_row: usize,
        cx: &mut Context<Self>,
    ) {
        if submitted_prompt_already_visible(&self.state, &text, created_at, echo_after_row) {
            return;
        }
        let Some(turn_id) = self
            .state
            .active_turn()
            .or_else(|| self.state.turns.last())
            .map(|turn| turn.turn.id.clone())
        else {
            return;
        };
        self.apply_live_events(
            optimistic_prompt_events(
                thread_id,
                &turn_id,
                format!("optimistic:{}", uuid::Uuid::new_v4()),
                text,
                created_at,
                false,
            ),
            cx,
        );
    }

    fn append_started_prompt_if_missing(
        &mut self,
        thread_id: &str,
        turn_id: &str,
        text: String,
        created_at: f64,
        echo_after_row: usize,
        cx: &mut Context<Self>,
    ) {
        if submitted_prompt_already_visible(&self.state, &text, created_at, echo_after_row) {
            return;
        }
        self.apply_live_events(
            optimistic_prompt_events(
                thread_id,
                turn_id,
                format!("optimistic:{}", uuid::Uuid::new_v4()),
                text,
                created_at,
                self.state.turn(turn_id).is_none(),
            ),
            cx,
        );
    }

    fn reconcile_optimistic_active_turn_after_history(
        &mut self,
        thread_id: &str,
        canonical_turn_id: Option<String>,
        canonical_user_arrived: bool,
    ) {
        let Some(pending) = self.optimistic_active_turn.clone() else {
            return;
        };
        if canonical_user_arrived {
            self.optimistic_active_turn = None;
            return;
        }
        if self.state.turn(&pending.turn_id).is_some() {
            return;
        }
        let canonical_turn_id =
            canonical_turn_id.filter(|turn_id| self.state.turn(turn_id).is_some());
        let (turn_id, start_turn) = canonical_turn_id.as_ref().map_or_else(
            || (pending.turn_id.as_str(), true),
            |turn_id| (turn_id.as_str(), false),
        );
        for push in optimistic_prompt_events(
            thread_id,
            turn_id,
            pending.item_id.clone(),
            pending.text,
            pending.created_at,
            start_turn,
        ) {
            let _ = self.state.apply_live(push.seq, push.event);
        }
        if canonical_turn_id.is_some() {
            self.optimistic_active_turn = None;
        }
    }

    fn rollback_optimistic_active_turn(&mut self) {
        let Some(pending) = self.optimistic_active_turn.take() else {
            return;
        };
        if !self.state.discard_optimistic_turn(&pending.turn_id) {
            return;
        }
        self.presentation.rebuild(&self.state);
        self.reset_transcript_item_entries();
        self.list_state.reset(self.transcript_list_len());
        self.sync_structured_requests();
        self.sync_diff_summary();
        self.refresh_work_label();
    }

    fn primary_action(&mut self, cx: &mut Context<Self>) {
        if self.voice_phase != VoicePhase::Idle {
            return;
        }
        let has_text = !self.composer.read(cx).value().trim().is_empty();
        let has_draft = has_text || !self.attachments.is_empty();
        if self.state.running && !has_draft {
            if self.interrupt_pending {
                return;
            }
            if let Some(thread_id) = self
                .session
                .as_ref()
                .and_then(|session| session.thread_id.as_ref())
            {
                self.interrupt_pending = true;
                cx.emit(ChatEvent::Interrupt {
                    thread_id: thread_id.clone(),
                });
                cx.notify();
            }
        } else {
            self.submit(false, cx);
        }
    }

    fn emit_delete_queued_turn(&self, queued_turn_id: String, cx: &mut Context<Self>) {
        if let Some(thread_id) = self
            .session
            .as_ref()
            .and_then(|session| session.thread_id.clone())
        {
            cx.emit(ChatEvent::DeleteQueuedTurn {
                thread_id,
                queued_turn_id,
            });
        }
    }

    fn emit_move_queued_turn(
        &self,
        queued_turn_id: String,
        direction: QueueDirection,
        cx: &mut Context<Self>,
    ) {
        if let Some(thread_id) = self
            .session
            .as_ref()
            .and_then(|session| session.thread_id.clone())
        {
            cx.emit(ChatEvent::MoveQueuedTurn {
                thread_id,
                queued_turn_id,
                direction,
            });
        }
    }

    fn emit_steer_queued_turn(&self, queued_turn_id: String, cx: &mut Context<Self>) {
        if let Some(thread_id) = self
            .session
            .as_ref()
            .and_then(|session| session.thread_id.clone())
        {
            cx.emit(ChatEvent::SteerQueuedTurn {
                thread_id,
                queued_turn_id,
            });
        }
    }

    fn edit_queued_turn(
        &mut self,
        queued_turn_id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(queued_turn) = self
            .queue
            .items
            .iter()
            .find(|queued_turn| queued_turn.id == queued_turn_id)
            .cloned()
        else {
            return;
        };
        let draft = self.composer.read(cx).value().to_string();
        let text = merge_queued_draft(&queued_turn.text, &draft);
        self.composer.update(cx, |composer, cx| {
            composer.set_value(text, window, cx);
            composer.focus(window, cx);
        });
        merge_unique_attachments(&mut self.attachments, queued_turn.attachments);
        self.emit_delete_queued_turn(queued_turn.id, cx);
        cx.notify();
    }

    fn start_voice(&mut self, cx: &mut Context<Self>) {
        if self.voice_phase != VoicePhase::Idle
            || !self.composer_settings.voice_available
            || self.state.running
        {
            return;
        }
        self.voice_error = None;
        match self.voice_recorder.start() {
            Ok(()) => {
                self.voice_phase = VoicePhase::Recording;
                self.voice_levels.clear();
                self.schedule_voice_tick(cx);
            }
            Err(error) => self.voice_error = Some(error),
        }
        cx.notify();
    }

    fn stop_voice(&mut self, send_after: bool, cx: &mut Context<Self>) {
        if self.voice_phase != VoicePhase::Recording {
            return;
        }
        self.voice_phase = VoicePhase::Transcribing;
        self.voice_error = None;
        self.voice_cursor = self.composer.read(cx).cursor();
        self.voice_send_after = send_after;
        match self.voice_recorder.stop() {
            Ok(Some(recording)) => {
                let request_id = uuid::Uuid::new_v4().to_string();
                self.voice_request_id = Some(request_id.clone());
                cx.emit(ChatEvent::TranscribeVoice {
                    params: VoiceTranscribeParams {
                        request_id,
                        provider: ProviderId::Codex,
                        audio_base64: recording.audio_base64,
                        mime_type: VoiceMimeType::Wav,
                        sample_rate_hz: VOICE_SAMPLE_RATE,
                        duration_ms: recording.duration_ms,
                    },
                });
            }
            Ok(None) => {
                self.voice_phase = VoicePhase::Idle;
                self.voice_error = Some(
                    "No audio was captured. Check the selected microphone and try again.".into(),
                );
            }
            Err(error) => {
                self.voice_phase = VoicePhase::Idle;
                self.voice_error = Some(error);
            }
        }
        cx.notify();
    }

    fn cancel_voice(&mut self, cx: &mut Context<Self>) {
        if self.voice_phase == VoicePhase::Idle && self.voice_request_id.is_none() {
            return;
        }
        if let Some(request_id) = self.voice_request_id.take() {
            cx.emit(ChatEvent::CancelVoice { request_id });
        }
        self.voice_recorder.cancel();
        self.voice_phase = VoicePhase::Idle;
        self.voice_error = None;
        self.voice_levels.clear();
        cx.notify();
    }

    fn schedule_voice_tick(&mut self, cx: &mut Context<Self>) {
        if self.voice_tick_scheduled {
            return;
        }
        self.voice_tick_scheduled = true;
        cx.spawn(async move |view, cx| {
            loop {
                cx.background_executor().timer(VOICE_LEVEL_INTERVAL).await;
                let keep_ticking = view
                    .update(cx, |this, cx| this.voice_tick(cx))
                    .unwrap_or(false);
                if !keep_ticking {
                    break;
                }
            }
        })
        .detach();
    }

    fn voice_tick(&mut self, cx: &mut Context<Self>) -> bool {
        if self.voice_phase != VoicePhase::Recording {
            self.voice_tick_scheduled = false;
            return false;
        }
        if let Some(error) = self.voice_recorder.take_error() {
            self.voice_recorder.cancel();
            self.voice_phase = VoicePhase::Idle;
            self.voice_error = Some(error);
            self.voice_tick_scheduled = false;
            cx.notify();
            return false;
        }
        self.voice_levels.push(self.voice_recorder.level());
        if self.voice_levels.len() > MAX_WAVEFORM_LEVELS {
            let excess = self.voice_levels.len() - MAX_WAVEFORM_LEVELS;
            self.voice_levels.drain(..excess);
        }
        if self.voice_recorder.elapsed() >= MAX_RECORDING_DURATION {
            self.voice_tick_scheduled = false;
            self.stop_voice(false, cx);
            return false;
        }
        cx.notify();
        true
    }

    fn toggle_composer_menu(&mut self, menu: ComposerMenu, cx: &mut Context<Self>) {
        if self.state.running {
            return;
        }
        let next = if self.composer_menu == Some(menu) {
            None
        } else {
            Some(menu)
        };
        if self.composer_menu == Some(ComposerMenu::Model) && next != self.composer_menu {
            self.reset_effort_interaction();
            self.model_search_focus_pending = false;
        }
        if next == Some(ComposerMenu::Model) && self.composer_menu != next {
            self.active_model_source_key = self.selected_model().map(model_picker_source_key);
            self.model_search_reset = true;
            self.model_search_focus_pending = true;
        }
        self.composer_menu = next;
        cx.notify();
    }

    fn prepare_model_search_input(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.model_search_reset {
            self.model_search.update(cx, |input, cx| {
                input.set_value("", window, cx);
            });
            self.model_search_reset = false;
        }
        if self.model_search_focus_pending && self.composer_menu == Some(ComposerMenu::Model) {
            self.model_search
                .update(cx, |input, cx| input.focus(window, cx));
            self.model_search_focus_pending = false;
        }
    }

    fn select_model_source(&mut self, key: String, cx: &mut Context<Self>) {
        if self.active_model_source_key.as_deref() != Some(key.as_str()) {
            self.active_model_source_key = Some(key);
            cx.notify();
        }
    }

    fn choose_project(&mut self, path: String, cx: &mut Context<Self>) {
        self.composer_menu = None;
        cx.emit(ChatEvent::SelectProject { path });
        cx.notify();
    }

    fn choose_branch(&mut self, branch: String, cx: &mut Context<Self>) {
        self.composer_menu = None;
        cx.emit(ChatEvent::SelectBranch { branch });
        cx.notify();
    }

    fn choose_model(&mut self, key: String, cx: &mut Context<Self>) {
        self.reset_effort_interaction();
        cx.emit(ChatEvent::SelectModel { key });
    }

    fn choose_effort(&mut self, effort: String, cx: &mut Context<Self>) {
        cx.emit(ChatEvent::SelectEffort { effort });
    }

    fn reset_effort_interaction(&mut self) {
        self.effort_slider_bounds = None;
        self.effort_pointer = None;
        self.effort_dragging = false;
        self.effort_preview_index = None;
        self.effort_dither_fading = false;
        self.effort_dither_generation = self.effort_dither_generation.wrapping_add(1);
    }

    fn effort_slider_bounds_changed(&mut self, bounds: Bounds<Pixels>) {
        if self.effort_slider_bounds != Some(bounds) {
            self.effort_slider_bounds = Some(bounds);
        }
    }

    fn effort_index_at(&self, position: Point<Pixels>, count: usize) -> usize {
        let Some(bounds) = self.effort_slider_bounds else {
            return 0;
        };
        effort_index_from_pointer(
            f32::from(position.x),
            f32::from(bounds.origin.x),
            f32::from(bounds.size.width),
            count,
            f32::from(px(EFFORT_SLIDER_INSET)),
            f32::from(px(EFFORT_SLIDER_MIN_FILL)),
        )
    }

    fn effort_pointer_moved(
        &mut self,
        event: &gpui::MouseMoveEvent,
        count: usize,
        cx: &mut Context<Self>,
    ) {
        if count == 0 {
            return;
        }
        let index = self.effort_index_at(event.position, count);
        let pointer_changed = self.effort_pointer.is_none_or(|previous| {
            (f32::from(previous.x - event.position.x)).abs() >= 0.5
                || (f32::from(previous.y - event.position.y)).abs() >= 0.5
        });
        let preview_changed = self.effort_dragging && self.effort_preview_index != Some(index);
        let activating = self.effort_pointer.is_none() || self.effort_dither_fading;
        self.effort_pointer = Some(event.position);
        if self.effort_dragging {
            self.effort_preview_index = Some(index);
        }
        if activating {
            self.effort_dither_fading = false;
            self.effort_dither_generation = self.effort_dither_generation.wrapping_add(1);
        }
        if pointer_changed || preview_changed || activating {
            cx.notify();
        }
    }

    fn begin_effort_drag(
        &mut self,
        event: &gpui::MouseDownEvent,
        count: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if event.button != gpui::MouseButton::Left || count <= 1 {
            return;
        }
        self.effort_focus.focus(window);
        self.effort_dragging = true;
        self.effort_preview_index = Some(self.effort_index_at(event.position, count));
        self.effort_pointer = Some(event.position);
        self.effort_dither_fading = false;
        self.effort_dither_generation = self.effort_dither_generation.wrapping_add(1);
        cx.stop_propagation();
        cx.notify();
    }

    fn finish_effort_drag(
        &mut self,
        event: &gpui::MouseUpEvent,
        efforts: &[String],
        selected_index: usize,
        cx: &mut Context<Self>,
    ) {
        if !self.effort_dragging || efforts.is_empty() {
            return;
        }
        let index = self.effort_index_at(event.position, efforts.len());
        self.effort_dragging = false;
        self.effort_preview_index = Some(index);
        self.effort_pointer = Some(event.position);
        cx.stop_propagation();
        if index != selected_index
            && let Some(effort) = efforts.get(index)
        {
            self.choose_effort(effort.clone(), cx);
        } else {
            self.effort_preview_index = None;
        }
        cx.notify();
    }

    fn cancel_effort_drag(&mut self, cx: &mut Context<Self>) {
        if self.effort_dragging {
            self.effort_dragging = false;
            self.effort_preview_index = None;
        }
        self.begin_effort_dither_fade(cx);
    }

    fn begin_effort_dither_fade(&mut self, cx: &mut Context<Self>) {
        if self.effort_pointer.is_none() || self.effort_dither_fading {
            return;
        }
        self.effort_dither_fading = true;
        self.effort_dither_generation = self.effort_dither_generation.wrapping_add(1);
        let generation = self.effort_dither_generation;
        cx.notify();
        cx.spawn(async move |view, cx| {
            cx.background_executor().timer(EFFORT_DITHER_FADE_OUT).await;
            let _ = view.update(cx, |this, cx| {
                if this.effort_dither_generation == generation
                    && this.effort_dither_fading
                    && !this.effort_dragging
                {
                    this.effort_pointer = None;
                    this.effort_dither_fading = false;
                    cx.notify();
                }
            });
        })
        .detach();
    }

    fn effort_key_down(
        &mut self,
        event: &gpui::KeyDownEvent,
        efforts: &[String],
        selected_index: usize,
        cx: &mut Context<Self>,
    ) {
        if efforts.len() <= 1 {
            return;
        }
        let current = self.effort_preview_index.unwrap_or(selected_index);
        let next = match event.keystroke.key.to_ascii_lowercase().as_str() {
            "left" | "down" => current.saturating_sub(1),
            "right" | "up" => (current + 1).min(efforts.len() - 1),
            "home" => 0,
            "end" => efforts.len() - 1,
            _ => return,
        };
        cx.stop_propagation();
        if next != current {
            self.effort_preview_index = Some(next);
            self.choose_effort(efforts[next].clone(), cx);
            cx.notify();
        }
    }

    fn choose_approval(&mut self, approval: ApprovalMode, cx: &mut Context<Self>) {
        self.composer_menu = None;
        cx.emit(ChatEvent::SelectApproval { approval });
        cx.notify();
    }

    fn selected_model(&self) -> Option<&ModelChoice> {
        let key = self.composer_settings.selected_model_key.as_ref()?;
        self.composer_settings
            .models
            .iter()
            .find(|choice| choice.key == *key)
    }

    fn structured_surfaces(&self, weak: &gpui::WeakEntity<Self>) -> Option<AnyElement> {
        if self.state.approvals.is_empty() && self.state.reviews.is_empty() {
            return None;
        }
        let approval_count = self.state.approvals.len();
        let approvals = self
            .state
            .approvals
            .iter()
            .enumerate()
            .map(|(index, request)| self.approval_card(request, index, weak));
        let reviews = self
            .state
            .reviews
            .iter()
            .enumerate()
            .map(|(index, review)| self.approval_review_card(review, approval_count + index));

        Some(
            div()
                .id("structured-surfaces")
                .w_full()
                .flex()
                .flex_col()
                .gap(px(12.0))
                .children(approvals)
                .children(reviews)
                .into_any_element(),
        )
    }

    fn transcript_footer_visible(&self) -> bool {
        !self.state.approvals.is_empty()
            || !self.state.reviews.is_empty()
            || if self.state.running {
                self.state.plan.as_ref().is_some_and(|(_, steps)| {
                    steps.iter().any(|step| {
                        matches!(
                            step.status,
                            harness_protocol::PlanStepStatus::Running
                                | harness_protocol::PlanStepStatus::Pending
                        )
                    })
                })
            } else {
                self.diff_ui.has_summary()
            }
    }

    fn transcript_list_len(&self) -> usize {
        self.state.timeline_len() + usize::from(self.transcript_footer_visible())
    }

    fn reconcile_transcript_footer(&mut self, was_visible: bool) {
        let row = self.state.timeline_len();
        match (was_visible, self.transcript_footer_visible()) {
            (false, true) => self.list_state.splice(row..row, 1),
            (true, false) => self.list_state.splice(row..row + 1, 0),
            (true, true) => self.list_state.splice(row..row + 1, 1),
            (false, false) => {}
        }
    }

    fn remeasure_transcript_footer(&mut self) {
        if self.transcript_footer_visible() {
            let row = self.state.timeline_len();
            self.list_state.splice(row..row + 1, 1);
        }
    }

    fn transcript_footer(&self, weak: &gpui::WeakEntity<Self>) -> Option<AnyElement> {
        let structured = self.structured_surfaces(weak);
        let control = self.control_surface(weak);
        if structured.is_none() && control.is_none() {
            return None;
        }
        Some(
            div()
                .w_full()
                .max_w(px(CHAT_WIDTH + 48.0))
                .mx_auto()
                .pb(px(4.0))
                .child(
                    div()
                        .w_full()
                        .max_w(px(CHAT_WIDTH))
                        .mx_auto()
                        .flex()
                        .flex_col()
                        .gap(px(12.0))
                        .when_some(structured, |footer, structured| footer.child(structured))
                        .when_some(control, |footer, control| footer.child(control)),
                )
                .into_any_element(),
        )
    }

    fn approval_card(
        &self,
        request: &harness_protocol::ApprovalRequest,
        card_index: usize,
        weak: &gpui::WeakEntity<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let pending = self.pending_approvals.contains(&request.id);
        let weak = weak.clone();
        let actions = [
            ("Deny", ApprovalDecision::Deny, true),
            ("Stop the turn", ApprovalDecision::Abort, false),
            (
                "Always this session",
                ApprovalDecision::ApproveSession,
                false,
            ),
            ("Allow once", ApprovalDecision::Approve, true),
        ]
        .into_iter()
        .enumerate()
        .map(|(action_index, (label, decision, filled))| {
            let approval_id = request.id.clone();
            let weak = weak.clone();
            let action: Option<UiAction> = (!pending).then(|| {
                Rc::new(move |cx: &mut App| {
                    let approval_id = approval_id.clone();
                    let _ = weak.update(cx, |this, cx| {
                        this.decide_approval(approval_id, decision, cx);
                    });
                }) as UiAction
            });
            approval_action_button(
                card_index * 4 + action_index,
                label,
                filled,
                action_index == 2,
                theme,
                action,
            )
            .into_any_element()
        })
        .collect::<Vec<_>>();

        div()
            .w_full()
            .rounded(px(5.0))
            .border_1()
            .border_color(theme.line_strong.hsla())
            .bg(theme.surface.hsla())
            .px(px(14.0))
            .py(px(12.0))
            .child(
                div()
                    .mb(px(10.0))
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .text_color(theme.text_2.hsla())
                    .child(motion_icon(
                        ("approval-icon", card_index),
                        "icons/shield-alert.svg",
                        14.0,
                        "approval-icon-direct-hover",
                        theme,
                    ))
                    .child(
                        div()
                            .text_color(theme.text.hsla())
                            .font_weight(FontWeight(560.0))
                            .child(approval_title(request.kind)),
                    ),
            )
            .when_some(request.command.clone(), |card, command| {
                card.child(
                    div()
                        .w_full()
                        .mb(px(8.0))
                        .rounded(px(3.0))
                        .border_1()
                        .border_color(theme.line.hsla())
                        .bg(theme.background.hsla())
                        .px(px(10.0))
                        .py(px(8.0))
                        .font_family("Geist Mono")
                        .text_size(px(12.5))
                        .line_height(relative(1.5))
                        .whitespace_normal()
                        .child(command),
                )
            })
            .when_some(request.path.clone(), |card, path| {
                card.child(
                    div()
                        .mb(px(8.0))
                        .font_family("Geist Mono")
                        .text_size(px(12.5))
                        .line_height(relative(1.5))
                        .whitespace_normal()
                        .child(path),
                )
            })
            .when_some(request.cwd.clone(), |card, cwd| {
                card.child(
                    div()
                        .mb(px(8.0))
                        .flex()
                        .gap(px(5.0))
                        .text_size(px(12.5))
                        .text_color(theme.text_3.hsla())
                        .child("in")
                        .child(
                            div()
                                .font_family("Geist Mono")
                                .whitespace_normal()
                                .child(cwd),
                        ),
                )
            })
            .when_some(request.reason.clone(), |card, reason| {
                card.child(
                    div()
                        .mb(px(12.0))
                        .rounded(px(3.0))
                        .bg(theme.surface_2.hsla())
                        .px(px(10.0))
                        .py(px(8.0))
                        .text_size(px(12.5))
                        .line_height(relative(1.6))
                        .text_color(theme.text_2.hsla())
                        .whitespace_normal()
                        .child(reason),
                )
            })
            .when_some(
                self.action_errors.get(&request.id).cloned(),
                |card, error| {
                    card.child(
                        div()
                            .mb(px(9.0))
                            .text_size(px(11.0))
                            .text_color(theme.error.hsla())
                            .child(error),
                    )
                },
            )
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(6.0))
                    .children(actions),
            )
            .into_any_element()
    }

    fn approval_review_card(&self, review: &ApprovalReview, card_index: usize) -> AnyElement {
        let theme = self.theme;
        let (status, icon_path) = review_status(review.status);
        let reviewing = review.status == ApprovalReviewStatus::InProgress;
        div()
            .id(("approval-review", card_index))
            .w_full()
            .rounded(px(5.0))
            .border_1()
            .border_color(theme.line_strong.hsla())
            .bg(theme.surface.hsla())
            .px(px(14.0))
            .py(px(12.0))
            .child(
                div()
                    .mb(px(6.0))
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .text_color(theme.text_2.hsla())
                    .child(if reviewing {
                        svg()
                            .path("icons/loader-circle.svg")
                            .size(px(11.0))
                            .with_animation(
                                ("approval-review-spinner", card_index),
                                theme.repeating_animation(Duration::from_millis(700)),
                                |spinner, delta| {
                                    spinner.with_transformation(gpui::Transformation::rotate(
                                        gpui::percentage(delta),
                                    ))
                                },
                            )
                            .into_any_element()
                    } else {
                        motion_icon(
                            ("approval-review-icon", card_index),
                            icon_path,
                            14.0,
                            "approval-review-icon-direct-hover",
                            theme,
                        )
                        .into_any_element()
                    })
                    .child(
                        div()
                            .font_weight(FontWeight(560.0))
                            .text_color(theme.text.hsla())
                            .child(status),
                    )
                    .when_some(review.risk_level, |head, risk| {
                        head.child(
                            div()
                                .ml_auto()
                                .text_size(px(11.5))
                                .text_color(theme.text_3.hsla())
                                .child(format!("{} risk", risk_label(risk))),
                        )
                    }),
            )
            .child(
                div()
                    .font_family("Geist Mono")
                    .text_size(px(12.5))
                    .line_height(relative(1.5))
                    .whitespace_normal()
                    .child(review.description.clone()),
            )
            .when_some(review.rationale.clone(), |card, rationale| {
                card.child(
                    div()
                        .mt(px(6.0))
                        .text_size(px(12.5))
                        .line_height(relative(1.5))
                        .text_color(theme.text_2.hsla())
                        .whitespace_normal()
                        .child(rationale),
                )
            })
            .into_any_element()
    }

    fn user_input_card(&self, window: &Window, cx: &Context<Self>) -> Option<AnyElement> {
        let request = self.active_user_input()?;
        let question = request.questions.get(self.user_input_step)?;
        let theme = self.theme;
        let pending = self.pending_user_inputs.contains(&request.id);

        if pending {
            let request_animation_id = request.created_at.max(0.0) as u64;
            return Some(
                div()
                    .absolute()
                    .left(px(0.0))
                    .bottom(relative(1.0))
                    .mb(px(BRIEF_STATUS_GAP))
                    .h(px(36.0))
                    .overflow_hidden()
                    .flex()
                    .items_center()
                    .gap(px(9.0))
                    .rounded(px(20.0))
                    .border_1()
                    .border_color(theme.line_strong.hsla())
                    .bg(theme.surface.hsla().opacity(0.94))
                    .shadow(brief_flyout_shadows(theme))
                    .px(px(13.0))
                    .text_size(px(12.5))
                    .text_color(theme.text_2.hsla())
                    .child(
                        div()
                            .absolute()
                            .top_0()
                            .left_0()
                            .right_0()
                            .h(px(1.0))
                            .bg(gpui::white().opacity(0.07)),
                    )
                    .child(
                        div()
                            .relative()
                            .size(px(14.0))
                            .flex_none()
                            .child(
                                div()
                                    .absolute()
                                    .inset_0()
                                    .rounded_full()
                                    .border_2()
                                    .border_color(theme.line_strong.hsla()),
                            )
                            .child(
                                svg()
                                    .absolute()
                                    .inset_0()
                                    .path("icons/brief-loader-quarter.svg")
                                    .size(px(14.0))
                                    .text_color(theme.text.hsla())
                                    .with_animation(
                                        ("brief-submit-spinner", request_animation_id),
                                        theme.repeating_animation(Duration::from_millis(700)),
                                        |spinner, delta| {
                                            spinner.with_transformation(
                                                gpui::Transformation::rotate(gpui::percentage(
                                                    delta,
                                                )),
                                            )
                                        },
                                    ),
                            ),
                    )
                    .child("Submitting answers…")
                    .with_animation(
                        ("brief-submit", request_animation_id),
                        Animation::new(theme.motion_duration(Duration::from_millis(220)))
                            .with_easing(crate::theme::web_ease_out),
                        move |card, delta| {
                            card.mb(px(brief_entry_margin(BRIEF_STATUS_GAP, delta)))
                                .opacity(delta)
                        },
                    )
                    .into_any_element(),
            );
        }

        let selected = self.user_input_answers.get(&question.id);
        let options = question.options.as_deref().unwrap_or_default();
        let custom_available = question.allow_other || options.is_empty();
        let custom_selected = self.user_input_custom_question.as_deref() == Some(&question.id);
        let custom_focused = custom_selected
            && self
                .user_input_custom
                .read(cx)
                .focus_handle(cx)
                .is_focused(window);
        let weak = cx.weak_entity();
        let option_rows = options.iter().enumerate().map(|(index, option)| {
            let active = selected.is_some_and(|answer| answer == &option.label);
            let press_group: SharedString = format!("brief-option-{index}-press").into();
            let question_id = question.id.clone();
            let answer = option.label.clone();
            let weak = weak.clone();
            div()
                .id(("brief-option", index))
                .group(press_group.clone())
                .min_h(px(38.0))
                .w_full()
                .mx_auto()
                .flex()
                .items_center()
                .gap(px(9.0))
                .px(px(10.0))
                .py(px(7.0))
                .rounded(px(5.0))
                .overflow_hidden()
                .border_1()
                .border_color(if active {
                    theme.text_2.hsla().opacity(0.74)
                } else {
                    theme.line_strong.hsla().opacity(0.68)
                })
                .bg(brief_option_background(theme, active, false))
                .shadow(brief_option_outer_shadows(active))
                .cursor_pointer()
                .hover(move |style| {
                    style
                        .border_color(if active {
                            theme.text_2.hsla().opacity(0.74)
                        } else {
                            theme.line_strong.hsla()
                        })
                        .bg(brief_option_background(theme, active, true))
                        .text_color(theme.text.hsla())
                })
                .active(|style| {
                    style
                        .w(relative(0.985))
                        .min_h(px(37.43))
                        .my(px(0.285))
                        .gap(px(8.865))
                        .px(px(9.85))
                        .py(px(6.895))
                        .rounded(px(4.925))
                        .shadow(Vec::new())
                })
                .on_click(move |_event, _window, cx| {
                    let question_id = question_id.clone();
                    let answer = answer.clone();
                    let _ = weak.update(cx, |this, cx| {
                        this.select_user_input_option(question_id, answer, cx);
                    });
                })
                .child(brief_option_inset(active, press_group.clone()))
                .child(radio_mark(
                    format!("brief-option-radio-{index}").into(),
                    active,
                    press_group.clone(),
                    theme,
                ))
                .child(
                    div()
                        .id(("brief-option-label", index))
                        .min_w(px(0.0))
                        .truncate()
                        .text_size(px(12.5))
                        .font_weight(FontWeight(530.0))
                        .text_color(if active {
                            theme.text.hsla()
                        } else {
                            theme.text_2.hsla()
                        })
                        .group_active(press_group, |style| style.text_size(px(12.3125)))
                        .child(option.label.clone()),
                )
                .into_any_element()
        });

        let custom_row = custom_available.then(|| {
            let press_group: SharedString = "brief-custom-option-press".into();
            let question_id = question.id.clone();
            let weak = cx.weak_entity();
            div()
                .id("brief-custom-option")
                .group(press_group.clone())
                .min_h(px(38.0))
                .w_full()
                .mx_auto()
                .flex()
                .items_center()
                .gap(px(9.0))
                .px(px(10.0))
                .py(px(7.0))
                .rounded(px(5.0))
                .overflow_hidden()
                .border_1()
                .border_color(if custom_focused {
                    theme.text_2.hsla()
                } else if custom_selected {
                    theme.text_2.hsla().opacity(0.74)
                } else {
                    theme.line_strong.hsla().opacity(0.68)
                })
                .bg(brief_option_background(theme, custom_selected, false))
                .shadow(brief_option_outer_shadows(custom_selected))
                .cursor_text()
                .hover(move |style| {
                    style
                        .border_color(if custom_focused {
                            theme.text_2.hsla()
                        } else if custom_selected {
                            theme.text_2.hsla().opacity(0.74)
                        } else {
                            theme.line_strong.hsla()
                        })
                        .bg(brief_option_background(theme, custom_selected, true))
                        .text_color(theme.text.hsla())
                })
                .active(|style| {
                    style
                        .w(relative(0.985))
                        .min_h(px(37.43))
                        .my(px(0.285))
                        .gap(px(8.865))
                        .px(px(9.85))
                        .py(px(6.895))
                        .rounded(px(4.925))
                        .shadow(Vec::new())
                })
                .on_click(move |_event, _window, cx| {
                    let question_id = question_id.clone();
                    let _ = weak.update(cx, |this, cx| {
                        this.select_user_input_custom(question_id, cx);
                    });
                })
                .child(brief_option_inset(custom_selected, press_group.clone()))
                .child(radio_mark(
                    "brief-custom-radio".into(),
                    custom_selected,
                    press_group.clone(),
                    theme,
                ))
                .when(custom_selected, |row| {
                    row.child(
                        div()
                            .id("brief-custom-input-press")
                            .h(px(28.0))
                            .min_w(px(0.0))
                            .flex_1()
                            .flex()
                            .items_center()
                            .px(px(8.0))
                            .group_active(press_group.clone(), |style| {
                                style.h(px(27.58)).px(px(7.88))
                            })
                            .child(
                                Input::new(&self.user_input_custom)
                                    .xsmall()
                                    .appearance(false)
                                    .bordered(false)
                                    .focus_bordered(false)
                                    .min_w(px(0.0))
                                    .flex_1()
                                    .px(px(0.0))
                                    .py(px(0.0))
                                    .line_height(px(16.0))
                                    .text_size(px(12.5))
                                    .text_color(theme.text.hsla()),
                            ),
                    )
                })
                .when(!custom_selected, |row| {
                    row.child(
                        div()
                            .id("brief-custom-preview-press")
                            .relative()
                            .flex_1()
                            .min_h(px(28.0))
                            .overflow_hidden()
                            .rounded(px(3.0))
                            .border_1()
                            .border_color(theme.line.hsla())
                            .bg(theme.surface.hsla().opacity(0.72))
                            .px(px(8.0))
                            .py(px(5.0))
                            .line_height(px(16.0))
                            .text_size(px(12.5))
                            .font_weight(FontWeight(450.0))
                            .text_color(theme.text_3.hsla())
                            .group_active(press_group, |style| {
                                style
                                    .min_h(px(27.58))
                                    .rounded(px(2.955))
                                    .px(px(7.88))
                                    .py(px(4.925))
                                    .line_height(px(15.76))
                                    .text_size(px(12.3125))
                            })
                            .child(brief_inset_top_shadow(0.18))
                            .child("Write your own answer…"),
                    )
                })
                .into_any_element()
        });

        let answer_ready = selected.is_some_and(|answer| !answer.trim().is_empty());
        let last_step = self.user_input_step + 1 == request.questions.len();
        let back_action: Option<UiAction> = (self.user_input_step > 0).then(|| {
            let weak = cx.weak_entity();
            Rc::new(move |cx: &mut App| {
                let _ = weak.update(cx, |this, cx| this.back_user_input(cx));
            }) as UiAction
        });
        let next_action: Option<UiAction> = answer_ready.then(|| {
            let weak = cx.weak_entity();
            Rc::new(move |cx: &mut App| {
                let _ = weak.update(cx, |this, cx| this.advance_user_input(cx));
            }) as UiAction
        });
        let request_animation_id = request.created_at.max(0.0) as u64;
        let error = self.action_errors.get(&request.id).cloned();

        Some(
            div()
                .absolute()
                .left(px(0.0))
                .right(px(0.0))
                .bottom(relative(1.0))
                .mb(px(BRIEF_CARD_GAP))
                .w_full()
                .overflow_hidden()
                .rounded(px(20.0))
                .border_1()
                .border_color(theme.line_strong.hsla())
                .bg(theme.surface.hsla().opacity(0.94))
                .shadow(brief_flyout_shadows(theme))
                .on_scroll_wheel(cx.listener(|this, event, _window, cx| {
                    this.navigate_user_input_wheel(event, cx);
                }))
                .child(
                    div()
                        .absolute()
                        .top_0()
                        .left_0()
                        .right_0()
                        .h(px(1.0))
                        .bg(gpui::white().opacity(0.07)),
                )
                .child(
                    div()
                        .px(px(18.0))
                        .pt(px(16.0))
                        .pb(px(14.0))
                        .child(
                            div()
                                .text_size(px(15.0))
                                .font_weight(FontWeight(600.0))
                                .line_height(relative(1.35))
                                .text_color(theme.text.hsla())
                                .whitespace_normal()
                                .child(tracked_text(question.question.clone(), -0.01)),
                        )
                        .child(
                            div()
                                .mt(px(12.0))
                                .flex()
                                .flex_col()
                                .gap(px(5.0))
                                .children(option_rows)
                                .when_some(custom_row, |options, custom| options.child(custom)),
                        )
                        .when_some(error, |body, error| {
                            body.child(
                                div()
                                    .mt(px(9.0))
                                    .text_size(px(11.0))
                                    .text_color(theme.error.hsla())
                                    .child(error),
                            )
                        }),
                )
                .child(
                    div()
                        .min_h(px(48.0))
                        .flex()
                        .items_center()
                        .gap(px(12.0))
                        .border_t_1()
                        .border_color(theme.line.hsla())
                        .pl(px(18.0))
                        .pr(px(9.0))
                        .py(px(7.0))
                        .child(
                            div()
                                .flex_1()
                                .text_size(px(11.5))
                                .text_color(theme.text_3.hsla())
                                .child(format!(
                                    "Question {} of {}",
                                    self.user_input_step + 1,
                                    request.questions.len()
                                )),
                        )
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(6.0))
                                .when_some(back_action, |actions, action| {
                                    actions.child(input_nav_button(
                                        "brief-back",
                                        "Back",
                                        false,
                                        theme,
                                        Some(action),
                                    ))
                                })
                                .child(input_nav_button(
                                    "brief-next",
                                    if last_step { "Submit" } else { "Next" },
                                    true,
                                    theme,
                                    next_action,
                                )),
                        ),
                )
                .with_animation(
                    ("brief-input", request_animation_id),
                    Animation::new(theme.motion_duration(Duration::from_millis(220)))
                        .with_easing(crate::theme::web_ease_out),
                    move |card, delta| {
                        let horizontal_inset = 0.005 * (1.0 - delta);
                        card.mb(px(brief_entry_margin(BRIEF_CARD_GAP, delta)))
                            .left(relative(horizontal_inset))
                            .right(relative(horizontal_inset))
                            .opacity(delta)
                    },
                )
                .into_any_element(),
        )
    }

    fn queue_panel(&self, window: &Window, cx: &Context<Self>) -> Option<AnyElement> {
        if self.queue.items.is_empty() {
            return None;
        }
        let theme = self.theme;
        let can_steer = self.queue.can_steer;
        let queue_len = self.queue.items.len();
        let maximum_height = (window.viewport_size().height * 0.4).min(px(280.0));
        let rows = self
            .queue
            .items
            .iter()
            .cloned()
            .enumerate()
            .map(|(index, queued_turn)| {
                let move_up_id = queued_turn.id.clone();
                let move_down_id = queued_turn.id.clone();
                let steer_id = queued_turn.id.clone();
                let edit_id = queued_turn.id.clone();
                let delete_id = queued_turn.id.clone();
                let move_up_group: SharedString = format!("queue-move-up-{index}").into();
                let move_down_group: SharedString = format!("queue-move-down-{index}").into();
                let steer_group: SharedString = format!("queue-steer-{index}").into();
                let edit_group: SharedString = format!("queue-edit-{index}").into();
                let delete_group: SharedString = format!("queue-delete-{index}").into();
                let move_up = div()
                    .id(("queue-move-up", index))
                    .group(move_up_group.clone())
                    .w(px(20.0))
                    .flex_1()
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_color(theme.queue_action.hsla())
                    .opacity(if index == 0 { 0.25 } else { 1.0 })
                    .when(index > 0, |button| {
                        button
                            .cursor_pointer()
                            .hover(move |style| style.text_color(theme.text.hsla()))
                            .on_click(cx.listener(move |this, _event, _window, cx| {
                                this.emit_move_queued_turn(
                                    move_up_id.clone(),
                                    QueueDirection::Up,
                                    cx,
                                );
                            }))
                    })
                    .child(motion_icon(
                        ("queue-move-up-icon", index),
                        "icons/arrow-up.svg",
                        12.0,
                        move_up_group,
                        theme,
                    ));
                let move_down = div()
                    .id(("queue-move-down", index))
                    .group(move_down_group.clone())
                    .w(px(20.0))
                    .flex_1()
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_color(theme.queue_action.hsla())
                    .opacity(if index + 1 == queue_len { 0.25 } else { 1.0 })
                    .when(index + 1 < queue_len, |button| {
                        button
                            .cursor_pointer()
                            .hover(move |style| style.text_color(theme.text.hsla()))
                            .on_click(cx.listener(move |this, _event, _window, cx| {
                                this.emit_move_queued_turn(
                                    move_down_id.clone(),
                                    QueueDirection::Down,
                                    cx,
                                );
                            }))
                    })
                    .child(motion_icon(
                        ("queue-move-down-icon", index),
                        "icons/arrow-down.svg",
                        12.0,
                        move_down_group,
                        theme,
                    ));
                let steer = can_steer.then(|| {
                    div()
                        .id(("queue-steer", index))
                        .group(steer_group.clone())
                        .h(px(28.0))
                        .flex_none()
                        .px(px(6.0))
                        .flex()
                        .items_center()
                        .justify_center()
                        .gap(px(5.0))
                        .rounded(px(5.0))
                        .text_size(px(13.5))
                        .text_color(theme.queue_action.hsla())
                        .cursor_pointer()
                        .hover(move |style| {
                            style
                                .bg(theme.queue_hover.hsla())
                                .text_color(theme.text.hsla())
                        })
                        .on_click(cx.listener(move |this, _event, _window, cx| {
                            this.emit_steer_queued_turn(steer_id.clone(), cx);
                        }))
                        .child(motion_icon(
                            ("queue-steer-icon", index),
                            "icons/corner-down-right.svg",
                            15.0,
                            steer_group,
                            theme,
                        ))
                        .child("Steer")
                });
                let edit = div()
                    .id(("queue-edit", index))
                    .group(edit_group.clone())
                    .size(px(28.0))
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(5.0))
                    .text_color(theme.queue_action.hsla())
                    .cursor_pointer()
                    .hover(move |style| {
                        style
                            .bg(theme.queue_hover.hsla())
                            .text_color(theme.text.hsla())
                    })
                    .on_click(cx.listener(move |this, _event, window, cx| {
                        this.edit_queued_turn(&edit_id, window, cx);
                    }))
                    .child(motion_icon(
                        ("queue-edit-icon", index),
                        "icons/pencil.svg",
                        14.0,
                        edit_group,
                        theme,
                    ));
                let delete = div()
                    .id(("queue-delete", index))
                    .group(delete_group.clone())
                    .size(px(28.0))
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(5.0))
                    .text_color(theme.queue_action.hsla())
                    .cursor_pointer()
                    .hover(move |style| {
                        style
                            .bg(theme.queue_hover.hsla())
                            .text_color(theme.text.hsla())
                    })
                    .on_click(cx.listener(move |this, _event, _window, cx| {
                        this.emit_delete_queued_turn(delete_id.clone(), cx);
                    }))
                    .child(motion_icon(
                        ("queue-delete-icon", index),
                        "icons/trash-2.svg",
                        15.0,
                        delete_group,
                        theme,
                    ));
                let row_animation_id = SharedString::from(format!("queue-row-{}", queued_turn.id));
                div()
                    .relative()
                    .min_w(px(0.0))
                    .min_h(px(38.0))
                    .flex()
                    .items_center()
                    .gap(px(10.0))
                    .px(px(7.0))
                    .text_color(theme.queue_text.hsla())
                    .child(
                        div()
                            .h(px(38.0))
                            .w(px(25.0))
                            .flex_none()
                            .flex()
                            .flex_col()
                            .pl(px(5.0))
                            .border_l_2()
                            .border_color(theme.queue_line.hsla())
                            .child(move_up)
                            .child(move_down),
                    )
                    .child(
                        div()
                            .min_w(px(0.0))
                            .flex_1()
                            .truncate()
                            .text_size(px(13.5))
                            .child(queued_turn.text),
                    )
                    .when_some(steer, |row, steer| row.child(steer))
                    .child(edit)
                    .child(delete)
                    .with_animation(
                        row_animation_id,
                        Animation::new(theme.motion_duration(Duration::from_millis(240)))
                            .with_easing(crate::theme::web_ease_out),
                        |row, delta| row.top(px(4.0 * (1.0 - delta))).opacity(delta),
                    )
                    .into_any_element()
            })
            .collect::<Vec<_>>();

        Some(
            div()
                .id("composer-queue-scroll")
                .absolute()
                .left(px(28.0))
                .right(px(28.0))
                .bottom(relative(1.0))
                .mb(px(-9.0))
                .min_w(px(0.0))
                .max_h(maximum_height)
                .overflow_y_scroll()
                .pt(px(5.0))
                .px(px(9.0))
                .pb(px(14.0))
                .rounded_t(px(20.0))
                .border_t_1()
                .border_l_1()
                .border_r_1()
                .border_color(theme.queue_line.hsla())
                .bg(theme.queue_background.hsla())
                .children(rows)
                .with_animation(
                    "composer-queue-panel",
                    Animation::new(theme.motion.fast).with_easing(crate::theme::web_ease_out),
                    |panel, delta| panel.opacity(delta),
                )
                .into_any_element(),
        )
    }

    fn composer_primary_action(
        &self,
        show_stop: bool,
        send_disabled: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let stopping = show_stop && self.interrupt_pending;
        let disabled = !show_stop && send_disabled;
        let sending = !show_stop && self.sending;
        let action_group: SharedString = "composer-primary-action-hover".into();
        let composer_orb = theme.composer_orb.hsla();
        let composer_stop = theme.composer_stop.hsla();
        let stopping_background: gpui::Hsla = if theme.mode == ThemeMode::Dark {
            theme.composer_stop.hsla()
        } else {
            gpui::rgb(0x7a7a7d).into()
        };
        let background = if sending {
            composer_orb
        } else if disabled {
            theme.surface_3.hsla()
        } else if stopping {
            stopping_background
        } else if show_stop {
            composer_stop
        } else {
            composer_orb.opacity(0.90)
        };
        let foreground = if sending {
            theme.composer_on_orb.hsla()
        } else if disabled {
            theme.text_3.hsla()
        } else {
            theme.composer_on_orb.hsla()
        };
        let hover_background: gpui::Hsla = if show_stop {
            if theme.mode == ThemeMode::Dark {
                gpui::rgb(0x4e4e4e).into()
            } else {
                gpui::rgb(0x1f1f21).into()
            }
        } else {
            composer_orb
        };
        let shadows = if disabled || show_stop {
            Vec::new()
        } else {
            vec![BoxShadow {
                color: composer_orb.opacity(0.24),
                offset: point(px(0.0), px(1.0)),
                blur_radius: px(2.0),
                spread_radius: px(0.0),
            }]
        };

        div()
            .relative()
            .ml(px(2.0))
            .size(px(30.0))
            .rounded_full()
            .when(show_stop, |beam| {
                beam.child(composer_beam(
                    "composer-send-beam",
                    15.0,
                    theme,
                    0.72,
                    SEND_BEAM_DURATION,
                    ComposerBeamVariant::Ocean,
                ))
            })
            .child(
                div()
                    .id("composer-primary-action")
                    .group(action_group.clone())
                    .absolute()
                    .inset_0()
                    .rounded_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .overflow_hidden()
                    .bg(background)
                    .shadow(shadows)
                    .text_color(foreground)
                    .when(!disabled && !stopping, |button| {
                        button
                            .cursor_pointer()
                            .hover(move |style| style.inset(px(-0.75)).bg(hover_background))
                            .active(move |style| {
                                if show_stop {
                                    style.inset(px(1.2))
                                } else {
                                    style
                                }
                            })
                            .on_click(cx.listener(|this, _event, _window, cx| {
                                this.primary_action(cx);
                            }))
                    })
                    .when(!show_stop, |button| {
                        button.child(
                            div()
                                .id("composer-primary-active-shade")
                                .absolute()
                                .top_0()
                                .left_0()
                                .right_0()
                                .h(px(1.0))
                                .bg(gpui::black().opacity(0.08))
                                .opacity(0.0)
                                .group_active(action_group.clone(), |style| style.opacity(1.0)),
                        )
                    })
                    .child(composer_primary_icon(
                        show_stop,
                        stopping,
                        self.sending,
                        self.send_motion_generation,
                        !disabled && !stopping,
                        action_group,
                        theme,
                    )),
            )
            .into_any_element()
    }

    fn composer(&self, window: &Window, cx: &mut Context<Self>) -> gpui::Div {
        let theme = self.theme;
        let session = self.session.clone();
        let composer_empty = self.composer.read(cx).value().is_empty();
        let has_text = !self.composer.read(cx).value().trim().is_empty();
        let has_draft = has_text || !self.attachments.is_empty();
        let show_stop = self.state.running && !has_draft;
        let send_disabled = !has_text
            || self
                .attachments
                .iter()
                .any(|attachment| attachment.path.is_none());
        let running = self.state.running;
        let is_new_session = is_centered_new_session(session.as_ref(), self.creating);
        let composer_focused = self.composer.read(cx).focus_handle(cx).is_focused(window);
        let prompt_shadow = if theme.mode == ThemeMode::Dark {
            BoxShadow {
                color: gpui::black().opacity(0.70),
                offset: point(px(0.0), px(14.0)),
                blur_radius: px(34.0),
                spread_radius: px(-26.0),
            }
        } else {
            BoxShadow {
                color: gpui::rgba(0x18181b2e).into(),
                offset: point(px(0.0), px(12.0)),
                blur_radius: px(30.0),
                spread_radius: px(-18.0),
            }
        };
        let popover = self.composer_popover(window, cx);
        let user_input = self.user_input_card(window, cx);
        let queue_panel = self.queue_panel(window, cx);
        let attach_view = cx.weak_entity();
        let attach_action: UiAction = Rc::new(move |cx| {
            let _ = attach_view.update(cx, |_this, cx| cx.emit(ChatEvent::PickAttachments));
        });
        let design_view = cx.weak_entity();
        let design_action: UiAction = Rc::new(move |cx| {
            let _ = design_view.update(cx, |_this, cx| cx.emit(ChatEvent::ToggleDesign));
        });
        let box_bounds_view = cx.entity();
        let box_bounds_probe = canvas(
            move |bounds, _, cx| {
                box_bounds_view.update(cx, |this, _| {
                    this.composer_box_bounds = Some(bounds);
                });
            },
            |_, _, _, _| {},
        )
        .absolute()
        .inset_0();
        let field_bounds_view = cx.entity();
        let field_bounds_probe = canvas(
            move |bounds, _, cx| {
                field_bounds_view.update(cx, |this, _| {
                    this.composer_field_bounds = Some(bounds);
                });
            },
            |_, _, _, _| {},
        )
        .absolute()
        .inset_0();
        div()
            .flex_none()
            .px(px(24.0))
            .pt(px(4.0))
            .pb(px(if is_new_session { 8.0 } else { 12.0 }))
            .child(
                div()
                    .relative()
                    .w_full()
                    .max_w(px(CHAT_WIDTH))
                    .mx_auto()
                    .when_some(user_input, |composer, user_input| {
                        composer.child(user_input)
                    })
                    .when_some(popover, |composer, popover| {
                        composer.child(deferred(popover).with_priority(80))
                    })
                    .when_some(queue_panel, |composer, queue| composer.child(queue))
                    .child(
                        div()
                            .relative()
                            .rounded(px(crate::RADIUS_2XL))
                            .child(box_bounds_probe)
                            .when(self.composer_settings.design_mode, |box_| {
                                box_.child(composer_beam(
                                    "composer-design-beam",
                                    crate::RADIUS_2XL,
                                    theme,
                                    0.74,
                                    DESIGN_BEAM_DURATION,
                                    ComposerBeamVariant::Colorful,
                                ))
                            })
                            .child(
                                div()
                                    .relative()
                                    .rounded(px(crate::RADIUS_2XL))
                                    .border_1()
                                    .border_color(if composer_focused {
                                        theme.line_strong.hsla()
                                    } else {
                                        theme.line.hsla()
                                    })
                                    .bg(theme.prompt.hsla())
                                    .can_drop(|value, _window, _cx| value.is::<ExternalPaths>())
                                    .drag_over::<ExternalPaths>(
                                        move |style, _paths, _window, _cx| {
                                            style
                                                .border_color(theme.text_2.hsla())
                                                .bg(theme.surface_2.hsla())
                                        },
                                    )
                                    .on_drop(cx.listener(
                                        |this, paths: &ExternalPaths, _window, cx| {
                                            this.add_attachments(
                                                attachment_paths(paths.paths()),
                                                cx,
                                            );
                                        },
                                    ))
                                    .shadow(vec![prompt_shadow])
                                    .overflow_hidden()
                                    .when(is_new_session, |prompt| {
                                        prompt.child(
                                            div()
                                                .relative()
                                                .min_w(px(0.0))
                                                .min_h(px(36.0))
                                                .flex()
                                                .items_center()
                                                .gap(px(6.0))
                                                .px(px(12.0))
                                                .py(px(2.0))
                                                .rounded_t(px(crate::RADIUS_2XL))
                                                .bg(theme.shelf.hsla())
                                                .text_size(px(13.5))
                                                .line_height(relative(1.55))
                                                .text_color(theme.text_2.hsla())
                                                .child(
                                                    div()
                                                        .absolute()
                                                        .left_0()
                                                        .right_0()
                                                        .bottom(px(-18.0))
                                                        .h(px(20.0))
                                                        .bg(theme.shelf.hsla()),
                                                )
                                                .child(
                                                    div()
                                                        .absolute()
                                                        .top_0()
                                                        .left_0()
                                                        .right_0()
                                                        .h(px(1.0))
                                                        .bg(gpui::white().opacity(0.07)),
                                                )
                                                .child(
                                                    div()
                                                        .absolute()
                                                        .bottom_0()
                                                        .left_0()
                                                        .right_0()
                                                        .h(px(1.0))
                                                        .bg(gpui::black().opacity(0.18)),
                                                )
                                                .child(self.project_shelf_trigger(cx))
                                                .child(
                                                    div()
                                                        .id("composer-isolation")
                                                        .group("composer-isolation-hover")
                                                        .flex_none()
                                                        .max_w(px(150.0))
                                                        .px(px(6.0))
                                                        .py(px(4.0))
                                                        .flex()
                                                        .items_center()
                                                        .gap(px(7.0))
                                                        .cursor_pointer()
                                                        .hover(move |style| {
                                                            style
                                                                .bg(theme
                                                                    .surface_3
                                                                    .hsla()
                                                                    .opacity(0.88))
                                                                .text_color(theme.text.hsla())
                                                        })
                                                        .on_click(cx.listener(
                                                            |_this, _event, _window, cx| {
                                                                cx.emit(ChatEvent::ToggleIsolation);
                                                            },
                                                        ))
                                                        .child(motion_icon(
                                                            "composer-isolation-icon",
                                                            if self.composer_settings.isolate {
                                                                "icons/git-branch.svg"
                                                            } else {
                                                                "icons/laptop.svg"
                                                            },
                                                            15.0,
                                                            "composer-isolation-hover",
                                                            theme,
                                                        ))
                                                        .child(
                                                            div().min_w(px(0.0)).truncate().child(
                                                                if self.composer_settings.isolate {
                                                                    "Isolated"
                                                                } else {
                                                                    "Local"
                                                                },
                                                            ),
                                                        ),
                                                )
                                                .when(
                                                    !self.stage_settings.branches.is_empty(),
                                                    |shelf| {
                                                        shelf.child(self.branch_shelf_trigger(cx))
                                                    },
                                                ),
                                        )
                                    })
                                    .when_some(self.attachment_chips(cx), |prompt, chips| {
                                        prompt.child(chips)
                                    })
                                    .child(
                                        div().relative().w_full().child(field_bounds_probe).child(
                                            ComposerField {
                                                input: self.composer.clone(),
                                                empty: composer_empty,
                                                interface_font: self.interface_font.clone(),
                                                theme,
                                            },
                                        ),
                                    )
                                    .child(
                                        div()
                                            .flex()
                                            .items_center()
                                            .gap(px(6.0))
                                            .px(px(8.0))
                                            .pt(px(4.0))
                                            .pb(px(8.0))
                                            .child(icon_tool_button(
                                                "composer-attach",
                                                "icons/plus.svg",
                                                None,
                                                false,
                                                theme,
                                                Some(attach_action),
                                            ))
                                            .child(self.permission_trigger(running, cx))
                                            .child(
                                                div()
                                                    .relative()
                                                    .rounded(px(crate::RADIUS_XL))
                                                    .when(
                                                        self.composer_settings.design_mode,
                                                        |beam| {
                                                            beam.child(composer_beam(
                                                                "composer-design-button-beam",
                                                                crate::RADIUS_XL,
                                                                theme,
                                                                0.82,
                                                                DESIGN_BEAM_DURATION,
                                                                ComposerBeamVariant::Colorful,
                                                            ))
                                                        },
                                                    )
                                                    .child(
                                                        self.design_tool_button(design_action, cx),
                                                    ),
                                            )
                                            .when(self.voice_phase == VoicePhase::Idle, |tools| {
                                                tools
                                                    .child(div().flex_1())
                                                    .when_some(
                                                        self.state.usage.as_ref().filter(|usage| {
                                                            usage
                                                                .context_window
                                                                .is_some_and(|window| window > 0.0)
                                                        }),
                                                        |tools, usage| {
                                                            tools.child(context_usage(usage, theme))
                                                        },
                                                    )
                                                    .when_some(
                                                        self.model_trigger(running, cx),
                                                        |tools, trigger| tools.child(trigger),
                                                    )
                                                    .when(
                                                        self.composer_settings.voice_available
                                                            && !running,
                                                        |tools| tools.child(self.voice_button(cx)),
                                                    )
                                                    .child(self.composer_primary_action(
                                                        show_stop,
                                                        send_disabled,
                                                        cx,
                                                    ))
                                            })
                                            .when(self.voice_phase != VoicePhase::Idle, |tools| {
                                                tools.child(self.voice_bar(running, cx))
                                            }),
                                    ),
                            ),
                    ),
            )
            .when_some(self.voice_error.clone(), |composer, error| {
                composer.child(
                    div()
                        .w_full()
                        .max_w(px(CHAT_WIDTH))
                        .mx_auto()
                        .mt(px(5.0))
                        .px(px(12.0))
                        .text_size(px(10.5))
                        .line_height(relative(1.4))
                        .text_color(theme.error.hsla())
                        .child(error),
                )
            })
    }

    fn docked_composer(&self, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let composer = self.composer(window, cx);
        let Some(motion) = self.composer_dock_motion else {
            return composer.into_any_element();
        };
        composer
            .with_animation(
                ("composer-dock", motion.generation),
                Animation::new(self.theme.motion_duration(COMPOSER_DOCK_DURATION))
                    .with_easing(composer_dock_easing),
                move |composer, delta| composer.relative().top(motion.offset_y * (1.0 - delta)),
            )
            .into_any_element()
    }

    fn prepare_composer_dock_motion(&mut self, window: &Window) {
        let Some(pending) = self.composer_dock_pending.take() else {
            return;
        };
        self.composer_dock_motion = None;
        if self.theme.reduced_motion {
            return;
        }
        let offset_y = composer_dock_offset(
            pending,
            window.viewport_size().height,
            crate::zoom::factor(),
            Instant::now(),
        );
        if f32::from(offset_y).abs() < f32::from(px(0.5)) {
            return;
        }
        self.composer_dock_generation = self.composer_dock_generation.wrapping_add(1);
        self.composer_dock_motion = Some(ComposerDockMotion {
            offset_y,
            generation: self.composer_dock_generation,
        });
    }

    fn design_tool_button(&self, action: UiAction, cx: &Context<Self>) -> AnyElement {
        let theme = self.theme;
        let active = self.composer_settings.design_mode;
        let group: SharedString = "composer-design-hover".into();
        let background = if theme.mode == ThemeMode::Dark {
            theme.surface_3.hsla()
        } else {
            theme.prompt.hsla()
        };
        let label = if self.design_hovered {
            if theme.reduced_motion {
                div().child(design_shimmer_label(0.0)).into_any_element()
            } else {
                div()
                    .with_animation(
                        "design-label-shimmer",
                        theme.repeating_animation(DESIGN_BEAM_DURATION),
                        |label, delta| label.child(design_shimmer_label(delta)),
                    )
                    .into_any_element()
            }
        } else {
            div().child("Design").into_any_element()
        };

        let sizing = div()
            .h(px(34.0))
            .px(px(12.0))
            .py(px(5.0))
            .flex()
            .items_center()
            .justify_center()
            .gap(px(6.0))
            .text_size(px(13.5))
            .invisible()
            .child(div().size(px(13.0)).flex_none())
            .child("Design");
        let visual = div()
            .id("composer-design-visual")
            .absolute()
            .inset_0()
            .flex()
            .items_center()
            .justify_center()
            .gap(px(6.0))
            .px(px(12.0))
            .py(px(5.0))
            .rounded(px(RADIUS_XL))
            .border_1()
            .border_color(if active {
                theme.text_3.hsla().opacity(0.8)
            } else {
                theme.line_strong.hsla()
            })
            .bg(background)
            .shadow_sm()
            .text_size(px(13.5))
            .text_color(if active {
                theme.text.hsla()
            } else {
                theme.text_2.hsla()
            })
            .group_hover(group.clone(), move |style| {
                style
                    .bg(if theme.mode == ThemeMode::Dark {
                        theme.surface_3.hsla()
                    } else {
                        theme.surface.hsla()
                    })
                    .border_color(theme.text_3.hsla().opacity(0.72))
                    .text_color(theme.text.hsla())
            })
            .group_active(group.clone(), |style| {
                style
                    .top(px(0.51))
                    .right(relative(0.015))
                    .bottom(px(0.51))
                    .left(relative(0.015))
                    .gap(px(5.82))
                    .px(px(11.64))
                    .py(px(4.85))
                    .rounded(px(RADIUS_XL * 0.97))
                    .text_size(px(13.095))
                    .shadow(Vec::new())
            })
            .child(
                div()
                    .id("composer-design-icon-press")
                    .size(px(13.0))
                    .group_active(group.clone(), |style| style.size(px(12.61)).m(px(0.195)))
                    .child(
                        motion_icon(
                            "composer-design-icon",
                            "icons/palette.svg",
                            13.0,
                            group.clone(),
                            theme,
                        )
                        .size_full(),
                    ),
            )
            .child(label);
        div()
            .id("composer-design")
            .group(group)
            .relative()
            .h(px(34.0))
            .flex_none()
            .cursor_pointer()
            .on_hover(cx.listener(|this, hovered: &bool, _window, cx| {
                if this.design_hovered != *hovered {
                    this.design_hovered = *hovered;
                    cx.notify();
                }
            }))
            .on_click(move |_event, _window, cx| action(cx))
            .child(sizing)
            .child(visual)
            .into_any_element()
    }

    fn voice_button(&self, cx: &Context<Self>) -> AnyElement {
        let theme = self.theme;
        let group: SharedString = "composer-voice-hover".into();
        div()
            .id("composer-voice")
            .group(group.clone())
            .size(px(30.0))
            .ml(px(2.0))
            .rounded(px(15.0))
            .border_1()
            .border_color(theme.line_strong.hsla())
            .bg(theme.surface.hsla())
            .flex()
            .items_center()
            .justify_center()
            .text_color(theme.text_2.hsla())
            .cursor_pointer()
            .hover(move |style| {
                style
                    .bg(theme.surface_2.hsla())
                    .text_color(theme.text.hsla())
            })
            .active(|style| style.size(px(29.1)).ml(px(2.45)).mr(px(0.45)).my(px(0.45)))
            .on_click(cx.listener(|this, _event, _window, cx| this.start_voice(cx)))
            .child(
                div()
                    .id("composer-voice-icon-press")
                    .size(px(15.0))
                    .group_active(group.clone(), |style| style.size(px(14.55)).m(px(0.225)))
                    .child(
                        motion_icon("composer-voice-icon", "icons/mic.svg", 15.0, group, theme)
                            .size_full(),
                    ),
            )
            .into_any_element()
    }

    fn voice_bar(&self, running: bool, cx: &Context<Self>) -> AnyElement {
        let theme = self.theme;
        let transcribing = self.voice_phase == VoicePhase::Transcribing;
        let duration = format_voice_duration(self.voice_recorder.elapsed());
        let stop_group: SharedString = "composer-voice-stop-hover".into();
        let stop_icon_size = if transcribing { 13.0 } else { 11.0 };
        let stop_icon = div()
            .id("composer-voice-stop-icon-press")
            .size(px(stop_icon_size))
            .group_active(stop_group.clone(), move |style| {
                style
                    .size(px(stop_icon_size * 0.94))
                    .m(px(stop_icon_size * 0.03))
            })
            .child(
                motion_icon(
                    "composer-voice-stop-icon",
                    if transcribing {
                        "icons/x.svg"
                    } else {
                        "icons/square.svg"
                    },
                    stop_icon_size,
                    stop_group.clone(),
                    theme,
                )
                .size_full(),
            );
        let stop = div()
            .id("composer-voice-stop")
            .group(stop_group)
            .size(px(28.0))
            .rounded(px(14.0))
            .flex()
            .items_center()
            .justify_center()
            .bg(theme.surface_2.hsla())
            .text_color(theme.text_2.hsla())
            .opacity(if running { 0.5 } else { 1.0 })
            .when(!running, |button| {
                button
                    .cursor_pointer()
                    .hover(move |style| {
                        style
                            .bg(theme.surface_3.hsla())
                            .text_color(theme.text.hsla())
                    })
                    .active(|style| style.size(px(26.32)).m(px(0.84)))
                    .on_click(cx.listener(move |this, _event, _window, cx| {
                        if transcribing {
                            this.cancel_voice(cx);
                        } else {
                            this.stop_voice(false, cx);
                        }
                    }))
            })
            .child(stop_icon);
        let submit_group: SharedString = "composer-voice-submit-hover".into();
        let submit_icon_size = if transcribing { 12.0 } else { 13.0 };
        let submit_icon = motion_icon(
            "composer-voice-submit-icon",
            if transcribing {
                "icons/loader-circle.svg"
            } else {
                "icons/arrow-up.svg"
            },
            submit_icon_size,
            submit_group.clone(),
            theme,
        )
        .size_full();
        let submit_icon = if transcribing && !theme.reduced_motion {
            submit_icon
                .with_animation(
                    "composer-voice-submit-spinner",
                    theme.repeating_animation(Duration::from_millis(700)),
                    |icon, delta| {
                        icon.with_transformation(IconTransformation::rotate(delta * 360.0))
                    },
                )
                .into_any_element()
        } else {
            submit_icon.into_any_element()
        };
        let submit_icon = div()
            .id("composer-voice-submit-icon-press")
            .size(px(submit_icon_size))
            .group_hover(submit_group.clone(), move |style| {
                style
                    .size(px(submit_icon_size * 1.05))
                    .m(px(submit_icon_size * -0.025))
            })
            .group_active(submit_group.clone(), move |style| {
                style
                    .size(px(submit_icon_size * 0.94))
                    .m(px(submit_icon_size * 0.03))
            })
            .child(submit_icon);
        let submit = div()
            .id("composer-voice-submit")
            .group(submit_group)
            .size(px(28.0))
            .rounded(px(14.0))
            .flex()
            .items_center()
            .justify_center()
            .bg(theme.text.hsla())
            .text_color(theme.background.hsla())
            .text_size(px(13.0))
            .font_weight(FontWeight::SEMIBOLD)
            .opacity(if running || transcribing { 0.5 } else { 1.0 })
            .when(!running && !transcribing, |button| {
                button
                    .cursor_pointer()
                    .hover(|style| style.size(px(29.4)).m(px(-0.7)))
                    .active(|style| style.size(px(26.32)).m(px(0.84)))
                    .on_click(cx.listener(|this, _event, _window, cx| {
                        this.stop_voice(true, cx);
                    }))
            })
            .child(submit_icon);
        div()
            .min_w(px(0.0))
            .flex_1()
            .flex()
            .items_center()
            .gap(px(10.0))
            .child(self.voice_waveform(transcribing))
            .child(
                div()
                    .flex_none()
                    .text_size(px(11.5))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.text_3.hsla())
                    .child(tracked_text(duration, 0.02)),
            )
            .child(stop)
            .child(submit)
            .into_any_element()
    }

    fn voice_waveform(&self, transcribing: bool) -> AnyElement {
        let theme = self.theme;
        let levels = self.voice_levels.clone();
        div()
            .relative()
            .h(px(28.0))
            .min_w(px(0.0))
            .flex_1()
            .overflow_hidden()
            .opacity(if transcribing { 0.5 } else { 1.0 })
            .child(
                canvas(
                    |_, _, _| {},
                    move |bounds, _, window, _| {
                        paint_voice_dither(bounds, &levels, theme, window);
                    },
                )
                .absolute()
                .inset_0(),
            )
            .into_any_element()
    }

    fn attachment_shelf_height(&self) -> f32 {
        if self.attachments.is_empty() && self.attachment_error.is_none() {
            0.0
        } else if self
            .attachments
            .iter()
            .any(|attachment| attachment.preview.is_some())
        {
            81.0
        } else {
            34.0
        }
    }

    fn attach_pasted_image(&mut self, cx: &mut Context<Self>) -> bool {
        let Some(image) = cx
            .read_from_clipboard()
            .into_iter()
            .flat_map(|clipboard| clipboard.into_entries())
            .find_map(|entry| match entry {
                ClipboardEntry::Image(image) => Some(Arc::new(image)),
                ClipboardEntry::String(_) => None,
            })
        else {
            return false;
        };
        let Some(extension) = pasted_image_extension(&image) else {
            self.attachment_error = Some("Couldn’t attach that image.".into());
            cx.notify();
            return true;
        };
        if image.bytes().is_empty() || image.bytes().len() > MAX_PASTED_IMAGE_BYTES {
            self.attachment_error = Some("Couldn’t attach that image.".into());
            cx.notify();
            return true;
        }

        let id = uuid::Uuid::new_v4().to_string();
        self.attachments.push(ComposerAttachment {
            id: id.clone(),
            name: format!("Pasted image.{extension}"),
            path: None,
            preview: Some(image.clone()),
        });
        self.attachment_error = None;
        let save = cx.background_spawn(async move { materialize_pasted_image(&image) });
        cx.spawn(async move |view, cx| {
            let result = save.await;
            let _ = view.update(cx, |this, cx| {
                let Some(index) = this
                    .attachments
                    .iter()
                    .position(|attachment| attachment.id == id)
                else {
                    return;
                };
                match result {
                    Ok(path) => {
                        this.attachments[index].path = Some(path.to_string_lossy().into_owned());
                    }
                    Err(_) => {
                        this.attachments.remove(index);
                        this.attachment_error = Some("Couldn’t attach that image.".into());
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
        true
    }

    fn attachment_chips(&self, cx: &Context<Self>) -> Option<AnyElement> {
        if self.attachments.is_empty() && self.attachment_error.is_none() {
            return None;
        }
        let theme = self.theme;
        let attachments = self
            .attachments
            .iter()
            .enumerate()
            .filter(|(_, attachment)| attachment.preview.is_some())
            .chain(
                self.attachments
                    .iter()
                    .enumerate()
                    .filter(|(_, attachment)| attachment.preview.is_none()),
            );
        Some(
            div()
                .min_h(px(self.attachment_shelf_height()))
                .w_full()
                .flex()
                .flex_wrap()
                .items_start()
                .gap(px(5.0))
                .px(px(10.0))
                .pt(px(9.0))
                .children(attachments.map(|(index, attachment)| {
                    if let Some(preview) = attachment.preview.clone() {
                        let image = preview.clone();
                        let path = attachment.path.clone();
                        let name = attachment.name.clone();
                        let loading = path.is_none();
                        let remove_group: SharedString =
                            format!("attachment-preview-remove-{index}").into();
                        div()
                            .id(("attachment-preview", index))
                            .relative()
                            .size(px(72.0))
                            .flex_none()
                            .rounded(px(12.0))
                            .border_1()
                            .border_color(theme.line_strong.hsla())
                            .overflow_hidden()
                            .cursor_pointer()
                            .on_click(cx.listener(move |_this, _event, _window, cx| {
                                cx.emit(ChatEvent::OpenImage {
                                    image: image.clone(),
                                    path: path.clone(),
                                    name: name.clone(),
                                });
                            }))
                            .child(
                                img(preview)
                                    .size_full()
                                    .object_fit(ObjectFit::Cover)
                                    .opacity(if loading { 0.68 } else { 1.0 }),
                            )
                            .child(
                                div()
                                    .id(("attachment-preview-remove", index))
                                    .group(remove_group.clone())
                                    .absolute()
                                    .top(px(4.0))
                                    .right(px(4.0))
                                    .size(px(22.0))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .rounded_full()
                                    .border_1()
                                    .border_color(gpui::white().opacity(0.12))
                                    .bg(gpui::rgba(0x121212eb))
                                    .text_color(gpui::white())
                                    .cursor_pointer()
                                    .hover(|style| style.bg(gpui::rgb(0x222222)))
                                    .active(|style| style.size(px(20.24)).m(px(0.88)))
                                    .on_click(cx.listener(move |this, _event, _window, cx| {
                                        cx.stop_propagation();
                                        if index < this.attachments.len() {
                                            this.attachments.remove(index);
                                            cx.notify();
                                        }
                                    }))
                                    .child(
                                        div()
                                            .id(("attachment-preview-remove-icon-press", index))
                                            .size(px(13.0))
                                            .group_active(remove_group.clone(), |style| {
                                                style.size(px(11.96)).m(px(0.52))
                                            })
                                            .child(
                                                motion_icon(
                                                    ("attachment-preview-remove-icon", index),
                                                    "icons/x.svg",
                                                    13.0,
                                                    remove_group,
                                                    theme,
                                                )
                                                .size_full(),
                                            ),
                                    ),
                            )
                            .when(loading, |preview| {
                                preview.child(
                                    svg()
                                        .path("icons/attachment-loader.svg")
                                        .absolute()
                                        .right(px(8.0))
                                        .bottom(px(8.0))
                                        .size(px(12.0))
                                        .text_color(gpui::white())
                                        .with_animation(
                                            ("pasted-image-loading", index),
                                            theme.repeating_animation(Duration::from_millis(700)),
                                            |spinner, delta| {
                                                spinner.with_transformation(
                                                    gpui::Transformation::rotate(gpui::percentage(
                                                        delta,
                                                    )),
                                                )
                                            },
                                        ),
                                )
                            })
                            .with_animation(
                                ("attachment-preview-in", index),
                                Animation::new(theme.motion.fast)
                                    .with_easing(crate::theme::web_ease_out),
                                |preview, delta| {
                                    let scale = 0.98 + 0.02 * delta;
                                    let size = 72.0 * scale;
                                    preview
                                        .size(px(size))
                                        .m(px((72.0 - size) / 2.0))
                                        .top(px(2.0 * (1.0 - delta)))
                                        .opacity(delta)
                                },
                            )
                            .into_any_element()
                    } else {
                        let path = attachment.path.as_deref().unwrap_or_default();
                        let name = attachment.name.clone();
                        let remove_group: SharedString =
                            format!("attachment-remove-{index}").into();
                        let file_icon_group: SharedString =
                            format!("attachment-file-icon-{index}").into();
                        let chip = div()
                            .id(("attachment-chip", index))
                            .absolute()
                            .left(px(0.0))
                            .right(px(0.0))
                            .top(px(0.0))
                            .h(px(25.0))
                            .flex()
                            .items_center()
                            .gap(px(6.0))
                            .pl(px(7.0))
                            .pr(px(3.0))
                            .rounded(px(8.0))
                            .bg(theme.surface_2.hsla())
                            .text_size(px(12.5))
                            .text_color(theme.text_2.hsla())
                            .child(
                                div()
                                    .size(px(13.0))
                                    .flex_none()
                                    .child(
                                        motion_icon(
                                            ("attachment-file-icon", index),
                                            if is_image_path(path) {
                                                "icons/image.svg"
                                            } else {
                                                "icons/file.svg"
                                            },
                                            13.0,
                                            file_icon_group,
                                            theme,
                                        )
                                        .size_full(),
                                    )
                                    .with_animation(
                                        ("attachment-file-icon-in", index),
                                        Animation::new(theme.motion.fast)
                                            .with_easing(crate::theme::web_ease_out),
                                        |icon, delta| {
                                            let scale = 0.98 + 0.02 * delta;
                                            icon.size(px(13.0 * scale))
                                        },
                                    ),
                            )
                            .child(div().min_w(px(0.0)).flex_1().truncate().child(name.clone()))
                            .child(
                                div()
                                    .id(("attachment-remove", index))
                                    .group(remove_group.clone())
                                    .size(px(17.0))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .rounded(px(5.0))
                                    .cursor_pointer()
                                    .hover(move |style| {
                                        style
                                            .bg(theme.surface_3.hsla())
                                            .text_color(theme.text.hsla())
                                    })
                                    .on_click(cx.listener(move |this, _event, _window, cx| {
                                        if index < this.attachments.len() {
                                            this.attachments.remove(index);
                                            cx.notify();
                                        }
                                    }))
                                    .child(
                                        div()
                                            .size(px(10.0))
                                            .child(
                                                motion_icon(
                                                    ("attachment-remove-icon", index),
                                                    "icons/x.svg",
                                                    10.0,
                                                    remove_group,
                                                    theme,
                                                )
                                                .size_full(),
                                            )
                                            .with_animation(
                                                ("attachment-remove-icon-in", index),
                                                Animation::new(theme.motion.fast)
                                                    .with_easing(crate::theme::web_ease_out),
                                                |icon, delta| {
                                                    let scale = 0.98 + 0.02 * delta;
                                                    icon.size(px(10.0 * scale))
                                                },
                                            ),
                                    )
                                    .with_animation(
                                        ("attachment-remove-in", index),
                                        Animation::new(theme.motion.fast)
                                            .with_easing(crate::theme::web_ease_out),
                                        |remove, delta| {
                                            let scale = 0.98 + 0.02 * delta;
                                            remove.size(px(17.0 * scale)).rounded(px(5.0 * scale))
                                        },
                                    ),
                            )
                            .with_animation(
                                ("attachment-chip-in", index),
                                Animation::new(theme.motion.fast)
                                    .with_easing(crate::theme::web_ease_out),
                                |chip, delta| {
                                    let scale = 0.98 + 0.02 * delta;
                                    let inset = (1.0 - scale) / 2.0;
                                    chip.left(relative(inset))
                                        .right(relative(inset))
                                        .top(px((25.0 - 25.0 * scale) / 2.0 + 2.0 * (1.0 - delta)))
                                        .h(px(25.0 * scale))
                                        .gap(px(6.0 * scale))
                                        .pl(px(7.0 * scale))
                                        .pr(px(3.0 * scale))
                                        .rounded(px(8.0 * scale))
                                        .text_size(px(12.5 * scale))
                                        .opacity(delta)
                                },
                            );
                        div()
                            .relative()
                            .h(px(25.0))
                            .max_w(px(220.0))
                            .flex_none()
                            .child(
                                div()
                                    .h(px(25.0))
                                    .max_w(px(220.0))
                                    .flex()
                                    .items_center()
                                    .gap(px(6.0))
                                    .pl(px(7.0))
                                    .pr(px(3.0))
                                    .text_size(px(12.5))
                                    .invisible()
                                    .child(div().size(px(13.0)).flex_none())
                                    .child(div().min_w(px(0.0)).flex_1().truncate().child(name))
                                    .child(div().size(px(17.0)).flex_none()),
                            )
                            .child(chip)
                            .into_any_element()
                    }
                }))
                .when_some(self.attachment_error.clone(), |chips, error| {
                    chips.child(
                        div()
                            .h(px(25.0))
                            .flex()
                            .items_center()
                            .px(px(8.0))
                            .rounded(px(8.0))
                            .bg(theme.surface_2.hsla())
                            .text_size(px(12.5))
                            .text_color(theme.error.hsla())
                            .child(error),
                    )
                })
                .into_any_element(),
        )
    }

    fn project_shelf_trigger(&self, cx: &Context<Self>) -> AnyElement {
        let theme = self.theme;
        let open = self.composer_menu == Some(ComposerMenu::Project);
        let label = self.session.as_ref().map_or_else(
            || SharedString::from("Choose project"),
            |session| session.project_name.clone().into(),
        );
        let bounds_view = cx.entity();
        let bounds_probe = canvas(
            move |bounds, _, cx| {
                bounds_view.update(cx, |this, _| {
                    this.project_trigger_bounds = Some(bounds);
                });
            },
            |_, _, _, _| {},
        )
        .absolute()
        .inset_0();
        div()
            .id("composer-project")
            .group("composer-project-hover")
            .relative()
            .flex_none()
            .max_w(px(260.0))
            .flex()
            .items_center()
            .gap(px(7.0))
            .px(px(8.0))
            .py(px(5.0))
            .rounded(px(crate::RADIUS_MD))
            .text_color(if open {
                theme.text.hsla()
            } else {
                theme.text_2.hsla()
            })
            .cursor_pointer()
            .hover(move |style| {
                style
                    .bg(theme.surface_3.hsla().opacity(0.88))
                    .text_color(theme.text.hsla())
            })
            .on_click(cx.listener(|this, _event, _window, cx| {
                this.toggle_composer_menu(ComposerMenu::Project, cx);
            }))
            .child(bounds_probe)
            .child(motion_icon(
                "composer-project-icon",
                "icons/folder.svg",
                15.0,
                "composer-project-hover",
                theme,
            ))
            .child(div().min_w(px(0.0)).truncate().child(label))
            .into_any_element()
    }

    fn branch_shelf_trigger(&self, cx: &Context<Self>) -> AnyElement {
        let theme = self.theme;
        let open = self.composer_menu == Some(ComposerMenu::Branch);
        let label = self
            .stage_settings
            .workspace_branch
            .clone()
            .or_else(|| self.stage_settings.branches.first().cloned())
            .unwrap_or_else(|| "No branch".into());
        let bounds_view = cx.entity();
        let bounds_probe = canvas(
            move |bounds, _, cx| {
                bounds_view.update(cx, |this, _| {
                    this.branch_trigger_bounds = Some(bounds);
                });
            },
            |_, _, _, _| {},
        )
        .absolute()
        .inset_0();
        div()
            .id("composer-branch")
            .group("composer-branch-hover")
            .relative()
            .flex_none()
            .max_w(px(220.0))
            .flex()
            .items_center()
            .gap(px(7.0))
            .px(px(8.0))
            .py(px(5.0))
            .rounded(px(crate::RADIUS_MD))
            .text_color(if open {
                theme.text.hsla()
            } else {
                theme.text_2.hsla()
            })
            .opacity(if self.stage_settings.branch_switching {
                0.48
            } else {
                1.0
            })
            .when(!self.stage_settings.branch_switching, |trigger| {
                trigger
                    .cursor_pointer()
                    .hover(move |style| {
                        style
                            .bg(theme.surface_3.hsla().opacity(0.88))
                            .text_color(theme.text.hsla())
                    })
                    .on_click(cx.listener(|this, _event, _window, cx| {
                        this.toggle_composer_menu(ComposerMenu::Branch, cx);
                    }))
            })
            .child(bounds_probe)
            .child(motion_icon(
                "composer-branch-icon",
                "icons/git-branch.svg",
                15.0,
                "composer-branch-hover",
                theme,
            ))
            .child(div().min_w(px(0.0)).truncate().child(label))
            .into_any_element()
    }

    fn permission_trigger(&self, running: bool, cx: &Context<Self>) -> AnyElement {
        let theme = self.theme;
        let approval = self.composer_settings.approval;
        let open = self.composer_menu == Some(ComposerMenu::Permissions);
        let (icon_path, label) = approval_meta(approval);
        let semantic_color = approval_semantic_color(approval, theme);
        let label_color = semantic_color.unwrap_or_else(|| theme.text_2.hsla());
        let icon_color = semantic_color.unwrap_or_else(|| theme.text_3.hsla());
        let group: SharedString = "composer-permission-trigger".into();
        let background = if theme.mode == ThemeMode::Dark {
            theme.surface_3.hsla()
        } else {
            theme.prompt.hsla()
        };
        let bounds_view = cx.entity();
        let bounds_probe = canvas(
            move |bounds, _, cx| {
                bounds_view.update(cx, |this, _| {
                    this.permission_trigger_bounds = Some(bounds);
                });
            },
            |_, _, _, _| {},
        )
        .absolute()
        .inset_0();
        let sizing = div()
            .h(px(34.0))
            .px(px(12.0))
            .py(px(5.0))
            .flex()
            .items_center()
            .gap(px(6.0))
            .text_size(px(13.5))
            .invisible()
            .child(div().size(px(13.0)).flex_none())
            .child(label);
        let visual = div()
            .id("composer-permissions-visual")
            .absolute()
            .inset_0()
            .px(px(12.0))
            .py(px(5.0))
            .flex()
            .items_center()
            .gap(px(6.0))
            .rounded(px(RADIUS_XL))
            .border_1()
            .border_color(if open {
                theme.text_3.hsla()
            } else {
                theme.line_strong.hsla()
            })
            .bg(background)
            .shadow_sm()
            .text_size(px(13.5))
            .text_color(label_color)
            .when(!running, |visual| {
                visual
                    .group_hover(group.clone(), move |style| {
                        style
                            .bg(if theme.mode == ThemeMode::Dark {
                                theme.surface_3.hsla()
                            } else {
                                theme.surface.hsla()
                            })
                            .border_color(theme.text_3.hsla().opacity(0.72))
                            .text_color(semantic_color.unwrap_or_else(|| theme.text.hsla()))
                    })
                    .group_active(group.clone(), |style| {
                        style
                            .top(px(0.51))
                            .right(relative(0.015))
                            .bottom(px(0.51))
                            .left(relative(0.015))
                            .gap(px(5.82))
                            .px(px(11.64))
                            .py(px(4.85))
                            .rounded(px(RADIUS_XL * 0.97))
                            .text_size(px(13.095))
                            .shadow(Vec::new())
                    })
            })
            .child(
                div()
                    .id("composer-permissions-icon-press")
                    .size(px(13.0))
                    .flex_none()
                    .text_color(icon_color)
                    .when(semantic_color.is_none(), |icon| {
                        icon.group_hover(group.clone(), |style| style.text_color(theme.text.hsla()))
                    })
                    .when(!running, |icon| {
                        icon.group_active(group.clone(), |style| style.size(px(12.61)).m(px(0.195)))
                    })
                    .child(
                        motion_icon(
                            "composer-permissions-icon",
                            icon_path,
                            13.0,
                            group.clone(),
                            theme,
                        )
                        .size_full(),
                    ),
            )
            .child(label);
        div()
            .id("composer-permissions")
            .group(group)
            .relative()
            .h(px(34.0))
            .flex_none()
            .opacity(if running { 0.42 } else { 1.0 })
            .when(!running, |button| {
                button
                    .cursor_pointer()
                    .on_click(cx.listener(|this, _event, _window, cx| {
                        this.toggle_composer_menu(ComposerMenu::Permissions, cx);
                    }))
            })
            .child(bounds_probe)
            .child(sizing)
            .child(visual)
            .into_any_element()
    }

    fn model_trigger(&self, running: bool, cx: &Context<Self>) -> Option<AnyElement> {
        let selected = self.selected_model()?.clone();
        let theme = self.theme;
        let open = self.composer_menu == Some(ComposerMenu::Model);
        let effort = friendly_effort_label(selected_reasoning_effort(
            &selected.model,
            self.composer_settings.effort.as_deref(),
        ));
        let model_name = compact_model_name(&selected.model.display_name);
        let fast = is_fast_mode_enabled(
            &selected.model,
            self.composer_settings.service_tier.as_deref(),
        );
        let background = if theme.mode == ThemeMode::Dark {
            theme.surface_3.hsla()
        } else {
            theme.prompt.hsla()
        };
        let group: SharedString = "composer-model-hover".into();
        let provider_icon = provider_mark_path(provider_mark(selected.provider));
        let bounds_view = cx.entity();
        let bounds_probe = canvas(
            move |bounds, _, cx| {
                bounds_view.update(cx, |this, _| {
                    this.model_trigger_bounds = Some(bounds);
                });
            },
            |_, _, _, _| {},
        )
        .absolute()
        .inset_0();
        let chevron = motion_icon(
            "composer-model-chevron-icon",
            "icons/chevron-down.svg",
            16.0,
            group.clone(),
            theme,
        )
        .size_full()
        .with_animation(
            ("composer-model-chevron", usize::from(open)),
            Animation::new(theme.motion.fast).with_easing(crate::theme::web_ease_out),
            move |icon, delta| {
                let rotation_degrees = if open {
                    delta * 180.0
                } else {
                    (1.0 - delta) * 180.0
                };
                icon.with_transformation(IconTransformation::rotate(rotation_degrees))
            },
        );
        let sizing = div()
            .h(px(32.0))
            .max_w(px(270.0))
            .pl(px(8.0))
            .pr(px(9.0))
            .py(px(5.0))
            .flex()
            .items_center()
            .gap(px(7.0))
            .text_size(px(12.5))
            .invisible()
            .when(fast, |button| {
                button.child(div().size(px(13.0)).flex_none())
            })
            .child(
                div()
                    .min_w(px(0.0))
                    .flex()
                    .items_center()
                    .gap(px(5.0))
                    .child(
                        div()
                            .min_w(px(0.0))
                            .max_w(px(165.0))
                            .flex()
                            .items_center()
                            .gap(px(6.0))
                            .truncate()
                            .child(div().size(px(13.0)).flex_none())
                            .child(model_name.clone()),
                    )
                    .child(div().min_w(px(0.0)).truncate().child(effort.clone())),
            )
            .child(div().size(px(16.0)).flex_none());
        let visual = div()
            .id("composer-model-visual")
            .absolute()
            .inset_0()
            .pl(px(8.0))
            .pr(px(9.0))
            .py(px(5.0))
            .flex()
            .items_center()
            .gap(px(7.0))
            .rounded(px(RADIUS_XL))
            .border_1()
            .border_color(if open {
                theme.text_3.hsla()
            } else {
                theme.line_strong.hsla()
            })
            .bg(background)
            .shadow_sm()
            .text_size(px(12.5))
            .text_color(theme.text.hsla())
            .when(!running, |visual| {
                visual
                    .group_hover(group.clone(), move |style| {
                        style
                            .bg(if theme.mode == ThemeMode::Dark {
                                theme.surface_3.hsla()
                            } else {
                                theme.surface.hsla()
                            })
                            .border_color(theme.text_3.hsla().opacity(0.72))
                    })
                    .group_active(group.clone(), |style| {
                        style
                            .top(px(0.48))
                            .right(relative(0.015))
                            .bottom(px(0.48))
                            .left(relative(0.015))
                            .pl(px(7.76))
                            .pr(px(8.73))
                            .py(px(4.85))
                            .gap(px(6.79))
                            .rounded(px(RADIUS_XL * 0.97))
                            .text_size(px(12.125))
                            .shadow(Vec::new())
                    })
            })
            .when(fast, |button| {
                button.child(
                    div()
                        .id("composer-model-fast-icon-press")
                        .size(px(13.0))
                        .flex_none()
                        .text_color(theme.text.hsla())
                        .when(!running, |icon| {
                            icon.group_active(group.clone(), |style| {
                                style.size(px(12.61)).m(px(0.195))
                            })
                        })
                        .child(
                            motion_icon(
                                "composer-model-fast-icon",
                                "icons/zap-filled.svg",
                                13.0,
                                group.clone(),
                                theme,
                            )
                            .size_full(),
                        ),
                )
            })
            .child(
                div()
                    .id("composer-model-copy-press")
                    .min_w(px(0.0))
                    .flex()
                    .items_center()
                    .gap(px(5.0))
                    .when(!running, |copy| {
                        copy.group_active(group.clone(), |style| style.gap(px(4.85)))
                    })
                    .child(
                        div()
                            .id("composer-model-name-press")
                            .min_w(px(0.0))
                            .max_w(px(165.0))
                            .flex()
                            .items_center()
                            .gap(px(6.0))
                            .truncate()
                            .when(!running, |name| {
                                name.group_active(group.clone(), |style| {
                                    style.max_w(px(160.05)).gap(px(5.82))
                                })
                            })
                            .child(
                                div()
                                    .id("composer-model-provider-icon-press")
                                    .size(px(13.0))
                                    .flex_none()
                                    .when(!running, |icon| {
                                        icon.group_active(group.clone(), |style| {
                                            style.size(px(12.61)).m(px(0.195))
                                        })
                                    })
                                    .child(
                                        motion_icon(
                                            "composer-model-provider-icon",
                                            provider_icon,
                                            13.0,
                                            group.clone(),
                                            theme,
                                        )
                                        .size_full()
                                        .text_color(theme.text_2.hsla()),
                                    ),
                            )
                            .child(model_name),
                    )
                    .child(
                        div()
                            .min_w(px(0.0))
                            .truncate()
                            .text_color(theme.text_3.hsla())
                            .child(effort),
                    ),
            )
            .child(
                div()
                    .id("composer-model-chevron-press")
                    .size(px(16.0))
                    .flex_none()
                    .text_color(theme.text_3.hsla())
                    .when(!running, |icon| {
                        icon.group_active(group.clone(), |style| style.size(px(15.52)).m(px(0.24)))
                    })
                    .child(chevron),
            );
        Some(
            div()
                .id("composer-model")
                .group(group)
                .relative()
                .h(px(32.0))
                .max_w(px(270.0))
                .flex_none()
                .opacity(if running { 0.42 } else { 1.0 })
                .when(!running, |button| {
                    button
                        .cursor_pointer()
                        .on_click(cx.listener(|this, _event, _window, cx| {
                            this.toggle_composer_menu(ComposerMenu::Model, cx);
                        }))
                })
                .child(bounds_probe)
                .child(sizing)
                .child(visual)
                .into_any_element(),
        )
    }

    fn composer_popover(&self, window: &Window, cx: &Context<Self>) -> Option<AnyElement> {
        match self.composer_menu {
            Some(ComposerMenu::Permissions) => Some(self.permission_popover(window, cx)),
            Some(ComposerMenu::Model) => Some(self.model_popover(window, cx)),
            Some(ComposerMenu::Project) => Some(self.project_popover(window, cx)),
            Some(ComposerMenu::Branch) => Some(self.branch_popover(window, cx)),
            None => None,
        }
    }

    fn project_popover(&self, window: &Window, cx: &Context<Self>) -> AnyElement {
        let theme = self.theme;
        let active_path = self
            .session
            .as_ref()
            .map(|session| session.project_path.clone());
        let viewport = window.viewport_size();
        let panel_width = composer_menu_width(350.0, viewport.width);
        let panel_height = composer_stacked_menu_height(
            self.stage_settings.projects.len(),
            (13.5 + 11.5) * crate::theme::BASE_LINE_HEIGHT + 14.0,
            viewport.height,
        );
        let placement = composer_menu_placement(
            self.composer_box_bounds,
            self.project_trigger_bounds,
            viewport.width,
            viewport.height,
            panel_width,
            panel_height,
            ComposerMenuAlignment::Left,
            ComposerMenuDrop::Down,
        )
        .unwrap_or(ComposerMenuPlacement {
            left: px(8.0),
            vertical: px(38.0),
            drop: ComposerMenuDrop::Down,
        });
        div()
            .id("composer-project-menu")
            .occlude()
            .absolute()
            .left(placement.left)
            .when(placement.drop == ComposerMenuDrop::Up, |menu| {
                menu.bottom(placement.vertical)
            })
            .when(placement.drop == ComposerMenuDrop::Down, |menu| {
                menu.top(placement.vertical)
            })
            .w(panel_width)
            .max_h(composer_menu_max_height(viewport.height))
            .overflow_y_scroll()
            .rounded(px(8.0))
            .border_1()
            .border_color(chrome::menu_border(theme))
            .bg(chrome::menu_background(theme))
            .shadow(chrome::flyout_shadows(theme))
            .p(px(4.0))
            .children(
                self.stage_settings
                    .projects
                    .iter()
                    .cloned()
                    .enumerate()
                    .map(|(index, project)| {
                        let selected = active_path.as_deref() == Some(project.path.as_str());
                        let path = project.path.clone();
                        let hover_group: SharedString =
                            format!("composer-project-option-{index}").into();
                        div()
                            .id(("composer-project-option", index))
                            .group(hover_group.clone())
                            .w_full()
                            .flex()
                            .flex_col()
                            .px(px(9.0))
                            .py(px(7.0))
                            .rounded(px(5.0))
                            .cursor_pointer()
                            .hover(move |style| style.bg(chrome::menu_hover_background(theme)))
                            .on_click(cx.listener(move |this, _event, _window, cx| {
                                this.choose_project(path.clone(), cx);
                            }))
                            .child(
                                div()
                                    .w_full()
                                    .min_w(px(0.0))
                                    .flex()
                                    .items_center()
                                    .justify_between()
                                    .gap(px(6.0))
                                    .child(
                                        div()
                                            .min_w(px(0.0))
                                            .flex_1()
                                            .truncate()
                                            .text_size(px(13.5))
                                            .text_color(theme.text.hsla())
                                            .child(project.name)
                                            .with_animation(
                                                ("composer-project-option-title-in", index),
                                                menu_entry_animation(theme),
                                                |title, delta| {
                                                    title.text_size(px(
                                                        13.5 * menu_entry_scale(delta)
                                                    ))
                                                },
                                            ),
                                    )
                                    .when(selected, |name| {
                                        name.child(menu_entry_icon(
                                            ("composer-project-option-check-in", index),
                                            ("composer-project-option-check", index),
                                            "icons/check.svg",
                                            13.0,
                                            hover_group,
                                            theme,
                                        ))
                                    })
                                    .with_animation(
                                        ("composer-project-option-name-in", index),
                                        menu_entry_animation(theme),
                                        |name, delta| name.gap(px(6.0 * menu_entry_scale(delta))),
                                    ),
                            )
                            .child(
                                div()
                                    .w_full()
                                    .truncate()
                                    .text_size(px(11.5))
                                    .text_color(theme.text_3.hsla())
                                    .child(project.path)
                                    .with_animation(
                                        ("composer-project-option-detail-in", index),
                                        menu_entry_animation(theme),
                                        |detail, delta| {
                                            detail.text_size(px(11.5 * menu_entry_scale(delta)))
                                        },
                                    ),
                            )
                            .with_animation(
                                ("composer-project-option-in", index),
                                menu_entry_animation(theme),
                                |option, delta| {
                                    let scale = menu_entry_scale(delta);
                                    option
                                        .px(px(9.0 * scale))
                                        .py(px(7.0 * scale))
                                        .rounded(px(5.0 * scale))
                                },
                            )
                    }),
            )
            .with_animation(
                "composer-project-menu",
                Animation::new(theme.motion.fast).with_easing(crate::theme::web_ease_out),
                move |menu, delta| {
                    let scale = menu_entry_scale(delta);
                    let menu = menu
                        .left(placement.left + panel_width * ((1.0 - scale) / 2.0))
                        .w(panel_width * scale)
                        .rounded(px(8.0 * scale))
                        .p(px(4.0 * scale))
                        .opacity(delta);
                    match placement.drop {
                        ComposerMenuDrop::Up => {
                            menu.bottom(placement.vertical - px(2.0 * (1.0 - delta)))
                        }
                        ComposerMenuDrop::Down => {
                            menu.top(placement.vertical + px(2.0 * (1.0 - delta)))
                        }
                    }
                },
            )
            .into_any_element()
    }

    fn branch_popover(&self, window: &Window, cx: &Context<Self>) -> AnyElement {
        let theme = self.theme;
        let selected = self.stage_settings.workspace_branch.clone();
        let viewport = window.viewport_size();
        let panel_width = composer_menu_width(280.0, viewport.width);
        let panel_height = composer_stacked_menu_height(
            self.stage_settings.branches.len(),
            13.5 * crate::theme::BASE_LINE_HEIGHT + 14.0,
            viewport.height,
        );
        let placement = composer_menu_placement(
            self.composer_box_bounds,
            self.branch_trigger_bounds,
            viewport.width,
            viewport.height,
            panel_width,
            panel_height,
            ComposerMenuAlignment::Left,
            ComposerMenuDrop::Down,
        )
        .unwrap_or(ComposerMenuPlacement {
            left: px(175.0),
            vertical: px(38.0),
            drop: ComposerMenuDrop::Down,
        });
        div()
            .id("composer-branch-menu")
            .occlude()
            .absolute()
            .left(placement.left)
            .when(placement.drop == ComposerMenuDrop::Up, |menu| {
                menu.bottom(placement.vertical)
            })
            .when(placement.drop == ComposerMenuDrop::Down, |menu| {
                menu.top(placement.vertical)
            })
            .w(panel_width)
            .max_h(composer_menu_max_height(viewport.height))
            .overflow_y_scroll()
            .rounded(px(8.0))
            .border_1()
            .border_color(chrome::menu_border(theme))
            .bg(chrome::menu_background(theme))
            .shadow(chrome::flyout_shadows(theme))
            .p(px(4.0))
            .children(
                self.stage_settings
                    .branches
                    .iter()
                    .cloned()
                    .enumerate()
                    .map(|(index, branch)| {
                        let active = selected.as_deref() == Some(branch.as_str());
                        let value = branch.clone();
                        let hover_group: SharedString =
                            format!("composer-branch-option-{index}").into();
                        div()
                            .id(("composer-branch-option", index))
                            .group(hover_group.clone())
                            .w_full()
                            .flex()
                            .items_center()
                            .gap(px(6.0))
                            .px(px(9.0))
                            .py(px(7.0))
                            .rounded(px(5.0))
                            .text_size(px(13.5))
                            .text_color(theme.text.hsla())
                            .cursor_pointer()
                            .hover(move |style| {
                                style
                                    .bg(chrome::menu_hover_background(theme))
                                    .text_color(theme.text.hsla())
                            })
                            .on_click(cx.listener(move |this, _event, _window, cx| {
                                this.choose_branch(value.clone(), cx);
                            }))
                            .child(div().min_w(px(0.0)).flex_1().truncate().child(branch))
                            .when(active, |row| {
                                row.child(menu_entry_icon(
                                    ("composer-branch-option-check-in", index),
                                    ("composer-branch-option-check", index),
                                    "icons/check.svg",
                                    13.0,
                                    hover_group,
                                    theme,
                                ))
                            })
                            .with_animation(
                                ("composer-branch-option-in", index),
                                menu_entry_animation(theme),
                                |option, delta| {
                                    let scale = menu_entry_scale(delta);
                                    option
                                        .gap(px(6.0 * scale))
                                        .px(px(9.0 * scale))
                                        .py(px(7.0 * scale))
                                        .rounded(px(5.0 * scale))
                                        .text_size(px(13.5 * scale))
                                },
                            )
                    }),
            )
            .with_animation(
                "composer-branch-menu",
                Animation::new(theme.motion.fast).with_easing(crate::theme::web_ease_out),
                move |menu, delta| {
                    let scale = menu_entry_scale(delta);
                    let menu = menu
                        .left(placement.left + panel_width * ((1.0 - scale) / 2.0))
                        .w(panel_width * scale)
                        .rounded(px(8.0 * scale))
                        .p(px(4.0 * scale))
                        .opacity(delta);
                    match placement.drop {
                        ComposerMenuDrop::Up => {
                            menu.bottom(placement.vertical - px(2.0 * (1.0 - delta)))
                        }
                        ComposerMenuDrop::Down => {
                            menu.top(placement.vertical + px(2.0 * (1.0 - delta)))
                        }
                    }
                },
            )
            .into_any_element()
    }

    fn permission_popover(&self, window: &Window, cx: &Context<Self>) -> AnyElement {
        let theme = self.theme;
        let selected = self.composer_settings.approval;
        let auto_review = self.composer_settings.auto_review_supported;
        let options = [
            (
                ApprovalMode::Ask,
                "Ask first",
                "Read-only until you approve each action",
            ),
            (
                ApprovalMode::Auto,
                "Auto-approve",
                "Edits and commands inside this folder",
            ),
            (
                ApprovalMode::AutoReview,
                "Auto-review",
                "Reviews elevated actions before they run",
            ),
            (
                ApprovalMode::Full,
                "Full access",
                "No sandbox, no prompts, no undo. Use with care.",
            ),
        ];
        let viewport = window.viewport_size();
        let panel_width = composer_menu_width(315.0, viewport.width);
        let panel_height = composer_stacked_menu_height(
            if auto_review { 4 } else { 3 },
            (13.5 + 11.5) * crate::theme::BASE_LINE_HEIGHT + 14.0,
            viewport.height,
        );
        let placement = composer_menu_placement(
            self.composer_box_bounds,
            self.permission_trigger_bounds,
            viewport.width,
            viewport.height,
            panel_width,
            panel_height,
            ComposerMenuAlignment::Left,
            ComposerMenuDrop::Up,
        )
        .unwrap_or(ComposerMenuPlacement {
            left: px(48.0),
            vertical: px(49.0),
            drop: ComposerMenuDrop::Up,
        });
        div()
            .occlude()
            .absolute()
            .left(placement.left)
            .when(placement.drop == ComposerMenuDrop::Up, |menu| {
                menu.bottom(placement.vertical)
            })
            .when(placement.drop == ComposerMenuDrop::Down, |menu| {
                menu.top(placement.vertical)
            })
            .w(panel_width)
            .max_h(composer_menu_max_height(viewport.height))
            .rounded(px(8.0))
            .border_1()
            .border_color(chrome::menu_border(theme))
            .bg(chrome::menu_background(theme))
            .shadow(chrome::flyout_shadows(theme))
            .p(px(4.0))
            .children(
                options
                    .into_iter()
                    .filter(|(mode, _, _)| *mode != ApprovalMode::AutoReview || auto_review)
                    .enumerate()
                    .map(|(index, (mode, title, detail))| {
                        let active = mode == selected;
                        let (icon_path, _) = approval_meta(mode);
                        let semantic_color = approval_semantic_color(mode, theme);
                        let title_color = semantic_color.unwrap_or_else(|| theme.text.hsla());
                        let icon_color = semantic_color.unwrap_or_else(|| theme.text_3.hsla());
                        let hover_group: SharedString = format!("permission-option-{index}").into();
                        div()
                            .id(("permission-option", index))
                            .group(hover_group.clone())
                            .w_full()
                            .flex()
                            .flex_col()
                            .px(px(9.0))
                            .py(px(7.0))
                            .rounded(px(5.0))
                            .cursor_pointer()
                            .hover(move |style| style.bg(chrome::menu_hover_background(theme)))
                            .on_click(cx.listener(move |this, _event, _window, cx| {
                                this.choose_approval(mode, cx);
                            }))
                            .child(
                                div()
                                    .w_full()
                                    .min_w(px(0.0))
                                    .flex()
                                    .items_center()
                                    .justify_between()
                                    .gap(px(6.0))
                                    .child(
                                        div()
                                            .min_w(px(0.0))
                                            .flex()
                                            .items_center()
                                            .gap(px(8.0))
                                            .child(div().flex_none().text_color(icon_color).child(
                                                menu_entry_icon(
                                                    ("permission-option-icon-in", index),
                                                    ("permission-option-icon", index),
                                                    icon_path,
                                                    14.0,
                                                    hover_group.clone(),
                                                    theme,
                                                ),
                                            ))
                                            .child(
                                                div()
                                                    .min_w(px(0.0))
                                                    .truncate()
                                                    .text_size(px(13.5))
                                                    .text_color(title_color)
                                                    .child(title)
                                                    .with_animation(
                                                        ("permission-option-title-in", index),
                                                        menu_entry_animation(theme),
                                                        |title, delta| {
                                                            title.text_size(px(
                                                                13.5 * menu_entry_scale(delta)
                                                            ))
                                                        },
                                                    ),
                                            )
                                            .with_animation(
                                                ("permission-option-label-in", index),
                                                menu_entry_animation(theme),
                                                |label, delta| {
                                                    label.gap(px(8.0 * menu_entry_scale(delta)))
                                                },
                                            ),
                                    )
                                    .when(active, |name| {
                                        name.child(menu_entry_icon(
                                            ("permission-option-check-in", index),
                                            ("permission-option-check", index),
                                            "icons/check.svg",
                                            13.0,
                                            hover_group,
                                            theme,
                                        ))
                                    })
                                    .with_animation(
                                        ("permission-option-name-in", index),
                                        menu_entry_animation(theme),
                                        |name, delta| name.gap(px(6.0 * menu_entry_scale(delta))),
                                    ),
                            )
                            .child(
                                div()
                                    .w_full()
                                    .truncate()
                                    .text_size(px(11.5))
                                    .text_color(theme.text_3.hsla())
                                    .child(detail)
                                    .with_animation(
                                        ("permission-option-detail-in", index),
                                        menu_entry_animation(theme),
                                        |detail, delta| {
                                            detail.text_size(px(11.5 * menu_entry_scale(delta)))
                                        },
                                    ),
                            )
                            .with_animation(
                                ("permission-option-in", index),
                                menu_entry_animation(theme),
                                |option, delta| {
                                    let scale = menu_entry_scale(delta);
                                    option
                                        .px(px(9.0 * scale))
                                        .py(px(7.0 * scale))
                                        .rounded(px(5.0 * scale))
                                },
                            )
                    }),
            )
            .with_animation(
                "composer-permission-menu",
                Animation::new(theme.motion.fast).with_easing(crate::theme::web_ease_out),
                move |menu, delta| {
                    let scale = menu_entry_scale(delta);
                    let menu = menu
                        .left(placement.left + panel_width * ((1.0 - scale) / 2.0))
                        .w(panel_width * scale)
                        .rounded(px(8.0 * scale))
                        .p(px(4.0 * scale))
                        .opacity(delta);
                    match placement.drop {
                        ComposerMenuDrop::Up => {
                            menu.bottom(placement.vertical - px(2.0 * (1.0 - delta)))
                        }
                        ComposerMenuDrop::Down => {
                            menu.top(placement.vertical + px(2.0 * (1.0 - delta)))
                        }
                    }
                },
            )
            .into_any_element()
    }

    fn model_popover(&self, window: &Window, cx: &Context<Self>) -> AnyElement {
        let theme = self.theme;
        let selected_key = self.composer_settings.selected_model_key.clone();
        let selected = self.selected_model().cloned();
        let groups = group_models_by_source(&self.composer_settings.models);
        let selected_group_key = selected.as_ref().map(model_picker_source_key);
        let active_group = self
            .active_model_source_key
            .as_deref()
            .and_then(|key| groups.iter().find(|group| group.key == key))
            .or_else(|| {
                selected_group_key
                    .as_deref()
                    .and_then(|key| groups.iter().find(|group| group.key == key))
            })
            .or_else(|| groups.first())
            .cloned();
        let active_group_key = active_group.as_ref().map(|group| group.key.clone());
        let query = self.model_search.read(cx).value().to_string();
        let viewport = window.viewport_size();
        let panel_width = composer_menu_width(MODEL_PICKER_WIDTH, viewport.width);
        let panel_height =
            px(MODEL_PICKER_PANEL_HEIGHT).min(composer_menu_max_height(viewport.height));
        let fallback_left = self
            .composer_box_bounds
            .map_or(px(CHAT_WIDTH - MODEL_PICKER_WIDTH - 72.0), |bounds| {
                bounds.size.width - panel_width - px(72.0)
            });
        let placement = composer_menu_placement(
            self.composer_box_bounds,
            self.model_trigger_bounds,
            viewport.width,
            viewport.height,
            panel_width,
            panel_height,
            ComposerMenuAlignment::RightShiftedLeft(MODEL_MENU_TRANSLATE_X),
            ComposerMenuDrop::Up,
        )
        .unwrap_or(ComposerMenuPlacement {
            left: fallback_left,
            vertical: px(48.0),
            drop: ComposerMenuDrop::Up,
        });
        let provider_rail = div()
            .id("model-provider-rail")
            .h_full()
            .w(px(52.0))
            .flex_none()
            .flex()
            .flex_col()
            .items_center()
            .gap(px(4.0))
            .overflow_y_scroll()
            .px(px(8.0))
            .py(px(6.0))
            .bg(theme.surface.hsla())
            .border_r_1()
            .border_color(chrome::menu_border(theme))
            .children(groups.into_iter().enumerate().map(|(index, group)| {
                let active = active_group_key.as_deref() == Some(group.key.as_str());
                let key = group.key;
                let hover_group: SharedString = format!("model-provider-{index}").into();
                let button = div()
                    .id(("model-provider", index))
                    .group(hover_group.clone())
                    .absolute()
                    .inset_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(5.0))
                    .text_color(if active {
                        theme.text.hsla()
                    } else {
                        theme.text_3.hsla()
                    })
                    .when(active, |button| {
                        button
                            .bg(model_picker_selected_background(theme))
                            .shadow(model_picker_selected_shadows(theme))
                            .when(theme.mode == ThemeMode::Light, |button| {
                                button.border_1().border_color(gpui::rgb(0xe3e3e6))
                            })
                    })
                    .cursor_pointer()
                    .hover(move |style| style.bg(model_picker_hover_background(theme)))
                    .active(|style| {
                        style
                            .top(relative(0.02))
                            .right(relative(0.02))
                            .bottom(relative(0.02))
                            .left(relative(0.02))
                    })
                    .on_click(cx.listener(move |this, _event, _window, cx| {
                        this.select_model_source(key.clone(), cx);
                    }))
                    .child(
                        div()
                            .size(px(18.0))
                            .child(
                                div()
                                    .id(("model-provider-icon-press", index))
                                    .size_full()
                                    .group_active(hover_group.clone(), |style| {
                                        style.size(px(17.28)).m(px(0.36))
                                    })
                                    .child(
                                        motion_icon(
                                            ("model-provider-icon", index),
                                            provider_mark_path(provider_mark(group.provider)),
                                            18.0,
                                            hover_group,
                                            theme,
                                        )
                                        .size_full(),
                                    ),
                            )
                            .text_color(if active {
                                theme.text.hsla()
                            } else {
                                theme.text_3.hsla()
                            })
                            .with_animation(
                                ("model-provider-icon-in", index),
                                menu_entry_animation(theme),
                                |icon, delta| icon.size(px(18.0 * menu_entry_scale(delta))),
                            ),
                    );
                div()
                    .relative()
                    .size(px(34.0))
                    .flex_none()
                    .child(button)
                    .with_animation(
                        ("model-provider-in", index),
                        menu_entry_animation(theme),
                        |provider, delta| provider.size(px(34.0 * menu_entry_scale(delta))),
                    )
            }))
            .with_animation(
                "model-provider-rail-in",
                menu_entry_animation(theme),
                |rail, delta| {
                    let scale = menu_entry_scale(delta);
                    rail.w(px(52.0 * scale))
                        .gap(px(4.0 * scale))
                        .px(px(8.0 * scale))
                        .py(px(6.0 * scale))
                },
            );

        let models = if let Some(group) = active_group {
            let rows = filter_model_choices_by_query(&group.entries, &query)
                .into_iter()
                .enumerate()
                .map(|(index, choice)| {
                    let active = selected_key.as_deref() == Some(choice.key.as_str());
                    let key = choice.key.clone();
                    let hover_group: SharedString = format!("model-option-{index}").into();
                    div()
                        .id(("model-option", index))
                        .group(hover_group.clone())
                        .min_h(px(32.0))
                        .w_full()
                        .flex()
                        .items_center()
                        .justify_between()
                        .gap(px(8.0))
                        .px(px(8.0))
                        .rounded(px(5.0))
                        .when(active, |row| {
                            row.bg(model_picker_selected_background(theme))
                                .shadow(model_picker_selected_shadows(theme))
                                .when(theme.mode == ThemeMode::Light, |row| {
                                    row.border_1().border_color(gpui::rgb(0xe3e3e6))
                                })
                        })
                        .cursor_pointer()
                        .hover(move |style| style.bg(model_picker_hover_background(theme)))
                        .on_click(cx.listener(move |this, _event, _window, cx| {
                            this.choose_model(key.clone(), cx);
                        }))
                        .child(
                            div()
                                .min_w(px(0.0))
                                .flex_1()
                                .truncate()
                                .text_size(px(12.5))
                                .text_color(theme.text.hsla())
                                .child(choice.model.display_name)
                                .with_animation(
                                    ("model-option-name-in", index),
                                    menu_entry_animation(theme),
                                    |name, delta| {
                                        name.text_size(px(12.5 * menu_entry_scale(delta)))
                                    },
                                ),
                        )
                        .when(active, |row| {
                            row.child(div().flex_none().text_color(theme.text_2.hsla()).child(
                                menu_entry_icon(
                                    ("model-option-check-in", index),
                                    ("model-option-check", index),
                                    "icons/check.svg",
                                    14.0,
                                    hover_group,
                                    theme,
                                ),
                            ))
                        })
                        .with_animation(
                            ("model-option-in", index),
                            menu_entry_animation(theme),
                            |row, delta| {
                                let scale = menu_entry_scale(delta);
                                row.min_h(px(32.0 * scale))
                                    .gap(px(8.0 * scale))
                                    .px(px(8.0 * scale))
                                    .rounded(px(5.0 * scale))
                            },
                        )
                        .into_any_element()
                })
                .collect::<Vec<_>>();
            let empty = rows.is_empty();
            div()
                .h_full()
                .min_w(px(0.0))
                .flex_1()
                .flex()
                .flex_col()
                .p(px(6.0))
                .child(
                    div()
                        .h(px(34.0))
                        .flex_none()
                        .flex()
                        .items_center()
                        .gap(px(6.0))
                        .pl(px(8.0))
                        .pr(px(4.0))
                        .py(px(3.0))
                        .when(theme.mode == ThemeMode::Dark, |header| {
                            header.bg(theme.surface_2.hsla())
                        })
                        .child(
                            div()
                                .min_w(px(0.0))
                                .flex_1()
                                .truncate()
                                .text_size(px(10.0))
                                .font_weight(FontWeight(560.0))
                                .text_color(theme.text_3.hsla())
                                .child(tracked_text(group.name, 0.02))
                                .with_animation(
                                    "model-group-title-in",
                                    menu_entry_animation(theme),
                                    |title, delta| {
                                        title.text_size(px(10.0 * menu_entry_scale(delta)))
                                    },
                                ),
                        )
                        .child(self.model_search_field(query, window, cx))
                        .with_animation(
                            "model-group-head-in",
                            menu_entry_animation(theme),
                            |header, delta| {
                                let scale = menu_entry_scale(delta);
                                header
                                    .h(px(34.0 * scale))
                                    .gap(px(6.0 * scale))
                                    .pl(px(8.0 * scale))
                                    .pr(px(4.0 * scale))
                                    .py(px(3.0 * scale))
                            },
                        ),
                )
                .child(
                    div()
                        .id(SharedString::from(format!(
                            "model-options-scroll:{}",
                            group.key
                        )))
                        .flex_1()
                        .min_h(px(0.0))
                        .overflow_y_scroll()
                        .when(empty, |list| {
                            list.child(
                                div()
                                    .px(px(8.0))
                                    .py(px(24.0))
                                    .text_center()
                                    .text_size(px(12.5))
                                    .text_color(theme.text_3.hsla())
                                    .child("No matching models.")
                                    .with_animation(
                                        "model-empty-in",
                                        menu_entry_animation(theme),
                                        |empty, delta| {
                                            let scale = menu_entry_scale(delta);
                                            empty
                                                .px(px(8.0 * scale))
                                                .py(px(24.0 * scale))
                                                .text_size(px(12.5 * scale))
                                        },
                                    ),
                            )
                        })
                        .children(rows),
                )
                .with_animation(
                    "model-models-in",
                    menu_entry_animation(theme),
                    |models, delta| models.p(px(6.0 * menu_entry_scale(delta))),
                )
                .into_any_element()
        } else {
            div().flex_1().into_any_element()
        };

        div()
            .occlude()
            .absolute()
            .left(placement.left)
            .when(placement.drop == ComposerMenuDrop::Up, |menu| {
                menu.bottom(placement.vertical)
            })
            .when(placement.drop == ComposerMenuDrop::Down, |menu| {
                menu.top(placement.vertical)
            })
            .w(panel_width)
            .max_h(composer_menu_max_height(viewport.height))
            .rounded(px(RADIUS_XL))
            .border_1()
            .border_color(model_picker_border(theme))
            .bg(model_picker_background(theme))
            .shadow(chrome::flyout_shadows(theme))
            .overflow_hidden()
            .child(
                div()
                    .h(px(246.0))
                    .w_full()
                    .flex()
                    .overflow_hidden()
                    .child(provider_rail)
                    .child(models)
                    .with_animation(
                        "model-catalog-in",
                        menu_entry_animation(theme),
                        |catalog, delta| catalog.h(px(246.0 * menu_entry_scale(delta))),
                    ),
            )
            .when_some(selected, |menu, selected| {
                menu.child(self.model_controls(selected, panel_width, window, cx))
            })
            .with_animation(
                "composer-model-menu",
                Animation::new(theme.motion.fast).with_easing(crate::theme::web_ease_out),
                move |menu, delta| {
                    let scale = menu_entry_scale(delta);
                    let menu = menu
                        .left(placement.left + panel_width * ((1.0 - scale) / 2.0))
                        .w(panel_width * scale)
                        .rounded(px(RADIUS_XL * scale))
                        .opacity(delta);
                    match placement.drop {
                        ComposerMenuDrop::Up => {
                            menu.bottom(placement.vertical - px(2.0 * (1.0 - delta)))
                        }
                        ComposerMenuDrop::Down => {
                            menu.top(placement.vertical + px(2.0 * (1.0 - delta)))
                        }
                    }
                },
            )
            .into_any_element()
    }

    fn model_search_field(&self, query: String, window: &Window, cx: &Context<Self>) -> AnyElement {
        let theme = self.theme;
        let focused = self
            .model_search
            .read(cx)
            .focus_handle(cx)
            .is_focused(window);
        let clear_input = self.model_search.clone();
        let keyboard_clear_input = clear_input.clone();
        div()
            .id("model-search")
            .relative()
            .h(px(26.0))
            .w(px(184.0))
            .min_w(px(120.0))
            .flex_none()
            .flex()
            .items_center()
            .gap(px(6.0))
            .px(px(7.0))
            .rounded(px(5.0))
            .border_1()
            .border_color(if focused {
                theme.text_3.hsla()
            } else {
                chrome::border(theme)
            })
            .bg(chrome::recessed(theme))
            .text_color(theme.text_3.hsla())
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                if event.keystroke.key.eq_ignore_ascii_case("escape")
                    && !this.model_search.read(cx).value().is_empty()
                {
                    cx.stop_propagation();
                    this.model_search.update(cx, |input, cx| {
                        input.set_value("", window, cx);
                    });
                }
            }))
            .child(chrome::inset_top_shade(theme))
            .child(menu_entry_icon(
                "model-search-icon-in",
                "model-search-icon",
                "icons/search.svg",
                13.0,
                "model-search-icon-direct-hover",
                theme,
            ))
            .child(
                Input::new(&self.model_search)
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
                    .text_color(theme.text.hsla())
                    .with_animation(
                        "model-search-input-in",
                        menu_entry_animation(theme),
                        |input, delta| input.text_size(px(12.5 * menu_entry_scale(delta))),
                    ),
            )
            .when(!query.is_empty(), |field| {
                field.child(
                    div()
                        .id("clear-model-search")
                        .group("clear-model-search-hover")
                        .tab_index(0)
                        .size(px(18.0))
                        .flex_none()
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded_full()
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
                        .child(menu_entry_icon(
                            "clear-model-search-icon-in",
                            "clear-model-search-icon",
                            "icons/x.svg",
                            12.0,
                            "clear-model-search-hover",
                            theme,
                        ))
                        .with_animation(
                            "clear-model-search-in",
                            menu_entry_animation(theme),
                            |clear, delta| clear.size(px(18.0 * menu_entry_scale(delta))),
                        ),
                )
            })
            .with_animation(
                "model-search-in",
                menu_entry_animation(theme),
                |field, delta| {
                    let scale = menu_entry_scale(delta);
                    field
                        .h(px(26.0 * scale))
                        .w(px(184.0 * scale))
                        .min_w(px(120.0 * scale))
                        .gap(px(6.0 * scale))
                        .px(px(7.0 * scale))
                        .rounded(px(5.0 * scale))
                },
            )
            .into_any_element()
    }

    fn model_controls(
        &self,
        selected: ModelChoice,
        panel_width: Pixels,
        window: &Window,
        cx: &Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let fast = is_fast_mode_enabled(
            &selected.model,
            self.composer_settings.service_tier.as_deref(),
        );
        let has_fast = fast_service_tier(&selected.model).is_some();
        let selected_effort =
            selected_reasoning_effort(&selected.model, self.composer_settings.effort.as_deref())
                .map(str::to_owned);
        let efforts = selected.model.reasoning_efforts;
        let selected_index = selected_effort
            .as_deref()
            .and_then(|effort| efforts.iter().position(|candidate| candidate == effort))
            .unwrap_or(0);
        let display_index = self
            .effort_preview_index
            .unwrap_or(selected_index)
            .min(efforts.len().saturating_sub(1));
        let displayed_label = efforts
            .get(display_index)
            .map(|effort| friendly_effort_label(Some(effort)))
            .unwrap_or_else(|| "Default".into());
        div()
            .h(px(89.0))
            .flex()
            .flex_col()
            .gap(px(6.0))
            .border_t_1()
            .border_color(chrome::menu_border(theme))
            .bg(model_picker_controls_background(theme))
            .p(px(MODEL_CONTROLS_PADDING))
            .child(
                div()
                    .min_h(px(30.0))
                    .flex()
                    .items_center()
                    .justify_between()
                    .pl(px(6.0))
                    .child(
                        div()
                            .flex_1()
                            .flex()
                            .items_center()
                            .text_size(px(11.5))
                            .font_weight(FontWeight(520.0))
                            .text_color(theme.text_3.hsla())
                            .child("Effort: ")
                            .child(
                                div()
                                    .text_color(if theme.mode == ThemeMode::Dark {
                                        gpui::rgb(0xf5f5f7)
                                    } else {
                                        gpui::rgb(0x27272a)
                                    })
                                    .child(displayed_label),
                            )
                            .with_animation(
                                "model-effort-title-in",
                                menu_entry_animation(theme),
                                |title, delta| title.text_size(px(11.5 * menu_entry_scale(delta))),
                            ),
                    )
                    .when(has_fast, |row| {
                        let button = div()
                            .id("model-fast-toggle")
                            .group("model-fast-toggle-hover")
                            .absolute()
                            .inset_0()
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(15.0))
                            .border_1()
                            .border_color(fast_toggle_border(theme, fast))
                            .bg(fast_toggle_background(theme, fast))
                            .text_color(if fast {
                                theme.text.hsla()
                            } else {
                                theme.text_2.hsla()
                            })
                            .shadow(fast_toggle_shadows(theme))
                            .cursor_pointer()
                            .hover(move |style| {
                                style
                                    .border_color(theme.text_3.hsla())
                                    .bg(fast_toggle_hover_background(theme))
                            })
                            .active(|style| {
                                style
                                    .top(relative(0.015))
                                    .right(relative(0.015))
                                    .bottom(relative(0.015))
                                    .left(relative(0.015))
                            })
                            .on_click(cx.listener(|this, _event, _window, cx| {
                                cx.emit(ChatEvent::ToggleFast);
                                this.composer_menu = Some(ComposerMenu::Model);
                            }))
                            .child(fast_toggle_icon(fast, "model-fast-toggle-hover", theme));
                        row.child(
                            div()
                                .relative()
                                .size(px(30.0))
                                .flex_none()
                                .child(button)
                                .with_animation(
                                    "model-fast-toggle-in",
                                    menu_entry_animation(theme),
                                    |toggle, delta| toggle.size(px(30.0 * menu_entry_scale(delta))),
                                ),
                        )
                    })
                    .with_animation(
                        "model-controls-head-in",
                        menu_entry_animation(theme),
                        |header, delta| {
                            let scale = menu_entry_scale(delta);
                            header.min_h(px(30.0 * scale)).pl(px(6.0 * scale))
                        },
                    ),
            )
            .when(!efforts.is_empty(), |controls| {
                controls.child(self.effort_slider(
                    efforts,
                    selected_index,
                    display_index,
                    panel_width - px(MODEL_CONTROLS_PADDING * 2.0),
                    window,
                    cx,
                ))
            })
            .with_animation(
                "model-controls-in",
                menu_entry_animation(theme),
                |controls, delta| {
                    let scale = menu_entry_scale(delta);
                    controls
                        .h(px(89.0 * scale))
                        .gap(px(6.0 * scale))
                        .p(px(MODEL_CONTROLS_PADDING * scale))
                },
            )
            .into_any_element()
    }

    fn effort_slider(
        &self,
        efforts: Vec<String>,
        selected_index: usize,
        display_index: usize,
        track_width: Pixels,
        window: &Window,
        cx: &Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let count = efforts.len();
        let disabled = count <= 1;
        let inset = f32::from(px(EFFORT_SLIDER_INSET));
        let minimum_fill = f32::from(px(EFFORT_SLIDER_MIN_FILL));
        let selected_width = gpui::px(effort_fill_width(
            selected_index,
            count,
            f32::from(track_width),
            inset,
            minimum_fill,
        ));
        let display_width = gpui::px(effort_fill_width(
            display_index,
            count,
            f32::from(track_width),
            inset,
            minimum_fill,
        ));
        let entity = cx.entity();
        let bounds_probe = canvas(
            move |bounds, _, cx| {
                entity.update(cx, |this, _| {
                    this.effort_slider_bounds_changed(bounds);
                });
            },
            |_, _, _, _| {},
        )
        .absolute()
        .inset_0();

        let base_dither = canvas(
            |_, _, _| {},
            move |bounds, _, window, _| {
                paint_effort_dither(bounds, None, false, theme, window);
            },
        )
        .absolute()
        .inset_0();

        let pointer = self.effort_pointer;
        let fading = self.effort_dither_fading;
        let generation = self.effort_dither_generation;
        let dither = pointer.map(|pointer| {
            canvas(
                |_, _, _| {},
                move |bounds, _, window, _| {
                    paint_effort_dither(bounds, Some(pointer), true, theme, window);
                },
            )
            .absolute()
            .inset_0()
            .with_animation(
                SharedString::from(format!("effort-dither:{generation}:{fading}")),
                Animation::new(theme.motion_duration(if fading {
                    EFFORT_DITHER_FADE_OUT
                } else {
                    EFFORT_DITHER_FADE_IN
                }))
                .with_easing(ease_out_cubic),
                move |layer, delta| layer.opacity(if fading { 1.0 - delta } else { delta }),
            )
        });

        let track_background = if theme.mode == ThemeMode::Dark {
            gpui::rgb(0x171719).into()
        } else {
            linear_gradient(
                180.0,
                linear_color_stop(gpui::rgb(0xf3f3f5), 0.0),
                linear_color_stop(gpui::white(), 1.0),
            )
        };
        let track_border = if theme.mode == ThemeMode::Dark {
            gpui::white().opacity(0.008)
        } else {
            gpui::rgb(0xdedee2).into()
        };
        let track_shadows = if theme.mode == ThemeMode::Dark {
            vec![BoxShadow {
                color: gpui::black().opacity(0.18),
                offset: point(px(0.0), px(1.0)),
                blur_radius: px(2.0),
                spread_radius: px(0.0),
            }]
        } else {
            vec![BoxShadow {
                color: gpui::rgba(0x18181b12).into(),
                offset: point(px(0.0), px(1.0)),
                blur_radius: px(2.0),
                spread_radius: px(0.0),
            }]
        };
        let fill_background = if theme.mode == ThemeMode::Dark {
            linear_gradient(
                180.0,
                linear_color_stop(gpui::rgb(0x2d2d2f), 0.0),
                linear_color_stop(gpui::rgb(0x363638), 1.0),
            )
        } else {
            linear_gradient(
                180.0,
                linear_color_stop(gpui::rgb(0xfafafa), 0.0),
                linear_color_stop(gpui::rgb(0xececef), 1.0),
            )
        };
        let fill_shadows = if theme.mode == ThemeMode::Dark {
            vec![BoxShadow {
                color: gpui::white().opacity(0.025),
                offset: point(px(0.0), px(-1.0)),
                blur_radius: px(0.0),
                spread_radius: px(0.0),
            }]
        } else {
            vec![
                BoxShadow {
                    color: gpui::white(),
                    offset: point(px(0.0), px(1.0)),
                    blur_radius: px(0.0),
                    spread_radius: px(0.0),
                },
                BoxShadow {
                    color: gpui::rgba(0x18181b12).into(),
                    offset: point(px(0.0), px(1.0)),
                    blur_radius: px(2.0),
                    spread_radius: px(0.0),
                },
            ]
        };

        let fill = div()
            .absolute()
            .top(px(EFFORT_SLIDER_INSET))
            .bottom(px(EFFORT_SLIDER_INSET))
            .left(px(EFFORT_SLIDER_INSET))
            .w(display_width)
            .rounded_full()
            .overflow_hidden()
            .bg(fill_background)
            .shadow(fill_shadows)
            .child(base_dither)
            .when_some(dither, |fill, dither| fill.child(dither))
            .with_animation(
                ("effort-slider-fill", display_index),
                Animation::new(theme.motion_duration(Duration::from_millis(170)))
                    .with_easing(crate::theme::web_ease_out),
                move |fill, delta| {
                    fill.w(selected_width + (display_width - selected_width) * delta)
                },
            );

        let stops = div()
            .absolute()
            .inset_0()
            .left(px(22.0))
            .right(px(22.0))
            .children((0..count).map(|index| {
                let active = index <= display_index;
                let progress = effort_progress(index, count);
                let stop_background: gpui::Hsla = if active {
                    if theme.mode == ThemeMode::Dark {
                        gpui::rgba(0xf5f5f7d6).into()
                    } else {
                        gpui::rgba(0x27272ad6).into()
                    }
                } else {
                    theme.text_3.hsla().opacity(0.52)
                };
                div()
                    .id(("effort-stop", index))
                    .absolute()
                    .top(relative(0.5))
                    .left(relative(progress))
                    .mt(px(-2.0))
                    .ml(px(-2.0))
                    .size(px(4.0))
                    .rounded_full()
                    .bg(stop_background)
                    .shadow(vec![BoxShadow {
                        color: gpui::black().opacity(0.10),
                        offset: point(px(0.0), px(0.0)),
                        blur_radius: px(0.0),
                        spread_radius: px(1.0),
                    }])
                    .with_animation(
                        ("effort-stop-in", index),
                        menu_entry_animation(theme),
                        |stop, delta| {
                            let scale = menu_entry_scale(delta);
                            stop.mt(px(-2.0 * scale))
                                .ml(px(-2.0 * scale))
                                .size(px(4.0 * scale))
                        },
                    )
            }))
            .with_animation(
                "effort-stops-in",
                menu_entry_animation(theme),
                |stops, delta| {
                    let inset = 22.0 * menu_entry_scale(delta);
                    stops.left(px(inset)).right(px(inset))
                },
            );

        let track = div()
            .absolute()
            .inset_0()
            .rounded_full()
            .border_1()
            .border_color(track_border)
            .bg(track_background)
            .shadow(track_shadows)
            .overflow_hidden()
            .child(fill)
            .child(stops);

        let surface = div()
            .id("model-effort-slider")
            .absolute()
            .inset_0()
            .track_focus(&self.effort_focus)
            .opacity(if disabled { 0.45 } else { 1.0 })
            .child(bounds_probe)
            .child(track)
            .when(
                self.effort_focus.is_focused(window) && !disabled,
                |slider| {
                    slider.child(
                        div()
                            .absolute()
                            .inset(px(-3.0))
                            .rounded_full()
                            .border_1()
                            .border_color(theme.text_2.hsla()),
                    )
                },
            );

        let efforts_for_up = efforts.clone();
        let surface = if disabled {
            surface
        } else {
            surface
                .on_key_down(cx.listener(move |this, event, _window, cx| {
                    this.effort_key_down(event, &efforts, selected_index, cx);
                }))
                .on_mouse_down(
                    gpui::MouseButton::Left,
                    cx.listener(move |this, event, window, cx| {
                        this.begin_effort_drag(event, count, window, cx);
                    }),
                )
                .on_mouse_move(cx.listener(move |this, event, _window, cx| {
                    this.effort_pointer_moved(event, count, cx);
                }))
                .on_mouse_up(
                    gpui::MouseButton::Left,
                    cx.listener(move |this, event, _window, cx| {
                        this.finish_effort_drag(event, &efforts_for_up, selected_index, cx);
                    }),
                )
                .on_mouse_up_out(
                    gpui::MouseButton::Left,
                    cx.listener(|this, _event, _window, cx| {
                        this.cancel_effort_drag(cx);
                    }),
                )
                .on_hover(cx.listener(|this, hovered: &bool, _window, cx| {
                    if !*hovered && !this.effort_dragging {
                        this.begin_effort_dither_fade(cx);
                    }
                }))
        };
        div()
            .relative()
            .h(px(EFFORT_SLIDER_HEIGHT))
            .w_full()
            .child(surface)
            .with_animation(
                "model-effort-slider-in",
                menu_entry_animation(theme),
                |slider, delta| slider.h(px(EFFORT_SLIDER_HEIGHT * menu_entry_scale(delta))),
            )
            .into_any_element()
    }
}

impl Render for ChatView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.ensure_working_tick(cx);
        if matches!(
            self.transcript_scroll_mode.get(),
            TranscriptScrollMode::AnchorTurn { .. }
        ) {
            cx.on_next_frame(window, |this, _window, cx| {
                this.release_transcript_anchor_if_needed(cx);
            });
        }
        self.prepare_thread_search_input(window, cx);
        self.prepare_model_search_input(window, cx);
        if let Some(text) = self.restore_composer.take() {
            self.composer.update(cx, |composer, cx| {
                composer.set_value(text, window, cx);
            });
            self.clear_composer = false;
        } else if self.clear_composer {
            self.composer.update(cx, |composer, cx| {
                composer.set_value("", window, cx);
            });
            self.clear_composer = false;
        }
        let mut send_transcript = false;
        if let Some(pending) = self.pending_transcript.take() {
            let current = self.composer.read(cx).value().to_string();
            if let Some(insertion) =
                insert_transcript_at_cursor(&current, &pending.text, pending.cursor)
            {
                self.composer.update(cx, |composer, cx| {
                    composer.set_value(insertion.text, window, cx);
                    let position = composer.text().offset_to_position(insertion.cursor);
                    composer.set_cursor_position(position, window, cx);
                });
                send_transcript = pending.send_after;
            }
        }
        if send_transcript {
            self.submit(false, cx);
        }
        if let Some(sync) = self.user_input_field_sync.take() {
            let focus = self.user_input_custom_question.is_some();
            self.user_input_custom.update(cx, |input, cx| {
                input.set_masked(sync.masked, window, cx);
                input.set_value(sync.value, window, cx);
                if focus {
                    input.focus(window, cx);
                }
            });
        }
        let terminal_pane = self.terminal_pane(window, cx);
        let thread_search = self.thread_search_overlay(cx);
        let markdown_table_overlay = self.markdown_table_overlay(window, cx);
        let is_new_session = is_centered_new_session(self.session.as_ref(), self.creating);
        if !is_new_session {
            self.prepare_composer_dock_motion(window);
        }
        let view = div()
            .size_full()
            .min_w(px(0.0))
            .relative()
            .flex()
            .flex_col()
            .bg(self.theme.background.hsla())
            .on_mouse_move(cx.listener(|this, event, window, cx| {
                this.update_terminal_resize(event, window, cx);
            }))
            .on_mouse_up(
                gpui::MouseButton::Left,
                cx.listener(|this, _event, _window, cx| {
                    this.finish_terminal_resize(cx);
                }),
            )
            .capture_key_down(cx.listener(|this, event, window, cx| {
                this.handle_composer_paste_key(event, window, cx);
            }))
            .on_key_down(cx.listener(|this, event, window, cx| {
                this.handle_thread_navigation_key(event, window, cx);
            }));
        if is_new_session {
            return view
                .justify_center()
                .pb(px(new_session_optical_padding(design_dimension(
                    window.viewport_size().height,
                    crate::zoom::factor(),
                ))))
                .child(self.new_session_prompt(window))
                .child(self.composer(window, cx))
                .when_some(markdown_table_overlay, |view, overlay| view.child(overlay));
        }
        view.child(
            div()
                .relative()
                .flex_1()
                .min_h(px(0.0))
                .child(self.timeline(cx))
                .when_some(thread_search, |thread, search| thread.child(search)),
        )
        .when_some(terminal_pane, |view, terminal| view.child(terminal))
        .child(self.docked_composer(window, cx))
        .when_some(markdown_table_overlay, |view, overlay| view.child(overlay))
    }
}

impl ChatView {
    fn new_session_prompt(&self, window: &Window) -> AnyElement {
        let (label, text_size, text_color, letter_spacing) = if let Some(error) = &self.error {
            (Some(error.clone()), 12.5, self.theme.text_3.hsla(), None)
        } else {
            (
                new_session_prompt_label(
                    self.stage_settings.projects_loaded,
                    self.stage_settings.projects.is_empty(),
                    self.session
                        .as_ref()
                        .map(|session| session.project_name.as_str()),
                ),
                new_session_prompt_size(design_dimension(
                    window.viewport_size().width,
                    crate::zoom::factor(),
                )),
                self.theme.text.hsla(),
                Some(-0.035),
            )
        };
        div()
            .w_full()
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .p(px(24.0))
            .text_center()
            .text_size(px(text_size))
            .line_height(relative(1.12))
            .font_weight(FontWeight(400.0))
            .text_color(text_color)
            .when_some(label, |prompt, label| {
                prompt.child(if let Some(letter_spacing) = letter_spacing {
                    tracked_text(label, letter_spacing).into_any_element()
                } else {
                    label.into_any_element()
                })
            })
            .into_any_element()
    }
}

fn new_session_optical_padding(viewport_height: f32) -> f32 {
    (viewport_height * 0.015).clamp(0.0, 14.0)
}

fn design_dimension(dimension: Pixels, scale: f32) -> f32 {
    f32::from(dimension) / scale
}

fn is_new_session(session: Option<&SessionContext>) -> bool {
    session.is_none_or(|session| session.thread_id.is_none())
}

fn is_centered_new_session(session: Option<&SessionContext>, creating: bool) -> bool {
    is_new_session(session) && !creating
}

fn new_session_prompt_size(viewport_width: f32) -> f32 {
    (viewport_width * 0.024).clamp(20.0, 30.0)
}

fn new_session_prompt_label(
    projects_loaded: bool,
    projects_empty: bool,
    project_name: Option<&str>,
) -> Option<String> {
    if !projects_loaded {
        None
    } else if projects_empty {
        Some("Add a project to start building.".into())
    } else {
        Some(format!(
            "What should we build in {}?",
            project_name.unwrap_or("a project")
        ))
    }
}

fn optimistic_prompt_events(
    thread_id: &str,
    turn_id: &str,
    item_id: String,
    text: String,
    created_at: f64,
    start_turn: bool,
) -> Vec<ThreadEventPush> {
    let mut events = Vec::with_capacity(usize::from(start_turn) + 1);
    if start_turn {
        events.push(ThreadEventPush {
            thread_id: thread_id.into(),
            seq: None,
            event: DomainEvent::TurnStarted {
                turn: Turn {
                    id: turn_id.into(),
                    thread_id: thread_id.into(),
                    status: TurnStatus::Running,
                    created_at,
                },
            },
        });
    }
    events.push(ThreadEventPush {
        thread_id: thread_id.into(),
        seq: None,
        event: DomainEvent::ItemCompleted {
            item: Item {
                id: item_id,
                turn_id: turn_id.into(),
                item_type: ItemType::Message,
                status: ItemStatus::Completed,
                role: Some(MessageRole::User),
                text: Some(text),
                command: None,
                exit_code: None,
                duration_ms: None,
                path: None,
                lines_added: None,
                lines_removed: None,
                created_at,
            },
        },
    });
    events
}

fn reconcile_queue_snapshot(
    current: &ThreadQueueResult,
    mut incoming: ThreadQueueResult,
) -> ThreadQueueResult {
    let mut matched_canonical = HashSet::new();
    for pending in current
        .items
        .iter()
        .filter(|queued_turn| queued_turn.id.starts_with("pending:"))
    {
        let canonical_arrived = incoming
            .items
            .iter()
            .enumerate()
            .find(|(index, queued_turn)| {
                !matched_canonical.contains(index)
                    && !queued_turn.id.starts_with("pending:")
                    && queued_turn.created_at >= pending.created_at - 5_000.0
                    && same_queue_submission(queued_turn, pending)
            })
            .map(|(index, _)| matched_canonical.insert(index))
            .is_some();
        if !canonical_arrived
            && !incoming
                .items
                .iter()
                .any(|queued_turn| queued_turn.id == pending.id)
        {
            incoming.items.push(pending.clone());
        }
    }
    incoming
}

fn same_queue_submission(left: &QueuedTurn, right: &QueuedTurn) -> bool {
    left.text == right.text
        && left
            .attachments
            .iter()
            .filter(|path| path.as_str() != DESIGN_BRIEF_ATTACHMENT)
            .eq(right
                .attachments
                .iter()
                .filter(|path| path.as_str() != DESIGN_BRIEF_ATTACHMENT))
}

fn resolve_queue_submission(
    queue: &mut ThreadQueueResult,
    optimistic_queue_id: Option<&str>,
    queued_turn: Option<QueuedTurn>,
) {
    let optimistic_index = optimistic_queue_id
        .and_then(|queue_id| queue.items.iter().position(|item| item.id == queue_id));
    if let Some(queue_id) = optimistic_queue_id {
        queue.items.retain(|item| item.id != queue_id);
    }
    let Some(queued_turn) = queued_turn else {
        return;
    };
    if queue.items.iter().any(|item| item.id == queued_turn.id) {
        return;
    }
    let index = optimistic_index
        .unwrap_or(queue.items.len())
        .min(queue.items.len());
    queue.items.insert(index, queued_turn);
}

fn submitted_prompt_already_visible(
    state: &ThreadState,
    text: &str,
    created_at: f64,
    echo_after_row: usize,
) -> bool {
    let timeline_len = state.timeline_len();
    if echo_after_row <= timeline_len {
        (echo_after_row..timeline_len).any(|row| {
            state.item_at_row(row).is_some_and(|item| {
                item.role == Some(MessageRole::User) && item.text.as_deref() == Some(text)
            })
        })
    } else {
        state.active_turn().is_some_and(|turn| {
            turn.items.iter().any(|item| {
                item.role == Some(MessageRole::User)
                    && item.text.as_deref() == Some(text)
                    && item.created_at >= created_at - 5_000.0
            })
        })
    }
}

fn design_attachments(mut attachments: Vec<String>, design_mode: bool) -> Vec<String> {
    if design_mode
        && !attachments
            .iter()
            .any(|path| path == DESIGN_BRIEF_ATTACHMENT)
    {
        attachments.push(DESIGN_BRIEF_ATTACHMENT.into());
    }
    attachments
}

fn restored_composer_attachments(paths: Vec<String>) -> Vec<ComposerAttachment> {
    paths
        .into_iter()
        .filter(|path| path != DESIGN_BRIEF_ATTACHMENT)
        .map(ComposerAttachment::file)
        .collect()
}

fn unix_time_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
        * 1_000.0
}

fn composer_dock_offset(
    pending: ComposerDockPending,
    viewport_height: Pixels,
    scale: f32,
    now: Instant,
) -> Pixels {
    let progress = now.saturating_duration_since(pending.started).as_secs_f32()
        / COMPOSER_DOCK_DURATION.as_secs_f32();
    let collapse = crate::theme::web_ease_out(progress.clamp(0.0, 1.0));
    let minimum_height = gpui::px(COMPOSER_MIN_HEIGHT * scale);
    let field_height = pending.field_height + (minimum_height - pending.field_height) * collapse;
    let docked_box_height = field_height + gpui::px(COMPOSER_TOOLS_HEIGHT * scale);
    let docked_origin_y =
        viewport_height - gpui::px(COMPOSER_DOCKED_BOTTOM_PADDING * scale) - docked_box_height;
    pending.box_bounds.origin.y - docked_origin_y
}

fn composer_dock_easing(progress: f32) -> f32 {
    cubic_bezier_timing(progress, 0.4, 0.0, 0.2, 1.0)
}

fn approval_title(kind: ApprovalKind) -> &'static str {
    match kind {
        ApprovalKind::Command => "Run this command?",
        ApprovalKind::FileChange => "Write to your files?",
        ApprovalKind::Permissions => "Grant extra access?",
    }
}

fn review_status(status: ApprovalReviewStatus) -> (&'static str, &'static str) {
    match status {
        ApprovalReviewStatus::InProgress => ("Reviewing access", "icons/loader-circle.svg"),
        ApprovalReviewStatus::Approved => ("Access approved", "icons/shield-check.svg"),
        ApprovalReviewStatus::Denied => ("Access denied", "icons/shield-check.svg"),
        ApprovalReviewStatus::TimedOut => ("Review timed out", "icons/shield-check.svg"),
        ApprovalReviewStatus::Aborted => ("Review aborted", "icons/shield-check.svg"),
    }
}

fn risk_label(risk: RiskLevel) -> &'static str {
    match risk {
        RiskLevel::Low => "Low",
        RiskLevel::Medium => "Medium",
        RiskLevel::High => "High",
        RiskLevel::Critical => "Critical",
    }
}

fn radio_mark(
    id: SharedString,
    active: bool,
    press_group: SharedString,
    theme: Theme,
) -> impl IntoElement {
    let dot_id: SharedString = format!("{id}:dot").into();
    div()
        .id(id)
        .size(px(14.0))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(7.0))
        .border_1()
        .border_color(if active {
            theme.text.hsla()
        } else {
            theme.text_3.hsla()
        })
        .group_active(press_group.clone(), |style| {
            style.size(px(13.79)).rounded(px(6.895))
        })
        .when(active, |radio| {
            radio.child(
                div()
                    .id(dot_id)
                    .size(px(6.0))
                    .rounded(px(3.0))
                    .bg(theme.text.hsla())
                    .group_active(press_group, |style| style.size(px(5.91)).rounded(px(2.955))),
            )
        })
}

const COMPOSER_MIN_HEIGHT: f32 = 68.0;
const COMPOSER_MAX_HEIGHT: f32 = 242.0;
const COMPOSER_TEXT_SIZE: f32 = 14.0;
const COMPOSER_LINE_HEIGHT: f32 = COMPOSER_TEXT_SIZE * 1.55;
const COMPOSER_VERTICAL_PADDING: f32 = 24.0;
const COMPOSER_HORIZONTAL_PADDING: f32 = 36.0;
const COMPOSER_INPUT_RIGHT_MARGIN: f32 = 10.0;

#[derive(IntoElement)]
struct ComposerField {
    input: Entity<InputState>,
    empty: bool,
    interface_font: SharedString,
    theme: Theme,
}

impl RenderOnce for ComposerField {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let state = window.use_keyed_state("composer-field-state", cx, |_window, _cx| {
            ComposerFieldState::new(
                self.input.clone(),
                self.empty,
                self.interface_font.clone(),
                self.theme,
            )
        });
        state.update(cx, |state, cx| {
            state.update_content(self.input, self.empty, self.interface_font, self.theme, cx);
        });
        state
    }
}

struct ComposerFieldState {
    input: Entity<InputState>,
    empty: bool,
    interface_font: SharedString,
    theme: Theme,
    width: Option<Pixels>,
    height_motion: ScalarMotion,
}

impl ComposerFieldState {
    fn new(
        input: Entity<InputState>,
        empty: bool,
        interface_font: SharedString,
        theme: Theme,
    ) -> Self {
        Self {
            input,
            empty,
            interface_font,
            theme,
            width: None,
            height_motion: ScalarMotion::stationary(COMPOSER_MIN_HEIGHT, Instant::now()),
        }
    }

    fn update_content(
        &mut self,
        input: Entity<InputState>,
        empty: bool,
        interface_font: SharedString,
        theme: Theme,
        cx: &mut Context<Self>,
    ) {
        let mut changed = false;
        if self.input != input {
            self.input = input;
            self.width = None;
            changed = true;
        }
        if self.empty != empty {
            self.empty = empty;
            changed = true;
        }
        if self.interface_font != interface_font {
            self.interface_font = interface_font;
            changed = true;
        }
        if self.theme != theme {
            self.theme = theme;
            changed = true;
        }
        if changed {
            cx.notify();
        }
    }

    fn observe_width(&mut self, width: Pixels, cx: &mut Context<Self>) {
        if width > px(0.0) && self.width != Some(width) {
            self.width = Some(width);
            cx.notify();
        }
    }
}

impl Render for ComposerFieldState {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let text = self.input.read(cx).value();
        let target_height = self.width.map_or(COMPOSER_MIN_HEIGHT, |width| {
            composer_height_for_text(&text, width, &self.interface_font, cx)
        });
        let now = Instant::now();
        self.height_motion
            .retarget(target_height, self.theme.motion.fast, false, now);
        let (height, animating) = self.height_motion.sample(now);
        let from = self.height_motion.from;
        let target = self.height_motion.target;
        let duration = self.height_motion.duration;
        let generation = self.height_motion.generation;
        let frame = ComposerFieldFrame {
            input: self.input.clone(),
            empty: self.empty,
            height,
            theme: self.theme,
            observer: cx.weak_entity(),
        };
        if animating {
            frame
                .with_animation(
                    ("composer-field-height", generation),
                    Animation::new(duration).with_easing(crate::theme::web_ease_out),
                    move |mut frame, delta| {
                        frame.height = from + (target - from) * delta;
                        frame
                    },
                )
                .into_any_element()
        } else {
            frame.into_any_element()
        }
    }
}

#[derive(IntoElement)]
struct ComposerFieldFrame {
    input: Entity<InputState>,
    empty: bool,
    height: f32,
    theme: Theme,
    observer: WeakEntity<ComposerFieldState>,
}

impl RenderOnce for ComposerFieldFrame {
    fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let observer = self.observer;
        div()
            .relative()
            .h(px(self.height))
            .overflow_hidden()
            .on_children_prepainted(move |bounds, window, cx| {
                let Some(width) = bounds.first().map(|bounds| bounds.size.width) else {
                    return;
                };
                let observer = observer.clone();
                window.defer(cx, move |_window, cx| {
                    let _ = observer.update(cx, |state, cx| state.observe_width(width, cx));
                });
            })
            .child(
                Input::new(&self.input)
                    .appearance(false)
                    .bordered(false)
                    .focus_bordered(false)
                    .h(px(self.height))
                    .px(px(18.0))
                    .pt(px(16.0))
                    .pb(px(8.0))
                    .text_size(px(COMPOSER_TEXT_SIZE))
                    .line_height(relative(1.55))
                    .text_color(self.theme.text.hsla()),
            )
            .when(self.empty, |input| {
                input.child(
                    div()
                        .absolute()
                        .top(px(16.0))
                        .left(px(18.0))
                        .text_size(px(COMPOSER_TEXT_SIZE))
                        .line_height(relative(1.55))
                        .text_color(self.theme.composer_placeholder.hsla())
                        .child("Do anything"),
                )
            })
    }
}

fn composer_height_for_text(
    text: &str,
    outer_width: Pixels,
    interface_font: &SharedString,
    cx: &App,
) -> f32 {
    let wrap_width = composer_wrap_width(outer_width, crate::zoom::factor());
    let mut line_wrapper = cx
        .text_system()
        .line_wrapper(gpui::font(interface_font.clone()), px(COMPOSER_TEXT_SIZE));
    let lines = text
        .split('\n')
        .map(|line| {
            let fragments = [LineFragment::text(line)];
            let (boundary_count, last_boundary) = line_wrapper
                .wrap_line(&fragments, wrap_width)
                .fold((0, 0), |(count, _), boundary| (count + 1, boundary.ix));
            boundary_count + usize::from(last_boundary == 0 || last_boundary < line.len())
        })
        .sum::<usize>();
    composer_height_for_line_count(lines)
}

fn composer_wrap_width(outer_width: Pixels, scale: f32) -> Pixels {
    let horizontal_chrome = (COMPOSER_HORIZONTAL_PADDING + COMPOSER_INPUT_RIGHT_MARGIN) * scale;
    gpui::px((f32::from(outer_width) - horizontal_chrome).max(scale))
}

fn composer_height_for_line_count(lines: usize) -> f32 {
    (lines.max(2) as f32 * COMPOSER_LINE_HEIGHT + COMPOSER_VERTICAL_PADDING)
        .clamp(COMPOSER_MIN_HEIGHT, COMPOSER_MAX_HEIGHT)
}

fn context_usage(usage: &Usage, theme: Theme) -> AnyElement {
    let context_window = usage.context_window.unwrap_or_default();
    let progress = context_usage_progress(usage.total_tokens, context_window);
    ContextUsage {
        total_tokens: usage.total_tokens,
        context_window,
        progress,
        theme,
    }
    .into_any_element()
}

fn context_usage_progress(total_tokens: f64, context_window: f64) -> f32 {
    if !total_tokens.is_finite() || !context_window.is_finite() || context_window <= 0.0 {
        return 0.0;
    }
    (total_tokens / context_window).clamp(0.0, 1.0) as f32
}

fn format_token_count(value: f64) -> String {
    if !value.is_finite() {
        return "0".into();
    }
    let value = value.max(0.0).round() as u64;
    let digits = value.to_string();
    let mut grouped = String::with_capacity(digits.len() + digits.len() / 3);
    let first_group = digits.len() % 3;
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && index % 3 == first_group {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    grouped
}

#[derive(IntoElement)]
struct ContextUsage {
    total_tokens: f64,
    context_window: f64,
    progress: f32,
    theme: Theme,
}

impl RenderOnce for ContextUsage {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let state = window.use_keyed_state("composer-context-usage", cx, |_window, cx| {
            ContextUsageState::new(
                self.total_tokens,
                self.context_window,
                self.progress,
                self.theme,
                cx,
            )
        });
        state.update(cx, |state, cx| {
            state.update_content(
                self.total_tokens,
                self.context_window,
                self.progress,
                self.theme,
                cx,
            );
        });
        state
    }
}

#[derive(Clone, Copy, Debug)]
struct ScalarMotion {
    from: f32,
    target: f32,
    started: Instant,
    duration: Duration,
    generation: u64,
}

impl ScalarMotion {
    fn stationary(value: f32, now: Instant) -> Self {
        Self {
            from: value,
            target: value,
            started: now,
            duration: Duration::ZERO,
            generation: 0,
        }
    }

    fn sample(self, now: Instant) -> (f32, bool) {
        if self.duration.is_zero() {
            return (self.target, false);
        }
        let progress =
            now.saturating_duration_since(self.started).as_secs_f32() / self.duration.as_secs_f32();
        if progress >= 1.0 {
            return (self.target, false);
        }
        let eased = crate::theme::web_ease_out(progress.clamp(0.0, 1.0));
        (self.from + (self.target - self.from) * eased, true)
    }

    fn retarget(
        &mut self,
        target: f32,
        duration: Duration,
        shorten_to_distance: bool,
        now: Instant,
    ) -> bool {
        if (self.target - target).abs() < f32::EPSILON {
            return false;
        }
        let (current, _) = self.sample(now);
        self.from = current;
        self.target = target;
        self.started = now;
        self.duration = if shorten_to_distance {
            duration.mul_f32((target - current).abs())
        } else {
            duration
        };
        self.generation = self.generation.wrapping_add(1);
        true
    }
}

struct ContextUsageState {
    total_tokens: f64,
    context_window: f64,
    theme: Theme,
    focus: FocusHandle,
    hovered: bool,
    focused: bool,
    ring_motion: ScalarMotion,
    tooltip_motion: ScalarMotion,
}

impl ContextUsageState {
    fn new(
        total_tokens: f64,
        context_window: f64,
        progress: f32,
        theme: Theme,
        cx: &mut Context<Self>,
    ) -> Self {
        let now = Instant::now();
        Self {
            total_tokens,
            context_window,
            theme,
            focus: cx.focus_handle(),
            hovered: false,
            focused: false,
            ring_motion: ScalarMotion::stationary(progress, now),
            tooltip_motion: ScalarMotion::stationary(0.0, now),
        }
    }

    fn update_content(
        &mut self,
        total_tokens: f64,
        context_window: f64,
        progress: f32,
        theme: Theme,
        cx: &mut Context<Self>,
    ) {
        let mut changed = false;
        if self.total_tokens != total_tokens || self.context_window != context_window {
            self.total_tokens = total_tokens;
            self.context_window = context_window;
            changed = true;
        }
        if self.theme != theme {
            self.theme = theme;
            changed = true;
        }
        changed |= self.ring_motion.retarget(
            progress,
            theme.motion_duration(Duration::from_millis(170)),
            false,
            Instant::now(),
        );
        if changed {
            cx.notify();
        }
    }

    fn hover_changed(&mut self, hovered: bool, cx: &mut Context<Self>) {
        if self.hovered != hovered {
            self.hovered = hovered;
            self.sync_tooltip(cx);
        }
    }

    fn focus_changed(&mut self, focused: bool, cx: &mut Context<Self>) {
        if self.focused != focused {
            self.focused = focused;
            self.sync_tooltip(cx);
        }
    }

    fn sync_tooltip(&mut self, cx: &mut Context<Self>) {
        if self.tooltip_motion.retarget(
            f32::from(self.hovered || self.focused),
            self.theme.motion.fast,
            true,
            Instant::now(),
        ) {
            cx.notify();
        }
    }
}

impl Focusable for ContextUsageState {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for ContextUsageState {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.focus.is_focused(window) != self.focused {
            self.focus_changed(self.focus.is_focused(window), cx);
        }
        let theme = self.theme;
        let (ring_progress, ring_animating) = self.ring_motion.sample(Instant::now());
        let ring_from = self.ring_motion.from;
        let ring_target = self.ring_motion.target;
        let ring_duration = self.ring_motion.duration;
        let ring_generation = self.ring_motion.generation;
        let ring = ContextUsageRing {
            progress: ring_progress,
            theme,
        };
        let ring = if ring_animating {
            ring.with_animation(
                ("context-usage-ring", ring_generation),
                Animation::new(ring_duration).with_easing(crate::theme::web_ease_out),
                move |mut ring, delta| {
                    ring.progress = ring_from + (ring_target - ring_from) * delta;
                    ring
                },
            )
            .into_any_element()
        } else {
            ring.into_any_element()
        };

        let (tooltip_progress, tooltip_animating) = self.tooltip_motion.sample(Instant::now());
        let tooltip_from = self.tooltip_motion.from;
        let tooltip_target = self.tooltip_motion.target;
        let tooltip_duration = self.tooltip_motion.duration;
        let tooltip_generation = self.tooltip_motion.generation;
        let percent = (self.ring_motion.target * 100.0).round() as u8;
        let bubble = div()
            .id("context-usage-tooltip")
            .absolute()
            .right_0()
            .bottom(px(34.0 - 3.0 * (1.0 - tooltip_progress)))
            .grid()
            .gap(px(2.0))
            .max_w(px(230.0))
            .px(px(10.0))
            .py(px(8.0))
            .rounded(px(5.0))
            .border_1()
            .border_color(theme.line_strong.hsla())
            .bg(theme.surface_3.hsla())
            .shadow(chrome::flyout_shadows(theme))
            .text_size(px(11.5))
            .text_color(theme.text_3.hsla())
            .opacity(tooltip_progress)
            .child(
                div()
                    .text_size(px(12.5))
                    .font_weight(FontWeight(550.0))
                    .text_color(theme.text.hsla())
                    .child(format!("{percent}% context used")),
            )
            .child(format!(
                "{} / {} tokens",
                format_token_count(self.total_tokens),
                format_token_count(self.context_window)
            ))
            .when(tooltip_animating || tooltip_target > 0.0, |bubble| {
                bubble.on_hover(cx.listener(|this, hovered, _window, cx| {
                    this.hover_changed(*hovered, cx);
                }))
            });
        let bubble = if tooltip_animating {
            bubble
                .with_animation(
                    ("context-usage-tooltip-in", tooltip_generation),
                    Animation::new(tooltip_duration).with_easing(crate::theme::web_ease_out),
                    move |bubble, delta| {
                        let progress = tooltip_from + (tooltip_target - tooltip_from) * delta;
                        bubble
                            .bottom(px(34.0 - 3.0 * (1.0 - progress)))
                            .opacity(progress)
                    },
                )
                .into_any_element()
        } else {
            bubble.into_any_element()
        };

        div()
            .id("context-usage")
            .relative()
            .size(px(26.0))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .rounded_full()
            .track_focus(&self.focus)
            .tab_index(0)
            .on_hover(cx.listener(|this, hovered, _window, cx| {
                this.hover_changed(*hovered, cx);
            }))
            .when(self.focus.is_focused(window), |usage| {
                usage.child(
                    div()
                        .absolute()
                        .inset(px(-3.0))
                        .rounded_full()
                        .border_2()
                        .border_color(theme.text_2.hsla()),
                )
            })
            .child(ring)
            .child(deferred(bubble).with_priority(40))
    }
}

#[derive(IntoElement)]
struct ContextUsageRing {
    progress: f32,
    theme: Theme,
}

impl RenderOnce for ContextUsageRing {
    fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
        canvas(
            |_, _, _| {},
            move |bounds, _, window, _| {
                paint_context_usage_ring(bounds, self.progress, self.theme, window);
            },
        )
        .size(px(22.0))
    }
}

fn paint_context_usage_ring(
    bounds: Bounds<Pixels>,
    progress: f32,
    theme: Theme,
    window: &mut Window,
) {
    const RADIUS: f32 = 9.0;
    const STROKE: f32 = 2.25;
    let center = bounds.center();
    if let Some(track) = context_ring_path(center, RADIUS, 1.0, STROKE) {
        window.paint_path(track, theme.line_strong.hsla());
    }
    let progress = progress.clamp(0.0, 1.0);
    if progress <= 0.0001 {
        return;
    }
    if let Some(fill_path) = context_ring_path(center, RADIUS, progress, STROKE) {
        window.paint_path(fill_path, theme.text_2.hsla());
    }
    if progress < 0.9999 {
        let start = point(center.x, center.y - px(RADIUS));
        let angle = -std::f32::consts::FRAC_PI_2 + std::f32::consts::TAU * progress;
        let end = point(
            center.x + px(RADIUS * angle.cos()),
            center.y + px(RADIUS * angle.sin()),
        );
        paint_context_ring_cap(start, STROKE, theme.text_2.hsla(), window);
        paint_context_ring_cap(end, STROKE, theme.text_2.hsla(), window);
    }
}

fn context_ring_path(
    center: Point<Pixels>,
    radius: f32,
    progress: f32,
    stroke: f32,
) -> Option<gpui::Path<Pixels>> {
    let progress = progress.clamp(0.0, 1.0);
    if progress <= 0.0001 {
        return None;
    }
    let radii = point(px(radius), px(radius));
    let start = point(center.x, center.y - px(radius));
    let mut builder = PathBuilder::stroke(px(stroke));
    builder.move_to(start);
    if progress >= 0.9999 {
        let bottom = point(center.x, center.y + px(radius));
        builder.arc_to(radii, px(0.0), false, true, bottom);
        builder.arc_to(radii, px(0.0), false, true, start);
    } else {
        let angle = -std::f32::consts::FRAC_PI_2 + std::f32::consts::TAU * progress;
        builder.arc_to(
            radii,
            px(0.0),
            progress > 0.5,
            true,
            point(
                center.x + px(radius * angle.cos()),
                center.y + px(radius * angle.sin()),
            ),
        );
    }
    builder.build().ok()
}

fn paint_context_ring_cap(
    center: Point<Pixels>,
    diameter: f32,
    color: gpui::Hsla,
    window: &mut Window,
) {
    window.paint_quad(
        fill(
            Bounds {
                origin: point(center.x - px(diameter / 2.0), center.y - px(diameter / 2.0)),
                size: size(px(diameter), px(diameter)),
            },
            color,
        )
        .corner_radii(px(diameter / 2.0)),
    );
}

fn approval_action_button(
    id: usize,
    label: &'static str,
    filled: bool,
    push_right: bool,
    theme: Theme,
    action: Option<UiAction>,
) -> impl IntoElement {
    let enabled = action.is_some();
    let height = if filled { 33.0 } else { 27.0 };
    let padding = if filled { 15.0 } else { 8.0 };
    let radius = if filled { 5.0 } else { 3.0 };
    let font_size = if filled { 13.5 } else { 12.5 };
    let group: SharedString = format!("approval-action-{id}:press").into();
    let sizing = div()
        .h(px(height))
        .px(px(padding))
        .flex()
        .items_center()
        .justify_center()
        .text_size(px(font_size))
        .font_weight(if filled {
            FontWeight(540.0)
        } else {
            FontWeight::NORMAL
        })
        .invisible()
        .child(label);
    let visual = div()
        .id(("approval-action-visual", id))
        .absolute()
        .inset_0()
        .px(px(padding))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(radius))
        .bg(if filled {
            theme.text.hsla()
        } else {
            gpui::transparent_black()
        })
        .text_size(px(font_size))
        .font_weight(if filled {
            FontWeight(540.0)
        } else {
            FontWeight::NORMAL
        })
        .text_color(if filled {
            theme.background.hsla()
        } else {
            theme.text_2.hsla()
        })
        .when(enabled, |button| {
            button
                .group_hover(group.clone(), move |style| {
                    style
                        .bg(if filled {
                            theme.text.hsla()
                        } else {
                            theme.surface_3.hsla()
                        })
                        .text_color(if filled {
                            theme.background.hsla()
                        } else {
                            theme.text.hsla()
                        })
                })
                .when(filled, |button| {
                    button.group_active(group.clone(), move |style| {
                        style
                            .top(px(height * 0.015))
                            .right(relative(0.015))
                            .bottom(px(height * 0.015))
                            .left(relative(0.015))
                            .px(px(padding * 0.97))
                            .rounded(px(radius * 0.97))
                            .text_size(px(font_size * 0.97))
                    })
                })
        });
    div()
        .id(("approval-action", id))
        .group(group)
        .relative()
        .h(px(height))
        .flex_none()
        .when(push_right, |button| button.ml_auto())
        .opacity(if enabled {
            1.0
        } else if filled {
            0.28
        } else {
            0.46
        })
        .when(enabled, |button| button.cursor_pointer())
        .when_some(action, |button, action| {
            button.on_click(move |_event, _window, cx| action(cx))
        })
        .child(sizing)
        .child(visual)
}

fn input_nav_button(
    id: &'static str,
    label: &'static str,
    primary: bool,
    theme: Theme,
    action: Option<UiAction>,
) -> impl IntoElement {
    let enabled = action.is_some();
    let group: SharedString = format!("{id}:press").into();
    let visual_id: SharedString = format!("{id}:visual").into();
    let resting_inset_id: SharedString = format!("{id}:resting-inset").into();
    let pressed_inset_id: SharedString = format!("{id}:pressed-inset").into();
    let border = if primary && enabled {
        brief_primary_color(theme).opacity(0.54)
    } else {
        theme.line_strong.hsla().opacity(0.7)
    };
    let text_color = if primary && enabled {
        brief_on_primary_color(theme)
    } else {
        theme.text_2.hsla()
    };
    let shadow = vec![BoxShadow {
        color: gpui::black().opacity(if primary && enabled { 0.28 } else { 0.18 }),
        offset: point(px(0.0), px(1.0)),
        blur_radius: px(if primary && enabled { 2.0 } else { 1.0 }),
        spread_radius: px(0.0),
    }];
    let sizing = div()
        .min_w(px(58.0))
        .h(px(32.0))
        .px(px(11.0))
        .flex()
        .items_center()
        .justify_center()
        .text_size(px(12.5))
        .font_weight(FontWeight(570.0))
        .invisible()
        .child(label);
    let visual = div()
        .id(visual_id)
        .absolute()
        .inset_0()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(5.0))
        .overflow_hidden()
        .border_1()
        .border_color(border)
        .bg(brief_action_background(theme, primary && enabled))
        .shadow(shadow)
        .text_size(px(12.5))
        .font_weight(FontWeight(570.0))
        .text_color(text_color)
        .when(enabled, |button| {
            button.group_active(group.clone(), |style| {
                style
                    .top(px(0.48))
                    .right(relative(0.015))
                    .bottom(px(0.48))
                    .left(relative(0.015))
                    .rounded(px(4.85))
                    .shadow(Vec::new())
                    .text_size(px(12.125))
            })
        })
        .child(
            div()
                .id(resting_inset_id)
                .absolute()
                .top_0()
                .left_0()
                .right_0()
                .h(px(1.0))
                .bg(gpui::white().opacity(if primary && enabled { 1.0 } else { 0.09 }))
                .when(enabled, |inset| {
                    inset.group_active(group.clone(), |style| style.opacity(0.0))
                }),
        )
        .child(
            brief_inset_top_shadow(0.24)
                .id(pressed_inset_id)
                .opacity(0.0)
                .when(enabled, |inset| {
                    inset.group_active(group.clone(), |style| style.opacity(1.0))
                }),
        )
        .child(label);
    div()
        .id(id)
        .group(group)
        .relative()
        .min_w(px(58.0))
        .h(px(32.0))
        .flex_none()
        .opacity(if enabled { 1.0 } else { 0.38 })
        .when(enabled, |button| button.cursor_pointer())
        .when_some(action, |button, action| {
            button.on_click(move |_event, _window, cx| action(cx))
        })
        .child(sizing)
        .child(visual)
}

fn brief_entry_margin(gap: f32, delta: f32) -> f32 {
    gap - BRIEF_ENTRY_OFFSET * (1.0 - delta)
}

#[allow(clippy::too_many_arguments)]
fn composer_menu_placement(
    composer: Option<Bounds<Pixels>>,
    trigger: Option<Bounds<Pixels>>,
    viewport_width: Pixels,
    viewport_height: Pixels,
    panel_width: Pixels,
    panel_height: Pixels,
    alignment: ComposerMenuAlignment,
    preferred_drop: ComposerMenuDrop,
) -> Option<ComposerMenuPlacement> {
    let composer = composer?;
    let trigger = trigger?;
    let trigger_right = trigger.origin.x + trigger.size.width;
    let (preferred_left, translate_x) = match alignment {
        ComposerMenuAlignment::Left => (trigger.origin.x, px(0.0)),
        ComposerMenuAlignment::RightShiftedLeft(shift) => (trigger_right - panel_width, -px(shift)),
    };
    let gutter = px(COMPOSER_MENU_VIEWPORT_GUTTER);
    let gap = px(COMPOSER_MENU_GAP);
    let max_left = (viewport_width - panel_width - gutter).max(gutter);
    let left = preferred_left.clamp(gutter, max_left) + translate_x;
    let trigger_bottom = trigger.origin.y + trigger.size.height;
    let space_above = trigger.origin.y - gap - gutter;
    let space_below = viewport_height - trigger_bottom - gap - gutter;
    let drop = match preferred_drop {
        ComposerMenuDrop::Down if panel_height > space_below && space_above > space_below => {
            ComposerMenuDrop::Up
        }
        ComposerMenuDrop::Up if panel_height > space_above && space_below > space_above => {
            ComposerMenuDrop::Down
        }
        drop => drop,
    };
    let preferred_top = match drop {
        ComposerMenuDrop::Up => trigger.origin.y - gap - panel_height,
        ComposerMenuDrop::Down => trigger_bottom + gap,
    };
    let max_top = (viewport_height - panel_height - gutter).max(gutter);
    let top = preferred_top.clamp(gutter, max_top);
    let composer_bottom = composer.origin.y + composer.size.height;
    Some(ComposerMenuPlacement {
        left: left - composer.origin.x,
        vertical: match drop {
            ComposerMenuDrop::Up => composer_bottom - top - panel_height,
            ComposerMenuDrop::Down => top - composer.origin.y,
        },
        drop,
    })
}

fn composer_menu_width(design_width: f32, viewport_width: Pixels) -> Pixels {
    px(design_width).min((viewport_width - px(COMPOSER_MENU_VIEWPORT_GUTTER * 2.0)).max(px(0.0)))
}

fn composer_menu_max_height(viewport_height: Pixels) -> Pixels {
    px(COMPOSER_MENU_MAX_HEIGHT)
        .min((viewport_height - px(COMPOSER_MENU_VIEWPORT_GUTTER * 2.0)).max(px(0.0)))
}

fn composer_stacked_menu_height(
    row_count: usize,
    row_height: f32,
    viewport_height: Pixels,
) -> Pixels {
    px(row_count as f32 * row_height + 10.0).min(composer_menu_max_height(viewport_height))
}

fn brief_option_background(theme: Theme, selected: bool, hovered: bool) -> Background {
    if selected {
        return theme.surface_3.hsla().into();
    }
    let (top, bottom) = if hovered { (0.72, 0.50) } else { (0.50, 0.32) };
    linear_gradient(
        180.0,
        linear_color_stop(theme.surface_3.hsla().opacity(top), 0.0),
        linear_color_stop(theme.surface_2.hsla().opacity(bottom), 1.0),
    )
}

fn brief_option_outer_shadows(selected: bool) -> Vec<BoxShadow> {
    if selected {
        Vec::new()
    } else {
        vec![BoxShadow {
            color: gpui::black().opacity(0.16),
            offset: point(px(0.0), px(1.0)),
            blur_radius: px(1.0),
            spread_radius: px(0.0),
        }]
    }
}

fn brief_option_inset(selected: bool, press_group: SharedString) -> AnyElement {
    let resting = if selected {
        brief_inset_top_shadow(0.18)
    } else {
        div()
            .absolute()
            .top_0()
            .left_0()
            .right_0()
            .h(px(1.0))
            .bg(gpui::white().opacity(0.08))
    };
    div()
        .absolute()
        .inset_0()
        .child(
            div()
                .id("resting-inset")
                .absolute()
                .inset_0()
                .group_active(press_group.clone(), |style| style.opacity(0.0))
                .child(resting),
        )
        .when(selected, |inset| {
            inset.child(
                div()
                    .id("selected-inset-stroke")
                    .absolute()
                    .inset_0()
                    .rounded(px(4.0))
                    .border_1()
                    .border_color(gpui::white().opacity(0.04))
                    .group_active(press_group.clone(), |style| style.opacity(0.0)),
            )
        })
        .child(
            brief_inset_top_shadow(0.25)
                .id("pressed-inset")
                .opacity(0.0)
                .group_active(press_group.clone(), |style| style.opacity(1.0)),
        )
        .into_any_element()
}

fn brief_inset_top_shadow(opacity: f32) -> gpui::Div {
    div()
        .absolute()
        .top_0()
        .left_0()
        .right_0()
        .h(px(4.0))
        .bg(linear_gradient(
            180.0,
            linear_color_stop(gpui::black().opacity(opacity), 0.0),
            linear_color_stop(gpui::transparent_black(), 1.0),
        ))
}

fn brief_action_background(theme: Theme, primary: bool) -> Background {
    if primary {
        let top = brief_primary_color(theme);
        let bottom = theme.surface_3.hsla().blend(top.opacity(0.82));
        return linear_gradient(
            180.0,
            linear_color_stop(top, 0.0),
            linear_color_stop(bottom, 1.0),
        );
    }
    linear_gradient(
        180.0,
        linear_color_stop(theme.surface_3.hsla().opacity(0.58), 0.0),
        linear_color_stop(theme.surface_2.hsla().opacity(0.38), 1.0),
    )
}

fn brief_primary_color(theme: Theme) -> gpui::Hsla {
    if theme.mode == ThemeMode::Dark {
        gpui::white()
    } else {
        theme.text.hsla()
    }
}

fn brief_on_primary_color(theme: Theme) -> gpui::Hsla {
    if theme.mode == ThemeMode::Dark {
        gpui::rgb(0x101010).into()
    } else {
        gpui::white()
    }
}

fn brief_flyout_shadows(theme: Theme) -> Vec<BoxShadow> {
    if theme.mode == ThemeMode::Dark {
        vec![BoxShadow {
            color: gpui::black().opacity(0.46),
            offset: point(px(0.0), px(8.0)),
            blur_radius: px(24.0),
            spread_radius: px(-14.0),
        }]
    } else {
        vec![
            BoxShadow {
                color: gpui::black().opacity(0.05),
                offset: point(px(0.0), px(1.0)),
                blur_radius: px(2.0),
                spread_radius: px(0.0),
            },
            BoxShadow {
                color: gpui::black().opacity(0.18),
                offset: point(px(0.0), px(10.0)),
                blur_radius: px(28.0),
                spread_radius: px(-18.0),
            },
        ]
    }
}

fn model_picker_source_key(choice: &ModelChoice) -> String {
    format!("{}:{}", source_key(choice), choice.source_name)
}

fn group_models_by_source(models: &[ModelChoice]) -> Vec<ModelSourceGroup> {
    let mut groups = Vec::<ModelSourceGroup>::new();
    for choice in models.iter().cloned() {
        let key = model_picker_source_key(&choice);
        if let Some(group) = groups.iter_mut().find(|group| group.key == key) {
            group.entries.push(choice);
        } else {
            groups.push(ModelSourceGroup {
                key,
                name: choice.source_name.clone(),
                provider: choice.provider,
                entries: vec![choice],
            });
        }
    }
    groups
}

fn icon_tool_button(
    id: &'static str,
    icon_path: &'static str,
    label: Option<&'static str>,
    active: bool,
    theme: Theme,
    action: Option<UiAction>,
) -> impl IntoElement {
    let hover_group: SharedString = format!("{id}:hover").into();
    let icon_id: SharedString = format!("{id}:icon").into();
    let icon_press_id: SharedString = format!("{id}:icon-press").into();
    let icon_size = if label.is_some() { 13.0 } else { 15.0 };
    let background = if theme.mode == ThemeMode::Dark {
        theme.surface_3.hsla()
    } else {
        theme.prompt.hsla()
    };
    div()
        .id(id)
        .group(hover_group.clone())
        .min_h(px(34.0))
        .min_w(px(34.0))
        .px(px(if label.is_some() { 12.0 } else { 0.0 }))
        .py(px(if label.is_some() { 5.0 } else { 0.0 }))
        .flex()
        .items_center()
        .justify_center()
        .gap(px(6.0))
        .rounded(px(RADIUS_XL))
        .border_1()
        .border_color(if active {
            theme.text_3.hsla().opacity(0.8)
        } else {
            theme.line_strong.hsla()
        })
        .bg(background)
        .shadow_sm()
        .text_size(px(13.5))
        .text_color(if active {
            theme.text.hsla()
        } else {
            theme.text_2.hsla()
        })
        .cursor_pointer()
        .hover(move |style| {
            style
                .bg(if theme.mode == ThemeMode::Dark {
                    theme.surface_3.hsla()
                } else {
                    theme.surface.hsla()
                })
                .border_color(theme.text_3.hsla().opacity(0.72))
                .text_color(theme.text.hsla())
        })
        .active(move |style| {
            if label.is_none() {
                style.size(px(32.98)).m(px(0.51))
            } else {
                style
                    .min_h(px(32.98))
                    .px(px(11.64))
                    .py(px(4.85))
                    .gap(px(5.82))
                    .rounded(px(RADIUS_XL * 0.97))
                    .text_size(px(13.095))
            }
        })
        .when_some(action, |button, action| {
            button.on_click(move |_event, _window, cx| action(cx))
        })
        .child(
            div()
                .id(icon_press_id)
                .size(px(icon_size))
                .group_active(hover_group.clone(), move |style| {
                    style.size(px(icon_size * 0.97))
                })
                .child(motion_icon(icon_id, icon_path, icon_size, hover_group, theme).size_full()),
        )
        .when_some(label, |button, label| button.child(label))
}

fn composer_primary_icon(
    show_stop: bool,
    stopping: bool,
    sending: bool,
    send_motion_generation: u64,
    interactive: bool,
    action_group: SharedString,
    theme: Theme,
) -> AnyElement {
    if show_stop {
        let icon = motion_icon(
            "composer-primary-icon",
            "icons/square.svg",
            9.0,
            action_group.clone(),
            theme,
        )
        .size_full()
        .flex_none();
        let icon = if stopping {
            icon.with_animation(
                "composer-stopping",
                theme.repeating_animation(Duration::from_millis(900)),
                |icon, delta| {
                    let pulse = (std::f32::consts::PI * delta).sin();
                    let scale = 1.0 - 0.14 * pulse;
                    icon.opacity(1.0 - 0.55 * pulse)
                        .with_transformation(IconTransformation::scale(scale))
                },
            )
            .into_any_element()
        } else {
            icon.with_animation(
                "composer-stop-icon-in",
                Animation::new(theme.motion_duration(Duration::from_millis(150)))
                    .with_easing(crate::theme::web_ease_out),
                |icon, delta| {
                    let scale = 0.55 + 0.45 * delta;
                    icon.opacity(delta).with_transformation(
                        IconTransformation::scale(scale).with_rotation(-18.0 * (1.0 - delta)),
                    )
                },
            )
            .into_any_element()
        };
        div()
            .id("composer-primary-icon-press")
            .size(px(9.0))
            .when(interactive, |icon| {
                icon.group_hover(action_group.clone(), |style| {
                    style.size(px(9.45)).m(px(-0.225))
                })
                .group_active(action_group, |style| style.size(px(8.28)).m(px(0.36)))
            })
            .child(icon)
            .into_any_element()
    } else {
        let icon = motion_icon(
            "composer-primary-icon",
            "icons/arrow-up.svg",
            15.0,
            "composer-primary-action-hover",
            theme,
        )
        .flex_none();
        let icon = if sending {
            icon.with_animation(
                ("composer-send-motion", send_motion_generation),
                Animation::new(theme.motion_duration(Duration::from_millis(180))),
                |icon, delta| {
                    let pulse = (std::f32::consts::PI * delta).sin();
                    let scale = 1.0 - 0.06 * pulse;
                    icon.with_transformation(
                        IconTransformation::scale(scale).with_translation(0.0, -2.0 * pulse),
                    )
                },
            )
            .into_any_element()
        } else {
            icon.with_animation(
                "composer-send-icon-in",
                Animation::new(theme.motion_duration(Duration::from_millis(150)))
                    .with_easing(crate::theme::web_ease_out),
                |icon, delta| {
                    let scale = 0.72 + 0.28 * delta;
                    icon.opacity(delta).with_transformation(
                        IconTransformation::scale(scale)
                            .with_translation(0.0, -6.0 * (1.0 - delta)),
                    )
                },
            )
            .into_any_element()
        };
        div()
            .id("composer-primary-icon-hover-scale")
            .size(px(15.0))
            .when(interactive, |icon| {
                icon.group_hover(action_group, |style| style.size(px(15.75)).m(px(-0.375)))
            })
            .child(icon)
            .into_any_element()
    }
}

#[derive(Clone, Copy)]
enum ComposerBeamVariant {
    Colorful,
    Ocean,
}

impl ComposerBeamVariant {
    fn palette(self) -> &'static [u32] {
        match self {
            Self::Colorful => &[
                0xff3264, 0x288cff, 0x32c850, 0x1eb9aa, 0x6446ff, 0x287cff, 0xff7828, 0xf032b4,
                0xb428f0,
            ],
            Self::Ocean => &[
                0x6450dc, 0x3c78ff, 0x5064c8, 0x328cdc, 0x7850ff, 0x4682ff, 0x8c64f0, 0x5a6ee6,
                0x8246ff,
            ],
        }
    }
}

fn composer_beam(
    id: &'static str,
    radius: f32,
    theme: Theme,
    opacity: f32,
    duration: Duration,
    variant: ComposerBeamVariant,
) -> AnyElement {
    div()
        .absolute()
        .inset(px(-1.0))
        .rounded(px(radius + 1.0))
        .opacity(opacity)
        .with_animation(
            id,
            theme.repeating_animation(duration),
            move |beam, delta| {
                let from = palette_color(variant.palette(), delta);
                let to = palette_color(variant.palette(), (delta + 0.34).fract());
                let glow = palette_color(variant.palette(), (delta + 0.12).fract());
                beam.bg(linear_gradient(
                    delta * 360.0,
                    linear_color_stop(from, 0.0),
                    linear_color_stop(to, 1.0),
                ))
                .shadow(vec![BoxShadow {
                    color: glow.opacity(0.16 * opacity),
                    offset: point(px(0.0), px(0.0)),
                    blur_radius: px(9.0),
                    spread_radius: px(0.0),
                }])
            },
        )
        .into_any_element()
}

fn palette_color(palette: &[u32], progress: f32) -> gpui::Hsla {
    let progress = progress.rem_euclid(1.0);
    let scaled = progress * palette.len() as f32;
    let index = scaled.floor() as usize % palette.len();
    let next = (index + 1) % palette.len();
    mix_color(
        gpui::rgb(palette[index]).into(),
        gpui::rgb(palette[next]).into(),
        scaled.fract(),
    )
}

fn mix_color(from: gpui::Hsla, to: gpui::Hsla, amount: f32) -> gpui::Hsla {
    let from = Rgba::from(from);
    let to = Rgba::from(to);
    let amount = amount.clamp(0.0, 1.0);
    Rgba {
        r: from.r + (to.r - from.r) * amount,
        g: from.g + (to.g - from.g) * amount,
        b: from.b + (to.b - from.b) * amount,
        a: from.a + (to.a - from.a) * amount,
    }
    .into()
}

fn design_shimmer_label(progress: f32) -> StyledText {
    const LABEL: &str = "Design";
    const COLORS: [u32; 4] = [0xb9a7ff, 0x87c7d8, 0xe2a6bc, 0xb9a7ff];
    StyledText::new(LABEL).with_highlights((0..LABEL.len()).map(|index| {
        let position = (progress + index as f32 / LABEL.len() as f32 * 0.46).fract();
        (
            index..index + 1,
            HighlightStyle {
                color: Some(palette_color(&COLORS, position)),
                ..HighlightStyle::default()
            },
        )
    }))
}

fn model_picker_background(theme: Theme) -> Background {
    if theme.mode == ThemeMode::Dark {
        theme.surface_2.hsla().into()
    } else {
        chrome::menu_background(theme)
    }
}

fn model_picker_controls_background(theme: Theme) -> Background {
    if theme.mode == ThemeMode::Light {
        linear_gradient(
            180.0,
            linear_color_stop(gpui::rgb(0xfafafa), 0.0),
            linear_color_stop(gpui::rgb(0xf6f6f7), 1.0),
        )
    } else {
        gpui::transparent_black().into()
    }
}

fn model_picker_border(theme: Theme) -> gpui::Hsla {
    chrome::menu_border(theme)
}

fn model_picker_selected_background(theme: Theme) -> Background {
    if theme.mode == ThemeMode::Dark {
        linear_gradient(
            180.0,
            linear_color_stop(theme.surface_3.hsla().opacity(0.92), 0.0),
            linear_color_stop(theme.surface.hsla().opacity(0.56), 1.0),
        )
    } else {
        linear_gradient(
            180.0,
            linear_color_stop(gpui::white(), 0.0),
            linear_color_stop(gpui::rgb(0xf5f5f6), 1.0),
        )
    }
}

fn model_picker_hover_background(theme: Theme) -> Background {
    if theme.mode == ThemeMode::Dark {
        theme.surface_3.hsla().into()
    } else {
        linear_gradient(
            180.0,
            linear_color_stop(gpui::white(), 0.0),
            linear_color_stop(gpui::rgb(0xfafafa), 1.0),
        )
    }
}

fn model_picker_selected_shadows(theme: Theme) -> Vec<BoxShadow> {
    if theme.mode == ThemeMode::Dark {
        Vec::new()
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

fn fast_toggle_background(theme: Theme, fast: bool) -> Background {
    if fast {
        if theme.mode == ThemeMode::Dark {
            theme.text.mix_oklab(theme.surface_3, 0.15).hsla().into()
        } else {
            gpui::rgb(0xf3f3f5).into()
        }
    } else if theme.mode == ThemeMode::Dark {
        linear_gradient(
            180.0,
            linear_color_stop(
                mix_color(theme.surface_2.hsla(), theme.surface_3.hsla(), 0.78),
                0.0,
            ),
            linear_color_stop(
                mix_color(theme.surface_2.hsla(), theme.surface.hsla(), 0.44),
                1.0,
            ),
        )
    } else {
        linear_gradient(
            180.0,
            linear_color_stop(gpui::white(), 0.0),
            linear_color_stop(theme.surface.hsla(), 1.0),
        )
    }
}

fn fast_toggle_border(theme: Theme, fast: bool) -> gpui::Hsla {
    match (theme.mode, fast) {
        (ThemeMode::Dark, true) => theme.text.mix_oklab(theme.line_strong, 0.28).hsla(),
        (ThemeMode::Dark, false) => theme.line_strong.hsla().opacity(0.8),
        (ThemeMode::Light, true) => theme.line_strong.hsla(),
        (ThemeMode::Light, false) => gpui::rgb(0xe3e3e6).into(),
    }
}

fn fast_toggle_hover_background(theme: Theme) -> Background {
    if theme.mode == ThemeMode::Dark {
        theme.surface_3.hsla().into()
    } else {
        fast_toggle_background(theme, false)
    }
}

fn fast_toggle_shadows(theme: Theme) -> Vec<BoxShadow> {
    vec![BoxShadow {
        color: gpui::black().opacity(if theme.mode == ThemeMode::Dark {
            0.20
        } else {
            0.08
        }),
        offset: point(px(0.0), px(1.0)),
        blur_radius: px(2.0),
        spread_radius: px(0.0),
    }]
}

fn fast_toggle_icon(fast: bool, hover_group: &'static str, theme: Theme) -> AnyElement {
    let icon = div()
        .id("model-fast-toggle-icon-press")
        .size(px(15.0))
        .group_active(hover_group, |style| style.size(px(14.55)).m(px(0.225)))
        .flex()
        .items_center()
        .justify_center()
        .child(
            motion_icon(
                "model-fast-toggle-icon",
                if fast {
                    "icons/zap-filled.svg"
                } else {
                    "icons/zap.svg"
                },
                15.0,
                hover_group,
                theme,
            )
            .size_full(),
        );
    if fast {
        icon.with_animation(
            "model-fast-bolt-on",
            Animation::new(theme.motion_duration(Duration::from_millis(320))),
            move |icon, delta| {
                let scale = fast_bolt_on_scale(delta);
                let glow = (1.0 - ((delta - 0.48) / 0.48).abs()).clamp(0.0, 1.0);
                icon.size(px(15.0 * scale)).shadow(vec![BoxShadow {
                    color: theme.text.hsla().opacity(0.34 * glow),
                    offset: point(px(0.0), px(0.0)),
                    blur_radius: px(5.0 * glow),
                    spread_radius: px(0.0),
                }])
            },
        )
        .into_any_element()
    } else {
        icon.with_animation(
            "model-fast-bolt-off",
            Animation::new(theme.motion_duration(Duration::from_millis(260))),
            |icon, delta| {
                let (scale, opacity) = fast_bolt_off_state(delta);
                icon.size(px(15.0 * scale)).opacity(opacity)
            },
        )
        .into_any_element()
    }
}

fn fast_bolt_on_scale(progress: f32) -> f32 {
    if progress <= 0.48 {
        let local = cubic_bezier_timing(progress / 0.48, 0.2, 1.6, 0.4, 1.0);
        0.7 + (1.25 - 0.7) * local
    } else {
        let local = cubic_bezier_timing((progress - 0.48) / 0.52, 0.2, 1.6, 0.4, 1.0);
        1.25 + (1.0 - 1.25) * local
    }
}

fn fast_bolt_off_state(progress: f32) -> (f32, f32) {
    if progress <= 0.45 {
        let local = crate::theme::web_ease_out(progress / 0.45);
        (1.0 + (0.78 - 1.0) * local, 1.0 + (0.55 - 1.0) * local)
    } else {
        let local = crate::theme::web_ease_out((progress - 0.45) / 0.55);
        (0.78 + (1.0 - 0.78) * local, 0.55 + (1.0 - 0.55) * local)
    }
}

type UiAction = Rc<dyn Fn(&mut App)>;

fn approval_meta(approval: ApprovalMode) -> (&'static str, &'static str) {
    match approval {
        ApprovalMode::Ask => ("icons/shield-question.svg", "Ask first"),
        ApprovalMode::Auto => ("icons/shield-check.svg", "Auto"),
        ApprovalMode::AutoReview => ("icons/scan-eye.svg", "Auto-review"),
        ApprovalMode::Full => ("icons/lock-open.svg", "Full access"),
    }
}

fn approval_semantic_color(approval: ApprovalMode, theme: Theme) -> Option<gpui::Hsla> {
    match approval {
        ApprovalMode::AutoReview => Some(theme.composer_review.hsla()),
        ApprovalMode::Full => Some(theme.composer_danger.hsla()),
        ApprovalMode::Ask | ApprovalMode::Auto => None,
    }
}

fn selected_reasoning_effort<'a>(
    model: &'a harness_protocol::Model,
    current: Option<&'a str>,
) -> Option<&'a str> {
    current
        .filter(|effort| {
            model
                .reasoning_efforts
                .iter()
                .any(|candidate| candidate == effort)
        })
        .or_else(|| {
            model.default_reasoning_effort.as_deref().filter(|effort| {
                model
                    .reasoning_efforts
                    .iter()
                    .any(|candidate| candidate == effort)
            })
        })
        .or_else(|| model.reasoning_efforts.first().map(String::as_str))
}

fn friendly_effort_label(value: Option<&str>) -> String {
    let Some(value) = value.filter(|value| !value.is_empty()) else {
        return "Default".into();
    };
    value
        .split(['_', '-'])
        .filter(|word| !word.is_empty())
        .flat_map(|word| {
            let mut labels = Vec::with_capacity(2);
            if word.len() > 1
                && word.starts_with(['x', 'X'])
                && word.as_bytes()[1].is_ascii_alphabetic()
            {
                labels.push("Extra".into());
                labels.push(title_case(&word[1..]));
            } else {
                labels.push(title_case(word));
            }
            labels
        })
        .collect::<Vec<String>>()
        .join(" ")
}

fn compact_model_name(display_name: &str) -> String {
    let display_name = display_name.trim();
    let without_prefix = display_name
        .get(..3)
        .filter(|prefix| prefix.eq_ignore_ascii_case("gpt"))
        .map_or(display_name, |_| {
            display_name[3..]
                .trim_start_matches(|character: char| character == '-' || character.is_whitespace())
        });
    let compact = without_prefix.replace('-', " ").trim().to_owned();
    if compact.is_empty() {
        "Model".into()
    } else {
        compact
    }
}

fn effort_index_from_pointer(
    client_x: f32,
    left: f32,
    width: f32,
    stop_count: usize,
    inset: f32,
    minimum_fill: f32,
) -> usize {
    if stop_count <= 1 {
        return 0;
    }
    let inner_width = width - inset * 2.0;
    if inner_width <= minimum_fill {
        return 0;
    }
    let travel_width = inner_width - minimum_fill;
    let relative_x = client_x - left - inset - minimum_fill;
    let progress = (relative_x / travel_width).clamp(0.0, 1.0);
    (progress * (stop_count - 1) as f32).round() as usize
}

fn effort_progress(index: usize, count: usize) -> f32 {
    if count <= 1 {
        0.5
    } else {
        index.min(count - 1) as f32 / (count - 1) as f32
    }
}

fn effort_fill_width(
    index: usize,
    count: usize,
    track_width: f32,
    inset: f32,
    minimum_fill: f32,
) -> f32 {
    minimum_fill + effort_progress(index, count) * (track_width - minimum_fill - inset * 2.0)
}

fn ease_out_cubic(progress: f32) -> f32 {
    1.0 - (1.0 - progress.clamp(0.0, 1.0)).powi(3)
}

fn dither_noise_threshold(x: u32, y: u32) -> f32 {
    let mut hash = (x + 1).wrapping_mul(374_761_393) ^ (y + 1).wrapping_mul(668_265_263);
    hash = (hash ^ (hash >> 13)).wrapping_mul(1_274_126_177);
    (hash ^ (hash >> 16)) as f32 / 4_294_967_296.0
}

fn smoothed_voice_level(levels: &[f32], index: usize) -> f32 {
    let current = levels.get(index).copied().unwrap_or_default();
    let previous = index
        .checked_sub(1)
        .and_then(|index| levels.get(index).copied())
        .unwrap_or(current);
    let next = levels.get(index + 1).copied().unwrap_or(current);
    previous * 0.2 + current * 0.6 + next * 0.2
}

fn for_each_voice_dither_dot(
    width: f32,
    height: f32,
    levels: &[f32],
    mut visit: impl FnMut(u32, u32, f32),
) {
    const CELL_SIZE: f32 = 4.0;
    const BAYER: [[f32; 4]; 4] = [
        [0.03125, 0.53125, 0.15625, 0.65625],
        [0.78125, 0.28125, 0.90625, 0.40625],
        [0.21875, 0.71875, 0.09375, 0.59375],
        [0.96875, 0.46875, 0.84375, 0.34375],
    ];

    if width <= 0.0 || height <= 0.0 {
        return;
    }
    let columns = (width / CELL_SIZE).ceil().max(4.0) as usize;
    let rows = (height / CELL_SIZE).ceil().max(4.0) as usize;
    let visible_start = levels.len().saturating_sub(columns);
    let visible_levels = &levels[visible_start..];
    let first_level_column = columns - visible_levels.len();
    let center_y = height / 2.0;

    for x in 0..columns {
        let level_index = x.checked_sub(first_level_column);
        let level = level_index.map_or(0.0, |index| {
            (smoothed_voice_level(visible_levels, index).clamp(0.0, 1.0) * 1.6)
                .clamp(0.0, 1.0)
                .powf(0.72)
        });
        let envelope_radius = CELL_SIZE * (0.7 + level * (rows as f32 / 2.0 - 0.8).max(0.5));

        for y in 0..rows {
            let cell_center_y = y as f32 * CELL_SIZE + CELL_SIZE / 2.0;
            let distance_from_center = (cell_center_y - center_y).abs();
            let baseline_density: f32 = if distance_from_center <= CELL_SIZE * 0.34 {
                0.18
            } else {
                0.0
            };
            let envelope_density = level_index.map_or(0.0, |_| {
                (1.0 - distance_from_center / envelope_radius.max(1.0)).clamp(0.0, 1.0)
                    * (0.48 + level * 0.52)
            });
            let density = baseline_density.max(envelope_density);
            if density <= BAYER[y & 3][x & 3] {
                continue;
            }
            let alpha = if level_index.is_some() {
                (0.16 + envelope_density * 0.7 + level * 0.14).min(1.0)
            } else {
                0.08
            };
            visit(x as u32, y as u32, alpha);
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct DitherPaintSpace {
    origin_x: f32,
    origin_y: f32,
    design_width: f32,
    design_height: f32,
    scale: f32,
}

impl DitherPaintSpace {
    fn new(bounds: Bounds<Pixels>, scale: f32) -> Self {
        Self {
            origin_x: f32::from(bounds.origin.x),
            origin_y: f32::from(bounds.origin.y),
            design_width: f32::from(bounds.size.width) / scale,
            design_height: f32::from(bounds.size.height) / scale,
            scale,
        }
    }

    fn x(self, design_x: f32) -> f32 {
        self.origin_x + design_x * self.scale
    }

    fn y(self, design_y: f32) -> f32 {
        self.origin_y + design_y * self.scale
    }

    fn length(self, design_length: f32) -> f32 {
        design_length * self.scale
    }
}

fn paint_voice_dither(bounds: Bounds<Pixels>, levels: &[f32], theme: Theme, window: &mut Window) {
    const CELL_SIZE: f32 = 4.0;
    const DOT_SIZE: f32 = 2.0;
    const DOT_INSET: f32 = 1.0;

    let space = DitherPaintSpace::new(bounds, crate::zoom::factor());
    let dark = theme.mode == ThemeMode::Dark;
    let texture_color: gpui::Hsla = if dark {
        gpui::rgb(0xededed).into()
    } else {
        gpui::rgb(0x121212).into()
    };
    let texture_opacity = if dark { 1.0 } else { 0.26 };
    let bloom_opacity = if dark { 0.44 } else { 0.05 };
    let fade_width = space.design_width * 0.08;

    for_each_voice_dither_dot(
        space.design_width,
        space.design_height,
        levels,
        |x, y, alpha| {
            let design_x = x as f32 * CELL_SIZE + DOT_INSET;
            let design_y = y as f32 * CELL_SIZE + DOT_INSET;
            let origin_x = space.x(design_x);
            let origin_y = space.y(design_y);
            let mask = if fade_width > 0.0 {
                (design_x / fade_width).clamp(0.0, 1.0)
            } else {
                1.0
            };
            let alpha = alpha * mask;
            let dot_size = space.length(DOT_SIZE);
            let bloom_size = space.length(DOT_SIZE + if dark { 3.5 } else { 2.5 });
            let bloom_inset = (bloom_size - dot_size) / 2.0;
            window.paint_quad(
                fill(
                    Bounds {
                        origin: point(
                            gpui::px(origin_x - bloom_inset),
                            gpui::px(origin_y - bloom_inset),
                        ),
                        size: size(gpui::px(bloom_size), gpui::px(bloom_size)),
                    },
                    texture_color.opacity(alpha * bloom_opacity),
                )
                .corner_radii(gpui::px(bloom_size / 2.0)),
            );
            window.paint_quad(fill(
                Bounds {
                    origin: point(gpui::px(origin_x), gpui::px(origin_y)),
                    size: size(gpui::px(dot_size), gpui::px(dot_size)),
                },
                texture_color.opacity(alpha * texture_opacity),
            ));
        },
    );
}

fn smoothstep(progress: f32) -> f32 {
    let progress = progress.clamp(0.0, 1.0);
    progress * progress * (3.0 - 2.0 * progress)
}

fn paint_effort_dither(
    bounds: Bounds<Pixels>,
    pointer: Option<Point<Pixels>>,
    active_only: bool,
    theme: Theme,
    window: &mut Window,
) {
    const CELL_SIZE: f32 = 4.0;
    const DOT_FILL: f32 = 0.42;
    const INNER_RADIUS: f32 = 20.0;
    const OUTER_RADIUS: f32 = 60.0;

    let space = DitherPaintSpace::new(bounds, crate::zoom::factor());
    if space.design_width <= 0.0 || space.design_height <= 0.0 {
        return;
    }
    let columns = (space.design_width / CELL_SIZE).ceil().max(4.0) as u32;
    let rows = (space.design_height / CELL_SIZE).ceil().max(4.0) as u32;
    let design_dot_size = CELL_SIZE * DOT_FILL;
    let design_dot_inset = (CELL_SIZE - design_dot_size) / 2.0;
    let dot_size = space.length(design_dot_size);
    let dark = theme.mode == ThemeMode::Dark;
    let texture_color: gpui::Hsla = if dark {
        gpui::rgb(0xededed).into()
    } else {
        gpui::rgb(0x121212).into()
    };
    let texture_opacity = if dark { 1.0 } else { 0.26 };
    let bloom_opacity = if dark { 0.44 } else { 0.05 };
    let pointer = pointer.map(|pointer| (f32::from(pointer.x), f32::from(pointer.y)));

    for y in 0..rows {
        for x in 0..columns {
            let threshold = dither_noise_threshold(x, y);
            let center_x = space.x(x as f32 * CELL_SIZE + CELL_SIZE / 2.0);
            let center_y = space.y(y as f32 * CELL_SIZE + CELL_SIZE / 2.0);
            let bright = pointer.is_some_and(|(pointer_x, pointer_y)| {
                let distance = (center_x - pointer_x).hypot(center_y - pointer_y);
                let inner_radius = space.length(INNER_RADIUS);
                let outer_radius = space.length(OUTER_RADIUS);
                let radial = smoothstep(
                    ((outer_radius - distance) / (outer_radius - inner_radius)).clamp(0.0, 1.0),
                );
                threshold <= radial * 0.5
            });
            if active_only {
                if !bright {
                    continue;
                }
            } else if threshold > 0.5 {
                continue;
            }

            let alpha = if active_only { 0.88 } else { 0.025 };
            let origin_x = space.x(x as f32 * CELL_SIZE + design_dot_inset);
            let origin_y = space.y(y as f32 * CELL_SIZE + design_dot_inset);
            let bloom_size = dot_size + space.length(if dark { 3.5 } else { 2.5 });
            let bloom_inset = (bloom_size - dot_size) / 2.0;
            let bloom_bounds = Bounds {
                origin: point(
                    gpui::px(origin_x - bloom_inset),
                    gpui::px(origin_y - bloom_inset),
                ),
                size: size(gpui::px(bloom_size), gpui::px(bloom_size)),
            };
            window.paint_quad(
                fill(bloom_bounds, texture_color.opacity(alpha * bloom_opacity))
                    .corner_radii(gpui::px(bloom_size / 2.0)),
            );
            window.paint_quad(fill(
                Bounds {
                    origin: point(gpui::px(origin_x), gpui::px(origin_y)),
                    size: size(gpui::px(dot_size), gpui::px(dot_size)),
                },
                texture_color.opacity(alpha * texture_opacity),
            ));
        }
    }
}

fn title_case(value: &str) -> String {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return String::new();
    };
    first.to_uppercase().chain(chars).collect()
}

fn path_label(path: &str) -> &str {
    path.rsplit(['/', '\\'])
        .find(|component| !component.is_empty())
        .unwrap_or(path)
}

fn design_phase_label(text: &str) -> Option<&'static str> {
    let text = text.to_ascii_lowercase();
    if text.contains("design:brief") {
        Some("Preparing questions")
    } else if text.contains("design:brand") {
        Some("Creating brand direction")
    } else if text.contains("design:page") {
        Some("Planning the page")
    } else if text.contains("design:assets") {
        Some("Gathering assets")
    } else if text.contains("design:build") {
        Some("Building the website")
    } else if text.contains("design:preview") {
        Some("Starting the preview")
    } else if text.contains("design:review") {
        Some("Reviewing the design")
    } else if text.contains("design:repair") {
        Some("Refining the website")
    } else {
        None
    }
}

fn merge_queued_draft(queued: &str, draft: &str) -> String {
    let draft = draft.trim();
    if draft.is_empty() {
        queued.into()
    } else {
        format!("{queued}\n\n{draft}")
    }
}

fn merge_unique_attachments(current: &mut Vec<ComposerAttachment>, queued: Vec<String>) {
    for path in queued {
        if !current
            .iter()
            .any(|attachment| attachment.path.as_deref() == Some(path.as_str()))
        {
            current.push(ComposerAttachment::file(path));
        }
    }
}

fn attachment_paths(paths: &[PathBuf]) -> Vec<String> {
    paths
        .iter()
        .filter(|path| !path.as_os_str().is_empty())
        .map(|path| path.to_string_lossy().into_owned())
        .collect()
}

fn is_image_path(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg"
            )
        })
}

fn pasted_image_extension(image: &Image) -> Option<&'static str> {
    let bytes = image.bytes();
    match image.format() {
        ImageFormat::Png
            if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) =>
        {
            Some("png")
        }
        ImageFormat::Jpeg if bytes.starts_with(&[0xff, 0xd8, 0xff]) => Some("jpg"),
        ImageFormat::Gif if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") => {
            Some("gif")
        }
        ImageFormat::Webp
            if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP".as_slice()) =>
        {
            Some("webp")
        }
        ImageFormat::Bmp if bytes.starts_with(b"BM") => Some("bmp"),
        _ => None,
    }
}

fn materialize_pasted_image(image: &Image) -> anyhow::Result<PathBuf> {
    let extension =
        pasted_image_extension(image).ok_or_else(|| anyhow::anyhow!("unsupported pasted image"))?;
    if image.bytes().is_empty() || image.bytes().len() > MAX_PASTED_IMAGE_BYTES {
        anyhow::bail!("pasted image is empty or too large");
    }
    let directory = std::env::temp_dir()
        .join("TasteCode")
        .join("pasted-images");
    std::fs::create_dir_all(&directory)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))?;
    }
    let destination = directory.join(format!("pasted-{}.{}", uuid::Uuid::new_v4(), extension));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options.open(&destination)?;
    file.write_all(image.bytes())?;
    file.sync_all()?;
    Ok(destination)
}

fn transcript_mode_for_bottom_gap(gap: gpui::Pixels) -> TranscriptScrollMode {
    if gap < px(TRANSCRIPT_BOTTOM_SLACK) {
        TranscriptScrollMode::FollowEnd
    } else {
        TranscriptScrollMode::Free
    }
}

fn format_voice_duration(duration: Duration) -> String {
    let seconds = duration.as_secs();
    format!("{}:{:02}", seconds / 60, seconds % 60)
}

struct TranscriptInsertion {
    text: String,
    cursor: usize,
}

fn insert_transcript_at_cursor(
    current: &str,
    transcript: &str,
    cursor: usize,
) -> Option<TranscriptInsertion> {
    let spoken = transcript.trim();
    if spoken.is_empty() {
        return None;
    }
    let mut position = cursor.min(current.len());
    while !current.is_char_boundary(position) {
        position = position.saturating_sub(1);
    }
    let (before, after) = current.split_at(position);
    let leading = if before
        .chars()
        .next_back()
        .is_some_and(|character| !character.is_whitespace())
    {
        " "
    } else {
        ""
    };
    let trailing = if after
        .chars()
        .next()
        .is_some_and(|character| !character.is_whitespace())
    {
        " "
    } else {
        ""
    };
    let insertion = format!("{leading}{spoken}{trailing}");
    Some(TranscriptInsertion {
        text: format!("{before}{insertion}{after}"),
        cursor: before.len() + insertion.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn queued_turn(id: &str, text: &str, attachments: &[&str], created_at: f64) -> QueuedTurn {
        QueuedTurn {
            id: id.into(),
            text: text.into(),
            attachments: attachments.iter().map(|path| (*path).into()).collect(),
            created_at,
        }
    }

    #[test]
    fn transcript_insertion_preserves_both_sides_of_the_draft() {
        let inserted = insert_transcript_at_cursor("hello world", " spoken words ", 5).unwrap();
        assert_eq!(inserted.text, "hello spoken words world");
        assert_eq!(inserted.cursor, 18);
    }

    #[test]
    fn queued_prompt_edit_preserves_the_draft_and_deduplicates_attachments() {
        assert_eq!(
            merge_queued_draft("Polish the queue", "  keep this draft  "),
            "Polish the queue\n\nkeep this draft"
        );
        assert_eq!(
            merge_queued_draft("Polish the queue", "  "),
            "Polish the queue"
        );

        let mut attachments = vec![ComposerAttachment::file("/work/existing.png".into())];
        merge_unique_attachments(
            &mut attachments,
            vec!["/work/reference.png".into(), "/work/existing.png".into()],
        );
        assert_eq!(
            attachments
                .iter()
                .filter_map(|attachment| attachment.path.as_deref())
                .collect::<Vec<_>>(),
            ["/work/existing.png", "/work/reference.png"]
        );
    }

    #[test]
    fn queue_snapshots_keep_unconfirmed_prompts_and_reconcile_canonical_rows_once() {
        let current = ThreadQueueResult {
            items: vec![
                queued_turn("queued-old", "Earlier", &[], 1.0),
                queued_turn("pending:1", "Same prompt", &["reference.png"], 10_000.0),
                queued_turn("pending:2", "Same prompt", &["reference.png"], 10_001.0),
            ],
            can_steer: true,
        };
        let stale = reconcile_queue_snapshot(
            &current,
            ThreadQueueResult {
                items: vec![queued_turn("queued-old", "Earlier", &[], 1.0)],
                can_steer: false,
            },
        );
        assert_eq!(
            stale
                .items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["queued-old", "pending:1", "pending:2"]
        );

        let confirmed = reconcile_queue_snapshot(
            &current,
            ThreadQueueResult {
                items: vec![
                    queued_turn("queued-old", "Earlier", &[], 1.0),
                    queued_turn(
                        "queued-new",
                        "Same prompt",
                        &["reference.png", DESIGN_BRIEF_ATTACHMENT],
                        10_002.0,
                    ),
                ],
                can_steer: true,
            },
        );
        assert_eq!(
            confirmed
                .items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["queued-old", "queued-new", "pending:2"]
        );
    }

    #[test]
    fn queue_response_replaces_the_optimistic_row_in_place() {
        let mut queue = ThreadQueueResult {
            items: vec![
                queued_turn("queued-old", "Earlier", &[], 1.0),
                queued_turn("pending:1", "Next", &[], 2.0),
                queued_turn("queued-later", "Later", &[], 3.0),
            ],
            can_steer: false,
        };

        resolve_queue_submission(
            &mut queue,
            Some("pending:1"),
            Some(queued_turn("queued-next", "Next", &[], 2.0)),
        );
        assert_eq!(
            queue
                .items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["queued-old", "queued-next", "queued-later"]
        );

        resolve_queue_submission(
            &mut queue,
            Some("pending:1"),
            Some(queued_turn("queued-next", "Next", &[], 2.0)),
        );
        assert_eq!(queue.items.len(), 3);
    }

    #[test]
    fn submission_acknowledgement_only_echoes_when_no_canonical_prompt_arrived() {
        let mut state = ThreadState::default();
        for push in optimistic_prompt_events(
            "thread-1",
            "turn-1",
            "canonical-prior".into(),
            "Use this direction now".into(),
            1.0,
            true,
        ) {
            state.apply_live(push.seq, push.event);
        }
        let echo_after_row = state.timeline_len();
        assert!(!submitted_prompt_already_visible(
            &state,
            "Use this direction now",
            10_000.0,
            echo_after_row,
        ));

        for push in optimistic_prompt_events(
            "thread-1",
            "turn-1",
            "canonical-new".into(),
            "Use this direction now".into(),
            10_000.0,
            false,
        ) {
            state.apply_live(push.seq, push.event);
        }
        assert!(submitted_prompt_already_visible(
            &state,
            "Use this direction now",
            10_000.0,
            echo_after_row,
        ));
        assert!(submitted_prompt_already_visible(
            &state,
            "Use this direction now",
            10_000.0,
            99,
        ));
    }

    #[test]
    fn voice_duration_uses_the_web_minutes_and_seconds_format() {
        assert_eq!(format_voice_duration(Duration::from_millis(999)), "0:00");
        assert_eq!(format_voice_duration(Duration::from_secs(65)), "1:05");
    }

    #[test]
    fn voice_dither_density_tracks_microphone_level() {
        let mut quiet_dots = 0;
        let mut loud_dots = 0;
        for_each_voice_dither_dot(320.0, 28.0, &[0.0; 80], |_, _, _| quiet_dots += 1);
        for_each_voice_dither_dot(320.0, 28.0, &[1.0; 80], |_, _, _| loud_dots += 1);

        assert!(quiet_dots > 0);
        assert!(loud_dots > quiet_dots * 2);
        assert!((smoothed_voice_level(&[0.0, 1.0, 0.0], 1) - 0.6).abs() < 0.001);
    }

    #[test]
    fn dither_paint_space_scales_local_geometry_without_rescaling_its_origin() {
        let space = DitherPaintSpace::new(
            Bounds {
                origin: point(gpui::px(120.0), gpui::px(80.0)),
                size: size(gpui::px(640.0), gpui::px(56.0)),
            },
            2.0,
        );

        assert_eq!(space.design_width, 320.0);
        assert_eq!(space.design_height, 28.0);
        assert_eq!(space.x(3.0), 126.0);
        assert_eq!(space.y(2.0), 84.0);
        assert_eq!(space.length(4.0), 8.0);
    }

    #[test]
    fn context_usage_matches_the_web_percentage_and_number_copy() {
        assert!((context_usage_progress(15_000.0, 100_000.0) - 0.15).abs() < 0.001);
        assert_eq!(context_usage_progress(120_000.0, 100_000.0), 1.0);
        assert_eq!(context_usage_progress(10.0, 0.0), 0.0);
        assert_eq!(format_token_count(15_000.0), "15,000");
        assert_eq!(format_token_count(1_234_567.4), "1,234,567");
    }

    #[test]
    fn composer_height_matches_the_web_textarea_bounds() {
        assert_eq!(composer_height_for_line_count(0), COMPOSER_MIN_HEIGHT);
        assert_eq!(composer_height_for_line_count(2), COMPOSER_MIN_HEIGHT);
        assert!((composer_height_for_line_count(3) - 89.1).abs() < 0.001);
        assert!((composer_height_for_line_count(10) - 241.0).abs() < 0.001);
        assert_eq!(composer_height_for_line_count(11), COMPOSER_MAX_HEIGHT);
        assert_eq!(composer_height_for_line_count(100), COMPOSER_MAX_HEIGHT);
        assert_eq!(composer_wrap_width(gpui::px(808.0), 1.0), gpui::px(762.0));
        assert_eq!(
            composer_wrap_width(gpui::px(1_616.0), 2.0),
            gpui::px(1_524.0)
        );
    }

    #[test]
    fn brief_card_entry_keeps_the_web_relative_anchor() {
        assert_eq!(brief_entry_margin(BRIEF_CARD_GAP, 0.0), 0.0);
        assert_eq!(brief_entry_margin(BRIEF_CARD_GAP, 1.0), 8.0);
        assert_eq!(brief_entry_margin(BRIEF_STATUS_GAP, 0.0), -2.0);
        assert_eq!(brief_entry_margin(BRIEF_STATUS_GAP, 1.0), 6.0);
    }

    #[test]
    fn new_session_geometry_matches_the_web_stage() {
        assert_eq!(new_session_optical_padding(800.0), 12.0);
        assert_eq!(new_session_optical_padding(1_000.0), 14.0);
        assert_eq!(new_session_prompt_size(700.0), 20.0);
        assert_eq!(new_session_prompt_size(1_000.0), 24.0);
        assert_eq!(new_session_prompt_size(1_400.0), 30.0);
        assert_eq!(design_dimension(gpui::px(1_400.0), 2.0), 700.0);
    }

    #[test]
    fn missing_project_context_stays_a_new_session_with_the_web_prompt_copy() {
        assert!(is_new_session(None));
        let mut session = SessionContext {
            thread_id: None,
            title: "New chat".into(),
            project_path: "/work/harness".into(),
            project_name: "TasteCode".into(),
            provider: None,
        };
        assert!(is_new_session(Some(&session)));
        assert!(is_centered_new_session(Some(&session), false));
        assert!(!is_centered_new_session(Some(&session), true));
        session.thread_id = Some("thread-1".into());
        assert!(!is_new_session(Some(&session)));
        assert_eq!(new_session_prompt_label(false, true, None), None);
        assert_eq!(
            new_session_prompt_label(true, true, None).as_deref(),
            Some("Add a project to start building.")
        );
        assert_eq!(
            new_session_prompt_label(true, false, None).as_deref(),
            Some("What should we build in a project?")
        );
        assert_eq!(
            new_session_prompt_label(true, false, Some("TasteCode")).as_deref(),
            Some("What should we build in TasteCode?")
        );
    }

    #[test]
    fn provisional_session_keeps_consecutive_prompts_visible_and_ordered() {
        let mut state = ThreadState::default();
        let events = optimistic_prompt_events(
            "",
            "local-turn:1",
            "optimistic:1".into(),
            "Start immediately".into(),
            1.0,
            true,
        )
        .into_iter()
        .chain(optimistic_prompt_events(
            "",
            "local-turn:1",
            "optimistic:2".into(),
            "Then do this too".into(),
            2.0,
            false,
        ));

        for push in events {
            assert!(matches!(
                state.apply_live(push.seq, push.event),
                ApplyOutcome::Applied(_)
            ));
        }

        assert!(state.running);
        assert_eq!(state.timeline_len(), 2);
        assert_eq!(
            (0..state.timeline_len())
                .filter_map(|row| state.item_at_row(row)?.text.as_deref())
                .collect::<Vec<_>>(),
            ["Start immediately", "Then do this too"]
        );
    }

    #[test]
    fn pending_design_turn_captures_the_brief_at_submit_time() {
        assert_eq!(
            design_attachments(vec!["reference.png".into()], true),
            ["reference.png", DESIGN_BRIEF_ATTACHMENT]
        );
        assert_eq!(
            design_attachments(vec![DESIGN_BRIEF_ATTACHMENT.into()], true),
            [DESIGN_BRIEF_ATTACHMENT]
        );
        assert!(design_attachments(Vec::new(), false).is_empty());
        assert_eq!(
            restored_composer_attachments(vec![
                "reference.png".into(),
                DESIGN_BRIEF_ATTACHMENT.into(),
            ])
            .into_iter()
            .filter_map(|attachment| attachment.path)
            .collect::<Vec<_>>(),
            ["reference.png"]
        );
    }

    #[test]
    fn composer_menus_follow_their_triggers_and_flip_like_the_web_menu() {
        let composer = Bounds {
            origin: point(px(100.0), px(200.0)),
            size: size(px(500.0), px(114.0)),
        };
        let permission = Bounds {
            origin: point(px(148.0), px(271.0)),
            size: size(px(90.0), px(34.0)),
        };
        let permission_placement = composer_menu_placement(
            Some(composer),
            Some(permission),
            px(800.0),
            px(800.0),
            px(315.0),
            px(221.0),
            ComposerMenuAlignment::Left,
            ComposerMenuDrop::Up,
        )
        .unwrap();
        assert_eq!(permission_placement.left, px(48.0));
        assert_eq!(permission_placement.vertical, px(49.0));
        assert_eq!(permission_placement.drop, ComposerMenuDrop::Up);

        let model = Bounds {
            origin: point(px(430.0), px(272.0)),
            size: size(px(126.0), px(32.0)),
        };
        let model_placement = composer_menu_placement(
            Some(composer),
            Some(model),
            px(800.0),
            px(800.0),
            px(MODEL_PICKER_WIDTH),
            px(MODEL_PICKER_PANEL_HEIGHT),
            ComposerMenuAlignment::RightShiftedLeft(MODEL_MENU_TRANSLATE_X),
            ComposerMenuDrop::Up,
        )
        .unwrap();
        assert_eq!(model_placement.left, px(46.0));
        assert_eq!(model_placement.vertical, px(110.0));
        assert_eq!(model_placement.drop, ComposerMenuDrop::Down);

        let lower_composer = Bounds {
            origin: point(px(100.0), px(500.0)),
            size: size(px(500.0), px(114.0)),
        };
        let lower_model = Bounds {
            origin: point(px(430.0), px(572.0)),
            size: size(px(126.0), px(32.0)),
        };
        let lower_model_placement = composer_menu_placement(
            Some(lower_composer),
            Some(lower_model),
            px(800.0),
            px(800.0),
            px(MODEL_PICKER_WIDTH),
            px(MODEL_PICKER_PANEL_HEIGHT),
            ComposerMenuAlignment::RightShiftedLeft(MODEL_MENU_TRANSLATE_X),
            ComposerMenuDrop::Up,
        )
        .unwrap();
        assert_eq!(lower_model_placement.left, px(46.0));
        assert_eq!(lower_model_placement.vertical, px(48.0));
        assert_eq!(lower_model_placement.drop, ComposerMenuDrop::Up);

        let project = Bounds {
            origin: point(px(113.0), px(203.0)),
            size: size(px(130.0), px(31.0)),
        };
        let project_placement = composer_menu_placement(
            Some(composer),
            Some(project),
            px(800.0),
            px(800.0),
            px(350.0),
            px(200.0),
            ComposerMenuAlignment::Left,
            ComposerMenuDrop::Down,
        )
        .unwrap();
        assert_eq!(project_placement.left, px(13.0));
        assert_eq!(project_placement.vertical, px(40.0));
        assert_eq!(project_placement.drop, ComposerMenuDrop::Down);

        let branch = Bounds {
            origin: point(px(300.0), px(203.0)),
            size: size(px(120.0), px(31.0)),
        };
        let branch_placement = composer_menu_placement(
            Some(composer),
            Some(branch),
            px(800.0),
            px(800.0),
            px(280.0),
            px(200.0),
            ComposerMenuAlignment::Left,
            ComposerMenuDrop::Down,
        )
        .unwrap();
        assert_eq!(branch_placement.left, px(200.0));
        assert_eq!(branch_placement.vertical, px(40.0));
        assert_eq!(branch_placement.drop, ComposerMenuDrop::Down);
    }

    #[test]
    fn composer_dock_motion_uses_the_web_flip_geometry() {
        let start = Instant::now();
        let pending = ComposerDockPending {
            box_bounds: Bounds {
                origin: point(gpui::px(0.0), gpui::px(300.0)),
                size: size(gpui::px(808.0), gpui::px(200.0)),
            },
            field_height: gpui::px(100.0),
            started: start,
        };

        assert!(
            (f32::from(composer_dock_offset(pending, gpui::px(800.0), 1.0, start,)) + 342.0).abs()
                < 0.001
        );
        assert!(
            (f32::from(composer_dock_offset(
                pending,
                gpui::px(800.0),
                1.0,
                start + COMPOSER_DOCK_DURATION,
            )) + 374.0)
                .abs()
                < 0.001
        );

        let zoomed_pending = ComposerDockPending {
            box_bounds: Bounds {
                origin: point(gpui::px(0.0), gpui::px(600.0)),
                size: size(gpui::px(1_616.0), gpui::px(400.0)),
            },
            field_height: gpui::px(200.0),
            started: start,
        };
        assert!(
            (f32::from(composer_dock_offset(
                zoomed_pending,
                gpui::px(1_600.0),
                2.0,
                start,
            )) + 684.0)
                .abs()
                < 0.001
        );
        assert_eq!(composer_dock_easing(0.0), 0.0);
        assert_eq!(composer_dock_easing(1.0), 1.0);
    }

    #[test]
    fn context_usage_motion_animates_updates_without_animating_mounts() {
        let start = Instant::now();
        let duration = Duration::from_millis(170);
        let mut motion = ScalarMotion::stationary(0.15, start);

        assert_eq!(motion.sample(start), (0.15, false));
        assert!(motion.retarget(0.42, duration, false, start));
        let (midpoint, animating) = motion.sample(start + Duration::from_millis(85));
        assert!(animating);
        assert!((0.15..0.42).contains(&midpoint));
        assert_eq!(
            motion.sample(start + duration + Duration::from_millis(1)),
            (0.42, false)
        );
    }

    #[test]
    fn design_activity_labels_match_the_web_timeline() {
        assert_eq!(
            design_phase_label("design:brand"),
            Some("Creating brand direction")
        );
        assert_eq!(
            design_phase_label("DESIGN:REVIEW"),
            Some("Reviewing the design")
        );
        assert_eq!(design_phase_label("ordinary tool"), None);
    }

    #[test]
    fn pasted_images_require_a_matching_supported_signature() {
        let png = Image::from_bytes(
            ImageFormat::Png,
            vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a],
        );
        let spoofed = Image::from_bytes(ImageFormat::Png, b"not a png".to_vec());
        let svg = Image::from_bytes(ImageFormat::Svg, b"<svg/>".to_vec());

        assert_eq!(pasted_image_extension(&png), Some("png"));
        assert_eq!(pasted_image_extension(&spoofed), None);
        assert_eq!(pasted_image_extension(&svg), None);
    }

    #[test]
    fn attachment_image_detection_is_case_insensitive() {
        assert!(is_image_path("C:\\work\\REFERENCE.PNG"));
        assert!(is_image_path("/work/reference.webp"));
        assert!(!is_image_path("/work/notes.md"));
    }

    #[test]
    fn native_file_drops_preserve_every_nonempty_platform_path() {
        let first = PathBuf::from("reference.png");
        let second = PathBuf::from("notes.md");

        assert_eq!(
            attachment_paths(&[first.clone(), PathBuf::new(), second.clone()]),
            [
                first.to_string_lossy().into_owned(),
                second.to_string_lossy().into_owned(),
            ]
        );
    }

    #[test]
    fn transcript_bottom_slack_matches_the_web_scroll_contract() {
        assert_eq!(
            transcript_mode_for_bottom_gap(px(79.0)),
            TranscriptScrollMode::FollowEnd
        );
        assert_eq!(
            transcript_mode_for_bottom_gap(px(80.0)),
            TranscriptScrollMode::Free
        );
    }

    #[test]
    fn model_labels_match_the_web_selector() {
        assert_eq!(compact_model_name("GPT-5.6-Sol"), "5.6 Sol");
        assert_eq!(compact_model_name("gpt 5.4 mini"), "5.4 mini");
        assert_eq!(compact_model_name("Claude-Sonnet-4.5"), "Claude Sonnet 4.5");
        assert_eq!(friendly_effort_label(None), "Default");
        assert_eq!(friendly_effort_label(Some("xhigh")), "Extra High");
        assert_eq!(friendly_effort_label(Some("xlow")), "Extra Low");
        assert_eq!(friendly_effort_label(Some("extra_high")), "Extra High");
    }

    #[test]
    fn effort_slider_geometry_matches_the_web_component() {
        let left = 100.0;
        assert_eq!(
            effort_index_from_pointer(100.0, left, 314.0, 4, 2.0, 44.0),
            0
        );
        assert_eq!(
            effort_index_from_pointer(146.0, left, 314.0, 4, 2.0, 44.0),
            0
        );
        assert_eq!(
            effort_index_from_pointer(279.0, left, 314.0, 4, 2.0, 44.0),
            2
        );
        assert_eq!(
            effort_index_from_pointer(412.0, left, 314.0, 4, 2.0, 44.0),
            3
        );
        assert_eq!(
            effort_index_from_pointer(500.0, left, 314.0, 4, 2.0, 44.0),
            3
        );
        assert!((effort_fill_width(0, 4, 366.0, 2.0, 44.0) - 44.0).abs() < f32::EPSILON);
        assert!((effort_fill_width(3, 4, 366.0, 2.0, 44.0) - 362.0).abs() < f32::EPSILON);
        assert!((effort_fill_width(0, 1, 366.0, 2.0, 44.0) - 203.0).abs() < f32::EPSILON);
        assert!((effort_fill_width(3, 4, 328.0, 2.0, 44.0) - 324.0).abs() < f32::EPSILON);
    }

    #[test]
    fn effort_resolution_keeps_valid_selection_then_uses_model_default() {
        let model = harness_protocol::Model {
            id: "gpt-5.6".into(),
            display_name: "GPT-5.6".into(),
            description: None,
            is_default: true,
            reasoning_efforts: vec!["low".into(), "medium".into(), "high".into()],
            default_reasoning_effort: Some("medium".into()),
            service_tiers: Vec::new(),
            default_service_tier: None,
        };
        assert_eq!(
            selected_reasoning_effort(&model, Some("high")),
            Some("high")
        );
        assert_eq!(
            selected_reasoning_effort(&model, Some("max")),
            Some("medium")
        );
        assert_eq!(selected_reasoning_effort(&model, None), Some("medium"));
    }

    #[test]
    fn composer_control_motion_matches_the_web_keyframes() {
        assert_eq!(DESIGN_BEAM_DURATION, Duration::from_millis(2_400));
        assert_eq!(SEND_BEAM_DURATION, Duration::from_millis(1_960));
        assert!((menu_entry_scale(0.0) - 0.97).abs() < 0.000_1);
        assert!((menu_entry_scale(1.0) - 1.0).abs() < 0.000_1);
        assert!((fast_bolt_on_scale(0.0) - 0.7).abs() < 0.000_1);
        assert!((fast_bolt_on_scale(0.48) - 1.25).abs() < 0.000_1);
        assert!((fast_bolt_on_scale(1.0) - 1.0).abs() < 0.000_1);
        assert_eq!(fast_bolt_off_state(0.0), (1.0, 1.0));
        let off_midpoint = fast_bolt_off_state(0.45);
        assert!((off_midpoint.0 - 0.78).abs() < 0.000_1);
        assert!((off_midpoint.1 - 0.55).abs() < 0.000_1);
        let off_end = fast_bolt_off_state(1.0);
        assert!((off_end.0 - 1.0).abs() < 0.000_1);
        assert!((off_end.1 - 1.0).abs() < 0.000_1);
    }

    #[test]
    fn model_picker_keeps_backdrop_panel_and_transparent_controls_distinct() {
        let dark = Theme::new(
            ThemeMode::Dark,
            crate::theme::Backdrop::Slate,
            crate::theme::Accent::Neutral,
        );
        let light = Theme::new(
            ThemeMode::Light,
            crate::theme::Backdrop::Mocha,
            crate::theme::Accent::Neutral,
        );

        assert_eq!(model_picker_background(dark), dark.surface_2.hsla().into());
        assert_eq!(
            model_picker_controls_background(dark),
            gpui::transparent_black().into()
        );
        assert_eq!(
            model_picker_background(light),
            chrome::menu_background(light)
        );
        assert_eq!(
            model_picker_controls_background(light),
            linear_gradient(
                180.0,
                linear_color_stop(gpui::rgb(0xfafafa), 0.0),
                linear_color_stop(gpui::rgb(0xf6f6f7), 1.0),
            )
        );
    }
}
