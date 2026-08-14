use super::provider_terminal::{
    ProviderTerminalKey, ProviderTerminalPhase, ProviderTerminalSnapshot,
};
use super::{HarnessApp, MCP_TRANSPORT_MIN_HEIGHT, McpTransportResizeDrag};
use crate::chrome;
use crate::client_state::{AuthTarget, ProviderTerminalKind};
use crate::model_selection::filter_model_choices_by_query;
use crate::motion_icon::motion_icon;
use crate::preferences::{FontPreference, NativePreferences, ThemePreference};
use crate::provider_icon::{
    ProviderMark, agent_mark, connection_mark, provider_mark, provider_mark_path,
};
use crate::shortcuts::is_button_activation;
use crate::theme::{Accent, Backdrop, Theme, ThemeMode};
use crate::tracked_text::tracked_text;
use crate::zoom::px;
use gpui::{
    Animation, AnimationExt, AnyElement, App, ClipboardItem, Context, ElementId, Entity,
    FocusHandle, Focusable, FontWeight, Hsla, IntoElement, KeyDownEvent, MouseButton,
    MouseDownEvent, MouseMoveEvent, PathPromptOptions, PromptButton, PromptLevel, Render,
    RenderOnce, Rgba, SharedString, Window, deferred, div, linear_color_stop, linear_gradient,
    prelude::*, relative,
};
use gpui_component::Sizable as _;
use gpui_component::input::{Input, InputEvent, InputState};
use harness_protocol::{
    McpAuth, McpAuthMethod, McpConfigValue, McpServer, McpServerConfig, McpStartupStatus,
    McpTransport, ModelConnectionInput, ModelConnectionPreset, ModelTransport, ProviderAuth,
    ProviderId, ProviderLogin, SidebarMode, SidebarSettings, Skill, SkillScope, SkillSource,
    UpdateCheckResult,
};
use std::collections::HashMap;
use std::rc::Rc;
use std::time::{Duration, Instant};

const SETTINGS_CONTENT_WIDTH: f32 = 840.0;
const SETTINGS_SECTION_GAP: f32 = 30.0;
const APPEARANCE_SECTION_GAP: f32 = 34.0;
const THEME_PREVIEW_ASPECT_RATIO: f32 = 1.45;
const THEME_PREVIEW_PRESS_SCALE: f32 = 0.985;
const THEME_PREVIEW_PRESS_MARGIN_Y: f32 =
    (1.0 - THEME_PREVIEW_PRESS_SCALE) / (2.0 * THEME_PREVIEW_ASPECT_RATIO);
const THEME_SYSTEM_SPLIT_OFFSET: f32 = 0.0001;

type SettingsAction = Rc<dyn Fn(&mut App)>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum McpEditorMode {
    Add,
    Edit,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct McpEditorState {
    mode: McpEditorMode,
    provider: ProviderId,
    project_path: String,
    server_id: Option<String>,
}

#[derive(Clone, Copy, Debug)]
pub(super) struct SettingsSwitchMotion {
    target: bool,
    from: f32,
    started: Instant,
    duration: Duration,
    generation: u64,
    animating: bool,
}

#[derive(Clone, Copy, Debug)]
struct SettingsSwitchAnimation {
    from: f32,
    to: f32,
    duration: Duration,
    generation: u64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum SettingsSection {
    #[default]
    Providers,
    Models,
    Mcp,
    Skills,
    Workflows,
    Appearance,
    Data,
    About,
}

impl SettingsSection {
    const ALL: [Self; 8] = [
        Self::Providers,
        Self::Models,
        Self::Mcp,
        Self::Skills,
        Self::Workflows,
        Self::Appearance,
        Self::Data,
        Self::About,
    ];

    fn label(self) -> &'static str {
        match self {
            Self::Providers => "Providers",
            Self::Models => "Models",
            Self::Mcp => "MCP",
            Self::Skills => "Skills",
            Self::Workflows => "Workflows",
            Self::Appearance => "Appearance",
            Self::Data => "Data",
            Self::About => "About",
        }
    }

    fn icon(self) -> &'static str {
        match self {
            Self::Providers => "icons/user-round.svg",
            Self::Models => "icons/boxes.svg",
            Self::Mcp => "icons/network.svg",
            Self::Skills => "icons/blocks.svg",
            Self::Workflows => "icons/panel-left.svg",
            Self::Appearance => "icons/palette.svg",
            Self::Data => "icons/database.svg",
            Self::About => "icons/info.svg",
        }
    }

    fn index(self) -> usize {
        Self::ALL
            .iter()
            .position(|section| *section == self)
            .unwrap_or_default()
    }
}

impl HarnessApp {
    pub(super) fn open_settings(&mut self, cx: &mut Context<Self>) {
        if self.settings_open {
            return;
        }
        if self.sidebar_controls.is_open() {
            self.close_sidebar_controls(cx);
        }
        self.close_rollback(cx);
        self.account_menu_open = false;
        self.settings_open = true;
        self.settings_section = SettingsSection::Providers;
        self.settings_focus_pending = true;
        self.model_settings_searches.clear();
        self.settings_switch_motion.borrow_mut().clear();
        self.scope_open = false;
        self.settings_transition = self.settings_transition.wrapping_add(1);
        self.settings_open_transition = self.settings_open_transition.wrapping_add(1);
        cx.notify();
    }

    pub(super) fn close_settings(&mut self, cx: &mut Context<Self>) {
        self.settings_open = false;
        self.settings_focus_pending = false;
        self.model_settings_searches.clear();
        self.mcp_editor = None;
        self.mcp_editor_submission_id = None;
        self.mcp_transport_resize_drag = None;
        cx.notify();
    }

    fn settings_switch_control(
        &self,
        id: usize,
        on: bool,
        enabled: bool,
        action: SettingsAction,
    ) -> AnyElement {
        let animation = settings_switch_animation(
            &mut self.settings_switch_motion.borrow_mut(),
            id,
            on,
            self.theme.motion.fast,
            Instant::now(),
        );
        settings_switch(id, on, enabled, self.theme, action, animation)
    }

    pub(super) fn settings_panel(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let back_view = cx.weak_entity();
        let back: SettingsAction = Rc::new(move |cx| {
            let _ = back_view.update(cx, |this, cx| this.close_settings(cx));
        });

        let mut nav_items = Vec::with_capacity(SettingsSection::ALL.len());
        for (index, section) in SettingsSection::ALL.into_iter().enumerate() {
            let selected = self.settings_section == section;
            let view = cx.weak_entity();
            let action: SettingsAction = Rc::new(move |cx| {
                let _ = view.update(cx, |this, cx| {
                    if this.settings_section != section {
                        this.settings_section = section;
                        this.model_settings_searches.clear();
                        this.settings_switch_motion.borrow_mut().clear();
                        this.mcp_editor = None;
                        this.mcp_editor_submission_id = None;
                        this.mcp_transport_resize_drag = None;
                        this.settings_transition = this.settings_transition.wrapping_add(1);
                        this.refresh_settings_inventory(cx);
                    }
                });
            });
            nav_items.push(settings_nav_item(
                index,
                section.label(),
                section.icon(),
                selected,
                theme,
                action,
            ));
        }

        let sidebar = div()
            .relative()
            .w(px(crate::RAIL_WIDTH))
            .h_full()
            .flex_none()
            .flex()
            .flex_col()
            .px(px(8.0))
            .pt(px(14.0))
            .pb(px(16.0))
            .bg(chrome::rail_background(theme))
            .border_r_1()
            .border_color(theme.line.hsla())
            .child(chrome::right_highlight(theme))
            .child(
                div()
                    .id("settings-back")
                    .group("settings-back-hover")
                    .relative()
                    .h(px(30.0))
                    .w_full()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .px(px(8.0))
                    .rounded(px(5.0))
                    .text_size(px(12.5))
                    .text_color(theme.text_2.hsla())
                    .cursor_pointer()
                    .hover(move |style| {
                        style
                            .bg(chrome::raised(theme))
                            .shadow(chrome::shadows(theme))
                            .text_color(theme.text.hsla())
                    })
                    .active(move |style| style.top(px(1.0)).shadow(Vec::new()))
                    .on_click(move |_event, _window, cx| back(cx))
                    .child(chrome::interactive_top_highlight(
                        theme,
                        "settings-back-hover",
                        false,
                    ))
                    .child(chrome::interactive_inset_shade(
                        theme,
                        "settings-back-hover",
                    ))
                    .child(motion_icon(
                        "settings-back-icon",
                        "icons/arrow-left.svg",
                        14.0,
                        "settings-back-hover",
                        theme,
                    ))
                    .child("Back to app"),
            )
            .child(
                div()
                    .mt(px(18.0))
                    .mb(px(4.0))
                    .px(px(8.0))
                    .text_size(px(11.5))
                    .text_color(theme.text_3.hsla())
                    .child("Settings"),
            )
            .child(div().flex().flex_col().gap(px(1.0)).children(nav_items));

        let transition = self.settings_transition ^ self.settings_section.index() as u64;
        let content = self.settings_content(window, cx).with_animation(
            ("settings-section", transition),
            Animation::new(theme.motion_duration(std::time::Duration::from_millis(220)))
                .with_easing(crate::theme::web_ease_out),
            |panel, delta| panel.opacity(delta).mt(px(4.0 * (1.0 - delta))),
        );

        div()
            .size_full()
            .flex()
            .bg(theme.background.hsla())
            .child(sidebar)
            .child(
                div()
                    .id("settings-scroll")
                    .min_w(px(0.0))
                    .min_h(px(0.0))
                    .flex_1()
                    .overflow_y_scroll()
                    .child(
                        div()
                            .w_full()
                            .max_w(px(SETTINGS_CONTENT_WIDTH))
                            .mx_auto()
                            .pt(px(48.0))
                            .px(px(48.0))
                            .pb(px(64.0))
                            .child(content),
                    ),
            )
            .with_animation(
                ("settings-overlay", self.settings_open_transition),
                Animation::new(theme.motion.fast).with_easing(crate::theme::web_ease_out),
                |panel, delta| panel.opacity(delta),
            )
            .into_any_element()
    }

    fn settings_content(&mut self, window: &mut Window, cx: &mut Context<Self>) -> gpui::Div {
        match self.settings_section {
            SettingsSection::Providers => self.provider_settings(cx),
            SettingsSection::Models => self.model_settings(window, cx),
            SettingsSection::Mcp => self.mcp_settings(window, cx),
            SettingsSection::Skills => self.skills_settings(cx),
            SettingsSection::Workflows => self.workflow_settings(cx),
            SettingsSection::Appearance => self.appearance_settings(cx),
            SettingsSection::Data => self.data_settings(cx),
            SettingsSection::About => self.about_settings(cx),
        }
    }

