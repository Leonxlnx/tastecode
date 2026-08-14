use anyhow::Result;
use gpui::{App, AssetSource, SharedString};
use std::borrow::Cow;

pub struct HarnessAssets;

macro_rules! font_face {
    ($family:literal, $weight:literal, $path:literal) => {
        ($family, $weight, include_bytes!($path))
    };
}

const FONT_FACES: &[(&str, u16, &[u8])] = &[
    font_face!("Geist", 400, "../assets/fonts/Geist-400.ttf"),
    font_face!("Geist", 450, "../assets/fonts/Geist-450.ttf"),
    font_face!("Geist", 500, "../assets/fonts/Geist-500.ttf"),
    font_face!("Geist", 520, "../assets/fonts/Geist-520.ttf"),
    font_face!("Geist", 530, "../assets/fonts/Geist-530.ttf"),
    font_face!("Geist", 540, "../assets/fonts/Geist-540.ttf"),
    font_face!("Geist", 550, "../assets/fonts/Geist-550.ttf"),
    font_face!("Geist", 560, "../assets/fonts/Geist-560.ttf"),
    font_face!("Geist", 570, "../assets/fonts/Geist-570.ttf"),
    font_face!("Geist", 580, "../assets/fonts/Geist-580.ttf"),
    font_face!("Geist", 600, "../assets/fonts/Geist-600.ttf"),
    font_face!("Geist", 680, "../assets/fonts/Geist-680.ttf"),
    font_face!("Geist", 700, "../assets/fonts/Geist-700.ttf"),
    font_face!("Geist Mono", 400, "../assets/fonts/GeistMono-400.ttf"),
    font_face!("Geist Mono", 450, "../assets/fonts/GeistMono-450.ttf"),
    font_face!("Geist Mono", 500, "../assets/fonts/GeistMono-500.ttf"),
    font_face!("Geist Mono", 520, "../assets/fonts/GeistMono-520.ttf"),
    font_face!("Geist Mono", 530, "../assets/fonts/GeistMono-530.ttf"),
    font_face!("Geist Mono", 540, "../assets/fonts/GeistMono-540.ttf"),
    font_face!("Geist Mono", 550, "../assets/fonts/GeistMono-550.ttf"),
    font_face!("Geist Mono", 560, "../assets/fonts/GeistMono-560.ttf"),
    font_face!("Geist Mono", 570, "../assets/fonts/GeistMono-570.ttf"),
    font_face!("Geist Mono", 580, "../assets/fonts/GeistMono-580.ttf"),
    font_face!("Geist Mono", 600, "../assets/fonts/GeistMono-600.ttf"),
    font_face!("Geist Mono", 680, "../assets/fonts/GeistMono-680.ttf"),
    font_face!("Geist Mono", 700, "../assets/fonts/GeistMono-700.ttf"),
];

