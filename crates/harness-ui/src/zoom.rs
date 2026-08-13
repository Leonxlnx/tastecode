use gpui::Pixels;
use std::sync::atomic::{AtomicU32, Ordering};

const DEFAULT_ZOOM_BITS: u32 = 1.0_f32.to_bits();
static UI_ZOOM_BITS: AtomicU32 = AtomicU32::new(DEFAULT_ZOOM_BITS);

pub(crate) fn factor() -> f32 {
    f32::from_bits(UI_ZOOM_BITS.load(Ordering::Relaxed))
}

pub(crate) fn set_factor(factor: f32) {
    UI_ZOOM_BITS.store(factor.to_bits(), Ordering::Relaxed);
}

/// Converts a design pixel into a GPUI logical pixel at the current app zoom.
///
/// GPUI's built-in rem size only scales rem-based component defaults. Harness
/// deliberately uses exact pixel values from the web oracle, so those values
/// pass through this function to keep layout, text, hitboxes, and effects on
/// the same zoom factor without adding a transformed compositor layer.
pub(crate) fn px(value: f32) -> Pixels {
    gpui::px(value * factor())
}
