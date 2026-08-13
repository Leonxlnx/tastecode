use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{Read as _, Write as _};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use thiserror::Error;
use uuid::Uuid;

const MIN_TERMINAL_SIZE: u16 = 1;
const MAX_TERMINAL_SIZE: u16 = 1_000;

type OutputHandler = dyn Fn(String, String) + Send + Sync;
type ExitHandler = dyn Fn(String, Option<i32>) + Send + Sync;

#[derive(Clone)]
pub struct TerminalManager {
    inner: Arc<TerminalInner>,
}

struct TerminalInner {
    terminals: Mutex<TerminalMaps>,
    on_output: Arc<OutputHandler>,
    on_exit: Arc<ExitHandler>,
}

#[derive(Default)]
struct TerminalMaps {
    by_id: HashMap<String, Arc<TerminalEntry>>,
    by_key: HashMap<String, String>,
}

struct TerminalEntry {
    key: String,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn std::io::Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    output_gate: Arc<OutputGate>,
}

struct OutputGate {
    enabled: AtomicBool,
    callback: Mutex<()>,
}

#[derive(Debug, Error)]
pub enum TerminalError {
    #[error("terminal dimensions must be between 1 and 1000")]
    InvalidSize,
    #[error("no such terminal: {0}")]
    NotFound(String),
    #[error("could not start terminal: {0}")]
    Spawn(String),
    #[error("could not write to terminal: {0}")]
    Write(String),
    #[error("could not resize terminal: {0}")]
    Resize(String),
    #[error("terminal state mutex poisoned")]
    Poisoned,
    #[error("could not start terminal worker: {0}")]
    Worker(#[from] std::io::Error),
}

impl TerminalManager {
    pub fn new<O, E>(on_output: O, on_exit: E) -> Self
    where
        O: Fn(String, String) + Send + Sync + 'static,
        E: Fn(String, Option<i32>) + Send + Sync + 'static,
    {
        Self {
            inner: Arc::new(TerminalInner {
                terminals: Mutex::new(TerminalMaps::default()),
                on_output: Arc::new(on_output),
                on_exit: Arc::new(on_exit),
            }),
        }
    }

    pub fn open(
        &self,
        thread_id: &str,
        cwd: impl AsRef<Path>,
        columns: u16,
        rows: u16,
    ) -> Result<String, TerminalError> {
        self.spawn(thread_id, &[], cwd.as_ref(), columns, rows)
    }

    pub fn run(
        &self,
        key: &str,
        command: &str,
        cwd: impl AsRef<Path>,
        columns: u16,
        rows: u16,
    ) -> Result<String, TerminalError> {
        #[cfg(target_os = "windows")]
        let args = ["/d", "/s", "/c", command];
        #[cfg(not(target_os = "windows"))]
        let args = ["-c", command];
        self.spawn(key, &args, cwd.as_ref(), columns, rows)
    }

    pub fn write(&self, terminal_id: &str, data: &str) -> Result<(), TerminalError> {
        let entry = self.entry(terminal_id)?;
        let mut writer = entry.writer.lock().map_err(|_| TerminalError::Poisoned)?;
        writer
            .write_all(data.as_bytes())
            .and_then(|_| writer.flush())
            .map_err(|error| TerminalError::Write(error.to_string()))
    }

    pub fn resize(&self, terminal_id: &str, columns: u16, rows: u16) -> Result<(), TerminalError> {
        validate_size(columns, rows)?;
        let entry = self.entry(terminal_id)?;
        entry
            .master
            .lock()
            .map_err(|_| TerminalError::Poisoned)?
            .resize(pty_size(columns, rows))
            .map_err(|error| TerminalError::Resize(error.to_string()))
    }

    pub fn close(&self, terminal_id: &str) {
        let entry = {
            let Ok(mut terminals) = self.inner.terminals.lock() else {
                return;
            };
            let Some(entry) = terminals.by_id.remove(terminal_id) else {
                return;
            };
            if terminals.by_key.get(&entry.key).map(String::as_str) == Some(terminal_id) {
                terminals.by_key.remove(&entry.key);
            }
            entry
        };
        stop_entry(&entry);
    }

