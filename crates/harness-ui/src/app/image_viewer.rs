use super::HarnessApp;
use crate::downloads::save_bytes;
use crate::motion_icon::motion_icon;
use crate::zoom::px;
use gpui::{
    Animation, AnimationExt, AnyElement, BoxShadow, Context, FontFeatures, Image, MouseButton,
    ObjectFit, ScrollHandle, SharedString, StyledImage, Window, div, img, point, prelude::*,
    relative, rgba,
};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

const MIN_ZOOM: f32 = 0.5;
const MAX_ZOOM: f32 = 3.0;
const ZOOM_STEP: f32 = 0.25;

pub(super) struct ImageViewerState {
    image: Arc<Image>,
    path: Option<PathBuf>,
    name: String,
    zoom: f32,
    previous_zoom: f32,
    zoom_transition: u64,
    scroll: ScrollHandle,
}

impl HarnessApp {
    pub(super) fn open_image_viewer(
        &mut self,
        image: Arc<Image>,
        path: Option<String>,
        name: String,
        cx: &mut Context<Self>,
    ) {
        self.image_viewer = Some(ImageViewerState {
            image,
            path: path.map(PathBuf::from),
            name,
            zoom: 1.0,
            previous_zoom: 1.0,
            zoom_transition: 0,
            scroll: ScrollHandle::new(),
        });
        cx.notify();
    }

    pub(super) fn close_image_viewer(&mut self, cx: &mut Context<Self>) {
        if self.image_viewer.take().is_some() {
            cx.notify();
        }
    }

    fn change_image_zoom(&mut self, delta: f32, cx: &mut Context<Self>) {
        let Some(viewer) = &mut self.image_viewer else {
            return;
        };
        let next = (viewer.zoom + delta).clamp(MIN_ZOOM, MAX_ZOOM);
        if (next - viewer.zoom).abs() < f32::EPSILON {
            return;
        }

        let previous = viewer.zoom;
        let factor = next / previous;
        let offset = viewer.scroll.offset();
        let bounds = viewer.scroll.bounds().size;
        viewer.scroll.set_offset(point(
            (offset.x - bounds.width / 2.0) * factor + bounds.width / 2.0,
            (offset.y - bounds.height / 2.0) * factor + bounds.height / 2.0,
        ));
        viewer.previous_zoom = previous;
        viewer.zoom = next;
        viewer.zoom_transition = viewer.zoom_transition.wrapping_add(1);
        cx.notify();
    }

    fn download_viewed_image(&mut self, cx: &mut Context<Self>) {
        let Some(viewer) = &self.image_viewer else {
            return;
        };
        let source = viewer.path.clone();
        let bytes = viewer.image.bytes().to_vec();
        let name = viewer.name.clone();
        let directory = dirs::download_dir()
            .or_else(|| {
                source
                    .as_deref()
                    .and_then(|source| source.parent().map(ToOwned::to_owned))
            })
            .unwrap_or_else(std::env::temp_dir);
        let save =
            cx.background_spawn(async move { save_bytes(&directory, &name, "image", &bytes) });
        cx.spawn(async move |view, cx| {
            if let Err(error) = save.await {
                let _ = view.update(cx, |this, cx| {
                    this.state.notice = Some(format!("Could not save that image: {error}"));
                    cx.notify();
                });
            }
        })
        .detach();
    }

