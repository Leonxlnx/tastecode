use crate::design_preview_runner::RunningPreview;
use harness_agent::TurnOptions;
use harness_design_agent::{
    BriefingOption, BriefingQuestion, ExplicitBriefAnswer, PreviewPlan, ReviewScreenshot,
    VisualReview, design_asset_prompt, design_brand_prompt, design_build_prompt,
    design_page_prompt, design_preview_prompt, design_repair_prompt, design_review_prompt,
    read_asset_manifest, read_brand_system, read_design_brief, read_page_blueprint,
};
use harness_protocol::{DomainEvent, Item, SequencedDomainEvent};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;
use uuid::Uuid;

pub(crate) const DESIGN_REPAIR_LIMIT: u32 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum DesignFlowPhase {
    Brief,
    Brand,
    Page,
    Assets,
    Build,
    Preview,
    Review,
    Repair,
    Complete,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DesignOperation {
    StartPreview,
    CaptureReview,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesignTurnOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) service_tier: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) effort: Option<String>,
}

impl DesignTurnOptions {
    pub(crate) fn from_turn_options(options: &TurnOptions) -> Self {
        Self {
            model: options.model.clone(),
            service_tier: options.service_tier.clone(),
            effort: Some("low".into()),
        }
    }

    pub(crate) fn turn_options(&self) -> TurnOptions {
        TurnOptions {
            model: self.model.clone(),
            service_tier: self.service_tier.clone(),
            effort: self.effort.clone(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesignFlow {
    #[serde(default = "new_id")]
    pub(crate) id: String,
    #[serde(default)]
    pub(crate) workspace_path: String,
    pub(crate) original_request: String,
    #[serde(default)]
    pub(crate) options: DesignTurnOptions,
    pub(crate) phase: DesignFlowPhase,
    pub(crate) asked_questions: bool,
    pub(crate) final_asked: bool,
    pub(crate) explicit_answers: Vec<ExplicitBriefAnswer>,
    #[serde(default)]
    pub(crate) correcting: bool,
    #[serde(default)]
    pub(crate) repair_attempt: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) pending_brief: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) pending_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) pending_operation: Option<DesignOperation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) completion: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) preview_plan: Option<PreviewPlan>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) preview_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) screenshots: Option<Vec<ReviewScreenshot>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) review: Option<VisualReview>,
}

impl DesignFlow {
    pub(crate) fn new(
        workspace_path: String,
        original_request: String,
        options: &TurnOptions,
    ) -> Self {
        Self {
            id: new_id(),
            workspace_path,
            original_request,
            options: DesignTurnOptions::from_turn_options(options),
            phase: DesignFlowPhase::Brief,
            asked_questions: false,
            final_asked: false,
            explicit_answers: Vec::new(),
            correcting: false,
            repair_attempt: 0,
            pending_brief: None,
            pending_prompt: None,
            pending_operation: None,
            completion: None,
            preview_plan: None,
            preview_url: None,
            screenshots: None,
            review: None,
        }
    }
}

#[derive(Clone)]
pub(crate) struct DesignInput {
    pub(crate) thread_id: String,
    pub(crate) questions: Vec<BriefingQuestion>,
    pub(crate) final_question: bool,
}

#[derive(Default)]
pub(crate) struct DesignLiveState {
    pub(crate) flows: HashMap<String, DesignFlow>,
    pub(crate) processing: HashSet<String>,
    pub(crate) turns: HashMap<String, String>,
    pub(crate) starting_threads: HashSet<String>,
    pub(crate) message_items: HashSet<String>,
    pub(crate) accepted_outputs: HashSet<String>,
    pub(crate) output_errors: HashMap<String, String>,
    pub(crate) activity_items: HashMap<String, Item>,
    pub(crate) inputs: HashMap<String, DesignInput>,
    pub(crate) input_by_thread: HashMap<String, String>,
    pub(crate) previews: HashMap<String, Arc<RunningPreview>>,
}

