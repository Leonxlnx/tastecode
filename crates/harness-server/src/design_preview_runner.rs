use crate::safe_command_environment::safe_command_environment;
use harness_design_agent::{PreviewPlan, PreviewViewport};
use harness_proc::{SpawnOptions, SpawnedChild, spawn_cli};
use serde_json::Value;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use thiserror::Error;

const COMMANDS: &[&str] = &["bun", "node", "npm", "pnpm", "yarn"];
const MAX_OUTPUT_BYTES: usize = 100_000;
const POLL_INTERVAL: Duration = Duration::from_millis(100);
const HTTP_TIMEOUT: Duration = Duration::from_millis(500);

#[derive(Debug, Error)]
pub(crate) enum PreviewError {
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Process(String),
    #[error("preview exited before it was ready\n{0}")]
    Exited(String),
    #[error("preview did not become ready within {timeout_ms}ms\n{output}")]
    TimedOut { timeout_ms: u128, output: String },
}

pub(crate) struct RunningPreview {
    url: String,
    viewports: Vec<PreviewViewport>,
    process: Mutex<PreviewProcess>,
}

struct PreviewProcess {
    child: Option<SpawnedChild>,
    readers: Vec<JoinHandle<()>>,
}

impl RunningPreview {
    pub(crate) fn url(&self) -> &str {
        &self.url
    }

    pub(crate) fn viewports(&self) -> &[PreviewViewport] {
        &self.viewports
    }

    pub(crate) fn stop(&self) -> Result<(), PreviewError> {
        let (mut child, readers) = {
            let mut process = lock(&self.process);
            (process.child.take(), std::mem::take(&mut process.readers))
        };
        let stop_result = child.as_mut().map(SpawnedChild::kill_tree).transpose();
        drop(child);
        for reader in readers {
            let _ = reader.join();
        }
        stop_result
            .map(|_| ())
            .map_err(|error| PreviewError::Process(error.to_string()))
    }
}