    fn provider_settings(&self, cx: &mut Context<Self>) -> gpui::Div {
        let theme = self.theme;
        let mut blocks = Vec::new();

        let mut providers = Vec::new();
        for (index, provider) in self.state.provider_statuses.iter().enumerate() {
            if provider.id == ProviderId::Acp {
                continue;
            }
            let target = AuthTarget::provider(provider.id);
            let install_key =
                ProviderTerminalKey::new(target.clone(), ProviderTerminalKind::Install);
            let sign_in_key =
                ProviderTerminalKey::new(target.clone(), ProviderTerminalKind::SignIn);
            let account = self.state.accounts.get(&target);
            let signed_in = account
                .map(|account| account.signed_in)
                .unwrap_or(provider.auth == ProviderAuth::Authenticated);
            let ready = provider.installed && provider.problem.is_none() && signed_in;
            let status = if !provider.installed {
                "Not installed"
            } else if provider.problem.is_some() {
                "Needs attention"
            } else {
                match (signed_in, provider.setup.as_ref().map(|setup| setup.login)) {
                    (true, _) => "Ready",
                    (false, Some(ProviderLogin::Provider)) => "CLI sign-in required",
                    (false, _) => "Sign-in required",
                }
            };
            let idle_note = provider.problem.clone().unwrap_or_else(|| {
                if !provider.installed {
                    return provider
                        .setup
                        .as_ref()
                        .and_then(|setup| setup.install_command.clone())
                        .unwrap_or_else(|| "Provider CLI is not installed.".into());
                }
                if let Some(account) = account
                    && account.signed_in
                {
                    let identity = [account.email.as_deref(), account.plan.as_deref()]
                        .into_iter()
                        .flatten()
                        .collect::<Vec<_>>()
                        .join(" · ");
                    if identity.is_empty() {
                        "Signed in".into()
                    } else {
                        identity
                    }
                } else {
                    provider.version.as_ref().map_or_else(
                        || "Local provider adapter".into(),
                        |version| format!("Version {version}"),
                    )
                }
            });
            let terminal_key = if !provider.installed {
                Some(&install_key)
            } else if !signed_in
                && provider
                    .setup
                    .as_ref()
                    .is_some_and(|setup| setup.login == ProviderLogin::Provider)
            {
                Some(&sign_in_key)
            } else {
                None
            };
            let terminal =
                terminal_key.and_then(|key| self.provider_terminal_snapshot(key, &idle_note, cx));
            let auth_busy = self.state.auth_busy.as_ref() == Some(&target);
            let terminal_busy = self.state.provider_terminal_busy.as_ref() == Some(&target);
            let trailing = if !provider.installed {
                if terminal_busy {
                    provider_action_disabled("Installing…", false, theme)
                } else if let Some(setup) = &provider.setup {
                    if setup.install_command.is_some() {
                        match terminal.as_ref().map(|terminal| terminal.phase) {
                            Some(ProviderTerminalPhase::Starting) => {
                                provider_action_disabled("Installing…", false, theme)
                            }
                            Some(ProviderTerminalPhase::Running) => {
                                let key = install_key.clone();
                                let view = cx.weak_entity();
                                let action: SettingsAction = Rc::new(move |cx| {
                                    let key = key.clone();
                                    let _ = view.update(cx, |this, cx| {
                                        this.toggle_provider_terminal(&key, cx);
                                    });
                                });
                                provider_action_button(
                                    index,
                                    if terminal.as_ref().is_some_and(|terminal| terminal.visible) {
                                        "Hide terminal"
                                    } else {
                                        "Installing…"
                                    },
                                    false,
                                    theme,
                                    action,
                                )
                            }
                            Some(ProviderTerminalPhase::Succeeded) => {
                                provider_action_disabled("Installed", false, theme)
                            }
                            Some(ProviderTerminalPhase::Failed | ProviderTerminalPhase::Error)
                            | None => {
                                let target = target.clone();
                                let title = provider.display_name.clone();
                                let view = cx.weak_entity();
                                let action: SettingsAction = Rc::new(move |cx| {
                                    let target = target.clone();
                                    let title = title.clone();
                                    let _ = view.update(cx, |this, cx| {
                                        this.start_provider_terminal(
                                            target,
                                            ProviderTerminalKind::Install,
                                            title,
                                            cx,
                                        );
                                    });
                                });
                                provider_action_button(
                                    index,
                                    if terminal.is_some() {
                                        "Retry install"
                                    } else {
                                        "Install"
                                    },
                                    false,
                                    theme,
                                    action,
                                )
                            }
                        }
                    } else {
                        let url = setup.install_url.clone();
                        let action: SettingsAction = Rc::new(move |cx| cx.open_url(&url));
                        provider_action_button(index, "Install first", false, theme, action)
                    }
                } else {
                    provider_action_disabled("Install first", false, theme)
                }
            } else if signed_in
                || provider
                    .setup
                    .as_ref()
                    .is_some_and(|setup| setup.login == ProviderLogin::App)
            {
                if auth_busy {
                    provider_action_disabled(
                        if signed_in {
                            "Signing out…"
                        } else {
                            "Signing in…"
                        },
                        signed_in,
                        theme,
                    )
                } else {
                    let target = target.clone();
                    let view = cx.weak_entity();
                    let action: SettingsAction = Rc::new(move |cx| {
                        let target = target.clone();
                        let _ = view.update(cx, |this, cx| {
                            let update = if signed_in {
                                this.state.sign_out(target)
                            } else {
                                this.state.start_auth(target)
                            };
                            this.apply_client_update(update, cx);
                        });
                    });
                    provider_action_button(
                        index,
                        if signed_in { "Sign out" } else { "Sign in" },
                        signed_in,
                        theme,
                        action,
                    )
                }
            } else if provider
                .setup
                .as_ref()
                .is_some_and(|setup| setup.login == ProviderLogin::Provider)
                && !signed_in
            {
                if terminal_busy {
                    provider_action_disabled("Signing in…", false, theme)
                } else {
                    match terminal.as_ref().map(|terminal| terminal.phase) {
                        Some(ProviderTerminalPhase::Starting) => {
                            provider_action_disabled("Signing in…", false, theme)
                        }
                        Some(ProviderTerminalPhase::Running) => {
                            let key = sign_in_key.clone();
                            let view = cx.weak_entity();
                            let action: SettingsAction = Rc::new(move |cx| {
                                let key = key.clone();
                                let _ = view.update(cx, |this, cx| {
                                    this.toggle_provider_terminal(&key, cx);
                                });
                            });
                            provider_action_button(
                                index,
                                if terminal.as_ref().is_some_and(|terminal| terminal.visible) {
                                    "Hide details"
                                } else {
                                    "Details"
                                },
                                false,
                                theme,
                                action,
                            )
                        }
                        Some(ProviderTerminalPhase::Succeeded) => {
                            status_pill("Checking…", true, theme)
                        }
                        Some(ProviderTerminalPhase::Failed | ProviderTerminalPhase::Error)
                        | None => {
                            let target = target.clone();
                            let title = provider.display_name.clone();
                            let view = cx.weak_entity();
                            let action: SettingsAction = Rc::new(move |cx| {
                                let target = target.clone();
                                let title = title.clone();
                                let _ = view.update(cx, |this, cx| {
                                    this.start_provider_terminal(
                                        target,
                                        ProviderTerminalKind::SignIn,
                                        title,
                                        cx,
                                    );
                                });
                            });
                            provider_action_button(
                                index,
                                if terminal.is_some() {
                                    "Retry sign-in"
                                } else {
                                    "Sign in"
                                },
                                false,
                                theme,
                                action,
                            )
                        }
                    }
                }
            } else {
                status_pill(status, ready, theme)
            };
            let issue = terminal
                .as_ref()
                .filter(|terminal| {
                    matches!(
                        terminal.phase,
                        ProviderTerminalPhase::Failed | ProviderTerminalPhase::Error
                    )
                })
                .map(|terminal| {
                    (
                        terminal.note.clone(),
                        Some("Open the terminal for details, then retry.".into()),
                    )
                })
                .or_else(|| {
                    provider.problem.as_ref().map(|problem| {
                        (
                            problem.clone(),
                            Some("Fix the provider installation, then refresh.".into()),
                        )
                    })
                });
            let inline_status = terminal
                .as_ref()
                .filter(|terminal| {
                    matches!(
                        terminal.phase,
                        ProviderTerminalPhase::Starting
                            | ProviderTerminalPhase::Running
                            | ProviderTerminalPhase::Succeeded
                    )
                })
                .map(|terminal| settings_status(terminal.note.clone(), false, theme))
                .or_else(|| {
                    provider
                        .installed
                        .then(|| account_status(account, signed_in, theme))
                });
            let trailing = provider_actions(
                format!("provider:{:?}", provider.id).into(),
                issue,
                inline_status,
                provider_mark(provider.id),
                trailing,
                theme,
            );
            providers.push(settings_row(
                index,
                provider.display_name.clone(),
                "",
                trailing,
                theme,
            ));
            if terminal_key == Some(&sign_in_key)
                && let Some(snapshot) = terminal.as_ref()
                && matches!(
                    snapshot.phase,
                    ProviderTerminalPhase::Starting | ProviderTerminalPhase::Running
                )
            {
                providers.push(self.provider_sign_in_card(snapshot, cx));
            }
            if let Some(key) = terminal_key
                && let Some(terminal) = self.provider_terminal_element(key, cx)
            {
                providers.push(terminal);
            }
        }
        if providers.is_empty() {
            providers.push(settings_empty_row(
                "Provider discovery is waiting for the local TasteCode server.",
                theme,
            ));
        }
        if let Some(error) = &self.state.auth_error {
            blocks.push(settings_error_group(
                "Provider sign-in error",
                error.clone(),
                theme,
            ));
        }

        let mut connections = Vec::new();
        for (index, connection) in self.state.model_connections.iter().enumerate() {
            let action = if self.state.connection_busy.as_deref() == Some(connection.id.as_str()) {
                status_pill("Removing…", false, theme)
            } else {
                let connection_id = connection.id.clone();
                let view = cx.weak_entity();
                let remove: SettingsAction = Rc::new(move |cx| {
                    let connection_id = connection_id.clone();
                    let _ = view.update(cx, |this, cx| {
                        let update = this.state.remove_connection(connection_id);
                        this.apply_client_update(update, cx);
                    });
                });
                connection_remove_button(index, theme, remove)
            };
            let issue = connection.problem.as_ref().map(|problem| {
                (
                    problem.clone(),
                    Some("Check this connection's endpoint and credentials.".into()),
                )
            });
            let status = if connection.credential_configured {
                settings_status(connection_preset(connection.preset).label, false, theme)
            } else {
                settings_status("Key missing", true, theme)
            };
            let trailing = provider_actions(
                format!("connection:{}", connection.id).into(),
                issue,
                Some(status),
                connection_mark(connection.preset),
                action,
                theme,
            );
            connections.push(settings_row(
                index,
                connection.display_name.clone(),
                "",
                trailing,
                theme,
            ));
        }
        if parked_provider_surfaces_visible()
            && let Some(error) = &self.state.connection_error
        {
            blocks.push(settings_error_group(
                "Connection error",
                error.clone(),
                theme,
            ));
        }
        let connection_control = if self.connection_editor_open {
            self.connection_form(cx)
        } else {
            let add_view = cx.weak_entity();
            let add: SettingsAction = Rc::new(move |cx| {
                let _ = add_view.update(cx, |this, cx| {
                    this.state.connection_error = None;
                    this.connection_editor_open = true;
                    cx.notify();
                });
            });
            connection_add_button(theme, add)
        };

        let mut agents = vec![settings_row(
            0,
            "Pi",
            "",
            provider_actions(
                "agent:pi".into(),
                None,
                None,
                ProviderMark::Pi,
                provider_action_disabled("Planned", false, theme),
                theme,
            ),
            theme,
        )];
        for (index, agent) in self.state.acp_agents.iter().enumerate() {
            let target = AuthTarget::agent(ProviderId::Acp, agent.id.clone());
            let install_key =
                ProviderTerminalKey::new(target.clone(), ProviderTerminalKind::Install);
            let sign_in_key =
                ProviderTerminalKey::new(target.clone(), ProviderTerminalKind::SignIn);
            let account = self.state.accounts.get(&target);
            let signed_in = account.is_some_and(|account| account.signed_in);
            let idle_note = agent.problem.clone().unwrap_or_else(|| {
                if !agent.installed {
                    return agent
                        .setup
                        .install_command
                        .clone()
                        .unwrap_or_else(|| "Provider CLI is not installed.".into());
                }
                if let Some(account) = account
                    && account.signed_in
                {
                    let identity = [account.email.as_deref(), account.plan.as_deref()]
                        .into_iter()
                        .flatten()
                        .collect::<Vec<_>>()
                        .join(" · ");
                    if identity.is_empty() {
                        "Signed in".into()
                    } else {
                        identity
                    }
                } else if agent.verified {
                    "Captured ACP protocol adapter".into()
                } else {
                    "ACP-compatible coding agent".into()
                }
            });
            let terminal_key = if !agent.installed {
                Some(&install_key)
            } else if !signed_in {
                Some(&sign_in_key)
            } else {
                None
            };
            let terminal =
                terminal_key.and_then(|key| self.provider_terminal_snapshot(key, &idle_note, cx));
            let busy = self.state.provider_terminal_busy.as_ref() == Some(&target);
            let action_index = 1_000 + index;
            let trailing = if busy {
                status_pill("Working…", false, theme)
            } else if !agent.installed {
                if agent.setup.install_command.is_some() {
                    match terminal.as_ref().map(|terminal| terminal.phase) {
                        Some(ProviderTerminalPhase::Starting) => {
                            status_pill("Starting…", false, theme)
                        }
                        Some(ProviderTerminalPhase::Running) => {
                            let key = install_key.clone();
                            let view = cx.weak_entity();
                            let action: SettingsAction = Rc::new(move |cx| {
                                let key = key.clone();
                                let _ = view.update(cx, |this, cx| {
                                    this.toggle_provider_terminal(&key, cx);
                                });
                            });
                            provider_action_button(
                                action_index,
                                if terminal.as_ref().is_some_and(|terminal| terminal.visible) {
                                    "Hide terminal"
                                } else {
                                    "Installing…"
                                },
                                false,
                                theme,
                                action,
                            )
                        }
                        Some(ProviderTerminalPhase::Succeeded) => {
                            status_pill("Installed", true, theme)
                        }
                        Some(ProviderTerminalPhase::Failed | ProviderTerminalPhase::Error)
                        | None => {
                            let target = target.clone();
                            let title = agent.name.clone();
                            let view = cx.weak_entity();
                            let action: SettingsAction = Rc::new(move |cx| {
                                let target = target.clone();
                                let title = title.clone();
                                let _ = view.update(cx, |this, cx| {
                                    this.start_provider_terminal(
                                        target,
                                        ProviderTerminalKind::Install,
                                        title,
                                        cx,
                                    );
                                });
                            });
                            provider_action_button(
                                action_index,
                                if terminal.is_some() {
                                    "Retry install"
                                } else {
                                    "Install"
                                },
                                false,
                                theme,
                                action,
                            )
                        }
                    }
                } else {
                    let url = agent.setup.install_url.clone();
                    let action: SettingsAction = Rc::new(move |cx| cx.open_url(&url));
                    provider_action_button(action_index, "Install first", false, theme, action)
                }
            } else if !signed_in {
                match terminal.as_ref().map(|terminal| terminal.phase) {
                    Some(ProviderTerminalPhase::Starting) => status_pill("Starting…", false, theme),
                    Some(ProviderTerminalPhase::Running) => {
                        let key = sign_in_key.clone();
                        let view = cx.weak_entity();
                        let action: SettingsAction = Rc::new(move |cx| {
                            let key = key.clone();
                            let _ = view.update(cx, |this, cx| {
                                this.toggle_provider_terminal(&key, cx);
                            });
                        });
                        provider_action_button(
                            action_index,
                            if terminal.as_ref().is_some_and(|terminal| terminal.visible) {
                                "Hide details"
                            } else {
                                "Details"
                            },
                            false,
                            theme,
                            action,
                        )
                    }
                    Some(ProviderTerminalPhase::Succeeded) => status_pill("Checking…", true, theme),
                    Some(ProviderTerminalPhase::Failed | ProviderTerminalPhase::Error) | None => {
                        let target = target.clone();
                        let title = agent.name.clone();
                        let view = cx.weak_entity();
                        let action: SettingsAction = Rc::new(move |cx| {
                            let target = target.clone();
                            let title = title.clone();
                            let _ = view.update(cx, |this, cx| {
                                this.start_provider_terminal(
                                    target,
                                    ProviderTerminalKind::SignIn,
                                    title,
                                    cx,
                                );
                            });
                        });
                        provider_action_button(
                            action_index,
                            if terminal.is_some() {
                                "Retry sign-in"
                            } else {
                                "Sign in"
                            },
                            false,
                            theme,
                            action,
                        )
                    }
                }
            } else {
                let target = target.clone();
                let view = cx.weak_entity();
                let action: SettingsAction = Rc::new(move |cx| {
                    let target = target.clone();
                    let _ = view.update(cx, |this, cx| {
                        let update = this.state.sign_out(target);
                        this.apply_client_update(update, cx);
                    });
                });
                provider_action_button(action_index, "Sign out", true, theme, action)
            };
            let issue = terminal
                .as_ref()
                .filter(|terminal| {
                    matches!(
                        terminal.phase,
                        ProviderTerminalPhase::Failed | ProviderTerminalPhase::Error
                    )
                })
                .map(|terminal| {
                    (
                        terminal.note.clone(),
                        Some("Open the terminal for details, then retry.".into()),
                    )
                })
                .or_else(|| {
                    agent
                        .problem
                        .as_ref()
                        .map(|problem| (problem.clone(), None))
                });
            let inline_status = terminal
                .as_ref()
                .filter(|terminal| {
                    matches!(
                        terminal.phase,
                        ProviderTerminalPhase::Starting
                            | ProviderTerminalPhase::Running
                            | ProviderTerminalPhase::Succeeded
                    )
                })
                .map(|terminal| settings_status(terminal.note.clone(), false, theme))
                .or_else(|| {
                    agent
                        .installed
                        .then(|| account_status(account, signed_in, theme))
                });
            let trailing = provider_actions(
                format!("agent:{}", agent.id).into(),
                issue,
                inline_status,
                agent_mark(&agent.id),
                trailing,
                theme,
            );
            agents.push(settings_row(
                index + 1,
                agent.name.clone(),
                "",
                trailing,
                theme,
            ));
            if terminal_key == Some(&sign_in_key)
                && let Some(snapshot) = terminal.as_ref()
                && matches!(
                    snapshot.phase,
                    ProviderTerminalPhase::Starting | ProviderTerminalPhase::Running
                )
            {
                agents.push(self.provider_sign_in_card(snapshot, cx));
            }
            if let Some(key) = terminal_key
                && let Some(terminal) = self.provider_terminal_element(key, cx)
            {
                agents.push(terminal);
            }
        }
        if parked_provider_surfaces_visible() {
            providers.extend(agents);
            providers.push(settings_inside_title("API connections", theme));
            providers.extend(connections);
            providers.push(connection_control);
        }
        blocks.push(settings_group("", providers, theme));
        settings_panel("Providers", blocks, theme)
    }

    fn provider_sign_in_card(
        &self,
        snapshot: &ProviderTerminalSnapshot,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let copied = snapshot
            .device_code
            .as_ref()
            .is_some_and(|code| self.copied_provider_code.as_ref() == Some(code));
        let copy_action = snapshot.device_code.clone().map(|code| {
            let view = cx.weak_entity();
            Rc::new(move |cx: &mut App| {
                cx.write_to_clipboard(ClipboardItem::new_string(code.clone()));
                let code = code.clone();
                let _ = view.update(cx, |this, cx| {
                    this.copied_provider_code = Some(code);
                    cx.notify();
                });
            }) as SettingsAction
        });
        let open_action = snapshot
            .opened_auth_url
            .clone()
            .map(|url| Rc::new(move |cx: &mut App| cx.open_url(&url)) as SettingsAction);
        let hint = if snapshot.opened_auth_url.is_some() {
            "Your browser opened — approve the sign-in there"
        } else {
            "Starting the provider sign-in…"
        };
        let code_row = snapshot.device_code.clone().map(|code| {
            div()
                .flex()
                .items_center()
                .flex_wrap()
                .gap(px(10.0))
                .min_w(px(0.0))
                .child(
                    div()
                        .text_size(px(11.0))
                        .text_color(theme.text_2.hsla())
                        .child("Confirm this code in your browser"),
                )
                .child(
                    div()
                        .px(px(9.0))
                        .py(px(3.0))
                        .rounded(px(crate::RADIUS_SM))
                        .border_1()
                        .border_color(theme.line_strong.hsla())
                        .bg(theme.surface_2.hsla())
                        .font_family("Geist Mono")
                        .text_size(px(15.0))
                        .text_color(theme.text.hsla())
                        .child(tracked_text(code, 0.08)),
                )
                .when_some(copy_action, |row, action| {
                    row.child(provider_action_button(
                        990_000,
                        if copied { "Copied" } else { "Copy" },
                        false,
                        theme,
                        action,
                    ))
                })
                .into_any_element()
        });
        let details_hidden = !snapshot.visible && !snapshot.last_line.is_empty();
        div()
            .mx(px(12.0))
            .mb(px(10.0))
            .p(px(10.0))
            .flex()
            .items_center()
            .flex_wrap()
            .gap(px(10.0))
            .rounded(px(crate::RADIUS_MD))
            .border_1()
            .border_color(theme.line.hsla())
            .bg(theme.surface.hsla())
            .when_some(code_row, |card, row| card.child(row))
            .when(snapshot.device_code.is_none(), |card| {
                card.child(
                    div()
                        .text_size(px(11.0))
                        .text_color(theme.text_2.hsla())
                        .child(hint),
                )
            })
            .when_some(open_action, |card, action| {
                card.child(provider_action_button(
                    990_001,
                    "Open link again",
                    false,
                    theme,
                    action,
                ))
            })
            .when(details_hidden, |card| {
                card.child(
                    div()
                        .w_full()
                        .truncate()
                        .font_family("Geist Mono")
                        .text_size(px(10.5))
                        .text_color(theme.text_3.hsla())
                        .child(snapshot.last_line.clone()),
                )
            })
            .into_any_element()
    }