impl DesignLiveState {
    pub(crate) fn owns_thread(&self, thread_id: &str) -> bool {
        self.flows.contains_key(thread_id)
            || self.processing.contains(thread_id)
            || self.input_by_thread.contains_key(thread_id)
    }

    pub(crate) fn clear_thread(&mut self, thread_id: &str) -> Option<Arc<RunningPreview>> {
        self.flows.remove(thread_id);
        self.processing.remove(thread_id);
        self.starting_threads.remove(thread_id);
        if let Some(request_id) = self.input_by_thread.remove(thread_id) {
            self.inputs.remove(&request_id);
        }
        let turn_ids = self
            .turns
            .iter()
            .filter(|(_, owner)| owner.as_str() == thread_id)
            .map(|(turn_id, _)| turn_id.clone())
            .collect::<Vec<_>>();
        for turn_id in turn_ids {
            self.turns.remove(&turn_id);
            self.accepted_outputs.remove(&turn_id);
            self.output_errors.remove(&turn_id);
            self.activity_items.remove(&turn_id);
        }
        if self.flows.is_empty() {
            self.message_items.clear();
        }
        self.previews.remove(thread_id)
    }
}

pub(crate) fn parse_stored_design_flow(value: Value, workspace_path: String) -> Option<DesignFlow> {
    let object = value.as_object()?;
    if !object.get("originalRequest").is_some_and(Value::is_string)
        || !object.get("askedQuestions").is_some_and(Value::is_boolean)
        || !object.get("finalAsked").is_some_and(Value::is_boolean)
        || !object.get("explicitAnswers").is_some_and(Value::is_array)
    {
        return None;
    }
    let mut flow: DesignFlow = serde_json::from_value(value).ok()?;
    flow.workspace_path = workspace_path;
    if let Some(plan) = &flow.preview_plan {
        flow.preview_url = Some(plan.url.clone());
    }
    if (matches!(
        flow.phase,
        DesignFlowPhase::Review | DesignFlowPhase::Repair
    ) && flow.preview_plan.is_none())
        || (flow.phase == DesignFlowPhase::Review && flow.screenshots.is_none())
        || (flow.phase == DesignFlowPhase::Repair && flow.review.is_none())
    {
        return None;
    }
    Some(flow)
}

pub(crate) fn prompt_for_phase(flow: &DesignFlow) -> Result<String, String> {
    if flow.phase == DesignFlowPhase::Brief {
        return Ok(harness_design_agent::design_briefing_prompt(
            &flow.original_request,
        ));
    }
    let workspace = Path::new(&flow.workspace_path);
    let brief = read_design_brief(workspace).map_err(|error| error.to_string())?;
    if flow.phase == DesignFlowPhase::Brand {
        return Ok(design_brand_prompt(&brief));
    }
    let brand = read_brand_system(workspace).map_err(|error| error.to_string())?;
    if flow.phase == DesignFlowPhase::Page {
        return Ok(design_page_prompt(&brief, &brand));
    }
    let page = read_page_blueprint(workspace).map_err(|error| error.to_string())?;
    match flow.phase {
        DesignFlowPhase::Assets => Ok(design_asset_prompt(&brief, &brand, &page)),
        DesignFlowPhase::Build => Ok(design_build_prompt(
            &brief,
            &brand,
            &page,
            &read_asset_manifest(workspace).map_err(|error| error.to_string())?,
        )),
        DesignFlowPhase::Preview => Ok(design_preview_prompt()),
        DesignFlowPhase::Review => flow
            .screenshots
            .as_deref()
            .map(|screenshots| design_review_prompt(&brief, &brand, &page, screenshots))
            .ok_or_else(|| "review screenshots are unavailable".into()),
        DesignFlowPhase::Repair => design_repair_prompt(
            flow.review
                .as_ref()
                .ok_or_else(|| "visual review is unavailable".to_owned())?,
            flow.repair_attempt,
            DESIGN_REPAIR_LIMIT,
        )
        .map_err(|error| error.to_string()),
        DesignFlowPhase::Brief | DesignFlowPhase::Brand | DesignFlowPhase::Page => {
            unreachable!("handled before downstream artifacts")
        }
        DesignFlowPhase::Complete => Err("cannot resume completed design flow".into()),
    }
}

