use std::ffi::OsString;
use std::fs;
use std::path::Path;

pub(crate) fn safe_command_environment(
    workspace: &Path,
) -> std::io::Result<Vec<(OsString, OsString)>> {
    let runtime = std::env::temp_dir().join("personal-harness-project-tools");
    fs::create_dir_all(&runtime)?;
    let mut environment = Vec::new();
    for key in ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC"] {
        if let Some(value) = std::env::var_os(key) {
            environment.push((key.into(), value));
        }
    }
    for key in ["TEMP", "TMP", "APPDATA", "LOCALAPPDATA"] {
        environment.push((key.into(), runtime.as_os_str().into()));
    }
    environment.push(("HOME".into(), workspace.as_os_str().into()));
    environment.push(("USERPROFILE".into(), workspace.as_os_str().into()));
    for (key, value) in [
        ("CI", "1"),
        ("NO_COLOR", "1"),
        ("GIT_TERMINAL_PROMPT", "0"),
        ("GIT_CONFIG_NOSYSTEM", "1"),
    ] {
        environment.push((key.into(), value.into()));
    }
    let null_file = if cfg!(windows) { "NUL" } else { "/dev/null" };
    environment.push(("GIT_CONFIG_GLOBAL".into(), null_file.into()));
    environment.push(("NPM_CONFIG_USERCONFIG".into(), null_file.into()));
    Ok(environment)
}
