use super::HarnessApp;
use crate::chat::{StageProject, StageSettings};
use crate::chrome;
use crate::client_state::{RollbackOperation, UsageScope, WorkspaceOperation};
use crate::motion_icon::motion_icon;
use crate::theme::ThemeMode;
use crate::tracked_text::tracked_text;
use crate::zoom::px;
use chrono::{DateTime, Local};
use gpui::{
    Animation, AnimationExt, AnyElement, Context, FontWeight, SharedString, div, prelude::*,
    relative, svg,
};
use harness_protocol::{CheckpointSummary, UsageLimit, UsageSummaryResult, WorkspaceInfo};
use std::time::Duration;

#[derive(Default)]
pub(super) struct StageControlsState {
    workspace_path: Option<String>,
    workspace_generation: u64,
    workspace_info: Option<WorkspaceInfo>,
    branches: Vec<String>,
    workspace_info_loading: bool,
    branches_loading: bool,
    switching_branch: Option<String>,
    checkpoint_thread_id: Option<String>,
    checkpoint_generation: u64,
    checkpoints: Vec<CheckpointSummary>,
    checkpoints_loading: bool,
    usage_scope: Option<UsageScope>,
    usage_generation: u64,
    pub(super) usage: Option<UsageSummaryResult>,
    usage_loading: bool,
    rollback: RollbackState,
    undo_restore: Option<UndoRestore>,
    undo_generation: u64,
    undo_busy: bool,
}

#[derive(Default)]
struct RollbackState {
    open: bool,
    transition: u64,
    generation: u64,
    thread_id: Option<String>,
    loading_id: Option<u64>,
    inspection: Option<RollbackInspection>,
    restoring: bool,
}

#[derive(Clone)]
struct RollbackInspection {
    checkpoint: CheckpointSummary,
    files: Vec<String>,
}

struct UndoRestore {
    thread_id: String,
    token: String,
}

impl StageControlsState {
    pub(super) fn overlay_open(&self) -> bool {
        self.rollback.open
    }

    pub(super) fn clear_restore_undo(&mut self) {
        self.undo_restore = None;
        self.undo_busy = false;
    }

    pub(super) fn usage_limits(&self) -> &[UsageLimit] {
        self.usage
            .as_ref()
            .map_or(&[], |summary| summary.limits.as_slice())
    }

    pub(super) fn checkpoint_count(&self) -> usize {
        self.checkpoints.len()
    }
}

impl HarnessApp {
    pub(super) fn refresh_stage_context(&mut self, cx: &mut Context<Self>) {
        self.refresh_workspace_state(cx);
        self.refresh_checkpoint_state(cx);
        self.refresh_usage_state(cx);
        self.sync_stage_settings(cx);
    }

    pub(super) fn refresh_workspace_state(&mut self, cx: &mut Context<Self>) {
        let path = self.active_project_path.clone();
        if self.stage_controls.workspace_path != path {
            self.stage_controls.workspace_path = path.clone();
            self.stage_controls.workspace_info = None;
            self.stage_controls.branches.clear();
            self.stage_controls.switching_branch = None;
        }
        self.stage_controls.workspace_generation =
            self.stage_controls.workspace_generation.wrapping_add(1);
        let generation = self.stage_controls.workspace_generation;
        let Some(path) = path else {
            self.stage_controls.workspace_info_loading = false;
            self.stage_controls.branches_loading = false;
            self.sync_stage_settings(cx);
            return;
        };
        self.stage_controls.workspace_info_loading = true;
        self.stage_controls.branches_loading = true;
        let update = self.state.request_workspace(path, generation);
        self.apply_client_update(update, cx);
    }

    pub(super) fn refresh_checkpoint_state(&mut self, cx: &mut Context<Self>) {
        let thread_id = self.selected_thread_id.clone();
        if self.stage_controls.checkpoint_thread_id != thread_id {
            self.stage_controls.checkpoint_thread_id = thread_id.clone();
            self.stage_controls.checkpoints.clear();
            self.close_rollback(cx);
        }
        self.stage_controls.checkpoint_generation =
            self.stage_controls.checkpoint_generation.wrapping_add(1);
        let generation = self.stage_controls.checkpoint_generation;
        let Some(thread_id) = thread_id else {
            self.stage_controls.checkpoints_loading = false;
            self.sync_stage_settings(cx);
            return;
        };
        if self.active_session_running() {
            self.stage_controls.checkpoints_loading = false;
            self.sync_stage_settings(cx);
            return;
        }
        self.stage_controls.checkpoints_loading = true;
        let update = self.state.request_checkpoints(thread_id, generation);
        self.apply_client_update(update, cx);
    }

