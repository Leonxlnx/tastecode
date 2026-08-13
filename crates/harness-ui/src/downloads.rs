use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

pub(crate) fn save_bytes(
    directory: &Path,
    suggested_name: &str,
    fallback_name: &str,
    bytes: &[u8],
) -> io::Result<PathBuf> {
    fs::create_dir_all(directory)?;
    let name = safe_download_name(suggested_name, fallback_name);
    let (destination, mut file) = create_download_file(directory, &name)?;
    if let Err(error) = file.write_all(bytes) {
        drop(file);
        let _ = fs::remove_file(&destination);
        return Err(error);
    }
    Ok(destination)
}

fn create_download_file(directory: &Path, name: &str) -> io::Result<(PathBuf, fs::File)> {
    for index in 0..u32::MAX {
        let candidate = directory.join(download_candidate_name(name, index));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => return Ok((candidate, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not allocate a unique download filename",
    ))
}

fn safe_download_name(suggested_name: &str, fallback_name: &str) -> String {
    let replaced = suggested_name
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
            {
                '_'
            } else {
                character
            }
        })
        .collect::<String>();
    let trimmed = replaced.trim_end_matches([' ', '.']);
    if trimmed.trim().is_empty() {
        return fallback_name.into();
    }
    let stem = trimmed
        .split('.')
        .next()
        .unwrap_or(trimmed)
        .to_ascii_uppercase();
    if matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    ) {
        format!("_{trimmed}")
    } else {
        trimmed.into()
    }
}

fn download_candidate_name(name: &str, index: u32) -> String {
    if index == 0 {
        return name.into();
    }
    let extension_start = name.rfind('.').filter(|index| *index > 0);
    let (stem, extension) = extension_start.map_or((name, ""), |index| name.split_at(index));
    format!("{stem} ({index}){extension}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_downloads_use_browser_collision_names() {
        let directory =
            std::env::temp_dir().join(format!("harness-download-test-{}", uuid::Uuid::new_v4()));
        let first = save_bytes(&directory, "Screenshot.png", "image", b"first").unwrap();
        let second = save_bytes(&directory, "Screenshot.png", "image", b"second").unwrap();

        assert_eq!(first.file_name().unwrap(), "Screenshot.png");
        assert_eq!(second.file_name().unwrap(), "Screenshot (1).png");
        assert_eq!(fs::read(first).unwrap(), b"first");
        assert_eq!(fs::read(second).unwrap(), b"second");

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn direct_downloads_keep_suggested_names_inside_the_download_folder() {
        assert_eq!(
            safe_download_name("../bad:name?.png", "image"),
            ".._bad_name_.png"
        );
        assert_eq!(safe_download_name("CON.png", "image"), "_CON.png");
        assert_eq!(safe_download_name("...", "image"), "image");
    }
}
