use harness_proc::{ProcessError, run};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::time::Duration;
use thiserror::Error;

const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
const MUTATION_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_GIT_OUTPUT: usize = 64 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Worktree {
    pub path: PathBuf,
    pub branch: String,
    pub repo_path: PathBuf,
}

#[derive(Debug, Error)]
pub enum WorktreeError {
    #[error("{} is not a git repository, so a session cannot be isolated in it", .0.display())]
    NotARepository(PathBuf),
    #[error(
        "{} has uncommitted changes. Commit or discard them, then remove the session again.",
        .0.display()
    )]
    Dirty(PathBuf),
    #[error("thread id cannot be empty")]
    EmptyThreadId,
    #[error("{0}")]
    Git(String),
}

pub fn is_repository(repo_path: impl AsRef<Path>) -> bool {
    git_optional(
        repo_path.as_ref(),
        &[OsStr::new("rev-parse"), OsStr::new("--git-dir")],
    )
    .is_some()
}

pub fn create_worktree(
    repo_path: impl AsRef<Path>,
    thread_id: &str,
    root: impl AsRef<Path>,
) -> Result<Worktree, WorktreeError> {
    let repo_path = repo_path.as_ref();
    if !is_repository(repo_path) {
        return Err(WorktreeError::NotARepository(repo_path.to_owned()));
    }
    let short_id = short_thread_id(thread_id).ok_or(WorktreeError::EmptyThreadId)?;
    let branch = format!("harness/{short_id}");
    let target = root.as_ref().join(&short_id);

    let _ = git_optional(repo_path, &[OsStr::new("worktree"), OsStr::new("prune")]);
    git_required(
        repo_path,
        &[
            OsStr::new("worktree"),
            OsStr::new("add"),
            OsStr::new("-b"),
            OsStr::new(&branch),
            target.as_os_str(),
            OsStr::new("HEAD"),
        ],
    )?;
    Ok(Worktree {
        path: target,
        branch,
        repo_path: repo_path.to_owned(),
    })
}

pub fn remove_worktree(worktree: &Worktree, force: bool) -> Result<(), WorktreeError> {
    if !force && has_uncommitted_changes(&worktree.path) {
        return Err(WorktreeError::Dirty(worktree.path.clone()));
    }
    let mut args = vec![
        OsStr::new("worktree"),
        OsStr::new("remove"),
        worktree.path.as_os_str(),
    ];
    if force {
        args.push(OsStr::new("--force"));
    }
    if let Err(error) = git_required(&worktree.repo_path, &args) {
        if worktree.path.exists() {
            return Err(error);
        }
        let _ = git_optional(
            &worktree.repo_path,
            &[OsStr::new("worktree"), OsStr::new("prune")],
        );
    }
    Ok(())
}

pub fn has_uncommitted_changes(worktree_path: impl AsRef<Path>) -> bool {
    let worktree_path = worktree_path.as_ref();
    if !worktree_path.exists() {
        return false;
    }
    git_optional(
        worktree_path,
        &[OsStr::new("status"), OsStr::new("--porcelain")],
    )
    .is_none_or(|status| !status.is_empty())
}

pub fn prune_worktrees(repo_path: impl AsRef<Path>) {
    let _ = git_optional(
        repo_path.as_ref(),
        &[OsStr::new("worktree"), OsStr::new("prune")],
    );
}

fn short_thread_id(thread_id: &str) -> Option<String> {
    if thread_id.is_empty() {
        return None;
    }
    let cleaned = thread_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    let start = cleaned.len().saturating_sub(12);
    Some(cleaned[start..].into())
}

fn git_optional(cwd: &Path, args: &[&OsStr]) -> Option<String> {
    run(OsStr::new("git"), args, cwd, PROBE_TIMEOUT, MAX_GIT_OUTPUT).ok()
}

fn git_required(cwd: &Path, args: &[&OsStr]) -> Result<String, WorktreeError> {
    run(
        OsStr::new("git"),
        args,
        cwd,
        MUTATION_TIMEOUT,
        MAX_GIT_OUTPUT,
    )
    .map_err(|error| WorktreeError::Git(process_message(error)))
}

