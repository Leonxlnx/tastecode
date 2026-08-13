use crate::safe_command_environment::safe_command_environment;
use harness_adapter_api::{
    ApiTool, ApiToolCall, ApiToolError, ApiToolExecutor, ApiToolFactory, ApiToolResult,
    ApiToolReview, ApiToolSet,
};
use harness_proc::{SpawnOptions, spawn_cli};
use harness_protocol::{ApprovalKind, ApprovalMode};
use serde_json::{Map, Value, json};
use sha2::{Digest as _, Sha256};
use std::ffi::{OsStr, OsString};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write as _};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use uuid::Uuid;

const MAX_READ_BYTES: u64 = 200_000;
const MAX_WRITE_BYTES: usize = 1_000_000;
const MAX_OUTPUT_BYTES: usize = 100_000;
const MAX_DIRECTORY_ENTRIES: usize = 500;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(10);
const COMMANDS: &[&str] = &["bun", "git", "node", "npm", "npx", "pnpm", "yarn"];
const SECRET_NAMES: &[&str] = &[
    ".npmrc",
    ".pypirc",
    "credentials.json",
    "id_ed25519",
    "id_rsa",
];

pub(crate) struct ApiWorkspaceTools {
    workspace: PathBuf,
    approval: ApprovalMode,
    command_timeout: Duration,
}

pub(crate) struct ApiWorkspaceToolFactory;

impl ApiToolFactory for ApiWorkspaceToolFactory {
    fn create(
        &self,
        workspace_path: &str,
        approval: ApprovalMode,
    ) -> Result<ApiToolSet, ApiToolError> {
        Ok(ApiToolSet {
            definitions: ApiWorkspaceTools::definitions(),
            executor: Arc::new(ApiWorkspaceTools::new(workspace_path, approval)?),
        })
    }
}

impl ApiWorkspaceTools {
    pub(crate) fn new(
        workspace_path: impl AsRef<Path>,
        approval: ApprovalMode,
    ) -> Result<Self, ApiToolError> {
        let workspace = fs::canonicalize(workspace_path.as_ref())
            .map_err(|error| tool_error("workspace is unavailable", error))?;
        if !workspace.is_dir() {
            return Err(ApiToolError::new("workspace path must be a directory"));
        }
        Ok(Self {
            workspace,
            approval,
            command_timeout: COMMAND_TIMEOUT,
        })
    }

