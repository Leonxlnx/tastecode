use super::{HarnessApp, sync_component_theme};
use crate::chrome;
use crate::motion_icon::motion_icon;
use crate::theme::{TITLEBAR_HEIGHT, Theme};
use crate::zoom;
use crate::zoom::px;
use gpui::{AnyElement, Context, KeyDownEvent, SharedString, Window, div, prelude::*, relative};
use std::time::Duration;

const MIN_ZOOM: f32 = 0.5;
const MAX_ZOOM: f32 = 2.0;
const ZOOM_STEP: f32 = 0.1;
const HIDE_DELAY: Duration = Duration::from_secs(3);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum AppZoomAction {
    In,
    Out,
    Reset,
}

pub(super) struct AppZoomState {
    factor: f32,
    visible: bool,
    hovered: bool,
    hide_generation: u64,
}

impl Default for AppZoomState {
    fn default() -> Self {
        Self {
            factor: 1.0,
            visible: false,
            hovered: false,
            hide_generation: 0,
        }
    }
}

impl HarnessApp {
    pub(super) fn handle_zoom_shortcut(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let modifiers = event.keystroke.modifiers;
        if (!modifiers.platform && !modifiers.control) || modifiers.alt {
            return false;
        }
        let action = match event.keystroke.key.to_ascii_lowercase().as_str() {
            "+" | "=" | "add" => AppZoomAction::In,
            "-" | "subtract" => AppZoomAction::Out,
            "0" => AppZoomAction::Reset,
            _ => return false,
        };
        cx.stop_propagation();
        self.apply_app_zoom(action, window, cx);
        true
    }

    fn apply_app_zoom(
        &mut self,
        action: AppZoomAction,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let previous = self.app_zoom.factor;
        let next = next_zoom_factor(previous, action);
        self.app_zoom.factor = next;
        zoom::set_factor(next);
        sync_component_theme(self.theme, self.interface_font(), cx);
        window.set_rem_size(gpui::px(13.5 * next));
        self.chat.update(cx, |chat, cx| {
            chat.app_zoom_changed(previous, next, cx);
        });
        self.show_zoom_hud(cx);
        cx.notify();
    }

    fn show_zoom_hud(&mut self, cx: &mut Context<Self>) {
        self.app_zoom.visible = true;
        self.schedule_zoom_hud_hide(cx);
    }

    fn schedule_zoom_hud_hide(&mut self, cx: &mut Context<Self>) {
        self.app_zoom.hide_generation = self.app_zoom.hide_generation.wrapping_add(1);
        let generation = self.app_zoom.hide_generation;
        cx.spawn(async move |view, cx| {
            cx.background_executor().timer(HIDE_DELAY).await;
            let _ = view.update(cx, |this, cx| {
                if this.app_zoom.hide_generation == generation && !this.app_zoom.hovered {
                    this.app_zoom.visible = false;
                    cx.notify();
                }
            });
        })
        .detach();
    }

    fn zoom_hud_hover_changed(&mut self, hovered: bool, cx: &mut Context<Self>) {
        self.app_zoom.hovered = hovered;
        self.app_zoom.hide_generation = self.app_zoom.hide_generation.wrapping_add(1);
        if !hovered {
            self.schedule_zoom_hud_hide(cx);
        }
    }

    pub(super) fn zoom_hud(&self, cx: &Context<Self>) -> Option<AnyElement> {
        if !self.app_zoom.visible {
            return None;
        }
        let theme = self.theme;
        let factor = self.app_zoom.factor;
        let reset_disabled = (factor - 1.0).abs() < f32::EPSILON;
        Some(
            div()
                .id("zoom-hud")
                .absolute()
                .top(px(TITLEBAR_HEIGHT + 10.0))
                .right(px(12.0))
                .h(px(40.0))
                .flex()
                .items_center()
                .gap(px(2.0))
                .p(px(4.0))
                .rounded(px(8.0))
                .border_1()
                .border_color(theme.line_strong.hsla())
                .bg(theme.surface_2.hsla())
                .text_color(theme.text_2.hsla())
                .shadow(chrome::flyout_shadows(theme))
                .on_hover(cx.listener(|this, hovered, _window, cx| {
                    this.zoom_hud_hover_changed(*hovered, cx);
                }))
                .child(zoom_hud_icon_button(
                    "zoom-hud-out",
                    "icons/minus.svg",
                    14.0,
                    false,
                    theme,
                    cx.listener(|this, _event, window, cx| {
                        this.apply_app_zoom(AppZoomAction::Out, window, cx);
                    }),
                ))
                .child(
                    div()
                        .min_w(px(48.0))
                        .flex()
                        .justify_center()
                        .text_size(px(12.5))
                        .text_color(theme.text.hsla())
                        .child(format!("{}%", (factor * 100.0).round() as u16)),
                )
                .child(zoom_hud_icon_button(
                    "zoom-hud-in",
                    "icons/plus.svg",
                    14.0,
                    false,
                    theme,
                    cx.listener(|this, _event, window, cx| {
                        this.apply_app_zoom(AppZoomAction::In, window, cx);
                    }),
                ))
                .child(
                    div()
                        .w(px(1.0))
                        .h(px(18.0))
                        .mx(px(2.0))
                        .bg(theme.line_strong.hsla()),
                )
                .child(zoom_hud_reset_button(
                    reset_disabled,
                    theme,
                    cx.listener(|this, _event, window, cx| {
                        this.apply_app_zoom(AppZoomAction::Reset, window, cx);
                    }),
                ))
                .into_any_element(),
        )
    }
}

