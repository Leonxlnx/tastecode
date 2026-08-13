use harness_protocol::{ProjectDirectoryEntry, ProjectDirectoryEntryKind, ProjectDirectoryListing};
use std::cmp::Ordering;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use thiserror::Error;

#[derive(Clone, Copy, Debug, Error)]
pub(crate) enum ProjectDirectoryBrowserError {
    #[error("The home folder is not available.")]
    HomeUnavailable,
    #[error("That folder is no longer available.")]
    FolderUnavailable,
    #[error("The mobile project picker can only browse inside your home folder.")]
    OutsideHome,
}

pub(crate) fn browse_project_directory(
    requested_path: Option<&Path>,
    home_directory: Option<&Path>,
) -> Result<ProjectDirectoryListing, ProjectDirectoryBrowserError> {
    let home = home_directory
        .map(Path::to_path_buf)
        .or_else(dirs::home_dir)
        .ok_or(ProjectDirectoryBrowserError::HomeUnavailable)?;
    let root = canonical_directory(&home, ProjectDirectoryBrowserError::HomeUnavailable)?;
    let current = canonical_directory(
        requested_path.unwrap_or(&root),
        ProjectDirectoryBrowserError::FolderUnavailable,
    )?;
    if current.strip_prefix(&root).is_err() {
        return Err(ProjectDirectoryBrowserError::OutsideHome);
    }

    let children =
        fs::read_dir(&current).map_err(|_| ProjectDirectoryBrowserError::FolderUnavailable)?;
    let mut entries = Vec::new();
    for child in children.flatten() {
        let name = child.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let Ok(file_type) = child.file_type() else {
            continue;
        };
        let kind = if file_type.is_dir() {
            ProjectDirectoryEntryKind::Directory
        } else if file_type.is_file() {
            ProjectDirectoryEntryKind::File
        } else {
            continue;
        };
        let Ok(metadata) = child.metadata() else {
            continue;
        };
        let modified_at = metadata
            .modified()
            .ok()
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .map_or(0.0, |duration| duration.as_secs_f64() * 1_000.0);
        entries.push(ProjectDirectoryEntry {
            path: child.path().to_string_lossy().into_owned(),
            name,
            kind,
            modified_at,
        });
    }
    entries.sort_by(|left, right| natural_name_cmp(&left.name, &right.name));

    let name = current
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| current.to_string_lossy().into_owned());
    let parent = (current != root)
        .then(|| current.parent())
        .flatten()
        .map(|parent| parent.to_string_lossy().into_owned());
    Ok(ProjectDirectoryListing {
        path: current.to_string_lossy().into_owned(),
        name,
        parent,
        entries,
    })
}

fn canonical_directory(
    location: &Path,
    error: ProjectDirectoryBrowserError,
) -> Result<PathBuf, ProjectDirectoryBrowserError> {
    let canonical = fs::canonicalize(location).map_err(|_| error)?;
    if !canonical.is_dir() {
        return Err(error);
    }
    Ok(canonical)
}

fn natural_name_cmp(left: &str, right: &str) -> Ordering {
    let mut left = left.chars().peekable();
    let mut right = right.chars().peekable();
    loop {
        match (left.peek(), right.peek()) {
            (Some(left_char), Some(right_char))
                if left_char.is_ascii_digit() && right_char.is_ascii_digit() =>
            {
                let left_number = take_ascii_digits(&mut left);
                let right_number = take_ascii_digits(&mut right);
                let left_trimmed = left_number.trim_start_matches('0');
                let right_trimmed = right_number.trim_start_matches('0');
                let left_trimmed = if left_trimmed.is_empty() {
                    "0"
                } else {
                    left_trimmed
                };
                let right_trimmed = if right_trimmed.is_empty() {
                    "0"
                } else {
                    right_trimmed
                };
                let order = left_trimmed
                    .len()
                    .cmp(&right_trimmed.len())
                    .then_with(|| left_trimmed.cmp(right_trimmed))
                    .then_with(|| left_number.len().cmp(&right_number.len()));
                if !order.is_eq() {
                    return order;
                }
            }
            (Some(_), Some(_)) => {
                let left_char = left.next().expect("peeked left character missing");
                let right_char = right.next().expect("peeked right character missing");
                let order = left_char
                    .to_ascii_lowercase()
                    .cmp(&right_char.to_ascii_lowercase())
                    .then_with(|| left_char.cmp(&right_char));
                if !order.is_eq() {
                    return order;
                }
            }
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
        }
    }
}

fn take_ascii_digits(iterator: &mut std::iter::Peekable<std::str::Chars<'_>>) -> String {
    let mut digits = String::new();
    while iterator.peek().is_some_and(char::is_ascii_digit) {
        digits.push(iterator.next().expect("peeked digit missing"));
    }
    digits
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_browser_stays_inside_home_and_hides_links_and_dotfiles() {
        let root = tempfile::tempdir().unwrap();
        let developer = root.path().join("Developer");
        fs::create_dir(&developer).unwrap();
        fs::create_dir(developer.join("project10")).unwrap();
        fs::create_dir(developer.join("project2")).unwrap();
        fs::write(developer.join("notes.txt"), b"notes").unwrap();
        fs::write(developer.join(".secret"), b"hidden").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.path(), developer.join("escape")).unwrap();

        let listing = browse_project_directory(Some(&developer), Some(root.path())).unwrap();
        assert_eq!(
            listing.path,
            fs::canonicalize(&developer).unwrap().to_string_lossy()
        );
        assert_eq!(
            listing
                .entries
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            ["notes.txt", "project2", "project10"]
        );
        assert!(listing.entries.iter().all(|entry| entry.name != ".secret"));
        #[cfg(unix)]
        assert!(listing.entries.iter().all(|entry| entry.name != "escape"));

        let outside = tempfile::tempdir().unwrap();
        assert!(matches!(
            browse_project_directory(Some(outside.path()), Some(root.path())),
            Err(ProjectDirectoryBrowserError::OutsideHome)
        ));
    }
}