    pub(crate) fn definitions() -> Vec<ApiTool> {
        vec![
            ApiTool {
                name: "list_files".into(),
                description:
                    "List one directory inside the active workspace. Secret files are omitted."
                        .into(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Workspace-relative directory."
                        }
                    },
                    "required": ["path"],
                    "additionalProperties": false
                }),
            },
            ApiTool {
                name: "read_file".into(),
                description:
                    "Read a UTF-8 text file inside the workspace and return its SHA-256 hash."
                        .into(),
                input_schema: json!({
                    "type": "object",
                    "properties": { "path": { "type": "string" } },
                    "required": ["path"],
                    "additionalProperties": false
                }),
            },
            ApiTool {
                name: "write_file".into(),
                description: "Write a UTF-8 workspace file. Supply the hash returned by read_file, or null for a new file.".into(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" },
                        "content": { "type": "string" },
                        "expectedSha256": { "type": ["string", "null"] }
                    },
                    "required": ["path", "content", "expectedSha256"],
                    "additionalProperties": false
                }),
            },
            ApiTool {
                name: "run_command".into(),
                description: "Run an approved non-interactive project command without a shell expression. Supported executables: bun, git, node, npm, npx, pnpm, yarn.".into(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "command": { "type": "string" },
                        "args": { "type": "array", "items": { "type": "string" } },
                        "cwd": { "type": "string" }
                    },
                    "required": ["command", "args", "cwd"],
                    "additionalProperties": false
                }),
            },
        ]
    }

    fn list_files(&self, input: &Map<String, Value>) -> Result<ApiToolResult, ApiToolError> {
        let directory =
            self.existing_path(required_string(input, "path", "workspace path")?, true)?;
        let mut entries = Vec::new();
        for entry in fs::read_dir(directory)
            .map_err(|error| tool_error("could not list workspace directory", error))?
        {
            let entry =
                entry.map_err(|error| tool_error("could not list workspace directory", error))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if is_secret_workspace_name(&name) {
                continue;
            }
            let kind = if entry
                .file_type()
                .map_err(|error| tool_error("could not inspect workspace entry", error))?
                .is_dir()
            {
                "directory"
            } else {
                "file"
            };
            entries.push((name.clone(), format!("{kind}\t{name}")));
        }
        entries.sort_by(|left, right| left.0.cmp(&right.0));
        let content = entries
            .into_iter()
            .take(MAX_DIRECTORY_ENTRIES)
            .map(|(_, line)| line)
            .collect::<Vec<_>>()
            .join("\n");
        Ok(ApiToolResult::success(if content.is_empty() {
            "(empty directory)".into()
        } else {
            content
        }))
    }

    fn read_file(&self, input: &Map<String, Value>) -> Result<ApiToolResult, ApiToolError> {
        let display_path = required_string(input, "path", "workspace path")?;
        let file = self.existing_path(display_path, false)?;
        assert_public_workspace_file(&file)?;
        let metadata = fs::metadata(&file)
            .map_err(|error| tool_error("could not inspect workspace file", error))?;
        if metadata.len() > MAX_READ_BYTES {
            return Err(ApiToolError::new("file exceeds the read limit"));
        }
        let content = fs::read_to_string(file)
            .map_err(|error| tool_error("workspace file must be UTF-8 text", error))?;
        Ok(ApiToolResult::success(
            json!({
                "path": display_path,
                "sha256": sha256(&content),
                "content": content
            })
            .to_string(),
        ))
    }

    fn write_file(&self, input: &Map<String, Value>) -> Result<ApiToolResult, ApiToolError> {
        let display_path = required_string(input, "path", "workspace path")?;
        let destination = self.writable_path(display_path)?;
        assert_public_workspace_file(&destination)?;
        let content = required_text(input, "content", "write_file content")?;
        if content.len() > MAX_WRITE_BYTES {
            return Err(ApiToolError::new("file exceeds the write limit"));
        }
        let expected = nullable_string(input, "expectedSha256", "write_file expectedSha256")?;
        let current = if destination
            .try_exists()
            .map_err(|error| tool_error("could not inspect workspace file", error))?
        {
            Some(
                fs::read_to_string(&destination)
                    .map_err(|error| tool_error("workspace file must be UTF-8 text", error))?,
            )
        } else {
            None
        };
        if current.as_deref().map(sha256).as_deref() != expected {
            return Err(ApiToolError::new("file changed since it was read"));
        }
        let parent = destination
            .parent()
            .ok_or_else(|| ApiToolError::new("workspace destination has no parent"))?;
        fs::create_dir_all(parent)
            .map_err(|error| tool_error("could not create workspace directory", error))?;
        let temporary = sibling_temporary(&destination, "tmp")?;
        let backup = sibling_temporary(&destination, "bak")?;
        let mut temporary_file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| tool_error("could not create temporary workspace file", error))?;
        if let Err(error) = temporary_file
            .write_all(content.as_bytes())
            .and_then(|()| temporary_file.sync_all())
        {
            remove_temporary(&temporary);
            return Err(tool_error(
                "could not write temporary workspace file",
                error,
            ));
        }
        drop(temporary_file);

        let mut backed_up = false;
        let replace = (|| -> std::io::Result<()> {
            if destination.try_exists()? {
                fs::rename(&destination, &backup)?;
                backed_up = true;
            }
            fs::rename(&temporary, &destination)
        })();
        if let Err(error) = replace {
            remove_temporary(&temporary);
            let destination_exists = destination.try_exists().unwrap_or(false);
            if backed_up
                && !destination_exists
                && let Err(restore_error) = fs::rename(&backup, &destination)
            {
                return Err(tool_error(
                    "could not restore the original workspace file",
                    restore_error,
                ));
            }
            if destination_exists {
                remove_temporary(&backup);
            }
            return Err(tool_error("could not replace workspace file", error));
        }
        remove_temporary(&backup);
        Ok(ApiToolResult::success(
            json!({ "path": display_path, "sha256": sha256(content) }).to_string(),
        ))
    }

    fn run_command(
        &self,
        input: &Map<String, Value>,
        cancelled: &AtomicBool,
    ) -> Result<ApiToolResult, ApiToolError> {
        if cancelled.load(Ordering::Acquire) {
            return Err(ApiToolError::new("interrupted"));
        }
        let command = required_string(input, "command", "run_command command")?;
        if !COMMANDS.contains(&command) {
            return Err(ApiToolError::new(
                "command is not in the project-tool allowlist",
            ));
        }
        let args = string_array(input, "args", "run_command args")?;
        if args.iter().any(|argument| unsafe_argument(argument)) {
            return Err(ApiToolError::new("command argument is unsafe"));
        }
        let cwd = self.existing_path(required_string(input, "cwd", "workspace path")?, true)?;
        let arguments = args.iter().map(OsString::from).collect::<Vec<_>>();
        let argument_refs = arguments
            .iter()
            .map(OsString::as_os_str)
            .collect::<Vec<_>>();
        let options = SpawnOptions {
            cwd: Some(cwd),
            environment: safe_command_environment(&self.workspace).map_err(|error| {
                tool_error("could not create project-tool runtime directory", error)
            })?,
            replace_environment: true,
        };
        run_bounded_command(
            OsStr::new(command),
            &argument_refs,
            &options,
            self.command_timeout,
            cancelled,
        )
    }

    fn existing_path(&self, relative_path: &str, directory: bool) -> Result<PathBuf, ApiToolError> {
        let target = self.contained(relative_path)?;
        let real = fs::canonicalize(target)
            .map_err(|error| tool_error("workspace path does not exist", error))?;
        self.assert_contained(&real)?;
        let metadata = fs::metadata(&real)
            .map_err(|error| tool_error("could not inspect workspace path", error))?;
        if directory && !metadata.is_dir() {
            return Err(ApiToolError::new("path must be a directory"));
        }
        if !directory && !metadata.is_file() {
            return Err(ApiToolError::new("path must be a file"));
        }
        Ok(real)
    }

    fn writable_path(&self, relative_path: &str) -> Result<PathBuf, ApiToolError> {
        let target = self.contained(relative_path)?;
        if target
            .try_exists()
            .map_err(|error| tool_error("could not inspect workspace path", error))?
        {
            let real = fs::canonicalize(&target)
                .map_err(|error| tool_error("workspace path is unavailable", error))?;
            self.assert_contained(&real)?;
        }
        let mut ancestor = target
            .parent()
            .ok_or_else(|| ApiToolError::new("workspace is unavailable"))?;
        loop {
            if ancestor
                .try_exists()
                .map_err(|error| tool_error("workspace is unavailable", error))?
            {
                break;
            }
            ancestor = ancestor
                .parent()
                .ok_or_else(|| ApiToolError::new("workspace is unavailable"))?;
        }
        let real_ancestor = fs::canonicalize(ancestor)
            .map_err(|error| tool_error("workspace is unavailable", error))?;
        self.assert_contained(&real_ancestor)?;
        Ok(target)
    }

    fn contained(&self, relative_path: &str) -> Result<PathBuf, ApiToolError> {
        if relative_path.is_empty() {
            return Err(ApiToolError::new("workspace path must be a string"));
        }
        let relative = Path::new(relative_path);
        if relative.is_absolute() {
            return Err(ApiToolError::new("workspace path must be relative"));
        }
        let mut target = self.workspace.clone();
        for component in relative.components() {
            match component {
                Component::CurDir => {}
                Component::Normal(component) => target.push(component),
                Component::ParentDir if target != self.workspace => {
                    target.pop();
                }
                Component::ParentDir => {
                    return Err(ApiToolError::new("path escapes the workspace"));
                }
                Component::RootDir | Component::Prefix(_) => {
                    return Err(ApiToolError::new("workspace path must be relative"));
                }
            }
        }
        self.assert_contained(&target)?;
        Ok(target)
    }

    fn assert_contained(&self, target: &Path) -> Result<(), ApiToolError> {
        if target.strip_prefix(&self.workspace).is_err() {
            return Err(ApiToolError::new("path escapes the workspace"));
        }
        Ok(())
    }
}