    pub(super) fn refresh_usage_state(&mut self, cx: &mut Context<Self>) {
        let scope = self.selected_thread_id.clone().map_or_else(
            || {
                self.selected_model_choice()
                    .map(|choice| UsageScope::Provider(choice.provider))
            },
            |thread_id| Some(UsageScope::Thread(thread_id)),
        );
        if self.stage_controls.usage_scope != scope {
            self.stage_controls.usage_scope = scope.clone();
            self.stage_controls.usage = None;
        }
        self.stage_controls.usage_generation = self.stage_controls.usage_generation.wrapping_add(1);
        let generation = self.stage_controls.usage_generation;
        let Some(scope) = scope else {
            self.stage_controls.usage_loading = false;
            cx.notify();
            return;
        };
        self.stage_controls.usage_loading = true;
        let update = self.state.request_usage(scope, generation);
        self.apply_client_update(update, cx);
    }

    pub(super) fn sync_stage_settings(&mut self, cx: &mut Context<Self>) {
        let settings = StageSettings {
            projects_loaded: self.state.projects_loaded,
            projects: self
                .state
                .projects
                .iter()
                .map(|project| StageProject {
                    path: project.path.clone(),
                    name: project.name.clone(),
                })
                .collect(),
            workspace_branch: self
                .stage_controls
                .workspace_info
                .as_ref()
                .and_then(|info| info.branch.clone()),
            branches: self.stage_controls.branches.clone(),
            checkpoints: self.stage_controls.checkpoints.clone(),
            branch_switching: self.stage_controls.switching_branch.is_some(),
        };
        self.chat
            .update(cx, |chat, cx| chat.update_stage_settings(settings, cx));
    }

    pub(super) fn select_workspace_branch(&mut self, branch: String, cx: &mut Context<Self>) {
        if self.selected_thread_id.is_some() || self.stage_controls.switching_branch.is_some() {
            return;
        }
        let Some(path) = self.active_project_path.clone() else {
            return;
        };
        if self
            .stage_controls
            .workspace_info
            .as_ref()
            .and_then(|info| info.branch.as_deref())
            == Some(branch.as_str())
        {
            return;
        }
        self.stage_controls.workspace_generation =
            self.stage_controls.workspace_generation.wrapping_add(1);
        let generation = self.stage_controls.workspace_generation;
        self.stage_controls.switching_branch = Some(branch.clone());
        self.sync_stage_settings(cx);
        let update = self.state.switch_workspace_branch(path, branch, generation);
        self.apply_client_update(update, cx);
    }

    pub(super) fn open_rollback(&mut self, cx: &mut Context<Self>) {
        let Some(thread_id) = self.selected_thread_id.clone() else {
            return;
        };
        if self.stage_controls.checkpoints.is_empty() || self.active_session_running() {
            return;
        }
        self.close_session_search(cx);
        self.close_sidebar_controls(cx);
        self.stage_controls.rollback.open = true;
        self.stage_controls.rollback.transition =
            self.stage_controls.rollback.transition.wrapping_add(1);
        self.stage_controls.rollback.generation =
            self.stage_controls.rollback.generation.wrapping_add(1);
        self.stage_controls.rollback.thread_id = Some(thread_id);
        self.stage_controls.rollback.loading_id = None;
        self.stage_controls.rollback.inspection = None;
        self.stage_controls.rollback.restoring = false;
        cx.notify();
    }

    pub(super) fn open_rollback_checkpoint(&mut self, checkpoint_id: u64, cx: &mut Context<Self>) {
        let checkpoint = self
            .stage_controls
            .checkpoints
            .iter()
            .find(|checkpoint| checkpoint.id == checkpoint_id)
            .cloned();
        let Some(checkpoint) = checkpoint else {
            return;
        };
        self.open_rollback(cx);
        self.inspect_checkpoint(checkpoint, cx);
    }

    pub(super) fn close_rollback(&mut self, cx: &mut Context<Self>) {
        if !self.stage_controls.rollback.open
            && self.stage_controls.rollback.thread_id.is_none()
            && self.stage_controls.rollback.inspection.is_none()
        {
            return;
        }
        self.stage_controls.rollback.open = false;
        self.stage_controls.rollback.generation =
            self.stage_controls.rollback.generation.wrapping_add(1);
        self.stage_controls.rollback.thread_id = None;
        self.stage_controls.rollback.loading_id = None;
        self.stage_controls.rollback.inspection = None;
        self.stage_controls.rollback.restoring = false;
        cx.notify();
    }

