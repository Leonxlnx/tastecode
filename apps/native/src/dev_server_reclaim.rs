use anyhow::{Context as _, bail};
use std::collections::BTreeSet;
use std::net::{SocketAddr, TcpListener};
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

const RELEASE_TIMEOUT: Duration = Duration::from_secs(2);
const RELEASE_POLL_INTERVAL: Duration = Duration::from_millis(25);

pub fn reclaim(address: SocketAddr) -> anyhow::Result<()> {
    let pids = listening_processes(address)?;
    if pids.is_empty() {
        bail!("no process was found listening on {address}");
    }

    let current_pid = std::process::id();
    for pid in pids {
        if pid == current_pid {
            bail!("the current TasteCode process already owns {address}");
        }
        kill(pid)
            .with_context(|| format!("failed to stop process {pid} listening on {address}"))?;
        eprintln!("[native] stopped process {pid} listening on {address}");
    }

    let deadline = Instant::now() + RELEASE_TIMEOUT;
    while Instant::now() < deadline {
        if TcpListener::bind(address).is_ok() {
            return Ok(());
        }
        thread::sleep(RELEASE_POLL_INTERVAL);
    }
    bail!("{address} was still in use after stopping its listener")
}

#[cfg(target_os = "macos")]
fn listening_processes(address: SocketAddr) -> anyhow::Result<Vec<u32>> {
    let endpoint = format!("TCP@{}:{}", address.ip(), address.port());
    let output = Command::new("lsof")
        .args(["-nP", "-t", "-a", &format!("-i{endpoint}"), "-sTCP:LISTEN"])
        .output()
        .context("failed to inspect the occupied TasteCode address with lsof")?;
    if !output.status.success() && output.stdout.is_empty() {
        return Ok(Vec::new());
    }
    parse_pids(&output.stdout)
}

#[cfg(target_os = "windows")]
fn listening_processes(address: SocketAddr) -> anyhow::Result<Vec<u32>> {
    let command = format!(
        "Get-NetTCPConnection -LocalAddress '{}' -LocalPort {} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess",
        address.ip(),
        address.port()
    );
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &command])
        .output()
        .context("failed to inspect the occupied TasteCode address with PowerShell")?;
    if !output.status.success() && output.stdout.is_empty() {
        return Ok(Vec::new());
    }
    parse_pids(&output.stdout)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn listening_processes(address: SocketAddr) -> anyhow::Result<Vec<u32>> {
    bail!("automatic address reclaim is unsupported for {address} on this platform")
}

#[cfg(target_os = "macos")]
fn kill(pid: u32) -> anyhow::Result<()> {
    let result = unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error().into())
    }
}

#[cfg(target_os = "windows")]
fn kill(pid: u32) -> anyhow::Result<()> {
    let status = Command::new("taskkill.exe")
        .args(["/PID", &pid.to_string(), "/F"])
        .status()
        .context("failed to launch taskkill")?;
    if status.success() {
        Ok(())
    } else {
        bail!("taskkill exited with {status}")
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn kill(_pid: u32) -> anyhow::Result<()> {
    unreachable!("listening_processes rejects unsupported platforms")
}

fn parse_pids(output: &[u8]) -> anyhow::Result<Vec<u32>> {
    let output = String::from_utf8_lossy(output);
    let mut pids = BTreeSet::new();
    for value in output.split_whitespace() {
        pids.insert(
            value
                .parse::<u32>()
                .with_context(|| format!("invalid listener process id {value:?}"))?,
        );
    }
    Ok(pids.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_deduplicates_listener_processes() {
        assert_eq!(parse_pids(b"42\n17\n42\n").unwrap(), vec![17, 42]);
    }

    #[test]
    fn rejects_malformed_listener_processes() {
        assert!(parse_pids(b"42\nnot-a-pid\n").is_err());
    }
}