    fn connection_form(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let presets = [
            (ModelConnectionPreset::Openai, "OpenAI"),
            (ModelConnectionPreset::Anthropic, "Anthropic"),
            (ModelConnectionPreset::Openrouter, "OpenRouter"),
            (ModelConnectionPreset::Kimi, "Kimi"),
            (ModelConnectionPreset::Zai, "Z.ai"),
            (ModelConnectionPreset::Custom, "Custom"),
        ];
        let mut preset_buttons = Vec::new();
        for (index, (preset, label)) in presets.into_iter().enumerate() {
            let selected = self.connection_preset == preset;
            preset_buttons.push(
                div()
                    .id(("connection-preset", index))
                    .h(px(28.0))
                    .flex()
                    .items_center()
                    .px(px(10.0))
                    .rounded(px(7.0))
                    .border_1()
                    .border_color(if selected {
                        theme.attention.hsla()
                    } else {
                        theme.line.hsla()
                    })
                    .bg(if selected {
                        theme.surface_2.hsla()
                    } else {
                        theme.surface.hsla()
                    })
                    .text_size(px(10.5))
                    .text_color(if selected {
                        theme.text.hsla()
                    } else {
                        theme.text_3.hsla()
                    })
                    .cursor_pointer()
                    .hover(move |style| style.bg(theme.surface_2.hsla()))
                    .on_click(cx.listener(move |this, _event, window, cx| {
                        this.select_connection_preset(preset, window, cx);
                    }))
                    .child(label)
                    .into_any_element(),
            );
        }
        let busy = self.state.connection_busy.is_some();
        let can_submit = !busy
            && !self.connection_name.read(cx).value().trim().is_empty()
            && !self.connection_base_url.read(cx).value().trim().is_empty()
            && !self
                .connection_api_key
                .read(cx)
                .unmask_value()
                .trim()
                .is_empty();

        let cancel = div()
            .id("cancel-connection")
            .group("cancel-connection-hover")
            .h(px(30.0))
            .flex()
            .items_center()
            .gap(px(7.0))
            .px(px(10.0))
            .rounded(px(8.0))
            .border_1()
            .border_color(theme.line_strong.hsla())
            .bg(theme.surface.hsla())
            .text_size(px(11.0))
            .text_color(theme.text_2.hsla())
            .when(!busy, |button| {
                button
                    .cursor_pointer()
                    .hover(move |style| style.bg(theme.surface_2.hsla()))
                    .active(|style| style.opacity(0.72))
                    .on_click(cx.listener(|this, _event, window, cx| {
                        this.cancel_connection_editor(window, cx)
                    }))
            })
            .child(motion_icon(
                "cancel-connection-icon",
                "icons/x.svg",
                13.0,
                "cancel-connection-hover",
                theme,
            ))
            .child("Cancel")
            .into_any_element();
        let submit = if can_submit {
            div()
                .id("submit-connection")
                .h(px(30.0))
                .flex()
                .items_center()
                .px(px(12.0))
                .rounded(px(8.0))
                .bg(theme.attention.hsla())
                .text_size(px(11.0))
                .font_weight(FontWeight::MEDIUM)
                .text_color(gpui::white())
                .cursor_pointer()
                .hover(|style| style.opacity(0.9))
                .active(|style| style.opacity(0.72))
                .on_click(
                    cx.listener(|this, _event, window, cx| this.submit_connection(window, cx)),
                )
                .child("Connect")
                .into_any_element()
        } else {
            div()
                .h(px(30.0))
                .flex()
                .items_center()
                .px(px(12.0))
                .rounded(px(8.0))
                .bg(theme.surface_3.hsla())
                .text_size(px(11.0))
                .text_color(theme.text_3.hsla())
                .opacity(0.62)
                .child(if busy { "Connecting…" } else { "Connect" })
                .into_any_element()
        };

        div()
            .w_full()
            .child(
                div()
                    .mb(px(12.0))
                    .text_size(px(12.5))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.text_2.hsla())
                    .child("New API connection"),
            )
            .child(
                div()
                    .w_full()
                    .rounded(px(10.0))
                    .border_1()
                    .border_color(theme.line_strong.hsla())
                    .bg(chrome::rail_background(theme))
                    .p(px(16.0))
                    .child(
                        div()
                            .mb(px(14.0))
                            .flex()
                            .flex_wrap()
                            .gap(px(7.0))
                            .children(preset_buttons),
                    )
                    .child(
                        div()
                            .w_full()
                            .flex()
                            .flex_wrap()
                            .gap(px(12.0))
                            .child(connection_field(
                                "Name",
                                &self.connection_name,
                                false,
                                theme,
                            ))
                            .child(connection_field(
                                "Default model",
                                &self.connection_default_model,
                                false,
                                theme,
                            ))
                            .child(connection_field(
                                "Base URL",
                                &self.connection_base_url,
                                true,
                                theme,
                            ))
                            .child(connection_field(
                                "API key",
                                &self.connection_api_key,
                                true,
                                theme,
                            )),
                    )
                    .child(
                        div()
                            .mt(px(16.0))
                            .flex()
                            .items_center()
                            .justify_end()
                            .gap(px(8.0))
                            .child(cancel)
                            .child(submit),
                    ),
            )
            .into_any_element()
    }

    fn select_connection_preset(
        &mut self,
        preset: ModelConnectionPreset,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.connection_preset = preset;
        let config = connection_preset(preset);
        self.connection_name
            .update(cx, |input, cx| input.set_value(config.label, window, cx));
        self.connection_base_url
            .update(cx, |input, cx| input.set_value(config.base_url, window, cx));
        self.connection_default_model
            .update(cx, |input, cx| input.set_value("", window, cx));
        self.state.connection_error = None;
        cx.notify();
    }

    fn submit_connection(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.state.connection_busy.is_some() {
            return;
        }
        let display_name = self.connection_name.read(cx).value().trim().to_owned();
        let base_url = self.connection_base_url.read(cx).value().trim().to_owned();
        let default_model = self
            .connection_default_model
            .read(cx)
            .value()
            .trim()
            .to_owned();
        let api_key = self
            .connection_api_key
            .read(cx)
            .unmask_value()
            .trim()
            .to_owned();
        if display_name.is_empty() || base_url.is_empty() || api_key.is_empty() {
            self.state.connection_error = Some("Name, base URL, and API key are required.".into());
            cx.notify();
            return;
        }
        if let Err(message) = validate_model_endpoint(&base_url) {
            self.state.connection_error = Some(message);
            cx.notify();
            return;
        }
        let config = connection_preset(self.connection_preset);
        let connection_id = format!(
            "{}-{}",
            connection_preset_id(self.connection_preset),
            uuid::Uuid::new_v4()
        );
        let update = self.state.upsert_connection(
            ModelConnectionInput {
                id: connection_id.clone(),
                display_name,
                preset: self.connection_preset,
                transport: config.transport,
                base_url,
                default_model: (!default_model.is_empty()).then_some(default_model),
                enabled: true,
            },
            api_key,
        );
        self.connection_submission_id = Some(connection_id);
        self.connection_api_key
            .update(cx, |input, cx| input.set_value("", window, cx));
        self.apply_client_update(update, cx);
    }

    fn cancel_connection_editor(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.state.connection_busy.is_some() {
            return;
        }
        self.connection_api_key
            .update(cx, |input, cx| input.set_value("", window, cx));
        self.connection_editor_open = false;
        self.connection_submission_id = None;
        self.state.connection_error = None;
        cx.notify();
    }

    fn model_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) -> gpui::Div {
        let theme = self.theme;
        let visible_model_count = self
            .state
            .model_catalog
            .iter()
            .filter(|choice| !self.preferences.hidden_models.contains(&choice.key))
            .count();
        let mut sources: Vec<(String, Vec<crate::client_state::ModelChoice>)> = Vec::new();
        for choice in &self.state.model_catalog {
            if let Some((_, choices)) = sources
                .iter_mut()
                .find(|(source, _)| *source == choice.source_name)
            {
                choices.push(choice.clone());
            } else {
                sources.push((choice.source_name.clone(), vec![choice.clone()]));
            }
        }

        self.model_settings_searches
            .retain(|source, _| sources.iter().any(|(live_source, _)| live_source == source));
        for (source, _) in &sources {
            if self.model_settings_searches.contains_key(source) {
                continue;
            }
            let input = cx.new(|cx| InputState::new(window, cx).placeholder("Search models"));
            cx.subscribe(&input, |_this, _input, event: &InputEvent, cx| {
                if matches!(
                    event,
                    InputEvent::Change | InputEvent::Focus | InputEvent::Blur
                ) {
                    cx.notify();
                }
            })
            .detach();
            self.model_settings_searches.insert(source.clone(), input);
        }

        let mut source_cards = Vec::new();
        for (source_index, (source, choices)) in sources.into_iter().enumerate() {
            let any_visible = choices
                .iter()
                .any(|choice| !self.preferences.hidden_models.contains(&choice.key));
            let visible_count = choices
                .iter()
                .filter(|choice| !self.preferences.hidden_models.contains(&choice.key))
                .count();
            let keys = choices
                .iter()
                .map(|choice| choice.key.clone())
                .collect::<Vec<_>>();
            let master_view = cx.weak_entity();
            let master: SettingsAction = Rc::new(move |cx| {
                let keys = keys.clone();
                let _ = master_view.update(cx, |this, cx| {
                    this.set_models_visible(&keys, !any_visible, cx);
                });
            });
            let source_provider = choices.first().map(|choice| choice.provider);
            let search_input = self
                .model_settings_searches
                .get(&source)
                .expect("model source search input should exist")
                .clone();
            let query = search_input.read(cx).value().to_string();
            let filtered_choices = filter_model_choices_by_query(&choices, &query);
            let header = div()
                .min_h(px(46.0))
                .w_full()
                .flex()
                .items_center()
                .gap(px(18.0))
                .px(px(16.0))
                .py(px(7.0))
                .child(
                    div()
                        .min_w(px(0.0))
                        .flex_none()
                        .flex()
                        .items_center()
                        .gap(px(9.0))
                        .when_some(source_provider, |copy, provider| {
                            copy.child(motion_icon(
                                ("model-source-provider-icon", source_index),
                                provider_mark_path(provider_mark(provider)),
                                18.0,
                                "model-source-provider-icon-direct-hover",
                                theme,
                            ))
                        })
                        .child(
                            div()
                                .max_w(px(270.0))
                                .truncate()
                                .text_size(px(13.5))
                                .font_weight(FontWeight(540.0))
                                .text_color(theme.text.hsla())
                                .child(source.clone()),
                        )
                        .child(
                            div()
                                .text_size(px(12.5))
                                .text_color(theme.text_3.hsla())
                                .child(format!("{visible_count}/{}", choices.len())),
                        ),
                )
                .child(model_settings_search_field(
                    source_index,
                    &search_input,
                    theme,
                    window,
                    cx,
                ))
                .child(self.settings_switch_control(
                    source_index * 10_000,
                    any_visible,
                    true,
                    master,
                ));

            let mut rows = vec![header.into_any_element()];
            for choice in filtered_choices {
                let model_index = choices
                    .iter()
                    .position(|candidate| candidate.key == choice.key)
                    .expect("filtered model should belong to its source");
                let visible = !self.preferences.hidden_models.contains(&choice.key);
                let key = choice.key.clone();
                let view = cx.weak_entity();
                let action: SettingsAction = Rc::new(move |cx| {
                    let key = key.clone();
                    let _ = view.update(cx, |this, cx| {
                        this.set_models_visible(&[key], !visible, cx);
                    });
                });
                rows.push(model_visibility_row(
                    choice.model.display_name,
                    visible,
                    self.settings_switch_control(
                        source_index * 10_000 + model_index + 1,
                        visible,
                        true,
                        action,
                    ),
                    theme,
                ));
            }
            if rows.len() == 1 {
                rows.push(
                    div()
                        .min_h(px(48.0))
                        .w_full()
                        .flex()
                        .items_center()
                        .justify_center()
                        .border_t_1()
                        .border_color(theme.line.hsla())
                        .px(px(16.0))
                        .py(px(16.0))
                        .text_size(px(12.5))
                        .text_color(theme.text_3.hsla())
                        .child("No matching models.")
                        .into_any_element(),
                );
            }
            source_cards.push(settings_group("", rows, theme));
        }

        let blocks = if source_cards.is_empty() {
            vec![model_settings_empty(
                if self.state.model_catalog_loaded {
                    "No models are available from your connected providers yet."
                } else {
                    "Model discovery is still in progress."
                },
                theme,
            )]
        } else {
            vec![
                div()
                    .w_full()
                    .flex()
                    .flex_col()
                    .gap(px(14.0))
                    .child(
                        div()
                            .px(px(2.0))
                            .pb(px(2.0))
                            .text_size(px(12.5))
                            .text_color(theme.text_2.hsla())
                            .child(format!(
                                "{visible_model_count} of {} visible",
                                self.state.model_catalog.len()
                            )),
                    )
                    .child(
                        div()
                            .w_full()
                            .flex()
                            .flex_col()
                            .gap(px(12.0))
                            .children(source_cards),
                    )
                    .into_any_element(),
            ]
        };
        settings_panel("Models", blocks, theme)
    }

    fn mcp_settings(&self, window: &Window, cx: &mut Context<Self>) -> gpui::Div {
        let theme = self.theme;
        let Some((provider, project_path)) = self.settings_scope() else {
            return inventory_settings_panel(
                "MCP servers",
                "Choose a project to inspect its servers.".into(),
                None,
                vec![inventory_empty(
                    "Select a project in the sidebar first.",
                    theme,
                )],
                theme,
            );
        };
        let project_name = self.settings_project_name(&project_path);
        let provider_name = self.settings_provider_name(provider);
        let inventory = self.state.mcp_inventory.as_ref().filter(|inventory| {
            inventory.provider == provider && inventory.project_path == project_path
        });
        let add_action = inventory
            .filter(|inventory| inventory.result.capabilities.add)
            .map(|_| {
                let path = project_path.clone();
                mcp_action_button(
                    "mcp-add-server".into(),
                    "Add server".into(),
                    Some("icons/plus.svg"),
                    false,
                    self.state.mcp_busy.is_none(),
                    theme,
                    cx.listener(move |this, _event, window, cx| {
                        this.open_mcp_editor(
                            McpEditorMode::Add,
                            provider,
                            path.clone(),
                            None,
                            window,
                            cx,
                        );
                    }),
                )
            });
        let mut blocks = Vec::new();

        if let Some(error) = &self.state.mcp_error {
            blocks.push(inventory_message(error.clone(), true, theme));
        }
        if let Some(notice) = &self.state.mcp_notice {
            blocks.push(inventory_message(notice.clone(), false, theme));
        }
        let editor_open = self.mcp_editor.as_ref().is_some_and(|editor| {
            editor.provider == provider && editor.project_path == project_path
        });
        let Some(inventory) = inventory else {
            blocks.push(inventory_empty(
                if self.state.mcp_loading {
                    "Loading MCP servers…"
                } else {
                    "MCP inventory has not been loaded yet."
                },
                theme,
            ));
            if editor_open {
                blocks.push(self.mcp_editor_form(window, cx));
            }
            return inventory_settings_panel(
                "MCP servers",
                format!("Available in {project_name}"),
                add_action,
                blocks,
                theme,
            );
        };
        if !inventory.result.capabilities.inventory {
            blocks.push(inventory_empty(
                format!("{provider_name} does not expose MCP servers here yet."),
                theme,
            ));
            if editor_open {
                blocks.push(self.mcp_editor_form(window, cx));
            }
            return inventory_settings_panel(
                "MCP servers",
                format!("Available in {project_name}"),
                add_action,
                blocks,
                theme,
            );
        }

        let mut rows = Vec::new();
        for (index, server) in inventory.result.servers.iter().enumerate() {
            let busy = self.state.mcp_busy.as_deref() == Some(server.id.as_str());
            let needs_oauth = inventory.result.capabilities.start_o_auth
                && matches!(
                    server.auth,
                    McpAuth::SignInRequired {
                        method: McpAuthMethod::Oauth
                    }
                );
            let can_toggle = inventory.result.capabilities.remove
                && ((!server.enabled && server.scope == harness_protocol::McpServerScope::Project)
                    || (inventory.result.capabilities.add
                        && server.scope == harness_protocol::McpServerScope::Global));
            let can_edit = inventory.result.capabilities.update
                && server.scope == harness_protocol::McpServerScope::Project
                && server.transport.is_some();
            let can_remove = inventory.result.capabilities.remove
                && server.scope == harness_protocol::McpServerScope::Project
                && server.enabled;
            let oauth_active = self.state.mcp_oauth.as_ref().is_some_and(|oauth| {
                oauth.provider == provider
                    && oauth.project_path == project_path
                    && oauth.server_id == server.id
            });
            let mut actions = Vec::new();
            if oauth_active {
                let can_cancel = inventory.result.capabilities.cancel_o_auth;
                actions.push(mcp_action_button(
                    format!("mcp-cancel-oauth-{}", server.id).into(),
                    if can_cancel {
                        "Cancel sign-in"
                    } else {
                        "Signing in…"
                    }
                    .into(),
                    None,
                    false,
                    can_cancel && !busy,
                    theme,
                    cx.listener(|this, _event, _window, cx| {
                        let update = this.state.cancel_mcp_oauth();
                        this.apply_client_update(update, cx);
                    }),
                ));
            } else if needs_oauth {
                let path = project_path.clone();
                let server_id = server.id.clone();
                actions.push(mcp_action_button(
                    format!("mcp-oauth-{server_id}").into(),
                    "Sign in".into(),
                    None,
                    false,
                    !busy,
                    theme,
                    cx.listener(move |this, _event, _window, cx| {
                        let update =
                            this.state
                                .start_mcp_oauth(provider, path.clone(), server_id.clone());
                        this.apply_client_update(update, cx);
                    }),
                ));
            }
            if can_toggle {
                let enabled = server.enabled;
                let server = server.clone();
                let path = project_path.clone();
                let view = cx.weak_entity();
                let action: SettingsAction = Rc::new(move |cx| {
                    let server = server.clone();
                    let path = path.clone();
                    let _ = view.update(cx, |this, cx| {
                        let update = this.state.toggle_mcp_server(provider, path, &server);
                        this.apply_client_update(update, cx);
                    });
                });
                actions.push(self.settings_switch_control(920_000 + index, enabled, !busy, action));
            }
            if can_edit {
                let path = project_path.clone();
                let server = server.clone();
                actions.push(mcp_action_button(
                    format!("mcp-edit-{}", server.id).into(),
                    "Edit".into(),
                    None,
                    false,
                    !busy,
                    theme,
                    cx.listener(move |this, _event, window, cx| {
                        this.open_mcp_editor(
                            McpEditorMode::Edit,
                            provider,
                            path.clone(),
                            Some(server.clone()),
                            window,
                            cx,
                        );
                    }),
                ));
            }
            if can_remove {
                let path = project_path.clone();
                let server_id = server.id.clone();
                let server_name = server
                    .display_name
                    .clone()
                    .unwrap_or_else(|| server.id.clone());
                actions.push(mcp_action_button(
                    format!("mcp-remove-{server_id}").into(),
                    "Remove".into(),
                    Some("icons/trash-2.svg"),
                    true,
                    !busy,
                    theme,
                    cx.listener(move |this, _event, window, cx| {
                        this.confirm_remove_mcp_server(
                            provider,
                            path.clone(),
                            server_id.clone(),
                            server_name.clone(),
                            window,
                            cx,
                        );
                    }),
                ));
            }

            let name = server
                .display_name
                .clone()
                .unwrap_or_else(|| server.id.clone());
            let scope = match server.scope {
                harness_protocol::McpServerScope::Project => "Project",
                harness_protocol::McpServerScope::Global => "Global",
            };
            let (status, _ready) = mcp_status(server);
            let detail_key = (provider, project_path.clone(), server.id.clone());
            let expanded = self.mcp_expanded_servers.contains(&detail_key);
            let expand_view = cx.weak_entity();
            let summary = format!(
                "{} tools · {} resources · {} templates",
                server.tools.len(),
                server.resources.len(),
                server.resource_templates.len()
            );
            let details = div()
                .id(SharedString::from(format!("mcp-details-{}", server.id)))
                .mt(px(10.0))
                .flex()
                .items_center()
                .gap(px(5.0))
                .text_size(px(12.5))
                .text_color(theme.text_3.hsla())
                .cursor_pointer()
                .on_click(move |_event, _window, cx| {
                    let detail_key = detail_key.clone();
                    let _ = expand_view.update(cx, |this, cx| {
                        if !this.mcp_expanded_servers.remove(&detail_key) {
                            this.mcp_expanded_servers.insert(detail_key);
                        }
                        cx.notify();
                    });
                })
                .child(if expanded { "▾" } else { "▸" })
                .child(if expanded {
                    format!("Hide · {summary}")
                } else {
                    summary
                });
            let tool_list = expanded.then(|| {
                if server.tools.is_empty() {
                    div()
                        .mt(px(8.0))
                        .text_size(px(12.5))
                        .text_color(theme.text_3.hsla())
                        .child("No tools reported.")
                        .into_any_element()
                } else {
                    div()
                        .mt(px(8.0))
                        .pl(px(18.0))
                        .flex()
                        .flex_col()
                        .gap(px(5.0))
                        .children(server.tools.iter().map(|tool| {
                            let title = tool.title.as_deref().unwrap_or(&tool.name);
                            let line = tool.description.as_ref().map_or_else(
                                || title.to_owned(),
                                |description| format!("{title} — {description}"),
                            );
                            div()
                                .text_size(px(12.5))
                                .line_height(relative(1.45))
                                .text_color(theme.text_2.hsla())
                                .child(format!("• {line}"))
                        }))
                        .into_any_element()
                }
            });
            let failure = match &server.startup {
                McpStartupStatus::Failed { message } => Some(
                    div()
                        .mt(px(10.0))
                        .flex()
                        .items_center()
                        .gap(px(6.0))
                        .text_size(px(11.5))
                        .text_color(theme.error.hsla())
                        .child(motion_icon(
                            ("mcp-failure-icon", index),
                            "icons/triangle-alert.svg",
                            13.0,
                            "mcp-failure-icon-direct-hover",
                            theme,
                        ))
                        .child(message.clone()),
                ),
                _ => None,
            };
            rows.push(
                div()
                    .min_h(px(46.0))
                    .w_full()
                    .flex()
                    .items_start()
                    .justify_between()
                    .gap(px(20.0))
                    .px(px(16.0))
                    .py(px(6.0))
                    .when(index > 0, |row| {
                        row.border_t_1().border_color(theme.line.hsla())
                    })
                    .opacity(if server.enabled { 1.0 } else { 0.58 })
                    .hover(move |style| style.bg(theme.surface.hsla()))
                    .child(
                        div()
                            .min_w(px(0.0))
                            .flex_1()
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .flex_wrap()
                                    .gap(px(7.0))
                                    .child(
                                        div()
                                            .text_size(px(13.5))
                                            .font_weight(FontWeight(550.0))
                                            .text_color(theme.text.hsla())
                                            .child(name),
                                    )
                                    .child(mcp_badge(scope, theme))
                                    .child(mcp_badge(status, theme)),
                            )
                            .child(
                                div()
                                    .mt(px(7.0))
                                    .truncate()
                                    .text_size(px(12.5))
                                    .text_color(theme.text_3.hsla())
                                    .child(mcp_transport_label(server.transport.as_ref())),
                            )
                            .when_some(failure, |copy, failure| copy.child(failure))
                            .child(details)
                            .when_some(tool_list, |copy, tools| copy.child(tools)),
                    )
                    .child(
                        div()
                            .max_w(px(250.0))
                            .flex_none()
                            .flex()
                            .items_center()
                            .justify_end()
                            .flex_wrap()
                            .gap(px(7.0))
                            .children(actions),
                    )
                    .into_any_element(),
            );
        }
        if rows.is_empty() {
            blocks.push(inventory_empty(
                "No MCP servers are configured for this project.",
                theme,
            ));
            if editor_open {
                blocks.push(self.mcp_editor_form(window, cx));
            }
        } else {
            if editor_open {
                blocks.push(self.mcp_editor_form(window, cx));
            }
            blocks.push(settings_group("", rows, theme));
        }
        inventory_settings_panel(
            "MCP servers",
            format!("Available in {project_name}"),
            add_action,
            blocks,
            theme,
        )
    }

    fn mcp_editor_form(&self, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let editor = self.mcp_editor.as_ref().expect("editor checked by caller");
        let editing = editor.mode == McpEditorMode::Edit;
        let saving = self.mcp_editor_submission_id.is_some();
        let can_save = !saving
            && !self.mcp_editor_id.read(cx).value().trim().is_empty()
            && !self.mcp_editor_transport.read(cx).value().trim().is_empty();
        let cancel = mcp_action_button(
            "mcp-editor-cancel".into(),
            "Cancel".into(),
            None,
            false,
            !saving,
            theme,
            cx.listener(|this, _event, _window, cx| {
                this.mcp_editor = None;
                this.mcp_editor_submission_id = None;
                this.mcp_transport_resize_drag = None;
                this.state.mcp_error = None;
                cx.notify();
            }),
        );
        let save = mcp_action_button(
            "mcp-editor-save".into(),
            if saving { "Saving…" } else { "Save server" }.into(),
            None,
            false,
            can_save,
            theme,
            cx.listener(|this, _event, window, cx| {
                this.submit_mcp_editor(window, cx);
            }),
        );

        div()
            .w_full()
            .mb(px(6.0))
            .rounded(px(8.0))
            .border_1()
            .border_color(theme.line_strong.hsla())
            .bg(chrome::rail_background(theme))
            .p(px(16.0))
            .flex()
            .flex_col()
            .gap(px(14.0))
            .child(
                div()
                    .w_full()
                    .flex()
                    .gap(px(14.0))
                    .child(mcp_editor_field(
                        McpEditorFieldSpec {
                            label: "Server ID",
                            disabled: editing,
                            multiline_height: None,
                            help: None,
                        },
                        &self.mcp_editor_id,
                        None,
                        theme,
                        window,
                        cx,
                    ))
                    .child(mcp_editor_field(
                        McpEditorFieldSpec {
                            label: "Display name",
                            disabled: false,
                            multiline_height: None,
                            help: None,
                        },
                        &self.mcp_editor_name,
                        None,
                        theme,
                        window,
                        cx,
                    )),
            )
            .child(mcp_editor_field(
                McpEditorFieldSpec {
                    label: "Transport JSON",
                    disabled: false,
                    multiline_height: Some(self.mcp_transport_height),
                    help: Some(
                        "Use stdio or HTTP transport fields. Reference secrets as { \"source\": \"credential\", \"credentialRef\": \"…\" }.",
                    ),
                },
                &self.mcp_editor_transport,
                Some(
                    div()
                        .id("mcp-transport-resize")
                        .absolute()
                        .right(px(1.0))
                        .bottom(px(1.0))
                        .size(px(13.0))
                        .cursor_nwse_resize()
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(|this, event, _window, cx| {
                                this.begin_mcp_transport_resize(event, cx);
                            }),
                        )
                        .child(
                            motion_icon(
                                "mcp-transport-resize-icon",
                                "icons/resize-corner.svg",
                                10.0,
                                "mcp-transport-resize-icon-direct-hover",
                                theme,
                            )
                                .absolute()
                                .right(px(1.0))
                                .bottom(px(1.0))
                                .text_color(theme.text_3.hsla().opacity(0.72)),
                        )
                        .into_any_element(),
                ),
                theme,
                window,
                cx,
            ))
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_end()
                    .gap(px(8.0))
                    .child(cancel)
                    .child(save),
            )
            .into_any_element()
    }

    fn begin_mcp_transport_resize(&mut self, event: &MouseDownEvent, cx: &mut Context<Self>) {
        self.mcp_transport_resize_drag = Some(McpTransportResizeDrag {
            start_y: event.position.y,
            start_height: self.mcp_transport_height,
        });
        cx.stop_propagation();
    }

    pub(super) fn update_mcp_transport_resize(
        &mut self,
        event: &MouseMoveEvent,
        cx: &mut Context<Self>,
    ) {
        let Some(drag) = self.mcp_transport_resize_drag else {
            return;
        };
        if !event.dragging() {
            self.mcp_transport_resize_drag = None;
            return;
        }
        let delta = f32::from(event.position.y - drag.start_y) / crate::zoom::factor();
        let next = resized_mcp_transport_height(drag.start_height, delta);
        if (self.mcp_transport_height - next).abs() >= f32::EPSILON {
            self.mcp_transport_height = next;
            cx.notify();
        }
    }

    pub(super) fn finish_mcp_transport_resize(&mut self, cx: &mut Context<Self>) {
        if self.mcp_transport_resize_drag.take().is_some() {
            cx.notify();
        }
    }

    fn confirm_remove_mcp_server(
        &mut self,
        provider: ProviderId,
        project_path: String,
        server_id: String,
        server_name: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.state.mcp_busy.is_some() {
            return;
        }
        let message = format!("Remove {server_name} from this project?");
        let answer = window.prompt(
            PromptLevel::Warning,
            &message,
            Some(
                "This removes the project configuration. It does not delete the MCP server itself.",
            ),
            &[PromptButton::cancel("Cancel"), PromptButton::new("Remove")],
            cx,
        );
        cx.spawn(async move |view, cx| {
            let Ok(1) = answer.await else {
                return;
            };
            let _ = view.update(cx, |this, cx| {
                let update = this
                    .state
                    .remove_mcp_server(provider, project_path, server_id);
                this.apply_client_update(update, cx);
            });
        })
        .detach();
    }

    fn open_mcp_editor(
        &mut self,
        mode: McpEditorMode,
        provider: ProviderId,
        project_path: String,
        server: Option<McpServer>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.state.mcp_busy.is_some() {
            return;
        }
        let server_id = server.as_ref().map(|server| server.id.clone());
        let id = server_id.clone().unwrap_or_default();
        let display_name = server
            .as_ref()
            .and_then(|server| server.display_name.clone())
            .unwrap_or_default();
        let transport = server
            .as_ref()
            .and_then(|server| server.transport.as_ref())
            .and_then(|transport| serde_json::to_string_pretty(transport).ok())
            .unwrap_or_else(|| {
                "{\n  \"type\": \"http\",\n  \"url\": \"https://example.com/mcp\"\n}".into()
            });
        self.mcp_editor = Some(McpEditorState {
            mode,
            provider,
            project_path,
            server_id,
        });
        self.mcp_editor_submission_id = None;
        self.mcp_transport_height = MCP_TRANSPORT_MIN_HEIGHT;
        self.mcp_transport_resize_drag = None;
        self.state.mcp_error = None;
        self.state.mcp_notice = None;
        self.mcp_editor_id
            .update(cx, |input, cx| input.set_value(id, window, cx));
        self.mcp_editor_name
            .update(cx, |input, cx| input.set_value(display_name, window, cx));
        self.mcp_editor_transport
            .update(cx, |input, cx| input.set_value(transport, window, cx));
        cx.notify();
    }

    fn submit_mcp_editor(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        if self.mcp_editor_submission_id.is_some() || self.state.mcp_busy.is_some() {
            return;
        }
        let Some(editor) = self.mcp_editor.clone() else {
            return;
        };
        let id = self.mcp_editor_id.read(cx).value().trim().to_owned();
        let display_name = self.mcp_editor_name.read(cx).value().trim().to_owned();
        let transport_json = self.mcp_editor_transport.read(cx).value().trim().to_owned();
        if id.is_empty() || transport_json.is_empty() {
            self.state.mcp_error = Some("Server ID and transport JSON are required.".into());
            cx.notify();
            return;
        }
        if editor.mode == McpEditorMode::Edit && editor.server_id.as_deref() != Some(id.as_str()) {
            self.state.mcp_error = Some("An existing MCP server ID cannot be changed.".into());
            cx.notify();
            return;
        }
        let transport = match serde_json::from_str::<McpTransport>(&transport_json) {
            Ok(transport) => transport,
            Err(_) => {
                self.state.mcp_error = Some("Transport must be valid MCP JSON.".into());
                cx.notify();
                return;
            }
        };
        if let Err(message) = validate_mcp_transport(&transport) {
            self.state.mcp_error = Some(message);
            cx.notify();
            return;
        }
        let update = self.state.save_mcp_server(
            editor.provider,
            editor.project_path,
            McpServerConfig {
                id: id.clone(),
                enabled: true,
                display_name: (!display_name.is_empty()).then_some(display_name),
                transport: Some(transport),
            },
            editor.mode == McpEditorMode::Edit,
        );
        self.mcp_editor_submission_id = Some(id);
        self.apply_client_update(update, cx);
    }

    fn skills_settings(&self, cx: &mut Context<Self>) -> gpui::Div {
        let theme = self.theme;
        let Some((provider, project_path)) = self.settings_scope() else {
            return inventory_settings_panel(
                "Agent Skills",
                "Choose a project to manage its skills.".into(),
                None,
                vec![inventory_empty(
                    "Select a project in the sidebar first.",
                    theme,
                )],
                theme,
            );
        };
        let project_name = self.settings_project_name(&project_path);
        let provider_name = self.settings_provider_name(provider);
        let inventory = self.state.skills_inventory.as_ref().filter(|inventory| {
            inventory.provider == provider && inventory.project_path == project_path
        });
        let install_supported = inventory.is_some_and(|inventory| {
            inventory.result.capabilities.install && self.state.skills_busy.is_none()
        });
        let intro_action = install_supported.then(|| {
            let install_view = cx.weak_entity();
            let install_path = project_path.clone();
            let install: SettingsAction = Rc::new(move |cx| {
                let path = install_path.clone();
                let _ =
                    install_view.update(cx, |this, cx| this.pick_skill_folder(provider, path, cx));
            });
            settings_button(
                "install-skill",
                "Install from folder",
                "icons/folder-pen.svg",
                theme,
                install,
                false,
            )
        });
        let mut blocks = Vec::new();

        if let Some(error) = &self.state.skills_error {
            blocks.push(inventory_message(error.clone(), true, theme));
        }
        let Some(inventory) = inventory else {
            blocks.push(inventory_empty(
                if self.state.skills_loading {
                    "Discovering skills…"
                } else {
                    "Skill inventory has not been loaded yet."
                },
                theme,
            ));
            return inventory_settings_panel(
                "Agent Skills",
                format!("Available in {project_name}"),
                intro_action,
                blocks,
                theme,
            );
        };
        if !inventory.result.errors.is_empty() {
            let details = inventory
                .result
                .errors
                .iter()
                .map(|error| format!("{} · {}", error.message, error.path))
                .collect::<Vec<_>>()
                .join("\n");
            blocks.push(inventory_message(
                format!("Some skills could not be loaded\n{details}"),
                true,
                theme,
            ));
        }
        if !inventory.result.capabilities.inventory {
            blocks.push(inventory_empty(
                format!("{provider_name} does not expose Agent Skills here yet."),
                theme,
            ));
            return inventory_settings_panel(
                "Agent Skills",
                format!("Available in {project_name}"),
                intro_action,
                blocks,
                theme,
            );
        }

        let mut rows = Vec::new();
        for (index, skill) in inventory.result.skills.iter().enumerate() {
            let busy = self.state.skills_busy.as_deref() == Some(skill.id.as_str());
            let trailing = if inventory.result.capabilities.configure {
                let id = skill.id.clone();
                let path = project_path.clone();
                let enabled = skill.enabled;
                let view = cx.weak_entity();
                let action: SettingsAction = Rc::new(move |cx| {
                    let id = id.clone();
                    let path = path.clone();
                    let _ = view.update(cx, |this, cx| {
                        let update = this.state.set_skill_enabled(provider, path, id, !enabled);
                        this.apply_client_update(update, cx);
                    });
                });
                self.settings_switch_control(930_000 + index, skill.enabled, !busy, action)
            } else {
                div().into_any_element()
            };
            rows.push(skill_settings_row(index, skill, trailing, theme));
        }
        if rows.is_empty() {
            blocks.push(inventory_empty(
                "No skills were discovered for this project.",
                theme,
            ));
        } else {
            blocks.push(settings_group("", rows, theme));
        }
        inventory_settings_panel(
            "Agent Skills",
            format!("Available in {project_name}"),
            intro_action,
            blocks,
            theme,
        )
    }

    fn workflow_settings(&self, cx: &mut Context<Self>) -> gpui::Div {
        let theme = self.theme;
        let inbox = self.state.sidebar_settings.mode == SidebarMode::Inbox;
        let classic_view = cx.weak_entity();
        let classic: SettingsAction = Rc::new(move |cx| {
            let _ = classic_view.update(cx, |this, cx| {
                this.set_sidebar_mode(SidebarMode::Classic, cx)
            });
        });
        let inbox_view = cx.weak_entity();
        let inbox_action: SettingsAction = Rc::new(move |cx| {
            let _ = inbox_view.update(cx, |this, cx| this.set_sidebar_mode(SidebarMode::Inbox, cx));
        });
        let version_picker = div()
            .flex()
            .p(px(2.0))
            .rounded(px(5.0))
            .border_1()
            .border_color(chrome::border(theme))
            .bg(chrome::recessed(theme))
            .child(segmented_button(
                "workflow-v1",
                "V1 Classic",
                !inbox,
                theme,
                classic,
            ))
            .child(segmented_button(
                "workflow-v2",
                "V2 Inbox",
                inbox,
                theme,
                inbox_action,
            ))
            .into_any_element();

        let auto_settle = self.state.sidebar_settings.auto_settle_days.is_some();
        let toggle_view = cx.weak_entity();
        let toggle: SettingsAction = Rc::new(move |cx| {
            let _ = toggle_view.update(cx, |this, cx| {
                this.set_auto_settle_days(if auto_settle { None } else { Some(3) }, cx)
            });
        });
        let settle_control = div()
            .flex()
            .items_center()
            .gap(px(10.0))
            .child(
                div()
                    .relative()
                    .w(px(64.0))
                    .h(px(31.375))
                    .flex_none()
                    .flex()
                    .items_center()
                    .px(px(7.0))
                    .py(px(5.0))
                    .rounded(px(5.0))
                    .border_1()
                    .border_color(chrome::border(theme))
                    .bg(chrome::recessed(theme))
                    .opacity(if auto_settle { 1.0 } else { 0.6 })
                    .child(chrome::inset_top_shade(theme))
                    .child(
                        Input::new(&self.auto_settle_days_input)
                            .xsmall()
                            .appearance(false)
                            .bordered(false)
                            .focus_bordered(false)
                            .disabled(!auto_settle)
                            .w_full()
                            .px(px(0.0))
                            .py(px(0.0))
                            .line_height(relative(1.55))
                            .text_size(px(12.5))
                            .text_color(if auto_settle {
                                theme.text.hsla()
                            } else {
                                theme.text_3.hsla()
                            }),
                    ),
            )
            .child(self.settings_switch_control(900_000, auto_settle, true, toggle))
            .into_any_element();

        settings_panel(
            "Workflows",
            vec![settings_group(
                "",
                vec![
                    settings_row(0, "Sidebar version", "", version_picker, theme),
                    settings_row(1, "Settle inactive threads", "", settle_control, theme),
                ],
                theme,
            )],
            theme,
        )
    }

    fn appearance_settings(&self, cx: &mut Context<Self>) -> gpui::Div {
        let theme = self.theme;
        let mut blocks = Vec::new();
        let theme_options = [
            (ThemePreference::System, "System"),
            (ThemePreference::Light, "Light"),
            (ThemePreference::Dark, "Dark"),
        ];
        let mut theme_cards = Vec::new();
        for (index, (preference, label)) in theme_options.into_iter().enumerate() {
            let selected = self.preferences.theme == preference;
            let view = cx.weak_entity();
            let action: SettingsAction = Rc::new(move |cx| {
                let _ = view.update(cx, |this, cx| this.set_theme_preference(preference, cx));
            });
            theme_cards.push(theme_card(
                index, label, preference, selected, theme, action,
            ));
        }
        blocks.push(settings_plain_group(
            "",
            div()
                .relative()
                .w_full()
                .flex()
                .gap(px(16.0))
                .children(theme_cards)
                .into_any_element(),
            theme,
        ));

        let font_options = [
            (FontPreference::Geist, "Geist"),
            (FontPreference::System, "System"),
            (FontPreference::Humanist, "Humanist"),
            (FontPreference::Rounded, "Rounded"),
            (FontPreference::Serif, "Editorial"),
            (FontPreference::Mono, "Mono"),
        ];
        let mut font_choices = Vec::new();
        for (index, (preference, label)) in font_options.into_iter().enumerate() {
            let view = cx.weak_entity();
            let action: SettingsAction = Rc::new(move |cx| {
                let _ = view.update(cx, |this, cx| this.set_font_preference(preference, cx));
            });
            font_choices.push(appearance_choice(
                index,
                label,
                super::resolve_interface_font(preference, &self.available_fonts),
                None,
                self.preferences.font == preference,
                theme,
                action,
            ));
        }
        blocks.push(settings_plain_group(
            "Interface font",
            div()
                .grid()
                .grid_cols(3)
                .gap(px(8.0))
                .children(font_choices)
                .into_any_element(),
            theme,
        ));

        let backdrop_options = [
            (Backdrop::Default, "Graphite", (0x1a1a1a, 0x444444)),
            (Backdrop::Slate, "Slate", (0x12151a, 0x3a4353)),
            (Backdrop::Mocha, "Mocha", (0x161312, 0x55453d)),
            (Backdrop::Forest, "Forest", (0x121713, 0x3c5242)),
            (Backdrop::Midnight, "Midnight", (0x0e1119, 0x2c3a5e)),
            (Backdrop::Plum, "Plum", (0x161217, 0x4d3a52)),
        ];
        let mut backdrop_choices = Vec::new();
        for (index, (backdrop, label, swatch)) in backdrop_options.into_iter().enumerate() {
            let view = cx.weak_entity();
            let action: SettingsAction = Rc::new(move |cx| {
                let _ = view.update(cx, |this, cx| this.set_backdrop(backdrop, cx));
            });
            backdrop_choices.push(appearance_choice(
                100 + index,
                label,
                "Geist",
                Some(swatch),
                self.preferences.backdrop == backdrop,
                theme,
                action,
            ));
        }
        blocks.push(settings_plain_group(
            "Background",
            div()
                .grid()
                .grid_cols(4)
                .gap(px(8.0))
                .children(backdrop_choices)
                .into_any_element(),
            theme,
        ));

        let glass_options: [(u8, &str); 4] =
            [(0, "Off"), (20, "Subtle"), (35, "Medium"), (50, "Strong")];
        let selected_glass = glass_options
            .iter()
            .min_by_key(|(value, _)| (*value).abs_diff(self.preferences.sidebar_glass))
            .map_or(35, |(value, _)| *value);
        let mut glass_choices = Vec::with_capacity(glass_options.len());
        for (index, (glass, label)) in glass_options.into_iter().enumerate() {
            let view = cx.weak_entity();
            let action: SettingsAction = Rc::new(move |cx| {
                let _ = view.update(cx, |this, cx| this.set_sidebar_glass(glass, cx));
            });
            glass_choices.push(glass_choice(
                300 + index,
                label,
                glass,
                selected_glass == glass,
                theme,
                action,
            ));
        }
        blocks.push(settings_plain_group(
            "Sidebar translucency",
            div()
                .grid()
                .grid_cols(3)
                .gap(px(8.0))
                .children(glass_choices)
                .into_any_element(),
            theme,
        ));

        let accent_options = [
            (Accent::Neutral, "Neutral", (0x71717a, 0xd4d4d8)),
            (Accent::Ocean, "Ocean", (0x2d7fbd, 0x79c8dd)),
            (Accent::Forest, "Forest", (0x397a56, 0x94c879)),
            (Accent::Sunset, "Sunset", (0x8b63bd, 0xe58c76)),
            (Accent::Amber, "Amber", (0x9a6823, 0xe2b568)),
            (Accent::Rose, "Rose", (0x9a4b6a, 0xe59aad)),
            (Accent::Lavender, "Lavender", (0x6658a6, 0xc49ad8)),
        ];
        let mut accent_choices = Vec::new();
        for (index, (accent, label, swatch)) in accent_options.into_iter().enumerate() {
            let view = cx.weak_entity();
            let action: SettingsAction = Rc::new(move |cx| {
                let _ = view.update(cx, |this, cx| this.set_accent(accent, cx));
            });
            accent_choices.push(appearance_choice(
                200 + index,
                label,
                "Geist",
                Some(swatch),
                self.preferences.accent == accent,
                theme,
                action,
            ));
        }
        blocks.push(settings_plain_group(
            "Accent palette",
            div()
                .grid()
                .grid_cols(4)
                .gap(px(8.0))
                .children(accent_choices)
                .into_any_element(),
            theme,
        ));

        #[cfg(target_os = "macos")]
        blocks.push(settings_group(
            "Text rendering",
            vec![settings_row(
                0,
                "Font smoothing",
                "",
                status_pill("On", true, theme),
                theme,
            )],
            theme,
        ));

        settings_panel_with_gap("Appearance", blocks, theme, APPEARANCE_SECTION_GAP)
    }

    fn data_settings(&self, cx: &mut Context<Self>) -> gpui::Div {
        let theme = self.theme;
        let project_count = self.state.projects.len();
        let reset_view = cx.weak_entity();
        let reset: SettingsAction = Rc::new(move |cx| {
            let _ = reset_view.update(cx, |this, cx| this.reset_native_preferences(cx));
        });
        settings_panel(
            "Data",
            vec![settings_group(
                "",
                vec![settings_row(
                    0,
                    format!(
                        "{project_count} {} on this machine",
                        if project_count == 1 {
                            "project"
                        } else {
                            "projects"
                        }
                    ),
                    "",
                    settings_button(
                        "reset-native-settings",
                        "Reset app",
                        "icons/rotate-ccw.svg",
                        theme,
                        reset,
                        true,
                    ),
                    theme,
                )],
                theme,
            )],
            theme,
        )
    }

    fn about_settings(&self, cx: &mut Context<Self>) -> gpui::Div {
        let theme = self.theme;
        let product_note = self
            .state
            .update_check
            .as_ref()
            .and_then(|result| result.local_commit.as_deref())
            .map_or_else(
                || "Desktop · pre-release".to_owned(),
                |commit| format!("Desktop · pre-release · {}", short_commit(commit)),
            );
        let update_status = update_check_note(self.state.update_check.as_ref());
        let update_error = self
            .state
            .update_check
            .as_ref()
            .and_then(|result| result.error.clone());
        let checking = self.state.update_checking;
        let check_view = cx.weak_entity();
        let check: SettingsAction = Rc::new(move |cx| {
            let _ = check_view.update(cx, |this, cx| {
                let update = this.state.request_update_check();
                this.apply_client_update(update, cx);
            });
        });
        let source: SettingsAction = Rc::new(|cx| {
            cx.open_url("https://github.com/Leonxlnx/tastecode");
        });
        let update_controls = div()
            .flex()
            .items_center()
            .gap(px(10.0))
            .when_some(update_error, |controls, error| {
                controls.child(row_issue(
                    "update-check-error",
                    error,
                    Some("Check your network or GitHub access, then retry.".into()),
                    theme,
                ))
            })
            .when_some(update_status, |controls, status| {
                controls.child(settings_status(status, false, theme))
            })
            .child(settings_button_enabled(
                "check-for-updates",
                if checking {
                    "Checking…"
                } else {
                    "Check for updates"
                },
                "icons/rotate-ccw.svg",
                theme,
                check,
                false,
                !checking,
            ))
            .into_any_element();
        settings_panel(
            "About",
            vec![settings_group(
                "",
                vec![
                    settings_row(
                        0,
                        "TasteCode",
                        "",
                        settings_status(product_note, false, theme),
                        theme,
                    ),
                    settings_row(1, "Updates", "", update_controls, theme),
                    settings_row(
                        2,
                        "Source",
                        "",
                        provider_action_button(0, "GitHub", false, theme, source),
                        theme,
                    ),
                ],
                theme,
            )],
            theme,
        )
    }

    fn refresh_settings_inventory(&mut self, cx: &mut Context<Self>) {
        let Some((provider, project_path)) = self.settings_scope() else {
            cx.notify();
            return;
        };
        let update = match self.settings_section {
            SettingsSection::Mcp => self.state.request_mcp_inventory(provider, project_path),
            SettingsSection::Skills => self.state.request_skills_inventory(provider, project_path),
            _ => {
                cx.notify();
                return;
            }
        };
        self.apply_client_update(update, cx);
    }

    fn settings_scope(&self) -> Option<(ProviderId, String)> {
        let provider = self
            .selected_model_choice()
            .map_or(ProviderId::Codex, |choice| choice.provider);
        let project_path = self
            .active_project_path
            .clone()
            .or_else(|| self.sidebar_scope.clone())
            .or_else(|| {
                self.state
                    .projects
                    .first()
                    .map(|project| project.path.clone())
            })?;
        Some((provider, project_path))
    }

    fn settings_project_name(&self, project_path: &str) -> String {
        self.state
            .projects
            .iter()
            .find(|project| project.path == project_path)
            .map_or_else(|| project_path.to_owned(), |project| project.name.clone())
    }

    fn settings_provider_name(&self, provider: ProviderId) -> String {
        self.state
            .provider_statuses
            .iter()
            .find(|status| status.id == provider)
            .map(|status| status.display_name.clone())
            .or_else(|| {
                self.state
                    .model_catalog
                    .iter()
                    .find(|choice| choice.provider == provider)
                    .map(|choice| choice.source_name.clone())
            })
            .unwrap_or_else(|| provider_label(provider).into())
    }

    fn pick_skill_folder(
        &mut self,
        provider: ProviderId,
        project_path: String,
        cx: &mut Context<Self>,
    ) {
        let receiver = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Install Agent Skill".into()),
        });
        cx.spawn(async move |view, cx| {
            let Ok(Ok(Some(paths))) = receiver.await else {
                return;
            };
            let Some(folder) = paths.into_iter().next() else {
                return;
            };
            let folder_path = folder.to_string_lossy().into_owned();
            let _ = view.update(cx, |this, cx| {
                let update =
                    this.state
                        .install_skill_from_folder(provider, project_path, folder_path);
                this.apply_client_update(update, cx);
            });
        })
        .detach();
    }

    fn set_models_visible(&mut self, keys: &[String], visible: bool, cx: &mut Context<Self>) {
        for key in keys {
            if visible {
                self.preferences.hidden_models.remove(key);
            } else {
                self.preferences.hidden_models.insert(key.clone());
            }
        }
        self.sync_model_selection(cx);
        self.sync_composer_settings(cx);
        self.persist_native_preferences();
        cx.notify();
    }

    pub(super) fn prepare_auto_settle_days_input(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (focused, current) = {
            let input = self.auto_settle_days_input.read(cx);
            (
                input.focus_handle(cx).is_focused(window),
                input.value().to_string(),
            )
        };
        if focused {
            return;
        }
        let desired = self
            .state
            .sidebar_settings
            .auto_settle_days
            .unwrap_or(3)
            .to_string();
        if current != desired {
            self.auto_settle_days_input
                .update(cx, |input, cx| input.set_value(desired, window, cx));
        }
    }

    fn set_sidebar_mode(&mut self, mode: SidebarMode, cx: &mut Context<Self>) {
        if self.state.sidebar_settings.mode == mode {
            return;
        }
        let settings = SidebarSettings {
            mode,
            auto_settle_days: self.state.sidebar_settings.auto_settle_days,
        };
        let update = self.state.update_sidebar_settings(settings);
        self.apply_client_update(update, cx);
    }

    pub(super) fn set_auto_settle_days(&mut self, days: Option<u8>, cx: &mut Context<Self>) {
        let days = days.map(|days| days.clamp(1, 90));
        if self.state.sidebar_settings.auto_settle_days == days {
            return;
        }
        let settings = SidebarSettings {
            mode: self.state.sidebar_settings.mode,
            auto_settle_days: days,
        };
        let update = self.state.update_sidebar_settings(settings);
        self.apply_client_update(update, cx);
    }

    fn set_theme_preference(&mut self, preference: ThemePreference, cx: &mut Context<Self>) {
        self.preferences.theme = preference;
        self.apply_native_theme(cx);
    }

    fn set_font_preference(&mut self, preference: FontPreference, cx: &mut Context<Self>) {
        self.preferences.font = preference;
        let interface_font = self.interface_font();
        super::sync_component_theme(self.theme, interface_font, cx);
        self.chat.update(cx, |chat, cx| {
            chat.update_interface_font(interface_font.into(), cx)
        });
        self.persist_native_preferences();
        cx.notify();
    }

    fn set_backdrop(&mut self, backdrop: Backdrop, cx: &mut Context<Self>) {
        self.preferences.backdrop = backdrop;
        self.apply_native_theme(cx);
    }

    fn set_accent(&mut self, accent: Accent, cx: &mut Context<Self>) {
        self.preferences.accent = accent;
        self.apply_native_theme(cx);
    }

    fn set_sidebar_glass(&mut self, glass: u8, cx: &mut Context<Self>) {
        self.preferences.sidebar_glass = glass.min(60);
        self.persist_native_preferences();
        cx.notify();
    }

    pub(super) fn apply_native_theme(&mut self, cx: &mut Context<Self>) {
        let mode = match self.preferences.theme {
            ThemePreference::System => self.system_theme_mode,
            ThemePreference::Light => ThemeMode::Light,
            ThemePreference::Dark => ThemeMode::Dark,
        };
        self.theme = Theme::new(mode, self.preferences.backdrop, self.preferences.accent)
            .with_reduced_motion(self.reduced_motion);
        let interface_font = self.interface_font();
        super::sync_component_theme(self.theme, interface_font, cx);
        let theme = self.theme;
        self.chat.update(cx, |chat, cx| {
            chat.update_theme(theme, cx);
            chat.update_interface_font(interface_font.into(), cx);
        });
        self.update_provider_terminal_themes(cx);
        self.persist_native_preferences();
        cx.notify();
    }

    fn reset_native_preferences(&mut self, cx: &mut Context<Self>) {
        self.preferences = NativePreferences::default();
        self.sidebar_width = f32::from(self.preferences.rail_width);
        self.sidebar_collapsed = false;
        self.selected_model_key = None;
        self.effort = None;
        self.service_tier = None;
        self.approval = self.preferences.approval;
        self.isolate_session = false;
        self.design_mode = false;
        for project in &mut self.state.projects {
            project
                .sessions
                .sort_by(|left, right| right.created_at.total_cmp(&left.created_at));
        }
        self.chat
            .update(cx, |chat, cx| chat.reset_terminal_preferences(cx));
        match NativePreferences::reset_file() {
            Ok(()) => self.state.notice = Some("Native preferences were reset.".into()),
            Err(error) => self.state.notice = Some(format!("Could not reset preferences: {error}")),
        }
        self.close_settings(cx);
        self.apply_native_theme(cx);
        self.sync_model_selection(cx);
        self.sync_composer_settings(cx);
    }

    pub(super) fn persist_native_preferences(&mut self) {
        if let Err(error) = self.preferences.save() {
            self.state.notice = Some(format!("Could not save native preferences: {error}"));
        }
    }

    pub(super) fn interface_font(&self) -> &'static str {
        super::resolve_interface_font(self.preferences.font, &self.available_fonts)
    }
}