impl AssetSource for HarnessAssets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        let bytes: Option<&'static [u8]> = match path {
            "icons/panel-left.svg" => Some(include_bytes!("../assets/icons/panel-left.svg")),
            "icons/plus.svg" => Some(include_bytes!("../assets/icons/plus.svg")),
            "icons/folder-pen.svg" => Some(include_bytes!("../assets/icons/folder-pen.svg")),
            "icons/folder-plus.svg" => Some(include_bytes!("../assets/icons/folder-plus.svg")),
            "icons/search.svg" => Some(include_bytes!("../assets/icons/search.svg")),
            "icons/settings.svg" => Some(include_bytes!("../assets/icons/settings.svg")),
            "icons/inbox.svg" => Some(include_bytes!("../assets/icons/inbox.svg")),
            "icons/chevron-right.svg" => Some(include_bytes!("../assets/icons/chevron-right.svg")),
            "icons/chevron-down.svg" => Some(include_bytes!("../assets/icons/chevron-down.svg")),
            "icons/chevron-up.svg" => Some(include_bytes!("../assets/icons/chevron-up.svg")),
            "icons/check.svg" => Some(include_bytes!("../assets/icons/check.svg")),
            "icons/check-check.svg" => Some(include_bytes!("../assets/icons/check-check.svg")),
            "icons/clock-3.svg" => Some(include_bytes!("../assets/icons/clock-3.svg")),
            "icons/ellipsis.svg" => Some(include_bytes!("../assets/icons/ellipsis.svg")),
            "icons/shield-question.svg" => {
                Some(include_bytes!("../assets/icons/shield-question.svg"))
            }
            "icons/shield-check.svg" => Some(include_bytes!("../assets/icons/shield-check.svg")),
            "icons/shield-alert.svg" => Some(include_bytes!("../assets/icons/shield-alert.svg")),
            "icons/scan-eye.svg" => Some(include_bytes!("../assets/icons/scan-eye.svg")),
            "icons/lock-open.svg" => Some(include_bytes!("../assets/icons/lock-open.svg")),
            "icons/lock-keyhole.svg" => Some(include_bytes!("../assets/icons/lock-keyhole.svg")),
            "icons/zap.svg" => Some(include_bytes!("../assets/icons/zap.svg")),
            "icons/zap-filled.svg" => Some(include_bytes!("../assets/icons/zap-filled.svg")),
            "icons/palette.svg" => Some(include_bytes!("../assets/icons/palette.svg")),
            "icons/mic.svg" => Some(include_bytes!("../assets/icons/mic.svg")),
            "icons/openai.svg" => Some(include_bytes!("../assets/icons/openai.svg")),
            "icons/anthropic.svg" => Some(include_bytes!("../assets/icons/anthropic.svg")),
            "icons/grok.svg" => Some(include_bytes!("../assets/icons/grok.svg")),
            "icons/cursor.svg" => Some(include_bytes!("../assets/icons/cursor.svg")),
            "icons/opencode.svg" => Some(include_bytes!("../assets/icons/opencode.svg")),
            "icons/openrouter.svg" => Some(include_bytes!("../assets/icons/openrouter.svg")),
            "icons/kimi.svg" => Some(include_bytes!("../assets/icons/kimi.svg")),
            "icons/qwen.svg" => Some(include_bytes!("../assets/icons/qwen.svg")),
            "icons/zai.svg" => Some(include_bytes!("../assets/icons/zai.svg")),
            "icons/antigravity.svg" => Some(include_bytes!("../assets/icons/antigravity.svg")),
            "icons/pi.svg" => Some(include_bytes!("../assets/icons/pi.svg")),
            "icons/acp.svg" => Some(include_bytes!("../assets/icons/acp.svg")),
            "icons/custom-provider.svg" => {
                Some(include_bytes!("../assets/icons/custom-provider.svg"))
            }
            "icons/file-diff.svg" => Some(include_bytes!("../assets/icons/file-diff.svg")),
            "icons/atom.svg" => Some(include_bytes!("../assets/icons/atom.svg")),
            "icons/hash.svg" => Some(include_bytes!("../assets/icons/hash.svg")),
            "icons/code-xml.svg" => Some(include_bytes!("../assets/icons/code-xml.svg")),
            "icons/braces.svg" => Some(include_bytes!("../assets/icons/braces.svg")),
            "icons/pilcrow.svg" => Some(include_bytes!("../assets/icons/pilcrow.svg")),
            "icons/file-text.svg" => Some(include_bytes!("../assets/icons/file-text.svg")),
            "icons/cog.svg" => Some(include_bytes!("../assets/icons/cog.svg")),
            "icons/gem.svg" => Some(include_bytes!("../assets/icons/gem.svg")),
            "icons/coffee.svg" => Some(include_bytes!("../assets/icons/coffee.svg")),
            "icons/bird.svg" => Some(include_bytes!("../assets/icons/bird.svg")),
            "icons/settings-2.svg" => Some(include_bytes!("../assets/icons/settings-2.svg")),
            "icons/container.svg" => Some(include_bytes!("../assets/icons/container.svg")),
            "icons/file-code-2.svg" => Some(include_bytes!("../assets/icons/file-code-2.svg")),
            "icons/rotate-ccw.svg" => Some(include_bytes!("../assets/icons/rotate-ccw.svg")),
            "icons/refresh-cw.svg" => Some(include_bytes!("../assets/icons/refresh-cw.svg")),
            "icons/copy.svg" => Some(include_bytes!("../assets/icons/copy.svg")),
            "icons/x.svg" => Some(include_bytes!("../assets/icons/x.svg")),
            "icons/arrow-left.svg" => Some(include_bytes!("../assets/icons/arrow-left.svg")),
            "icons/arrow-right.svg" => Some(include_bytes!("../assets/icons/arrow-right.svg")),
            "icons/arrow-up.svg" => Some(include_bytes!("../assets/icons/arrow-up.svg")),
            "icons/arrow-down.svg" => Some(include_bytes!("../assets/icons/arrow-down.svg")),
            "icons/square.svg" => Some(include_bytes!("../assets/icons/square.svg")),
            "icons/corner-down-right.svg" => {
                Some(include_bytes!("../assets/icons/corner-down-right.svg"))
            }
            "icons/resize-corner.svg" => Some(include_bytes!("../assets/icons/resize-corner.svg")),
            "icons/pencil.svg" => Some(include_bytes!("../assets/icons/pencil.svg")),
            "icons/pin.svg" => Some(include_bytes!("../assets/icons/pin.svg")),
            "icons/pin-off.svg" => Some(include_bytes!("../assets/icons/pin-off.svg")),
            "icons/archive.svg" => Some(include_bytes!("../assets/icons/archive.svg")),
            "icons/folder-open.svg" => Some(include_bytes!("../assets/icons/folder-open.svg")),
            "icons/panel-left-close.svg" => {
                Some(include_bytes!("../assets/icons/panel-left-close.svg"))
            }
            "icons/log-out.svg" => Some(include_bytes!("../assets/icons/log-out.svg")),
            "icons/square-pen.svg" => Some(include_bytes!("../assets/icons/square-pen.svg")),
            "icons/trash-2.svg" => Some(include_bytes!("../assets/icons/trash-2.svg")),
            "icons/blocks.svg" => Some(include_bytes!("../assets/icons/blocks.svg")),
            "icons/bell.svg" => Some(include_bytes!("../assets/icons/bell.svg")),
            "icons/boxes.svg" => Some(include_bytes!("../assets/icons/boxes.svg")),
            "icons/database.svg" => Some(include_bytes!("../assets/icons/database.svg")),
            "icons/info.svg" => Some(include_bytes!("../assets/icons/info.svg")),
            "icons/network.svg" => Some(include_bytes!("../assets/icons/network.svg")),
            "icons/user-round.svg" => Some(include_bytes!("../assets/icons/user-round.svg")),
            "icons/git-branch.svg" => Some(include_bytes!("../assets/icons/git-branch.svg")),
            "icons/history.svg" => Some(include_bytes!("../assets/icons/history.svg")),
            "icons/square-terminal.svg" => {
                Some(include_bytes!("../assets/icons/square-terminal.svg"))
            }
            "icons/folder.svg" => Some(include_bytes!("../assets/icons/folder.svg")),
            "icons/laptop.svg" => Some(include_bytes!("../assets/icons/laptop.svg")),
            "icons/gauge.svg" => Some(include_bytes!("../assets/icons/gauge.svg")),
            "icons/octagon-x.svg" => Some(include_bytes!("../assets/icons/octagon-x.svg")),
            "icons/panels-top-left.svg" => {
                Some(include_bytes!("../assets/icons/panels-top-left.svg"))
            }
            "icons/loader-circle.svg" => Some(include_bytes!("../assets/icons/loader-circle.svg")),
            "icons/attachment-loader.svg" => {
                Some(include_bytes!("../assets/icons/attachment-loader.svg"))
            }
            "icons/brief-loader-quarter.svg" => {
                Some(include_bytes!("../assets/icons/brief-loader-quarter.svg"))
            }
            "icons/brain.svg" => Some(include_bytes!("../assets/icons/brain.svg")),
            "icons/file-pen-line.svg" => Some(include_bytes!("../assets/icons/file-pen-line.svg")),
            "icons/wrench.svg" => Some(include_bytes!("../assets/icons/wrench.svg")),
            "icons/book-open.svg" => Some(include_bytes!("../assets/icons/book-open.svg")),
            "icons/images.svg" => Some(include_bytes!("../assets/icons/images.svg")),
            "icons/list-checks.svg" => Some(include_bytes!("../assets/icons/list-checks.svg")),
            "icons/circle-alert.svg" => Some(include_bytes!("../assets/icons/circle-alert.svg")),
            "icons/triangle-alert.svg" => {
                Some(include_bytes!("../assets/icons/triangle-alert.svg"))
            }
            "icons/circle-question-mark.svg" => {
                Some(include_bytes!("../assets/icons/circle-question-mark.svg"))
            }
            "icons/file.svg" => Some(include_bytes!("../assets/icons/file.svg")),
            "icons/image.svg" => Some(include_bytes!("../assets/icons/image.svg")),
            "icons/download.svg" => Some(include_bytes!("../assets/icons/download.svg")),
            "icons/maximize-2.svg" => Some(include_bytes!("../assets/icons/maximize-2.svg")),
            "icons/minus.svg" => Some(include_bytes!("../assets/icons/minus.svg")),
            _ => None,
        };
        Ok(bytes.map(Cow::Borrowed))
    }

    fn list(&self, _path: &str) -> Result<Vec<SharedString>> {
        Ok(Vec::new())
    }
}