    fn inspect_checkpoint(&mut self, checkpoint: CheckpointSummary, cx: &mut Context<Self>) {
        if !self.stage_controls.rollback.open
            || self.stage_controls.rollback.loading_id.is_some()
            || self.stage_controls.rollback.restoring
        {
            return;
        }
        let Some(thread_id) = self.stage_controls.rollback.thread_id.clone() else {
            return;
        };
        self.stage_controls.rollback.generation =
            self.stage_controls.rollback.generation.wrapping_add(1);
        let generation = self.stage_controls.rollback.generation;
        self.stage_controls.rollback.loading_id = Some(checkpoint.id);
        self.stage_controls.rollback.inspection = None;
        let update = self
            .state
            .request_changed_since(thread_id, checkpoint.id, generation);
        self.apply_client_update(update, cx);
        cx.notify();
    }

    fn restore_inspected_checkpoint(&mut self, cx: &mut Context<Self>) {
        if self.stage_controls.rollback.restoring {
            return;
        }
        let Some(thread_id) = self.stage_controls.rollback.thread_id.clone() else {
            return;
        };
        let Some(inspection) = self.stage_controls.rollback.inspection.as_ref() else {
            return;
        };
        let checkpoint_id = inspection.checkpoint.id;
        let generation = self.stage_controls.rollback.generation;
        self.stage_controls.rollback.restoring = true;
        let update = self
            .state
            .restore_checkpoint(thread_id, checkpoint_id, generation);
        self.apply_client_update(update, cx);
        cx.notify();
    }

    fn reverse_restore(&mut self, cx: &mut Context<Self>) {
        if self.stage_controls.undo_busy {
            return;
        }
        let Some(undo) = self.stage_controls.undo_restore.as_ref() else {
            return;
        };
        self.stage_controls.undo_generation = self.stage_controls.undo_generation.wrapping_add(1);
        let generation = self.stage_controls.undo_generation;
        self.stage_controls.undo_busy = true;
        let update =
            self.state
                .undo_restore(undo.thread_id.clone(), undo.token.clone(), generation);
        self.apply_client_update(update, cx);
        cx.notify();
    }

    pub(super) fn dismiss_global_notice(&mut self, cx: &mut Context<Self>) {
        self.state.notice = None;
        self.stage_controls.undo_restore = None;
        self.stage_controls.undo_busy = false;
        cx.notify();
    }

    pub(super) fn apply_workspace_info(
        &mut self,
        path: String,
        generation: u64,
        info: WorkspaceInfo,
        cx: &mut Context<Self>,
    ) {
        if self.stage_controls.workspace_path.as_deref() != Some(path.as_str())
            || self.stage_controls.workspace_generation != generation
        {
            return;
        }
        self.stage_controls.workspace_info_loading = false;
        if let Some(branch) = info.branch.clone()
            && !self.stage_controls.branches.contains(&branch)
        {
            self.stage_controls.branches.insert(0, branch);
        }
        self.stage_controls.workspace_info = Some(info);
        self.sync_stage_settings(cx);
        cx.notify();
    }

    pub(super) fn apply_workspace_branches(
        &mut self,
        path: String,
        generation: u64,
        mut branches: Vec<String>,
        cx: &mut Context<Self>,
    ) {
        if self.stage_controls.workspace_path.as_deref() != Some(path.as_str())
            || self.stage_controls.workspace_generation != generation
        {
            return;
        }
        self.stage_controls.branches_loading = false;
        if let Some(branch) = self
            .stage_controls
            .workspace_info
            .as_ref()
            .and_then(|info| info.branch.clone())
            && !branches.contains(&branch)
        {
            branches.insert(0, branch);
        }
        self.stage_controls.branches = branches;
        self.sync_stage_settings(cx);
        cx.notify();
    }

    pub(super) fn apply_workspace_switched(
        &mut self,
        path: String,
        branch: String,
        generation: u64,
        info: WorkspaceInfo,
        cx: &mut Context<Self>,
    ) {
        if self.stage_controls.workspace_path.as_deref() != Some(path.as_str())
            || self.stage_controls.workspace_generation != generation
        {
            return;
        }
        self.stage_controls.switching_branch = None;
        self.stage_controls.workspace_info = Some(info);
        self.stage_controls.branches.retain(|item| item != &branch);
        self.stage_controls.branches.insert(0, branch);
        self.sync_stage_settings(cx);
        cx.notify();
    }