fn settings_panel(title: &str, blocks: Vec<AnyElement>, theme: Theme) -> gpui::Div {
    settings_panel_with_gap(title, blocks, theme, SETTINGS_SECTION_GAP)
}

fn settings_panel_with_gap(
    title: &str,
    blocks: Vec<AnyElement>,
    theme: Theme,
    section_gap: f32,
) -> gpui::Div {
    div()
        .w_full()
        .child(
            div()
                .mb(px(22.0))
                .text_size(px(26.0))
                .line_height(relative(1.2))
                .font_weight(FontWeight(550.0))
                .text_color(theme.text.hsla())
                .child(tracked_text(title.to_owned(), -0.026)),
        )
        .child(
            div()
                .w_full()
                .flex()
                .flex_col()
                .gap(px(section_gap))
                .children(blocks),
        )
}

fn inventory_settings_panel(
    title: &'static str,
    subtitle: String,
    action: Option<AnyElement>,
    blocks: Vec<AnyElement>,
    theme: Theme,
) -> gpui::Div {
    div()
        .w_full()
        .child(
            div()
                .w_full()
                .flex()
                .items_start()
                .justify_between()
                .gap(px(24.0))
                .mb(px(24.0))
                .child(
                    div()
                        .min_w(px(0.0))
                        .child(
                            div()
                                .mb(px(5.0))
                                .text_size(px(26.0))
                                .line_height(relative(1.2))
                                .font_weight(FontWeight(550.0))
                                .text_color(theme.text.hsla())
                                .child(title),
                        )
                        .child(
                            div()
                                .text_size(px(12.5))
                                .text_color(theme.text_3.hsla())
                                .child(subtitle),
                        ),
                )
                .when_some(action, |header, action| header.child(action)),
        )
        .child(
            div()
                .w_full()
                .flex()
                .flex_col()
                .gap(px(14.0))
                .children(blocks),
        )
}