impl ApiToolExecutor for ApiWorkspaceTools {
    fn review(&self, call: &ApiToolCall) -> Result<Option<ApiToolReview>, ApiToolError> {
        if self.approval == ApprovalMode::Full {
            return Ok(None);
        }
        let input = object(&call.input, &format!("{} input", call.name))?;
        match call.name.as_str() {
            "write_file" => Ok(Some(ApiToolReview {
                kind: ApprovalKind::FileChange,
                reason: Some("Modify a project file".into()),
                command: None,
                cwd: None,
                path: Some(display_path(input.get("path"))),
            })),
            "run_command" => Ok(Some(ApiToolReview {
                kind: ApprovalKind::Command,
                reason: Some("Run a project command".into()),
                command: Some(command_line(input)?),
                cwd: Some(display_path(input.get("cwd"))),
                path: None,
            })),
            _ => Ok(None),
        }
    }

    fn execute(
        &self,
        call: &ApiToolCall,
        cancelled: &AtomicBool,
    ) -> Result<ApiToolResult, ApiToolError> {
        if cancelled.load(Ordering::Acquire) {
            return Err(ApiToolError::new("interrupted"));
        }
        let input = object(&call.input, &format!("{} input", call.name))?;
        match call.name.as_str() {
            "list_files" => self.list_files(input),
            "read_file" => self.read_file(input),
            "write_file" => self.write_file(input),
            "run_command" => self.run_command(input, cancelled),
            name => Ok(ApiToolResult::error(format!("Unknown tool: {name}"))),
        }
    }
}

