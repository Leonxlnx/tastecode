mod accessibility;
mod app;
mod assets;
mod chat;
mod chrome;
mod client_state;
mod downloads;
mod model_selection;
mod motion_icon;
mod preferences;
mod preview_capture;
mod provider_icon;
mod shortcuts;
mod sidebar;
mod theme;
mod tracked_text;
mod zoom;

pub use app::{ShellCommand, run, run_with_endpoint, run_with_endpoint_and_shell, run_with_shell};
pub use harness_client::Endpoint;
pub use theme::{
    Accent, Backdrop, CHAT_WIDTH, ColorToken, Motion, RADIUS_2XL, RADIUS_LG, RADIUS_MD, RADIUS_SM,
    RADIUS_XL, RAIL_WIDTH, TITLEBAR_HEIGHT, Theme, ThemeMode,
};
