use super::{ProcessError, join_output, read_bounded};
use std::ffi::{OsStr, OsString};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const POLL_INTERVAL: Duration = Duration::from_millis(10);

#[derive(Clone, Debug, Default)]
pub struct SpawnOptions {
    pub cwd: Option<PathBuf>,
    pub environment: Vec<(OsString, OsString)>,
    pub replace_environment: bool,
}

impl SpawnOptions {
    pub fn cwd(mut self, cwd: impl Into<PathBuf>) -> Self {
        self.cwd = Some(cwd.into());
        self
    }

    pub fn env(mut self, key: impl Into<OsString>, value: impl Into<OsString>) -> Self {
        self.environment.push((key.into(), value.into()));
        self
    }

    pub fn replace_environment(mut self, replace: bool) -> Self {
        self.replace_environment = replace;
        self
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CliOutput {
    pub code: Option<i32>,
    pub stdout: String,
}

pub struct SpawnedChild {
    label: String,
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: Option<ChildStdout>,
    stderr: Option<ChildStderr>,
}

impl SpawnedChild {
    pub fn id(&self) -> u32 {
        self.child.id()
    }

    pub fn take_stdin(&mut self) -> Option<ChildStdin> {
        self.stdin.take()
    }

    pub fn take_stdout(&mut self) -> Option<ChildStdout> {
        self.stdout.take()
    }

    pub fn take_stderr(&mut self) -> Option<ChildStderr> {
        self.stderr.take()
    }

    pub fn write_all(&mut self, bytes: &[u8]) -> Result<(), ProcessError> {
        let stdin = self.stdin.as_mut().ok_or_else(|| ProcessError::Input {
            program: self.label.clone(),
            source: std::io::Error::new(std::io::ErrorKind::BrokenPipe, "stdin is closed"),
        })?;
        stdin
            .write_all(bytes)
            .and_then(|()| stdin.flush())
            .map_err(|source| ProcessError::Input {
                program: self.label.clone(),
                source,
            })
    }

    pub fn try_wait(&mut self) -> Result<Option<ExitStatus>, ProcessError> {
        self.child.try_wait().map_err(|source| ProcessError::Wait {
            program: self.label.clone(),
            source,
        })
    }

    pub fn wait(&mut self) -> Result<ExitStatus, ProcessError> {
        self.child.wait().map_err(|source| ProcessError::Wait {
            program: self.label.clone(),
            source,
        })
    }

    pub fn kill_tree(&mut self) -> Result<(), ProcessError> {
        if self.try_wait()?.is_some() {
            return Ok(());
        }
        self.stdin.take();
        if let Err(source) = kill_process_tree(&mut self.child)
            && self.try_wait()?.is_none()
        {
            return Err(ProcessError::Stop {
                program: self.label.clone(),
                source,
            });
        }
        let _ = self.wait()?;
        Ok(())
    }
}

impl Drop for SpawnedChild {
    fn drop(&mut self) {
        let _ = self.kill_tree();
    }
}

pub fn spawn_cli(
    program: &OsStr,
    args: &[&OsStr],
    options: &SpawnOptions,
) -> Result<SpawnedChild, ProcessError> {
    let label = program.to_string_lossy().into_owned();
    spawn_command(platform_command(program, args), label, options)
}

/// Spawn a real executable directly on every platform. Use this only when the
/// target is known not to be a Windows `.cmd` shim and argv must bypass
/// `cmd.exe`, such as a prompt containing newlines.
pub fn spawn_direct(
    program: &OsStr,
    args: &[&OsStr],
    options: &SpawnOptions,
) -> Result<SpawnedChild, ProcessError> {
    let label = program.to_string_lossy().into_owned();
    let mut command = Command::new(program);
    command.args(args);
    spawn_command(command, label, options)
}

fn spawn_command(
    mut command: Command,
    label: String,
    options: &SpawnOptions,
) -> Result<SpawnedChild, ProcessError> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = &options.cwd {
        command.current_dir(cwd);
    }
    if options.replace_environment {
        command.env_clear();
    }
    command.envs(options.environment.iter().map(|(key, value)| (key, value)));
    configure_process_group(&mut command);
    let mut child = command.spawn().map_err(|source| ProcessError::Start {
        program: label.clone(),
        source,
    })?;
    Ok(SpawnedChild {
        label,
        stdin: child.stdin.take(),
        stdout: child.stdout.take(),
        stderr: child.stderr.take(),
        child,
    })
}

pub fn run_cli(
    program: &OsStr,
    args: &[&OsStr],
    options: &SpawnOptions,
    timeout: Duration,
    max_output: usize,
) -> Result<CliOutput, ProcessError> {
    collect_output(
        program,
        spawn_cli(program, args, options)?,
        timeout,
        max_output,
    )
}

pub fn run_direct(
    program: &OsStr,
    args: &[&OsStr],
    options: &SpawnOptions,
    timeout: Duration,
    max_output: usize,
) -> Result<CliOutput, ProcessError> {
    collect_output(
        program,
        spawn_direct(program, args, options)?,
        timeout,
        max_output,
    )
}

fn collect_output(
    program: &OsStr,
    mut child: SpawnedChild,
    timeout: Duration,
    max_output: usize,
) -> Result<CliOutput, ProcessError> {
    child.stdin.take();
    let stdout = child.stdout.take().expect("piped stdout missing");
    let stderr = child.stderr.take().expect("piped stderr missing");
    let stdout_reader = thread::spawn(move || read_bounded(stdout, max_output));
    let stderr_reader = thread::spawn(move || read_bounded(stderr, max_output));
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait()? {
            Some(status) => break status,
            None if Instant::now() < deadline => thread::sleep(POLL_INTERVAL),
            None => {
                let _ = child.kill_tree();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(ProcessError::TimedOut {
                    program: program.to_string_lossy().into_owned(),
                });
            }
        }
    };
    let display_program = program.to_string_lossy();
    let stdout = join_output(stdout_reader, &display_program)?;
    let stderr = join_output(stderr_reader, &display_program)?;
    if stdout.exceeded || stderr.exceeded {
        return Err(ProcessError::OutputTooLarge {
            program: display_program.into_owned(),
        });
    }
    Ok(CliOutput {
        code: status.code(),
        stdout: String::from_utf8_lossy(&stdout.bytes).into_owned(),
    })
}