fn run_bounded_command(
    program: &OsStr,
    args: &[&OsStr],
    options: &SpawnOptions,
    timeout: Duration,
    cancelled: &AtomicBool,
) -> Result<ApiToolResult, ApiToolError> {
    let mut child = spawn_cli(program, args, options)
        .map_err(|error| ApiToolError::new(format!("could not start project command: {error}")))?;
    drop(child.take_stdin());
    let stdout = child
        .take_stdout()
        .ok_or_else(|| ApiToolError::new("project command stdout is unavailable"))?;
    let stderr = child
        .take_stderr()
        .ok_or_else(|| ApiToolError::new("project command stderr is unavailable"))?;
    let (sender, receiver) = mpsc::sync_channel(32);
    let readers = vec![
        spawn_output_reader(stdout, sender.clone()),
        spawn_output_reader(stderr, sender),
    ];
    let deadline = Instant::now() + timeout;
    let mut output = Vec::new();
    let mut readers_done = 0;
    let mut status = None;
    let mut terminated = None;
    let mut reader_error = None;
    let mut stop_error = None;

    while status.is_none() || readers_done < readers.len() {
        if terminated.is_none() && cancelled.load(Ordering::Acquire) {
            terminated = Some(CommandTermination::Cancelled);
            if let Err(error) = child.kill_tree() {
                stop_error = Some(error.to_string());
            }
            status = Some(None);
        } else if terminated.is_none() && Instant::now() >= deadline {
            terminated = Some(CommandTermination::TimedOut);
            if let Err(error) = child.kill_tree() {
                stop_error = Some(error.to_string());
            }
            status = Some(None);
        }

        if status.is_none() {
            match child.try_wait() {
                Ok(Some(exit)) => status = Some(exit.code()),
                Ok(None) => {}
                Err(error) => {
                    reader_error = Some(error.to_string());
                    let _ = child.kill_tree();
                    status = Some(None);
                }
            }
        }

        match receiver.recv_timeout(PROCESS_POLL_INTERVAL) {
            Ok(OutputEvent::Chunk(chunk)) => append_tail(&mut output, &chunk),
            Ok(OutputEvent::Error(error)) => {
                reader_error.get_or_insert(error);
                if status.is_none() {
                    let _ = child.kill_tree();
                    status = Some(None);
                }
            }
            Ok(OutputEvent::Done) => readers_done += 1,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                readers_done = readers.len();
            }
        }
    }
    for reader in readers {
        if reader.join().is_err() {
            reader_error.get_or_insert_with(|| "project command output reader panicked".into());
        }
    }
    while let Ok(event) = receiver.try_recv() {
        if let OutputEvent::Chunk(chunk) = event {
            append_tail(&mut output, &chunk);
        }
    }

    if let Some(error) = stop_error {
        return Err(ApiToolError::new(format!(
            "could not stop project command: {error}"
        )));
    }
    if matches!(terminated, Some(CommandTermination::Cancelled)) {
        return Err(ApiToolError::new("interrupted"));
    }
    let output = String::from_utf8_lossy(&output).into_owned();
    if matches!(terminated, Some(CommandTermination::TimedOut)) {
        return Ok(ApiToolResult::error(
            json!({
                "code": Value::Null,
                "output": output,
                "error": "command exceeded the 120 second limit"
            })
            .to_string(),
        ));
    }
    if let Some(error) = reader_error {
        return Err(ApiToolError::new(format!(
            "could not read project command output: {error}"
        )));
    }
    let code = status.flatten();
    let content = json!({ "code": code, "output": output }).to_string();
    Ok(if code == Some(0) {
        ApiToolResult::success(content)
    } else {
        ApiToolResult::error(content)
    })
}

