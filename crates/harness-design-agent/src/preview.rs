use crate::common::{object, parse_json_text, require_version_one, string};
use crate::{DesignError, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use url::Url;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewPlan {
    pub version: u8,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ready_pattern: Option<String>,
    pub viewports: Vec<PreviewViewport>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreviewViewport {
    pub name: String,
    pub width: u32,
    pub height: u32,
}

const PREVIEW_PROTOCOL: &str = r#"Return the preview plan as JSON only, without Markdown fences:

{"version":1,"command":"pnpm","args":["dev","--host","127.0.0.1"],"cwd":".","url":"http://127.0.0.1:5173","readyPattern":"optional output text","viewports":[{"name":"desktop","width":1440,"height":1000},{"name":"mobile","width":390,"height":844}]}"#;

pub fn design_preview_prompt() -> String {
    format!(
        r#"You are running the Preview Setup phase of TasteCode Design Mode.

Inspect the implemented project's real package scripts and configuration. Choose the existing development or preview command that serves the built page on 127.0.0.1 with an explicit port. Do not install dependencies, edit files, start the server, use a shell string, or choose a remote URL. The command is an executable name and args is its argv array. cwd is relative to the current workspace.

Include one representative desktop viewport and one representative mobile viewport. Use readyPattern only when the command has a stable output fragment that indicates readiness. TasteCode will validate and execute this plan.

{PREVIEW_PROTOCOL}"#
    )
}

pub fn parse_preview_phase_output(text: &str) -> Result<PreviewPlan> {
    parse_preview_plan(&parse_json_text(text)?)
}

pub fn parse_preview_plan(value: &Value) -> Result<PreviewPlan> {
    let plan = object(value, "preview plan")?;
    require_version_one(plan.get("version"), "preview plan")?;
    let command = string(plan.get("command"), "preview command")?;
    if command.contains(['/', '\\'])
        || command
            .chars()
            .any(|character| character.is_whitespace() || ";&|<>".contains(character))
    {
        return Err(DesignError::new(
            "preview command must be an executable name",
        ));
    }
    let args = plan
        .get("args")
        .and_then(Value::as_array)
        .ok_or_else(|| DesignError::new("preview args must be a string array"))?
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| DesignError::new("preview args must be a string array"))
        })
        .collect::<Result<Vec<_>>>()?;
    let cwd = string(plan.get("cwd"), "preview cwd")?;
    if leaves_workspace(&cwd) {
        return Err(DesignError::new(
            "preview cwd must stay inside the workspace",
        ));
    }
    let raw_url = string(plan.get("url"), "preview url")?;
    let url = Url::parse(&raw_url).map_err(|error| DesignError::new(error.to_string()))?;
    if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") {
        return Err(DesignError::new("preview url must use http://127.0.0.1"));
    }
    if url.port().is_none() {
        return Err(DesignError::new(
            "preview url must contain an explicit port",
        ));
    }
    let viewports = plan
        .get("viewports")
        .and_then(Value::as_array)
        .filter(|viewports| (1..=4).contains(&viewports.len()))
        .ok_or_else(|| {
            DesignError::new("preview viewports must contain between one and four entries")
        })?
        .iter()
        .enumerate()
        .map(|(index, value)| {
            let field = format!("preview viewports[{index}]");
            let viewport = object(value, &field)?;
            Ok(PreviewViewport {
                name: string(viewport.get("name"), &format!("{field}.name"))?,
                width: dimension(viewport.get("width"), 320, 3_840, &format!("{field}.width"))?,
                height: dimension(
                    viewport.get("height"),
                    240,
                    2_160,
                    &format!("{field}.height"),
                )?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let mut names = HashSet::new();
    if !viewports
        .iter()
        .all(|viewport| names.insert(&viewport.name))
    {
        return Err(DesignError::new("preview viewport names must be unique"));
    }
    let ready_pattern = plan
        .get("readyPattern")
        .map(|value| string(Some(value), "preview readyPattern"))
        .transpose()?;
    Ok(PreviewPlan {
        version: 1,
        command,
        args,
        cwd,
        url: url.to_string(),
        ready_pattern,
        viewports,
    })
}

fn dimension(value: Option<&Value>, minimum: u32, maximum: u32, field: &str) -> Result<u32> {
    let value = value.and_then(Value::as_u64);
    value
        .filter(|value| (u64::from(minimum)..=u64::from(maximum)).contains(value))
        .map(|value| value as u32)
        .ok_or_else(|| {
            DesignError::new(format!(
                "{field} must be an integer between {minimum} and {maximum}"
            ))
        })
}

fn leaves_workspace(path: &str) -> bool {
    let bytes = path.as_bytes();
    (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
        || path.starts_with('/')
        || path.starts_with('\\')
        || path.split(['/', '\\']).any(|part| part == "..")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn plan() -> Value {
        json!({
            "version": 1,
            "command": "pnpm",
            "args": ["dev", "--host", "127.0.0.1"],
            "cwd": ".",
            "url": "http://127.0.0.1:5173",
            "readyPattern": "ready",
            "viewports": [
                {"name": "desktop", "width": 1440, "height": 1000},
                {"name": "mobile", "width": 390, "height": 844}
            ]
        })
    }

    #[test]
    fn normalizes_a_shell_free_local_plan() {
        let plan = parse_preview_plan(&plan()).unwrap();
        assert_eq!(plan.command, "pnpm");
        assert_eq!(plan.url, "http://127.0.0.1:5173/");
        assert!(design_preview_prompt().contains("Do not install dependencies"));
    }

    #[test]
    fn rejects_remote_shell_traversal_and_oversized_capture() {
        let mut remote = plan();
        remote["url"] = json!("https://example.com");
        assert!(
            parse_preview_plan(&remote)
                .unwrap_err()
                .to_string()
                .contains("127.0.0.1")
        );
        let mut shell = plan();
        shell["command"] = json!("pnpm && upload");
        assert!(
            parse_preview_plan(&shell)
                .unwrap_err()
                .to_string()
                .contains("executable name")
        );
        let mut traversal = plan();
        traversal["cwd"] = json!("../outside");
        assert!(
            parse_preview_plan(&traversal)
                .unwrap_err()
                .to_string()
                .contains("inside the workspace")
        );
        let mut oversized = plan();
        oversized["viewports"] = json!([{"name": "large", "width": 7680, "height": 4320}]);
        assert!(
            parse_preview_plan(&oversized)
                .unwrap_err()
                .to_string()
                .contains("between 320 and 3840")
        );
    }
}