    pub(super) fn apply_workspace_error(
        &mut self,
        path: String,
        generation: u64,
        operation: WorkspaceOperation,
        message: String,
        cx: &mut Context<Self>,
    ) {
        if self.stage_controls.workspace_path.as_deref() != Some(path.as_str())
            || self.stage_controls.workspace_generation != generation
        {
            return;
        }
        match operation {
            WorkspaceOperation::Info => self.stage_controls.workspace_info_loading = false,
            WorkspaceOperation::Branches => self.stage_controls.branches_loading = false,
            WorkspaceOperation::Switch => {
                self.stage_controls.switching_branch = None;
                self.state.notice = Some(message);
            }
        }
        self.sync_stage_settings(cx);
        cx.notify();
    }

    pub(super) fn apply_checkpoints(
        &mut self,
        thread_id: String,
        generation: u64,
        checkpoints: Vec<CheckpointSummary>,
        cx: &mut Context<Self>,
    ) {
        if self.stage_controls.checkpoint_thread_id.as_deref() != Some(thread_id.as_str())
            || self.stage_controls.checkpoint_generation != generation
        {
            return;
        }
        self.stage_controls.checkpoints_loading = false;
        self.stage_controls.checkpoints = checkpoints;
        self.sync_stage_settings(cx);
        cx.notify();
    }

    pub(super) fn apply_changed_since(
        &mut self,
        thread_id: String,
        checkpoint_id: u64,
        generation: u64,
        files: Vec<String>,
        cx: &mut Context<Self>,
    ) {
        let rollback = &mut self.stage_controls.rollback;
        if !rollback.open
            || rollback.thread_id.as_deref() != Some(thread_id.as_str())
            || rollback.generation != generation
            || rollback.loading_id != Some(checkpoint_id)
        {
            return;
        }
        rollback.loading_id = None;
        if let Some(checkpoint) = self
            .stage_controls
            .checkpoints
            .iter()
            .find(|checkpoint| checkpoint.id == checkpoint_id)
            .cloned()
        {
            rollback.inspection = Some(RollbackInspection { checkpoint, files });
        }
        cx.notify();
    }

    pub(super) fn apply_checkpoint_restored(
        &mut self,
        thread_id: String,
        checkpoint_id: u64,
        generation: u64,
        undo: String,
        cx: &mut Context<Self>,
    ) {
        let rollback = &self.stage_controls.rollback;
        if !rollback.open
            || rollback.thread_id.as_deref() != Some(thread_id.as_str())
            || rollback.generation != generation
            || rollback
                .inspection
                .as_ref()
                .map(|inspection| inspection.checkpoint.id)
                != Some(checkpoint_id)
        {
            return;
        }
        let label = rollback
            .inspection
            .as_ref()
            .map(|inspection| inspection.checkpoint.label.clone())
            .unwrap_or_else(|| "checkpoint".into());
        self.stage_controls.undo_restore = Some(UndoRestore {
            thread_id: thread_id.clone(),
            token: undo,
        });
        self.stage_controls.undo_busy = false;
        self.state.notice = Some(format!("Restored to before “{label}”."));
        self.close_rollback(cx);
        self.state.request_history(&thread_id, None);
        self.refresh_stage_context(cx);
    }

    pub(super) fn apply_restore_undone(
        &mut self,
        thread_id: String,
        generation: u64,
        cx: &mut Context<Self>,
    ) {
        let matching = self
            .stage_controls
            .undo_restore
            .as_ref()
            .is_some_and(|undo| undo.thread_id == thread_id)
            && self.stage_controls.undo_generation == generation;
        if !matching {
            return;
        }
        self.stage_controls.undo_busy = false;
        self.stage_controls.undo_restore = None;
        self.state.notice = Some("Restore undone.".into());
        self.state.request_history(&thread_id, None);
        self.refresh_stage_context(cx);
    }

    pub(super) fn apply_rollback_error(
        &mut self,
        thread_id: String,
        generation: u64,
        operation: RollbackOperation,
        message: String,
        cx: &mut Context<Self>,
    ) {
        match operation {
            RollbackOperation::Checkpoints
                if self.stage_controls.checkpoint_thread_id.as_deref()
                    == Some(thread_id.as_str())
                    && self.stage_controls.checkpoint_generation == generation =>
            {
                self.stage_controls.checkpoints_loading = false;
                self.stage_controls.checkpoints.clear();
                self.sync_stage_settings(cx);
            }
            RollbackOperation::Inspect
                if self.stage_controls.rollback.thread_id.as_deref()
                    == Some(thread_id.as_str())
                    && self.stage_controls.rollback.generation == generation =>
            {
                self.stage_controls.rollback.loading_id = None;
                self.state.notice = Some(message);
            }
            RollbackOperation::Restore
                if self.stage_controls.rollback.thread_id.as_deref()
                    == Some(thread_id.as_str())
                    && self.stage_controls.rollback.generation == generation =>
            {
                self.stage_controls.rollback.restoring = false;
                self.state.notice = Some(message);
            }
            RollbackOperation::Undo
                if self
                    .stage_controls
                    .undo_restore
                    .as_ref()
                    .is_some_and(|undo| undo.thread_id == thread_id)
                    && self.stage_controls.undo_generation == generation =>
            {
                self.stage_controls.undo_busy = false;
                self.state.notice = Some(message);
            }
            _ => return,
        }
        cx.notify();
    }

