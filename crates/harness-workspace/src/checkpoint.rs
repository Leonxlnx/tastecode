use harness_proc::{ProcessError, run, run_untrimmed, run_with_environment};
use std::collections::VecDeque;
use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use thiserror::Error;

const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(60);
const READ_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_GIT_OUTPUT: usize = 64 * 1024 * 1024;
const SNAPSHOT_CACHE_SIZE: usize = 64;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
    pub commit: String,
    pub clean: bool,
}

#[derive(Debug, Error)]
pub enum SnapshotError {
    #[error("{} is not a git repository, so there is nothing to snapshot", .0.display())]
    NotARepository(PathBuf),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Git(String),
    #[error("git reported a path outside the repository: {}", .0.display())]
    UnsafePath(PathBuf),
}

pub fn take_snapshot(repo_path: impl AsRef<Path>) -> Result<Snapshot, SnapshotError> {
    let repo_path = repo_path.as_ref();
    let head = git_optional(repo_path, &[OsStr::new("rev-parse"), OsStr::new("HEAD")])
        .ok_or_else(|| SnapshotError::NotARepository(repo_path.to_owned()))?;
    let index_directory = tempfile::Builder::new()
        .prefix("harness-index-")
        .tempdir()?;
    let index_file = index_directory.path().join("index");
    let environment = [(OsStr::new("GIT_INDEX_FILE"), index_file.as_os_str())];

    git_with_environment(
        repo_path,
        &[OsStr::new("read-tree"), OsStr::new("HEAD")],
        &environment,
    )?;
    git_with_environment(
        repo_path,
        &[OsStr::new("add"), OsStr::new("-A")],
        &environment,
    )?;
    let tree = git_with_environment(repo_path, &[OsStr::new("write-tree")], &environment)?;
    let head_tree = git_optional(
        repo_path,
        &[OsStr::new("rev-parse"), OsStr::new("HEAD^{tree}")],
    );
    if head_tree.as_deref() == Some(tree.as_str()) {
        return Ok(Snapshot {
            commit: head,
            clean: true,
        });
    }

    let key = SnapshotKey {
        repo_path: repo_path.to_owned(),
        head: head.clone(),
        tree: tree.clone(),
    };
    if let Some(commit) = snapshot_cache()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .iter()
        .find_map(|(candidate, commit)| (candidate == &key).then(|| commit.clone()))
    {
        return Ok(Snapshot {
            commit,
            clean: false,
        });
    }
    let commit = git_required(
        repo_path,
        &[
            OsStr::new("commit-tree"),
            OsStr::new(&tree),
            OsStr::new("-p"),
            OsStr::new(&head),
            OsStr::new("-m"),
            OsStr::new("harness checkpoint"),
        ],
        SNAPSHOT_TIMEOUT,
    )?;
    let mut cache = snapshot_cache()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    cache.push_back((key, commit.clone()));
    if cache.len() > SNAPSHOT_CACHE_SIZE {
        cache.pop_front();
    }
    Ok(Snapshot {
        commit,
        clean: false,
    })
}

pub fn restore_snapshot(
    repo_path: impl AsRef<Path>,
    commit: &str,
) -> Result<Snapshot, SnapshotError> {
    let repo_path = repo_path.as_ref();
    let replaced = take_snapshot(repo_path)?;
    let added = git_untrimmed_optional(
        repo_path,
        &[
            OsStr::new("diff"),
            OsStr::new("--name-only"),
            OsStr::new("-z"),
            OsStr::new("--diff-filter=A"),
            OsStr::new(commit),
            OsStr::new(&replaced.commit),
        ],
    )
    .unwrap_or_default();
    for file in split_git_paths(&added) {
        let relative = safe_relative_path(file)?;
        let _ = std::fs::remove_file(repo_path.join(relative));
    }
    git_required(
        repo_path,
        &[
            OsStr::new("restore"),
            OsStr::new("--source"),
            OsStr::new(commit),
            OsStr::new("--worktree"),
            OsStr::new("--"),
            OsStr::new("."),
        ],
        SNAPSHOT_TIMEOUT,
    )?;
    Ok(replaced)
}

