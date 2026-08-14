mod command_palette;
mod image_viewer;
mod provider_terminal;
mod session_search;
mod settings;
mod sidebar_controls;
mod stage_controls;
mod zoom_hud;

use crate::assets::{HarnessAssets, register_fonts};
use crate::chat::{ChatEvent, ChatView, ComposerSettings, DESIGN_BRIEF_ATTACHMENT, SessionContext};
use crate::client_state::{
    AuthTarget, ChatUpdate, ClientState, ClientUpdate, NewThreadRequest, ReviewHunkRequest,
    SendTurnRequest, ShellEvent,
};
use crate::model_selection::{
    fast_mode_off_value, fast_service_tier, is_fast_mode_enabled, next_service_tier, source_key,
};
use crate::motion_icon::motion_icon;
use crate::preferences::{FontPreference, NativePreferences, SourceSelection, ThemePreference};
use crate::preview_capture::PreviewCaptureRuntime;
use crate::sidebar::{
    SelectionModifiers, SessionDropPosition, SidebarActions, SidebarMenuAnchor, SidebarMenuRequest,
    SidebarProps, ordered_inbox_ids, sidebar, sidebar_bloom,
};
use crate::theme::{
    BASE_LINE_HEIGHT, RAIL_FOLD_DURATION, RAIL_REVEAL_DURATION, TITLEBAR_HEIGHT, Theme, ThemeMode,
    web_ease_rail,
};
use crate::zoom::{self, px};
use anyhow::Result;
use command_palette::{CommandPaletteState, CommandScope};
use gpui::{
    Animation, AnimationExt, AnyElement, App, Application, Bounds, BoxShadow, Context, CursorStyle,
    Entity, FocusHandle, Focusable, KeyDownEvent, MouseButton, MouseDownEvent, MouseMoveEvent,
    MouseUpEvent, PathPromptOptions, Pixels, Render, SharedString, TitlebarOptions, Window,
    WindowAppearance, WindowBackgroundAppearance, WindowBounds, WindowHandle, WindowOptions, div,
    point, prelude::*, relative, rgba, size,
};
#[cfg(target_os = "macos")]
use gpui::{KeyBinding, Menu, MenuItem};
use gpui_component::Root;
use gpui_component::input::{InputEvent, InputState};
use harness_client::{ConnectionState, Endpoint};
use harness_protocol::{
    ApprovalMode, Model, ModelConnectionPreset, ProviderId, SessionSummary, SidebarMode,
    ThreadInboxStatus,
};
use provider_terminal::{ProviderTerminalKey, ProviderTerminalView};
use session_search::SessionSearchState;
use sidebar_controls::SidebarControlsState;
use stage_controls::StageControlsState;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[cfg(target_os = "macos")]
gpui::actions!(native_shell, [QuitApp]);

const APP_WIDTH: f32 = 1180.0;
const APP_HEIGHT: f32 = 820.0;
const APP_BACKGROUND_APPEARANCE: WindowBackgroundAppearance = WindowBackgroundAppearance::Blurred;
const MIN_RAIL_PREVIEW_WIDTH: f32 = 240.0;
const COLLAPSE_RAIL_WIDTH: f32 = MIN_RAIL_PREVIEW_WIDTH * 0.5;
const MAX_RAIL_WIDTH: f32 = 420.0;
const RAIL_REVEAL_KEEP_BUFFER: f32 = 96.0;
const RAIL_REVEAL_GRACE: Duration = Duration::from_millis(120);
const RAIL_REVEAL_COOLDOWN: Duration = Duration::from_millis(1_250);
const RAIL_REVEAL_EDGE_WIDTH: f32 = 6.0;
const MCP_TRANSPORT_MIN_HEIGHT: f32 = 130.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShellCommand {
    Show,
    Quit,
}

#[derive(Clone, Copy)]
enum SidebarTransitionKind {
    Collapse,
    Expand,
    DragFold,
    DragUnfold,
}

#[derive(Clone, Copy)]
struct SidebarResizeDrag {
    start_x: Pixels,
    start_width: f32,
    folded: bool,
    revealed: bool,
    settling: bool,
}

struct SidebarRevealState {
    visible: bool,
    retracting: bool,
    collapsing: bool,
    generation: u64,
    hide_generation: u64,
    hide_pending: bool,
    cooldown_generation: u64,
    cooling: bool,
    fold_generation: u64,
    pointer_x: f32,
}

impl Default for SidebarRevealState {
    fn default() -> Self {
        Self {
            visible: false,
            retracting: false,
            collapsing: false,
            generation: 0,
            hide_generation: 0,
            hide_pending: false,
            cooldown_generation: 0,
            cooling: false,
            fold_generation: 0,
            pointer_x: f32::INFINITY,
        }
    }
}

#[derive(Clone, Copy)]
struct McpTransportResizeDrag {
    start_y: Pixels,
    start_height: f32,
}

pub fn run() -> Result<()> {
    let (shell_sender, shell_receiver) = async_channel::unbounded();
    run_with_endpoint_and_shell(Endpoint::from_environment()?, shell_sender, shell_receiver)
}

pub fn run_with_endpoint(endpoint: Endpoint) -> Result<()> {
    let (shell_sender, shell_receiver) = async_channel::unbounded();
    run_with_endpoint_and_shell(endpoint, shell_sender, shell_receiver)
}

pub fn run_with_shell(
    shell_sender: async_channel::Sender<ShellCommand>,
    shell_receiver: async_channel::Receiver<ShellCommand>,
) -> Result<()> {
    run_with_endpoint_and_shell(Endpoint::from_environment()?, shell_sender, shell_receiver)
}

pub fn run_with_endpoint_and_shell(
    endpoint: Endpoint,
    shell_sender: async_channel::Sender<ShellCommand>,
    shell_receiver: async_channel::Receiver<ShellCommand>,
) -> Result<()> {
    let main_window = Rc::new(RefCell::new(None::<WindowHandle<Root>>));
    let reopen_window = Rc::clone(&main_window);
    let application = Application::new().with_assets(HarnessAssets);
    application.on_reopen(move |cx| {
        if let Some(window) = *reopen_window.borrow() {
            show_main_window(window, cx);
        }
    });

    application.run(move |cx: &mut App| {
        zoom::set_factor(1.0);
        gpui_component::init(cx);
        register_fonts(cx).expect("failed to register bundled Geist fonts");

        #[cfg(target_os = "macos")]
        {
            cx.bind_keys([KeyBinding::new("cmd-q", QuitApp, None)]);
            cx.on_action(|_: &QuitApp, cx| cx.quit());
            cx.set_menus(vec![Menu {
                name: "TasteCode".into(),
                items: vec![MenuItem::action("Quit TasteCode", QuitApp)],
            }]);
        }

        let bounds = Bounds::centered(None, size(px(APP_WIDTH), px(APP_HEIGHT)), cx);
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            window_min_size: Some(size(px(720.0), px(520.0))),
            titlebar: Some(TitlebarOptions {
                title: Some("TasteCode".into()),
                appears_transparent: true,
                traffic_light_position: Some(point(px(12.0), px(11.0))),
            }),
            window_background: APP_BACKGROUND_APPEARANCE,
            ..Default::default()
        };

        let window_handle = cx
            .open_window(options, move |window, cx| {
                window.set_window_title("TasteCode");
                #[cfg(any(target_os = "macos", target_os = "windows"))]
                window.on_window_should_close(cx, |window, cx| {
                    hide_main_window(window, cx);
                    false
                });
                let app = cx.new(|cx| HarnessApp::new(endpoint, window, cx));
                cx.new(|cx| Root::new(app, window, cx))
            })
            .expect("failed to open the TasteCode window");
        *main_window.borrow_mut() = Some(window_handle);

        #[cfg(target_os = "windows")]
        install_windows_tray(shell_sender.clone(), cx)
            .expect("failed to create the TasteCode background tray");
        #[cfg(not(target_os = "windows"))]
        drop(shell_sender);

        cx.spawn(async move |cx| {
            while let Ok(command) = shell_receiver.recv().await {
                let should_quit = command == ShellCommand::Quit;
                let result = cx.update(|cx| match command {
                    ShellCommand::Show => show_main_window(window_handle, cx),
                    ShellCommand::Quit => cx.quit(),
                });
                if result.is_err() || should_quit {
                    break;
                }
            }
        })
        .detach();

        cx.activate(true);
    });
    Ok(())
}

fn show_main_window(window_handle: WindowHandle<Root>, cx: &mut App) {
    cx.activate(true);
    let _ = window_handle.update(cx, |_root, window, _cx| {
        #[cfg(target_os = "macos")]
        set_macos_window_visible(window, true);
        #[cfg(target_os = "windows")]
        set_windows_window_visible(window, true);
        window.activate_window();
    });
}

#[cfg(target_os = "macos")]
fn hide_main_window(window: &Window, _cx: &mut App) {
    set_macos_window_visible(window, false);
}

#[cfg(target_os = "macos")]
fn set_macos_window_visible(window: &Window, visible: bool) {
    use objc2_app_kit::NSView;
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    let Ok(handle) = HasWindowHandle::window_handle(window) else {
        return;
    };
    let RawWindowHandle::AppKit(handle) = handle.as_raw() else {
        return;
    };
    let view = unsafe { &*handle.ns_view.as_ptr().cast::<NSView>() };
    let Some(window) = view.window() else {
        return;
    };
    if visible {
        window.makeKeyAndOrderFront(None);
    } else {
        window.orderOut(None);
    }
}

#[cfg(target_os = "windows")]
fn hide_main_window(window: &Window, _cx: &mut App) {
    set_windows_window_visible(window, false);
}

#[cfg(target_os = "windows")]
fn set_windows_window_visible(window: &Window, visible: bool) {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SW_HIDE, SW_RESTORE, SetForegroundWindow, ShowWindow,
    };

    let Ok(handle) = HasWindowHandle::window_handle(window) else {
        return;
    };
    let RawWindowHandle::Win32(handle) = handle.as_raw() else {
        return;
    };
    let hwnd = handle.hwnd.get() as *mut core::ffi::c_void;
    unsafe {
        ShowWindow(hwnd, if visible { SW_RESTORE } else { SW_HIDE });
        if visible {
            SetForegroundWindow(hwnd);
        }
    }
}

#[cfg(target_os = "windows")]
struct WindowsTray {
    _icon: tray_icon::TrayIcon,
}

#[cfg(target_os = "windows")]
impl gpui::Global for WindowsTray {}

#[cfg(target_os = "windows")]
fn install_windows_tray(
    shell_sender: async_channel::Sender<ShellCommand>,
    cx: &mut App,
) -> Result<()> {
    use tray_icon::menu::{Menu as TrayMenu, MenuEvent, MenuItem as TrayMenuItem};
    use tray_icon::{Icon, MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    const OPEN_ID: &str = "harness.open";
    const QUIT_ID: &str = "harness.quit";

    let open = TrayMenuItem::with_id(OPEN_ID, "Open TasteCode", true, None);
    let separator = tray_icon::menu::PredefinedMenuItem::separator();
    let quit = TrayMenuItem::with_id(QUIT_ID, "Quit TasteCode", true, None);
    let menu = TrayMenu::with_items(&[&open, &separator, &quit])?;
    let icon = Icon::from_rgba(tray_icon_rgba(), 20, 20)?;
    let tray = TrayIconBuilder::new()
        .with_menu(Box::new(menu))
        .with_menu_on_left_click(false)
        .with_menu_on_right_click(true)
        .with_tooltip("TasteCode")
        .with_icon(icon)
        .build()?;
    let tray_id = tray.id().clone();

    let menu_sender = shell_sender.clone();
    MenuEvent::set_event_handler(Some(move |event: MenuEvent| {
        let command = if event.id == OPEN_ID {
            Some(ShellCommand::Show)
        } else if event.id == QUIT_ID {
            Some(ShellCommand::Quit)
        } else {
            None
        };
        if let Some(command) = command {
            let _ = menu_sender.try_send(command);
        }
    }));
    TrayIconEvent::set_event_handler(Some(move |event: TrayIconEvent| {
        if event.id() == &tray_id
            && matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            )
        {
            let _ = shell_sender.try_send(ShellCommand::Show);
        }
    }));

    cx.set_global(WindowsTray { _icon: tray });
    Ok(())
}

#[cfg(any(test, target_os = "windows"))]
fn tray_icon_rgba() -> Vec<u8> {
    const OUTPUT_SIZE: usize = 20;
    const SUPERSAMPLING: usize = 8;
    const VIEWBOX_SIZE: f32 = 32.0;
    const DARK: [u8; 3] = [0x11, 0x11, 0x13];

    let mut rgba = Vec::with_capacity(OUTPUT_SIZE * OUTPUT_SIZE * 4);
    let samples_per_pixel = (SUPERSAMPLING * SUPERSAMPLING) as f32;
    for pixel_y in 0..OUTPUT_SIZE {
        for pixel_x in 0..OUTPUT_SIZE {
            let mut alpha = 0.0_f32;
            let mut premultiplied = [0.0_f32; 3];
            for sample_y in 0..SUPERSAMPLING {
                for sample_x in 0..SUPERSAMPLING {
                    let x = (pixel_x as f32 + (sample_x as f32 + 0.5) / SUPERSAMPLING as f32)
                        * VIEWBOX_SIZE
                        / OUTPUT_SIZE as f32;
                    let y = (pixel_y as f32 + (sample_y as f32 + 0.5) / SUPERSAMPLING as f32)
                        * VIEWBOX_SIZE
                        / OUTPUT_SIZE as f32;
                    let rounded_x = x.clamp(8.0, 24.0);
                    let rounded_y = y.clamp(8.0, 24.0);
                    let in_background = (x - rounded_x).powi(2) + (y - rounded_y).powi(2) <= 64.0;
                    let in_mark = (8.0..12.0).contains(&x) && (8.0..24.0).contains(&y)
                        || (20.0..24.0).contains(&x) && (8.0..24.0).contains(&y)
                        || (12.0..20.0).contains(&x) && (14.0..18.0).contains(&y);
                    let color = if in_mark {
                        Some([0xff, 0xff, 0xff])
                    } else if in_background {
                        Some(DARK)
                    } else {
                        None
                    };
                    if let Some(color) = color {
                        alpha += 1.0;
                        for channel in 0..3 {
                            premultiplied[channel] += color[channel] as f32;
                        }
                    }
                }
            }
            let alpha_fraction = alpha / samples_per_pixel;
            for channel in premultiplied {
                rgba.push(if alpha == 0.0 {
                    0
                } else {
                    (channel / alpha).round() as u8
                });
            }
            rgba.push((alpha_fraction * 255.0).round() as u8);
        }
    }
    rgba
}

