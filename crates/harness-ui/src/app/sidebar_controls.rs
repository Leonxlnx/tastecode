use super::HarnessApp;
use crate::chrome;
use crate::motion_icon::motion_icon;
use crate::sidebar::{
    SelectionModifiers, SidebarMenuAnchor, SidebarMenuRequest, ordered_inbox_ids,
};
use crate::tracked_text::tracked_text;
use crate::zoom::px;
use chrono::{Datelike, Duration as ChronoDuration, Local, Timelike};
use gpui::{
    Animation, AnimationExt, AnyElement, ClipboardItem, Context, Entity, FocusHandle, FontWeight,
    Pixels, SharedString, Window, div, prelude::*, relative,
};
use gpui_component::input::{Input, InputState, SelectAll};
use harness_protocol::{SessionSummary, ThreadInboxStatus, ThreadLifecycle};
use std::collections::{HashMap, HashSet, VecDeque};
use std::process::Command;

pub(super) struct SidebarControlsState {
    pub(super) menu: Option<SidebarMenuState>,
    dialog: Option<SidebarDialog>,
    pub(super) input: Entity<InputState>,
    reset_value: Option<String>,
    focus_pending: bool,
    archive_queue: VecDeque<String>,
    discarding_checkout: Option<String>,
    pub(super) selected_ids: HashSet<String>,
    pub(super) selection_anchor: Option<String>,
    pub(super) row_focus: HashMap<String, FocusHandle>,
}

pub(super) struct SidebarMenuState {
    request: SidebarMenuRequest,
    anchor: SidebarMenuAnchor,
}

#[derive(Clone)]
enum SidebarDialog {
    RenameProject {
        path: String,
    },
    RenameThread {
        thread_id: String,
    },
    RemoveProject {
        path: String,
    },
    ArchiveProject {
        path: String,
        thread_ids: Vec<String>,
    },
    DiscardCheckout {
        thread_id: String,
    },
}

#[derive(Clone, Copy)]
enum SidebarLifecycleAction {
    Settle,
    Snooze(u64),
    Wake,
    Unsettle,
}

impl SidebarControlsState {
    pub(super) fn new(input: Entity<InputState>) -> Self {
        Self {
            menu: None,
            dialog: None,
            input,
            reset_value: None,
            focus_pending: false,
            archive_queue: VecDeque::new(),
            discarding_checkout: None,
            selected_ids: HashSet::new(),
            selection_anchor: None,
            row_focus: HashMap::new(),
        }
    }

    pub(super) fn is_open(&self) -> bool {
        self.menu.is_some() || self.dialog.is_some()
    }

    pub(super) fn is_renaming(&self) -> bool {
        matches!(
            self.dialog,
            Some(SidebarDialog::RenameProject { .. } | SidebarDialog::RenameThread { .. })
        )
    }

    pub(super) fn renaming_project(&self) -> Option<&str> {
        match self.dialog.as_ref() {
            Some(SidebarDialog::RenameProject { path }) => Some(path),
            _ => None,
        }
    }

    pub(super) fn renaming_thread(&self) -> Option<&str> {
        match self.dialog.as_ref() {
            Some(SidebarDialog::RenameThread { thread_id }) => Some(thread_id),
            _ => None,
        }
    }

    pub(super) fn sync_inbox_rows(&mut self, ordered_ids: &[String], cx: &mut Context<HarnessApp>) {
        let visible = ordered_ids.iter().cloned().collect::<HashSet<_>>();
        self.selected_ids
            .retain(|thread_id| visible.contains(thread_id));
        if self
            .selection_anchor
            .as_ref()
            .is_some_and(|thread_id| !visible.contains(thread_id))
        {
            self.selection_anchor = None;
        }
        self.row_focus
            .retain(|thread_id, _| visible.contains(thread_id));
        for thread_id in ordered_ids {
            self.row_focus
                .entry(thread_id.clone())
                .or_insert_with(|| cx.focus_handle());
        }
    }

    pub(super) fn clear_selection(&mut self) {
        self.selected_ids.clear();
    }
}

impl HarnessApp {
    pub(super) fn choose_inbox_session(
        &mut self,
        thread_id: String,
        modifiers: SelectionModifiers,
        cx: &mut Context<Self>,
    ) {
        let query = self.sidebar_search.read(cx).value();
        let ordered = ordered_inbox_ids(
            &self.state.projects,
            self.sidebar_scope.as_deref(),
            query.as_ref(),
        );
        if modifiers.shift
            && let Some(anchor) = self.sidebar_controls.selection_anchor.as_ref()
            && let (Some(from), Some(to)) = (
                ordered.iter().position(|id| id == anchor),
                ordered.iter().position(|id| id == &thread_id),
            )
        {
            let (start, end) = if from < to { (from, to) } else { (to, from) };
            self.sidebar_controls.selected_ids = ordered[start..=end].iter().cloned().collect();
            cx.notify();
            return;
        }
        if modifiers.additive {
            if !self
                .sidebar_controls
                .selected_ids
                .remove(thread_id.as_str())
            {
                self.sidebar_controls.selected_ids.insert(thread_id.clone());
            }
            self.sidebar_controls.selection_anchor = Some(thread_id);
            cx.notify();
            return;
        }
        self.sidebar_controls.clear_selection();
        self.sidebar_controls.selection_anchor = Some(thread_id.clone());
        self.select_session(thread_id, cx);
    }

    pub(super) fn open_sidebar_menu(
        &mut self,
        mut request: SidebarMenuRequest,
        anchor: SidebarMenuAnchor,
        cx: &mut Context<Self>,
    ) {
        if let SidebarMenuRequest::ThreadSelection { target, thread_ids } = &request {
            self.sidebar_controls.selected_ids = thread_ids.iter().cloned().collect();
            self.sidebar_controls.selection_anchor = Some(target.clone());
            if thread_ids.len() == 1 {
                request = SidebarMenuRequest::Thread(target.clone());
            }
        }
        self.close_rollback(cx);
        self.account_menu_open = false;
        self.sidebar_controls.dialog = None;
        self.sidebar_controls.menu = Some(SidebarMenuState { request, anchor });
        cx.notify();
    }

    pub(super) fn close_sidebar_controls(&mut self, cx: &mut Context<Self>) {
        self.sidebar_controls.menu = None;
        self.sidebar_controls.discarding_checkout = None;
        if let Some(SidebarDialog::DiscardCheckout { thread_id }) =
            self.sidebar_controls.dialog.take()
            && self.sidebar_controls.archive_queue.front() == Some(&thread_id)
        {
            self.sidebar_controls.archive_queue.clear();
        }
        cx.notify();
    }

    pub(super) fn prepare_sidebar_controls_input(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(value) = self.sidebar_controls.reset_value.take() {
            self.sidebar_controls.input.update(cx, |input, cx| {
                input.set_value(value, window, cx);
            });
        }
        if self.sidebar_controls.focus_pending {
            self.sidebar_controls
                .input
                .update(cx, |input, cx| input.focus(window, cx));
            self.sidebar_controls.focus_pending = false;
            cx.on_next_frame(window, |_this, window, cx| {
                window.dispatch_action(Box::new(SelectAll), cx);
            });
        }
    }

