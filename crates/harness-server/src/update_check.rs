use harness_protocol::{UpdateCheckResult, UpdateRemote};
use serde::Deserialize;
use std::ffi::OsStr;
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::time::Duration;

const LATEST_URL: &str = "https://api.github.com/repos/Leonxlnx/tastecode/commits/main";
const UNREACHABLE: &str = "Could not reach GitHub.";
const HTTP_TIMEOUT: Duration = Duration::from_secs(8);
const GIT_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;

trait Probe {
    fn head(&self) -> Option<String>;
    fn fetch_latest(&self) -> Result<UpdateRemote, String>;
}

struct RealProbe {
    checkout: PathBuf,
}

impl RealProbe {
    fn new() -> Self {
        Self {
            checkout: checkout_root(),
        }
    }

    fn fetch_api(&self) -> Option<UpdateRemote> {
        let client = reqwest::blocking::Client::builder()
            .timeout(HTTP_TIMEOUT)
            .build()
            .ok()?;
        let mut response = client
            .get(LATEST_URL)
            .header(reqwest::header::ACCEPT, "application/vnd.github+json")
            .header(reqwest::header::USER_AGENT, "TasteCode")
            .send()
            .ok()?;
        if !response.status().is_success()
            || response
                .content_length()
                .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
        {
            return None;
        }
        let mut body = Vec::new();
        response
            .by_ref()
            .take((MAX_RESPONSE_BYTES + 1) as u64)
            .read_to_end(&mut body)
            .ok()?;
        if body.len() > MAX_RESPONSE_BYTES {
            return None;
        }
        let response: GitHubCommit = serde_json::from_slice(&body).ok()?;
        let sha = response.sha.filter(|sha| !sha.is_empty())?;
        let message = response
            .commit
            .as_ref()
            .and_then(|commit| commit.message.as_deref())
            .unwrap_or_default()
            .lines()
            .next()
            .unwrap_or_default()
            .into();
        let date = response
            .commit
            .and_then(|commit| commit.committer)
            .and_then(|committer| committer.date)
            .unwrap_or_default();
        Some(UpdateRemote { sha, message, date })
    }

    fn fetch_git(&self) -> Result<UpdateRemote, String> {
        let output = harness_proc::run(
            OsStr::new("git"),
            &[
                OsStr::new("-c"),
                OsStr::new("protocol.ext.allow=never"),
                OsStr::new("ls-remote"),
                OsStr::new("origin"),
                OsStr::new("refs/heads/main"),
            ],
            &self.checkout,
            GIT_TIMEOUT,
            MAX_RESPONSE_BYTES,
        )
        .map_err(|_| UNREACHABLE.to_owned())?;
        let sha = output
            .split_whitespace()
            .next()
            .filter(|sha| !sha.is_empty())
            .ok_or_else(|| UNREACHABLE.to_owned())?;
        Ok(UpdateRemote {
            sha: sha.into(),
            message: String::new(),
            date: String::new(),
        })
    }
}

impl Probe for RealProbe {
    fn head(&self) -> Option<String> {
        harness_proc::run(
            OsStr::new("git"),
            &[OsStr::new("rev-parse"), OsStr::new("HEAD")],
            &self.checkout,
            GIT_TIMEOUT,
            MAX_RESPONSE_BYTES,
        )
        .ok()
        .filter(|head| !head.is_empty())
    }

    fn fetch_latest(&self) -> Result<UpdateRemote, String> {
        self.fetch_api().map_or_else(|| self.fetch_git(), Ok)
    }
}

pub(crate) fn check() -> UpdateCheckResult {
    check_with(&RealProbe::new())
}

fn check_with(probe: &dyn Probe) -> UpdateCheckResult {
    let local_commit = probe.head();
    match probe.fetch_latest() {
        Ok(remote) => UpdateCheckResult {
            up_to_date: local_commit.as_ref().map(|local| local == &remote.sha),
            local_commit,
            remote: Some(remote),
            error: None,
        },
        Err(error) => UpdateCheckResult {
            local_commit,
            remote: None,
            up_to_date: None,
            error: Some(error),
        },
    }
}

fn checkout_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")))
        .to_owned()
}

#[derive(Deserialize)]
struct GitHubCommit {
    sha: Option<String>,
    commit: Option<GitHubCommitBody>,
}

#[derive(Deserialize)]
struct GitHubCommitBody {
    message: Option<String>,
    committer: Option<GitHubCommitter>,
}

#[derive(Deserialize)]
struct GitHubCommitter {
    date: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FixedProbe {
        local: Option<&'static str>,
        latest: Result<UpdateRemote, &'static str>,
    }

    impl Probe for FixedProbe {
        fn head(&self) -> Option<String> {
            self.local.map(str::to_owned)
        }

        fn fetch_latest(&self) -> Result<UpdateRemote, String> {
            self.latest.clone().map_err(str::to_owned)
        }
    }

    fn remote(sha: &str) -> UpdateRemote {
        UpdateRemote {
            sha: sha.into(),
            message: "Latest".into(),
            date: "2026-08-06T00:00:00Z".into(),
        }
    }

    #[test]
    fn reports_matching_and_mismatching_commits() {
        for (remote_sha, expected) in [("local", true), ("newer", false)] {
            let result = check_with(&FixedProbe {
                local: Some("local"),
                latest: Ok(remote(remote_sha)),
            });
            assert_eq!(result.up_to_date, Some(expected));
            assert_eq!(result.remote.unwrap().sha, remote_sha);
        }
    }

    #[test]
    fn keeps_unknown_local_and_offline_states_explicit() {
        let packaged = check_with(&FixedProbe {
            local: None,
            latest: Ok(remote("remote")),
        });
        assert_eq!(packaged.up_to_date, None);
        assert_eq!(packaged.local_commit, None);

        let offline = check_with(&FixedProbe {
            local: Some("local"),
            latest: Err(UNREACHABLE),
        });
        assert_eq!(offline.local_commit.as_deref(), Some("local"));
        assert_eq!(offline.remote, None);
        assert_eq!(offline.error.as_deref(), Some(UNREACHABLE));
    }

    #[test]
    fn parses_only_the_first_commit_message_line() {
        let response: GitHubCommit = serde_json::from_value(serde_json::json!({
            "sha": "abc",
            "commit": {
                "message": "feat: native update check\n\nDetails",
                "committer": { "date": "2026-08-06T00:00:00Z" }
            }
        }))
        .unwrap();
        let body = response.commit.unwrap();
        assert_eq!(
            body.message.unwrap().lines().next(),
            Some("feat: native update check")
        );
    }
}