struct HarnessApp {
    theme: Theme,
    sidebar_collapsed: bool,
    sidebar_transition: u64,
    sidebar_transition_kind: SidebarTransitionKind,
    sidebar_transition_instant: bool,
    sidebar_reveal: SidebarRevealState,
    sidebar_width: f32,
    sidebar_resize_drag: Option<SidebarResizeDrag>,
    sidebar_session_drag: Option<String>,
    sidebar_resize_focus: FocusHandle,
    state: ClientState,
    chat: Entity<ChatView>,
    selected_thread_id: Option<String>,
    active_project_path: Option<String>,
    initial_project_selection_done: bool,
    selected_model_key: Option<String>,
    effort: Option<String>,
    service_tier: Option<String>,
    approval: ApprovalMode,
    isolate_session: bool,
    design_mode: bool,
    sidebar_scope: Option<String>,
    scope_open: bool,
    new_thread_picker: bool,
    settings_open: bool,
    settings_section: settings::SettingsSection,
    settings_transition: u64,
    settings_open_transition: u64,
    settings_switch_motion: RefCell<HashMap<usize, settings::SettingsSwitchMotion>>,
    settings_focus: FocusHandle,
    settings_focus_pending: bool,
    command_palette: CommandPaletteState,
    focus_composer_pending: bool,
    session_search: SessionSearchState,
    pending_reveal_turn: Option<(String, String)>,
    sidebar_controls: SidebarControlsState,
    stage_controls: StageControlsState,
    collapsed_projects: HashSet<String>,
    expanded_project_sessions: HashSet<String>,
    sidebar_search: Entity<InputState>,
    sidebar_status_clocks: HashMap<String, (ThreadInboxStatus, f64)>,
    snoozed_expanded: bool,
    settled_expanded: bool,
    settled_limit: usize,
    account_menu_open: bool,
    reconnect_notice_generation: u64,
    reconnect_notice_visible: bool,
    window_active: bool,
    system_theme_mode: ThemeMode,
    reduced_motion: bool,
    preferences: NativePreferences,
    available_fonts: HashSet<String>,
    connection_editor_open: bool,
    connection_submission_id: Option<String>,
    connection_preset: ModelConnectionPreset,
    connection_name: Entity<InputState>,
    connection_base_url: Entity<InputState>,
    connection_default_model: Entity<InputState>,
    connection_api_key: Entity<InputState>,
    model_settings_searches: HashMap<String, Entity<InputState>>,
    mcp_editor: Option<settings::McpEditorState>,
    mcp_editor_submission_id: Option<String>,
    mcp_expanded_servers: HashSet<(ProviderId, String, String)>,
    mcp_editor_id: Entity<InputState>,
    mcp_editor_name: Entity<InputState>,
    mcp_editor_transport: Entity<InputState>,
    mcp_transport_height: f32,
    mcp_transport_resize_drag: Option<McpTransportResizeDrag>,
    auto_settle_days_input: Entity<InputState>,
    provider_terminals: HashMap<ProviderTerminalKey, Entity<ProviderTerminalView>>,
    provider_terminal_ids: HashMap<String, ProviderTerminalKey>,
    copied_provider_code: Option<String>,
    preview_capture: Option<PreviewCaptureRuntime>,
    image_viewer: Option<image_viewer::ImageViewerState>,
    app_zoom: zoom_hud::AppZoomState,
    fixture: bool,
}