fn zoom_hud_reset_button(
    disabled: bool,
    theme: Theme,
    on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut gpui::App) + 'static,
) -> AnyElement {
    let group: SharedString = "zoom-hud-reset-hover".into();
    let sizing = div()
        .min_w(px(30.0))
        .h(px(30.0))
        .flex()
        .items_center()
        .justify_center()
        .gap(px(6.0))
        .px(px(9.0))
        .text_size(px(12.5))
        .invisible()
        .child(div().size(px(13.0)).flex_none())
        .child("Reset");
    let visual = div()
        .id("zoom-hud-reset-visual")
        .absolute()
        .inset_0()
        .flex()
        .items_center()
        .justify_center()
        .gap(px(6.0))
        .px(px(9.0))
        .rounded(px(5.0))
        .text_size(px(12.5))
        .when(!disabled, |visual| {
            visual
                .group_hover(group.clone(), move |style| {
                    style
                        .bg(theme.surface_3.hsla())
                        .text_color(theme.text.hsla())
                })
                .group_active(group.clone(), |style| {
                    style
                        .top(px(0.6))
                        .right(relative(0.02))
                        .bottom(px(0.6))
                        .left(relative(0.02))
                        .gap(px(5.76))
                        .px(px(8.64))
                        .rounded(px(4.8))
                        .text_size(px(12.0))
                })
        })
        .child(
            div()
                .id("zoom-hud-reset-icon-press")
                .size(px(13.0))
                .flex_none()
                .when(!disabled, |icon| {
                    icon.group_active(group.clone(), |style| style.size(px(12.48)).m(px(0.26)))
                })
                .child(
                    motion_icon(
                        "zoom-hud-reset-icon",
                        "icons/rotate-ccw.svg",
                        13.0,
                        group.clone(),
                        theme,
                    )
                    .size_full(),
                ),
        )
        .child("Reset");
    div()
        .id("zoom-hud-reset")
        .group(group)
        .relative()
        .h(px(30.0))
        .flex_none()
        .opacity(if disabled { 0.4 } else { 1.0 })
        .when(!disabled, |button| {
            button.cursor_pointer().on_click(on_click)
        })
        .child(sizing)
        .child(visual)
        .into_any_element()
}

fn zoom_hud_icon_button(
    id: &'static str,
    icon: &'static str,
    icon_size: f32,
    disabled: bool,
    theme: Theme,
    on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut gpui::App) + 'static,
) -> AnyElement {
    let group: SharedString = format!("{id}:hover").into();
    let icon_id: SharedString = format!("{id}:icon").into();
    let icon_press_id: SharedString = format!("{id}:icon-press").into();
    div()
        .id(id)
        .group(group.clone())
        .size(px(30.0))
        .flex()
        .items_center()
        .justify_center()
        .px(px(8.0))
        .rounded(px(5.0))
        .opacity(if disabled { 0.4 } else { 1.0 })
        .when(!disabled, |button| {
            button
                .cursor_pointer()
                .hover(move |style| {
                    style
                        .bg(theme.surface_3.hsla())
                        .text_color(theme.text.hsla())
                })
                .active(|style| style.size(px(28.8)).m(px(0.6)))
                .on_click(on_click)
        })
        .child(
            div()
                .id(icon_press_id)
                .size(px(icon_size))
                .when(!disabled, |icon_wrapper| {
                    icon_wrapper.group_active(group.clone(), move |style| {
                        style.size(px(icon_size * 0.96)).m(px(icon_size * 0.02))
                    })
                })
                .child(motion_icon(icon_id, icon, icon_size, group, theme).size_full()),
        )
        .into_any_element()
}

fn next_zoom_factor(current: f32, action: AppZoomAction) -> f32 {
    if action == AppZoomAction::Reset {
        return 1.0;
    }
    let delta = if action == AppZoomAction::In {
        ZOOM_STEP
    } else {
        -ZOOM_STEP
    };
    (((current + delta) * 10.0).round() / 10.0).clamp(MIN_ZOOM, MAX_ZOOM)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zoom_steps_and_clamps_match_the_electron_contract() {
        assert_eq!(next_zoom_factor(1.0, AppZoomAction::In), 1.1);
        assert_eq!(next_zoom_factor(1.0, AppZoomAction::Out), 0.9);
        assert_eq!(next_zoom_factor(1.7, AppZoomAction::Reset), 1.0);
        assert_eq!(next_zoom_factor(2.0, AppZoomAction::In), 2.0);
        assert_eq!(next_zoom_factor(0.5, AppZoomAction::Out), 0.5);
    }
}