fn inventory_empty(message: impl Into<SharedString>, theme: Theme) -> AnyElement {
    div()
        .w_full()
        .p(px(28.0))
        .text_center()
        .rounded(px(8.0))
        .border_1()
        .border_color(theme.line_strong.hsla())
        .bg(chrome::rail_background(theme))
        .text_size(px(12.5))
        .text_color(theme.text_3.hsla())
        .child(message.into())
        .into_any_element()
}

fn inventory_message(message: impl Into<SharedString>, error: bool, theme: Theme) -> AnyElement {
    div()
        .w_full()
        .px(px(12.0))
        .py(px(10.0))
        .rounded(px(8.0))
        .border_1()
        .border_color(if error {
            theme.error.hsla().opacity(0.42)
        } else {
            theme.line_strong.hsla()
        })
        .when(error, |message| {
            message.bg(theme.error.hsla().opacity(0.07))
        })
        .text_size(px(12.5))
        .line_height(relative(1.45))
        .text_color(if error {
            theme.error.hsla()
        } else {
            theme.text_2.hsla()
        })
        .child(message.into())
        .into_any_element()
}

fn settings_group(title: &str, rows: Vec<AnyElement>, theme: Theme) -> AnyElement {
    div()
        .w_full()
        .when(!title.is_empty(), |group| {
            group.child(
                div()
                    .mb(px(12.0))
                    .text_size(px(13.5))
                    .font_weight(FontWeight(520.0))
                    .text_color(theme.text_2.hsla())
                    .child(title.to_owned()),
            )
        })
        .child(
            div()
                .w_full()
                .overflow_hidden()
                .rounded(px(crate::RADIUS_LG))
                .border_1()
                .border_color(chrome::border(theme))
                .bg(chrome::rail_background(theme))
                .shadow(chrome::shadows(theme))
                .child(chrome::top_highlight(theme))
                .children(rows),
        )
        .into_any_element()
}

fn settings_plain_group(title: &str, child: AnyElement, theme: Theme) -> AnyElement {
    div()
        .w_full()
        .when(!title.is_empty(), |group| {
            group.child(
                div()
                    .mb(px(12.0))
                    .text_size(px(13.5))
                    .font_weight(FontWeight(520.0))
                    .text_color(theme.text_2.hsla())
                    .child(title.to_owned()),
            )
        })
        .child(child)
        .into_any_element()
}

fn model_settings_empty(message: &'static str, theme: Theme) -> AnyElement {
    div()
        .relative()
        .min_h(px(72.0))
        .w_full()
        .flex()
        .items_center()
        .gap(px(10.0))
        .px(px(18.0))
        .rounded(px(crate::RADIUS_LG))
        .border_1()
        .border_color(chrome::border(theme))
        .bg(chrome::rail_background(theme))
        .shadow(chrome::shadows(theme))
        .child(chrome::top_highlight(theme))
        .text_size(px(12.5))
        .text_color(theme.text_3.hsla())
        .child(motion_icon(
            "model-settings-empty-icon",
            "icons/boxes.svg",
            18.0,
            "model-settings-empty-icon-direct-hover",
            theme,
        ))
        .child(message)
        .into_any_element()
}

fn model_settings_search_field(
    source_index: usize,
    state: &Entity<InputState>,
    theme: Theme,
    window: &Window,
    cx: &App,
) -> AnyElement {
    let query = state.read(cx).value().to_string();
    let focused = state.read(cx).focus_handle(cx).is_focused(window);
    let escape_state = state.clone();
    let clear_state = state.clone();
    let keyboard_clear_state = clear_state.clone();

    div()
        .id(SharedString::from(format!(
            "model-settings-search:{source_index}"
        )))
        .relative()
        .h(px(28.0))
        .min_w(px(120.0))
        .flex_1()
        .flex()
        .items_center()
        .gap(px(6.0))
        .px(px(7.0))
        .overflow_hidden()
        .rounded(px(5.0))
        .border_1()
        .border_color(if focused {
            theme.text_3.hsla()
        } else {
            chrome::border(theme)
        })
        .bg(chrome::recessed(theme))
        .text_color(theme.text_3.hsla())
        .on_key_down(move |event: &KeyDownEvent, window, cx| {
            if event.keystroke.key.eq_ignore_ascii_case("escape")
                && !escape_state.read(cx).value().is_empty()
            {
                cx.stop_propagation();
                escape_state.update(cx, |input, cx| input.set_value("", window, cx));
            }
        })
        .child(chrome::inset_top_shade(theme))
        .child(motion_icon(
            ("model-settings-search-icon", source_index),
            "icons/search.svg",
            13.0,
            "model-settings-search-icon-direct-hover",
            theme,
        ))
        .child(
            Input::new(state)
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
        .when(!query.is_empty(), |field| {
            field.child(
                div()
                    .id(SharedString::from(format!(
                        "model-settings-search-clear:{source_index}"
                    )))
                    .group("model-settings-search-clear-hover")
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
                            keyboard_clear_state.update(cx, |input, cx| {
                                input.set_value("", window, cx);
                                input.focus(window, cx);
                            });
                        }
                    })
                    .on_click(move |_event, window, cx| {
                        cx.stop_propagation();
                        clear_state.update(cx, |input, cx| {
                            input.set_value("", window, cx);
                            input.focus(window, cx);
                        });
                    })
                    .child(motion_icon(
                        ("model-settings-search-clear-icon", source_index),
                        "icons/x.svg",
                        12.0,
                        "model-settings-search-clear-hover",
                        theme,
                    )),
            )
        })
        .into_any_element()
}