pub fn is_installed(program: &OsStr, timeout: Duration) -> bool {
    #[cfg(windows)]
    let lookup = OsStr::new("where.exe");
    #[cfg(not(windows))]
    let lookup = OsStr::new("/usr/bin/which");
    run_cli(
        lookup,
        &[program],
        &SpawnOptions::default(),
        timeout,
        1024 * 1024,
    )
    .is_ok_and(|output| output.code == Some(0))
}

pub fn command_version(program: &OsStr, timeout: Duration) -> Option<String> {
    let output = run_cli(
        program,
        &[OsStr::new("--version")],
        &SpawnOptions::default(),
        timeout,
        1024 * 1024,
    )
    .ok()?;
    output
        .stdout
        .lines()
        .find(|line| contains_version_number(line))
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
}

fn contains_version_number(line: &str) -> bool {
    let bytes = line.as_bytes();
    bytes
        .windows(3)
        .any(|window| window[0].is_ascii_digit() && window[1] == b'.' && window[2].is_ascii_digit())
}

#[cfg(windows)]
fn platform_command(program: &OsStr, args: &[&OsStr]) -> Command {
    let mut command = Command::new("cmd.exe");
    command.args(["/d", "/s", "/c"]).arg(program).args(args);
    command
}

#[cfg(not(windows))]
fn platform_command(program: &OsStr, args: &[&OsStr]) -> Command {
    let mut command = Command::new(program);
    command.args(args);
    command
}

#[cfg(unix)]
fn configure_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt as _;
    command.process_group(0);
}

#[cfg(windows)]
fn configure_process_group(command: &mut Command) {
    use std::os::windows::process::CommandExt as _;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(unix)]
fn kill_process_tree(child: &mut Child) -> std::io::Result<()> {
    let process_group = i32::try_from(child.id())
        .map_err(|_| std::io::Error::other("child process id is outside the platform range"))?;
    let result = unsafe { libc::kill(-process_group, libc::SIGKILL) };
    if result == 0 { Ok(()) } else { child.kill() }
}

