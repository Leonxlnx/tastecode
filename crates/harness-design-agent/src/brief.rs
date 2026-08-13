use crate::common::{any_string, object, read_json, string, write_json};
use crate::{DesignError, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplicitBriefAnswer {
    pub question: String,
    pub answer: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignBrief {
    pub original_request: String,
    pub subject: String,
    pub page_type: String,
    pub scope: String,
    pub primary_goal: String,
    pub audience: String,
    pub offer: String,
    pub primary_action: String,
    pub required_content: Vec<String>,
    pub constraints: Vec<String>,
    pub brand_inputs: Vec<String>,
    pub creative_control: String,
    pub explicit_answers: Vec<ExplicitBriefAnswer>,
    pub assumptions: Vec<String>,
    pub unresolved: Vec<String>,
}

pub fn parse_design_brief(value: &Value) -> Result<DesignBrief> {
    let brief = object(value, "design brief")?;
    Ok(DesignBrief {
        original_request: string(
            brief.get("originalRequest"),
            "design brief field originalRequest",
        )?,
        subject: string(brief.get("subject"), "design brief field subject")?,
        page_type: string(brief.get("pageType"), "design brief field pageType")?,
        scope: string(brief.get("scope"), "design brief field scope")?,
        primary_goal: string(brief.get("primaryGoal"), "design brief field primaryGoal")?,
        audience: string(brief.get("audience"), "design brief field audience")?,
        offer: string(brief.get("offer"), "design brief field offer")?,
        primary_action: string(
            brief.get("primaryAction"),
            "design brief field primaryAction",
        )?,
        required_content: brief_strings(brief.get("requiredContent"), "requiredContent")?,
        constraints: brief_strings(brief.get("constraints"), "constraints")?,
        brand_inputs: brief_strings(brief.get("brandInputs"), "brandInputs")?,
        creative_control: string(
            brief.get("creativeControl"),
            "design brief field creativeControl",
        )?,
        explicit_answers: explicit_answers(brief.get("explicitAnswers"))?,
        assumptions: brief_strings(brief.get("assumptions"), "assumptions")?,
        unresolved: brief_strings(brief.get("unresolved"), "unresolved")?,
    })
}

pub fn read_design_brief(workspace_path: &Path) -> Result<DesignBrief> {
    parse_design_brief(&read_json(&brief_path(workspace_path))?)
}

pub fn write_design_brief(workspace_path: &Path, value: &Value) -> Result<DesignBrief> {
    let brief = parse_design_brief(value)?;
    write_json(&brief_path(workspace_path), &brief)?;
    Ok(brief)
}

fn explicit_answers(value: Option<&Value>) -> Result<Vec<ExplicitBriefAnswer>> {
    let values = value.and_then(Value::as_array).ok_or_else(|| {
        DesignError::new(
            "design brief field explicitAnswers must contain question and answer strings",
        )
    })?;
    values
        .iter()
        .map(|value| {
            let answer = value.as_object().ok_or_else(|| {
                DesignError::new(
                    "design brief field explicitAnswers must contain question and answer strings",
                )
            })?;
            Ok(ExplicitBriefAnswer {
                question: any_string(answer.get("question"), "explicit answer question").map_err(
                    |_| {
                        DesignError::new(
                            "design brief field explicitAnswers must contain question and answer strings",
                        )
                    },
                )?,
                answer: any_string(answer.get("answer"), "explicit answer").map_err(|_| {
                    DesignError::new(
                        "design brief field explicitAnswers must contain question and answer strings",
                    )
                })?,
            })
        })
        .collect()
}

fn brief_strings(value: Option<&Value>, field: &str) -> Result<Vec<String>> {
    let values = value.and_then(Value::as_array).ok_or_else(|| {
        DesignError::new(format!("design brief field {field} must be a string array"))
    })?;
    values
        .iter()
        .map(|value| {
            value.as_str().map(str::to_owned).ok_or_else(|| {
                DesignError::new(format!("design brief field {field} must be a string array"))
            })
        })
        .collect()
}

fn brief_path(workspace_path: &Path) -> PathBuf {
    workspace_path.join(".taste").join("brief.json")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn brief() -> Value {
        json!({
            "originalRequest": "Create a studio site.",
            "subject": "Independent creative studio",
            "pageType": "Marketing site",
            "scope": "Single responsive page",
            "primaryGoal": "Generate qualified enquiries",
            "audience": "Teams seeking creative direction",
            "offer": "Brand and digital design services",
            "primaryAction": "Start a project",
            "requiredContent": ["Selected work"],
            "constraints": [],
            "brandInputs": ["Use the supplied wordmark"],
            "creativeControl": "Agent-led",
            "explicitAnswers": [{"question": "Primary action?", "answer": "Start a project"}],
            "assumptions": [],
            "unresolved": [],
            "ignoredModelKey": "not persisted"
        })
    }

    #[test]
    fn round_trips_only_validated_fields() {
        let workspace = tempfile::tempdir().unwrap();
        let written = write_design_brief(workspace.path(), &brief()).unwrap();
        assert_eq!(read_design_brief(workspace.path()).unwrap(), written);
        let stored = std::fs::read_to_string(brief_path(workspace.path())).unwrap();
        assert!(!stored.contains("ignoredModelKey"));
    }

    #[test]
    fn rejects_incomplete_handoff() {
        let error = parse_design_brief(&json!({"subject": "Studio"})).unwrap_err();
        assert_eq!(
            error.to_string(),
            "design brief field originalRequest must be a non-empty string"
        );
    }
}
