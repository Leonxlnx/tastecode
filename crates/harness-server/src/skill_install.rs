use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Debug, Error)]
pub(crate) enum SkillInstallError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Invalid(String),
    #[error("project skill \"{0}\" already exists")]
    AlreadyExists(String),
}

pub(crate) fn install_local_skill(
    project_path: &str,
    folder_path: &str,
) -> Result<PathBuf, SkillInstallError> {
    let source = fs::canonicalize(folder_path)?;
    if !fs::metadata(&source)?.is_dir() {
        return invalid("selected skill path is not a folder");
    }
    let skill_file = source.join("SKILL.md");
    if !fs::metadata(&skill_file).is_ok_and(|metadata| metadata.is_file()) {
        return invalid("selected folder must contain a readable SKILL.md");
    }
    validate_tree(&source, &source, &HashSet::new())?;

    let name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| SkillInstallError::Invalid("skill folder name is not portable".into()))?;
    if !portable_name(name) {
        return invalid(&format!("skill folder name is not portable: {name}"));
    }
    let root = managed_root(project_path)?;
    if inside(&source, &root) {
        return invalid("selected skill folder cannot contain the managed skill location");
    }
    let destination = root.join(name);
    match fs::create_dir(&destination) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            return Err(SkillInstallError::AlreadyExists(name.into()));
        }
        Err(error) => return Err(error.into()),
    }
    if let Err(error) = copy_tree_contents(&source, &destination) {
        let _ = fs::remove_dir_all(&destination);
        return Err(error);
    }
    Ok(destination)
}

fn managed_root(project_path: &str) -> Result<PathBuf, SkillInstallError> {
    let project = fs::canonicalize(project_path)?;
    if !fs::metadata(&project)?.is_dir() {
        return invalid("project path is not a folder");
    }
    let agents = project.join(".agents");
    let managed = agents.join("skills");
    for candidate in [&agents, &managed] {
        if fs::symlink_metadata(candidate).is_ok() {
            let canonical = fs::canonicalize(candidate)?;
            if !inside(&project, &canonical) {
                return invalid("project skill location points outside the project");
            }
        }
    }
    fs::create_dir_all(&managed)?;
    let canonical = fs::canonicalize(managed)?;
    if !inside(&project, &canonical) {
        return invalid("project skill location points outside the project");
    }
    Ok(canonical)
}

fn validate_tree(
    root: &Path,
    current: &Path,
    ancestors: &HashSet<PathBuf>,
) -> Result<(), SkillInstallError> {
    let canonical = fs::canonicalize(current)?;
    if !inside(root, &canonical) {
        return invalid(&format!(
            "skill folder contains a symlink outside the selected folder: {}",
            current.display()
        ));
    }
    let metadata = fs::metadata(current)?;
    if metadata.is_file() {
        return Ok(());
    }
    if !metadata.is_dir() {
        return invalid(&format!(
            "skill folder contains an unsupported file type: {}",
            current.display()
        ));
    }
    if ancestors.contains(&canonical) {
        return invalid("skill folder contains a symbolic-link cycle");
    }
    let mut next = ancestors.clone();
    next.insert(canonical);
    for entry in fs::read_dir(current)? {
        validate_tree(root, &entry?.path(), &next)?;
    }
    Ok(())
}

fn copy_tree_contents(source: &Path, destination: &Path) -> Result<(), SkillInstallError> {
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        copy_entry(&entry.path(), &destination.join(entry.file_name()))?;
    }
    Ok(())
}

fn copy_entry(source: &Path, destination: &Path) -> Result<(), SkillInstallError> {
    let metadata = fs::metadata(source)?;
    if metadata.is_dir() {
        fs::create_dir(destination)?;
        copy_tree_contents(source, destination)
    } else if metadata.is_file() {
        fs::copy(source, destination)?;
        Ok(())
    } else {
        invalid(&format!(
            "skill folder contains an unsupported file type: {}",
            source.display()
        ))
    }
}

fn inside(root: &Path, candidate: &Path) -> bool {
    candidate == root || candidate.strip_prefix(root).is_ok()
}

fn portable_name(name: &str) -> bool {
    if name.is_empty() || name == "." || name == ".." || name.ends_with(['.', ' ']) {
        return false;
    }
    let base = name.split('.').next().unwrap_or(name).to_ascii_lowercase();
    let bytes = base.as_bytes();
    !(matches!(base.as_str(), "con" | "prn" | "aux" | "nul")
        || (bytes.len() == 4
            && matches!(&bytes[..3], b"com" | b"lpt")
            && matches!(bytes[3], b'1'..=b'9')))
}

fn invalid<T>(message: &str) -> Result<T, SkillInstallError> {
    Err(SkillInstallError::Invalid(message.into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copies_a_valid_skill_without_overwriting_a_conflict() {
        let project = tempfile::tempdir().unwrap();
        let source_root = tempfile::tempdir().unwrap();
        let source = source_root.path().join("review-skill");
        fs::create_dir_all(source.join("references")).unwrap();
        fs::write(source.join("SKILL.md"), "---\nname: review-skill\n---\n").unwrap();
        fs::write(source.join("references/notes.md"), "notes").unwrap();

        let destination =
            install_local_skill(&project.path().to_string_lossy(), &source.to_string_lossy())
                .unwrap();
        assert_eq!(
            fs::read_to_string(destination.join("references/notes.md")).unwrap(),
            "notes"
        );
        assert!(matches!(
            install_local_skill(
                &project.path().to_string_lossy(),
                &source.to_string_lossy()
            ),
            Err(SkillInstallError::AlreadyExists(name)) if name == "review-skill"
        ));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlink_that_escapes_the_selected_folder() {
        use std::os::unix::fs::symlink;

        let project = tempfile::tempdir().unwrap();
        let source_root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let source = source_root.path().join("unsafe-skill");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("SKILL.md"), "---\nname: unsafe-skill\n---\n").unwrap();
        symlink(outside.path(), source.join("outside")).unwrap();

        let error =
            install_local_skill(&project.path().to_string_lossy(), &source.to_string_lossy())
                .unwrap_err()
                .to_string();
        assert!(error.contains("symlink outside the selected folder"));
        assert!(!project.path().join(".agents/skills/unsafe-skill").exists());
    }

    #[test]
    fn rejects_nonportable_names_and_project_escape_links() {
        assert!(!portable_name("CON.txt"));
        assert!(!portable_name("lpt9"));
        assert!(!portable_name("trailing."));
        assert!(portable_name("review-skill"));
    }
}
