use harness_proc::{ProcessError, run};
use harness_protocol::WorkspaceInfo;
use std::ffi::OsStr;
use std::path::Path;
use std::time::Duration;
use thiserror::Error;

const READ_TIMEOUT: Duration = Duration::from_secs(8);
const SWITCH_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_GIT_OUTPUT: usize = 64 * 1024 * 1024;

#[derive(Debug, Error)]
pub enum WorkspaceError {
    #[error("unknown local branch: {0}")]
    UnknownLocalBranch(String),
    #[error("{0}")]
    SwitchFailed(String),
}

pub fn read_workspace(path: impl AsRef<Path>) -> WorkspaceInfo {
    let path = path.as_ref();
    let Some(branch) = git(path, &["rev-parse", "--abbrev-ref", "HEAD"], READ_TIMEOUT) else {
        return WorkspaceInfo::default();
    };
    let Some(stat) = git(path, &["diff", "--numstat", "HEAD"], READ_TIMEOUT) else {
        return WorkspaceInfo {
            branch: Some(branch),
            ..WorkspaceInfo::default()
        };
    };
    let mut info = WorkspaceInfo {
        branch: Some(branch),
        ..WorkspaceInfo::default()
    };
    for line in stat.lines().filter(|line| !line.trim().is_empty()) {
        let mut columns = line.split('\t');
        info.added = info.added.saturating_add(
            columns
                .next()
                .and_then(|value| value.parse().ok())
                .unwrap_or(0),
        );
        info.removed = info.removed.saturating_add(
            columns
                .next()
                .and_then(|value| value.parse().ok())
                .unwrap_or(0),
        );
        info.dirty_files = info.dirty_files.saturating_add(1);
    }
    info
}

pub fn list_workspace_branches(path: impl AsRef<Path>) -> Vec<String> {
    let path = path.as_ref();
    let current = git(path, &["rev-parse", "--abbrev-ref", "HEAD"], READ_TIMEOUT);
    let Some(output) = git(
        path,
        &[
            "for-each-ref",
            "--format=%(refname:short)",
            "--sort=refname",
            "refs/heads",
        ],
        READ_TIMEOUT,
    ) else {
        return Vec::new();
    };
    let mut branches = output
        .lines()
        .filter(|branch| !branch.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if let Some(current) = current
        && let Some(index) = branches.iter().position(|branch| branch == &current)
    {
        let current = branches.remove(index);
        branches.insert(0, current);
    }
    branches
}

pub fn switch_workspace_branch(
    path: impl AsRef<Path>,
    branch: &str,
) -> Result<WorkspaceInfo, WorkspaceError> {
    let path = path.as_ref();
    if !list_workspace_branches(path)
        .iter()
        .any(|candidate| candidate == branch)
    {
        return Err(WorkspaceError::UnknownLocalBranch(branch.into()));
    }
    let args = [
        OsStr::new("switch"),
        OsStr::new("--quiet"),
        OsStr::new(branch),
    ];
    run(
        OsStr::new("git"),
        &args,
        path,
        SWITCH_TIMEOUT,
        MAX_GIT_OUTPUT,
    )
    .map_err(|error| match error {
        ProcessError::Failed { message } => WorkspaceError::SwitchFailed(message),
        _ => WorkspaceError::SwitchFailed(format!("could not switch to {branch}")),
    })?;
    Ok(read_workspace(path))
}

fn git(cwd: &Path, args: &[&str], timeout: Duration) -> Option<String> {
    let args = args.iter().map(OsStr::new).collect::<Vec<_>>();
    run(OsStr::new("git"), &args, cwd, timeout, MAX_GIT_OUTPUT).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;

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

    fn repository() -> tempfile::TempDir {
        let directory = tempfile::tempdir().unwrap();
        git(directory.path(), &["init", "--initial-branch=main"]);
        git(
            directory.path(),
            &["config", "user.email", "test@example.com"],
        );
        git(directory.path(), &["config", "user.name", "Test"]);
        fs::write(directory.path().join("file.txt"), "main\n").unwrap();
        git(directory.path(), &["add", "file.txt"]);
        git(directory.path(), &["commit", "-m", "initial"]);
        git(directory.path(), &["branch", "feature/shelf"]);
        directory
    }

    #[test]
    fn lists_local_branches_with_the_current_branch_first() {
        let repo = repository();
        assert_eq!(
            list_workspace_branches(repo.path()),
            ["main", "feature/shelf"]
        );
    }

    #[test]
    fn switches_only_to_a_known_local_branch() {
        let repo = repository();
        assert_eq!(
            switch_workspace_branch(repo.path(), "feature/shelf").unwrap(),
            WorkspaceInfo {
                branch: Some("feature/shelf".into()),
                ..WorkspaceInfo::default()
            }
        );
        assert!(matches!(
            switch_workspace_branch(repo.path(), "HEAD~1"),
            Err(WorkspaceError::UnknownLocalBranch(_))
        ));
    }

    #[test]
    fn reports_text_and_binary_changes_without_throwing_for_plain_folders() {
        let repo = repository();
        fs::write(repo.path().join("file.txt"), "main\nchanged\n").unwrap();
        fs::write(repo.path().join("binary.dat"), [0, 159, 255, 0]).unwrap();
        git(repo.path(), &["add", "binary.dat"]);
        git(repo.path(), &["commit", "-m", "binary"]);
        fs::write(repo.path().join("binary.dat"), [0, 1, 2, 3]).unwrap();

        let info = read_workspace(repo.path());
        assert_eq!(info.branch.as_deref(), Some("main"));
        assert_eq!(info.added, 1);
        assert_eq!(info.removed, 0);
        assert_eq!(info.dirty_files, 2);

        let plain = tempfile::tempdir().unwrap();
        assert_eq!(read_workspace(plain.path()), WorkspaceInfo::default());
        assert!(list_workspace_branches(plain.path()).is_empty());
    }
}