enum CommandTermination {
    Cancelled,
    TimedOut,
}

enum OutputEvent {
    Chunk(Vec<u8>),
    Error(String),
    Done,
}

fn spawn_output_reader(
    mut reader: impl Read + Send + 'static,
    sender: mpsc::SyncSender<OutputEvent>,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        let mut buffer = [0_u8; 8_192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    if sender
                        .send(OutputEvent::Chunk(buffer[..read].to_vec()))
                        .is_err()
                    {
                        return;
                    }
                }
                Err(error) => {
                    let _ = sender.send(OutputEvent::Error(error.to_string()));
                    break;
                }
            }
        }
        let _ = sender.send(OutputEvent::Done);
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

fn sibling_temporary(destination: &Path, suffix: &str) -> Result<PathBuf, ApiToolError> {
    let parent = destination
        .parent()
        .ok_or_else(|| ApiToolError::new("workspace destination has no parent"))?;
    let file_name = destination
        .file_name()
        .ok_or_else(|| ApiToolError::new("workspace destination has no file name"))?;
    let mut temporary = file_name.to_os_string();
    temporary.push(format!(".{}.{suffix}", Uuid::new_v4()));
    Ok(parent.join(temporary))
}

fn remove_temporary(path: &Path) {
    let _ = fs::remove_file(path);
}

fn assert_public_workspace_file(file: &Path) -> Result<(), ApiToolError> {
    if file.components().any(|component| {
        let Component::Normal(name) = component else {
            return false;
        };
        is_secret_workspace_name(&name.to_string_lossy())
    }) {
        return Err(ApiToolError::new("credential files are not available"));
    }
    Ok(())
}

fn is_secret_workspace_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower == ".git"
        || lower == ".env"
        || lower.starts_with(".env.")
        || SECRET_NAMES.contains(&lower.as_str())
        || ["key", "p12", "pem", "pfx"]
            .iter()
            .any(|extension| lower.ends_with(&format!(".{extension}")))
}

fn object<'a>(value: &'a Value, field: &str) -> Result<&'a Map<String, Value>, ApiToolError> {
    value
        .as_object()
        .ok_or_else(|| ApiToolError::new(format!("{field} must be an object")))
}

fn required_string<'a>(
    input: &'a Map<String, Value>,
    key: &str,
    field: &str,
) -> Result<&'a str, ApiToolError> {
    input
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ApiToolError::new(format!("{field} must be a string")))
}

fn required_text<'a>(
    input: &'a Map<String, Value>,
    key: &str,
    field: &str,
) -> Result<&'a str, ApiToolError> {
    input
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| ApiToolError::new(format!("{field} must be a string")))
}

fn nullable_string<'a>(
    input: &'a Map<String, Value>,
    key: &str,
    field: &str,
) -> Result<Option<&'a str>, ApiToolError> {
    match input.get(key) {
        Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if !value.is_empty() => Ok(Some(value)),
        _ => Err(ApiToolError::new(format!(
            "{field} must be a string or null"
        ))),
    }
}