pub fn changed_since(
    repo_path: impl AsRef<Path>,
    commit: &str,
) -> Result<Vec<PathBuf>, SnapshotError> {
    let repo_path = repo_path.as_ref();
    let now = take_snapshot(repo_path)?;
    let output = git_untrimmed_optional(
        repo_path,
        &[
            OsStr::new("diff"),
            OsStr::new("--name-only"),
            OsStr::new("-z"),
            OsStr::new(commit),
            OsStr::new(&now.commit),
        ],
    )
    .unwrap_or_default();
    split_git_paths(&output).map(safe_relative_path).collect()
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SnapshotKey {
    repo_path: PathBuf,
    head: String,
    tree: String,
}

fn snapshot_cache() -> &'static Mutex<VecDeque<(SnapshotKey, String)>> {
    static CACHE: OnceLock<Mutex<VecDeque<(SnapshotKey, String)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(VecDeque::new()))
}

fn split_git_paths(output: &str) -> impl Iterator<Item = &str> {
    output.split('\0').filter(|path| !path.is_empty())
}

fn safe_relative_path(path: &str) -> Result<PathBuf, SnapshotError> {
    let path = PathBuf::from(path);
    if path.as_os_str().is_empty()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(SnapshotError::UnsafePath(path));
    }
    Ok(path)
}

fn git_optional(cwd: &Path, args: &[&OsStr]) -> Option<String> {
    run(OsStr::new("git"), args, cwd, READ_TIMEOUT, MAX_GIT_OUTPUT).ok()
}

fn git_untrimmed_optional(cwd: &Path, args: &[&OsStr]) -> Option<String> {
    run_untrimmed(OsStr::new("git"), args, cwd, READ_TIMEOUT, MAX_GIT_OUTPUT).ok()
}

fn git_required(cwd: &Path, args: &[&OsStr], timeout: Duration) -> Result<String, SnapshotError> {
    run(OsStr::new("git"), args, cwd, timeout, MAX_GIT_OUTPUT)
        .map_err(|error| SnapshotError::Git(process_message(error)))
}