    pub(super) fn image_viewer_overlay(&self, cx: &Context<Self>) -> Option<AnyElement> {
        let viewer = self.image_viewer.as_ref()?;
        let zoom = viewer.zoom;
        let previous_zoom = viewer.previous_zoom;
        let transition = viewer.zoom_transition;
        let image = viewer.image.clone();
        let image_id = image.id();
        let zoom_out_disabled = zoom <= MIN_ZOOM;
        let zoom_in_disabled = zoom >= MAX_ZOOM;
        let mut zoom_font = gpui::font(self.interface_font());
        zoom_font.features = FontFeatures(Arc::new(vec![("tnum".into(), 1)]));
        let frame = div()
            .flex_none()
            .m_auto()
            .flex()
            .items_center()
            .justify_center()
            .child(
                img(image)
                    .id("image-viewer-image")
                    .max_w_full()
                    .max_h_full()
                    .rounded(px(3.0))
                    .shadow(vec![BoxShadow {
                        color: rgba(0x0000006b).into(),
                        offset: point(px(0.0), px(24.0)),
                        blur_radius: px(72.0),
                        spread_radius: px(0.0),
                    }])
                    .object_fit(ObjectFit::Contain)
                    .on_mouse_down(MouseButton::Left, |_event, _window, cx| {
                        cx.stop_propagation();
                    }),
            );
        let frame = if transition == 0 {
            frame.w(relative(zoom)).h(relative(zoom)).into_any_element()
        } else {
            frame
                .with_animation(
                    ("image-viewer-zoom", transition),
                    Animation::new(self.theme.motion_duration(Duration::from_millis(180)))
                        .with_easing(crate::theme::web_ease_out),
                    move |frame, delta| {
                        let scale = previous_zoom + (zoom - previous_zoom) * delta;
                        frame.w(relative(scale)).h(relative(scale))
                    },
                )
                .into_any_element()
        };

        Some(
            div()
                .id("image-viewer")
                .occlude()
                .absolute()
                .inset(px(0.0))
                .overflow_hidden()
                .bg(rgba(0x080808f0))
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(|this, _event, _window, cx| this.close_image_viewer(cx)),
                )
                .child(
                    div()
                        .absolute()
                        .top(px(18.0))
                        .right(px(18.0))
                        .flex()
                        .gap(px(8.0))
                        .on_mouse_down(MouseButton::Left, |_event, _window, cx| {
                            cx.stop_propagation();
                        })
                        .child(image_viewer_action(
                            "image-viewer-download",
                            "icons/download.svg",
                            18.0,
                            false,
                            self.theme,
                            cx.listener(|this, _event, _window, cx| {
                                this.download_viewed_image(cx);
                            }),
                        ))
                        .child(image_viewer_action(
                            "image-viewer-close",
                            "icons/x.svg",
                            19.0,
                            false,
                            self.theme,
                            cx.listener(|this, _event, _window, cx| {
                                this.close_image_viewer(cx);
                            }),
                        )),
                )
                .child(
                    div()
                        .id("image-viewer-viewport")
                        .absolute()
                        .top(px(76.0))
                        .right(px(24.0))
                        .bottom(px(88.0))
                        .left(px(24.0))
                        .flex()
                        .overflow_scroll()
                        .track_scroll(&viewer.scroll)
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(move |this, _event, _window, cx| {
                                cx.stop_propagation();
                                if zoom <= 1.0 {
                                    this.close_image_viewer(cx);
                                }
                            }),
                        )
                        .child(frame),
                )
                .child(
                    div()
                        .id("image-viewer-zoom")
                        .absolute()
                        .bottom(px(22.0))
                        .left(relative(0.5))
                        .ml(px(-72.0))
                        .w(px(144.0))
                        .h(px(46.0))
                        .flex()
                        .items_center()
                        .px(px(3.0))
                        .rounded_full()
                        .border_1()
                        .border_color(rgba(0xffffff85))
                        .bg(rgba(0xf8f8f8f5))
                        .shadow(vec![BoxShadow {
                            color: rgba(0x00000052).into(),
                            offset: point(px(0.0), px(12.0)),
                            blur_radius: px(36.0),
                            spread_radius: px(0.0),
                        }])
                        .text_color(gpui::rgb(0x171717))
                        .on_mouse_down(MouseButton::Left, |_event, _window, cx| {
                            cx.stop_propagation();
                        })
                        .child(image_zoom_button(
                            "image-zoom-out",
                            "icons/minus.svg",
                            zoom_out_disabled,
                            self.theme,
                            cx.listener(|this, _event, _window, cx| {
                                this.change_image_zoom(-ZOOM_STEP, cx);
                            }),
                        ))
                        .child(
                            div()
                                .min_w(px(62.0))
                                .flex()
                                .justify_center()
                                .font(zoom_font)
                                .text_size(px(12.5))
                                .child(format!("{}%", (zoom * 100.0).round() as u16)),
                        )
                        .child(image_zoom_button(
                            "image-zoom-in",
                            "icons/plus.svg",
                            zoom_in_disabled,
                            self.theme,
                            cx.listener(|this, _event, _window, cx| {
                                this.change_image_zoom(ZOOM_STEP, cx);
                            }),
                        )),
                )
                .with_animation(
                    ("image-viewer-in", image_id),
                    Animation::new(self.theme.motion_duration(Duration::from_millis(180)))
                        .with_easing(crate::theme::web_ease_out),
                    |viewer, delta| viewer.opacity(delta),
                )
                .into_any_element(),
        )
    }
}

fn image_viewer_action(
    id: &'static str,
    icon: &'static str,
    icon_size: f32,
    disabled: bool,
    theme: crate::theme::Theme,
    on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut gpui::App) + 'static,
) -> AnyElement {
    let group: SharedString = format!("{id}:icon-hover").into();
    let icon_id: SharedString = format!("{id}:icon").into();
    let icon_press_id: SharedString = format!("{id}:icon-press").into();
    div()
        .id(id)
        .group(group.clone())
        .size(px(44.0))
        .flex()
        .items_center()
        .justify_center()
        .rounded_full()
        .border_1()
        .border_color(rgba(0xffffff85))
        .bg(rgba(0xf8f8f8f5))
        .text_color(gpui::rgb(0x171717))
        .opacity(if disabled { 0.4 } else { 1.0 })
        .when(!disabled, |button| {
            button
                .cursor_pointer()
                .hover(|style| style.bg(gpui::white()))
                .active(|style| style.size(px(41.36)).m(px(1.32)))
                .on_click(on_click)
        })
        .child(
            div()
                .id(icon_press_id)
                .size(px(icon_size))
                .when(!disabled, |icon_wrapper| {
                    icon_wrapper.group_active(group.clone(), move |style| {
                        style.size(px(icon_size * 0.94)).m(px(icon_size * 0.03))
                    })
                })
                .child(motion_icon(icon_id, icon, icon_size, group, theme).size_full()),
        )
        .into_any_element()
}

fn image_zoom_button(
    id: &'static str,
    icon: &'static str,
    disabled: bool,
    theme: crate::theme::Theme,
    on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut gpui::App) + 'static,
) -> AnyElement {
    let group: SharedString = format!("{id}:icon-hover").into();
    div()
        .id(id)
        .group(group.clone())
        .size(px(38.0))
        .flex()
        .items_center()
        .justify_center()
        .rounded_full()
        .opacity(if disabled { 0.28 } else { 1.0 })
        .when(!disabled, |button| {
            button
                .cursor_pointer()
                .hover(|style| style.bg(rgba(0x00000012)))
                .on_click(on_click)
        })
        .child(motion_icon(
            SharedString::from(format!("{id}:icon")),
            icon,
            16.0,
            group,
            theme,
        ))
        .into_any_element()
}