pub(crate) fn design_attachments(flow: &DesignFlow) -> Vec<String> {
    if flow.phase == DesignFlowPhase::Review {
        flow.screenshots
            .iter()
            .flatten()
            .map(|screenshot| screenshot.path.clone())
            .collect()
    } else {
        Vec::new()
    }
}

pub(crate) fn unresolved_design_input(
    history: &[SequencedDomainEvent],
) -> Option<(String, DesignInput)> {
    let mut unresolved = Vec::<(String, Vec<BriefingQuestion>)>::new();
    for event in history {
        match &event.event {
            DomainEvent::UserInputRequested { request } => {
                unresolved.retain(|(id, _)| id != &request.id);
                unresolved.push((
                    request.id.clone(),
                    request
                        .questions
                        .iter()
                        .map(|question| BriefingQuestion {
                            id: question.id.clone(),
                            header: question.header.clone(),
                            question: question.question.clone(),
                            allow_other: question.allow_other,
                            options: question
                                .options
                                .as_deref()
                                .unwrap_or_default()
                                .iter()
                                .map(|option| BriefingOption {
                                    label: option.label.clone(),
                                    description: option.description.clone(),
                                })
                                .collect(),
                        })
                        .collect(),
                ));
            }
            DomainEvent::UserInputResolved { id } => {
                unresolved.retain(|(candidate, _)| candidate != id);
            }
            _ => {}
        }
    }
    unresolved.pop().map(|(id, questions)| {
        let final_question = questions
            .iter()
            .all(|question| question.id == harness_design_agent::FINAL_BRIEFING_QUESTION_ID);
        (
            id,
            DesignInput {
                thread_id: String::new(),
                questions,
                final_question,
            },
        )
    })
}

pub(crate) fn open_turn(history: &[SequencedDomainEvent]) -> Option<String> {
    let mut open = Vec::<String>::new();
    for event in history {
        match &event.event {
            DomainEvent::TurnStarted { turn } => {
                open.retain(|turn_id| turn_id != &turn.id);
                open.push(turn.id.clone());
            }
            DomainEvent::TurnCompleted { turn_id, .. } => {
                open.retain(|candidate| candidate != turn_id);
            }
            _ => {}
        }
    }
    open.pop()
}

fn new_id() -> String {
    Uuid::new_v4().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_old_persisted_flows_and_rejects_incomplete_review_state() {
        let flow = parse_stored_design_flow(
            json!({
                "originalRequest": "Build a site.",
                "phase": "brand",
                "askedQuestions": false,
                "finalAsked": false,
                "explicitAnswers": [],
                "options": {"model": "gpt-5", "effort": "low"}
            }),
            "/workspace".into(),
        )
        .unwrap();
        assert_eq!(flow.workspace_path, "/workspace");
        assert_eq!(flow.options.model.as_deref(), Some("gpt-5"));
        assert!(
            parse_stored_design_flow(
                json!({
                    "originalRequest": "Build a site.",
                    "phase": "review",
                    "askedQuestions": false,
                    "finalAsked": false,
                    "explicitAnswers": []
                }),
                "/workspace".into()
            )
            .is_none()
        );
    }

    #[test]
    fn design_options_force_low_effort_without_resetting_selection() {
        let options = TurnOptions {
            model: Some("selected-model".into()),
            service_tier: Some("fast".into()),
            effort: Some("high".into()),
        };
        let design = DesignTurnOptions::from_turn_options(&options).turn_options();
        assert_eq!(design.model, options.model);
        assert_eq!(design.service_tier, options.service_tier);
        assert_eq!(design.effort.as_deref(), Some("low"));
    }
}