impl HarnessApp {
    fn new(endpoint: Endpoint, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let fixture = std::env::var_os("HARNESS_NATIVE_FIXTURE").is_some();
        let mut state = ClientState::new(fixture);
        let preview_capture = PreviewCaptureRuntime::discover();
        state.set_preview_capture_available(preview_capture.is_some());
        let mut preferences = match NativePreferences::load() {
            Ok(preferences) => preferences,
            Err(error) => {
                state.notice = Some(format!("Could not load native preferences: {error}"));
                NativePreferences::default()
            }
        };
        if !fixture {
            state.restore_model_catalog_snapshot(preferences.restored_model_catalog());
        }
        let available_fonts = cx
            .text_system()
            .all_font_names()
            .into_iter()
            .map(|name| name.to_ascii_lowercase())
            .collect::<HashSet<_>>();
        let has_boot_model_catalog = !state.model_catalog.is_empty();
        let sidebar_width = f32::from(preferences.rail_width);
        let window_active = window.is_window_active();
        let system_theme_mode = theme_mode_for_appearance(window.appearance());
        let mode = match preferences.theme {
            ThemePreference::System => system_theme_mode,
            ThemePreference::Light => ThemeMode::Light,
            ThemePreference::Dark => ThemeMode::Dark,
        };
        let reduced_motion = crate::accessibility::prefers_reduced_motion();
        let theme = Theme::new(mode, preferences.backdrop, preferences.accent)
            .with_reduced_motion(reduced_motion);
        let interface_font = resolve_interface_font(preferences.font, &available_fonts);
        sync_component_theme(theme, interface_font, cx);
        let chat = cx.new(|cx| {
            let mut chat = ChatView::new(theme, interface_font.into(), window, cx);
            chat.restore_terminal_preferences(
                preferences.terminal_open,
                preferences.terminal_height,
                window,
            );
            chat
        });
        let restored_terminal_height = chat.read(cx).terminal_preference_height();
        if preferences.terminal_height != restored_terminal_height {
            preferences.terminal_height = restored_terminal_height;
            if let Err(error) = preferences.save() {
                state.notice = Some(format!("Could not save native preferences: {error}"));
            }
        }
        let connection_name = cx.new(|cx| {
            InputState::new(window, cx)
                .default_value("OpenAI API")
                .placeholder("Connection name")
        });
        let connection_base_url = cx.new(|cx| {
            InputState::new(window, cx)
                .default_value("https://api.openai.com/v1")
                .placeholder("https://api.example.com/v1")
        });
        let connection_default_model =
            cx.new(|cx| InputState::new(window, cx).placeholder("Optional model ID"));
        let connection_api_key = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("API key")
                .masked(true)
        });
        let mcp_editor_id = cx.new(|cx| InputState::new(window, cx).placeholder("docs-server"));
        let mcp_editor_name =
            cx.new(|cx| InputState::new(window, cx).placeholder("Optional display name"));
        let mcp_editor_transport = cx.new(|cx| {
            InputState::new(window, cx)
                .multi_line(true)
                .rows(8)
                .placeholder("MCP transport JSON")
        });
        let initial_auto_settle_days = state
            .sidebar_settings
            .auto_settle_days
            .unwrap_or(3)
            .to_string();
        let auto_settle_days_input = cx.new(|cx| {
            InputState::new(window, cx)
                .default_value(initial_auto_settle_days.clone())
                .validate(|value, _cx| {
                    value
                        .parse::<u8>()
                        .is_ok_and(|days| (1..=90).contains(&days))
                })
        });
        let session_search_input =
            cx.new(|cx| InputState::new(window, cx).placeholder("Search every chat…"));
        let command_palette_input = cx
            .new(|cx| InputState::new(window, cx).placeholder("Search commands, projects, chats…"));
        let sidebar_search_input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Search threads")
                .clean_on_escape()
        });
        let sidebar_editor_input = cx.new(|cx| InputState::new(window, cx).placeholder("Name"));

        for input in [
            &connection_name,
            &connection_base_url,
            &connection_default_model,
            &connection_api_key,
            &mcp_editor_id,
            &mcp_editor_name,
            &mcp_editor_transport,
        ] {
            cx.subscribe(input, |_this, _input, event, cx| {
                if matches!(
                    event,
                    InputEvent::Change | InputEvent::Focus | InputEvent::Blur
                ) {
                    cx.notify();
                }
            })
            .detach();
        }
        cx.subscribe(
            &session_search_input,
            |this, _input, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    this.schedule_session_search(cx);
                }
            },
        )
        .detach();
        cx.subscribe(
            &command_palette_input,
            |this, _input, event: &InputEvent, cx| match event {
                InputEvent::PressEnter { .. } => this.run_selected_palette_command(cx),
                InputEvent::Change => this.command_palette_query_changed(cx),
                InputEvent::Focus | InputEvent::Blur => cx.notify(),
            },
        )
        .detach();
        cx.subscribe(
            &sidebar_search_input,
            |_this, _input, event: &InputEvent, cx| {
                if matches!(
                    event,
                    InputEvent::Change | InputEvent::Focus | InputEvent::Blur
                ) {
                    cx.notify();
                }
            },
        )
        .detach();
        cx.subscribe(
            &sidebar_editor_input,
            |this, _input, event: &InputEvent, cx| match event {
                InputEvent::PressEnter { .. } => this.commit_sidebar_dialog(cx),
                InputEvent::Blur
                    if this.sidebar_controls.renaming_thread().is_some()
                        || (this.state.sidebar_settings.mode == SidebarMode::Classic
                            && this.sidebar_controls.renaming_project().is_some()) =>
                {
                    this.commit_sidebar_dialog(cx);
                }
                InputEvent::Change | InputEvent::Focus | InputEvent::Blur => cx.notify(),
            },
        )
        .detach();
        cx.subscribe(
            &auto_settle_days_input,
            |this, input, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change)
                    && this.state.sidebar_settings.auto_settle_days.is_some()
                    && let Ok(days) = input.read(cx).value().parse::<u8>()
                {
                    this.set_auto_settle_days(Some(days), cx);
                }
                cx.notify();
            },
        )
        .detach();

        cx.subscribe(&chat, |this, _chat, event, cx| match event {
            ChatEvent::ProjectRequired => {
                this.state.notice = Some("Choose a project before sending.".into());
                cx.notify();
            }
            ChatEvent::NeedHistory {
                thread_id,
                after_seq,
            } => {
                this.state.request_history(thread_id, *after_seq);
                this.state.request_thread_queue(thread_id);
            }
            ChatEvent::Submit {
                thread_id,
                text,
                attachments,
                steer,
                model,
                effort,
                service_tier,
                optimistic_queue_id,
                steer_echo_after_row,
                started_echo_after_row,
            } => {
                let update = this.state.send_turn(
                    thread_id,
                    SendTurnRequest {
                        text: text.clone(),
                        steer: *steer,
                        attachments: attachments.clone(),
                        model: model.clone(),
                        effort: effort.clone(),
                        service_tier: service_tier.clone(),
                        steer_echo_after_row: *steer_echo_after_row,
                        started_echo_after_row: *started_echo_after_row,
                    },
                    optimistic_queue_id.clone(),
                );
                this.apply_client_update(update, cx);
            }
            ChatEvent::Interrupt { thread_id } => this.state.interrupt(thread_id),
            ChatEvent::DeleteQueuedTurn {
                thread_id,
                queued_turn_id,
            } => {
                let update = this.state.delete_queued_turn(thread_id, queued_turn_id);
                this.apply_client_update(update, cx);
            }
            ChatEvent::MoveQueuedTurn {
                thread_id,
                queued_turn_id,
                direction,
            } => {
                let update = this
                    .state
                    .move_queued_turn(thread_id, queued_turn_id, *direction);
                this.apply_client_update(update, cx);
            }
            ChatEvent::SteerQueuedTurn {
                thread_id,
                queued_turn_id,
            } => {
                let update = this.state.steer_queued_turn(thread_id, queued_turn_id);
                this.apply_client_update(update, cx);
            }
            ChatEvent::Create {
                project_path,
                text,
                attachments,
            } => {
                this.create_thread(project_path.clone(), text.clone(), attachments.clone(), cx);
            }
            ChatEvent::SelectModel { key } => this.select_model(key, cx),
            ChatEvent::SelectEffort { effort } => {
                this.effort = Some(effort.clone());
                this.remember_model_selection();
                this.sync_composer_settings(cx);
            }
            ChatEvent::ToggleFast => this.toggle_fast(cx),
            ChatEvent::SelectApproval { approval } => {
                this.approval = *approval;
                this.preferences.approval = *approval;
                this.persist_native_preferences();
                this.sync_composer_settings(cx);
            }
            ChatEvent::ToggleIsolation => {
                this.isolate_session = !this.isolate_session;
                this.sync_composer_settings(cx);
            }
            ChatEvent::ToggleDesign => {
                this.design_mode = !this.design_mode;
                this.sync_composer_settings(cx);
            }
            ChatEvent::SelectProject { path } => {
                if this.active_project_path.as_deref() != Some(path.as_str()) {
                    this.begin_new_chat(path.clone(), cx);
                }
            }
            ChatEvent::SelectBranch { branch } => {
                this.select_workspace_branch(branch.clone(), cx);
            }
            ChatEvent::OpenCheckpoint { checkpoint_id } => {
                this.open_rollback_checkpoint(*checkpoint_id, cx);
            }
            ChatEvent::OpenImage { image, path, name } => {
                this.open_image_viewer(image.clone(), path.clone(), name.clone(), cx);
            }
            ChatEvent::PickAttachments => this.pick_attachments(cx),
            ChatEvent::TranscribeVoice { params } => {
                let update = this.state.transcribe_voice(params.clone());
                this.apply_client_update(update, cx);
            }
            ChatEvent::CancelVoice { request_id } => {
                this.state.cancel_voice(request_id.clone());
            }
            ChatEvent::RespondApproval {
                thread_id,
                approval_id,
                decision,
            } => {
                let update = this
                    .state
                    .respond_to_approval(thread_id, approval_id, *decision);
                this.apply_client_update(update, cx);
            }
            ChatEvent::RespondUserInput {
                thread_id,
                request_id,
                answers,
            } => {
                let update =
                    this.state
                        .respond_to_user_input(thread_id, request_id, answers.clone());
                this.apply_client_update(update, cx);
            }
            ChatEvent::RequestDiff { thread_id } => {
                let update = this.state.request_diff(thread_id);
                this.apply_client_update(update, cx);
            }
            ChatEvent::ReviewHunk {
                thread_id,
                version,
                path,
                hunk_id,
                decision,
            } => {
                let update = this.state.review_hunk(
                    thread_id,
                    ReviewHunkRequest {
                        version: version.clone(),
                        path: path.clone(),
                        hunk_id: hunk_id.clone(),
                        decision: *decision,
                    },
                );
                this.apply_client_update(update, cx);
            }
            ChatEvent::TerminalOpen {
                thread_id,
                columns,
                rows,
            } => {
                let update = this.state.open_terminal(thread_id, *columns, *rows);
                this.apply_client_update(update, cx);
            }
            ChatEvent::TerminalInput { terminal_id, data } => {
                let update = this.state.write_terminal(terminal_id, data.clone());
                this.apply_client_update(update, cx);
            }
            ChatEvent::TerminalResize {
                terminal_id,
                columns,
                rows,
            } => {
                let update = this.state.resize_terminal(terminal_id, *columns, *rows);
                this.apply_client_update(update, cx);
            }
            ChatEvent::TerminalClose { terminal_id } => {
                let update = this.state.close_terminal(terminal_id);
                this.apply_client_update(update, cx);
            }
            ChatEvent::TerminalPreferencesChanged { visible, height } => {
                if this.preferences.terminal_open != *visible
                    || this.preferences.terminal_height != *height
                {
                    this.preferences.terminal_open = *visible;
                    this.preferences.terminal_height = *height;
                    this.persist_native_preferences();
                }
            }
        })
        .detach();

        if !fixture && let Some(events) = state.connect(endpoint) {
            cx.spawn(async move |view, cx| {
                while let Ok(event) = events.recv().await {
                    let result = view.update(cx, |this, cx| {
                        let update = this.state.handle_event(event);
                        this.apply_client_update(update, cx);
                    });
                    if result.is_err() {
                        break;
                    }
                }
            })
            .detach();
        }

        cx.observe_window_activation(window, |this, window, _cx| {
            let active = window.is_window_active();
            if active && !this.window_active {
                this.state.ensure_healthy();
            }
            this.window_active = active;
        })
        .detach();

        cx.observe_window_appearance(window, |this, window, cx| {
            let mode = theme_mode_for_appearance(window.appearance());
            if this.system_theme_mode != mode {
                this.system_theme_mode = mode;
                if this.preferences.theme == ThemePreference::System {
                    this.apply_native_theme(cx);
                }
            }
        })
        .detach();

        cx.spawn(async move |view, cx| {
            loop {
                cx.background_executor().timer(Duration::from_secs(2)).await;
                let result = view.update(cx, |this, cx| {
                    let reduced_motion = crate::accessibility::prefers_reduced_motion();
                    if this.reduced_motion != reduced_motion {
                        this.reduced_motion = reduced_motion;
                        this.apply_native_theme(cx);
                    }
                });
                if result.is_err() {
                    break;
                }
            }
        })
        .detach();

        cx.spawn(async move |view, cx| {
            let mut delay = Duration::from_secs(1);
            loop {
                cx.background_executor().timer(delay).await;
                let result = view.update(cx, |this, cx| {
                    if this.state.sidebar_settings.mode == SidebarMode::Inbox {
                        cx.notify();
                    }
                    delay = if this.state.projects.iter().any(|project| {
                        project.sessions.iter().any(|session| {
                            session.running
                                || matches!(
                                    session.status,
                                    Some(ThreadInboxStatus::Starting | ThreadInboxStatus::Working)
                                )
                        })
                    }) {
                        Duration::from_secs(1)
                    } else {
                        Duration::from_secs(30)
                    };
                });
                if result.is_err() {
                    break;
                }
            }
        })
        .detach();

        let mut app = Self {
            theme,
            sidebar_collapsed: false,
            sidebar_transition: 0,
            sidebar_transition_kind: SidebarTransitionKind::Expand,
            sidebar_transition_instant: false,
            sidebar_reveal: SidebarRevealState::default(),
            sidebar_width,
            sidebar_resize_drag: None,
            sidebar_session_drag: None,
            sidebar_resize_focus: cx.focus_handle(),
            state,
            chat,
            selected_thread_id: None,
            active_project_path: None,
            initial_project_selection_done: false,
            selected_model_key: preferences.selected_model_key.clone(),
            effort: None,
            service_tier: None,
            approval: preferences.approval,
            isolate_session: false,
            design_mode: false,
            sidebar_scope: None,
            scope_open: false,
            new_thread_picker: false,
            settings_open: false,
            settings_section: settings::SettingsSection::default(),
            settings_transition: 0,
            settings_open_transition: 0,
            settings_switch_motion: RefCell::new(HashMap::new()),
            settings_focus: cx.focus_handle(),
            settings_focus_pending: false,
            command_palette: CommandPaletteState::new(command_palette_input),
            focus_composer_pending: false,
            session_search: SessionSearchState::new(session_search_input),
            pending_reveal_turn: None,
            sidebar_controls: SidebarControlsState::new(sidebar_editor_input),
            stage_controls: StageControlsState::default(),
            collapsed_projects: HashSet::new(),
            expanded_project_sessions: HashSet::new(),
            sidebar_search: sidebar_search_input,
            sidebar_status_clocks: HashMap::new(),
            snoozed_expanded: false,
            settled_expanded: true,
            settled_limit: 10,
            account_menu_open: false,
            reconnect_notice_generation: 0,
            reconnect_notice_visible: false,
            window_active,
            system_theme_mode,
            reduced_motion,
            preferences,
            available_fonts,
            connection_editor_open: false,
            connection_submission_id: None,
            connection_preset: ModelConnectionPreset::Openai,
            connection_name,
            connection_base_url,
            connection_default_model,
            connection_api_key,
            model_settings_searches: HashMap::new(),
            mcp_editor: None,
            mcp_editor_submission_id: None,
            mcp_expanded_servers: HashSet::new(),
            mcp_editor_id,
            mcp_editor_name,
            mcp_editor_transport,
            mcp_transport_height: MCP_TRANSPORT_MIN_HEIGHT,
            mcp_transport_resize_drag: None,
            auto_settle_days_input,
            provider_terminals: HashMap::new(),
            provider_terminal_ids: HashMap::new(),
            copied_provider_code: None,
            preview_capture,
            image_viewer: None,
            app_zoom: zoom_hud::AppZoomState::default(),
            fixture,
        };
        if has_boot_model_catalog {
            app.sync_model_selection(cx);
            app.sync_composer_settings(cx);
        }
        app.select_initial_project_if_ready(cx);
        app
    }

    fn apply_client_update(&mut self, update: ClientUpdate, cx: &mut Context<Self>) {
        let completed_model_catalog = self.state.take_completed_model_catalog_snapshot();
        let shell_changed = update.shell_changed;
        let mut refresh_stage = false;
        for chat_update in update.chat {
            if matches!(&chat_update, ChatUpdate::DraftError { .. })
                && self
                    .selected_thread_id
                    .as_deref()
                    .is_some_and(|thread_id| thread_id.starts_with("pending:"))
            {
                self.selected_thread_id = None;
            }
            if let ChatUpdate::Connection(connection) = &chat_update {
                self.update_reconnect_notice(*connection, cx);
            }
            refresh_stage |= match &chat_update {
                ChatUpdate::Refresh => true,
                ChatUpdate::Event(push) => {
                    self.selected_thread_id.as_deref() == Some(push.thread_id.as_str())
                        && matches!(
                            push.event,
                            harness_protocol::DomainEvent::TurnCompleted { .. }
                        )
                }
                _ => false,
            };
            let reveal_turn = match (&chat_update, self.pending_reveal_turn.as_ref()) {
                (
                    ChatUpdate::History {
                        thread_id,
                        replace: true,
                        ..
                    },
                    Some((pending_thread_id, turn_id)),
                ) if thread_id == pending_thread_id => Some(turn_id.clone()),
                _ => None,
            };
            self.chat.update(cx, |chat, cx| {
                chat.apply_update(chat_update, cx);
                if let Some(turn_id) = reveal_turn.as_deref() {
                    chat.reveal_turn(turn_id, cx);
                }
            });
            if reveal_turn.is_some() {
                self.pending_reveal_turn = None;
            }
        }
        if shell_changed {
            self.reconcile_session_order();
            self.sync_model_selection(cx);
        }
        for event in update.shell_events {
            self.apply_shell_event(event, cx);
        }
        self.select_initial_project_if_ready(cx);
        if refresh_stage {
            self.refresh_stage_context(cx);
        }
        if self.connection_submission_id.is_some() && self.state.connection_busy.is_none() {
            if self.state.connection_error.is_none() {
                self.connection_editor_open = false;
            }
            self.connection_submission_id = None;
        }
        if self.mcp_editor_submission_id.is_some() && self.state.mcp_busy.is_none() {
            if self.state.mcp_notice.is_some() || self.state.mcp_error.is_none() {
                self.mcp_editor = None;
                self.mcp_transport_resize_drag = None;
            }
            self.mcp_editor_submission_id = None;
        }
        if shell_changed {
            self.sync_composer_settings(cx);
            self.sync_stage_settings(cx);
            cx.notify();
        }
        if let Some(catalog) = completed_model_catalog {
            let _ = NativePreferences::save_model_catalog_cache(&catalog);
        }
    }

    fn update_reconnect_notice(&mut self, connection: ConnectionState, cx: &mut Context<Self>) {
        self.reconnect_notice_generation = self.reconnect_notice_generation.wrapping_add(1);
        let generation = self.reconnect_notice_generation;
        if connection != ConnectionState::Reconnecting {
            self.reconnect_notice_visible = false;
            return;
        }

        cx.spawn(async move |view, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(1_200))
                .await;
            let _ = view.update(cx, |this, cx| {
                if this.reconnect_notice_generation == generation
                    && this.state.connection == ConnectionState::Reconnecting
                {
                    this.reconnect_notice_visible = true;
                    cx.notify();
                }
            });
        })
        .detach();
    }

    fn sync_model_selection(&mut self, cx: &mut Context<Self>) {
        if !self.state.model_catalog_loaded {
            return;
        }
        let Some(choice) = resolve_model_choice(
            &self.state.model_catalog,
            self.selected_model_key.as_deref(),
            &self.preferences.hidden_models,
        )
        .cloned() else {
            self.selected_model_key = self.preferences.selected_model_key.clone();
            let remembered = self.selected_model_key.as_ref().and_then(|selected| {
                self.preferences
                    .model_by_source
                    .values()
                    .find(|selection| selection.model_key == *selected)
            });
            self.effort = remembered.and_then(|selection| selection.effort.clone());
            self.service_tier = remembered.and_then(|selection| selection.service_tier.clone());
            return;
        };
        let (effort, service_tier) = self.remembered_model_settings(&choice);
        self.selected_model_key = Some(choice.key.clone());
        self.effort = effort;
        self.service_tier = service_tier;
        self.remember_model_selection();
        self.chat.update(cx, |chat, cx| {
            chat.update_draft_provider(choice.provider, cx);
        });
    }

    fn apply_shell_event(&mut self, event: ShellEvent, cx: &mut Context<Self>) {
        match event {
            ShellEvent::ProjectAdded { path } => {
                self.sidebar_scope = Some(path.clone());
                self.settled_limit = 10;
                self.begin_new_chat(path, cx);
            }
            ShellEvent::ProjectRemoved { path } => {
                if self.sidebar_scope.as_deref() == Some(path.as_str()) {
                    self.sidebar_scope = None;
                    self.settled_limit = 10;
                }
                if self.active_project_path.as_deref() == Some(path.as_str()) {
                    self.selected_thread_id = None;
                    self.active_project_path = None;
                    self.pending_reveal_turn = None;
                    self.stage_controls.clear_restore_undo();
                    if let Some(next_path) = self
                        .state
                        .projects
                        .first()
                        .map(|project| project.path.clone())
                    {
                        self.begin_new_chat(next_path, cx);
                    } else {
                        self.chat.update(cx, |chat, cx| chat.begin_empty_draft(cx));
                        self.state.notice = None;
                        self.refresh_stage_context(cx);
                    }
                }
                cx.notify();
            }
            ShellEvent::ThreadHidden { thread_id } => {
                if self.selected_thread_id.as_deref() == Some(thread_id.as_str()) {
                    self.select_next_active_or_draft(&thread_id, cx);
                }
            }
            ShellEvent::ArchiveNeedsConfirmation { thread_id } => {
                self.show_archive_confirmation(thread_id, cx);
            }
            ShellEvent::ArchiveFailed { thread_id } => {
                self.handle_thread_archive_failed(thread_id, cx);
            }
            ShellEvent::ThreadArchived { thread_id } => {
                self.handle_thread_archived(thread_id, cx);
            }
            ShellEvent::ThreadStarted {
                thread_id,
                project_path,
                title,
                provider,
            } => {
                let project_name = self
                    .state
                    .projects
                    .iter()
                    .find(|project| project.path == project_path)
                    .map_or_else(|| project_path.clone(), |project| project.name.clone());
                self.selected_thread_id = Some(thread_id.clone());
                self.active_project_path = Some(project_path.clone());
                self.stage_controls.clear_restore_undo();
                self.account_menu_open = false;
                self.settings_open = false;
                let pending_turns = self.chat.update(cx, |chat, cx| {
                    chat.promote_draft(
                        SessionContext {
                            thread_id: Some(thread_id.clone()),
                            title,
                            project_path,
                            project_name,
                            provider: Some(provider),
                        },
                        cx,
                    )
                });
                for pending in pending_turns {
                    let update = self.state.send_turn(
                        &thread_id,
                        SendTurnRequest {
                            text: pending.text,
                            steer: pending.steer,
                            attachments: pending.attachments,
                            model: pending.model,
                            effort: pending.effort,
                            service_tier: pending.service_tier,
                            steer_echo_after_row: None,
                            started_echo_after_row: None,
                        },
                        None,
                    );
                    self.apply_client_update(update, cx);
                }
                self.state.select_thread(&thread_id);
                self.refresh_stage_context(cx);
            }
            ShellEvent::OpenUrl { url } => cx.open_url(&url),
            ShellEvent::ProviderTerminalOpened {
                target,
                kind,
                terminal_id,
                buffered_output,
                early_exit,
            } => self.apply_provider_terminal_opened(
                target,
                kind,
                terminal_id,
                buffered_output,
                early_exit,
                cx,
            ),
            ShellEvent::ProviderTerminalOutput(push) => {
                self.apply_provider_terminal_output(push.terminal_id, push.data, cx)
            }
            ShellEvent::ProviderTerminalExit(push) => {
                self.apply_provider_terminal_exit(push.terminal_id, push.exit_code, cx);
            }
            ShellEvent::ProviderTerminalError {
                target,
                kind,
                terminal_id,
                message,
            } => self.apply_provider_terminal_error(target, kind, terminal_id, message, cx),
            ShellEvent::ProviderTerminalClosed { terminal_id } => {
                self.apply_provider_terminal_closed(terminal_id, cx);
            }
            ShellEvent::PreviewCaptureRequested(request) => {
                let Some(runtime) = self.preview_capture.clone() else {
                    self.state.submit_preview_capture_result(
                        harness_protocol::PreviewCaptureResult::Failed {
                            request_id: request.request_id,
                            error: "Preview capture is unavailable.".into(),
                        },
                    );
                    return;
                };
                let capture = cx
                    .background_executor()
                    .spawn(async move { runtime.capture(request) });
                cx.spawn(async move |view, cx| {
                    let result = capture.await;
                    let _ = view.update(cx, |this, _cx| {
                        this.state.submit_preview_capture_result(result);
                    });
                })
                .detach();
            }
            ShellEvent::SessionSearchResults {
                revision,
                append,
                page,
            } => {
                if self.session_search.open && self.session_search.revision == revision {
                    self.session_search.loading = false;
                    self.session_search.error = None;
                    if append {
                        self.session_search.results.extend(page.results);
                    } else {
                        self.session_search.results = page.results;
                    }
                    self.session_search.next_cursor = page.next_cursor;
                    cx.notify();
                }
            }
            ShellEvent::SessionSearchError { revision, message } => {
                if self.session_search.open && self.session_search.revision == revision {
                    self.session_search.loading = false;
                    self.session_search.error = Some(message);
                    cx.notify();
                }
            }
            ShellEvent::WorkspaceInfo {
                path,
                generation,
                info,
            } => self.apply_workspace_info(path, generation, info, cx),
            ShellEvent::WorkspaceBranches {
                path,
                generation,
                branches,
            } => self.apply_workspace_branches(path, generation, branches, cx),
            ShellEvent::WorkspaceSwitched {
                path,
                branch,
                generation,
                info,
            } => self.apply_workspace_switched(path, branch, generation, info, cx),
            ShellEvent::WorkspaceError {
                path,
                generation,
                operation,
                message,
            } => self.apply_workspace_error(path, generation, operation, message, cx),
            ShellEvent::Checkpoints {
                thread_id,
                generation,
                checkpoints,
            } => self.apply_checkpoints(thread_id, generation, checkpoints, cx),
            ShellEvent::ChangedSince {
                thread_id,
                checkpoint_id,
                generation,
                files,
            } => self.apply_changed_since(thread_id, checkpoint_id, generation, files, cx),
            ShellEvent::CheckpointRestored {
                thread_id,
                checkpoint_id,
                generation,
                undo,
            } => self.apply_checkpoint_restored(thread_id, checkpoint_id, generation, undo, cx),
            ShellEvent::RestoreUndone {
                thread_id,
                generation,
            } => self.apply_restore_undone(thread_id, generation, cx),
            ShellEvent::RollbackError {
                thread_id,
                generation,
                operation,
                message,
            } => self.apply_rollback_error(thread_id, generation, operation, message, cx),
            ShellEvent::UsageSummary {
                scope,
                generation,
                summary,
            } => self.apply_usage_summary(scope, generation, summary, cx),
            ShellEvent::UsageError {
                scope,
                generation,
                message,
            } => self.apply_usage_error(scope, generation, message, cx),
        }
    }

    fn select_session(&mut self, thread_id: String, cx: &mut Context<Self>) {
        let selection = self.state.projects.iter().find_map(|project| {
            project
                .sessions
                .iter()
                .find(|session| session.id == thread_id)
                .map(|session| {
                    (
                        SessionContext {
                            thread_id: Some(session.id.clone()),
                            title: session.title.clone(),
                            project_path: project.path.clone(),
                            project_name: project.name.clone(),
                            provider: Some(session.provider),
                        },
                        session.provider,
                        session.agent.clone(),
                    )
                })
        });
        let Some((context, provider, agent)) = selection else {
            return;
        };
        let matching_model = self
            .state
            .model_catalog
            .iter()
            .find(|choice| {
                choice.provider == provider
                    && (provider != harness_protocol::ProviderId::Acp || choice.agent_id == agent)
            })
            .map(|choice| choice.key.clone());
        if let Some(key) = matching_model {
            self.select_model(&key, cx);
            self.sync_model_selection(cx);
            self.sync_composer_settings(cx);
        }

        self.selected_thread_id = Some(thread_id.clone());
        self.active_project_path = Some(context.project_path.clone());
        self.stage_controls.clear_restore_undo();
        self.account_menu_open = false;
        self.settings_open = false;
        self.chat.update(cx, |chat, cx| {
            chat.begin_session(context, cx);
        });
        self.state.select_thread(&thread_id);
        self.refresh_stage_context(cx);
        cx.notify();
    }

    fn select_next_active_or_draft(&mut self, excluded_thread_id: &str, cx: &mut Context<Self>) {
        self.select_next_active_or_draft_excluding(
            &HashSet::from([excluded_thread_id.to_owned()]),
            cx,
        );
    }

    pub(super) fn select_next_active_or_draft_excluding(
        &mut self,
        excluded_thread_ids: &HashSet<String>,
        cx: &mut Context<Self>,
    ) {
        let project_path = self.active_project_path.clone();
        let next = self
            .state
            .projects
            .iter()
            .flat_map(|project| project.sessions.iter())
            .filter(|session| {
                !excluded_thread_ids.contains(&session.id)
                    && matches!(
                        session.lifecycle.as_ref(),
                        Some(harness_protocol::ThreadLifecycle::Active { .. }) | None
                    )
            })
            .max_by(|left, right| {
                left.created_at
                    .partial_cmp(&right.created_at)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .map(|session| session.id.clone());
        if let Some(next) = next {
            self.select_session(next, cx);
        } else if let Some(project_path) = project_path
            && self
                .state
                .projects
                .iter()
                .any(|project| project.path == project_path)
        {
            self.begin_new_chat(project_path, cx);
        } else {
            self.selected_thread_id = None;
            self.active_project_path = None;
            self.chat.update(cx, |chat, cx| chat.begin_empty_draft(cx));
            self.refresh_stage_context(cx);
            cx.notify();
        }
    }

    fn start_new_chat(&mut self, cx: &mut Context<Self>) {
        if self.state.sidebar_settings.mode == harness_protocol::SidebarMode::Classic {
            if let Some(path) = self.active_project_path.clone().or_else(|| {
                self.state
                    .projects
                    .first()
                    .map(|project| project.path.clone())
            }) {
                self.begin_new_chat(path, cx);
            } else {
                self.pick_project(cx);
            }
            return;
        }
        match self.state.projects.as_slice() {
            [] => self.pick_project(cx),
            [project] => self.begin_new_chat(project.path.clone(), cx),
            _ => {
                self.open_command_palette(
                    CommandScope::NewThread,
                    self.active_project_path.clone(),
                    cx,
                );
            }
        }
    }

    fn select_initial_project_if_ready(&mut self, cx: &mut Context<Self>) {
        if self.initial_project_selection_done || !self.state.projects_loaded {
            return;
        }
        self.initial_project_selection_done = true;
        if let Some(path) = self
            .state
            .projects
            .first()
            .map(|project| project.path.clone())
        {
            self.begin_new_chat(path, cx);
        } else {
            self.sync_stage_settings(cx);
            cx.notify();
        }
    }

    fn begin_new_chat(&mut self, project_path: String, cx: &mut Context<Self>) {
        let Some(project) = self
            .state
            .projects
            .iter()
            .find(|project| project.path == project_path)
            .cloned()
        else {
            self.state.notice = Some("That project is no longer available.".into());
            cx.notify();
            return;
        };
        let _ = self.state.delete_untouched_sessions(&project.path);
        self.initial_project_selection_done = true;
        self.selected_thread_id = None;
        self.active_project_path = Some(project.path.clone());
        self.sync_model_selection(cx);
        let context = SessionContext {
            thread_id: None,
            title: "New chat".into(),
            project_path: project.path.clone(),
            project_name: project.name.clone(),
            provider: self.selected_model_choice().map(|choice| choice.provider),
        };
        self.settings_open = false;
        self.account_menu_open = false;
        self.scope_open = false;
        self.new_thread_picker = false;
        self.state.notice = None;
        self.chat.update(cx, |chat, cx| {
            chat.begin_draft(context, cx);
        });
        self.stage_controls.clear_restore_undo();
        self.refresh_stage_context(cx);
        cx.notify();
    }

    fn create_thread(
        &mut self,
        project_path: String,
        text: String,
        mut attachments: Vec<String>,
        cx: &mut Context<Self>,
    ) {
        let Some(choice) = self.selected_model_choice().cloned() else {
            self.chat.update(cx, |chat, cx| {
                chat.apply_update(
                    crate::client_state::ChatUpdate::DraftError {
                        message: "Choose a configured model before starting this chat.".into(),
                        restore_text: text,
                        restore_attachments: attachments,
                    },
                    cx,
                );
            });
            return;
        };
        if self.design_mode
            && !attachments
                .iter()
                .any(|path| path == DESIGN_BRIEF_ATTACHMENT)
        {
            attachments.push(DESIGN_BRIEF_ATTACHMENT.into());
        }
        let provisional_id = format!("pending:{}", uuid::Uuid::new_v4());
        self.selected_thread_id = Some(provisional_id.clone());
        let update = self.state.start_thread(NewThreadRequest {
            provisional_id,
            project_path,
            title: title_from(&text),
            attachments,
            text,
            choice,
            effort: self.effort.clone(),
            service_tier: self.service_tier.clone(),
            approval: self.effective_approval(),
            isolate: self.isolate_session,
        });
        self.apply_client_update(update, cx);
    }

    fn selected_model_choice(&self) -> Option<&crate::client_state::ModelChoice> {
        let key = self.selected_model_key.as_ref()?;
        self.state
            .model_catalog
            .iter()
            .find(|choice| choice.key == *key)
    }

    fn auto_review_supported(&self) -> bool {
        self.selected_model_choice().is_some_and(|choice| {
            self.state
                .provider_statuses
                .iter()
                .find(|provider| provider.id == choice.provider)
                .and_then(|provider| provider.capabilities.as_ref())
                .and_then(|capabilities| capabilities.auto_review)
                .unwrap_or(false)
        })
    }

    fn effective_approval(&self) -> ApprovalMode {
        effective_approval_mode(self.approval, self.auto_review_supported())
    }

    fn select_model(&mut self, key: &str, cx: &mut Context<Self>) {
        let Some(next) = self
            .state
            .model_catalog
            .iter()
            .find(|choice| choice.key == key)
            .cloned()
        else {
            return;
        };
        let current_model = self
            .selected_model_choice()
            .map(|choice| choice.model.clone());
        let remembered = self
            .preferences
            .model_by_source
            .get(&source_key(&next))
            .filter(|selection| selection.model_key == next.key)
            .cloned();
        if remembered.is_some() {
            (self.effort, self.service_tier) = self.remembered_model_settings(&next);
        } else {
            self.effort = resolve_reasoning_effort(
                self.effort.as_deref(),
                current_model.as_ref(),
                &next.model,
            );
            self.service_tier = next_service_tier(
                current_model.as_ref(),
                &next.model,
                self.service_tier.as_deref(),
            );
        }
        self.selected_model_key = Some(next.key);
        self.remember_model_selection();
        self.chat.update(cx, |chat, cx| {
            chat.update_draft_provider(next.provider, cx);
        });
        self.sync_composer_settings(cx);
    }

    fn toggle_fast(&mut self, cx: &mut Context<Self>) {
        let Some(model) = self
            .selected_model_choice()
            .map(|choice| choice.model.clone())
        else {
            return;
        };
        self.service_tier = if is_fast_mode_enabled(&model, self.service_tier.as_deref()) {
            fast_mode_off_value(&model)
        } else {
            fast_service_tier(&model).map(|tier| tier.id.clone())
        };
        self.remember_model_selection();
        self.sync_composer_settings(cx);
    }

    fn remembered_model_settings(
        &self,
        choice: &crate::client_state::ModelChoice,
    ) -> (Option<String>, Option<String>) {
        let remembered = self
            .preferences
            .model_by_source
            .get(&source_key(choice))
            .filter(|selection| selection.model_key == choice.key);
        let effort = remembered
            .and_then(|selection| selection.effort.as_ref())
            .filter(|effort| choice.model.reasoning_efforts.contains(effort))
            .cloned()
            .or_else(|| default_reasoning_effort(&choice.model));
        let service_tier = remembered
            .and_then(|selection| selection.service_tier.as_ref())
            .filter(|selected| {
                choice
                    .model
                    .service_tiers
                    .iter()
                    .any(|tier| tier.id == **selected)
            })
            .cloned()
            .or_else(|| choice.model.default_service_tier.clone());
        (effort, service_tier)
    }

    fn remember_model_selection(&mut self) {
        let Some(choice) = self.selected_model_choice().cloned() else {
            return;
        };
        let entry = SourceSelection {
            model_key: choice.key.clone(),
            effort: self.effort.clone(),
            service_tier: self.service_tier.clone(),
        };
        let source = source_key(&choice);
        let mut changed =
            self.preferences.selected_model_key.as_deref() != Some(choice.key.as_str());
        if changed {
            self.preferences.selected_model_key = Some(choice.key);
        }
        if self.preferences.model_by_source.get(&source) != Some(&entry) {
            self.preferences.model_by_source.insert(source, entry);
            changed = true;
        }
        if changed {
            self.persist_native_preferences();
        }
    }

    fn sync_composer_settings(&mut self, cx: &mut Context<Self>) {
        let selected_provider = self.selected_model_choice().map(|choice| choice.provider);
        if let Some(provider) = selected_provider {
            self.state.ensure_voice_status(provider);
        }
        let voice_available = selected_provider.is_some_and(|provider| {
            provider == ProviderId::Codex
                && self
                    .state
                    .voice_statuses
                    .get(&provider)
                    .is_some_and(|status| status.available)
        });
        let auto_review_supported = self.auto_review_supported();
        let approval = self.effective_approval();
        self.chat.update(cx, |chat, cx| {
            chat.update_composer_settings(
                ComposerSettings {
                    models: self
                        .state
                        .model_catalog
                        .iter()
                        .filter(|choice| !self.preferences.hidden_models.contains(&choice.key))
                        .cloned()
                        .collect(),
                    selected_model_key: self.selected_model_key.clone(),
                    effort: self.effort.clone(),
                    service_tier: self.service_tier.clone(),
                    approval,
                    auto_review_supported,
                    isolate: self.isolate_session,
                    design_mode: self.design_mode,
                    voice_available,
                },
                cx,
            );
        });
    }

    fn pick_project(&mut self, cx: &mut Context<Self>) {
        let receiver = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Add Project".into()),
        });
        self.state.notice = None;
        cx.spawn(async move |view, cx| {
            let Ok(result) = receiver.await else {
                return;
            };
            match result {
                Ok(Some(paths)) => {
                    let Some(path) = paths.into_iter().next() else {
                        return;
                    };
                    let path = path.to_string_lossy().into_owned();
                    let _ = view.update(cx, |this, cx| {
                        this.state.add_project(path);
                        cx.notify();
                    });
                }
                Ok(None) => {}
                Err(error) => {
                    let message = error.to_string();
                    let _ = view.update(cx, |this, cx| {
                        this.state.notice = Some(format!("Could not open that project: {message}"));
                        cx.notify();
                    });
                }
            }
        })
        .detach();
    }

    fn pick_attachments(&mut self, cx: &mut Context<Self>) {
        let receiver = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: true,
            multiple: true,
            prompt: Some("Attach".into()),
        });
        let chat = self.chat.clone();
        cx.spawn(async move |_view, cx| {
            let Ok(Ok(Some(paths))) = receiver.await else {
                return;
            };
            let paths = paths
                .into_iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect::<Vec<_>>();
            let _ = chat.update(cx, |chat, cx| chat.add_attachments(paths, cx));
        })
        .detach();
    }

    fn sync_sidebar_status_clocks(&mut self) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0.0, |duration| duration.as_secs_f64() * 1_000.0);
        let mut live = HashSet::new();
        for session in self
            .state
            .projects
            .iter()
            .flat_map(|project| project.sessions.iter())
        {
            live.insert(session.id.clone());
            let status = session.status.unwrap_or(if session.running {
                ThreadInboxStatus::Working
            } else {
                ThreadInboxStatus::Idle
            });
            self.sidebar_status_clocks
                .entry(session.id.clone())
                .and_modify(|clock| {
                    if clock.0 != status {
                        *clock = (status, now);
                    }
                })
                .or_insert_with(|| {
                    (
                        status,
                        if session.running {
                            now
                        } else {
                            session.created_at
                        },
                    )
                });
        }
        self.sidebar_status_clocks
            .retain(|thread_id, _| live.contains(thread_id));
    }

    fn handle_sidebar_search_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.state.sidebar_settings.mode != SidebarMode::Inbox
            || !self
                .sidebar_search
                .read(cx)
                .focus_handle(cx)
                .is_focused(window)
        {
            return;
        }
        if event.keystroke.key.eq_ignore_ascii_case("escape") {
            if !self.sidebar_search.read(cx).value().is_empty() {
                cx.stop_propagation();
                self.sidebar_search.update(cx, |input, cx| {
                    input.set_value(String::new(), window, cx);
                });
            }
            return;
        }
        let first = event.keystroke.key.eq_ignore_ascii_case("down");
        let last = event.keystroke.key.eq_ignore_ascii_case("up");
        if !first && !last {
            return;
        }
        let query = self.sidebar_search.read(cx).value();
        let ordered = ordered_inbox_ids(
            &self.state.projects,
            self.sidebar_scope.as_deref(),
            query.as_ref(),
        );
        let target = if first {
            ordered.first()
        } else {
            ordered.last()
        };
        if let Some(focus) =
            target.and_then(|thread_id| self.sidebar_controls.row_focus.get(thread_id).cloned())
        {
            cx.stop_propagation();
            focus.focus(window);
        }
    }

    fn begin_sidebar_session_drag(
        &mut self,
        thread_id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.sidebar_session_drag = Some(thread_id);
        cx.on_next_frame(window, |_this, window, cx| {
            cx.set_active_drag_cursor_style(CursorStyle::ClosedHand, window);
        });
        cx.notify();
    }

    fn finish_sidebar_session_drag(&mut self, cx: &mut Context<Self>) {
        if self.sidebar_session_drag.take().is_some() {
            cx.notify();
        }
    }

    fn reorder_sidebar_session(
        &mut self,
        project_path: String,
        source_id: String,
        target_id: String,
        position: SessionDropPosition,
        cx: &mut Context<Self>,
    ) {
        self.sidebar_session_drag = None;
        let Some(project) = self
            .state
            .projects
            .iter_mut()
            .find(|project| project.path == project_path)
        else {
            cx.notify();
            return;
        };
        if reorder_project_sessions(&mut project.sessions, &source_id, &target_id, position) {
            self.preferences.session_order.insert(
                project_path,
                project
                    .sessions
                    .iter()
                    .map(|session| session.id.clone())
                    .collect(),
            );
            self.persist_native_preferences();
        }
        cx.notify();
    }

    fn reconcile_session_order(&mut self) {
        if !self.state.projects_loaded
            || self.state.projects.is_empty()
            || self.preferences.session_order.is_empty()
        {
            return;
        }
        for project in &mut self.state.projects {
            if let Some(order) = self.preferences.session_order.get(&project.path) {
                apply_project_session_order(&mut project.sessions, order);
            }
        }

        let mut next = self.preferences.session_order.clone();
        let live_paths = self
            .state
            .projects
            .iter()
            .map(|project| project.path.as_str())
            .collect::<HashSet<_>>();
        next.retain(|path, _| live_paths.contains(path.as_str()));
        for project in &self.state.projects {
            if next.contains_key(&project.path) {
                next.insert(
                    project.path.clone(),
                    project
                        .sessions
                        .iter()
                        .map(|session| session.id.clone())
                        .collect(),
                );
            }
        }
        if next != self.preferences.session_order {
            self.preferences.session_order = next;
            self.persist_native_preferences();
        }
    }

    fn sidebar_actions(&self, cx: &Context<Self>) -> SidebarActions {
        let select_view = cx.weak_entity();
        let choose_view = select_view.clone();
        let new_chat_view = select_view.clone();
        let new_project_view = select_view.clone();
        let search_view = select_view.clone();
        let settings_view = select_view.clone();
        let toggle_scope_view = select_view.clone();
        let select_scope_view = select_view.clone();
        let toggle_project_view = select_view.clone();
        let toggle_project_sessions_view = select_view.clone();
        let new_chat_in_project_view = select_view.clone();
        let settle_thread_view = select_view.clone();
        let wake_thread_view = select_view.clone();
        let unsettle_thread_view = select_view.clone();
        let rename_thread_view = select_view.clone();
        let begin_session_drag_view = select_view.clone();
        let reorder_session_view = select_view.clone();
        let archive_thread_view = select_view.clone();
        let open_menu_view = select_view.clone();
        let toggle_snoozed_view = select_view.clone();
        let toggle_settled_view = select_view.clone();
        let show_more_settled_view = select_view.clone();
        let toggle_account_view = select_view.clone();
        SidebarActions {
            select_session: Rc::new(move |thread_id, cx| {
                let _ = select_view.update(cx, |this, cx| this.select_session(thread_id, cx));
            }),
            choose_session: Rc::new(move |thread_id, modifiers: SelectionModifiers, cx| {
                let _ = choose_view.update(cx, |this, cx| {
                    this.choose_inbox_session(thread_id, modifiers, cx);
                });
            }),
            new_chat: Rc::new(move |cx| {
                let _ = new_chat_view.update(cx, |this, cx| this.start_new_chat(cx));
            }),
            new_project: Rc::new(move |cx| {
                let _ = new_project_view.update(cx, |this, cx| this.pick_project(cx));
            }),
            open_search: Rc::new(move |cx| {
                let _ = search_view.update(cx, |this, cx| {
                    this.open_session_search(None, cx);
                });
            }),
            open_settings: Rc::new(move |cx| {
                let _ = settings_view.update(cx, |this, cx| {
                    this.open_settings(cx);
                });
            }),
            toggle_scope: Rc::new(move |cx| {
                let _ = toggle_scope_view.update(cx, |this, cx| {
                    this.new_thread_picker = false;
                    this.scope_open = !this.scope_open;
                    cx.notify();
                });
            }),
            select_scope: Rc::new(move |path, cx| {
                let _ = select_scope_view.update(cx, |this, cx| {
                    let should_start = this.new_thread_picker && path.is_some();
                    this.sidebar_scope = path.clone();
                    this.settled_limit = 10;
                    this.scope_open = false;
                    this.new_thread_picker = false;
                    if should_start {
                        this.begin_new_chat(path.expect("checked above"), cx);
                    } else {
                        cx.notify();
                    }
                });
            }),
            toggle_project: Rc::new(move |path, cx| {
                let _ = toggle_project_view.update(cx, |this, cx| {
                    if !this.collapsed_projects.remove(&path) {
                        this.expanded_project_sessions.remove(&path);
                        this.collapsed_projects.insert(path);
                    }
                    cx.notify();
                });
            }),
            toggle_project_sessions: Rc::new(move |path, cx| {
                let _ = toggle_project_sessions_view.update(cx, |this, cx| {
                    if !this.expanded_project_sessions.remove(&path) {
                        this.expanded_project_sessions.insert(path);
                    }
                    cx.notify();
                });
            }),
            new_chat_in_project: Rc::new(move |path, cx| {
                let _ = new_chat_in_project_view.update(cx, |this, cx| {
                    this.begin_new_chat(path, cx);
                });
            }),
            settle_thread: Rc::new(move |thread_id, cx| {
                let _ = settle_thread_view.update(cx, |this, cx| {
                    let update = this.state.settle_thread(thread_id);
                    this.apply_client_update(update, cx);
                });
            }),
            wake_thread: Rc::new(move |thread_id, cx| {
                let _ = wake_thread_view.update(cx, |this, cx| {
                    let update = this.state.unsnooze_thread(thread_id);
                    this.apply_client_update(update, cx);
                });
            }),
            unsettle_thread: Rc::new(move |thread_id, cx| {
                let _ = unsettle_thread_view.update(cx, |this, cx| {
                    let update = this.state.unsettle_thread(thread_id);
                    this.apply_client_update(update, cx);
                });
            }),
            rename_thread: Rc::new(move |thread_id, cx| {
                let _ = rename_thread_view.update(cx, |this, cx| {
                    this.begin_rename_thread(thread_id, cx);
                });
            }),
            begin_session_drag: Rc::new(move |thread_id, window, cx| {
                let _ = begin_session_drag_view.update(cx, |this, cx| {
                    this.begin_sidebar_session_drag(thread_id, window, cx);
                });
            }),
            reorder_session: Rc::new(move |project_path, source_id, target_id, position, cx| {
                let _ = reorder_session_view.update(cx, |this, cx| {
                    this.reorder_sidebar_session(project_path, source_id, target_id, position, cx);
                });
            }),
            archive_thread: Rc::new(move |thread_id, cx| {
                let _ = archive_thread_view.update(cx, |this, cx| {
                    let update = this.state.archive_thread(thread_id);
                    this.apply_client_update(update, cx);
                });
            }),
            open_menu: Rc::new(
                move |request: SidebarMenuRequest, anchor: SidebarMenuAnchor, cx| {
                    let _ = open_menu_view.update(cx, |this, cx| {
                        this.open_sidebar_menu(request, anchor, cx);
                    });
                },
            ),
            toggle_snoozed: Rc::new(move |cx| {
                let _ = toggle_snoozed_view.update(cx, |this, cx| {
                    this.snoozed_expanded = !this.snoozed_expanded;
                    cx.notify();
                });
            }),
            toggle_settled: Rc::new(move |cx| {
                let _ = toggle_settled_view.update(cx, |this, cx| {
                    this.settled_expanded = !this.settled_expanded;
                    cx.notify();
                });
            }),
            show_more_settled: Rc::new(move |cx| {
                let _ = show_more_settled_view.update(cx, |this, cx| {
                    this.settled_limit = this.settled_limit.saturating_add(25);
                    cx.notify();
                });
            }),
            toggle_account: Rc::new(move |cx| {
                let _ = toggle_account_view.update(cx, |this, cx| {
                    this.account_menu_open = !this.account_menu_open;
                    cx.notify();
                });
            }),
        }
    }

    fn titlebar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let left_padding = if cfg!(target_os = "macos") {
            80.0
        } else {
            12.0
        };
        let resize_folded = self.sidebar_resize_drag.is_some_and(|drag| drag.folded);
        let layout_animating = self.sidebar_transition != 0 && !self.sidebar_transition_instant;
        let stage_left_open = self.sidebar_width + 16.0;
        let stage_left_collapsed = left_padding + 30.0;
        let (stage_left_from, stage_left_to) = match self.sidebar_transition_kind {
            SidebarTransitionKind::Collapse => (stage_left_open, stage_left_collapsed),
            SidebarTransitionKind::Expand => (stage_left_collapsed, stage_left_open),
            SidebarTransitionKind::DragFold => (stage_left_open, 16.0),
            SidebarTransitionKind::DragUnfold => (16.0, stage_left_open),
        };
        let stage_left_direct = if self.sidebar_collapsed {
            stage_left_collapsed
        } else if resize_folded {
            16.0
        } else {
            stage_left_open
        };
        let session = self.selected_thread_id.as_deref().and_then(|thread_id| {
            self.state
                .projects
                .iter()
                .flat_map(|project| project.sessions.iter())
                .find(|session| session.id == thread_id)
                .cloned()
        });
        let terminal_open = self.chat.read(cx).terminal_visible();
        let checkpoint_count = session
            .as_ref()
            .filter(|session| !session.running)
            .map_or(0, |_| self.stage_controls.checkpoint_count());
        let toggle_group: SharedString = "toggle-sidebar-hover".into();

        div()
            .relative()
            .h(px(TITLEBAR_HEIGHT))
            .w_full()
            .flex_none()
            .flex()
            .items_center()
            .pl(px(left_padding))
            .pr(px(12.0))
            .bg(crate::chrome::rail_background(theme))
            .on_mouse_down(MouseButton::Left, |event, window, _cx| {
                if event.click_count == 2 {
                    window.titlebar_double_click();
                } else {
                    window.start_window_move();
                }
            })
            .child(
                div()
                    .id("toggle-sidebar")
                    .group(toggle_group.clone())
                    .relative()
                    .size(px(22.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(3.0))
                    .text_color(theme.titlebar_symbol.hsla())
                    .cursor_pointer()
                    .hover(move |style| style.bg(theme.surface_2.hsla()))
                    .active(|style| style.size(px(20.68)).m(px(0.66)))
                    .on_mouse_down(MouseButton::Left, |_event, _window, cx| {
                        cx.stop_propagation();
                    })
                    .on_click(cx.listener(|this, _event, _window, cx| {
                        this.toggle_sidebar(cx);
                    }))
                    .child(
                        div()
                            .id("toggle-sidebar-icon-press")
                            .size(px(15.0))
                            .group_active(toggle_group.clone(), |style| {
                                style.size(px(14.1)).m(px(0.45))
                            })
                            .child(
                                motion_icon(
                                    "toggle-sidebar-icon",
                                    "icons/panel-left.svg",
                                    15.0,
                                    toggle_group,
                                    theme,
                                )
                                .size_full(),
                            ),
                    ),
            )
            .when_some(session, |titlebar, session| {
                let branch = session.worktree_branch.clone();
                let stage_header = div()
                    .absolute()
                    .top_0()
                    .bottom_0()
                    .right_0()
                    .min_w(px(0.0))
                    .flex()
                    .items_center()
                    .gap(px(10.0))
                    .pr(px(16.0))
                    .child(
                        div()
                            .min_w(px(0.0))
                            .truncate()
                            .text_size(px(12.5))
                            .text_color(theme.text_3.hsla())
                            .child(session.title),
                    )
                    .child(
                        div()
                            .ml_auto()
                            .flex_none()
                            .flex()
                            .items_center()
                            .gap(px(8.0))
                            .child(
                                titlebar_tool_button(
                                    "titlebar-terminal",
                                    "icons/square-terminal.svg",
                                    13.0,
                                    "Terminal",
                                    terminal_open,
                                    theme,
                                )
                                .on_mouse_down(MouseButton::Left, |_event, _window, cx| {
                                    cx.stop_propagation()
                                })
                                .on_click(cx.listener(
                                    |this, _event, _window, cx| {
                                        this.chat.update(cx, |chat, cx| {
                                            chat.toggle_terminal_from_shell(cx);
                                        });
                                    },
                                )),
                            )
                            .when_some(branch, |tools, branch| {
                                tools.child(
                                    div()
                                        .max_w(px(190.0))
                                        .min_w(px(0.0))
                                        .flex()
                                        .items_center()
                                        .gap(px(5.0))
                                        .truncate()
                                        .font_family("Geist Mono")
                                        .text_size(px(11.5))
                                        .text_color(theme.text_3.hsla())
                                        .child(motion_icon(
                                            "titlebar-branch-icon",
                                            "icons/git-branch.svg",
                                            12.0,
                                            "titlebar-branch-icon-direct-hover",
                                            theme,
                                        ))
                                        .child(div().min_w(px(0.0)).truncate().child(branch)),
                                )
                            })
                            .when(checkpoint_count > 0, |tools| {
                                let label = format!(
                                    "{checkpoint_count} checkpoint{}",
                                    if checkpoint_count == 1 { "" } else { "s" }
                                );
                                tools.child(
                                    titlebar_tool_button(
                                        "titlebar-checkpoints",
                                        "icons/history.svg",
                                        12.0,
                                        label,
                                        false,
                                        theme,
                                    )
                                    .on_mouse_down(MouseButton::Left, |_event, _window, cx| {
                                        cx.stop_propagation()
                                    })
                                    .on_click(cx.listener(
                                        |this, _event, _window, cx| this.open_rollback(cx),
                                    )),
                                )
                            }),
                    );
                let stage_header = if layout_animating {
                    stage_header
                        .with_animation(
                            ("stage-header-layout", self.sidebar_transition),
                            Animation::new(self.theme.motion_duration(RAIL_FOLD_DURATION))
                                .with_easing(web_ease_rail),
                            move |header, delta| {
                                header.left(px(
                                    stage_left_from + (stage_left_to - stage_left_from) * delta
                                ))
                            },
                        )
                        .into_any_element()
                } else {
                    stage_header.left(px(stage_left_direct)).into_any_element()
                };
                titlebar.child(stage_header)
            })
    }

    fn begin_sidebar_resize(&mut self, event: &MouseDownEvent, cx: &mut Context<Self>) {
        self.cancel_sidebar_reveal_hide();
        self.sidebar_resize_drag = Some(SidebarResizeDrag {
            start_x: event.position.x,
            start_width: self.sidebar_width,
            folded: false,
            revealed: self.sidebar_collapsed && self.sidebar_reveal.visible,
            settling: false,
        });
        cx.stop_propagation();
    }

    fn update_sidebar_resize(&mut self, event: &MouseMoveEvent, cx: &mut Context<Self>) {
        let Some(drag) = self.sidebar_resize_drag else {
            return;
        };
        if !event.dragging() {
            self.sidebar_resize_drag = None;
            return;
        }
        let raw = raw_resized_rail_width(
            drag.start_width,
            event.position.x - drag.start_x,
            crate::zoom::factor(),
        );
        if drag.revealed {
            self.cancel_sidebar_reveal_hide();
            let next = clamp_rail_width(raw);
            self.sidebar_transition_instant = true;
            if (self.sidebar_width - next).abs() >= f32::EPSILON {
                self.sidebar_width = next;
                cx.notify();
            }
            return;
        }

        let folded = rail_drag_folds(raw);
        if folded != drag.folded {
            if let Some(active_drag) = self.sidebar_resize_drag.as_mut() {
                active_drag.folded = folded;
                active_drag.settling = true;
            }
            if !folded {
                self.sidebar_width = clamp_rail_width(raw);
            }
            self.sidebar_transition_instant = false;
            self.sidebar_transition_kind = if folded {
                SidebarTransitionKind::DragFold
            } else {
                SidebarTransitionKind::DragUnfold
            };
            self.sidebar_transition = self.sidebar_transition.wrapping_add(1);
            let generation = self.sidebar_transition;
            let duration = self.theme.motion_duration(RAIL_FOLD_DURATION);
            cx.spawn(async move |view, cx| {
                cx.background_executor().timer(duration).await;
                let _ = view.update(cx, |this, _cx| {
                    if this.sidebar_transition != generation {
                        return;
                    }
                    if let Some(active_drag) = this.sidebar_resize_drag.as_mut() {
                        active_drag.settling = false;
                    }
                });
            })
            .detach();
            cx.notify();
            return;
        }
        if folded {
            return;
        }

        let next = clamp_rail_width(raw);
        self.sidebar_transition_instant = !drag.settling;
        if (self.sidebar_width - next).abs() >= f32::EPSILON {
            self.sidebar_width = next;
            cx.notify();
        }
    }

    fn finish_sidebar_resize(&mut self, release_x: Pixels, cx: &mut Context<Self>) {
        let Some(drag) = self.sidebar_resize_drag.take() else {
            return;
        };
        if drag.folded {
            self.sidebar_width = drag.start_width;
            self.sidebar_collapsed = true;
            self.sidebar_transition_instant = true;
            self.sidebar_reveal.collapsing = false;
            self.sidebar_reveal.visible = false;
            self.sidebar_reveal.retracting = false;
            self.start_sidebar_reveal_cooldown(release_x, cx);
        } else {
            self.preferences.rail_width = self.sidebar_width.round() as u16;
            self.persist_native_preferences();
        }
        cx.notify();
    }

    fn resize_sidebar_with_keyboard(&mut self, event: &KeyDownEvent, cx: &mut Context<Self>) {
        let moving_left = event.keystroke.key.eq_ignore_ascii_case("arrowleft");
        let direction = if moving_left {
            -8.0
        } else if event.keystroke.key.eq_ignore_ascii_case("arrowright") {
            8.0
        } else {
            return;
        };
        cx.stop_propagation();
        if moving_left && !self.sidebar_collapsed && self.sidebar_width <= MIN_RAIL_PREVIEW_WIDTH {
            self.collapse_sidebar(true, cx);
            return;
        }
        let next = clamp_rail_width(self.sidebar_width + direction);
        self.sidebar_width = next;
        self.sidebar_transition_instant = true;
        self.preferences.rail_width = next.round() as u16;
        self.persist_native_preferences();
        cx.notify();
    }

    pub(super) fn collapse_sidebar(&mut self, animate: bool, cx: &mut Context<Self>) {
        if self.sidebar_collapsed {
            return;
        }
        self.cancel_sidebar_reveal_hide();
        self.end_sidebar_reveal_cooldown();
        self.sidebar_collapsed = true;
        self.sidebar_transition_kind = SidebarTransitionKind::Collapse;
        self.sidebar_transition_instant = !animate;
        self.sidebar_transition = self.sidebar_transition.wrapping_add(1);
        self.sidebar_reveal.visible = false;
        self.sidebar_reveal.retracting = false;
        self.sidebar_reveal.collapsing = animate;
        self.sidebar_reveal.generation = self.sidebar_reveal.generation.wrapping_add(1);
        self.sidebar_reveal.fold_generation = self.sidebar_reveal.fold_generation.wrapping_add(1);
        let generation = self.sidebar_reveal.fold_generation;
        let duration = self.theme.motion_duration(RAIL_FOLD_DURATION);
        cx.spawn(async move |view, cx| {
            cx.background_executor().timer(duration).await;
            let _ = view.update(cx, |this, cx| {
                if this.sidebar_reveal.fold_generation == generation {
                    this.sidebar_reveal.collapsing = false;
                    cx.notify();
                }
            });
        })
        .detach();
        cx.notify();
    }

    pub(super) fn expand_sidebar(&mut self, cx: &mut Context<Self>) {
        if !self.sidebar_collapsed {
            return;
        }
        let docked_reveal = self.sidebar_reveal.visible;
        self.cancel_sidebar_reveal_hide();
        self.end_sidebar_reveal_cooldown();
        self.sidebar_collapsed = false;
        self.sidebar_transition_kind = SidebarTransitionKind::Expand;
        self.sidebar_transition_instant = docked_reveal;
        self.sidebar_transition = self.sidebar_transition.wrapping_add(1);
        self.sidebar_reveal.visible = false;
        self.sidebar_reveal.retracting = false;
        self.sidebar_reveal.collapsing = false;
        self.sidebar_reveal.generation = self.sidebar_reveal.generation.wrapping_add(1);
        self.sidebar_reveal.fold_generation = self.sidebar_reveal.fold_generation.wrapping_add(1);
        cx.notify();
    }

    fn show_sidebar_reveal(&mut self, cx: &mut Context<Self>) {
        if !self.sidebar_collapsed || self.sidebar_reveal.cooling || self.sidebar_reveal.visible {
            return;
        }
        self.cancel_sidebar_reveal_hide();
        self.sidebar_reveal.visible = true;
        self.sidebar_reveal.retracting = false;
        self.sidebar_reveal.collapsing = false;
        self.sidebar_reveal.generation = self.sidebar_reveal.generation.wrapping_add(1);
        cx.notify();
    }

    fn hide_sidebar_reveal(&mut self, cx: &mut Context<Self>) {
        self.cancel_sidebar_reveal_hide();
        if !self.sidebar_reveal.visible {
            return;
        }
        self.sidebar_reveal.visible = false;
        self.sidebar_reveal.retracting = true;
        self.sidebar_reveal.generation = self.sidebar_reveal.generation.wrapping_add(1);
        let generation = self.sidebar_reveal.generation;
        let duration = self.theme.motion_duration(RAIL_REVEAL_DURATION);
        cx.spawn(async move |view, cx| {
            cx.background_executor().timer(duration).await;
            let _ = view.update(cx, |this, cx| {
                if this.sidebar_reveal.generation == generation {
                    this.sidebar_reveal.retracting = false;
                    cx.notify();
                }
            });
        })
        .detach();
        cx.notify();
    }

    fn cancel_sidebar_reveal_hide(&mut self) {
        self.sidebar_reveal.hide_pending = false;
        self.sidebar_reveal.hide_generation = self.sidebar_reveal.hide_generation.wrapping_add(1);
    }

    fn schedule_sidebar_reveal_hide(&mut self, cx: &mut Context<Self>) {
        if self.sidebar_reveal.hide_pending || !self.sidebar_reveal.visible {
            return;
        }
        self.sidebar_reveal.hide_pending = true;
        self.sidebar_reveal.hide_generation = self.sidebar_reveal.hide_generation.wrapping_add(1);
        let generation = self.sidebar_reveal.hide_generation;
        cx.spawn(async move |view, cx| {
            cx.background_executor().timer(RAIL_REVEAL_GRACE).await;
            let _ = view.update(cx, |this, cx| {
                if this.sidebar_reveal.hide_generation != generation {
                    return;
                }
                this.sidebar_reveal.hide_pending = false;
                if this.sidebar_collapsed
                    && this.sidebar_reveal.visible
                    && this.sidebar_resize_drag.is_none()
                    && !rail_pointer_keeps_reveal(
                        this.sidebar_reveal.pointer_x,
                        this.sidebar_width,
                        false,
                    )
                {
                    this.hide_sidebar_reveal(cx);
                }
            });
        })
        .detach();
    }

    fn end_sidebar_reveal_cooldown(&mut self) {
        self.sidebar_reveal.cooling = false;
        self.sidebar_reveal.cooldown_generation =
            self.sidebar_reveal.cooldown_generation.wrapping_add(1);
    }

    fn start_sidebar_reveal_cooldown(&mut self, release_x: Pixels, cx: &mut Context<Self>) {
        self.end_sidebar_reveal_cooldown();
        self.sidebar_reveal.pointer_x = f32::from(release_x) / crate::zoom::factor();
        self.sidebar_reveal.cooling = true;
        let generation = self.sidebar_reveal.cooldown_generation;
        cx.spawn(async move |view, cx| {
            cx.background_executor().timer(RAIL_REVEAL_COOLDOWN).await;
            let _ = view.update(cx, |this, cx| {
                if this.sidebar_reveal.cooldown_generation != generation {
                    return;
                }
                this.sidebar_reveal.cooling = false;
                if this.sidebar_collapsed && rail_pointer_reveals(this.sidebar_reveal.pointer_x) {
                    this.show_sidebar_reveal(cx);
                }
            });
        })
        .detach();
    }

    fn track_sidebar_reveal(&mut self, pointer_x: Pixels, cx: &mut Context<Self>) {
        self.sidebar_reveal.pointer_x = f32::from(pointer_x) / crate::zoom::factor();
        if self.sidebar_reveal.cooling {
            return;
        }
        if !self.sidebar_collapsed {
            self.cancel_sidebar_reveal_hide();
            return;
        }
        if !self.sidebar_reveal.visible {
            if rail_pointer_reveals(self.sidebar_reveal.pointer_x) {
                self.show_sidebar_reveal(cx);
            }
            return;
        }
        if rail_pointer_keeps_reveal(
            self.sidebar_reveal.pointer_x,
            self.sidebar_width,
            self.sidebar_resize_drag.is_some(),
        ) {
            self.cancel_sidebar_reveal_hide();
        } else {
            self.schedule_sidebar_reveal_hide(cx);
        }
    }

    fn sidebar_pointer_left_window(&mut self, cx: &mut Context<Self>) {
        self.sidebar_reveal.pointer_x = f32::INFINITY;
        if self.sidebar_collapsed && self.sidebar_reveal.visible {
            self.schedule_sidebar_reveal_hide(cx);
        }
    }

    fn sidebar_resize_handle(&self, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let focused = self.sidebar_resize_focus.is_focused(window);
        div()
            .id("rail-resize")
            .absolute()
            .top_0()
            .right(px(-3.0))
            .h_full()
            .w(px(6.0))
            .group("rail-resize")
            .cursor_ew_resize()
            .track_focus(&self.sidebar_resize_focus)
            .tab_index(0)
            .on_key_down(cx.listener(|this, event, _window, cx| {
                this.resize_sidebar_with_keyboard(event, cx);
            }))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, event: &MouseDownEvent, _window, cx| {
                    this.begin_sidebar_resize(event, cx);
                }),
            )
            .child(
                div()
                    .absolute()
                    .top(px(12.0))
                    .bottom(px(12.0))
                    .right(px(2.0))
                    .w(px(2.0))
                    .rounded_full()
                    .bg(self.theme.text_3.hsla())
                    .opacity(if focused { 0.72 } else { 0.0 })
                    .group_hover("rail-resize", |line| line.opacity(0.72)),
            )
            .into_any_element()
    }

    fn settings_titlebar(&self) -> impl IntoElement {
        div()
            .relative()
            .h(px(TITLEBAR_HEIGHT))
            .w_full()
            .flex_none()
            .bg(crate::chrome::titlebar_background(self.theme))
            .border_b_1()
            .border_color(self.theme.line.hsla())
            .child(crate::chrome::top_highlight(self.theme))
            .on_mouse_down(MouseButton::Left, |event, window, _cx| {
                if event.click_count == 2 {
                    window.titlebar_double_click();
                } else {
                    window.start_window_move();
                }
            })
    }
}

