use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use thiserror::Error;
use unicode_normalization::UnicodeNormalization as _;
use uuid::Uuid;

pub(crate) const MAX_ATTACHMENT_BYTES: usize = 25 * 1_024 * 1_024;
const MAX_BASE64_LENGTH: usize = MAX_ATTACHMENT_BYTES.div_ceil(3) * 4;

#[derive(Debug, Error)]
pub(crate) enum UploadedAttachmentError {
    #[error("attachment exceeds the 25 MB limit")]
    TooLarge,
    #[error("attachment data is not valid base64")]
    InvalidBase64,
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub(crate) fn materialize_attachment(
    name: &str,
    data: &str,
    directory: Option<&Path>,
) -> Result<PathBuf, UploadedAttachmentError> {
    if data.len() > MAX_BASE64_LENGTH {
        return Err(UploadedAttachmentError::TooLarge);
    }
    let bytes = STANDARD
        .decode(data)
        .map_err(|_| UploadedAttachmentError::InvalidBase64)?;
    if bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err(UploadedAttachmentError::TooLarge);
    }

    let default_directory = std::env::temp_dir().join("TasteCode").join("attachments");
    let directory = directory.unwrap_or(&default_directory);
    fs::create_dir_all(directory)?;
    set_private_directory_permissions(directory)?;

    let target = directory.join(format!("{}-{}", Uuid::new_v4(), safe_file_name(name)));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    set_private_file_permissions(&mut options);
    let mut file = options.open(&target)?;
    file.write_all(&bytes)?;
    Ok(target)
}

pub(crate) fn image_file_name(mime_type: &str) -> &'static str {
    match mime_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "image/jpeg" => "image.jpg",
        "image/gif" => "image.gif",
        "image/webp" => "image.webp",
        "image/bmp" => "image.bmp",
        "image/heic" => "image.heic",
        "image/heif" => "image.heif",
        _ => "image.png",
    }
}

fn safe_file_name(name: &str) -> String {
    let leaf = name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .nfc()
        .collect::<String>();
    let cleaned = leaf
        .chars()
        .map(|character| {
            if character.is_control() || r#"<>:"/\|?*"#.contains(character) {
                '-'
            } else {
                character
            }
        })
        .collect::<String>();
    let cleaned = cleaned.trim_start_matches('.').trim();
    let cleaned = cleaned.chars().take(160).collect::<String>();
    if cleaned.is_empty() {
        "attachment".into()
    } else {
        cleaned
    }
}

#[cfg(unix)]
fn set_private_directory_permissions(directory: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    fs::set_permissions(directory, fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn set_private_directory_permissions(_directory: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn set_private_file_permissions(options: &mut OpenOptions) {
    use std::os::unix::fs::OpenOptionsExt as _;
    options.mode(0o600);
}

#[cfg(not(unix))]
fn set_private_file_permissions(_options: &mut OpenOptions) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uploaded_attachments_use_private_generated_names() {
        let directory = tempfile::tempdir().unwrap();
        let target = materialize_attachment(
            "../references\\design notes.txt",
            &STANDARD.encode("hello"),
            Some(directory.path()),
        )
        .unwrap();

        assert_eq!(target.parent(), Some(directory.path()));
        assert!(
            target
                .file_name()
                .unwrap()
                .to_string_lossy()
                .ends_with("-design notes.txt")
        );
        assert_eq!(fs::read_to_string(&target).unwrap(), "hello");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            assert_eq!(
                fs::metadata(target).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn uploaded_attachments_reject_malformed_and_oversized_data() {
        let directory = tempfile::tempdir().unwrap();
        assert!(matches!(
            materialize_attachment("bad.txt", "not base64", Some(directory.path())),
            Err(UploadedAttachmentError::InvalidBase64)
        ));
        assert!(matches!(
            materialize_attachment(
                "large.bin",
                &STANDARD.encode(vec![0; MAX_ATTACHMENT_BYTES + 1]),
                Some(directory.path())
            ),
            Err(UploadedAttachmentError::TooLarge)
        ));
    }

    #[test]
    fn image_names_follow_the_browser_mime_mapping() {
        assert_eq!(image_file_name("image/jpeg; charset=binary"), "image.jpg");
        assert_eq!(image_file_name("image/heic"), "image.heic");
        assert_eq!(image_file_name("application/octet-stream"), "image.png");
    }
}