impl Drop for RunningPreview {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

pub(crate) fn start_design_preview(
    workspace_path: &Path,
    plan: &PreviewPlan,
    timeout: Duration,
) -> Result<RunningPreview, PreviewError> {
    validate_command(plan)?;
    let workspace = fs::canonicalize(workspace_path)
        .map_err(|error| PreviewError::Invalid(format!("workspace is unavailable: {error}")))?;
    if !workspace.is_dir() {
        return Err(PreviewError::Invalid(
            "workspace path must be a directory".into(),
        ));
    }
    let cwd = existing_workspace_path(&workspace, &plan.cwd, true)?;
    assert_runs_workspace_code(&workspace, &cwd, plan)?;

    let arguments = plan.args.iter().map(OsString::from).collect::<Vec<_>>();
    let argument_refs = arguments
        .iter()
        .map(OsString::as_os_str)
        .collect::<Vec<_>>();
    let options = SpawnOptions {
        cwd: Some(cwd),
        environment: safe_command_environment(&workspace).map_err(|error| {
            PreviewError::Process(format!(
                "could not create project-tool runtime directory: {error}"
            ))
        })?,
        replace_environment: true,
    };
    let mut child = spawn_cli(OsStr::new(&plan.command), &argument_refs, &options)
        .map_err(|error| PreviewError::Process(error.to_string()))?;
    drop(child.take_stdin());
    let output = Arc::new(Mutex::new(Vec::new()));
    let mut readers = Vec::new();
    if let Some(stdout) = child.take_stdout() {
        readers.push(spawn_output_reader(stdout, Arc::clone(&output)));
    }
    if let Some(stderr) = child.take_stderr() {
        readers.push(spawn_output_reader(stderr, Arc::clone(&output)));
    }

    if let Err(error) = wait_for_preview(&mut child, &plan.url, timeout, &output) {
        let _ = child.kill_tree();
        drop(child);
        for reader in readers {
            let _ = reader.join();
        }
        return Err(error);
    }

    Ok(RunningPreview {
        url: plan.url.clone(),
        viewports: plan.viewports.clone(),
        process: Mutex::new(PreviewProcess {
            child: Some(child),
            readers,
        }),
    })
}

fn validate_command(plan: &PreviewPlan) -> Result<(), PreviewError> {
    if !COMMANDS.contains(&plan.command.as_str()) {
        return Err(PreviewError::Invalid(
            "preview command is not allowed".into(),
        ));
    }
    if plan.args.iter().any(|argument| {
        argument
            .chars()
            .any(|character| "&|<>^%!\"\r\n()".contains(character))
    }) {
        return Err(PreviewError::Invalid(
            "preview command argument is unsafe".into(),
        ));
    }
    Ok(())
}

fn assert_runs_workspace_code(
    workspace: &Path,
    cwd: &Path,
    plan: &PreviewPlan,
) -> Result<(), PreviewError> {
    if plan.command == "node" {
        if !plan.args.iter().any(|argument| !argument.starts_with('-')) {
            return Err(PreviewError::Invalid(
                "preview command must name a script in the workspace".into(),
            ));
        }
        for argument in &plan.args {
            if argument.starts_with('-') && !argument.contains('/') && !argument.contains('\\') {
                continue;
            }
            let candidate = if argument.starts_with('-') {
                argument
                    .split_once('=')
                    .map_or(argument.as_str(), |(_, value)| value)
            } else {
                argument
            };
            let target = cwd.join(candidate);
            existing_absolute_workspace_path(workspace, &target, false)?;
        }
        return Ok(());
    }

    let named = plan
        .args
        .iter()
        .filter(|argument| !argument.starts_with('-'))
        .collect::<Vec<_>>();
    let script = if named
        .first()
        .is_some_and(|argument| argument.as_str() == "run")
    {
        named.get(1)
    } else {
        named.first()
    }
    .ok_or_else(|| PreviewError::Invalid("preview command must name a package script".into()))?;
    if !package_scripts(cwd)
        .iter()
        .any(|declared| declared == *script)
    {
        return Err(PreviewError::Invalid(format!(
            "preview script \"{script}\" is not declared in package.json"
        )));
    }
    Ok(())
}

fn package_scripts(cwd: &Path) -> Vec<String> {
    let Ok(text) = fs::read_to_string(cwd.join("package.json")) else {
        return Vec::new();
    };
    let Ok(manifest) = serde_json::from_str::<Value>(&text) else {
        return Vec::new();
    };
    manifest
        .get("scripts")
        .and_then(Value::as_object)
        .map(|scripts| scripts.keys().cloned().collect())
        .unwrap_or_default()
}

fn existing_workspace_path(
    workspace: &Path,
    relative_path: &str,
    directory: bool,
) -> Result<PathBuf, PreviewError> {
    if relative_path.is_empty() {
        return Err(PreviewError::Invalid(
            "workspace path must be a string".into(),
        ));
    }
    let relative = Path::new(relative_path);
    if relative.is_absolute() {
        return Err(PreviewError::Invalid(
            "workspace path must be relative".into(),
        ));
    }
    existing_absolute_workspace_path(workspace, &workspace.join(relative), directory)
}

fn existing_absolute_workspace_path(
    workspace: &Path,
    target: &Path,
    directory: bool,
) -> Result<PathBuf, PreviewError> {
    let real = fs::canonicalize(target).map_err(|error| {
        PreviewError::Invalid(format!("workspace path does not exist: {error}"))
    })?;
    if real.strip_prefix(workspace).is_err() {
        return Err(PreviewError::Invalid("path escapes the workspace".into()));
    }
    let metadata = fs::metadata(&real)
        .map_err(|error| PreviewError::Invalid(format!("could not inspect path: {error}")))?;
    if directory && !metadata.is_dir() {
        return Err(PreviewError::Invalid("path must be a directory".into()));
    }
    if !directory && !metadata.is_file() {
        return Err(PreviewError::Invalid("path must be a file".into()));
    }
    Ok(real)
}

fn wait_for_preview(
    child: &mut SpawnedChild,
    url: &str,
    timeout: Duration,
    output: &Mutex<Vec<u8>>,
) -> Result<(), PreviewError> {
    let client = reqwest::blocking::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|error| PreviewError::Process(error.to_string()))?;
    let started_at = Instant::now();
    while started_at.elapsed() < timeout {
        if child
            .try_wait()
            .map_err(|error| PreviewError::Process(error.to_string()))?
            .is_some()
        {
            return Err(PreviewError::Exited(output_text(output)));
        }
        if client
            .get(url)
            .send()
            .is_ok_and(|response| response.status().is_success())
        {
            return Ok(());
        }
        thread::sleep(POLL_INTERVAL);
    }
    Err(PreviewError::TimedOut {
        timeout_ms: timeout.as_millis(),
        output: output_text(output),
    })
}