    pub(super) fn commit_sidebar_dialog(&mut self, cx: &mut Context<Self>) {
        let value = self
            .sidebar_controls
            .input
            .read(cx)
            .value()
            .trim()
            .to_owned();
        if value.is_empty() {
            if self.sidebar_controls.is_renaming() {
                self.sidebar_controls.dialog = None;
                cx.notify();
            }
            return;
        }
        let Some(dialog) = self.sidebar_controls.dialog.take() else {
            return;
        };
        let update = match dialog {
            SidebarDialog::RenameProject { path } => self.state.rename_project(path, value),
            SidebarDialog::RenameThread { thread_id } => {
                self.chat.update(cx, |chat, cx| {
                    chat.rename_session(&thread_id, value.clone(), cx);
                });
                self.state.rename_thread(thread_id, value)
            }
            other => {
                self.sidebar_controls.dialog = Some(other);
                return;
            }
        };
        self.apply_client_update(update, cx);
        cx.notify();
    }

    pub(super) fn show_archive_confirmation(&mut self, thread_id: String, cx: &mut Context<Self>) {
        self.sidebar_controls.menu = None;
        self.sidebar_controls.discarding_checkout = None;
        self.sidebar_controls.dialog = Some(SidebarDialog::DiscardCheckout { thread_id });
        cx.notify();
    }

    pub(super) fn handle_thread_archived(&mut self, thread_id: String, cx: &mut Context<Self>) {
        if self.sidebar_controls.discarding_checkout.as_deref() == Some(thread_id.as_str()) {
            self.sidebar_controls.discarding_checkout = None;
            self.sidebar_controls.dialog = None;
        }
        if self.selected_thread_id.as_deref() == Some(thread_id.as_str()) {
            self.select_next_active_or_draft(&thread_id, cx);
        }
        if self.sidebar_controls.archive_queue.front() == Some(&thread_id) {
            self.sidebar_controls.archive_queue.pop_front();
            self.archive_next_queued_thread(cx);
        }
        cx.notify();
    }

    pub(super) fn handle_thread_archive_failed(
        &mut self,
        thread_id: String,
        cx: &mut Context<Self>,
    ) {
        if self.sidebar_controls.discarding_checkout.as_deref() == Some(thread_id.as_str()) {
            self.sidebar_controls.discarding_checkout = None;
        }
        cx.notify();
    }

    fn archive_next_queued_thread(&mut self, cx: &mut Context<Self>) {
        let Some(thread_id) = self.sidebar_controls.archive_queue.front().cloned() else {
            return;
        };
        let update = self.state.archive_thread(thread_id);
        self.apply_client_update(update, cx);
    }

    fn begin_rename_project(&mut self, path: String, cx: &mut Context<Self>) {
        let Some(name) = self
            .state
            .projects
            .iter()
            .find(|project| project.path == path)
            .map(|project| project.name.clone())
        else {
            return;
        };
        self.sidebar_controls.menu = None;
        self.sidebar_controls.dialog = Some(SidebarDialog::RenameProject { path });
        self.sidebar_controls.reset_value = Some(name);
        self.sidebar_controls.focus_pending = true;
        cx.notify();
    }

    pub(super) fn begin_rename_thread(&mut self, thread_id: String, cx: &mut Context<Self>) {
        let Some(title) = self
            .state
            .projects
            .iter()
            .flat_map(|project| project.sessions.iter())
            .find(|session| session.id == thread_id)
            .map(|session| session.title.clone())
        else {
            return;
        };
        self.sidebar_controls.menu = None;
        self.sidebar_controls.clear_selection();
        self.sidebar_controls.dialog = Some(SidebarDialog::RenameThread { thread_id });
        self.sidebar_controls.reset_value = Some(title);
        self.sidebar_controls.focus_pending = true;
        cx.notify();
    }

    fn confirm_remove_project(&mut self, path: String, cx: &mut Context<Self>) {
        self.sidebar_controls.menu = None;
        self.sidebar_controls.dialog = Some(SidebarDialog::RemoveProject { path });
        cx.notify();
    }