pub fn register_fonts(cx: &mut App) -> Result<()> {
    let fonts = FONT_FACES
        .iter()
        .map(|(_, _, bytes)| Cow::Borrowed(*bytes))
        .collect();
    cx.text_system().add_fonts(fonts)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{FONT_FACES, HarnessAssets};
    use gpui::AssetSource as _;

    const REQUIRED_WEIGHTS: &[u16] = &[
        400, 450, 500, 520, 530, 540, 550, 560, 570, 580, 600, 680, 700,
    ];

    fn table<'a>(font: &'a [u8], tag: &[u8; 4]) -> Option<&'a [u8]> {
        let table_count = u16::from_be_bytes(font.get(4..6)?.try_into().ok()?) as usize;
        let directory_end = 12usize.checked_add(table_count.checked_mul(16)?)?;
        for record in font.get(12..directory_end)?.chunks_exact(16) {
            if record.get(..4)? != tag {
                continue;
            }
            let offset = u32::from_be_bytes(record.get(8..12)?.try_into().ok()?) as usize;
            let length = u32::from_be_bytes(record.get(12..16)?.try_into().ok()?) as usize;
            return font.get(offset..offset.checked_add(length)?);
        }
        None
    }

    fn declared_weight(font: &[u8]) -> Option<u16> {
        let os2 = table(font, b"OS/2")?;
        Some(u16::from_be_bytes(os2.get(4..6)?.try_into().ok()?))
    }

    #[test]
    fn bundled_font_faces_cover_and_match_every_renderer_weight() {
        for family in ["Geist", "Geist Mono"] {
            let actual = FONT_FACES
                .iter()
                .filter_map(|(font_family, weight, _)| (*font_family == family).then_some(*weight))
                .collect::<Vec<_>>();
            assert_eq!(actual, REQUIRED_WEIGHTS, "missing {family} font face");
        }

        for (family, weight, bytes) in FONT_FACES {
            assert_eq!(
                declared_weight(bytes),
                Some(*weight),
                "{family} face metadata does not match weight {weight}"
            );
        }
    }

    #[test]
    fn every_bundled_icon_is_registered_with_the_native_asset_source() {
        let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/icons");
        let mut paths = std::fs::read_dir(directory)
            .expect("native icon directory should be readable")
            .map(|entry| {
                let entry = entry.expect("native icon entry should be readable");
                format!(
                    "icons/{}",
                    entry
                        .file_name()
                        .to_str()
                        .expect("native icon names should be UTF-8")
                )
            })
            .collect::<Vec<_>>();
        paths.sort();

        for path in paths {
            assert!(
                HarnessAssets
                    .load(&path)
                    .expect("native icon load should not fail")
                    .is_some(),
                "{path} is not registered with HarnessAssets"
            );
        }
    }
}