impl Render for HarnessApp {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.prepare_command_palette_input(window, cx);
        self.prepare_session_search_input(window, cx);
        self.prepare_sidebar_controls_input(window, cx);
        self.prepare_auto_settle_days_input(window, cx);
        self.sync_sidebar_status_clocks();
        let sidebar_query = self.sidebar_search.read(cx).value().to_string();
        let sidebar_search_focused = self
            .sidebar_search
            .read(cx)
            .focus_handle(cx)
            .is_focused(window);
        let ordered_sidebar_ids = if self.state.sidebar_settings.mode == SidebarMode::Inbox {
            ordered_inbox_ids(
                &self.state.projects,
                self.sidebar_scope.as_deref(),
                &sidebar_query,
            )
        } else {
            Vec::new()
        };
        self.sidebar_controls
            .sync_inbox_rows(&ordered_sidebar_ids, cx);
        if self.focus_composer_pending {
            self.chat
                .update(cx, |chat, cx| chat.focus_composer(window, cx));
            self.focus_composer_pending = false;
        }
        if self.settings_open && self.settings_focus_pending {
            self.settings_focus.focus(window);
            self.settings_focus_pending = false;
        }
        let content = self.chat.clone().into_any_element();
        let sidebar_actions = self.sidebar_actions(cx);
        let account_target = self.selected_model_choice().map(|choice| AuthTarget {
            provider: choice.provider,
            agent: choice.agent_id.clone(),
        });
        let provider_name = self
            .selected_model_choice()
            .map(|choice| choice.source_name.clone())
            .unwrap_or_else(|| "TasteCode".into());
        let account_email = account_target
            .as_ref()
            .and_then(|target| self.state.accounts.get(target))
            .and_then(|account| account.email.as_deref());
        let usage_limits = self.stage_controls.usage_limits();
        let rail = sidebar(
            SidebarProps {
                theme: self.theme,
                projects: &self.state.projects,
                connection: self.state.connection,
                loaded: self.state.projects_loaded,
                fixture: self.fixture,
                mode: self.state.sidebar_settings.mode,
                selected_thread_id: self.selected_thread_id.as_deref(),
                selected_scope: self.sidebar_scope.as_deref(),
                query: &sidebar_query,
                search_focused: sidebar_search_focused,
                search_input: self.sidebar_search.clone(),
                rename_input: self.sidebar_controls.input.clone(),
                renaming_project: self.sidebar_controls.renaming_project(),
                renaming_thread: self.sidebar_controls.renaming_thread(),
                dragging_thread: self.sidebar_session_drag.as_deref(),
                scope_open: self.scope_open,
                collapsed_projects: &self.collapsed_projects,
                expanded_project_sessions: &self.expanded_project_sessions,
                status_clocks: &self.sidebar_status_clocks,
                selected_ids: &self.sidebar_controls.selected_ids,
                row_focus: &self.sidebar_controls.row_focus,
                snoozed_expanded: self.snoozed_expanded,
                settled_expanded: self.settled_expanded,
                settled_limit: self.settled_limit,
                account_menu_open: self.account_menu_open,
                provider_name: &provider_name,
                account_email,
                usage_limits,
                glass: self.preferences.sidebar_glass,
                width: self.sidebar_width,
            },
            sidebar_actions,
        );
        let resize_folded = self.sidebar_resize_drag.is_some_and(|drag| drag.folded);
        let layout_collapsed = self.sidebar_collapsed || resize_folded;
        let layout_animating = self.sidebar_transition != 0 && !self.sidebar_transition_instant;
        let rail_surface = div()
            .relative()
            .size_full()
            .overflow_hidden()
            .when(self.sidebar_collapsed, |surface| {
                surface
                    .border_t_1()
                    .border_r_1()
                    .border_b_1()
                    .border_color(self.theme.line.hsla())
                    .rounded_tr(px(10.0))
                    .rounded_br(px(10.0))
            })
            .child(sidebar_bloom(self.theme, self.preferences.sidebar_glass))
            .child(rail);
        let rail_panel = div()
            .id("rail-slot")
            .relative()
            .h_full()
            .w(px(self.sidebar_width))
            .flex_none()
            .child(rail_surface)
            .when(
                !self.sidebar_collapsed || self.sidebar_reveal.visible,
                |panel| panel.child(self.sidebar_resize_handle(window, cx)),
            );
        let (rail_slot, rail_overlay) = if layout_collapsed {
            let rail_slot = if layout_animating {
                let width = self.sidebar_width;
                div()
                    .relative()
                    .h_full()
                    .flex_none()
                    .with_animation(
                        ("rail-layout", self.sidebar_transition),
                        Animation::new(self.theme.motion_duration(RAIL_FOLD_DURATION))
                            .with_easing(web_ease_rail),
                        move |slot, delta| slot.w(px(width * (1.0 - delta))),
                    )
                    .into_any_element()
            } else {
                div()
                    .relative()
                    .h_full()
                    .w(px(0.0))
                    .flex_none()
                    .into_any_element()
            };
            let show_overlay = resize_folded
                || self.sidebar_reveal.visible
                || self.sidebar_reveal.retracting
                || self.sidebar_reveal.collapsing;
            let overlay = show_overlay.then(|| {
                let width = self.sidebar_width;
                let panel = rail_panel.absolute().top_0().bottom_0();
                if self.sidebar_reveal.visible {
                    let generation = self.sidebar_reveal.generation;
                    let theme = self.theme;
                    panel
                        .with_animation(
                            ("rail-reveal", generation),
                            Animation::new(theme.motion_duration(RAIL_REVEAL_DURATION))
                                .with_easing(web_ease_rail),
                            move |panel, delta| {
                                panel
                                    .left(px(-width * (1.0 - delta)))
                                    .shadow(sidebar_reveal_shadow(theme, delta))
                            },
                        )
                        .into_any_element()
                } else if self.sidebar_reveal.retracting {
                    let generation = self.sidebar_reveal.generation;
                    let theme = self.theme;
                    panel
                        .with_animation(
                            ("rail-reveal", generation),
                            Animation::new(theme.motion_duration(RAIL_REVEAL_DURATION))
                                .with_easing(web_ease_rail),
                            move |panel, delta| {
                                panel
                                    .left(px(-width * delta))
                                    .shadow(sidebar_reveal_shadow(theme, 1.0 - delta))
                            },
                        )
                        .into_any_element()
                } else if layout_animating {
                    panel
                        .with_animation(
                            ("rail-panel", self.sidebar_transition),
                            Animation::new(self.theme.motion_duration(RAIL_FOLD_DURATION))
                                .with_easing(web_ease_rail),
                            move |panel, delta| panel.left(px(-width * delta)),
                        )
                        .into_any_element()
                } else {
                    panel.left(px(-width)).into_any_element()
                }
            });
            (rail_slot, overlay)
        } else {
            let width = self.sidebar_width;
            let rail_panel = if layout_animating {
                rail_panel
                    .with_animation(
                        ("rail-panel", self.sidebar_transition),
                        Animation::new(self.theme.motion_duration(RAIL_FOLD_DURATION))
                            .with_easing(web_ease_rail),
                        move |panel, delta| panel.left(px(-width * (1.0 - delta))),
                    )
                    .into_any_element()
            } else {
                rail_panel.into_any_element()
            };
            let slot = if layout_animating {
                div()
                    .relative()
                    .h_full()
                    .flex_none()
                    .overflow_hidden()
                    .child(rail_panel)
                    .with_animation(
                        ("rail-layout", self.sidebar_transition),
                        Animation::new(self.theme.motion_duration(RAIL_FOLD_DURATION))
                            .with_easing(web_ease_rail),
                        move |slot, delta| slot.w(px(width * delta)),
                    )
                    .into_any_element()
            } else {
                div()
                    .relative()
                    .h_full()
                    .w(px(width))
                    .flex_none()
                    .child(rail_panel)
                    .into_any_element()
            };
            (slot, None)
        };
        let stage = div()
            .flex_1()
            .min_h(px(0.0))
            .min_w(px(0.0))
            .overflow_hidden()
            .bg(self.theme.background.hsla())
            .border_t_1()
            .border_color(self.theme.line.hsla())
            .when(!self.sidebar_collapsed, |stage| {
                stage.border_l_1().rounded_tl(px(10.0))
            })
            .child(content);
        let normal_body = div()
            .relative()
            .flex_1()
            .min_h(px(0.0))
            .w_full()
            .flex()
            .bg(crate::chrome::shell_body_background(
                self.theme,
                self.preferences.sidebar_glass,
            ))
            .child(rail_slot)
            .child(stage)
            .when_some(rail_overlay, |body, overlay| body.child(overlay))
            .into_any_element();
        let body = if self.settings_open {
            self.settings_panel(window, cx)
        } else {
            normal_body
        };
        let settings_open = self.settings_open;
        let search_open = self.session_search.open;
        let search_overlay = self.session_search_overlay(window, cx);
        let command_palette_open = self.command_palette.is_open();
        let command_palette_overlay = self.command_palette_overlay(window, cx);
        let sidebar_controls_open = self.sidebar_controls.is_open();
        let sidebar_controls_overlay = self.sidebar_controls_overlay(window, cx);
        let rollback_open = self.stage_controls.overlay_open();
        let rollback_overlay = self.rollback_overlay(cx);
        let offline_notice = self.offline_notice();
        let global_notice = self.global_notice(cx);
        let image_viewer_overlay = self.image_viewer_overlay(cx);
        let zoom_hud = self.zoom_hud(cx);
        div()
            .id("harness-root")
            .size_full()
            .relative()
            .flex()
            .flex_col()
            .overflow_hidden()
            .font_family(self.interface_font())
            .text_size(px(13.5))
            .line_height(relative(BASE_LINE_HEIGHT))
            .text_color(self.theme.text.hsla())
            .bg(crate::chrome::root_background(
                self.theme,
                self.preferences.sidebar_glass,
            ))
            .on_mouse_move(cx.listener(|this, event, _window, cx| {
                this.update_sidebar_resize(event, cx);
                this.track_sidebar_reveal(event.position.x, cx);
                this.update_mcp_transport_resize(event, cx);
            }))
            .on_hover(cx.listener(|this, hovered: &bool, _window, cx| {
                if !hovered {
                    this.sidebar_pointer_left_window(cx);
                }
            }))
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, event: &MouseUpEvent, _window, cx| {
                    this.finish_sidebar_resize(event.position.x, cx);
                    this.finish_sidebar_session_drag(cx);
                    this.finish_mcp_transport_resize(cx);
                }),
            )
            .capture_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                this.handle_sidebar_search_key(event, window, cx);
            }))
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                this.handle_global_shortcut(event, window, cx);
            }))
            .when(command_palette_open, |root| {
                root.on_key_down(cx.listener(|this, event: &KeyDownEvent, _window, cx| {
                    this.handle_command_palette_key(event, cx);
                }))
            })
            .when(
                settings_open
                    && !search_open
                    && !command_palette_open
                    && !sidebar_controls_open
                    && !rollback_open,
                |root| {
                    root.track_focus(&self.settings_focus)
                        .on_key_down(cx.listener(|this, event: &KeyDownEvent, _window, cx| {
                            if event.keystroke.key.eq_ignore_ascii_case("escape") {
                                cx.stop_propagation();
                                this.close_settings(cx);
                            }
                        }))
                },
            )
            .when(
                search_open && !command_palette_open && !sidebar_controls_open && !rollback_open,
                |root| {
                    root.on_key_down(cx.listener(|this, event: &KeyDownEvent, _window, cx| {
                        if event.keystroke.key.eq_ignore_ascii_case("escape") {
                            cx.stop_propagation();
                            this.close_session_search(cx);
                        }
                    }))
                },
            )
            .when(sidebar_controls_open && !rollback_open, |root| {
                root.on_key_down(cx.listener(|this, event: &KeyDownEvent, _window, cx| {
                    if event.keystroke.key.eq_ignore_ascii_case("escape") {
                        cx.stop_propagation();
                        this.close_sidebar_controls(cx);
                    }
                }))
            })
            .when(rollback_open, |root| {
                root.on_key_down(cx.listener(|this, event: &KeyDownEvent, _window, cx| {
                    if event.keystroke.key.eq_ignore_ascii_case("escape") {
                        cx.stop_propagation();
                        this.close_rollback(cx);
                    }
                }))
            })
            .child(if settings_open {
                self.settings_titlebar().into_any_element()
            } else {
                self.titlebar(cx).into_any_element()
            })
            .child(body)
            .when_some(zoom_hud, |root, hud| root.child(hud))
            .when_some(command_palette_overlay, |root, overlay| root.child(overlay))
            .when_some(search_overlay, |root, overlay| root.child(overlay))
            .when_some(sidebar_controls_overlay, |root, overlay| {
                root.child(overlay)
            })
            .when_some(rollback_overlay, |root, overlay| root.child(overlay))
            .when_some(image_viewer_overlay, |root, viewer| root.child(viewer))
            .when_some(offline_notice, |root, notice| root.child(notice))
            .when_some(global_notice, |root, notice| root.child(notice))
    }
}

