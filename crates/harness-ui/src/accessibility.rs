#[cfg(target_os = "macos")]
pub(crate) fn prefers_reduced_motion() -> bool {
    objc2_app_kit::NSWorkspace::sharedWorkspace().accessibilityDisplayShouldReduceMotion()
}

#[cfg(target_os = "windows")]
pub(crate) fn prefers_reduced_motion() -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SPI_GETCLIENTAREAANIMATION, SystemParametersInfoW,
    };

    let mut animations_enabled = 1i32;
    // SAFETY: SPI_GETCLIENTAREAANIMATION writes a BOOL into the valid pointer
    // supplied here and does not retain it after the call.
    let read = unsafe {
        SystemParametersInfoW(
            SPI_GETCLIENTAREAANIMATION,
            0,
            (&mut animations_enabled as *mut i32).cast(),
            0,
        )
    };
    read != 0 && animations_enabled == 0
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub(crate) fn prefers_reduced_motion() -> bool {
    false
}