#[cfg(windows)]
fn kill_process_tree(child: &mut Child) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt as _;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let status = Command::new("taskkill.exe")
        .args(["/pid", &child.id().to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    match status {
        Ok(status) if status.success() => Ok(()),
        _ => child.kill(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;
    use std::fs;
    use std::path::Path;

    const HELPER_MODE: &str = "HARNESS_PROC_HELPER_MODE";
    const HELPER_PATH: &str = "HARNESS_PROC_HELPER_PATH";

    #[test]
    fn captures_a_short_cli_without_a_posix_shell() {
        let rustc = std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into());
        let output = run_cli(
            &rustc,
            &[OsStr::new("--version")],
            &SpawnOptions::default(),
            Duration::from_secs(5),
            1024 * 1024,
        )
        .unwrap();
        assert_eq!(output.code, Some(0));
        assert!(output.stdout.starts_with("rustc "));
    }

    #[test]
    fn probes_presence_without_running_the_target_and_extracts_its_version_line() {
        let rustc = std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into());
        assert!(is_installed(&rustc, Duration::from_secs(5)));
        assert!(!is_installed(
            OsStr::new("harness-command-that-does-not-exist"),
            Duration::from_secs(5),
        ));
        assert!(
            command_version(&rustc, Duration::from_secs(5))
                .is_some_and(|version| version.starts_with("rustc "))
        );
        assert!(contains_version_number("warning 2026.07.3"));
        assert!(!contains_version_number("startup warning"));
    }

    #[test]
    fn replacement_environment_does_not_inherit_unlisted_values() {
        let directory = tempfile::tempdir().unwrap();
        let result_path = directory.path().join("environment.txt");
        let inherited_key = "CARGO_MANIFEST_DIR";
        assert!(std::env::var_os(inherited_key).is_some());
        let mut options = SpawnOptions::default()
            .replace_environment(true)
            .env(HELPER_MODE, "environment")
            .env(HELPER_PATH, result_path.as_os_str())
            .env("HARNESS_PROC_CHECK_KEY", inherited_key)
            .env("HARNESS_PROC_VISIBLE", "yes");
        preserve_windows_command_environment(&mut options);
        let mut child = spawn_test_helper(&options);
        assert!(child.wait().unwrap().success());
        assert_eq!(fs::read_to_string(result_path).unwrap(), "yes|");
    }

    #[test]
    fn kills_the_grandchild_behind_the_spawned_cli() {
        let directory = tempfile::tempdir().unwrap();
        let heartbeat = directory.path().join("heartbeat.txt");
        let options = SpawnOptions::default()
            .env(HELPER_MODE, "parent")
            .env(HELPER_PATH, heartbeat.as_os_str());
        let mut child = spawn_test_helper(&options);
        wait_for_file(&heartbeat);
        child.kill_tree().unwrap();
        thread::sleep(Duration::from_millis(300));
        let stopped = fs::read_to_string(&heartbeat).unwrap();
        thread::sleep(Duration::from_millis(500));
        assert_eq!(fs::read_to_string(heartbeat).unwrap(), stopped);
    }

    #[test]
    fn process_helper() {
        let Some(mode) = std::env::var_os(HELPER_MODE) else {
            return;
        };
        let path = PathBuf::from(std::env::var_os(HELPER_PATH).unwrap());
        match mode.to_string_lossy().as_ref() {
            "environment" => {
                let key = std::env::var("HARNESS_PROC_CHECK_KEY").unwrap();
                let visible = std::env::var("HARNESS_PROC_VISIBLE").unwrap_or_default();
                let hidden = std::env::var(key).unwrap_or_default();
                fs::write(path, format!("{visible}|{hidden}")).unwrap();
            }
            "parent" => {
                let mut child = Command::new(std::env::current_exe().unwrap());
                child
                    .args(["--exact", "child::tests::process_helper", "--nocapture"])
                    .env(HELPER_MODE, "heartbeat")
                    .env(HELPER_PATH, path);
                let mut grandchild = child.spawn().unwrap();
                loop {
                    assert!(grandchild.try_wait().unwrap().is_none());
                    thread::sleep(Duration::from_secs(1));
                }
            }
            "heartbeat" => loop {
                fs::write(&path, format!("{:?}", std::time::SystemTime::now())).unwrap();
                thread::sleep(Duration::from_millis(100));
            },
            mode => panic!("unknown helper mode: {mode}"),
        }
    }

    fn spawn_test_helper(options: &SpawnOptions) -> SpawnedChild {
        let executable = std::env::current_exe().unwrap();
        spawn_cli(
            executable.as_os_str(),
            &[
                OsStr::new("--exact"),
                OsStr::new("child::tests::process_helper"),
                OsStr::new("--nocapture"),
            ],
            options,
        )
        .unwrap()
    }

    fn wait_for_file(path: &Path) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !path.exists() {
            assert!(Instant::now() < deadline, "helper did not start");
            thread::sleep(Duration::from_millis(50));
        }
    }

    #[cfg(windows)]
    fn preserve_windows_command_environment(options: &mut SpawnOptions) {
        for key in ["PATH", "PATHEXT", "SYSTEMROOT", "COMSPEC"] {
            if let Some(value) = std::env::var_os(key) {
                options.environment.push((key.into(), value));
            }
        }
    }

    #[cfg(not(windows))]
    fn preserve_windows_command_environment(_options: &mut SpawnOptions) {}
}