fn theme_mode_for_appearance(appearance: WindowAppearance) -> ThemeMode {
    match appearance {
        WindowAppearance::Dark | WindowAppearance::VibrantDark => ThemeMode::Dark,
        WindowAppearance::Light | WindowAppearance::VibrantLight => ThemeMode::Light,
    }
}

fn clamp_rail_width(width: f32) -> f32 {
    width.round().clamp(MIN_RAIL_PREVIEW_WIDTH, MAX_RAIL_WIDTH)
}

fn raw_resized_rail_width(start_width: f32, pointer_delta: Pixels, scale: f32) -> f32 {
    start_width + f32::from(pointer_delta) / scale
}

fn rail_drag_folds(raw_width: f32) -> bool {
    raw_width <= COLLAPSE_RAIL_WIDTH
}

fn rail_pointer_reveals(pointer_x: f32) -> bool {
    pointer_x <= RAIL_REVEAL_EDGE_WIDTH
}

fn rail_pointer_keeps_reveal(pointer_x: f32, rail_width: f32, resizing: bool) -> bool {
    resizing || pointer_x <= rail_width + RAIL_REVEAL_KEEP_BUFFER
}

#[cfg(test)]
fn resized_rail_width(start_width: f32, pointer_delta: Pixels, scale: f32) -> f32 {
    clamp_rail_width(raw_resized_rail_width(start_width, pointer_delta, scale))
}