    fn confirm_archive_project(&mut self, path: String, cx: &mut Context<Self>) {
        let thread_ids = self
            .state
            .projects
            .iter()
            .find(|project| project.path == path)
            .map(|project| {
                project
                    .sessions
                    .iter()
                    .map(|session| session.id.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        self.sidebar_controls.menu = None;
        self.sidebar_controls.dialog = Some(SidebarDialog::ArchiveProject { path, thread_ids });
        cx.notify();
    }

    fn run_sidebar_update(
        &mut self,
        update: crate::client_state::ClientUpdate,
        cx: &mut Context<Self>,
    ) {
        self.sidebar_controls.menu = None;
        self.sidebar_controls.clear_selection();
        self.apply_client_update(update, cx);
        cx.notify();
    }

    fn run_sidebar_lifecycle_many(
        &mut self,
        thread_ids: Vec<String>,
        action: SidebarLifecycleAction,
        cx: &mut Context<Self>,
    ) {
        let mut seen = HashSet::new();
        let thread_ids = thread_ids
            .into_iter()
            .filter(|thread_id| seen.insert(thread_id.clone()))
            .collect::<Vec<_>>();
        let hidden = thread_ids.iter().cloned().collect::<HashSet<_>>();
        if matches!(
            action,
            SidebarLifecycleAction::Settle | SidebarLifecycleAction::Snooze(_)
        ) && self
            .selected_thread_id
            .as_ref()
            .is_some_and(|thread_id| hidden.contains(thread_id))
        {
            self.select_next_active_or_draft_excluding(&hidden, cx);
        }
        self.sidebar_controls.menu = None;
        self.sidebar_controls.clear_selection();
        for thread_id in thread_ids {
            let update = match action {
                SidebarLifecycleAction::Settle => self.state.settle_thread(thread_id),
                SidebarLifecycleAction::Snooze(wake_at) => {
                    self.state.snooze_thread(thread_id, wake_at)
                }
                SidebarLifecycleAction::Wake => self.state.unsnooze_thread(thread_id),
                SidebarLifecycleAction::Unsettle => self.state.unsettle_thread(thread_id),
            };
            self.apply_client_update(update, cx);
        }
        cx.notify();
    }

    fn archive_sidebar_threads(&mut self, thread_ids: Vec<String>, cx: &mut Context<Self>) {
        let mut seen = HashSet::new();
        let thread_ids = thread_ids
            .into_iter()
            .filter(|thread_id| seen.insert(thread_id.clone()))
            .collect::<Vec<_>>();
        if thread_ids.is_empty() {
            return;
        }
        self.sidebar_controls.menu = None;
        self.sidebar_controls.clear_selection();
        self.sidebar_controls.archive_queue = thread_ids.into();
        self.archive_next_queued_thread(cx);
        cx.notify();
    }

    fn confirm_sidebar_dialog(&mut self, cx: &mut Context<Self>) {
        let Some(dialog) = self.sidebar_controls.dialog.take() else {
            return;
        };
        match dialog {
            SidebarDialog::RenameProject { .. } | SidebarDialog::RenameThread { .. } => {
                self.sidebar_controls.dialog = Some(dialog);
                self.commit_sidebar_dialog(cx);
            }
            SidebarDialog::RemoveProject { path } => {
                let update = self.state.remove_project(path);
                self.apply_client_update(update, cx);
            }
            SidebarDialog::ArchiveProject { thread_ids, .. } => {
                self.sidebar_controls.archive_queue = thread_ids.into();
                self.archive_next_queued_thread(cx);
            }
            SidebarDialog::DiscardCheckout { thread_id } => {
                self.sidebar_controls.discarding_checkout = Some(thread_id.clone());
                self.sidebar_controls.dialog = Some(SidebarDialog::DiscardCheckout {
                    thread_id: thread_id.clone(),
                });
                let update = self.state.force_archive_thread(thread_id);
                self.apply_client_update(update, cx);
            }
        }
        cx.notify();
    }

    pub(super) fn sidebar_controls_overlay(
        &self,
        window: &Window,
        cx: &Context<Self>,
    ) -> Option<AnyElement> {
        if let Some(dialog) = self.sidebar_controls.dialog.clone() {
            let inline_rename = matches!(dialog, SidebarDialog::RenameThread { .. })
                || (self.state.sidebar_settings.mode == harness_protocol::SidebarMode::Classic
                    && matches!(dialog, SidebarDialog::RenameProject { .. }));
            if inline_rename {
                return None;
            }
            return Some(self.sidebar_dialog_overlay(dialog, cx));
        }
        let menu = self.sidebar_controls.menu.as_ref()?;
        let request = menu.request.clone();
        let anchor = menu.anchor;
        let theme = self.theme;
        let mut items = Vec::new();
        let mut rule_count = 0_usize;
        let mut selection_count = 0_usize;

        match request {
            SidebarMenuRequest::Project(path) => {
                let project = self
                    .state
                    .projects
                    .iter()
                    .find(|project| project.path == path)?
                    .clone();
                let pin_path = path.clone();
                let project_pinned = project.pinned;
                items.push(sidebar_project_menu_item(
                    "sidebar-project-pin",
                    if project_pinned {
                        "Unpin"
                    } else {
                        "Pin to top"
                    },
                    Some(if project_pinned {
                        "icons/pin-off.svg"
                    } else {
                        "icons/pin.svg"
                    }),
                    false,
                    theme,
                    cx.listener(move |this, _event, _window, cx| {
                        let update = this.state.pin_project(pin_path.clone(), !project_pinned);
                        this.run_sidebar_update(update, cx);
                    }),
                ));
                let reveal = path.clone();
                items.push(sidebar_project_menu_item(
                    "sidebar-project-reveal",
                    "Open in Explorer",
                    Some("icons/folder-open.svg"),
                    false,
                    theme,
                    cx.listener(move |this, _event, _window, cx| {
                        this.sidebar_controls.menu = None;
                        if let Err(error) = reveal_path(&reveal) {
                            this.state.notice =
                                Some(format!("Could not open that folder: {error}"));
                        }
                        cx.notify();
                    }),
                ));
                let rename = path.clone();
                items.push(sidebar_project_menu_item(
                    "sidebar-project-rename",
                    "Edit name",
                    Some("icons/pencil.svg"),
                    false,
                    theme,
                    cx.listener(move |this, _event, _window, cx| {
                        this.begin_rename_project(rename.clone(), cx);
                    }),
                ));
                let archive = path.clone();
                items.push(sidebar_project_menu_item(
                    "sidebar-project-archive",
                    "Archive chats",
                    Some("icons/archive.svg"),
                    false,
                    theme,
                    cx.listener(move |this, _event, _window, cx| {
                        this.confirm_archive_project(archive.clone(), cx);
                    }),
                ));
                items.push(sidebar_project_menu_item(
                    "sidebar-project-remove",
                    "Remove from sidebar",
                    Some("icons/panel-left-close.svg"),
                    true,
                    theme,
                    cx.listener(move |this, _event, _window, cx| {
                        this.confirm_remove_project(path.clone(), cx);
                    }),
                ));
            }
            SidebarMenuRequest::Thread(thread_id) => {
                let (project, session) = self.state.projects.iter().find_map(|project| {
                    project
                        .sessions
                        .iter()
                        .find(|session| session.id == thread_id)
                        .map(|session| (project.clone(), session.clone()))
                })?;
                if self.state.sidebar_settings.mode == harness_protocol::SidebarMode::Classic {
                    let pin_id = thread_id.clone();
                    let thread_pinned = session.pinned;
                    items.push(sidebar_menu_item(
                        "sidebar-thread-pin",
                        if thread_pinned {
                            "Unpin chat"
                        } else {
                            "Pin chat"
                        },
                        None,
                        false,
                        theme,
                        cx.listener(move |this, _event, _window, cx| {
                            let update = this.state.pin_thread(pin_id.clone(), !thread_pinned);
                            this.run_sidebar_update(update, cx);
                        }),
                    ));
                    let rename_id = thread_id.clone();
                    items.push(sidebar_menu_item(
                        "sidebar-thread-rename",
                        "Rename chat",
                        None,
                        false,
                        theme,
                        cx.listener(move |this, _event, _window, cx| {
                            this.begin_rename_thread(rename_id.clone(), cx);
                        }),
                    ));
                    let archive_id = thread_id.clone();
                    items.push(sidebar_menu_item(
                        "sidebar-thread-archive",
                        "Archive chat",
                        None,
                        false,
                        theme,
                        cx.listener(move |this, _event, _window, cx| {
                            let update = this.state.archive_thread(archive_id.clone());
                            this.run_sidebar_update(update, cx);
                        }),
                    ));
                    let reveal = project.path;
                    items.push(sidebar_menu_item(
                        "sidebar-thread-reveal",
                        "Open in Explorer",
                        None,
                        false,
                        theme,
                        cx.listener(move |this, _event, _window, cx| {
                            this.sidebar_controls.menu = None;
                            this.sidebar_controls.clear_selection();
                            if let Err(error) = reveal_path(&reveal) {
                                this.state.notice =
                                    Some(format!("Could not open that folder: {error}"));
                            }
                            cx.notify();
                        }),
                    ));
                } else {
                    match session.lifecycle.as_ref() {
                        Some(ThreadLifecycle::Snoozed { .. }) => {
                            let id = thread_id.clone();
                            items.push(sidebar_menu_item(
                                "sidebar-thread-wake",
                                "Wake now",
                                Some("icons/bell.svg"),
                                false,
                                theme,
                                cx.listener(move |this, _event, _window, cx| {
                                    let update = this.state.unsnooze_thread(id.clone());
                                    this.run_sidebar_update(update, cx);
                                }),
                            ));
                        }
                        Some(ThreadLifecycle::Settled { .. }) => {
                            let id = thread_id.clone();
                            items.push(sidebar_menu_item(
                                "sidebar-thread-unsettle",
                                "Un-settle",
                                Some("icons/check-check.svg"),
                                false,
                                theme,
                                cx.listener(move |this, _event, _window, cx| {
                                    let update = this.state.unsettle_thread(id.clone());
                                    this.run_sidebar_update(update, cx);
                                }),
                            ));
                        }
                        Some(ThreadLifecycle::Active { .. }) | None => {
                            if can_hide(&session) {
                                let settle_id = thread_id.clone();
                                items.push(sidebar_menu_item(
                                    "sidebar-thread-settle",
                                    "Settle",
                                    Some("icons/check-check.svg"),
                                    false,
                                    theme,
                                    cx.listener(move |this, _event, _window, cx| {
                                        let update = this.state.settle_thread(settle_id.clone());
                                        this.run_sidebar_update(update, cx);
                                    }),
                                ));
                                for (index, (label, wake_at)) in
                                    snooze_presets().into_iter().enumerate()
                                {
                                    let id = thread_id.clone();
                                    items.push(sidebar_menu_item(
                                        SharedString::from(format!(
                                            "sidebar-thread-snooze-{index}"
                                        )),
                                        label,
                                        Some("icons/clock-3.svg"),
                                        false,
                                        theme,
                                        cx.listener(move |this, _event, _window, cx| {
                                            let update =
                                                this.state.snooze_thread(id.clone(), wake_at);
                                            this.run_sidebar_update(update, cx);
                                        }),
                                    ));
                                }
                                let keep_id = thread_id.clone();
                                let keep_active = match session.lifecycle.as_ref() {
                                    Some(ThreadLifecycle::Active { keep_active, .. }) => {
                                        *keep_active
                                    }
                                    _ => false,
                                };
                                items.push(sidebar_menu_item(
                                    "sidebar-thread-keep-active",
                                    if keep_active {
                                        "Allow auto-settle"
                                    } else {
                                        "Keep active"
                                    },
                                    None,
                                    false,
                                    theme,
                                    cx.listener(move |this, _event, _window, cx| {
                                        let update = this
                                            .state
                                            .set_thread_keep_active(keep_id.clone(), !keep_active);
                                        this.run_sidebar_update(update, cx);
                                    }),
                                ));
                            }
                        }
                    }
                    items.push(sidebar_menu_rule("sidebar-thread-edit-rule-in", theme));
                    rule_count += 1;
                    let rename_id = thread_id.clone();
                    items.push(sidebar_menu_item(
                        "sidebar-thread-rename",
                        "Rename",
                        None,
                        false,
                        theme,
                        cx.listener(move |this, _event, _window, cx| {
                            this.begin_rename_thread(rename_id.clone(), cx);
                        }),
                    ));
                    let pin_id = thread_id.clone();
                    let thread_pinned = session.pinned;
                    items.push(sidebar_menu_item(
                        "sidebar-thread-pin",
                        if thread_pinned {
                            "Unpin thread"
                        } else {
                            "Pin thread"
                        },
                        Some(if thread_pinned {
                            "icons/pin-off.svg"
                        } else {
                            "icons/pin.svg"
                        }),
                        false,
                        theme,
                        cx.listener(move |this, _event, _window, cx| {
                            let update = this.state.pin_thread(pin_id.clone(), !thread_pinned);
                            this.run_sidebar_update(update, cx);
                        }),
                    ));
                    let project_path = project.path.clone();
                    items.push(sidebar_menu_item(
                        "sidebar-thread-copy-project",
                        "Copy project path",
                        Some("icons/copy.svg"),
                        false,
                        theme,
                        cx.listener(move |this, _event, _window, cx| {
                            this.sidebar_controls.menu = None;
                            this.sidebar_controls.clear_selection();
                            cx.write_to_clipboard(ClipboardItem::new_string(project_path.clone()));
                            cx.notify();
                        }),
                    ));
                    if let Some(branch) = session.worktree_branch.clone() {
                        items.push(sidebar_menu_item(
                            "sidebar-thread-copy-branch",
                            "Copy branch",
                            Some("icons/git-branch.svg"),
                            false,
                            theme,
                            cx.listener(move |this, _event, _window, cx| {
                                this.sidebar_controls.menu = None;
                                this.sidebar_controls.clear_selection();
                                cx.write_to_clipboard(ClipboardItem::new_string(branch.clone()));
                                cx.notify();
                            }),
                        ));
                    }
                    items.push(sidebar_menu_rule("sidebar-thread-delete-rule-in", theme));
                    rule_count += 1;
                    items.push(sidebar_menu_item(
                        "sidebar-thread-archive",
                        "Delete thread",
                        Some("icons/trash-2.svg"),
                        true,
                        theme,
                        cx.listener(move |this, _event, _window, cx| {
                            let update = this.state.archive_thread(thread_id.clone());
                            this.run_sidebar_update(update, cx);
                        }),
                    ));
                }
            }
            SidebarMenuRequest::ThreadSelection {
                target: _,
                thread_ids,
            } => {
                let sessions = thread_ids
                    .iter()
                    .filter_map(|thread_id| {
                        self.state
                            .projects
                            .iter()
                            .flat_map(|project| project.sessions.iter())
                            .find(|session| session.id == *thread_id)
                            .cloned()
                    })
                    .collect::<Vec<_>>();
                if sessions.is_empty() {
                    return None;
                }
                let selected = sessions
                    .iter()
                    .map(|session| session.id.clone())
                    .collect::<Vec<_>>();
                let active = sessions
                    .iter()
                    .filter(|session| {
                        matches!(
                            session.lifecycle.as_ref(),
                            Some(ThreadLifecycle::Active { .. }) | None
                        ) && can_hide(session)
                    })
                    .map(|session| session.id.clone())
                    .collect::<Vec<_>>();
                let snoozed = sessions
                    .iter()
                    .filter(|session| {
                        matches!(
                            session.lifecycle.as_ref(),
                            Some(ThreadLifecycle::Snoozed { .. })
                        )
                    })
                    .map(|session| session.id.clone())
                    .collect::<Vec<_>>();
                let settled = sessions
                    .iter()
                    .filter(|session| {
                        matches!(
                            session.lifecycle.as_ref(),
                            Some(ThreadLifecycle::Settled { .. })
                        )
                    })
                    .map(|session| session.id.clone())
                    .collect::<Vec<_>>();
                items.push(sidebar_menu_selection(sessions.len(), theme));
                selection_count += 1;
                if !active.is_empty() {
                    let settle_ids = active.clone();
                    items.push(sidebar_menu_item(
                        "sidebar-thread-settle-many",
                        format!("Settle {}", thread_count(active.len())),
                        Some("icons/check-check.svg"),
                        false,
                        theme,
                        cx.listener(move |this, _event, _window, cx| {
                            this.run_sidebar_lifecycle_many(
                                settle_ids.clone(),
                                SidebarLifecycleAction::Settle,
                                cx,
                            );
                        }),
                    ));
                    for (index, (label, wake_at)) in snooze_presets().into_iter().enumerate() {
                        let ids = active.clone();
                        items.push(sidebar_menu_item(
                            SharedString::from(format!("sidebar-thread-snooze-many-{index}")),
                            format!("{label} · {}", thread_count(active.len())),
                            Some("icons/clock-3.svg"),
                            false,
                            theme,
                            cx.listener(move |this, _event, _window, cx| {
                                this.run_sidebar_lifecycle_many(
                                    ids.clone(),
                                    SidebarLifecycleAction::Snooze(wake_at),
                                    cx,
                                );
                            }),
                        ));
                    }
                }
                if !snoozed.is_empty() {
                    let ids = snoozed.clone();
                    items.push(sidebar_menu_item(
                        "sidebar-thread-wake-many",
                        format!("Wake {}", thread_count(snoozed.len())),
                        Some("icons/bell.svg"),
                        false,
                        theme,
                        cx.listener(move |this, _event, _window, cx| {
                            this.run_sidebar_lifecycle_many(
                                ids.clone(),
                                SidebarLifecycleAction::Wake,
                                cx,
                            );
                        }),
                    ));
                }
                if !settled.is_empty() {
                    let ids = settled.clone();
                    items.push(sidebar_menu_item(
                        "sidebar-thread-unsettle-many",
                        format!("Un-settle {}", thread_count(settled.len())),
                        Some("icons/check-check.svg"),
                        false,
                        theme,
                        cx.listener(move |this, _event, _window, cx| {
                            this.run_sidebar_lifecycle_many(
                                ids.clone(),
                                SidebarLifecycleAction::Unsettle,
                                cx,
                            );
                        }),
                    ));
                }
                items.push(sidebar_menu_rule("sidebar-selection-delete-rule-in", theme));
                rule_count += 1;
                items.push(sidebar_menu_item(
                    "sidebar-thread-archive-many",
                    format!("Delete {} threads", selected.len()),
                    Some("icons/trash-2.svg"),
                    true,
                    theme,
                    cx.listener(move |this, _event, _window, cx| {
                        this.archive_sidebar_threads(selected.clone(), cx);
                    }),
                ));
            }
            SidebarMenuRequest::Snooze(thread_id) => {
                for (index, (label, wake_at)) in snooze_presets().into_iter().enumerate() {
                    let id = thread_id.clone();
                    items.push(sidebar_menu_item(
                        SharedString::from(format!("sidebar-quick-snooze-{index}")),
                        label,
                        None,
                        false,
                        theme,
                        cx.listener(move |this, _event, _window, cx| {
                            let update = this.state.snooze_thread(id.clone(), wake_at);
                            this.run_sidebar_update(update, cx);
                        }),
                    ));
                }
            }
        }

        let panel_width = px(210.0);
        let viewport = window.viewport_size();
        let row_count = items.len().saturating_sub(rule_count + selection_count);
        let content_height =
            row_count as f32 * 33.0 + rule_count as f32 * 9.0 + selection_count as f32 * 29.0;
        let viewport_height = f32::from(viewport.height) / crate::zoom::factor();
        let max_panel_height = (viewport_height - 16.0).clamp(0.0, 340.0);
        let panel_height_value = (content_height + 10.0).min(max_panel_height);
        let position = sidebar_menu_position(
            anchor,
            viewport.width,
            viewport.height,
            panel_width,
            px(panel_height_value),
        );
        let left = position.left;
        let top = position.top;
        let grows_up = position.grows_up;

        Some(
            div()
                .absolute()
                .inset(px(0.0))
                .child(
                    div()
                        .id("sidebar-menu-scrim")
                        .absolute()
                        .inset(px(0.0))
                        .on_click(cx.listener(|this, _event, _window, cx| {
                            this.close_sidebar_controls(cx);
                        })),
                )
                .child(
                    div()
                        .id("sidebar-context-panel")
                        .absolute()
                        .left(left)
                        .top(top)
                        .w(panel_width)
                        .max_h(px(max_panel_height))
                        .overflow_y_scroll()
                        .occlude()
                        .rounded(px(8.0))
                        .border_1()
                        .border_color(chrome::menu_border(theme))
                        .bg(chrome::menu_background(theme))
                        .shadow(chrome::flyout_shadows(theme))
                        .p(px(4.0))
                        .children(items)
                        .with_animation(
                            "sidebar-context-panel-in",
                            Animation::new(theme.motion.fast)
                                .with_easing(crate::theme::web_ease_out),
                            move |panel, delta| {
                                let scale = sidebar_menu_entry_scale(delta);
                                let anchor_offset = if grows_up {
                                    panel_height_value * (1.0 - scale)
                                } else {
                                    0.0
                                };
                                panel
                                    .left(left + px(105.0 * (1.0 - scale)))
                                    .top(top + px(anchor_offset + 2.0 * (1.0 - delta)))
                                    .w(px(210.0 * scale))
                                    .rounded(px(8.0 * scale))
                                    .p(px(4.0 * scale))
                                    .opacity(delta)
                            },
                        ),
                )
                .into_any_element(),
        )
    }

    fn sidebar_dialog_overlay(&self, dialog: SidebarDialog, cx: &Context<Self>) -> AnyElement {
        if let SidebarDialog::DiscardCheckout { thread_id } = &dialog {
            return self.checkout_discard_overlay(thread_id, cx);
        }
        let theme = self.theme;
        let (title, body, action, destructive, rename): (
            SharedString,
            SharedString,
            SharedString,
            bool,
            bool,
        ) = match &dialog {
            SidebarDialog::RenameProject { .. } => (
                "Edit project name".into(),
                "".into(),
                "Save".into(),
                false,
                true,
            ),
            SidebarDialog::RenameThread { .. } => {
                ("Rename chat".into(), "".into(), "Save".into(), false, true)
            }
            SidebarDialog::RemoveProject { .. } => (
                "Remove project?".into(),
                "This only removes the project from the sidebar. Its folder and chats stay untouched."
                    .into(),
                "Remove project".into(),
                true,
                false,
            ),
            SidebarDialog::ArchiveProject { path, .. } => {
                let name = self
                    .state
                    .projects
                    .iter()
                    .find(|project| project.path == *path)
                    .map_or(path.as_str(), |project| project.name.as_str());
                (
                    "Archive all chats?".into(),
                    format!(
                        "This archives every chat in {name}. Files on your computer stay untouched."
                    )
                    .into(),
                    "Archive chats".into(),
                    false,
                    false,
                )
            }
            SidebarDialog::DiscardCheckout { thread_id } => {
                let (title, branch) = self
                    .state
                    .projects
                    .iter()
                    .flat_map(|project| project.sessions.iter())
                    .find(|session| session.id == *thread_id)
                    .map_or(("this thread", "isolated checkout"), |session| {
                        (
                            session.title.as_str(),
                            session
                                .worktree_branch
                                .as_deref()
                                .unwrap_or("isolated checkout"),
                        )
                    });
                (
                    "Discard uncommitted work?".into(),
                    format!(
                        "{title} has uncommitted changes in {branch}. Deleting it discards those changes and removes the private checkout."
                    )
                    .into(),
                    "Discard and delete".into(),
                    true,
                    false,
                )
            }
        };
        let input = rename.then(|| {
            Input::new(&self.sidebar_controls.input)
                .appearance(false)
                .bordered(true)
                .focus_bordered(true)
                .h(px(34.0))
                .w_full()
        });

        div()
            .absolute()
            .inset(px(0.0))
            .flex()
            .items_center()
            .justify_center()
            .p(px(32.0))
            .child(
                div()
                    .id("sidebar-dialog-scrim")
                    .absolute()
                    .inset(px(0.0))
                    .bg(gpui::black().opacity(0.55))
                    .on_click(cx.listener(|this, _event, _window, cx| {
                        this.close_sidebar_controls(cx);
                    }))
                    .with_animation(
                        "sidebar-dialog-scrim-in",
                        Animation::new(theme.motion.fast).with_easing(crate::theme::web_ease_out),
                        |scrim, delta| scrim.opacity(delta),
                    ),
            )
            .child(
                div()
                    .id("sidebar-dialog-panel")
                    .w_full()
                    .max_w(px(210.0))
                    .min_h(px(174.0))
                    .max_h(relative(1.0))
                    .flex()
                    .flex_col()
                    .overflow_y_scroll()
                    .occlude()
                    .rounded(px(10.0))
                    .border_1()
                    .border_color(theme.line_strong.hsla())
                    .bg(chrome::rail_background(theme))
                    .shadow(chrome::modal_shadows(theme))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .gap(px(8.0))
                            .px(px(12.0))
                            .pt(px(12.0))
                            .pb(px(9.0))
                            .child(
                                div()
                                    .min_w(px(0.0))
                                    .flex_1()
                                    .text_size(px(15.0))
                                    .line_height(relative(1.55))
                                    .font_weight(FontWeight(560.0))
                                    .child(tracked_text(title, -0.014)),
                            )
                            .child(
                                div()
                                    .id("sidebar-dialog-close")
                                    .group("sidebar-dialog-close-hover")
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
                                        this.close_sidebar_controls(cx);
                                    }))
                                    .child(
                                        div()
                                            .id("sidebar-dialog-close-icon-press")
                                            .size(px(13.0))
                                            .group_active("sidebar-dialog-close-hover", |style| {
                                                style.size(px(12.22)).m(px(0.39))
                                            })
                                            .child(
                                                motion_icon(
                                                    "sidebar-dialog-close-icon",
                                                    "icons/x.svg",
                                                    13.0,
                                                    "sidebar-dialog-close-hover",
                                                    theme,
                                                )
                                                .size_full(),
                                            ),
                                    ),
                            ),
                    )
                    .child(
                        div()
                            .min_h(px(0.0))
                            .flex_1()
                            .flex()
                            .flex_col()
                            .border_t_1()
                            .border_color(theme.line.hsla())
                            .px(px(12.0))
                            .pt(px(10.0))
                            .pb(px(12.0))
                            .when(!body.is_empty(), |content| {
                                content.child(
                                    div()
                                        .text_size(px(12.5))
                                        .line_height(gpui::relative(1.45))
                                        .text_color(theme.text_2.hsla())
                                        .child(body.clone()),
                                )
                            })
                            .when_some(input, |content, input| content.child(input))
                            .child(
                                div()
                                    .mt_auto()
                                    .pt(px(16.0))
                                    .flex()
                                    .justify_between()
                                    .gap(px(8.0))
                                    .child(dialog_button(
                                        "sidebar-dialog-cancel",
                                        "Cancel",
                                        false,
                                        false,
                                        theme,
                                        cx.listener(|this, _event, _window, cx| {
                                            this.close_sidebar_controls(cx);
                                        }),
                                    ))
                                    .child(dialog_button(
                                        "sidebar-dialog-confirm",
                                        action,
                                        true,
                                        destructive,
                                        theme,
                                        cx.listener(|this, _event, _window, cx| {
                                            this.confirm_sidebar_dialog(cx);
                                        }),
                                    )),
                            ),
                    )
                    .with_animation(
                        "sidebar-dialog-panel-in",
                        Animation::new(
                            theme.motion_duration(std::time::Duration::from_millis(220)),
                        )
                        .with_easing(crate::theme::web_ease_out),
                        |panel, delta| panel.top(px(8.0 * (1.0 - delta))).opacity(delta),
                    ),
            )
            .into_any_element()
    }

    fn checkout_discard_overlay(&self, thread_id: &str, cx: &Context<Self>) -> AnyElement {
        let theme = self.theme;
        let session = self
            .state
            .projects
            .iter()
            .flat_map(|project| project.sessions.iter())
            .find(|session| session.id == thread_id);
        let title = session.map_or("this thread", |session| session.title.as_str());
        let branch = session
            .and_then(|session| session.worktree_branch.as_deref())
            .unwrap_or("isolated checkout");
        let busy = self.sidebar_controls.discarding_checkout.as_deref() == Some(thread_id);

        div()
            .absolute()
            .inset(px(0.0))
            .flex()
            .items_center()
            .justify_center()
            .p(px(32.0))
            .child(
                div()
                    .id("checkout-discard-scrim")
                    .absolute()
                    .inset(px(0.0))
                    .bg(gpui::black().opacity(0.55))
                    .cursor_default()
                    .on_click(cx.listener(|this, _event, _window, cx| {
                        this.close_sidebar_controls(cx);
                    }))
                    .with_animation(
                        "checkout-discard-scrim",
                        Animation::new(theme.motion.fast)
                            .with_easing(crate::theme::web_ease_out),
                        |scrim, delta| scrim.opacity(delta),
                    ),
            )
            .child(
                div()
                    .id("checkout-discard-panel")
                    .occlude()
                    .relative()
                    .w_full()
                    .max_w(px(460.0))
                    .max_h(relative(1.0))
                    .overflow_y_scroll()
                    .rounded(px(10.0))
                    .border_1()
                    .border_color(theme.line_strong.hsla())
                    .bg(chrome::rail_background(theme))
                    .shadow(chrome::modal_shadows(theme))
                    .child(
                        div()
                            .w_full()
                            .flex()
                            .items_center()
                            .justify_between()
                            .gap(px(16.0))
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
                                                "This checkout has uncommitted work",
                                                -0.014,
                                            )),
                                    )
                                    .child(
                                        div()
                                            .mt(px(3.0))
                                            .flex()
                                            .items_center()
                                            .gap(px(5.0))
                                            .font_family("Geist Mono")
                                            .text_size(px(11.5))
                                            .line_height(relative(1.55))
                                            .text_color(theme.text_3.hsla())
                                            .child(motion_icon(
                                                "checkout-discard-branch-icon",
                                                "icons/git-branch.svg",
                                                12.0,
                                                "checkout-discard-branch-icon-direct-hover",
                                                theme,
                                            ))
                                            .child(
                                                div()
                                                    .min_w(px(0.0))
                                                    .truncate()
                                                    .child(branch.to_owned()),
                                            ),
                                    ),
                            )
                            .child(
                                div()
                                    .id("checkout-discard-close")
                                    .group("checkout-discard-close-hover")
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
                                        this.close_sidebar_controls(cx);
                                    }))
                                    .child(
                                        div()
                                            .id("checkout-discard-close-icon-press")
                                            .size(px(13.0))
                                            .group_active(
                                                "checkout-discard-close-hover",
                                                |style| {
                                                    style.size(px(12.22)).m(px(0.39))
                                                },
                                            )
                                            .child(
                                                motion_icon(
                                                    "checkout-discard-close-icon",
                                                    "icons/x.svg",
                                                    13.0,
                                                    "checkout-discard-close-hover",
                                                    theme,
                                                )
                                                .size_full(),
                                            ),
                                    ),
                            ),
                    )
                    .child(
                        div()
                            .w_full()
                            .border_t_1()
                            .border_color(theme.line.hsla())
                            .px(px(16.0))
                            .pt(px(12.0))
                            .pb(px(16.0))
                            .child(
                                div()
                                    .text_size(px(12.5))
                                    .line_height(relative(1.55))
                                    .text_color(theme.text_2.hsla())
                                    .child(format!(
                                        "Archiving “{title}” now would discard changes the agent has not committed."
                                    )),
                            )
                            .child(
                                div()
                                    .mt(px(16.0))
                                    .flex()
                                    .justify_end()
                                    .gap(px(6.0))
                                    .child(checkout_dialog_button(
                                        "checkout-discard-keep",
                                        "Keep session",
                                        false,
                                        busy,
                                        theme,
                                        cx.listener(|this, _event, _window, cx| {
                                            this.close_sidebar_controls(cx);
                                        }),
                                    ))
                                    .child(checkout_dialog_button(
                                        "checkout-discard-confirm",
                                        if busy {
                                            "Discarding…"
                                        } else {
                                            "Discard changes and archive"
                                        },
                                        true,
                                        busy,
                                        theme,
                                        cx.listener(|this, _event, _window, cx| {
                                            this.confirm_sidebar_dialog(cx);
                                        }),
                                    )),
                            ),
                    )
                    .with_animation(
                        "checkout-discard-panel",
                        Animation::new(
                            theme.motion_duration(std::time::Duration::from_millis(220)),
                        )
                        .with_easing(crate::theme::web_ease_out),
                        |panel, delta| panel.top(px(8.0 * (1.0 - delta))).opacity(delta),
                    ),
            )
            .into_any_element()
    }
}