    pub(super) fn apply_usage_summary(
        &mut self,
        scope: UsageScope,
        generation: u64,
        summary: UsageSummaryResult,
        cx: &mut Context<Self>,
    ) {
        if self.stage_controls.usage_scope.as_ref() != Some(&scope)
            || self.stage_controls.usage_generation != generation
        {
            return;
        }
        self.stage_controls.usage_loading = false;
        self.stage_controls.usage = Some(summary);
        cx.notify();
    }

    pub(super) fn apply_usage_error(
        &mut self,
        scope: UsageScope,
        generation: u64,
        _message: String,
        cx: &mut Context<Self>,
    ) {
        if self.stage_controls.usage_scope.as_ref() != Some(&scope)
            || self.stage_controls.usage_generation != generation
        {
            return;
        }
        self.stage_controls.usage_loading = false;
        self.stage_controls.usage = None;
        cx.notify();
    }

    pub(super) fn rollback_overlay(&self, cx: &Context<Self>) -> Option<AnyElement> {
        if !self.stage_controls.rollback.open {
            return None;
        }
        let theme = self.theme;
        let rollback = &self.stage_controls.rollback;
        let selected_id = rollback
            .inspection
            .as_ref()
            .map(|inspection| inspection.checkpoint.id);
        let disabled = rollback.loading_id.is_some() || rollback.restoring;
        let rows = self
            .stage_controls
            .checkpoints
            .iter()
            .rev()
            .cloned()
            .enumerate()
            .map(|(index, checkpoint)| {
                let selected = selected_id == Some(checkpoint.id);
                let loading = rollback.loading_id == Some(checkpoint.id);
                let value = checkpoint.clone();
                div()
                    .id(("rollback-checkpoint", index))
                    .group("rollback-checkpoint-hover")
                    .w_full()
                    .flex()
                    .items_center()
                    .gap(px(10.0))
                    .px(px(10.0))
                    .py(px(9.0))
                    .rounded(px(8.0))
                    .when(selected, |row| row.bg(theme.surface_2.hsla()))
                    .text_color(if selected {
                        theme.text.hsla()
                    } else {
                        theme.text_2.hsla()
                    })
                    .when(!disabled, |row| {
                        row.cursor_pointer()
                            .hover(move |style| style.bg(theme.surface_2.hsla()))
                            .on_click(cx.listener(move |this, _event, _window, cx| {
                                this.inspect_checkpoint(value.clone(), cx);
                            }))
                    })
                    .child(motion_icon(
                        ("rollback-checkpoint-icon", checkpoint.id),
                        "icons/history.svg",
                        13.0,
                        "rollback-checkpoint-hover",
                        theme,
                    ))
                    .child(
                        div()
                            .min_w(px(0.0))
                            .flex_1()
                            .flex()
                            .flex_col()
                            .child(
                                div()
                                    .truncate()
                                    .text_size(px(12.5))
                                    .line_height(relative(1.55))
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(format!("Before “{}”", checkpoint.label)),
                            )
                            .child(
                                div()
                                    .mt(px(2.0))
                                    .truncate()
                                    .text_size(px(11.5))
                                    .line_height(relative(1.55))
                                    .text_color(theme.text_3.hsla())
                                    .child(format_checkpoint_time(checkpoint.created_at)),
                            ),
                    )
                    .when(loading, |row| {
                        row.child(
                            svg()
                                .path("icons/loader-circle.svg")
                                .size(px(11.0))
                                .text_color(theme.text_3.hsla())
                                .with_animation(
                                    ("rollback-spinner", checkpoint.id),
                                    theme.repeating_animation(Duration::from_millis(700)),
                                    |spinner, delta| {
                                        spinner.with_transformation(gpui::Transformation::rotate(
                                            gpui::percentage(delta),
                                        ))
                                    },
                                ),
                        )
                    })
            });
        let inspection = rollback
            .inspection
            .as_ref()
            .map(|inspection| self.rollback_confirmation(inspection, cx));
        Some(
            div()
                .absolute()
                .inset_0()
                .flex()
                .items_center()
                .justify_center()
                .p(px(32.0))
                .child(
                    div()
                        .id("rollback-scrim")
                        .absolute()
                        .inset_0()
                        .bg(gpui::black().opacity(0.55))
                        .cursor_default()
                        .on_click(cx.listener(|this, _event, _window, cx| {
                            this.close_rollback(cx);
                        }))
                        .with_animation(
                            ("rollback-scrim", rollback.transition),
                            Animation::new(theme.motion.fast)
                                .with_easing(crate::theme::web_ease_out),
                            |scrim, delta| scrim.opacity(delta),
                        ),
                )
                .child(
                    div()
                        .id("rollback-panel-scroll")
                        .occlude()
                        .relative()
                        .w_full()
                        .max_w(px(520.0))
                        .max_h(relative(1.0))
                        .overflow_y_scroll()
                        .rounded(px(10.0))
                        .border_1()
                        .border_color(theme.line_strong.hsla())
                        .bg(chrome::rail_background(theme))
                        .shadow(chrome::modal_shadows(theme))
                        .child(
                            div()
                                .min_h(px(71.0))
                                .flex()
                                .items_center()
                                .justify_between()
                                .px(px(16.0))
                                .pt(px(14.0))
                                .pb(px(10.0))
                                .child(
                                    div()
                                        .min_w(px(0.0))
                                        .flex_1()
                                        .child(
                                            div()
                                                .text_size(px(15.0))
                                                .line_height(relative(1.55))
                                                .font_weight(FontWeight(560.0))
                                                .text_color(theme.text.hsla())
                                                .child(tracked_text(
                                                    "Return to a checkpoint",
                                                    -0.014,
                                                )),
                                        )
                                        .child(
                                            div()
                                                .mt(px(3.0))
                                                .text_size(px(12.5))
                                                .line_height(relative(1.55))
                                                .text_color(theme.text_3.hsla())
                                                .child(
                                                    "Files and conversation move back together.",
                                                ),
                                        ),
                                )
                                .child(
                                    div()
                                        .id("rollback-close")
                                        .group("rollback-close-hover")
                                        .size(px(22.0))
                                        .flex_none()
                                        .flex()
                                        .items_center()
                                        .justify_center()
                                        .rounded(px(3.0))
                                        .text_color(theme.text_3.hsla())
                                        .cursor_pointer()
                                        .hover(move |style| {
                                            style
                                                .bg(theme.surface_2.hsla())
                                                .text_color(theme.text.hsla())
                                        })
                                        .active(|style| style.size(px(20.68)).m(px(0.66)))
                                        .on_click(cx.listener(|this, _event, _window, cx| {
                                            this.close_rollback(cx);
                                        }))
                                        .child(
                                            div()
                                                .id("rollback-close-icon-press")
                                                .size(px(13.0))
                                                .group_active("rollback-close-hover", |style| {
                                                    style.size(px(12.22)).m(px(0.39))
                                                })
                                                .child(
                                                    motion_icon(
                                                        "rollback-close-icon",
                                                        "icons/x.svg",
                                                        13.0,
                                                        "rollback-close-hover",
                                                        theme,
                                                    )
                                                    .size_full(),
                                                ),
                                        ),
                                ),
                        )
                        .child(
                            div()
                                .id("rollback-checkpoint-list")
                                .max_h(px(260.0))
                                .overflow_y_scroll()
                                .flex()
                                .flex_col()
                                .gap(px(3.0))
                                .px(px(10.0))
                                .pt(px(4.0))
                                .pb(px(10.0))
                                .children(rows),
                        )
                        .when_some(inspection, |panel, inspection| panel.child(inspection))
                        .with_animation(
                            ("rollback-panel", rollback.transition),
                            Animation::new(theme.motion_duration(Duration::from_millis(220)))
                                .with_easing(crate::theme::web_ease_out),
                            |panel, delta| panel.top(px(8.0 * (1.0 - delta))).opacity(delta),
                        ),
                )
                .into_any_element(),
        )
    }