fn sidebar_reveal_shadow(theme: Theme, opacity: f32) -> Vec<BoxShadow> {
    let opacity = opacity.clamp(0.0, 1.0);
    match theme.mode {
        ThemeMode::Dark => vec![BoxShadow {
            color: gpui::black().opacity(0.4 * opacity),
            offset: point(px(12.0), px(0.0)),
            blur_radius: px(30.0),
            spread_radius: px(-18.0),
        }],
        ThemeMode::Light => vec![BoxShadow {
            color: rgba(0x18181b00 | (41.0 * opacity).round() as u32).into(),
            offset: point(px(12.0), px(0.0)),
            blur_radius: px(28.0),
            spread_radius: px(-20.0),
        }],
    }
}

fn reorder_project_sessions(
    sessions: &mut Vec<SessionSummary>,
    source_id: &str,
    target_id: &str,
    position: SessionDropPosition,
) -> bool {
    if source_id == target_id {
        return false;
    }
    let Some(source_index) = sessions.iter().position(|session| session.id == source_id) else {
        return false;
    };
    if !sessions.iter().any(|session| session.id == target_id) {
        return false;
    }
    let moved = sessions.remove(source_index);
    let target_index = sessions
        .iter()
        .position(|session| session.id == target_id)
        .expect("the validated target remains after removing a different source");
    let insert_index = target_index + usize::from(matches!(position, SessionDropPosition::After));
    if insert_index == source_index {
        sessions.insert(source_index, moved);
        return false;
    }
    sessions.insert(insert_index, moved);
    true
}