fn model_visibility_row(
    title: impl Into<SharedString>,
    visible: bool,
    trailing: AnyElement,
    theme: Theme,
) -> AnyElement {
    div()
        .min_h(px(44.0))
        .w_full()
        .flex()
        .items_center()
        .justify_between()
        .gap(px(16.0))
        .px(px(16.0))
        .py(px(10.0))
        .border_t_1()
        .border_color(theme.line.hsla())
        .hover(move |style| style.bg(theme.surface.hsla()))
        .child(
            div()
                .min_w(px(0.0))
                .flex_1()
                .truncate()
                .text_size(px(13.5))
                .font_weight(FontWeight::MEDIUM)
                .text_color(if visible {
                    theme.text.hsla()
                } else {
                    theme.text_2.hsla()
                })
                .child(title.into()),
        )
        .child(div().flex_none().child(trailing))
        .into_any_element()
}

fn settings_inside_title(title: &'static str, theme: Theme) -> AnyElement {
    div()
        .pt(px(14.0))
        .pb(px(6.0))
        .px(px(16.0))
        .text_size(px(13.5))
        .font_weight(FontWeight(520.0))
        .text_color(theme.text_2.hsla())
        .child(title)
        .into_any_element()
}

fn settings_error_group(title: &str, message: String, theme: Theme) -> AnyElement {
    div()
        .w_full()
        .child(
            div()
                .mb(px(12.0))
                .text_size(px(12.5))
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.error.hsla())
                .child(title.to_owned()),
        )
        .child(
            div()
                .w_full()
                .rounded(px(10.0))
                .border_1()
                .border_color(theme.error.hsla().opacity(0.35))
                .bg(theme.error.hsla().opacity(0.08))
                .px(px(16.0))
                .py(px(12.0))
                .text_size(px(11.0))
                .line_height(px(16.0))
                .text_color(theme.error.hsla())
                .child(message),
        )
        .into_any_element()
}

fn settings_row(
    index: usize,
    title: impl Into<SharedString>,
    note: impl Into<SharedString>,
    trailing: AnyElement,
    theme: Theme,
) -> AnyElement {
    let title = title.into();
    let note = note.into();
    div()
        .min_h(px(46.0))
        .w_full()
        .flex()
        .items_center()
        .justify_between()
        .gap(px(16.0))
        .px(px(16.0))
        .py(px(6.0))
        .when(index > 0, |row| {
            row.border_t_1().border_color(theme.line.hsla())
        })
        .hover(move |style| style.bg(theme.surface.hsla()))
        .child(
            div()
                .min_w(px(0.0))
                .flex_1()
                .child(
                    div()
                        .text_size(px(13.5))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(theme.text.hsla())
                        .child(title),
                )
                .when(!note.is_empty(), |copy| {
                    copy.child(
                        div()
                            .mt(px(2.0))
                            .text_size(px(12.5))
                            .line_height(relative(1.45))
                            .text_color(theme.text_3.hsla())
                            .child(note),
                    )
                }),
        )
        .child(div().flex_none().child(trailing))
        .into_any_element()
}

fn skill_settings_row(
    index: usize,
    skill: &Skill,
    trailing: AnyElement,
    theme: Theme,
) -> AnyElement {
    let name = skill
        .display_name
        .clone()
        .unwrap_or_else(|| skill.name.clone());
    let description = skill.description.clone();
    let source = match &skill.source {
        SkillSource::Folder { path } => path.clone(),
        SkillSource::Provider => "Managed by provider".into(),
    };
    let dependency_errors = skill.dependency_errors.clone();
    div()
        .min_h(px(46.0))
        .w_full()
        .flex()
        .items_start()
        .justify_between()
        .gap(px(16.0))
        .px(px(16.0))
        .py(px(6.0))
        .when(index > 0, |row| {
            row.border_t_1().border_color(theme.line.hsla())
        })
        .opacity(if skill.enabled { 1.0 } else { 0.58 })
        .hover(move |style| style.bg(theme.surface.hsla()))
        .child(
            div()
                .min_w(px(0.0))
                .flex_1()
                .child(
                    div()
                        .min_w(px(0.0))
                        .flex()
                        .items_center()
                        .gap(px(8.0))
                        .child(
                            div()
                                .min_w(px(0.0))
                                .truncate()
                                .text_size(px(13.5))
                                .font_weight(FontWeight(550.0))
                                .text_color(theme.text.hsla())
                                .child(name),
                        )
                        .child(inventory_badge(skill_scope_label(skill.scope), theme))
                        .child(inventory_badge(
                            if skill.enabled { "Enabled" } else { "Disabled" },
                            theme,
                        )),
                )
                .when(!description.is_empty(), |copy| {
                    copy.child(
                        div()
                            .mt(px(7.0))
                            .text_size(px(12.5))
                            .line_height(relative(1.5))
                            .text_color(theme.text_2.hsla())
                            .child(description),
                    )
                })
                .child(
                    div()
                        .mt(px(8.0))
                        .truncate()
                        .font_family("Geist Mono")
                        .text_size(px(11.5))
                        .text_color(theme.text_3.hsla())
                        .child(source),
                )
                .children(
                    dependency_errors
                        .into_iter()
                        .enumerate()
                        .map(|(error_index, error)| {
                            div()
                                .mt(px(10.0))
                                .pt(px(10.0))
                                .flex()
                                .items_center()
                                .gap(px(6.0))
                                .border_t_1()
                                .border_color(theme.line.hsla())
                                .text_size(px(11.5))
                                .text_color(theme.error.hsla())
                                .child(motion_icon(
                                    ("skill-dependency-alert-icon", error_index),
                                    "icons/triangle-alert.svg",
                                    13.0,
                                    "skill-dependency-alert-icon-direct-hover",
                                    theme,
                                ))
                                .child(
                                    div()
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .child(error.dependency),
                                )
                                .child(format!("· {}", error.message))
                        }),
                ),
        )
        .child(div().flex_none().child(trailing))
        .into_any_element()
}

fn inventory_badge(label: impl Into<SharedString>, theme: Theme) -> AnyElement {
    div()
        .flex_none()
        .px(px(6.0))
        .py(px(1.0))
        .rounded_full()
        .bg(theme.surface_2.hsla())
        .text_size(px(11.5))
        .text_color(theme.text_3.hsla())
        .child(label.into())
        .into_any_element()
}

fn skill_scope_label(scope: SkillScope) -> &'static str {
    match scope {
        SkillScope::Project => "Project",
        SkillScope::User => "User",
        SkillScope::System => "System",
        SkillScope::Admin => "Admin",
    }
}

fn settings_empty_row(note: impl Into<SharedString>, theme: Theme) -> AnyElement {
    div()
        .min_h(px(46.0))
        .w_full()
        .flex()
        .items_center()
        .px(px(16.0))
        .py(px(7.0))
        .text_size(px(12.5))
        .line_height(relative(1.45))
        .text_color(theme.text_3.hsla())
        .child(note.into())
        .into_any_element()
}

fn settings_nav_item(
    index: usize,
    label: &'static str,
    icon: &'static str,
    selected: bool,
    theme: Theme,
    action: SettingsAction,
) -> AnyElement {
    let hover_group: SharedString = format!("settings-nav-hover:{index}").into();
    div()
        .id(("settings-nav", index))
        .group(hover_group.clone())
        .relative()
        .min_h(px(32.0))
        .w_full()
        .flex()
        .items_center()
        .gap(px(9.0))
        .px(px(8.0))
        .py(px(6.0))
        .rounded(px(5.0))
        .when(selected, |item| {
            item.bg(chrome::raised(theme))
                .shadow(chrome::shadows(theme))
        })
        .text_size(px(13.5))
        .text_color(if selected {
            theme.text.hsla()
        } else {
            theme.text_2.hsla()
        })
        .cursor_pointer()
        .hover(move |style| {
            style
                .bg(chrome::raised(theme))
                .shadow(chrome::shadows(theme))
                .text_color(theme.text.hsla())
        })
        .active(move |style| style.top(px(1.0)).shadow(Vec::new()))
        .on_click(move |_event, _window, cx| action(cx))
        .child(chrome::interactive_top_highlight(
            theme,
            hover_group.clone(),
            selected,
        ))
        .child(chrome::interactive_inset_shade(theme, hover_group.clone()))
        .child(
            div()
                .size(px(15.0))
                .text_color(if selected {
                    theme.text_2.hsla()
                } else {
                    theme.text_3.hsla()
                })
                .child(motion_icon(
                    ("settings-nav-icon", index),
                    icon,
                    15.0,
                    hover_group,
                    theme,
                )),
        )
        .child(label)
        .into_any_element()
}

fn settings_switch(
    id: usize,
    on: bool,
    enabled: bool,
    theme: Theme,
    action: SettingsAction,
    animation: Option<SettingsSwitchAnimation>,
) -> AnyElement {
    let off_background = if theme.mode == ThemeMode::Light {
        chrome::recessed(theme)
    } else {
        theme.surface_3.hsla()
    };
    let on_light = match theme.mode {
        ThemeMode::Dark => gpui::rgb(0x101010).into(),
        ThemeMode::Light => gpui::white(),
    };
    let off_border = if theme.mode == ThemeMode::Light {
        chrome::border(theme)
    } else {
        theme.line_strong.hsla()
    };
    let thumb = div()
        .absolute()
        .top(px(2.0))
        .left(px(if on { 16.0 } else { 2.0 }))
        .size(px(14.0))
        .rounded_full()
        .bg(if on { on_light } else { theme.text_2.hsla() });
    let thumb = if let Some(motion) = animation {
        thumb
            .with_animation(
                SharedString::from(format!("settings-switch-thumb:{id}:{}", motion.generation)),
                Animation::new(motion.duration).with_easing(crate::theme::web_ease_out),
                move |thumb, delta| {
                    let progress = switch_motion_progress(motion, delta);
                    thumb.left(px(2.0 + 14.0 * progress)).bg(interpolate_color(
                        theme.text_2.hsla(),
                        on_light,
                        progress,
                    ))
                },
            )
            .into_any_element()
    } else {
        thumb.into_any_element()
    };
    let switch = div()
        .id(("settings-switch", id))
        .relative()
        .w(px(34.0))
        .h(px(20.0))
        .flex_none()
        .overflow_hidden()
        .rounded_full()
        .border_1()
        .border_color(if on { theme.text.hsla() } else { off_border })
        .bg(if on {
            theme.text.hsla()
        } else {
            off_background
        })
        .opacity(if enabled { 1.0 } else { 0.5 })
        .when(enabled, |switch| {
            switch
                .cursor_pointer()
                .on_click(move |_event, _window, cx| action(cx))
        })
        .when(theme.mode == ThemeMode::Light && !on, |switch| {
            switch.child(chrome::inset_top_shade(theme))
        })
        .child(thumb);
    if let Some(motion) = animation {
        switch
            .with_animation(
                SharedString::from(format!("settings-switch-track:{id}:{}", motion.generation)),
                Animation::new(motion.duration).with_easing(crate::theme::web_ease_out),
                move |switch, delta| {
                    let progress = switch_motion_progress(motion, delta);
                    switch
                        .border_color(interpolate_color(off_border, theme.text.hsla(), progress))
                        .bg(interpolate_color(
                            off_background,
                            theme.text.hsla(),
                            progress,
                        ))
                },
            )
            .into_any_element()
    } else {
        switch.into_any_element()
    }
}

fn settings_switch_animation(
    states: &mut HashMap<usize, SettingsSwitchMotion>,
    id: usize,
    on: bool,
    base_duration: Duration,
    now: Instant,
) -> Option<SettingsSwitchAnimation> {
    let target = if on { 1.0 } else { 0.0 };
    let Some(state) = states.get_mut(&id) else {
        states.insert(
            id,
            SettingsSwitchMotion {
                target: on,
                from: target,
                started: now,
                duration: base_duration,
                generation: 0,
                animating: false,
            },
        );
        return None;
    };

    if state.target != on {
        let from = settings_switch_position(*state, now);
        let distance = (target - from).abs();
        state.target = on;
        state.from = from;
        state.started = now;
        state.generation = state.generation.wrapping_add(1);
        state.duration = if (distance - 1.0).abs() <= f32::EPSILON {
            base_duration
        } else {
            base_duration
                .mul_f32(distance)
                .max(Duration::from_millis(1))
        };
        state.animating = distance > 0.001;
    } else if state.animating && now.duration_since(state.started) >= state.duration {
        state.from = target;
        state.animating = false;
    }

    state.animating.then_some(SettingsSwitchAnimation {
        from: state.from,
        to: target,
        duration: state.duration,
        generation: state.generation,
    })
}

fn settings_switch_position(state: SettingsSwitchMotion, now: Instant) -> f32 {
    if !state.animating || state.duration.is_zero() {
        return if state.target { 1.0 } else { 0.0 };
    }
    let elapsed = now.duration_since(state.started).as_secs_f32();
    let progress = (elapsed / state.duration.as_secs_f32()).clamp(0.0, 1.0);
    let target = if state.target { 1.0 } else { 0.0 };
    state.from + (target - state.from) * crate::theme::web_ease_out(progress)
}

fn switch_motion_progress(motion: SettingsSwitchAnimation, delta: f32) -> f32 {
    motion.from + (motion.to - motion.from) * delta
}

fn interpolate_color(from: Hsla, to: Hsla, progress: f32) -> Hsla {
    let from = from.to_rgb();
    let to = to.to_rgb();
    let progress = progress.clamp(0.0, 1.0);
    Rgba {
        r: from.r + (to.r - from.r) * progress,
        g: from.g + (to.g - from.g) * progress,
        b: from.b + (to.b - from.b) * progress,
        a: from.a + (to.a - from.a) * progress,
    }
    .into()
}

fn segmented_button(
    id: &'static str,
    label: &'static str,
    selected: bool,
    theme: Theme,
    action: SettingsAction,
) -> AnyElement {
    div()
        .id(id)
        .relative()
        .h(px(28.0))
        .flex()
        .items_center()
        .px(px(9.0))
        .rounded(px(3.0))
        .when(selected, |button| {
            button
                .bg(chrome::raised(theme))
                .shadow(chrome::shadows(theme))
                .child(chrome::top_highlight(theme))
        })
        .text_size(px(12.5))
        .font_weight(FontWeight::NORMAL)
        .text_color(if selected {
            theme.text.hsla()
        } else {
            theme.text_3.hsla()
        })
        .cursor_pointer()
        .hover(move |style| style.text_color(theme.text.hsla()))
        .on_click(move |_event, _window, cx| action(cx))
        .child(label)
        .into_any_element()
}

fn settings_button(
    id: &'static str,
    label: &'static str,
    icon: &'static str,
    theme: Theme,
    action: SettingsAction,
    destructive: bool,
) -> AnyElement {
    settings_button_enabled(id, label, icon, theme, action, destructive, true)
}

fn connection_add_button(theme: Theme, action: SettingsAction) -> AnyElement {
    div()
        .id("add-connection")
        .group("add-connection-hover")
        .w_full()
        .py(px(13.0))
        .px(px(16.0))
        .flex()
        .items_center()
        .gap(px(9.0))
        .border_t_1()
        .border_color(theme.line.hsla())
        .text_size(px(13.5))
        .text_color(theme.text_2.hsla())
        .cursor_pointer()
        .hover(move |style| {
            style
                .bg(chrome::raised(theme))
                .text_color(theme.text.hsla())
        })
        .active(|style| style.top(px(1.0)))
        .on_click(move |_event, _window, cx| action(cx))
        .child(motion_icon(
            "add-connection-icon",
            "icons/plus.svg",
            15.0,
            "add-connection-hover",
            theme,
        ))
        .child("Connect another plan or API")
        .into_any_element()
}

fn settings_button_enabled(
    id: &'static str,
    label: &'static str,
    icon: &'static str,
    theme: Theme,
    action: SettingsAction,
    destructive: bool,
    enabled: bool,
) -> AnyElement {
    let hover_group: SharedString = format!("{id}:hover").into();
    let icon_id: SharedString = format!("{id}:icon").into();
    let text = if destructive {
        theme.error.hsla()
    } else {
        theme.text_2.hsla()
    };
    div()
        .id(id)
        .group(hover_group.clone())
        .relative()
        .h(px(30.0))
        .flex()
        .items_center()
        .gap(px(7.0))
        .px(px(10.0))
        .rounded(px(5.0))
        .border_1()
        .border_color(chrome::border(theme))
        .bg(chrome::raised(theme))
        .shadow(chrome::shadows(theme))
        .child(chrome::interactive_top_highlight(
            theme,
            hover_group.clone(),
            true,
        ))
        .child(chrome::interactive_inset_shade(theme, hover_group.clone()))
        .text_size(px(12.5))
        .text_color(text)
        .opacity(if enabled { 1.0 } else { 0.5 })
        .when(enabled, |button| {
            button
                .cursor_pointer()
                .hover(move |style| {
                    style
                        .bg(theme.surface_3.hsla())
                        .text_color(theme.text.hsla())
                })
                .active(|style| style.top(px(1.0)).shadow(Vec::new()))
                .on_click(move |_event, _window, cx| action(cx))
        })
        .child(motion_icon(icon_id, icon, 13.0, hover_group, theme))
        .child(label)
        .into_any_element()
}

fn connection_remove_button(index: usize, theme: Theme, action: SettingsAction) -> AnyElement {
    let hover_group: SharedString = format!("remove-connection-hover:{index}").into();
    div()
        .id(("remove-connection", index))
        .group(hover_group.clone())
        .relative()
        .h(px(26.0))
        .flex()
        .items_center()
        .px(px(9.0))
        .rounded(px(5.0))
        .border_1()
        .border_color(chrome::border(theme))
        .bg(chrome::raised(theme))
        .shadow(chrome::shadows(theme))
        .child(chrome::interactive_top_highlight(
            theme,
            hover_group.clone(),
            true,
        ))
        .child(chrome::interactive_inset_shade(theme, hover_group))
        .text_size(px(12.5))
        .text_color(theme.error.hsla())
        .cursor_pointer()
        .hover(move |style| style.bg(theme.surface_3.hsla()))
        .active(|style| style.top(px(1.0)).shadow(Vec::new()))
        .on_click(move |_event, _window, cx| action(cx))
        .child("Remove")
        .into_any_element()
}

fn provider_action_button(
    index: usize,
    label: &'static str,
    sign_out: bool,
    theme: Theme,
    action: SettingsAction,
) -> AnyElement {
    let hover_group: SharedString = format!("provider-action-hover:{index}").into();
    div()
        .id(("provider-action", index))
        .group(hover_group.clone())
        .relative()
        .flex()
        .items_center()
        .gap(px(6.0))
        .px(px(10.0))
        .py(px(6.0))
        .rounded(px(5.0))
        .border_1()
        .border_color(chrome::border(theme))
        .bg(chrome::raised(theme))
        .shadow(chrome::shadows(theme))
        .child(chrome::interactive_top_highlight(
            theme,
            hover_group.clone(),
            true,
        ))
        .child(chrome::interactive_inset_shade(theme, hover_group.clone()))
        .text_size(px(12.5))
        .line_height(relative(1.55))
        .text_color(theme.text_2.hsla())
        .cursor_pointer()
        .hover(move |style| {
            style
                .bg(theme.surface_3.hsla())
                .text_color(theme.text.hsla())
        })
        .active(|style| style.top(px(1.0)).shadow(Vec::new()))
        .on_click(move |_event, _window, cx| action(cx))
        .when(sign_out, |button| {
            button.child(motion_icon(
                ("provider-action-icon", index),
                "icons/log-out.svg",
                13.0,
                hover_group,
                theme,
            ))
        })
        .child(label)
        .into_any_element()
}

