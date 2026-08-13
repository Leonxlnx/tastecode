use crate::ServerState;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use harness_protocol::{DiffDecision, DiffFile, DiffFileStatus, DiffHunk, DiffLine, SessionDiff};
use harness_store::StoreError;
use sha2::{Digest as _, Sha256};
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::time::Duration;
use thiserror::Error;

const GIT_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_GIT_OUTPUT: usize = 64 * 1024 * 1024;
const FILE_BATCH: usize = 8;

#[derive(Debug, Error)]
pub(crate) enum DiffReviewError {
    #[error("Refresh the diff and try again.")]
    StaleSnapshot,
    #[error("diff review requires an isolated session")]
    IsolatedSessionRequired,
    #[error("cannot reject a diff while the agent turn is running")]
    TurnRunning,
    #[error("diff hunk not found")]
    HunkNotFound,
    #[error("diff file not found")]
    FileNotFound,
    #[error("could not parse diff hunk: {0}")]
    InvalidHunk(String),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Snapshot(#[from] harness_workspace::SnapshotError),
    #[error(transparent)]
    Process(#[from] harness_proc::ProcessError),
}

#[derive(Clone)]
struct ChangedFile {
    path: String,
    previous_path: Option<String>,
    status: DiffFileStatus,
}

struct ParsedHunk {
    value: DiffHunk,
    patch: String,
}

struct ParsedFile {
    value: DiffFile,
    patch: String,
    target_id: String,
    hunks: Vec<ParsedHunk>,
}

struct ParsedDiff {
    value: SessionDiff,
    files: Vec<ParsedFile>,
}

pub(crate) fn read(state: &ServerState, thread_id: &str) -> Result<SessionDiff, DiffReviewError> {
    Ok(parse_current(state, thread_id)?.value)
}

pub(crate) fn review_hunk(
    state: &ServerState,
    thread_id: &str,
    version: &str,
    file_path: &str,
    hunk_id: &str,
    decision: DiffDecision,
) -> Result<SessionDiff, DiffReviewError> {
    review(state, thread_id, decision, || {
        let mut diff = current_diff(state, thread_id, version)?;
        let hunk = diff
            .files
            .iter_mut()
            .find(|file| file.value.path == file_path)
            .and_then(|file| file.hunks.iter_mut().find(|hunk| hunk.value.id == hunk_id))
            .ok_or(DiffReviewError::HunkNotFound)?;
        if decision == DiffDecision::Reject {
            apply_reverse(&repo_path(state, thread_id)?, &hunk.patch)?;
        }
        state
            .store
            .lock()
            .expect("store mutex poisoned")
            .set_diff_decision(thread_id, &hunk_target(hunk_id), decision)?;
        read(state, thread_id)
    })
}

pub(crate) fn review_file(
    state: &ServerState,
    thread_id: &str,
    version: &str,
    file_path: &str,
    decision: DiffDecision,
) -> Result<SessionDiff, DiffReviewError> {
    review(state, thread_id, decision, || {
        let mut diff = current_diff(state, thread_id, version)?;
        let file = diff
            .files
            .iter_mut()
            .find(|file| file.value.path == file_path)
            .ok_or(DiffReviewError::FileNotFound)?;
        if decision == DiffDecision::Reject {
            apply_reverse(&repo_path(state, thread_id)?, &file.patch)?;
        }
        state
            .store
            .lock()
            .expect("store mutex poisoned")
            .set_diff_decision(thread_id, &file_target(&file.target_id), decision)?;
        read(state, thread_id)
    })
}

fn review<T>(
    state: &ServerState,
    thread_id: &str,
    decision: DiffDecision,
    operation: impl FnOnce() -> Result<T, DiffReviewError>,
) -> Result<T, DiffReviewError> {
    if decision != DiffDecision::Reject {
        return operation();
    }
    if state.agents.is_running(thread_id) {
        return Err(DiffReviewError::TurnRunning);
    }
    {
        let mut reviewing = state
            .reviewing_diffs
            .lock()
            .expect("diff review mutex poisoned");
        if !reviewing.insert(thread_id.into()) {
            return Err(DiffReviewError::StaleSnapshot);
        }
    }
    let result = operation();
    state
        .reviewing_diffs
        .lock()
        .expect("diff review mutex poisoned")
        .remove(thread_id);
    result
}

fn current_diff(
    state: &ServerState,
    thread_id: &str,
    version: &str,
) -> Result<ParsedDiff, DiffReviewError> {
    let diff = parse_current(state, thread_id)?;
    if diff.value.version != version {
        return Err(DiffReviewError::StaleSnapshot);
    }
    Ok(diff)
}

fn parse_current(state: &ServerState, thread_id: &str) -> Result<ParsedDiff, DiffReviewError> {
    let repo_path = repo_path(state, thread_id)?;
    let snapshot = harness_workspace::take_snapshot(&repo_path)?;
    let version = git(
        &repo_path,
        [
            OsString::from("rev-parse"),
            OsString::from(format!("{}^{{tree}}", snapshot.commit)),
        ],
    )?
    .trim()
    .to_owned();
    let changed = changed_files(&repo_path, &snapshot.commit)?;
    let mut files = Vec::with_capacity(changed.len());
    for batch in changed.chunks(FILE_BATCH) {
        let parsed = std::thread::scope(|scope| {
            let repo_path = repo_path.as_path();
            let commit = snapshot.commit.as_str();
            batch
                .iter()
                .cloned()
                .map(|file| scope.spawn(move || parse_file(repo_path, file, commit)))
                .collect::<Vec<_>>()
                .into_iter()
                .map(|handle| handle.join().expect("diff parser thread panicked"))
                .collect::<Result<Vec<_>, _>>()
        })?;
        files.extend(parsed);
    }
    let decisions = state
        .store
        .lock()
        .expect("store mutex poisoned")
        .diff_decisions(thread_id)?;
    for file in &mut files {
        file.value.decision = decisions.get(&file_target(&file.target_id)).copied();
        for hunk in &mut file.hunks {
            hunk.value.decision = decisions.get(&hunk_target(&hunk.value.id)).copied();
        }
        file.value.hunks = file.hunks.iter().map(|hunk| hunk.value.clone()).collect();
    }
    Ok(ParsedDiff {
        value: SessionDiff {
            thread_id: thread_id.into(),
            version,
            files: files.iter().map(|file| file.value.clone()).collect(),
        },
        files,
    })
}

fn repo_path(state: &ServerState, thread_id: &str) -> Result<PathBuf, DiffReviewError> {
    state
        .store
        .lock()
        .expect("store mutex poisoned")
        .thread(thread_id)?
        .and_then(|thread| thread.worktree_path)
        .map(PathBuf::from)
        .ok_or(DiffReviewError::IsolatedSessionRequired)
}

fn changed_files(repo_path: &Path, commit: &str) -> Result<Vec<ChangedFile>, DiffReviewError> {
    let output = git(
        repo_path,
        [
            OsString::from("diff"),
            OsString::from("--name-status"),
            OsString::from("-z"),
            OsString::from("--find-renames"),
            OsString::from("HEAD"),
            OsString::from(commit),
        ],
    )?;
    let fields = output
        .split('\0')
        .filter(|field| !field.is_empty())
        .collect::<Vec<_>>();
    let mut files = Vec::new();
    let mut index = 0;
    while index < fields.len() {
        let code = fields[index];
        index += 1;
        if code.starts_with('R') {
            if let (Some(previous_path), Some(path)) = (fields.get(index), fields.get(index + 1)) {
                files.push(ChangedFile {
                    path: (*path).into(),
                    previous_path: Some((*previous_path).into()),
                    status: DiffFileStatus::Renamed,
                });
            }
            index = index.saturating_add(2);
            continue;
        }
        let Some(path) = fields.get(index) else {
            break;
        };
        index += 1;
        files.push(ChangedFile {
            path: (*path).into(),
            previous_path: None,
            status: if code.starts_with('A') {
                DiffFileStatus::Added
            } else if code.starts_with('D') {
                DiffFileStatus::Deleted
            } else {
                DiffFileStatus::Modified
            },
        });
    }
    Ok(files)
}

fn parse_file(
    repo_path: &Path,
    file: ChangedFile,
    snapshot_commit: &str,
) -> Result<ParsedFile, DiffReviewError> {
    let mut args = vec![
        OsString::from("diff"),
        OsString::from("--binary"),
        OsString::from("--no-color"),
        OsString::from("--no-ext-diff"),
        OsString::from("--no-textconv"),
        OsString::from("--src-prefix=a/"),
        OsString::from("--dst-prefix=b/"),
        OsString::from("--find-renames"),
        OsString::from("--unified=3"),
        OsString::from("HEAD"),
        OsString::from("--"),
    ];
    if let Some(previous_path) = &file.previous_path {
        args.push(previous_path.into());
    }
    args.push(file.path.clone().into());
    args.insert(10, snapshot_commit.into());
    let patch = git(repo_path, args)?;
    let hunks = parse_hunks(&file.path, &patch, file.status == DiffFileStatus::Renamed)?;
    let target_id = digest(&format!("file\0{}\0{patch}", file.path));
    let value = DiffFile {
        path: file.path,
        previous_path: file.previous_path,
        status: file.status,
        binary: patch.contains("GIT binary patch") || patch.contains("Binary files "),
        hunks: hunks.iter().map(|hunk| hunk.value.clone()).collect(),
        decision: None,
    };
    Ok(ParsedFile {
        value,
        patch,
        target_id,
        hunks,
    })
}

fn parse_hunks(
    file_path: &str,
    patch: &str,
    renamed: bool,
) -> Result<Vec<ParsedHunk>, DiffReviewError> {
    let lines = patch.split('\n').collect::<Vec<_>>();
    let starts = lines
        .iter()
        .enumerate()
        .filter_map(|(index, line)| line.starts_with("@@ ").then_some(index))
        .collect::<Vec<_>>();
    let Some(old_header) = lines.iter().find(|line| line.starts_with("--- ")) else {
        return Ok(Vec::new());
    };
    let Some(new_header) = lines.iter().find(|line| line.starts_with("+++ ")) else {
        return Ok(Vec::new());
    };
    starts
        .iter()
        .enumerate()
        .map(|(index, start)| {
            let end = starts.get(index + 1).copied().unwrap_or(lines.len());
            let mut raw_lines = lines[*start..end].to_vec();
            while raw_lines.last() == Some(&"") {
                raw_lines.pop();
            }
            let header = raw_lines.first().copied().unwrap_or_default();
            let (old_start, old_lines, new_start, new_lines) = parse_hunk_header(header)?;
            let mut old_line = old_start;
            let mut new_line = new_start;
            let mut values = Vec::new();
            for line in raw_lines.iter().skip(1) {
                if *line == "\\ No newline at end of file" {
                    if let Some(previous) = values.last_mut() {
                        mark_no_newline(previous);
                    }
                } else if let Some(text) = line.strip_prefix(' ') {
                    values.push(DiffLine::Context {
                        old_line,
                        new_line,
                        text: text.into(),
                        no_newline_at_end: None,
                    });
                    old_line = old_line.saturating_add(1);
                    new_line = new_line.saturating_add(1);
                } else if let Some(text) = line.strip_prefix('+') {
                    values.push(DiffLine::Addition {
                        new_line,
                        text: text.into(),
                        no_newline_at_end: None,
                    });
                    new_line = new_line.saturating_add(1);
                } else if let Some(text) = line.strip_prefix('-') {
                    values.push(DiffLine::Deletion {
                        old_line,
                        text: text.into(),
                        no_newline_at_end: None,
                    });
                    old_line = old_line.saturating_add(1);
                }
            }
            let body = format!(
                "{}\n",
                raw_lines
                    .iter()
                    .skip(1)
                    .copied()
                    .collect::<Vec<_>>()
                    .join("\n")
            );
            let id = digest(&format!("hunk\0{file_path}\0{old_start}\0{body}"));
            let apply_old_header = if renamed {
                format!("--- {}", new_header.trim_start_matches("+++ "))
            } else {
                (*old_header).into()
            };
            Ok(ParsedHunk {
                value: DiffHunk {
                    id,
                    header: header.into(),
                    old_start,
                    old_lines,
                    new_start,
                    new_lines,
                    lines: values,
                    decision: None,
                },
                patch: format!(
                    "{apply_old_header}\n{new_header}\n{}\n",
                    raw_lines.join("\n")
                ),
            })
        })
        .collect()
}

fn parse_hunk_header(header: &str) -> Result<(u32, u32, u32, u32), DiffReviewError> {
    let ranges = header
        .strip_prefix("@@ -")
        .and_then(|header| header.split_once(" +"))
        .and_then(|(old, rest)| rest.split_once(" @@").map(|(new, _)| (old, new)))
        .ok_or_else(|| DiffReviewError::InvalidHunk(header.into()))?;
    let parse_range = |range: &str| -> Result<(u32, u32), DiffReviewError> {
        let (start, lines) = range.split_once(',').unwrap_or((range, "1"));
        Ok((
            start
                .parse()
                .map_err(|_| DiffReviewError::InvalidHunk(header.into()))?,
            lines
                .parse()
                .map_err(|_| DiffReviewError::InvalidHunk(header.into()))?,
        ))
    };
    let old = parse_range(ranges.0)?;
    let new = parse_range(ranges.1)?;
    Ok((old.0, old.1, new.0, new.1))
}

fn mark_no_newline(line: &mut DiffLine) {
    match line {
        DiffLine::Context {
            no_newline_at_end, ..
        }
        | DiffLine::Addition {
            no_newline_at_end, ..
        }
        | DiffLine::Deletion {
            no_newline_at_end, ..
        } => *no_newline_at_end = Some(true),
    }
}

fn apply_reverse(repo_path: &Path, patch: &str) -> Result<(), DiffReviewError> {
    harness_proc::run_with_input(
        OsStr::new("git"),
        &[
            OsStr::new("apply"),
            OsStr::new("--reverse"),
            OsStr::new("--binary"),
            OsStr::new("--recount"),
            OsStr::new("--whitespace=nowarn"),
            OsStr::new("-"),
        ],
        repo_path,
        patch.as_bytes(),
        GIT_TIMEOUT,
        MAX_GIT_OUTPUT,
    )?;
    Ok(())
}

fn git(
    repo_path: &Path,
    args: impl IntoIterator<Item = OsString>,
) -> Result<String, DiffReviewError> {
    let args = args.into_iter().collect::<Vec<_>>();
    let refs = args.iter().map(OsString::as_os_str).collect::<Vec<_>>();
    Ok(harness_proc::run_untrimmed(
        OsStr::new("git"),
        &refs,
        repo_path,
        GIT_TIMEOUT,
        MAX_GIT_OUTPUT,
    )?)
}

fn digest(value: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(value.as_bytes()))[..22].into()
}

fn hunk_target(id: &str) -> String {
    format!("hunk:{id}")
}

fn file_target(id: &str) -> String {
    format!("file:{id}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_hunk_ranges_and_no_newline_markers() {
        let patch = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+changed\n\\ No newline at end of file\n";
        let hunks = parse_hunks("a.txt", patch, false).unwrap();
        assert_eq!(hunks.len(), 1);
        assert_eq!(hunks[0].value.old_start, 1);
        assert_eq!(hunks[0].value.new_lines, 2);
        assert!(matches!(
            hunks[0].value.lines.last(),
            Some(DiffLine::Addition {
                no_newline_at_end: Some(true),
                ..
            })
        ));
    }

    #[test]
    fn digest_matches_the_existing_base64url_contract() {
        assert_eq!(
            digest(concat!("hunk\0file.txt\0", "1\0body\n")),
            "r6US2BAulAw9DKCRANeXIs"
        );
    }
}