fn apply_project_session_order(sessions: &mut [SessionSummary], order: &[String]) -> bool {
    if sessions.len() < 2 || order.is_empty() {
        return false;
    }
    let before = sessions
        .iter()
        .map(|session| session.id.clone())
        .collect::<Vec<_>>();
    let ranks = order
        .iter()
        .enumerate()
        .map(|(index, id)| (id.as_str(), index))
        .collect::<HashMap<_, _>>();
    sessions.sort_by_key(|session| {
        ranks
            .get(session.id.as_str())
            .map_or((0, 0), |rank| (1, *rank))
    });
    let after = sessions
        .iter()
        .map(|session| session.id.clone())
        .collect::<Vec<_>>();
    after != before
}

fn titlebar_tool_button(
    id: &'static str,
    icon_path: &'static str,
    icon_size: f32,
    label: impl IntoElement,
    open: bool,
    theme: Theme,
) -> gpui::Stateful<gpui::Div> {
    let hover_group: SharedString = format!("{id}:hover").into();
    let icon_id: SharedString = format!("{id}:icon").into();
    div()
        .id(id)
        .group(hover_group.clone())
        .h(px(28.0))
        .px(px(8.0))
        .flex()
        .items_center()
        .gap(px(5.0))
        .rounded(px(3.0))
        .text_size(px(12.5))
        .text_color(if open {
            theme.text.hsla()
        } else {
            theme.text_3.hsla()
        })
        .cursor_pointer()
        .hover(move |style| style.bg(theme.surface.hsla()).text_color(theme.text.hsla()))
        .child(motion_icon(
            icon_id,
            icon_path,
            icon_size,
            hover_group,
            theme,
        ))
        .child(label)
}