const SIDEBAR_MENU_ENTRY_SCALE_FROM: f32 = 0.97;
const SIDEBAR_MENU_GAP: f32 = 6.0;
const SIDEBAR_MENU_VIEWPORT_GUTTER: f32 = 8.0;

fn sidebar_menu_entry_scale(progress: f32) -> f32 {
    SIDEBAR_MENU_ENTRY_SCALE_FROM + (1.0 - SIDEBAR_MENU_ENTRY_SCALE_FROM) * progress
}

fn sidebar_menu_entry_animation(theme: crate::Theme) -> Animation {
    Animation::new(theme.motion.fast).with_easing(crate::theme::web_ease_out)
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct SidebarMenuPosition {
    left: Pixels,
    top: Pixels,
    grows_up: bool,
}

fn sidebar_menu_position(
    anchor: SidebarMenuAnchor,
    viewport_width: Pixels,
    viewport_height: Pixels,
    panel_width: Pixels,
    panel_height: Pixels,
) -> SidebarMenuPosition {
    let (preferred_left, anchor_top, anchor_bottom, gap) = match anchor {
        SidebarMenuAnchor::Context(point) => (point.x, point.y, point.y, px(0.0)),
        SidebarMenuAnchor::Trigger(bounds) => (
            bounds.origin.x + bounds.size.width - panel_width,
            bounds.origin.y,
            bounds.origin.y + bounds.size.height,
            px(SIDEBAR_MENU_GAP),
        ),
    };
    let gutter = px(SIDEBAR_MENU_VIEWPORT_GUTTER);
    let space_above = anchor_top - gap - gutter;
    let space_below = viewport_height - anchor_bottom - gap - gutter;
    let grows_up = panel_height > space_below && space_above > space_below;
    let preferred_top = if grows_up {
        anchor_top - gap - panel_height
    } else {
        anchor_bottom + gap
    };
    let max_left = (viewport_width - panel_width - gutter).max(gutter);
    let max_top = (viewport_height - panel_height - gutter).max(gutter);
    SidebarMenuPosition {
        left: preferred_left.clamp(gutter, max_left),
        top: preferred_top.clamp(gutter, max_top),
        grows_up,
    }
}

fn sidebar_project_menu_item(
    id: impl Into<SharedString>,
    label: impl Into<SharedString>,
    icon_path: Option<&'static str>,
    danger: bool,
    theme: crate::Theme,
    listener: impl Fn(&gpui::ClickEvent, &mut Window, &mut gpui::App) + 'static,
) -> AnyElement {
    sidebar_menu_item_with_icon_size(id, label, icon_path, 14.0, danger, theme, listener)
}

fn sidebar_menu_item(
    id: impl Into<SharedString>,
    label: impl Into<SharedString>,
    icon_path: Option<&'static str>,
    danger: bool,
    theme: crate::Theme,
    listener: impl Fn(&gpui::ClickEvent, &mut Window, &mut gpui::App) + 'static,
) -> AnyElement {
    sidebar_menu_item_with_icon_size(id, label, icon_path, 13.0, danger, theme, listener)
}

#[allow(clippy::too_many_arguments)]
fn sidebar_menu_item_with_icon_size(
    id: impl Into<SharedString>,
    label: impl Into<SharedString>,
    icon_path: Option<&'static str>,
    icon_size: f32,
    danger: bool,
    theme: crate::Theme,
    listener: impl Fn(&gpui::ClickEvent, &mut Window, &mut gpui::App) + 'static,
) -> AnyElement {
    let id = id.into();
    let hover_group: SharedString = format!("{id}:hover").into();
    let icon_id: SharedString = format!("{id}:icon").into();
    let icon_animation_id: SharedString = format!("{id}:icon-in").into();
    let animation_id: SharedString = format!("{id}:in").into();
    div()
        .id(id)
        .group(hover_group.clone())
        .w_full()
        .flex()
        .items_center()
        .gap(px(8.0))
        .px(px(9.0))
        .py(px(6.0))
        .rounded(px(5.0))
        .text_size(px(13.5))
        .text_color(if danger {
            theme.error.hsla()
        } else {
            theme.text_2.hsla()
        })
        .cursor_pointer()
        .hover(move |style| {
            style
                .bg(if danger {
                    theme.error.hsla().opacity(0.12).into()
                } else {
                    chrome::menu_hover_background(theme)
                })
                .text_color(if danger {
                    theme.error.hsla()
                } else {
                    theme.text.hsla()
                })
        })
        .on_click(listener)
        .when_some(icon_path, |item, icon_path| {
            item.child(
                div()
                    .size(px(icon_size))
                    .flex_none()
                    .child(
                        motion_icon(icon_id, icon_path, icon_size, hover_group, theme).size_full(),
                    )
                    .with_animation(
                        icon_animation_id,
                        sidebar_menu_entry_animation(theme),
                        move |icon, delta| {
                            icon.size(px(icon_size * sidebar_menu_entry_scale(delta)))
                        },
                    ),
            )
        })
        .child(label.into())
        .with_animation(
            animation_id,
            sidebar_menu_entry_animation(theme),
            |item, delta| {
                let scale = sidebar_menu_entry_scale(delta);
                item.gap(px(8.0 * scale))
                    .px(px(9.0 * scale))
                    .py(px(6.0 * scale))
                    .rounded(px(5.0 * scale))
                    .text_size(px(13.5 * scale))
            },
        )
        .into_any_element()
}

fn sidebar_menu_selection(count: usize, theme: crate::Theme) -> AnyElement {
    div()
        .h(px(28.0))
        .flex()
        .items_center()
        .px(px(9.0))
        .text_size(px(11.5))
        .text_color(theme.text_3.hsla())
        .child(format!("{count} selected"))
        .with_animation(
            "sidebar-menu-selection-in",
            sidebar_menu_entry_animation(theme),
            |selection, delta| {
                let scale = sidebar_menu_entry_scale(delta);
                selection
                    .h(px(28.0 * scale))
                    .px(px(9.0 * scale))
                    .text_size(px(11.5 * scale))
            },
        )
        .into_any_element()
}

fn thread_count(count: usize) -> String {
    format!("{count} {}", if count == 1 { "thread" } else { "threads" })
}

fn sidebar_menu_rule(id: &'static str, theme: crate::Theme) -> AnyElement {
    div()
        .h(px(1.0))
        .mx(px(2.0))
        .my(px(4.0))
        .bg(chrome::menu_border(theme))
        .with_animation(id, sidebar_menu_entry_animation(theme), |rule, delta| {
            let scale = sidebar_menu_entry_scale(delta);
            rule.h(px(scale)).mx(px(2.0 * scale)).my(px(4.0 * scale))
        })
        .into_any_element()
}

fn dialog_button(
    id: &'static str,
    label: impl Into<SharedString>,
    primary: bool,
    destructive: bool,
    theme: crate::Theme,
    listener: impl Fn(&gpui::ClickEvent, &mut Window, &mut gpui::App) + 'static,
) -> AnyElement {
    let label = label.into();
    let foreground = if destructive {
        gpui::rgb(0xfefefe).into()
    } else if primary {
        match theme.mode {
            crate::theme::ThemeMode::Dark => gpui::rgb(0x101010).into(),
            crate::theme::ThemeMode::Light => gpui::rgb(0xfefefe).into(),
        }
    } else {
        theme.text_2.hsla()
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
        .child(label.clone());
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
        .bg(if destructive {
            theme.error.hsla()
        } else if primary {
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
        .text_color(foreground)
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
        .child(label);
    div()
        .id(id)
        .group(group)
        .relative()
        .flex_none()
        .cursor_pointer()
        .on_click(listener)
        .child(sizing)
        .child(visual)
        .into_any_element()
}

fn checkout_dialog_button(
    id: &'static str,
    label: &'static str,
    destructive: bool,
    disabled: bool,
    theme: crate::Theme,
    listener: impl Fn(&gpui::ClickEvent, &mut Window, &mut gpui::App) + 'static,
) -> AnyElement {
    let padding_x = if destructive { 15.0 } else { 8.0 };
    let padding_y = if destructive { 7.0 } else { 4.0 };
    let radius = if destructive { 5.0 } else { 3.0 };
    let font_size = if destructive { 13.5 } else { 12.5 };
    let group: SharedString = format!("{id}:press").into();
    let sizing = div()
        .px(px(padding_x))
        .py(px(padding_y))
        .flex()
        .items_center()
        .justify_center()
        .text_size(px(font_size))
        .line_height(relative(1.55))
        .font_weight(if destructive {
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
        .bg(if destructive {
            theme.error.hsla()
        } else {
            gpui::transparent_black()
        })
        .text_size(px(font_size))
        .line_height(relative(1.55))
        .font_weight(if destructive {
            FontWeight(540.0)
        } else {
            FontWeight::NORMAL
        })
        .text_color(if destructive {
            gpui::rgb(0xfefefe).into()
        } else {
            theme.text_2.hsla()
        })
        .when(!disabled, |button| {
            button
                .when(!destructive, |button| {
                    button.group_hover(group.clone(), move |style| {
                        style
                            .bg(theme.surface_3.hsla())
                            .text_color(theme.text.hsla())
                    })
                })
                .when(destructive, |button| {
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
        .opacity(if disabled && destructive { 0.28 } else { 1.0 })
        .when(!disabled, |button| {
            button.cursor_pointer().on_click(listener)
        })
        .child(sizing)
        .child(visual)
        .into_any_element()
}

fn snooze_presets() -> Vec<(&'static str, u64)> {
    let now = Local::now();
    let in_one_hour = now + ChronoDuration::hours(1);
    let mut evening = now
        .with_hour(18)
        .and_then(|date| date.with_minute(0))
        .and_then(|date| date.with_second(0))
        .and_then(|date| date.with_nanosecond(0))
        .unwrap_or(now);
    if evening <= now {
        evening = (now + ChronoDuration::days(1))
            .with_hour(18)
            .and_then(|date| date.with_minute(0))
            .and_then(|date| date.with_second(0))
            .and_then(|date| date.with_nanosecond(0))
            .unwrap_or(now + ChronoDuration::days(1));
    }
    let tomorrow = (now + ChronoDuration::days(1))
        .with_hour(9)
        .and_then(|date| date.with_minute(0))
        .and_then(|date| date.with_second(0))
        .and_then(|date| date.with_nanosecond(0))
        .unwrap_or(now + ChronoDuration::days(1));
    let days_until_monday = 7 - i64::from(now.weekday().num_days_from_monday());
    let next_week = (now + ChronoDuration::days(days_until_monday))
        .with_hour(9)
        .and_then(|date| date.with_minute(0))
        .and_then(|date| date.with_second(0))
        .and_then(|date| date.with_nanosecond(0))
        .unwrap_or(now + ChronoDuration::days(days_until_monday));
    [
        ("In one hour", in_one_hour),
        ("This evening", evening),
        ("Tomorrow morning", tomorrow),
        ("Next week", next_week),
    ]
    .into_iter()
    .map(|(label, at)| (label, at.timestamp_millis().max(0) as u64))
    .collect()
}

fn can_hide(session: &SessionSummary) -> bool {
    !session.running
        && !matches!(
            session.status,
            Some(
                ThreadInboxStatus::Starting
                    | ThreadInboxStatus::Working
                    | ThreadInboxStatus::Queued
                    | ThreadInboxStatus::Approval
                    | ThreadInboxStatus::Input
            )
        )
}

fn reveal_path(path: &str) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(path);
        command
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("explorer.exe");
        command.arg(path);
        command
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(path);
        command
    };
    command.spawn().map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::{SidebarMenuPosition, sidebar_menu_position};
    use crate::sidebar::SidebarMenuAnchor;
    use crate::zoom::px;
    use gpui::{Bounds, point, size};

    #[test]
    fn sidebar_menu_flips_and_clamps_like_the_web_menu() {
        assert_eq!(
            sidebar_menu_position(
                SidebarMenuAnchor::Context(point(px(100.0), px(100.0))),
                px(800.0),
                px(800.0),
                px(210.0),
                px(200.0),
            ),
            SidebarMenuPosition {
                left: px(100.0),
                top: px(100.0),
                grows_up: false,
            }
        );
        assert_eq!(
            sidebar_menu_position(
                SidebarMenuAnchor::Context(point(px(750.0), px(750.0))),
                px(800.0),
                px(800.0),
                px(210.0),
                px(200.0),
            ),
            SidebarMenuPosition {
                left: px(582.0),
                top: px(550.0),
                grows_up: true,
            }
        );

        let trigger = Bounds {
            origin: point(px(250.0), px(100.0)),
            size: size(px(26.0), px(26.0)),
        };
        assert_eq!(
            sidebar_menu_position(
                SidebarMenuAnchor::Trigger(trigger),
                px(800.0),
                px(800.0),
                px(210.0),
                px(200.0),
            ),
            SidebarMenuPosition {
                left: px(66.0),
                top: px(132.0),
                grows_up: false,
            }
        );

        let bottom_trigger = Bounds {
            origin: point(px(250.0), px(730.0)),
            size: size(px(26.0), px(26.0)),
        };
        assert_eq!(
            sidebar_menu_position(
                SidebarMenuAnchor::Trigger(bottom_trigger),
                px(800.0),
                px(800.0),
                px(210.0),
                px(200.0),
            ),
            SidebarMenuPosition {
                left: px(66.0),
                top: px(524.0),
                grows_up: true,
            }
        );
    }
}