    pub fn close_thread(&self, thread_id: &str) {
        let terminal_id = self
            .inner
            .terminals
            .lock()
            .ok()
            .and_then(|terminals| terminals.by_key.get(thread_id).cloned());
        if let Some(terminal_id) = terminal_id {
            self.close(&terminal_id);
        }
    }

    pub fn close_all(&self) {
        let terminal_ids = self
            .inner
            .terminals
            .lock()
            .map(|terminals| terminals.by_id.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for terminal_id in terminal_ids {
            self.close(&terminal_id);
        }
    }

    fn spawn(
        &self,
        key: &str,
        args: &[&str],
        cwd: &Path,
        columns: u16,
        rows: u16,
    ) -> Result<String, TerminalError> {
        validate_size(columns, rows)?;
        let mut terminals = self
            .inner
            .terminals
            .lock()
            .map_err(|_| TerminalError::Poisoned)?;
        if let Some(terminal_id) = terminals.by_key.get(key).cloned() {
            drop(terminals);
            self.resize(&terminal_id, columns, rows)?;
            return Ok(terminal_id);
        }

        let pair = native_pty_system()
            .openpty(pty_size(columns, rows))
            .map_err(|error| TerminalError::Spawn(error.to_string()))?;
        let mut builder = CommandBuilder::new(platform_shell());
        builder.args(args);
        builder.cwd(cwd);
        builder.env("TERM", "xterm-256color");
        let mut child = pair
            .slave
            .spawn_command(builder)
            .map_err(|error| TerminalError::Spawn(error.to_string()))?;
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| TerminalError::Spawn(error.to_string()))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| TerminalError::Spawn(error.to_string()))?;
        let killer = child.clone_killer();
        drop(pair.slave);

        let terminal_id = Uuid::new_v4().to_string();
        let output_gate = Arc::new(OutputGate {
            enabled: AtomicBool::new(true),
            callback: Mutex::new(()),
        });
        let entry = Arc::new(TerminalEntry {
            key: key.into(),
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            killer: Mutex::new(killer),
            output_gate: Arc::clone(&output_gate),
        });
        terminals.by_key.insert(key.into(), terminal_id.clone());
        terminals
            .by_id
            .insert(terminal_id.clone(), Arc::clone(&entry));
        drop(terminals);

        let output_id = terminal_id.clone();
        let on_output = Arc::clone(&self.inner.on_output);
        let output_worker = match std::thread::Builder::new()
            .name("harness-terminal-output".into())
            .spawn(move || read_output(reader, output_gate, &output_id, on_output))
        {
            Ok(worker) => worker,
            Err(error) => {
                self.close(&terminal_id);
                return Err(error.into());
            }
        };

        let exit_id = terminal_id.clone();
        let exit_key = key.to_owned();
        let inner = Arc::downgrade(&self.inner);
        if let Err(error) = std::thread::Builder::new()
            .name("harness-terminal-exit".into())
            .spawn(move || {
                let exit_code = child
                    .wait()
                    .ok()
                    .and_then(|status| i32::try_from(status.exit_code()).ok());
                let _ = output_worker.join();
                handle_exit(inner, &exit_id, &exit_key, exit_code);
            })
        {
            self.close(&terminal_id);
            return Err(error.into());
        }
        Ok(terminal_id)
    }

    fn entry(&self, terminal_id: &str) -> Result<Arc<TerminalEntry>, TerminalError> {
        self.inner
            .terminals
            .lock()
            .map_err(|_| TerminalError::Poisoned)?
            .by_id
            .get(terminal_id)
            .cloned()
            .ok_or_else(|| TerminalError::NotFound(terminal_id.into()))
    }
}

impl Drop for TerminalInner {
    fn drop(&mut self) {
        let Ok(terminals) = self.terminals.get_mut() else {
            return;
        };
        for entry in terminals.by_id.values() {
            stop_entry(entry);
        }
        terminals.by_id.clear();
        terminals.by_key.clear();
    }
}