fn git_with_environment(
    cwd: &Path,
    args: &[&OsStr],
    environment: &[(&OsStr, &OsStr)],
) -> Result<String, SnapshotError> {
    run_with_environment(
        OsStr::new("git"),
        args,
        cwd,
        SNAPSHOT_TIMEOUT,
        MAX_GIT_OUTPUT,
        environment,
    )
    .map_err(|error| SnapshotError::Git(process_message(error)))
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
        directory: tempfile::TempDir,
    }

    impl Repository {
        fn new() -> Self {
            let directory = tempfile::tempdir().unwrap();
            git(directory.path(), &["init", "-b", "main"]);
            git(
                directory.path(),
                &["config", "user.email", "test@example.com"],
            );
            git(directory.path(), &["config", "user.name", "Test"]);
            git(directory.path(), &["config", "core.autocrlf", "false"]);
            fs::write(directory.path().join("tracked.txt"), "original\n").unwrap();
            git(directory.path(), &["add", "."]);
            git(directory.path(), &["commit", "-m", "first"]);
            Self { directory }
        }

        fn path(&self) -> &Path {
            self.directory.path()
        }

        fn read(&self, file: &str) -> String {
            fs::read_to_string(self.path().join(file)).unwrap()
        }

        fn write(&self, file: &str, contents: &str) {
            fs::write(self.path().join(file), contents).unwrap();
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
    fn clean_and_identical_dirty_snapshots_are_stable() {
        let repository = Repository::new();
        let clean = take_snapshot(repository.path()).unwrap();
        assert!(clean.clean);
        assert_eq!(clean.commit, git(repository.path(), &["rev-parse", "HEAD"]));

        repository.write("tracked.txt", "changed\n");
        let first = take_snapshot(repository.path()).unwrap();
        let second = take_snapshot(repository.path()).unwrap();
        assert!(!first.clean);
        assert_eq!(first.commit, second.commit);
    }

    #[test]
    fn captures_untracked_files_without_changing_the_index_or_log() {
        let repository = Repository::new();
        repository.write("tracked.txt", "changed\n");
        repository.write("staged.txt", "deliberately staged\n");
        repository.write("brand-new.txt", "written by the agent\n");
        git(repository.path(), &["add", "staged.txt"]);
        let status = git(repository.path(), &["status", "--porcelain"]);

        let snapshot = take_snapshot(repository.path()).unwrap();
        let files = git(
            repository.path(),
            &["ls-tree", "-r", "--name-only", &snapshot.commit],
        );
        assert!(files.contains("brand-new.txt"));
        assert_eq!(git(repository.path(), &["status", "--porcelain"]), status);
        assert_eq!(
            git(repository.path(), &["log", "--oneline"])
                .lines()
                .count(),
            1
        );
    }

    #[test]
    fn refuses_plain_folders() {
        let plain = tempfile::tempdir().unwrap();
        assert!(matches!(
            take_snapshot(plain.path()),
            Err(SnapshotError::NotARepository(_))
        ));
    }

    #[test]
    fn restores_modified_deleted_and_added_files_without_moving_head_or_index() {
        let repository = Repository::new();
        repository.write("will-be-deleted.txt", "precious\n");
        git(repository.path(), &["add", "."]);
        git(repository.path(), &["commit", "-m", "second"]);
        repository.write("staged.txt", "the user staged this\n");
        git(repository.path(), &["add", "staged.txt"]);
        let before_status = git(repository.path(), &["status", "--porcelain"]);
        let before_head = git(repository.path(), &["rev-parse", "HEAD"]);
        let before = take_snapshot(repository.path()).unwrap();

        repository.write("tracked.txt", "wrong way\n");
        fs::remove_file(repository.path().join("will-be-deleted.txt")).unwrap();
        repository.write("agent-made-this.txt", "noise\n");
        fs::create_dir(repository.path().join("nested")).unwrap();
        repository.write("nested/thing.txt", "new\n");
        repository.write("zażółć.txt", "unicode\n");
        repository.write(" leading space.txt", "space\n");
        let replaced = restore_snapshot(repository.path(), &before.commit).unwrap();

        assert_eq!(repository.read("tracked.txt"), "original\n");
        assert_eq!(repository.read("will-be-deleted.txt"), "precious\n");
        assert!(!repository.path().join("agent-made-this.txt").exists());
        assert!(!repository.path().join("nested/thing.txt").exists());
        assert!(!repository.path().join("zażółć.txt").exists());
        assert!(!repository.path().join(" leading space.txt").exists());
        assert_eq!(git(repository.path(), &["rev-parse", "HEAD"]), before_head);
        assert_eq!(
            git(repository.path(), &["status", "--porcelain"]),
            before_status
        );

        restore_snapshot(repository.path(), &replaced.commit).unwrap();
        assert_eq!(repository.read("tracked.txt"), "wrong way\n");
        assert!(repository.path().join("agent-made-this.txt").exists());
        assert!(repository.path().join("zażółć.txt").exists());
        assert!(repository.path().join(" leading space.txt").exists());
    }

    #[test]
    fn names_every_file_changed_since_a_snapshot() {
        let repository = Repository::new();
        let snapshot = take_snapshot(repository.path()).unwrap();
        assert!(
            changed_since(repository.path(), &snapshot.commit)
                .unwrap()
                .is_empty()
        );
        repository.write("tracked.txt", "changed\n");
        repository.write("added.txt", "new\n");
        let mut changed = changed_since(repository.path(), &snapshot.commit).unwrap();
        changed.sort();
        assert_eq!(
            changed,
            [PathBuf::from("added.txt"), PathBuf::from("tracked.txt")]
        );
    }

    #[test]
    fn rejects_paths_that_could_escape_the_repository() {
        assert!(safe_relative_path("src/main.rs").is_ok());
        assert!(safe_relative_path("../outside").is_err());
        assert!(safe_relative_path("/outside").is_err());
        assert!(safe_relative_path("").is_err());
    }
}