fn spawn_output_reader(
    mut reader: impl Read + Send + 'static,
    output: Arc<Mutex<Vec<u8>>>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        let mut buffer = [0_u8; 8_192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => return,
                Ok(read) => append_tail(&mut lock(&output), &buffer[..read]),
            }
        }
    })
}

fn append_tail(output: &mut Vec<u8>, chunk: &[u8]) {
    if chunk.len() >= MAX_OUTPUT_BYTES {
        output.clear();
        output.extend_from_slice(&chunk[chunk.len() - MAX_OUTPUT_BYTES..]);
        return;
    }
    let excess = output
        .len()
        .saturating_add(chunk.len())
        .saturating_sub(MAX_OUTPUT_BYTES);
    if excess > 0 {
        output.drain(..excess);
    }
    output.extend_from_slice(chunk);
}

fn output_text(output: &Mutex<Vec<u8>>) -> String {
    String::from_utf8_lossy(&lock(output)).into_owned()
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;
    use harness_design_agent::parse_preview_plan;
    use serde_json::json;
    use std::net::TcpListener;

    fn plan(command: &str, args: &[&str], port: u16) -> PreviewPlan {
        parse_preview_plan(&json!({
            "version": 1,
            "command": command,
            "args": args,
            "cwd": ".",
            "url": format!("http://127.0.0.1:{port}"),
            "viewports": [{"name": "desktop", "width": 1440, "height": 1000}]
        }))
        .unwrap()
    }

    fn free_port() -> u16 {
        TcpListener::bind(("127.0.0.1", 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    #[test]
    fn starts_waits_for_and_stops_a_local_preview() {
        let workspace = tempfile::tempdir().unwrap();
        let port = free_port();
        fs::write(
            workspace.path().join("preview.mjs"),
            format!(
                "import {{ createServer }} from 'node:http';\ncreateServer((_request, response) => response.end('ready')).listen({port}, '127.0.0.1');\n"
            ),
        )
        .unwrap();
        let preview = start_design_preview(
            workspace.path(),
            &plan("node", &["preview.mjs"], port),
            Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(preview.url(), format!("http://127.0.0.1:{port}/"));
        assert_eq!(preview.viewports()[0].name, "desktop");
        assert_eq!(
            reqwest::blocking::get(preview.url())
                .unwrap()
                .text()
                .unwrap(),
            "ready"
        );
        preview.stop().unwrap();
        assert!(reqwest::blocking::get(preview.url()).is_err());
    }

    #[test]
    fn refuses_unsafe_or_non_workspace_execution() {
        let workspace = tempfile::tempdir().unwrap();
        fs::write(
            workspace.path().join("package.json"),
            r#"{"scripts":{"dev":"vite"}}"#,
        )
        .unwrap();
        let port = free_port();
        assert!(
            start_design_preview(
                workspace.path(),
                &plan("node", &["server.js&&whoami"], port),
                Duration::from_millis(10)
            )
            .err()
            .unwrap()
            .to_string()
            .contains("argument is unsafe")
        );
        assert!(
            start_design_preview(
                workspace.path(),
                &plan("pnpm", &["run", "evil"], port),
                Duration::from_millis(10)
            )
            .err()
            .unwrap()
            .to_string()
            .contains("not declared")
        );
        assert!(
            start_design_preview(
                workspace.path(),
                &plan("node", &["../outside.mjs"], port),
                Duration::from_millis(10)
            )
            .is_err()
        );
        assert!(
            start_design_preview(
                workspace.path(),
                &plan("npx", &["some-package"], port),
                Duration::from_millis(10)
            )
            .err()
            .unwrap()
            .to_string()
            .contains("not allowed")
        );
    }

    #[test]
    fn keeps_only_the_bounded_output_tail() {
        let mut output = vec![b'a'; MAX_OUTPUT_BYTES - 2];
        append_tail(&mut output, b"bcdef");
        assert_eq!(output.len(), MAX_OUTPUT_BYTES);
        assert!(output.ends_with(b"bcdef"));
    }
}