fn stop_entry(entry: &TerminalEntry) {
    let callback = entry.output_gate.callback.lock();
    entry.output_gate.enabled.store(false, Ordering::Release);
    drop(callback);
    if let Ok(mut killer) = entry.killer.lock() {
        let _ = killer.kill();
    }
}

fn handle_exit(inner: Weak<TerminalInner>, terminal_id: &str, key: &str, exit_code: Option<i32>) {
    let Some(inner) = inner.upgrade() else {
        return;
    };
    if let Ok(mut terminals) = inner.terminals.lock() {
        terminals.by_id.remove(terminal_id);
        if terminals.by_key.get(key).map(String::as_str) == Some(terminal_id) {
            terminals.by_key.remove(key);
        }
    }
    (inner.on_exit)(terminal_id.into(), exit_code);
}

fn read_output(
    mut reader: Box<dyn std::io::Read + Send>,
    output_gate: Arc<OutputGate>,
    terminal_id: &str,
    on_output: Arc<OutputHandler>,
) {
    let mut bytes = [0_u8; 8192];
    let mut pending = Vec::new();
    loop {
        match reader.read(&mut bytes) {
            Ok(0) => {
                let text = finish_utf8(&mut pending);
                if !text.is_empty() {
                    emit_output(&output_gate, terminal_id, text, &on_output);
                }
                return;
            }
            Ok(read) => {
                let text = decode_utf8(&mut pending, &bytes[..read]);
                if !output_gate.enabled.load(Ordering::Acquire) {
                    return;
                }
                if !text.is_empty() {
                    emit_output(&output_gate, terminal_id, text, &on_output);
                }
            }
            Err(_) => return,
        }
    }
}

fn emit_output(
    output_gate: &OutputGate,
    terminal_id: &str,
    text: String,
    on_output: &Arc<OutputHandler>,
) {
    let Ok(_callback) = output_gate.callback.lock() else {
        return;
    };
    if output_gate.enabled.load(Ordering::Acquire) {
        on_output(terminal_id.into(), text);
    }
}

fn decode_utf8(pending: &mut Vec<u8>, bytes: &[u8]) -> String {
    pending.extend_from_slice(bytes);
    let mut decoded = String::new();
    loop {
        match std::str::from_utf8(pending) {
            Ok(text) => {
                decoded.push_str(text);
                pending.clear();
                break;
            }
            Err(error) => {
                let valid = error.valid_up_to();
                if valid > 0 {
                    decoded.push_str(std::str::from_utf8(&pending[..valid]).unwrap_or_default());
                    pending.drain(..valid);
                }
                let Some(invalid) = error.error_len() else {
                    break;
                };
                decoded.push('\u{fffd}');
                pending.drain(..invalid);
            }
        }
    }
    decoded
}

fn finish_utf8(pending: &mut Vec<u8>) -> String {
    let decoded = String::from_utf8_lossy(pending).into_owned();
    pending.clear();
    decoded
}

fn validate_size(columns: u16, rows: u16) -> Result<(), TerminalError> {
    if !(MIN_TERMINAL_SIZE..=MAX_TERMINAL_SIZE).contains(&columns)
        || !(MIN_TERMINAL_SIZE..=MAX_TERMINAL_SIZE).contains(&rows)
    {
        return Err(TerminalError::InvalidSize);
    }
    Ok(())
}

fn pty_size(columns: u16, rows: u16) -> PtySize {
    PtySize {
        rows,
        cols: columns,
        pixel_width: 0,
        pixel_height: 0,
    }
}

