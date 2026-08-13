use crate::common::{object, require_version_one, string};
use crate::{DesignError, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DesignPhase {
    Brief,
    Brand,
    Page,
    Assets,
    Build,
    Preview,
    Review,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DesignRunPhase {
    Brief,
    Brand,
    Page,
    Assets,
    Build,
    Preview,
    Review,
    Complete,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DesignRunStatus {
    Running,
    Waiting,
    Failed,
    Complete,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DesignRunAttempts {
    pub build: u32,
    pub preview: u32,
    pub review: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DesignRunError {
    pub phase: DesignPhase,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DesignRunState {
    pub version: u8,
    pub phase: DesignRunPhase,
    pub status: DesignRunStatus,
    pub completed: Vec<DesignPhase>,
    pub attempts: DesignRunAttempts,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<DesignRunError>,
}

const DESIGN_PHASES: [DesignPhase; 7] = [
    DesignPhase::Brief,
    DesignPhase::Brand,
    DesignPhase::Page,
    DesignPhase::Assets,
    DesignPhase::Build,
    DesignPhase::Preview,
    DesignPhase::Review,
];

pub fn create_design_run_state() -> DesignRunState {
    DesignRunState {
        version: 1,
        phase: DesignRunPhase::Brief,
        status: DesignRunStatus::Running,
        completed: Vec::new(),
        attempts: DesignRunAttempts {
            build: 0,
            preview: 0,
            review: 0,
        },
        error: None,
    }
}

pub fn next_design_phase(completed: &[DesignPhase]) -> Result<DesignRunPhase> {
    if completed.len() > DESIGN_PHASES.len() {
        return Err(DesignError::new(
            "completed design phases exceed the workflow",
        ));
    }
    if completed
        .iter()
        .zip(DESIGN_PHASES)
        .any(|(actual, expected)| *actual != expected)
    {
        return Err(DesignError::new(
            "completed design phases must be a contiguous prefix",
        ));
    }
    Ok(match DESIGN_PHASES.get(completed.len()) {
        Some(DesignPhase::Brief) => DesignRunPhase::Brief,
        Some(DesignPhase::Brand) => DesignRunPhase::Brand,
        Some(DesignPhase::Page) => DesignRunPhase::Page,
        Some(DesignPhase::Assets) => DesignRunPhase::Assets,
        Some(DesignPhase::Build) => DesignRunPhase::Build,
        Some(DesignPhase::Preview) => DesignRunPhase::Preview,
        Some(DesignPhase::Review) => DesignRunPhase::Review,
        None => DesignRunPhase::Complete,
    })
}

pub fn parse_design_run_state(value: &Value) -> Result<DesignRunState> {
    let run = object(value, "design run")?;
    require_version_one(run.get("version"), "design run")?;
    let completed = run
        .get("completed")
        .and_then(Value::as_array)
        .ok_or_else(|| DesignError::new("design run completed must be an array"))?
        .iter()
        .enumerate()
        .map(|(index, value)| parse_phase(value, &format!("design run completed[{index}]")))
        .collect::<Result<Vec<_>>>()?;
    let expected = next_design_phase(&completed)?;
    let phase = parse_run_phase(run.get("phase"), "design run phase")?;
    if phase != expected {
        return Err(DesignError::new(format!(
            "design run phase must be {}",
            run_phase_name(expected)
        )));
    }
    let status = parse_status(run.get("status"))?;
    if (status == DesignRunStatus::Complete) != (phase == DesignRunPhase::Complete) {
        return Err(DesignError::new(
            "only the complete phase may use complete status",
        ));
    }
    let attempts = object(
        run.get("attempts").unwrap_or(&Value::Null),
        "design run attempts",
    )?;
    let error = run.get("error").map(parse_error).transpose()?;
    if (status == DesignRunStatus::Failed) != error.is_some() {
        return Err(DesignError::new(
            "failed design runs must contain exactly one error",
        ));
    }
    Ok(DesignRunState {
        version: 1,
        phase,
        status,
        completed,
        attempts: DesignRunAttempts {
            build: count(attempts.get("build"), "design run attempts.build")?,
            preview: count(attempts.get("preview"), "design run attempts.preview")?,
            review: count(attempts.get("review"), "design run attempts.review")?,
        },
        error,
    })
}

fn parse_error(value: &Value) -> Result<DesignRunError> {
    let error = object(value, "design run error")?;
    Ok(DesignRunError {
        phase: parse_phase(
            error.get("phase").unwrap_or(&Value::Null),
            "design run error.phase",
        )?,
        message: string(error.get("message"), "design run error.message")?,
    })
}

fn parse_phase(value: &Value, field: &str) -> Result<DesignPhase> {
    match value.as_str() {
        Some("brief") => Ok(DesignPhase::Brief),
        Some("brand") => Ok(DesignPhase::Brand),
        Some("page") => Ok(DesignPhase::Page),
        Some("assets") => Ok(DesignPhase::Assets),
        Some("build") => Ok(DesignPhase::Build),
        Some("preview") => Ok(DesignPhase::Preview),
        Some("review") => Ok(DesignPhase::Review),
        _ => Err(DesignError::new(format!(
            "{field} must be one of brief, brand, page, assets, build, preview, review"
        ))),
    }
}

fn parse_run_phase(value: Option<&Value>, field: &str) -> Result<DesignRunPhase> {
    if value.and_then(Value::as_str) == Some("complete") {
        return Ok(DesignRunPhase::Complete);
    }
    Ok(match parse_phase(value.unwrap_or(&Value::Null), field)? {
        DesignPhase::Brief => DesignRunPhase::Brief,
        DesignPhase::Brand => DesignRunPhase::Brand,
        DesignPhase::Page => DesignRunPhase::Page,
        DesignPhase::Assets => DesignRunPhase::Assets,
        DesignPhase::Build => DesignRunPhase::Build,
        DesignPhase::Preview => DesignRunPhase::Preview,
        DesignPhase::Review => DesignRunPhase::Review,
    })
}

fn parse_status(value: Option<&Value>) -> Result<DesignRunStatus> {
    match value.and_then(Value::as_str) {
        Some("running") => Ok(DesignRunStatus::Running),
        Some("waiting") => Ok(DesignRunStatus::Waiting),
        Some("failed") => Ok(DesignRunStatus::Failed),
        Some("complete") => Ok(DesignRunStatus::Complete),
        _ => Err(DesignError::new(
            "design run status must be one of running, waiting, failed, complete",
        )),
    }
}

fn count(value: Option<&Value>, field: &str) -> Result<u32> {
    value
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| DesignError::new(format!("{field} must be a non-negative integer")))
}

fn run_phase_name(phase: DesignRunPhase) -> &'static str {
    match phase {
        DesignRunPhase::Brief => "brief",
        DesignRunPhase::Brand => "brand",
        DesignRunPhase::Page => "page",
        DesignRunPhase::Assets => "assets",
        DesignRunPhase::Build => "build",
        DesignRunPhase::Preview => "preview",
        DesignRunPhase::Review => "review",
        DesignRunPhase::Complete => "complete",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn starts_and_advances_contiguously() {
        assert_eq!(create_design_run_state().phase, DesignRunPhase::Brief);
        assert_eq!(
            next_design_phase(&[DesignPhase::Brief, DesignPhase::Brand, DesignPhase::Page])
                .unwrap(),
            DesignRunPhase::Assets
        );
        assert!(next_design_phase(&[DesignPhase::Brief, DesignPhase::Page]).is_err());
    }

    #[test]
    fn validates_resumable_failed_state() {
        let state = parse_design_run_state(&json!({
            "version": 1,
            "phase": "build",
            "status": "failed",
            "completed": ["brief", "brand", "page", "assets"],
            "attempts": {"build": 1, "preview": 0, "review": 0},
            "error": {"phase": "build", "message": "Build failed."}
        }))
        .unwrap();
        assert_eq!(state.phase, DesignRunPhase::Build);
    }
}