fn resolve_model_choice<'a>(
    catalog: &'a [crate::client_state::ModelChoice],
    selected_key: Option<&str>,
    hidden: &HashSet<String>,
) -> Option<&'a crate::client_state::ModelChoice> {
    let selected = selected_key.and_then(|key| catalog.iter().find(|choice| choice.key == key));
    let first_visible = catalog.iter().find(|choice| !hidden.contains(&choice.key));
    if selected.is_some_and(|choice| hidden.contains(&choice.key)) {
        return first_visible.or(selected);
    }
    selected
        .or_else(|| {
            catalog
                .iter()
                .find(|choice| choice.model.is_default && !hidden.contains(&choice.key))
        })
        .or(first_visible)
        .or_else(|| catalog.iter().find(|choice| choice.model.is_default))
        .or_else(|| catalog.first())
}

fn resolve_reasoning_effort(
    current: Option<&str>,
    current_model: Option<&Model>,
    next_model: &Model,
) -> Option<String> {
    let next = &next_model.reasoning_efforts;
    if next.is_empty() {
        return None;
    }
    let default = || {
        next_model
            .default_reasoning_effort
            .as_ref()
            .filter(|effort| next.contains(effort))
            .cloned()
            .or_else(|| next.first().cloned())
    };
    let Some(current) = current else {
        return default();
    };
    let current_efforts = current_model
        .map(|model| model.reasoning_efforts.as_slice())
        .unwrap_or_default();
    let current_index = current_efforts.iter().position(|effort| effort == current);
    if current_efforts.len() > 1 && current_index == Some(current_efforts.len() - 1) {
        return next.last().cloned();
    }
    if next.iter().any(|effort| effort == current) {
        return Some(current.into());
    }
    if let Some(current_index) = current_index
        && current_efforts.len() > 1
    {
        let relative = current_index as f32 / (current_efforts.len() - 1) as f32;
        let next_index = (relative * (next.len() - 1) as f32).round() as usize;
        return next.get(next_index).cloned();
    }
    if let Some(current_rank) = reasoning_effort_rank(current) {
        return next
            .iter()
            .filter_map(|effort| {
                let rank = reasoning_effort_rank(effort)?;
                Some((effort, current_rank.abs_diff(rank), rank))
            })
            .min_by(|left, right| left.1.cmp(&right.1).then_with(|| right.2.cmp(&left.2)))
            .map(|(effort, _, _)| effort.clone())
            .or_else(default);
    }
    default()
}

fn default_reasoning_effort(model: &Model) -> Option<String> {
    model
        .default_reasoning_effort
        .as_ref()
        .filter(|effort| model.reasoning_efforts.contains(effort))
        .cloned()
        .or_else(|| model.reasoning_efforts.first().cloned())
}

fn reasoning_effort_rank(value: &str) -> Option<u8> {
    let normalized = value
        .chars()
        .filter(|character| character.is_ascii_alphabetic())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    match normalized.as_str() {
        "none" => Some(0),
        "minimal" => Some(1),
        "xlow" | "extralow" => Some(2),
        "low" => Some(3),
        "medium" => Some(4),
        "high" => Some(5),
        "xhigh" | "extrahigh" => Some(6),
        "max" | "maximum" => Some(7),
        "ultra" => Some(8),
        _ => None,
    }
}

fn title_from(text: &str) -> String {
    let clean = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = clean.chars();
    let title = chars.by_ref().take(40).collect::<String>();
    if chars.next().is_some() {
        format!("{title}…")
    } else {
        title
    }
}

fn effective_approval_mode(approval: ApprovalMode, auto_review_supported: bool) -> ApprovalMode {
    if approval == ApprovalMode::AutoReview && !auto_review_supported {
        ApprovalMode::Ask
    } else {
        approval
    }
}

fn resolve_interface_font(
    preference: FontPreference,
    available_fonts: &HashSet<String>,
) -> &'static str {
    let first_available = |candidates: &'static [(&'static str, &'static str)],
                           fallback: &'static str| {
        candidates
            .iter()
            .find_map(|(family, normalized)| {
                available_fonts.contains(*normalized).then_some(*family)
            })
            .unwrap_or(fallback)
    };

    match preference {
        FontPreference::Geist => "Geist",
        FontPreference::System => first_available(
            &[("Segoe UI Variable Text", "segoe ui variable text")],
            ".SystemUIFont",
        ),
        FontPreference::Humanist => first_available(
            &[
                ("Aptos", "aptos"),
                ("Candara", "candara"),
                ("Segoe UI", "segoe ui"),
            ],
            ".SystemUIFont",
        ),
        FontPreference::Rounded => first_available(
            &[
                ("SF Pro Rounded", "sf pro rounded"),
                ("Arial Rounded MT Bold", "arial rounded mt bold"),
            ],
            ".SystemUIFont",
        ),
        FontPreference::Serif => first_available(
            &[
                ("Charter", "charter"),
                ("Iowan Old Style", "iowan old style"),
                ("Georgia", "georgia"),
                ("Times New Roman", "times new roman"),
                ("Times", "times"),
            ],
            ".SystemUIFont",
        ),
        FontPreference::Mono => "Geist Mono",
    }
}

fn sync_component_theme(theme: Theme, interface_font: &'static str, cx: &mut App) {
    let mode = match theme.mode {
        ThemeMode::Dark => gpui_component::ThemeMode::Dark,
        ThemeMode::Light => gpui_component::ThemeMode::Light,
    };
    gpui_component::Theme::change(mode, None, cx);
    let component = gpui_component::Theme::global_mut(cx);
    component.font_family = interface_font.into();
    component.font_size = px(13.5);
    component.mono_font_family = "Geist Mono".into();
    component.mono_font_size = px(12.5);
    component.radius = px(crate::RADIUS_MD);
    component.radius_lg = px(crate::RADIUS_LG);
    component.background = theme.background.hsla();
    component.foreground = theme.response_text.hsla();
    component.border = theme.line.hsla();
    component.input = theme.line_strong.hsla();
    component.muted = theme.surface.hsla();
    component.muted_foreground = theme.text_3.hsla();
    component.popover = theme.surface_2.hsla();
    component.popover_foreground = theme.text.hsla();
    component.link = theme.response_text.hsla();
    component.link_hover = theme.text.hsla();
    component.link_active = theme.text_2.hsla();
    component.selection = theme.attention.hsla().opacity(0.3);
    component.highlight_theme = crate::theme::github_highlight_theme(theme.mode);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(id: &str) -> SessionSummary {
        SessionSummary {
            id: id.into(),
            title: id.into(),
            provider: ProviderId::Codex,
            agent: None,
            created_at: 0.0,
            running: false,
            pinned: false,
            status: Some(ThreadInboxStatus::Idle),
            unread: Some(false),
            lifecycle: Some(harness_protocol::ThreadLifecycle::Active {
                keep_active: false,
                woke_at: None,
            }),
            closed_at: None,
            worktree_branch: None,
        }
    }

    fn model(efforts: &[&str], default: Option<&str>) -> Model {
        Model {
            id: "model".into(),
            display_name: "Model".into(),
            description: None,
            is_default: true,
            reasoning_efforts: efforts.iter().map(|effort| (*effort).into()).collect(),
            default_reasoning_effort: default.map(str::to_owned),
            service_tiers: Vec::new(),
            default_service_tier: None,
        }
    }

    fn choice(id: &str, is_default: bool) -> crate::client_state::ModelChoice {
        let mut model = model(&[], None);
        model.id = id.into();
        model.display_name = id.into();
        model.is_default = is_default;
        crate::client_state::ModelChoice {
            key: format!("codex\u{1f}{id}"),
            provider: ProviderId::Codex,
            source_name: "Codex".into(),
            connection_id: None,
            agent_id: None,
            agent_name: None,
            model,
            catalog_order: (0, 0, 0),
        }
    }

    #[test]
    fn highest_effort_stays_highest_across_model_vocabularies() {
        let current = model(&["low", "high"], Some("high"));
        let next = model(&["low", "medium", "high", "max"], Some("medium"));

        assert_eq!(
            resolve_reasoning_effort(Some("high"), Some(&current), &next).as_deref(),
            Some("max")
        );
    }

    #[test]
    fn hidden_selection_uses_the_first_visible_model_but_survives_when_all_are_hidden() {
        let catalog = vec![
            choice("selected", false),
            choice("first-visible", false),
            choice("default", true),
        ];
        let selected_key = catalog[0].key.clone();
        let mut hidden = HashSet::from([selected_key.clone()]);

        assert_eq!(
            resolve_model_choice(&catalog, Some(&selected_key), &hidden)
                .unwrap()
                .model
                .id,
            "first-visible"
        );

        hidden.extend(catalog.iter().map(|choice| choice.key.clone()));
        assert_eq!(
            resolve_model_choice(&catalog, Some(&selected_key), &hidden)
                .unwrap()
                .model
                .id,
            "selected"
        );
    }

    #[test]
    fn first_prompt_title_is_whitespace_normalized_and_bounded() {
        assert_eq!(title_from("  build\nthis   please "), "build this please");
        assert_eq!(title_from(&"x".repeat(41)), format!("{}…", "x".repeat(40)));
    }

    #[test]
    fn native_window_geometry_and_glass_match_the_desktop_shell() {
        assert_eq!((APP_WIDTH, APP_HEIGHT), (1180.0, 820.0));
        assert_eq!(
            APP_BACKGROUND_APPEARANCE,
            WindowBackgroundAppearance::Blurred
        );
    }

    #[test]
    fn auto_review_preference_only_degrades_for_an_unsupported_source() {
        assert_eq!(
            effective_approval_mode(ApprovalMode::AutoReview, false),
            ApprovalMode::Ask
        );
        assert_eq!(
            effective_approval_mode(ApprovalMode::AutoReview, true),
            ApprovalMode::AutoReview
        );
        assert_eq!(
            effective_approval_mode(ApprovalMode::Full, false),
            ApprovalMode::Full
        );
    }

    #[test]
    fn sidebar_resize_uses_the_web_preview_limits() {
        assert_eq!(clamp_rail_width(100.0), MIN_RAIL_PREVIEW_WIDTH);
        assert_eq!(clamp_rail_width(248.4), 248.0);
        assert_eq!(clamp_rail_width(248.6), 249.0);
        assert_eq!(clamp_rail_width(500.0), MAX_RAIL_WIDTH);
        assert_eq!(resized_rail_width(248.0, gpui::px(40.0), 2.0), 268.0);
        assert_eq!(COLLAPSE_RAIL_WIDTH, 120.0);
        assert!(rail_drag_folds(raw_resized_rail_width(
            248.0,
            gpui::px(-256.0),
            2.0
        )));
        assert!(!rail_drag_folds(COLLAPSE_RAIL_WIDTH + 1.0));
    }

    #[test]
    fn sidebar_reveal_uses_the_web_edge_and_keep_buffer() {
        assert!(rail_pointer_reveals(0.0));
        assert!(rail_pointer_reveals(RAIL_REVEAL_EDGE_WIDTH));
        assert!(!rail_pointer_reveals(RAIL_REVEAL_EDGE_WIDTH + 1.0));

        assert!(rail_pointer_keeps_reveal(
            248.0 + RAIL_REVEAL_KEEP_BUFFER,
            248.0,
            false
        ));
        assert!(!rail_pointer_keeps_reveal(
            248.0 + RAIL_REVEAL_KEEP_BUFFER + 1.0,
            248.0,
            false
        ));
        assert!(rail_pointer_keeps_reveal(f32::INFINITY, 248.0, true));
    }

    #[test]
    fn classic_sidebar_reorders_before_and_after_without_false_changes() {
        let mut sessions = vec![session("a"), session("b"), session("c")];

        assert!(reorder_project_sessions(
            &mut sessions,
            "a",
            "b",
            SessionDropPosition::After,
        ));
        assert_eq!(
            sessions
                .iter()
                .map(|session| session.id.as_str())
                .collect::<Vec<_>>(),
            ["b", "a", "c"]
        );
        assert!(!reorder_project_sessions(
            &mut sessions,
            "a",
            "b",
            SessionDropPosition::After,
        ));
        assert!(reorder_project_sessions(
            &mut sessions,
            "c",
            "b",
            SessionDropPosition::Before,
        ));
        assert_eq!(
            sessions
                .iter()
                .map(|session| session.id.as_str())
                .collect::<Vec<_>>(),
            ["c", "b", "a"]
        );
        assert!(!reorder_project_sessions(
            &mut sessions,
            "missing",
            "b",
            SessionDropPosition::Before,
        ));
    }

    #[test]
    fn saved_sidebar_order_keeps_new_sessions_ahead_of_known_rows() {
        let mut sessions = vec![session("a"), session("new"), session("b")];
        let order = vec!["b".into(), "a".into()];

        assert!(apply_project_session_order(&mut sessions, &order));
        assert_eq!(
            sessions
                .iter()
                .map(|session| session.id.as_str())
                .collect::<Vec<_>>(),
            ["new", "b", "a"]
        );
        assert!(!apply_project_session_order(&mut sessions, &order));
    }

    #[test]
    fn interface_fonts_follow_the_web_fallback_order() {
        let fonts = HashSet::from([
            "aptos".to_owned(),
            "candara".to_owned(),
            "segoe ui".to_owned(),
            "sf pro rounded".to_owned(),
            "arial rounded mt bold".to_owned(),
            "georgia".to_owned(),
            "times new roman".to_owned(),
        ]);

        assert_eq!(
            resolve_interface_font(FontPreference::Humanist, &fonts),
            "Aptos"
        );
        assert_eq!(
            resolve_interface_font(FontPreference::Rounded, &fonts),
            "SF Pro Rounded"
        );
        assert_eq!(
            resolve_interface_font(FontPreference::Serif, &fonts),
            "Georgia"
        );
        assert_eq!(
            resolve_interface_font(FontPreference::Mono, &HashSet::new()),
            "Geist Mono"
        );
    }

    #[test]
    fn unavailable_interface_fonts_fall_back_without_inventing_a_family() {
        let fonts = HashSet::from(["avenir next".to_owned()]);

        assert_eq!(
            resolve_interface_font(FontPreference::Humanist, &fonts),
            ".SystemUIFont"
        );
        assert_eq!(
            resolve_interface_font(FontPreference::Rounded, &fonts),
            ".SystemUIFont"
        );
        assert_eq!(
            resolve_interface_font(FontPreference::Serif, &fonts),
            ".SystemUIFont"
        );
    }

    #[test]
    fn windows_tray_icon_matches_the_electron_mark() {
        let icon = tray_icon_rgba();
        let pixel = |x: usize, y: usize| &icon[(y * 20 + x) * 4..(y * 20 + x + 1) * 4];

        assert_eq!(icon.len(), 20 * 20 * 4);
        assert_eq!(pixel(0, 0), [0, 0, 0, 0]);
        assert_eq!(pixel(10, 2), [0x11, 0x11, 0x13, 0xff]);
        assert_eq!(pixel(10, 10), [0xff, 0xff, 0xff, 0xff]);
    }
}