    fn rollback_confirmation(
        &self,
        inspection: &RollbackInspection,
        cx: &Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let files = inspection.files.clone();
        let count = files.len();
        let restoring = self.stage_controls.rollback.restoring;
        div()
            .border_t_1()
            .border_color(theme.line.hsla())
            .px(px(16.0))
            .pt(px(12.0))
            .pb(px(16.0))
            .text_size(px(12.5))
            .line_height(relative(1.55))
            .text_color(theme.text_2.hsla())
            .child(if count == 0 {
                SharedString::from(
                    "This restores the conversation and leaves the current files unchanged.",
                )
            } else {
                SharedString::from(format!(
                    "This restores the conversation and {count} changed file{}:",
                    if count == 1 { "" } else { "s" }
                ))
            })
            .when(!files.is_empty(), |section| {
                section.child(
                    div()
                        .id("rollback-files")
                        .mt(px(8.0))
                        .max_h(px(120.0))
                        .overflow_y_scroll()
                        .pl(px(24.0))
                        .font_family("Geist Mono")
                        .text_size(px(11.5))
                        .line_height(relative(1.55))
                        .text_color(theme.text.hsla())
                        .children(files.into_iter().enumerate().map(|(index, file)| {
                            div()
                                .id(("rollback-file", index))
                                .truncate()
                                .child(format!("• {file}"))
                        })),
                )
            })
            .child(
                div()
                    .mt(px(8.0))
                    .text_color(theme.text_3.hsla())
                    .child("You can undo this restore afterwards."),
            )
            .child(
                div()
                    .mt(px(14.0))
                    .flex()
                    .justify_end()
                    .gap(px(6.0))
                    .child(modal_button(
                        "rollback-cancel",
                        "Cancel",
                        false,
                        restoring,
                        theme,
                        Some(cx.listener(|this, _event, _window, cx| {
                            this.close_rollback(cx);
                        })),
                    ))
                    .child(modal_button(
                        "rollback-restore",
                        if restoring {
                            "Restoring…"
                        } else {
                            "Restore checkpoint"
                        },
                        true,
                        restoring,
                        theme,
                        Some(cx.listener(|this, _event, _window, cx| {
                            this.restore_inspected_checkpoint(cx);
                        })),
                    )),
            )
            .into_any_element()
    }