pub fn platform_shell() -> OsString {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("ComSpec")
            .or_else(|| std::env::var_os("COMSPEC"))
            .unwrap_or_else(|| "cmd.exe".into())
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var_os("SHELL").unwrap_or_else(|| "/bin/sh".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    #[test]
    fn decoder_preserves_codepoints_split_across_reads() {
        let mut pending = Vec::new();
        assert_eq!(decode_utf8(&mut pending, &[0xe2, 0x82]), "");
        assert_eq!(decode_utf8(&mut pending, &[0xac, b'!']), "€!");
        assert!(pending.is_empty());
    }

    #[test]
    fn runs_one_real_pty_per_key_and_reports_exit() {
        let cwd = tempfile::tempdir().unwrap();
        let (output_tx, output_rx) = mpsc::channel::<String>();
        let (exit_tx, exit_rx) = mpsc::channel::<(String, Option<i32>)>();
        let manager = TerminalManager::new(
            move |_terminal_id, output| {
                let _ = output_tx.send(output);
            },
            move |terminal_id, exit_code| {
                let _ = exit_tx.send((terminal_id, exit_code));
            },
        );
        let terminal_id = manager.open("thread-1", cwd.path(), 80, 24).unwrap();
        assert_eq!(
            manager.open("thread-1", cwd.path(), 100, 30).unwrap(),
            terminal_id
        );
        #[cfg(target_os = "windows")]
        manager.write(&terminal_id, "cd\r").unwrap();
        #[cfg(not(target_os = "windows"))]
        manager.write(&terminal_id, "pwd\r").unwrap();

        let deadline = Instant::now() + Duration::from_secs(10);
        let mut output = String::new();
        while !output.contains(&cwd.path().to_string_lossy().to_string()) {
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(
                !remaining.is_zero(),
                "terminal did not report its cwd: {output}"
            );
            output.push_str(&output_rx.recv_timeout(remaining).unwrap());
        }
        manager.write(&terminal_id, "exit\r").unwrap();
        assert_eq!(
            exit_rx.recv_timeout(Duration::from_secs(10)).unwrap(),
            (terminal_id.clone(), Some(0))
        );
        assert!(matches!(
            manager.write(&terminal_id, "after exit"),
            Err(TerminalError::NotFound(_))
        ));
        manager.close_all();
    }

    #[test]
    fn one_shot_commands_reattach_while_running() {
        let cwd = tempfile::tempdir().unwrap();
        let output = Arc::new(Mutex::new(String::new()));
        let output_for_handler = Arc::clone(&output);
        let (exit_tx, exit_rx) = mpsc::channel();
        let manager = TerminalManager::new(
            move |_terminal_id, chunk| {
                output_for_handler.lock().unwrap().push_str(&chunk);
            },
            move |terminal_id, exit_code| {
                let _ = exit_tx.send((terminal_id, exit_code));
            },
        );
        #[cfg(target_os = "windows")]
        let command = "echo harness-run-done && ping -n 2 127.0.0.1 > NUL";
        #[cfg(not(target_os = "windows"))]
        let command = "echo harness-run-done && sleep 1";
        let terminal_id = manager
            .run("install:probe", command, cwd.path(), 80, 24)
            .unwrap();
        assert_eq!(
            manager
                .run("install:probe", "echo something-else", cwd.path(), 100, 30,)
                .unwrap(),
            terminal_id
        );
        assert_eq!(
            exit_rx.recv_timeout(Duration::from_secs(10)).unwrap(),
            (terminal_id, Some(0))
        );
        let output = output.lock().unwrap();
        assert!(output.contains("harness-run-done"));
        assert!(!output.contains("something-else"));
    }

    #[test]
    fn close_thread_stops_the_pty_and_stale_close_does_not_unmap_a_new_one() {
        let cwd = tempfile::tempdir().unwrap();
        let (exit_tx, exit_rx) = mpsc::channel();
        let manager = TerminalManager::new(
            |_terminal_id, _output| {},
            move |terminal_id, _exit_code| {
                let _ = exit_tx.send(terminal_id);
            },
        );
        let first = manager.open("thread-1", cwd.path(), 80, 24).unwrap();
        manager.close_thread("thread-1");
        assert!(matches!(
            manager.resize(&first, 100, 30),
            Err(TerminalError::NotFound(_))
        ));
        assert_eq!(
            exit_rx.recv_timeout(Duration::from_secs(10)).unwrap(),
            first
        );

        let second = manager.open("thread-1", cwd.path(), 80, 24).unwrap();
        manager.close(&first);
        assert_eq!(
            manager.open("thread-1", cwd.path(), 80, 24).unwrap(),
            second
        );
        manager.close_all();
    }
}