fn string_array<'a>(
    input: &'a Map<String, Value>,
    key: &str,
    field: &str,
) -> Result<Vec<&'a str>, ApiToolError> {
    input
        .get(key)
        .and_then(Value::as_array)
        .filter(|values| values.iter().all(Value::is_string))
        .map(|values| values.iter().filter_map(Value::as_str).collect())
        .ok_or_else(|| ApiToolError::new(format!("{field} must be a string array")))
}

fn command_line(input: &Map<String, Value>) -> Result<String, ApiToolError> {
    let command = required_string(input, "command", "run_command command")?;
    let args = string_array(input, "args", "run_command args")?;
    Ok(std::iter::once(command)
        .chain(args)
        .collect::<Vec<_>>()
        .join(" "))
}

fn display_path(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(".")
        .into()
}

fn unsafe_argument(argument: &str) -> bool {
    argument.chars().any(|character| {
        matches!(
            character,
            '&' | '|' | '<' | '>' | '^' | '%' | '!' | '"' | '\r' | '\n' | '(' | ')'
        )
    })
}

fn sha256(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn tool_error(context: &str, error: impl std::fmt::Display) -> ApiToolError {
    ApiToolError::new(format!("{context}: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn reads_with_a_hash_and_rejects_stale_writes() {
        let workspace = workspace();
        let tools = ApiWorkspaceTools::new(workspace.path(), ApprovalMode::Ask).unwrap();
        let cancelled = AtomicBool::new(false);
        let read = tools
            .execute(
                &call("read_file", json!({ "path": "src/app.ts" })),
                &cancelled,
            )
            .unwrap();
        let read: Value = serde_json::from_str(&read.content).unwrap();
        assert!(read["content"].as_str().unwrap().contains("value = 1"));

        tools
            .execute(
                &call(
                    "write_file",
                    json!({
                        "path": "src/app.ts",
                        "content": "export const value = 2\n",
                        "expectedSha256": read["sha256"]
                    }),
                ),
                &cancelled,
            )
            .unwrap();
        assert!(
            fs::read_to_string(workspace.path().join("src/app.ts"))
                .unwrap()
                .contains("value = 2")
        );
        let stale = tools
            .execute(
                &call(
                    "write_file",
                    json!({
                        "path": "src/app.ts",
                        "content": "stale",
                        "expectedSha256": read["sha256"]
                    }),
                ),
                &cancelled,
            )
            .unwrap_err();
        assert_eq!(stale.to_string(), "file changed since it was read");
        assert!(
            fs::read_dir(workspace.path().join("src"))
                .unwrap()
                .all(|entry| !entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .contains(".bak"))
        );
    }

    #[test]
    fn hides_credentials_and_refuses_workspace_escapes() {
        let workspace = workspace();
        let tools = ApiWorkspaceTools::new(workspace.path(), ApprovalMode::Ask).unwrap();
        let cancelled = AtomicBool::new(false);
        let listed = tools
            .execute(&call("list_files", json!({ "path": "." })), &cancelled)
            .unwrap();
        assert!(!listed.content.contains(".env"));
        assert!(!listed.content.contains("private.pem"));
        assert!(
            tools
                .execute(&call("read_file", json!({ "path": ".env" })), &cancelled)
                .unwrap_err()
                .to_string()
                .contains("credential files")
        );
        assert_eq!(
            tools
                .execute(
                    &call("read_file", json!({ "path": "../outside.txt" })),
                    &cancelled,
                )
                .unwrap_err()
                .to_string(),
            "path escapes the workspace"
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_that_leave_the_workspace() {
        use std::os::unix::fs::symlink;

        let workspace = workspace();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "outside").unwrap();
        symlink(
            outside.path().join("secret.txt"),
            workspace.path().join("linked.txt"),
        )
        .unwrap();
        symlink(outside.path(), workspace.path().join("linked-dir")).unwrap();
        let tools = ApiWorkspaceTools::new(workspace.path(), ApprovalMode::Ask).unwrap();
        let cancelled = AtomicBool::new(false);

        assert!(
            tools
                .execute(
                    &call("read_file", json!({ "path": "linked.txt" })),
                    &cancelled,
                )
                .unwrap_err()
                .to_string()
                .contains("escapes")
        );
        assert!(
            tools
                .execute(
                    &call("list_files", json!({ "path": "linked-dir" })),
                    &cancelled,
                )
                .unwrap_err()
                .to_string()
                .contains("escapes")
        );
        assert!(
            tools
                .execute(
                    &call(
                        "write_file",
                        json!({
                            "path": "linked-dir/new.txt",
                            "content": "no",
                            "expectedSha256": null
                        }),
                    ),
                    &cancelled,
                )
                .unwrap_err()
                .to_string()
                .contains("escapes")
        );
    }

    #[test]
    fn reviews_mutations_unless_full_access_was_explicit() {
        let workspace = workspace();
        let ask = ApiWorkspaceTools::new(workspace.path(), ApprovalMode::Auto).unwrap();
        assert!(matches!(
            ask.review(&call(
                "write_file",
                json!({ "path": "src/app.ts" })
            ))
            .unwrap(),
            Some(ApiToolReview {
                kind: ApprovalKind::FileChange,
                path: Some(path),
                ..
            }) if path == "src/app.ts"
        ));
        let full = ApiWorkspaceTools::new(workspace.path(), ApprovalMode::Full).unwrap();
        assert!(
            full.review(&call("write_file", Value::Null))
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn runs_only_shell_free_allowlisted_commands_in_an_isolated_environment() {
        let workspace = workspace();
        let tools = ApiWorkspaceTools::new(workspace.path(), ApprovalMode::Full).unwrap();
        let cancelled = AtomicBool::new(false);
        let result = tools
            .execute(
                &call(
                    "run_command",
                    json!({ "command": "git", "args": ["--version"], "cwd": "." }),
                ),
                &cancelled,
            )
            .unwrap();
        assert!(!result.is_error, "{}", result.content);
        assert!(result.content.contains("git version"));

        let unsafe_call = tools
            .execute(
                &call(
                    "run_command",
                    json!({
                        "command": "git",
                        "args": ["--version&&whoami"],
                        "cwd": "."
                    }),
                ),
                &cancelled,
            )
            .unwrap_err();
        assert_eq!(unsafe_call.to_string(), "command argument is unsafe");
        let environment = safe_command_environment(workspace.path()).unwrap();
        assert!(!environment.iter().any(|(key, _)| key == "HARNESS_HIDDEN"));
        assert!(
            environment
                .iter()
                .any(|(key, value)| { key == "GIT_TERMINAL_PROMPT" && value == "0" })
        );
    }

    #[test]
    fn cancellation_prevents_a_command_from_starting() {
        let workspace = workspace();
        let tools = ApiWorkspaceTools::new(workspace.path(), ApprovalMode::Full).unwrap();
        let cancelled = AtomicBool::new(true);
        assert_eq!(
            tools
                .execute(
                    &call(
                        "run_command",
                        json!({ "command": "git", "args": ["--version"], "cwd": "." }),
                    ),
                    &cancelled,
                )
                .unwrap_err()
                .to_string(),
            "interrupted"
        );
    }

    #[test]
    fn exposes_exactly_the_four_bounded_workspace_tools() {
        assert_eq!(
            ApiWorkspaceTools::definitions()
                .into_iter()
                .map(|tool| tool.name)
                .collect::<Vec<_>>(),
            ["list_files", "read_file", "write_file", "run_command"]
        );
        let mut output = vec![b'a'; MAX_OUTPUT_BYTES - 2];
        append_tail(&mut output, b"tail");
        assert_eq!(output.len(), MAX_OUTPUT_BYTES);
        assert!(output.ends_with(b"tail"));
    }

    fn workspace() -> TempDir {
        let workspace = tempfile::tempdir().unwrap();
        fs::create_dir(workspace.path().join("src")).unwrap();
        fs::write(
            workspace.path().join("src/app.ts"),
            "export const value = 1\n",
        )
        .unwrap();
        fs::write(workspace.path().join(".env"), "TOKEN=never-read").unwrap();
        fs::write(workspace.path().join("private.pem"), "never-read").unwrap();
        workspace
    }

    fn call(name: &str, input: Value) -> ApiToolCall {
        ApiToolCall {
            id: format!("call-{name}"),
            name: name.into(),
            input,
        }
    }
}