    pub(super) fn global_notice(&self, cx: &Context<Self>) -> Option<AnyElement> {
        let message = self.state.notice.clone()?;
        let theme = self.theme;
        let can_undo = self.stage_controls.undo_restore.is_some();
        Some(
            div()
                .absolute()
                .bottom(px(18.0))
                .left_0()
                .w_full()
                .flex()
                .justify_center()
                .px(px(18.0))
                .child(
                    div()
                        .w_auto()
                        .max_w(px(620.0))
                        .min_h(px(39.0))
                        .flex()
                        .items_center()
                        .gap(px(8.0))
                        .px(px(10.0))
                        .py(px(9.0))
                        .rounded(px(5.0))
                        .border_1()
                        .border_color(theme.line_strong.hsla())
                        .bg(theme.surface_2.hsla())
                        .text_size(px(12.5))
                        .line_height(relative(1.55))
                        .text_color(theme.text.hsla())
                        .child(
                            div()
                                .min_w(px(0.0))
                                .max_h(px(58.2))
                                .overflow_hidden()
                                .flex_1()
                                .child(message),
                        )
                        .when(can_undo, |notice| {
                            notice.child(toast_button(
                                "notice-undo-restore",
                                "Undo restore",
                                self.stage_controls.undo_busy,
                                theme,
                                cx.listener(|this, _event, _window, cx| this.reverse_restore(cx)),
                            ))
                        })
                        .child(toast_button(
                            "notice-dismiss",
                            "Dismiss",
                            false,
                            theme,
                            cx.listener(|this, _event, _window, cx| {
                                this.dismiss_global_notice(cx);
                            }),
                        )),
                )
                .into_any_element(),
        )
    }

    pub(super) fn offline_notice(&self) -> Option<AnyElement> {
        if !self.reconnect_notice_visible {
            return None;
        }
        let theme = self.theme;
        Some(
            div()
                .absolute()
                .bottom(px(62.0))
                .left_0()
                .w_full()
                .flex()
                .justify_center()
                .px(px(18.0))
                .child(
                    div()
                        .w_auto()
                        .max_w(px(620.0))
                        .min_h(px(39.0))
                        .flex()
                        .items_center()
                        .gap(px(8.0))
                        .px(px(10.0))
                        .py(px(9.0))
                        .rounded(px(5.0))
                        .border_1()
                        .border_color(theme.attention.mix_srgb(theme.line_strong, 0.55).hsla())
                        .bg(theme.surface_2.hsla())
                        .text_size(px(12.5))
                        .line_height(relative(1.55))
                        .text_color(theme.text_2.hsla())
                        .child(
                            svg()
                                .path("icons/loader-circle.svg")
                                .size(px(11.0))
                                .flex_none()
                                .with_animation(
                                    "offline-notice-spinner",
                                    theme.repeating_animation(Duration::from_millis(700)),
                                    |spinner, delta| {
                                        spinner.with_transformation(gpui::Transformation::rotate(
                                            gpui::percentage(delta),
                                        ))
                                    },
                                ),
                        )
                        .child("Reconnecting to the server…"),
                )
                .into_any_element(),
        )
    }