fn provider_action_disabled(label: &'static str, sign_out: bool, theme: Theme) -> AnyElement {
    div()
        .relative()
        .flex()
        .items_center()
        .gap(px(6.0))
        .px(px(10.0))
        .py(px(6.0))
        .rounded(px(5.0))
        .border_1()
        .border_color(chrome::border(theme))
        .bg(chrome::raised(theme))
        .shadow(chrome::shadows(theme))
        .child(chrome::top_highlight(theme))
        .text_size(px(12.5))
        .line_height(relative(1.55))
        .text_color(theme.text_3.hsla())
        .opacity(0.5)
        .when(sign_out, |button| {
            button.child(motion_icon(
                SharedString::from(format!("provider-action-disabled-icon:{label}")),
                "icons/log-out.svg",
                13.0,
                "provider-action-disabled-icon-direct-hover",
                theme,
            ))
        })
        .child(label)
        .into_any_element()
}

fn mcp_action_button(
    id: SharedString,
    label: SharedString,
    icon: Option<&'static str>,
    destructive: bool,
    enabled: bool,
    theme: Theme,
    action: impl Fn(&gpui::ClickEvent, &mut Window, &mut App) + 'static,
) -> AnyElement {
    let hover_group: SharedString = format!("{id}:hover").into();
    let icon_id: SharedString = format!("{id}:icon").into();
    div()
        .id(id)
        .group(hover_group.clone())
        .relative()
        .flex()
        .items_center()
        .gap(px(6.0))
        .px(px(10.0))
        .py(px(6.0))
        .rounded(px(5.0))
        .border_1()
        .border_color(chrome::border(theme))
        .bg(chrome::raised(theme))
        .shadow(chrome::shadows(theme))
        .child(chrome::interactive_top_highlight(
            theme,
            hover_group.clone(),
            true,
        ))
        .child(chrome::interactive_inset_shade(theme, hover_group.clone()))
        .text_size(px(12.5))
        .line_height(relative(1.55))
        .text_color(if destructive {
            theme.error.hsla()
        } else {
            theme.text_2.hsla()
        })
        .opacity(if enabled { 1.0 } else { 0.5 })
        .when(enabled, |button| {
            button
                .cursor_pointer()
                .hover(move |style| {
                    style.bg(theme.surface_3.hsla()).text_color(if destructive {
                        theme.error.hsla()
                    } else {
                        theme.text.hsla()
                    })
                })
                .active(|style| style.top(px(1.0)).shadow(Vec::new()))
                .on_click(action)
        })
        .when_some(icon, |button, icon| {
            button.child(motion_icon(icon_id, icon, 13.0, hover_group, theme))
        })
        .child(label)
        .into_any_element()
}

fn mcp_badge(label: &'static str, theme: Theme) -> AnyElement {
    inventory_badge(label, theme)
}

fn mcp_transport_label(transport: Option<&McpTransport>) -> String {
    match transport {
        Some(McpTransport::Http { url, .. }) => url.clone(),
        Some(McpTransport::Stdio { command, args, .. }) => std::iter::once(command.as_str())
            .chain(args.iter().flatten().map(String::as_str))
            .collect::<Vec<_>>()
            .join(" "),
        None => "Configuration managed by provider".into(),
    }
}

#[derive(Clone, Copy)]
struct McpEditorFieldSpec {
    label: &'static str,
    disabled: bool,
    multiline_height: Option<f32>,
    help: Option<&'static str>,
}

fn mcp_editor_field(
    spec: McpEditorFieldSpec,
    state: &Entity<InputState>,
    resize_handle: Option<AnyElement>,
    theme: Theme,
    window: &Window,
    cx: &App,
) -> AnyElement {
    let focused = state.read(cx).focus_handle(cx).is_focused(window);
    let border = if focused {
        theme.text_3.hsla()
    } else {
        theme.line_strong.hsla()
    };
    let input = if let Some(height) = spec.multiline_height {
        div()
            .relative()
            .h(px(height))
            .w_full()
            .child(
                Input::new(state)
                    .appearance(false)
                    .bordered(false)
                    .focus_bordered(false)
                    .disabled(spec.disabled)
                    .h(px(height))
                    .w_full()
                    .px(px(9.0))
                    .py(px(8.0))
                    .line_height(relative(1.55))
                    .rounded(px(5.0))
                    .border_1()
                    .border_color(border)
                    .bg(theme.surface_2.hsla())
                    .text_size(px(13.5))
                    .text_color(theme.text.hsla()),
            )
            .when_some(resize_handle, |field, handle| field.child(handle))
            .into_any_element()
    } else {
        div()
            .h(px(38.925))
            .w_full()
            .flex()
            .items_center()
            .px(px(9.0))
            .py(px(8.0))
            .rounded(px(5.0))
            .border_1()
            .border_color(border)
            .bg(theme.surface_2.hsla())
            .child(
                Input::new(state)
                    .xsmall()
                    .appearance(false)
                    .bordered(false)
                    .focus_bordered(false)
                    .disabled(spec.disabled)
                    .w_full()
                    .px(px(0.0))
                    .py(px(0.0))
                    .line_height(relative(1.55))
                    .text_size(px(13.5))
                    .text_color(theme.text.hsla()),
            )
            .into_any_element()
    };

    div()
        .min_w(px(0.0))
        .flex_1()
        .flex()
        .flex_col()
        .gap(px(6.0))
        .when(spec.multiline_height.is_some(), |field| field.w_full())
        .child(
            div()
                .text_size(px(12.5))
                .text_color(theme.text_2.hsla())
                .child(spec.label),
        )
        .child(input)
        .when_some(spec.help, |field, help| {
            field.child(
                div()
                    .text_size(px(11.5))
                    .line_height(relative(1.55))
                    .text_color(theme.text_3.hsla())
                    .child(help),
            )
        })
        .into_any_element()
}

fn resized_mcp_transport_height(start_height: f32, delta: f32) -> f32 {
    (start_height + delta).max(MCP_TRANSPORT_MIN_HEIGHT)
}

fn connection_field(
    label: &'static str,
    state: &Entity<InputState>,
    wide: bool,
    theme: Theme,
) -> AnyElement {
    div()
        .min_w(px(if wide { 0.0 } else { 220.0 }))
        .when(wide, |field| field.w_full().flex_none())
        .when(!wide, |field| field.flex_1())
        .child(
            div()
                .mb(px(6.0))
                .text_size(px(12.5))
                .text_color(theme.text_3.hsla())
                .child(label),
        )
        .child(
            Input::new(state)
                .appearance(false)
                .bordered(false)
                .focus_bordered(false)
                .h(px(34.0))
                .w_full()
                .px(px(10.0))
                .rounded(px(5.0))
                .border_1()
                .border_color(chrome::border(theme))
                .bg(theme.background.hsla())
                .text_size(px(13.5))
                .text_color(theme.text.hsla()),
        )
        .into_any_element()
}

#[derive(Clone, Copy)]
struct ConnectionPresetConfig {
    label: &'static str,
    base_url: &'static str,
    transport: ModelTransport,
}

fn connection_preset(preset: ModelConnectionPreset) -> ConnectionPresetConfig {
    match preset {
        ModelConnectionPreset::Openai => ConnectionPresetConfig {
            label: "OpenAI API",
            base_url: "https://api.openai.com/v1",
            transport: ModelTransport::OpenaiResponses,
        },
        ModelConnectionPreset::Anthropic => ConnectionPresetConfig {
            label: "Anthropic API",
            base_url: "https://api.anthropic.com/v1",
            transport: ModelTransport::AnthropicMessages,
        },
        ModelConnectionPreset::Openrouter => ConnectionPresetConfig {
            label: "OpenRouter",
            base_url: "https://openrouter.ai/api/v1",
            transport: ModelTransport::OpenaiCompatible,
        },
        ModelConnectionPreset::Kimi => ConnectionPresetConfig {
            label: "Kimi API",
            base_url: "https://api.moonshot.ai/v1",
            transport: ModelTransport::OpenaiCompatible,
        },
        ModelConnectionPreset::Zai => ConnectionPresetConfig {
            label: "Z.ai API",
            base_url: "https://api.z.ai/api/paas/v4",
            transport: ModelTransport::OpenaiCompatible,
        },
        ModelConnectionPreset::Custom => ConnectionPresetConfig {
            label: "Custom endpoint",
            base_url: "http://127.0.0.1:11434/v1",
            transport: ModelTransport::OpenaiCompatible,
        },
    }
}

fn connection_preset_id(preset: ModelConnectionPreset) -> &'static str {
    match preset {
        ModelConnectionPreset::Openai => "openai",
        ModelConnectionPreset::Anthropic => "anthropic",
        ModelConnectionPreset::Openrouter => "openrouter",
        ModelConnectionPreset::Kimi => "kimi",
        ModelConnectionPreset::Zai => "zai",
        ModelConnectionPreset::Custom => "custom",
    }
}

fn validate_model_endpoint(value: &str) -> Result<(), String> {
    let url = url::Url::parse(value).map_err(|_| "Base URL must be a valid URL.".to_owned())?;
    match url.scheme() {
        "https" => Ok(()),
        "http" if url.host_str() == Some("127.0.0.1") => Ok(()),
        _ => Err("Use HTTPS, or loopback HTTP on 127.0.0.1 for a local server.".into()),
    }
}

fn validate_mcp_transport(transport: &McpTransport) -> Result<(), String> {
    match transport {
        McpTransport::Stdio {
            command,
            cwd,
            environment,
            ..
        } => {
            if command.trim().is_empty() {
                return Err("A stdio MCP transport needs a command.".into());
            }
            if cwd.as_ref().is_some_and(|cwd| cwd.trim().is_empty()) {
                return Err("The MCP working directory cannot be empty.".into());
            }
            validate_mcp_values(environment.as_ref(), "environment variable")
        }
        McpTransport::Http { url, headers } => {
            let parsed = url::Url::parse(url)
                .map_err(|_| "The MCP HTTP transport needs a valid URL.".to_owned())?;
            if !matches!(parsed.scheme(), "http" | "https") || parsed.host().is_none() {
                return Err("The MCP transport URL must use HTTP or HTTPS.".into());
            }
            validate_mcp_values(headers.as_ref(), "header")
        }
    }
}

fn validate_mcp_values(
    values: Option<&std::collections::BTreeMap<String, McpConfigValue>>,
    label: &str,
) -> Result<(), String> {
    for (name, value) in values.into_iter().flatten() {
        if name.trim().is_empty() {
            return Err(format!("An MCP {label} name cannot be empty."));
        }
        if let McpConfigValue::Credential { credential_ref } = value
            && credential_ref.trim().is_empty()
        {
            return Err(format!(
                "The credentialRef for MCP {label} {name} is empty."
            ));
        }
    }
    Ok(())
}

fn status_pill(label: &'static str, _ready: bool, theme: Theme) -> AnyElement {
    settings_status(label, false, theme)
}

fn provider_actions(
    id: SharedString,
    issue: Option<(String, Option<String>)>,
    status: Option<AnyElement>,
    mark: ProviderMark,
    action: AnyElement,
    theme: Theme,
) -> AnyElement {
    let icon_id: SharedString = format!("{id}:mark").into();
    div()
        .flex()
        .items_center()
        .gap(px(10.0))
        .when_some(issue, |actions, (message, tip)| {
            actions.child(row_issue(format!("{id}:issue"), message, tip, theme))
        })
        .when_some(status, |actions, status| actions.child(status))
        .child(
            motion_icon(
                icon_id,
                provider_mark_path(mark),
                17.0,
                "provider-mark-icon-direct-hover",
                theme,
            )
            .text_color(theme.text_2.hsla()),
        )
        .child(action)
        .into_any_element()
}

fn settings_status(label: impl Into<SharedString>, warning: bool, theme: Theme) -> AnyElement {
    div()
        .max_w(px(250.0))
        .truncate()
        .text_size(px(12.5))
        .text_color(if warning {
            theme.error.hsla()
        } else {
            theme.text_3.hsla()
        })
        .child(label.into())
        .into_any_element()
}

fn account_status(
    account: Option<&harness_protocol::Account>,
    signed_in: bool,
    theme: Theme,
) -> AnyElement {
    if !signed_in {
        return settings_status("Not signed in", false, theme);
    }
    let Some(account) = account else {
        return settings_status("Signed in", false, theme);
    };
    if account.email.is_none() && account.plan.is_none() {
        return settings_status("Signed in", false, theme);
    }
    div()
        .flex()
        .items_center()
        .min_w(px(0.0))
        .text_size(px(12.5))
        .text_color(theme.text_3.hsla())
        .when_some(account.email.clone(), |status, email| {
            status.child(account_email(email, theme))
        })
        .when(
            account.email.is_some() && account.plan.is_some(),
            |status| status.child(" · "),
        )
        .when_some(account.plan.clone(), |status, plan| status.child(plan))
        .into_any_element()
}

fn account_email(email: String, theme: Theme) -> AnyElement {
    let group: SharedString = format!("account-email:{email}").into();
    let masked = mask_email(&email);
    div()
        .grid()
        .grid_cols(1)
        .grid_rows(1)
        .group(group.clone())
        .child(
            div()
                .col_start(1)
                .row_start(1)
                .opacity(1.0)
                .group_hover(group.clone(), |label| label.opacity(0.0))
                .child(masked),
        )
        .child(
            div()
                .col_start(1)
                .row_start(1)
                .opacity(0.0)
                .text_color(theme.text_2.hsla())
                .group_hover(group, |label| label.opacity(1.0))
                .child(email),
        )
        .into_any_element()
}

fn mask_email(email: &str) -> String {
    let Some(at) = email.find('@') else {
        return email.into();
    };
    if at <= 1 {
        return email.into();
    }
    let first = email.chars().next().unwrap_or_default();
    format!("{first}…{}", &email[at..])
}

fn row_issue(
    id: impl Into<SharedString>,
    message: String,
    tip: Option<String>,
    theme: Theme,
) -> AnyElement {
    RowIssue {
        id: id.into(),
        message,
        tip,
        theme,
    }
    .into_any_element()
}

#[derive(IntoElement)]
struct RowIssue {
    id: SharedString,
    message: String,
    tip: Option<String>,
    theme: Theme,
}

impl RenderOnce for RowIssue {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let initial_id = self.id.clone();
        let initial_message = self.message.clone();
        let initial_tip = self.tip.clone();
        let initial_theme = self.theme;
        let state = window.use_keyed_state(self.id, cx, move |window, cx| {
            RowIssueState::new(
                initial_id,
                initial_message,
                initial_tip,
                initial_theme,
                window,
                cx,
            )
        });
        state.update(cx, |state, cx| {
            state.update_content(self.message, self.tip, self.theme, cx);
        });
        state
    }
}

#[derive(Clone, Copy, Debug)]
struct RowIssueMotion {
    from: f32,
    target: f32,
    started: Instant,
    duration: Duration,
    generation: u64,
}

impl RowIssueMotion {
    fn hidden(now: Instant) -> Self {
        Self {
            from: 0.0,
            target: 0.0,
            started: now,
            duration: Duration::ZERO,
            generation: 0,
        }
    }

    fn sample(self, now: Instant) -> (f32, bool) {
        if self.duration.is_zero() {
            return (self.target, false);
        }
        let elapsed = now.saturating_duration_since(self.started).as_secs_f32();
        let progress = elapsed / self.duration.as_secs_f32();
        if progress >= 1.0 {
            return (self.target, false);
        }
        let eased = crate::theme::web_ease_out(progress.clamp(0.0, 1.0));
        (self.from + (self.target - self.from) * eased, true)
    }

    fn retarget(&mut self, visible: bool, duration: Duration, now: Instant) -> bool {
        let target = f32::from(visible);
        if (self.target - target).abs() < f32::EPSILON {
            return false;
        }
        let (current, _) = self.sample(now);
        self.from = current;
        self.target = target;
        self.started = now;
        self.duration = duration.mul_f32((target - current).abs());
        self.generation = self.generation.wrapping_add(1);
        true
    }
}

struct RowIssueState {
    id: SharedString,
    message: String,
    tip: Option<String>,
    theme: Theme,
    focus: FocusHandle,
    hovered: bool,
    focused: bool,
    motion: RowIssueMotion,
}

impl RowIssueState {
    fn new(
        id: SharedString,
        message: String,
        tip: Option<String>,
        theme: Theme,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let focus = cx.focus_handle();
        cx.on_focus(&focus, window, |this, _window, cx| {
            this.focused = true;
            this.sync_visibility(cx);
        })
        .detach();
        cx.on_blur(&focus, window, |this, _window, cx| {
            this.focused = false;
            this.sync_visibility(cx);
        })
        .detach();
        Self {
            id,
            message,
            tip,
            theme,
            focus,
            hovered: false,
            focused: false,
            motion: RowIssueMotion::hidden(Instant::now()),
        }
    }

    fn update_content(
        &mut self,
        message: String,
        tip: Option<String>,
        theme: Theme,
        cx: &mut Context<Self>,
    ) {
        if self.message != message || self.tip != tip || self.theme != theme {
            self.message = message;
            self.tip = tip;
            self.theme = theme;
            cx.notify();
        }
    }

    fn hover_changed(&mut self, hovered: bool, cx: &mut Context<Self>) {
        if self.hovered != hovered {
            self.hovered = hovered;
            self.sync_visibility(cx);
        }
    }

    fn sync_visibility(&mut self, cx: &mut Context<Self>) {
        if self.motion.retarget(
            self.hovered || self.focused,
            self.theme.motion.fast,
            Instant::now(),
        ) {
            cx.notify();
        }
    }
}

impl Focusable for RowIssueState {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for RowIssueState {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let (progress, animating) = self.motion.sample(Instant::now());
        let from = self.motion.from;
        let target = self.motion.target;
        let duration = self.motion.duration;
        let generation = self.motion.generation;
        let hover_group: SharedString = format!("{}:hover", self.id).into();
        let icon_id: ElementId = SharedString::from(format!("{}:icon", self.id)).into();
        let bubble = div()
            .id("bubble")
            .absolute()
            .right_0()
            .bottom(px(30.0 - (2.0 * (1.0 - progress))))
            .max_w(px(300.0))
            .px(px(10.0))
            .py(px(8.0))
            .rounded(px(5.0))
            .border_1()
            .border_color(chrome::menu_border(theme))
            .bg(chrome::menu_background(theme))
            .shadow(chrome::flyout_shadows(theme))
            .text_size(px(12.5))
            .line_height(relative(1.45))
            .font_weight(FontWeight(400.0))
            .text_color(theme.text.hsla())
            .opacity(progress)
            .child(self.message.clone())
            .when_some(self.tip.clone(), |content, tip| {
                content.child(div().mt(px(4.0)).text_color(theme.text_3.hsla()).child(tip))
            })
            .when(animating || target > 0.0, |bubble| {
                bubble.on_hover(cx.listener(|this, hovered, _window, cx| {
                    this.hover_changed(*hovered, cx);
                }))
            });
        let bubble = if animating {
            bubble
                .with_animation(
                    ("row-issue-bubble", generation),
                    Animation::new(duration).with_easing(crate::theme::web_ease_out),
                    move |bubble, delta| {
                        let progress = from + (target - from) * delta;
                        bubble
                            .bottom(px(30.0 - (2.0 * (1.0 - progress))))
                            .opacity(progress)
                    },
                )
                .into_any_element()
        } else {
            bubble.into_any_element()
        };