fn process_message(error: ProcessError) -> String {
    match error {
        ProcessError::Failed { message } => message,
        error => error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;

    struct Repository {
        _directory: tempfile::TempDir,
        repo: PathBuf,
        root: PathBuf,
    }

    impl Repository {
        fn new() -> Self {
            let directory = tempfile::tempdir().unwrap();
            let repo = directory.path().join("repo");
            let root = directory.path().join("worktrees");
            let output = Command::new("git")
                .args(["init", "-b", "main"])
                .arg(&repo)
                .output()
                .unwrap();
            assert!(output.status.success());
            git(&repo, &["config", "user.email", "test@example.com"]);
            git(&repo, &["config", "user.name", "Test"]);
            fs::write(repo.join("file.txt"), "original\n").unwrap();
            git(&repo, &["add", "."]);
            git(&repo, &["commit", "-m", "first"]);
            Self {
                _directory: directory,
                repo,
                root,
            }
        }
    }

    fn git(cwd: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?}: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().into()
    }

    #[test]
    fn creates_separate_private_checkouts_and_branches() {
        let repository = Repository::new();
        let first =
            create_worktree(&repository.repo, "thread-aaaaaaaaaaaa", &repository.root).unwrap();
        let second =
            create_worktree(&repository.repo, "thread-bbbbbbbbbbbb", &repository.root).unwrap();
        assert!(first.path.join("file.txt").exists());
        assert_ne!(first.path, second.path);
        assert_ne!(first.branch, second.branch);

        fs::write(first.path.join("file.txt"), "changed by agent\n").unwrap();
        assert!(git(&repository.repo, &["status", "--porcelain"]).is_empty());
    }

    #[test]
    fn refuses_non_repositories_and_recovers_stale_registration() {
        let repository = Repository::new();
        let plain = tempfile::tempdir().unwrap();
        assert!(matches!(
            create_worktree(plain.path(), "thread-1", &repository.root),
            Err(WorktreeError::NotARepository(_))
        ));

        let stale =
            create_worktree(&repository.repo, "thread-cccccccccccc", &repository.root).unwrap();
        fs::remove_dir_all(&stale.path).unwrap();
        let recovered =
            create_worktree(&repository.repo, "thread-dddddddddddd", &repository.root).unwrap();
        assert!(recovered.path.exists());
    }

    #[test]
    fn refuses_dirty_removal_and_discards_only_when_forced() {
        let repository = Repository::new();
        let worktree =
            create_worktree(&repository.repo, "thread-eeeeeeeeeeee", &repository.root).unwrap();
        fs::write(worktree.path.join("file.txt"), "uncommitted\n").unwrap();
        assert!(matches!(
            remove_worktree(&worktree, false),
            Err(WorktreeError::Dirty(_))
        ));
        assert!(worktree.path.exists());
        remove_worktree(&worktree, true).unwrap();
        assert!(!worktree.path.exists());
    }

    #[test]
    fn clean_removal_keeps_the_branch_and_its_commits() {
        let repository = Repository::new();
        let worktree =
            create_worktree(&repository.repo, "thread-222222222222", &repository.root).unwrap();
        fs::write(worktree.path.join("file.txt"), "committed work\n").unwrap();
        git(&worktree.path, &["add", "."]);
        git(&worktree.path, &["commit", "-m", "agent work"]);
        remove_worktree(&worktree, false).unwrap();
        assert!(!worktree.path.exists());
        assert!(
            git(&repository.repo, &["branch", "--list", &worktree.branch])
                .contains(&worktree.branch)
        );
    }

    #[test]
    fn git_failure_never_falls_back_to_deleting_an_existing_checkout() {
        let repository = Repository::new();
        let worktree =
            create_worktree(&repository.repo, "thread-555555555555", &repository.root).unwrap();
        let keep = worktree.path.join("unsaved.txt");
        fs::write(&keep, "keep me\n").unwrap();
        fs::remove_dir_all(repository.repo.join(".git").join("worktrees")).unwrap();

        assert!(remove_worktree(&worktree, true).is_err());
        assert!(keep.exists());
    }

    #[test]
    fn already_missing_checkouts_are_success_and_unknown_status_is_dirty() {
        let repository = Repository::new();
        let worktree =
            create_worktree(&repository.repo, "thread-333333333333", &repository.root).unwrap();
        fs::remove_dir_all(&worktree.path).unwrap();
        remove_worktree(&worktree, true).unwrap();
        assert!(!has_uncommitted_changes(&worktree.path));

        let plain = tempfile::tempdir().unwrap();
        assert!(has_uncommitted_changes(plain.path()));
    }

    #[test]
    fn sanitizes_only_the_readable_twelve_character_tail() {
        assert_eq!(
            short_thread_id("codex-aaaa-bbbb-cccc"),
            Some("aa-bbbb-cccc".into())
        );
        assert_eq!(short_thread_id("thread/a:b"), Some("thread-a-b".into()));
        assert_eq!(short_thread_id(""), None);
    }
}