    fn active_session_running(&self) -> bool {
        let Some(thread_id) = self.selected_thread_id.as_deref() else {
            return false;
        };
        self.state
            .projects
            .iter()
            .flat_map(|project| project.sessions.iter())
            .find(|session| session.id == thread_id)
            .is_some_and(|session| session.running)
    }
}

fn format_checkpoint_time(timestamp_ms: f64) -> SharedString {
    let timestamp = timestamp_ms.round() as i64;
    DateTime::from_timestamp_millis(timestamp).map_or_else(
        || SharedString::from("Unknown time"),
        |date| {
            SharedString::from(
                date.with_timezone(&Local)
                    .format("%b %-d, %Y at %-I:%M %p")
                    .to_string(),
            )
        },
    )
}

fn modal_button(
    id: &'static str,
    label: &'static str,
    primary: bool,
    disabled: bool,
    theme: crate::theme::Theme,
    action: Option<impl Fn(&gpui::ClickEvent, &mut gpui::Window, &mut gpui::App) + 'static>,
) -> AnyElement {
    let on_primary = match theme.mode {
        ThemeMode::Dark => gpui::rgb(0x101010).into(),
        ThemeMode::Light => gpui::rgb(0xfefefe).into(),
    };
    let padding_x = if primary { 15.0 } else { 8.0 };
    let padding_y = if primary { 7.0 } else { 4.0 };
    let radius = if primary { 5.0 } else { 3.0 };
    let font_size = if primary { 13.5 } else { 12.5 };
    let group: SharedString = format!("{id}:press").into();
    let sizing = div()
        .px(px(padding_x))
        .py(px(padding_y))
        .flex()
        .items_center()
        .justify_center()
        .text_size(px(font_size))
        .line_height(relative(1.55))
        .font_weight(if primary {
            FontWeight(540.0)
        } else {
            FontWeight::NORMAL
        })
        .invisible()
        .child(label);
    let visual = div()
        .id(SharedString::from(format!("{id}:visual")))
        .absolute()
        .inset_0()
        .px(px(padding_x))
        .py(px(padding_y))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(radius))
        .bg(if primary {
            theme.text.hsla()
        } else {
            gpui::transparent_black()
        })
        .text_size(px(font_size))
        .line_height(relative(1.55))
        .font_weight(if primary {
            FontWeight(540.0)
        } else {
            FontWeight::NORMAL
        })
        .text_color(if primary {
            on_primary
        } else {
            theme.text_2.hsla()
        })
        .when(!disabled, |button| {
            button
                .when(!primary, |button| {
                    button.group_hover(group.clone(), move |style| {
                        style
                            .bg(theme.surface_3.hsla())
                            .text_color(theme.text.hsla())
                    })
                })
                .when(primary, |button| {
                    button.group_active(group.clone(), move |style| {
                        style
                            .top(relative(0.015))
                            .right(relative(0.015))
                            .bottom(relative(0.015))
                            .left(relative(0.015))
                            .px(px(padding_x * 0.97))
                            .py(px(padding_y * 0.97))
                            .rounded(px(radius * 0.97))
                            .text_size(px(font_size * 0.97))
                    })
                })
        })
        .child(label);
    div()
        .id(id)
        .group(group)
        .relative()
        .flex_none()
        .opacity(if disabled && primary { 0.28 } else { 1.0 })
        .when(!disabled, |button| button.cursor_pointer())
        .when_some(action, |button, action| button.on_click(action))
        .child(sizing)
        .child(visual)
        .into_any_element()
}

fn toast_button(
    id: &'static str,
    label: &'static str,
    disabled: bool,
    theme: crate::theme::Theme,
    action: impl Fn(&gpui::ClickEvent, &mut gpui::Window, &mut gpui::App) + 'static,
) -> AnyElement {
    div()
        .id(id)
        .flex_none()
        .flex()
        .items_center()
        .px(px(8.0))
        .py(px(4.0))
        .rounded(px(3.0))
        .text_size(px(12.5))
        .line_height(relative(1.55))
        .text_color(theme.text_2.hsla())
        .when(!disabled, |button| {
            button
                .cursor_pointer()
                .hover(move |style| {
                    style
                        .bg(theme.surface_3.hsla())
                        .text_color(theme.text.hsla())
                })
                .on_click(action)
        })
        .child(label)
        .into_any_element()
}