        div()
            .id("trigger")
            .group(hover_group.clone())
            .relative()
            .size(px(22.0))
            .flex()
            .items_center()
            .justify_center()
            .rounded_full()
            .bg(theme.error.hsla().opacity(0.14))
            .text_color(theme.error.hsla())
            .track_focus(&self.focus)
            .tab_index(0)
            .on_hover(cx.listener(|this, hovered, _window, cx| {
                this.hover_changed(*hovered, cx);
            }))
            .when(self.focus.is_focused(window), |trigger| {
                trigger.child(
                    div()
                        .absolute()
                        .inset(px(-3.0))
                        .rounded_full()
                        .border_2()
                        .border_color(theme.text_2.hsla()),
                )
            })
            .child(motion_icon(
                icon_id,
                "icons/circle-alert.svg",
                14.0,
                hover_group,
                theme,
            ))
            .child(deferred(bubble).with_priority(90))
    }
}

fn theme_card(
    index: usize,
    label: &'static str,
    preference: ThemePreference,
    selected: bool,
    theme: Theme,
    action: SettingsAction,
) -> AnyElement {
    let group: SharedString = format!("theme-card:{index}").into();
    let mut preview = div()
        .id(("theme-preview", index))
        .relative()
        .w_full()
        .overflow_hidden()
        .rounded(px(8.0))
        .when(selected, |preview| preview.border_2())
        .when(!selected, |preview| preview.border_1())
        .border_color(if selected {
            theme.text.hsla()
        } else {
            theme.text.hsla().opacity(0.16)
        })
        .when(!selected, |preview| {
            preview.group_hover(group.clone(), move |style| {
                style.border_color(theme.text.hsla().opacity(0.32))
            })
        })
        .group_active(group.clone(), |style| {
            style
                .w(relative(THEME_PREVIEW_PRESS_SCALE))
                .mx(relative(0.0075))
                .my(relative(THEME_PREVIEW_PRESS_MARGIN_Y))
                .rounded(px(7.88))
        })
        .bg(theme_preview_background(
            preference,
            ThemePreviewPart::Background,
        ))
        .child(
            div()
                .w(relative(0.44))
                .h(px(6.0))
                .mx_auto()
                .mt(relative(0.16))
                .mb(relative(0.06))
                .rounded_full()
                .bg(theme_preview_background(preference, ThemePreviewPart::Line)),
        )
        .child(
            div()
                .w(relative(0.68))
                .h(px(4.0))
                .mx_auto()
                .rounded_full()
                .bg(theme_preview_background(preference, ThemePreviewPart::Copy)),
        )
        .child(
            div()
                .absolute()
                .left(relative(0.09))
                .right(relative(0.09))
                .bottom(relative(-0.08))
                .h(relative(0.64))
                .overflow_hidden()
                .rounded_t(px(12.0))
                .bg(theme_preview_background(
                    preference,
                    ThemePreviewPart::Panel,
                ))
                .children((0..2).map(|row| {
                    div()
                        .relative()
                        .h(relative(0.5))
                        .px(relative(0.08))
                        .py(relative(0.10))
                        .when(row > 0, |row| {
                            row.border_t_1().border_color(theme_preview_color(
                                preference,
                                ThemePreviewPart::Divider,
                            ))
                        })
                        .child(
                            div()
                                .w(relative(0.42))
                                .h(px(6.0))
                                .rounded_full()
                                .bg(theme_preview_background(preference, ThemePreviewPart::Line)),
                        )
                        .child(
                            div()
                                .w(relative(0.66))
                                .h(px(3.0))
                                .mt(relative(0.08))
                                .rounded_full()
                                .bg(theme_preview_background(preference, ThemePreviewPart::Copy)),
                        )
                })),
        );
    preview.style().aspect_ratio = Some(THEME_PREVIEW_ASPECT_RATIO);
    div()
        .id(("theme-card", index))
        .group(group)
        .min_w(px(0.0))
        .flex_1()
        .cursor_pointer()
        .on_click(move |_event, _window, cx| action(cx))
        .child(preview)
        .child(
            div()
                .mt(px(8.0))
                .truncate()
                .text_center()
                .text_size(px(13.5))
                .text_color(if selected {
                    theme.text.hsla()
                } else {
                    theme.text_3.hsla()
                })
                .child(label),
        )
        .into_any_element()
}

#[derive(Clone, Copy)]
enum ThemePreviewPart {
    Background,
    Panel,
    Line,
    Copy,
    Divider,
}

fn theme_preview_background(
    preference: ThemePreference,
    part: ThemePreviewPart,
) -> gpui::Background {
    if preference == ThemePreference::System {
        let (light, dark) = theme_preview_pair(part);
        // GPUI currently supports two gradient stops. Keeping those stops on
        // opposite sides of the midpoint produces the browser's hard 50/50
        // system-theme split without a visible interpolation band.
        return linear_gradient(
            90.0,
            linear_color_stop(gpui::rgb(light), 0.5 - THEME_SYSTEM_SPLIT_OFFSET),
            linear_color_stop(gpui::rgb(dark), 0.5 + THEME_SYSTEM_SPLIT_OFFSET),
        );
    }
    if preference == ThemePreference::Light && matches!(part, ThemePreviewPart::Panel) {
        return linear_gradient(
            180.0,
            linear_color_stop(gpui::white(), 0.0),
            linear_color_stop(gpui::rgb(0xfafafa), 1.0),
        );
    }
    theme_preview_color(preference, part).into()
}

fn theme_preview_color(preference: ThemePreference, part: ThemePreviewPart) -> gpui::Hsla {
    let (light, dark) = theme_preview_pair(part);
    match preference {
        ThemePreference::Light | ThemePreference::System => gpui::rgb(light).into(),
        ThemePreference::Dark => gpui::rgb(dark).into(),
    }
}

fn theme_preview_pair(part: ThemePreviewPart) -> (u32, u32) {
    match part {
        ThemePreviewPart::Background => (0xfdfdfd, 0x3a3a3c),
        ThemePreviewPart::Panel => (0xffffff, 0x171717),
        ThemePreviewPart::Line => (0xdcdce0, 0x777779),
        ThemePreviewPart::Copy => (0xeeeeef, 0x4e4e50),
        ThemePreviewPart::Divider => (0xebebed, 0x29292b),
    }
}

#[allow(clippy::too_many_arguments)]
fn appearance_choice(
    id: usize,
    label: &'static str,
    preview_font: &'static str,
    swatch: Option<(u32, u32)>,
    selected: bool,
    theme: Theme,
    action: SettingsAction,
) -> AnyElement {
    let group: SharedString = format!("appearance-choice:{id}").into();
    let preview = match swatch {
        Some((from, to)) => div()
            .id(("appearance-choice-preview", id))
            .relative()
            .size(px(34.0))
            .flex_none()
            .overflow_hidden()
            .rounded(px(5.0))
            .border_1()
            .border_color(theme.line_strong.hsla())
            .bg(linear_gradient(
                135.0,
                linear_color_stop(gpui::rgb(from), 0.0),
                linear_color_stop(gpui::rgb(to), 1.0),
            ))
            .group_active(group.clone(), |style| {
                style.size(px(33.49)).rounded(px(4.925))
            })
            .child(
                div()
                    .absolute()
                    .top_0()
                    .left_0()
                    .right_0()
                    .h(px(1.0))
                    .bg(gpui::white().opacity(0.16)),
            )
            .into_any_element(),
        None => div()
            .id(("appearance-choice-preview", id))
            .size(px(34.0))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(5.0))
            .border_1()
            .border_color(theme.line.hsla())
            .bg(chrome::rail_background(theme))
            .font_family(preview_font)
            .text_size(px(15.0))
            .text_color(theme.text.hsla())
            .group_active(group, |style| {
                style
                    .size(px(33.49))
                    .rounded(px(4.925))
                    .text_size(px(14.775))
            })
            .child("Ag")
            .into_any_element(),
    };
    appearance_choice_shell(id, label, preview, selected, theme, action)
}

fn glass_choice(
    id: usize,
    label: &'static str,
    glass: u8,
    selected: bool,
    theme: Theme,
    action: SettingsAction,
) -> AnyElement {
    let group: SharedString = format!("appearance-choice:{id}").into();
    let effort: gpui::Hsla = match theme.mode {
        ThemeMode::Dark => gpui::rgb(0xef706e).into(),
        ThemeMode::Light => gpui::rgb(0xc2413d).into(),
    };
    let pane_opacity = match glass {
        0 => 1.0,
        20 => 0.80,
        35 => 0.62,
        50 => 0.45,
        _ => (1.0 - f32::from(glass) / 100.0).clamp(0.0, 1.0),
    };
    let preview = div()
        .id(("appearance-choice-preview", id))
        .relative()
        .size(px(34.0))
        .flex_none()
        .overflow_hidden()
        .rounded(px(crate::RADIUS_MD))
        .border_1()
        .border_color(theme.line_strong.hsla())
        .bg(linear_gradient(
            135.0,
            linear_color_stop(theme.attention.hsla().opacity(0.55), 0.0),
            linear_color_stop(effort.opacity(0.40), 1.0),
        ))
        .group_active(group, |style| {
            style.size(px(33.49)).rounded(px(crate::RADIUS_MD * 0.985))
        })
        .child(
            div()
                .absolute()
                .inset_0()
                .bg(chrome::rail_background_with_opacity(theme, pane_opacity)),
        )
        .child(
            div()
                .absolute()
                .top_0()
                .left_0()
                .right_0()
                .h(px(1.0))
                .bg(gpui::white().opacity(0.16)),
        )
        .into_any_element();
    appearance_choice_shell(id, label, preview, selected, theme, action)
}

fn appearance_choice_shell(
    id: usize,
    label: &'static str,
    preview: AnyElement,
    selected: bool,
    theme: Theme,
    action: SettingsAction,
) -> AnyElement {
    let group: SharedString = format!("appearance-choice:{id}").into();
    let background = if selected {
        chrome::recessed(theme).into()
    } else if theme.mode == ThemeMode::Light {
        chrome::raised(theme)
    } else {
        theme.surface.hsla().into()
    };
    let shadows = if !selected && theme.mode == ThemeMode::Light {
        chrome::shadows(theme)
    } else {
        Vec::new()
    };
    div()
        .id(("appearance-choice", id))
        .group(group)
        .relative()
        .w_full()
        .min_w(px(0.0))
        .min_h(px(54.0))
        .flex()
        .items_center()
        .gap(px(10.0))
        .px(px(10.0))
        .py(px(8.0))
        .rounded(px(8.0))
        .border_1()
        .border_color(if selected {
            theme.text_2.hsla()
        } else if theme.mode == ThemeMode::Light {
            chrome::border(theme)
        } else {
            theme.line.hsla()
        })
        .bg(background)
        .shadow(shadows)
        .when(selected, |choice| {
            choice.child(chrome::inset_top_shade(theme))
        })
        .text_size(px(12.5))
        .text_color(if selected {
            theme.text.hsla()
        } else {
            theme.text_2.hsla()
        })
        .cursor_pointer()
        .hover(move |style| {
            if selected {
                style
                    .bg(chrome::recessed(theme))
                    .border_color(theme.text_2.hsla())
            } else if theme.mode == ThemeMode::Light {
                style
                    .bg(chrome::raised_hover(theme))
                    .border_color(theme.line_strong.hsla())
            } else {
                style
                    .bg(theme.surface_2.hsla())
                    .border_color(theme.line_strong.hsla())
            }
        })
        .active(|style| {
            style
                .w(relative(0.985))
                .h(px(53.19))
                .min_h(px(53.19))
                .mx(relative(0.0075))
                .my(px(0.405))
                .gap(px(9.85))
                .px(px(9.85))
                .py(px(7.88))
                .rounded(px(7.88))
                .text_size(px(12.3125))
        })
        .on_click(move |_event, _window, cx| action(cx))
        .child(preview)
        .child(label)
        .into_any_element()
}

fn mcp_status(server: &McpServer) -> (&'static str, bool) {
    if !server.enabled {
        return ("Disabled", false);
    }
    if matches!(server.auth, McpAuth::SignInRequired { .. }) {
        return ("Sign-in required", false);
    }
    match server.startup {
        McpStartupStatus::Ready => ("Ready", true),
        McpStartupStatus::Starting => ("Starting", false),
        McpStartupStatus::Stopped => ("Stopped", false),
        McpStartupStatus::Failed { .. } => ("Failed", false),
    }
}

fn provider_label(provider: ProviderId) -> &'static str {
    match provider {
        ProviderId::Codex => "Codex",
        ProviderId::ClaudeCode => "Claude Code",
        ProviderId::Grok => "Grok",
        ProviderId::Cursor => "Cursor",
        ProviderId::OpenCode => "OpenCode",
        ProviderId::Antigravity => "Antigravity",
        ProviderId::Acp => "ACP",
        ProviderId::Api => "Direct API",
    }
}

fn short_commit(commit: &str) -> String {
    commit.chars().take(7).collect()
}

fn update_check_note(result: Option<&UpdateCheckResult>) -> Option<String> {
    let result = result?;
    if result.error.is_some() {
        return None;
    }
    if result.up_to_date == Some(true) {
        let remote = result
            .remote
            .as_ref()
            .map_or_else(String::new, |remote| short_commit(&remote.sha));
        return Some(format!("Up to date · {remote}"));
    }
    if let Some(remote) = &result.remote {
        return Some(format!(
            "Newer: {} — pull and restart",
            short_commit(&remote.sha)
        ));
    }
    Some("No verdict".into())
}

fn parked_provider_surfaces_visible() -> bool {
    // Keep the ACP and direct-API implementations compiled while the public beta
    // matches the web surface: Codex, Claude Code and Grok only.
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_transport_resize_keeps_the_browser_minimum_height() {
        assert_eq!(resized_mcp_transport_height(130.0, 42.0), 172.0);
        assert_eq!(resized_mcp_transport_height(190.0, -30.0), 160.0);
        assert_eq!(resized_mcp_transport_height(190.0, -90.0), 130.0);
    }

    #[test]
    fn model_endpoints_require_https_or_literal_loopback_http() {
        assert!(validate_model_endpoint("https://api.example.com/v1").is_ok());
        assert!(validate_model_endpoint("http://127.0.0.1:11434/v1").is_ok());
        assert!(validate_model_endpoint("http://localhost:11434/v1").is_err());
        assert!(validate_model_endpoint("http://api.example.com/v1").is_err());
    }

    #[test]
    fn connection_presets_keep_the_web_transport_contract() {
        assert_eq!(
            connection_preset(ModelConnectionPreset::Openai).transport,
            ModelTransport::OpenaiResponses
        );
        assert_eq!(
            connection_preset(ModelConnectionPreset::Anthropic).transport,
            ModelTransport::AnthropicMessages
        );
        assert_eq!(
            connection_preset(ModelConnectionPreset::Custom).base_url,
            "http://127.0.0.1:11434/v1"
        );
    }

    #[test]
    fn public_beta_keeps_parked_provider_surfaces_hidden() {
        assert!(!parked_provider_surfaces_visible());
    }

    #[test]
    fn appearance_geometry_matches_the_web_surface() {
        assert_eq!(APPEARANCE_SECTION_GAP, 34.0);
        assert_eq!(THEME_PREVIEW_ASPECT_RATIO, 1.45);
        assert_eq!(THEME_PREVIEW_PRESS_SCALE, 0.985);
        assert_eq!(THEME_SYSTEM_SPLIT_OFFSET, 0.0001);

        let pressed_height = THEME_PREVIEW_PRESS_SCALE / THEME_PREVIEW_ASPECT_RATIO
            + 2.0 * THEME_PREVIEW_PRESS_MARGIN_Y;
        assert!((pressed_height - 1.0 / THEME_PREVIEW_ASPECT_RATIO).abs() < f32::EPSILON);
    }

    #[test]
    fn settings_switch_motion_animates_changes_without_animating_mounts() {
        let mut states = HashMap::new();
        let start = Instant::now();
        let duration = Duration::from_millis(180);

        assert!(settings_switch_animation(&mut states, 7, false, duration, start).is_none());
        assert!(
            settings_switch_animation(
                &mut states,
                7,
                false,
                duration,
                start + Duration::from_millis(20),
            )
            .is_none()
        );

        let change = settings_switch_animation(
            &mut states,
            7,
            true,
            duration,
            start + Duration::from_millis(40),
        )
        .expect("a value change should animate");
        assert_eq!(change.from, 0.0);
        assert_eq!(change.to, 1.0);
        assert_eq!(change.duration, duration);

        assert!(
            settings_switch_animation(
                &mut states,
                7,
                true,
                duration,
                start + Duration::from_millis(221),
            )
            .is_none()
        );
    }

    #[test]
    fn row_issue_motion_mounts_hidden_and_reverses_from_its_current_opacity() {
        let start = Instant::now();
        let duration = Duration::from_millis(180);
        let mut motion = RowIssueMotion::hidden(start);

        assert_eq!(motion.sample(start), (0.0, false));
        assert!(motion.retarget(true, duration, start));
        let halfway = start + Duration::from_millis(90);
        let (visible_progress, animating) = motion.sample(halfway);
        assert!(animating);
        assert!((0.0..1.0).contains(&visible_progress));

        assert!(motion.retarget(false, duration, halfway));
        assert!((motion.from - visible_progress).abs() < 0.001);
        assert_eq!(motion.target, 0.0);
        assert!(motion.duration < duration);
        assert_eq!(
            motion.sample(halfway + motion.duration + Duration::from_millis(1)),
            (0.0, false)
        );
    }

    #[test]
    fn mcp_transport_validation_matches_the_wire_contract() {
        assert!(
            validate_mcp_transport(&McpTransport::Http {
                url: "https://example.com/mcp".into(),
                headers: None,
            })
            .is_ok()
        );
        assert!(
            validate_mcp_transport(&McpTransport::Http {
                url: "file:///tmp/mcp".into(),
                headers: None,
            })
            .is_err()
        );
        assert!(
            validate_mcp_transport(&McpTransport::Stdio {
                command: " ".into(),
                args: None,
                cwd: None,
                environment: None,
            })
            .is_err()
        );
    }

    #[test]
    fn mcp_credential_references_cannot_be_empty() {
        let headers = std::collections::BTreeMap::from([(
            "Authorization".into(),
            McpConfigValue::Credential {
                credential_ref: "".into(),
            },
        )]);
        assert!(
            validate_mcp_transport(&McpTransport::Http {
                url: "https://example.com/mcp".into(),
                headers: Some(headers),
            })
            .is_err()
        );
    }

    #[test]
    fn about_update_copy_matches_the_web_surface() {
        assert_eq!(update_check_note(None), None);
        assert_eq!(
            update_check_note(Some(&UpdateCheckResult {
                local_commit: Some("111111111".into()),
                remote: Some(harness_protocol::UpdateRemote {
                    sha: "222222222".into(),
                    message: "Latest change".into(),
                    date: "2026-08-06T12:00:00Z".into(),
                }),
                up_to_date: Some(false),
                error: None,
            })),
            Some("Newer: 2222222 — pull and restart".into())
        );
    }
}
