use std::ffi::OsStr;
use std::io::{Read as _, Write as _};
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use thiserror::Error;

const POLL_INTERVAL: Duration = Duration::from_millis(10);

struct RunIo<'a> {
    input: Option<&'a [u8]>,
    trim_stdout: bool,
}

#[derive(Debug, Error)]
pub enum ProcessError {
    #[error("could not start {program}: {source}")]
    Start {
        program: String,
        source: std::io::Error,
    },
    #[error("{program} timed out")]
    TimedOut { program: String },
    #[error("{program} produced more output than the safety limit")]
    OutputTooLarge { program: String },
    #[error("{message}")]
    Failed { message: String },
    #[error("could not read {program} output: {source}")]
    Output {
        program: String,
        source: std::io::Error,
    },
    #[error("could not write to {program}: {source}")]
    Input {
        program: String,
        source: std::io::Error,
    },
    #[error("could not wait for {program}: {source}")]
    Wait {
        program: String,
        source: std::io::Error,
    },
    #[error("could not stop {program}: {source}")]
    Stop {
        program: String,
        source: std::io::Error,
    },
}

pub fn run(
    program: &OsStr,
    args: &[&OsStr],
    cwd: &Path,
    timeout: Duration,
    max_output: usize,
) -> Result<String, ProcessError> {
    run_inner(
        program,
        args,
        cwd,
        timeout,
        max_output,
        &[],
        RunIo {
            input: None,
            trim_stdout: true,
        },
    )
}

pub fn run_with_input(
    program: &OsStr,
    args: &[&OsStr],
    cwd: &Path,
    input: &[u8],
    timeout: Duration,
    max_output: usize,
) -> Result<String, ProcessError> {
    run_inner(
        program,
        args,
        cwd,
        timeout,
        max_output,
        &[],
        RunIo {
            input: Some(input),
            trim_stdout: true,
        },
    )
}

pub fn run_with_environment(
    program: &OsStr,
    args: &[&OsStr],
    cwd: &Path,
    timeout: Duration,
    max_output: usize,
    environment: &[(&OsStr, &OsStr)],
) -> Result<String, ProcessError> {
    run_inner(
        program,
        args,
        cwd,
        timeout,
        max_output,
        environment,
        RunIo {
            input: None,
            trim_stdout: true,
        },
    )
}

pub fn run_untrimmed(
    program: &OsStr,
    args: &[&OsStr],
    cwd: &Path,
    timeout: Duration,
    max_output: usize,
) -> Result<String, ProcessError> {
    run_inner(
        program,
        args,
        cwd,
        timeout,
        max_output,
        &[],
        RunIo {
            input: None,
            trim_stdout: false,
        },
    )
}

fn run_inner(
    program: &OsStr,
    args: &[&OsStr],
    cwd: &Path,
    timeout: Duration,
    max_output: usize,
    environment: &[(&OsStr, &OsStr)],
    io: RunIo<'_>,
) -> Result<String, ProcessError> {
    let display_program = program.to_string_lossy().into_owned();
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(if io.input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in environment {
        command.env(key, value);
    }
    let mut child = command.spawn().map_err(|source| ProcessError::Start {
        program: display_program.clone(),
        source,
    })?;
    let stdout = child.stdout.take().expect("piped stdout missing");
    let stderr = child.stderr.take().expect("piped stderr missing");
    let stdout_reader = thread::spawn(move || read_bounded(stdout, max_output));
    let stderr_reader = thread::spawn(move || read_bounded(stderr, max_output));
    if let Some(input) = io.input {
        let result = child
            .stdin
            .take()
            .expect("piped stdin missing")
            .write_all(input);
        if let Err(source) = result {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(ProcessError::Input {
                program: display_program,
                source,
            });
        }
    }
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(POLL_INTERVAL),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(ProcessError::TimedOut {
                    program: display_program,
                });
            }
            Err(source) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(ProcessError::Output {
                    program: display_program,
                    source,
                });
            }
        }
    };
    let stdout = join_output(stdout_reader, &display_program)?;
    let stderr = join_output(stderr_reader, &display_program)?;
    if stdout.exceeded || stderr.exceeded {
        return Err(ProcessError::OutputTooLarge {
            program: display_program,
        });
    }
    if !status.success() {
        let stderr = String::from_utf8_lossy(&stderr.bytes).trim().to_owned();
        return Err(ProcessError::Failed {
            message: if stderr.is_empty() {
                format!("{display_program} exited with {status}")
            } else {
                stderr
            },
        });
    }
    let stdout = String::from_utf8_lossy(&stdout.bytes);
    Ok(if io.trim_stdout {
        stdout.trim().to_owned()
    } else {
        stdout.into_owned()
    })
}

struct BoundedOutput {
    bytes: Vec<u8>,
    exceeded: bool,
}

fn read_bounded(reader: impl std::io::Read, max_output: usize) -> std::io::Result<BoundedOutput> {
    let mut bytes = Vec::new();
    reader
        .take((max_output as u64).saturating_add(1))
        .read_to_end(&mut bytes)?;
    let exceeded = bytes.len() > max_output;
    bytes.truncate(max_output);
    Ok(BoundedOutput { bytes, exceeded })
}

fn join_output(
    reader: thread::JoinHandle<std::io::Result<BoundedOutput>>,
    program: &str,
) -> Result<BoundedOutput, ProcessError> {
    reader
        .join()
        .unwrap_or_else(|_| Err(std::io::Error::other("output reader panicked")))
        .map_err(|source| ProcessError::Output {
            program: program.into(),
            source,
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_reader_flags_output_without_retaining_the_overflow() {
        let output = read_bounded(&b"123456"[..], 4).unwrap();
        assert_eq!(output.bytes, b"1234");
        assert!(output.exceeded);
    }

    #[test]
    fn bounded_reader_keeps_exactly_sized_output() {
        let output = read_bounded(&b"1234"[..], 4).unwrap();
        assert_eq!(output.bytes, b"1234");
        assert!(!output.exceeded);
    }
}
mod child;
mod jsonrpc;
mod ndjson;

pub use child::{
    CliOutput, SpawnOptions, SpawnedChild, command_version, is_installed, run_cli, run_direct,
    spawn_cli, spawn_direct,
};
pub use jsonrpc::{JsonRpcCall, JsonRpcError, RpcResponder, StdioJsonRpc};
pub use ndjson::{DEFAULT_MAX_NDJSON_LINE, NdjsonDecoder, NdjsonFrame, read_ndjson};
