use crate::{ItemContext, map_thread_item};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use harness_protocol::{
    ApprovalReview, ApprovalReviewStatus, DomainEvent, ItemStatus, PlanStep, PlanStepStatus,
    ProviderId, RiskLevel, Thread, Turn, TurnStatus, Usage,
};
use serde_json::Value;
use thiserror::Error;

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum NotificationMappingError {
    #[error("{method} is missing {field}")]
    MissingField { method: String, field: &'static str },
    #[error("{method} has an unsupported {field}: {value}")]
    UnsupportedValue {
        method: String,
        field: &'static str,
        value: String,
    },
}

/// Translate the domain-bearing subset of Codex app-server notifications.
///
/// `Ok(None)` means the notification belongs to another adapter concern, such
/// as authentication or MCP inventory. Callers can log it without treating a
/// newer Codex notification as a session failure.
pub fn map_domain_notification(
    method: &str,
    params: &Value,
    now_ms: f64,
) -> Result<Option<DomainEvent>, NotificationMappingError> {
    let event = match method {
        "thread/started" => DomainEvent::ThreadStarted {
            thread: Thread {
                id: required_str(method, params, &["thread", "id"], "thread.id")?.into(),
                provider: ProviderId::Codex,
                connection_id: None,
                workspace_path: value_at(params, &["thread", "cwd"])
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .into(),
                title: None,
                created_at: now_ms,
            },
        },
        "turn/started" => DomainEvent::TurnStarted {
            turn: Turn {
                id: required_str(method, params, &["turn", "id"], "turn.id")?.into(),
                thread_id: required_str(method, params, &["threadId"], "threadId")?.into(),
                status: TurnStatus::Running,
                created_at: now_ms,
            },
        },
        "turn/completed" => DomainEvent::TurnCompleted {
            turn_id: required_str(method, params, &["turn", "id"], "turn.id")?.into(),
            status: completed_turn_status(
                method,
                required_str(method, params, &["turn", "status"], "turn.status")?,
            )?,
        },
        "item/started" => DomainEvent::ItemStarted {
            item: map_thread_item(
                required_value(method, params, &["item"], "item")?,
                ItemContext {
                    turn_id: required_str(method, params, &["turnId"], "turnId")?,
                    status: ItemStatus::Started,
                    created_at: required_number(method, params, &["startedAtMs"], "startedAtMs")?,
                },
            ),
        },
        "item/completed" => DomainEvent::ItemCompleted {
            item: map_thread_item(
                required_value(method, params, &["item"], "item")?,
                ItemContext {
                    turn_id: required_str(method, params, &["turnId"], "turnId")?,
                    status: ItemStatus::Completed,
                    created_at: required_number(
                        method,
                        params,
                        &["completedAtMs"],
                        "completedAtMs",
                    )?,
                },
            ),
        },
        "item/autoApprovalReview/started" => DomainEvent::ApprovalReviewStarted {
            review: map_approval_review(method, params)?,
        },
        "item/autoApprovalReview/completed" => DomainEvent::ApprovalReviewCompleted {
            review: map_approval_review(method, params)?,
        },
        "item/agentMessage/delta"
        | "item/reasoning/summaryTextDelta"
        | "item/reasoning/textDelta" => DomainEvent::ItemDelta {
            turn_id: required_str(method, params, &["turnId"], "turnId")?.into(),
            item_id: required_str(method, params, &["itemId"], "itemId")?.into(),
            text_delta: required_str(method, params, &["delta"], "delta")?.into(),
        },
        "item/commandExecution/outputDelta" => {
            let text_delta = command_output(params);
            if text_delta.is_empty() {
                return Ok(None);
            }
            DomainEvent::ItemDelta {
                turn_id: required_str(method, params, &["turnId"], "turnId")?.into(),
                item_id: required_str(method, params, &["itemId"], "itemId")?.into(),
                text_delta,
            }
        }
        "turn/plan/updated" => DomainEvent::PlanUpdated {
            turn_id: required_str(method, params, &["turnId"], "turnId")?.into(),
            steps: map_plan(method, params)?,
        },
        "turn/diff/updated" => DomainEvent::DiffUpdated {
            turn_id: required_str(method, params, &["turnId"], "turnId")?.into(),
            diff: required_str(method, params, &["diff"], "diff")?.into(),
        },
        "thread/tokenUsage/updated" => DomainEvent::UsageUpdated {
            usage: map_usage(method, params)?,
        },
        _ => return Ok(None),
    };
    Ok(Some(event))
}

fn completed_turn_status(
    method: &str,
    status: &str,
) -> Result<TurnStatus, NotificationMappingError> {
    match status {
        "inProgress" | "completed" => Ok(TurnStatus::Completed),
        "interrupted" => Ok(TurnStatus::Interrupted),
        "failed" => Ok(TurnStatus::Failed),
        value => Err(NotificationMappingError::UnsupportedValue {
            method: method.into(),
            field: "turn.status",
            value: value.into(),
        }),
    }
}

fn map_plan(method: &str, params: &Value) -> Result<Vec<PlanStep>, NotificationMappingError> {
    required_value(method, params, &["plan"], "plan")?
        .as_array()
        .ok_or_else(|| missing(method, "plan"))?
        .iter()
        .map(|entry| {
            let status = match required_str(method, entry, &["status"], "plan[].status")? {
                "completed" => PlanStepStatus::Done,
                "inProgress" => PlanStepStatus::Running,
                "pending" => PlanStepStatus::Pending,
                value => {
                    return Err(NotificationMappingError::UnsupportedValue {
                        method: method.into(),
                        field: "plan[].status",
                        value: value.into(),
                    });
                }
            };
            Ok(PlanStep {
                text: required_str(method, entry, &["step"], "plan[].step")?.into(),
                status,
            })
        })
        .collect()
}

fn map_usage(method: &str, params: &Value) -> Result<Usage, NotificationMappingError> {
    let total = required_value(method, params, &["tokenUsage", "total"], "tokenUsage.total")?;
    Ok(Usage {
        input_tokens: required_number(method, total, &["inputTokens"], "total.inputTokens")?,
        cached_input_tokens: required_number(
            method,
            total,
            &["cachedInputTokens"],
            "total.cachedInputTokens",
        )?,
        output_tokens: required_number(method, total, &["outputTokens"], "total.outputTokens")?,
        reasoning_tokens: required_number(
            method,
            total,
            &["reasoningOutputTokens"],
            "total.reasoningOutputTokens",
        )?,
        total_tokens: required_number(method, total, &["totalTokens"], "total.totalTokens")?,
        cost_usd: None,
        context_window: value_at(params, &["tokenUsage", "modelContextWindow"])
            .and_then(Value::as_f64)
            .filter(|window| *window != 0.0),
    })
}

fn map_approval_review(
    method: &str,
    params: &Value,
) -> Result<ApprovalReview, NotificationMappingError> {
    let status = match required_str(method, params, &["review", "status"], "review.status")? {
        "inProgress" => ApprovalReviewStatus::InProgress,
        "approved" => ApprovalReviewStatus::Approved,
        "denied" => ApprovalReviewStatus::Denied,
        "timedOut" => ApprovalReviewStatus::TimedOut,
        "aborted" => ApprovalReviewStatus::Aborted,
        value => {
            return Err(NotificationMappingError::UnsupportedValue {
                method: method.into(),
                field: "review.status",
                value: value.into(),
            });
        }
    };
    let risk_level = match value_at(params, &["review", "riskLevel"]).and_then(Value::as_str) {
        None => None,
        Some("low") => Some(RiskLevel::Low),
        Some("medium") => Some(RiskLevel::Medium),
        Some("high") => Some(RiskLevel::High),
        Some("critical") => Some(RiskLevel::Critical),
        Some(value) => {
            return Err(NotificationMappingError::UnsupportedValue {
                method: method.into(),
                field: "review.riskLevel",
                value: value.into(),
            });
        }
    };
    Ok(ApprovalReview {
        id: required_str(method, params, &["reviewId"], "reviewId")?.into(),
        turn_id: required_str(method, params, &["turnId"], "turnId")?.into(),
        status,
        description: describe_review_action(method, params)?,
        rationale: value_at(params, &["review", "rationale"])
            .and_then(Value::as_str)
            .map(str::to_owned),
        risk_level,
        started_at: required_number(method, params, &["startedAtMs"], "startedAtMs")?,
        completed_at: value_at(params, &["completedAtMs"]).and_then(Value::as_f64),
    })
}

fn describe_review_action(
    method: &str,
    params: &Value,
) -> Result<String, NotificationMappingError> {
    let action = required_value(method, params, &["action"], "action")?;
    match required_str(method, action, &["type"], "action.type")? {
        "command" => Ok(format!(
            "Run {}",
            required_str(method, action, &["command"], "action.command")?
        )),
        "execve" => {
            let program = required_str(method, action, &["program"], "action.program")?;
            let arguments = required_value(method, action, &["argv"], "action.argv")?
                .as_array()
                .ok_or_else(|| missing(method, "action.argv"))?
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>();
            let command = std::iter::once(program)
                .chain(arguments)
                .collect::<Vec<_>>()
                .join(" ");
            Ok(format!("Run {command}"))
        }
        "applyPatch" => {
            let files = required_value(method, action, &["files"], "action.files")?
                .as_array()
                .ok_or_else(|| missing(method, "action.files"))?;
            if files.len() == 1 {
                Ok(format!(
                    "Edit {}",
                    files[0].as_str().unwrap_or("unknown file")
                ))
            } else {
                Ok(format!("Edit {} files", files.len()))
            }
        }
        "networkAccess" => Ok(format!(
            "Connect to {}",
            required_str(method, action, &["target"], "action.target")?
        )),
        "mcpToolCall" => {
            let title = action
                .get("toolTitle")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| {
                    let server = action
                        .get("server")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let tool = action
                        .get("toolName")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    format!("{server}.{tool}")
                });
            Ok(format!("Use {title}"))
        }
        "requestPermissions" => Ok(action
            .get("reason")
            .and_then(Value::as_str)
            .map(|reason| format!("Request extra permissions: {reason}"))
            .unwrap_or_else(|| "Request extra permissions".into())),
        value => Err(NotificationMappingError::UnsupportedValue {
            method: method.into(),
            field: "action.type",
            value: value.into(),
        }),
    }
}

fn command_output(params: &Value) -> String {
    if let Some(delta) = params.get("delta").and_then(Value::as_str) {
        return delta.into();
    }
    params
        .get("deltaBase64")
        .and_then(Value::as_str)
        .and_then(|encoded| STANDARD.decode(encoded).ok())
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default()
}

fn required_str<'a>(
    method: &str,
    value: &'a Value,
    path: &[&str],
    field: &'static str,
) -> Result<&'a str, NotificationMappingError> {
    value_at(value, path)
        .and_then(Value::as_str)
        .ok_or_else(|| missing(method, field))
}

fn required_number(
    method: &str,
    value: &Value,
    path: &[&str],
    field: &'static str,
) -> Result<f64, NotificationMappingError> {
    value_at(value, path)
        .and_then(Value::as_f64)
        .ok_or_else(|| missing(method, field))
}

fn required_value<'a>(
    method: &str,
    value: &'a Value,
    path: &[&str],
    field: &'static str,
) -> Result<&'a Value, NotificationMappingError> {
    value_at(value, path).ok_or_else(|| missing(method, field))
}

fn value_at<'a>(mut value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    for segment in path {
        value = value.get(segment)?;
    }
    Some(value)
}

fn missing(method: &str, field: &'static str) -> NotificationMappingError {
    NotificationMappingError::MissingField {
        method: method.into(),
        field,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use harness_protocol::{ItemType, MessageRole};
    use serde_json::json;

    #[test]
    fn maps_captured_thread_turn_item_and_delta_lifecycle() {
        assert_eq!(
            map_domain_notification(
                "thread/started",
                &json!({ "thread": { "id": "thread-1", "cwd": "/repo" } }),
                1000.0,
            )
            .unwrap(),
            Some(DomainEvent::ThreadStarted {
                thread: Thread {
                    id: "thread-1".into(),
                    provider: ProviderId::Codex,
                    connection_id: None,
                    workspace_path: "/repo".into(),
                    title: None,
                    created_at: 1000.0,
                }
            })
        );
        assert_eq!(
            map_domain_notification(
                "turn/started",
                &json!({ "threadId": "thread-1", "turn": { "id": "turn-1" } }),
                1001.0,
            )
            .unwrap(),
            Some(DomainEvent::TurnStarted {
                turn: Turn {
                    id: "turn-1".into(),
                    thread_id: "thread-1".into(),
                    status: TurnStatus::Running,
                    created_at: 1001.0,
                }
            })
        );

        let started = map_domain_notification(
            "item/started",
            &json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "startedAtMs": 1002,
                "item": { "type": "agentMessage", "id": "item-1", "text": "" }
            }),
            0.0,
        )
        .unwrap()
        .unwrap();
        let DomainEvent::ItemStarted { item } = started else {
            panic!("expected item.started");
        };
        assert_eq!(item.item_type, ItemType::Message);
        assert_eq!(item.role, Some(MessageRole::Assistant));
        assert_eq!(item.created_at, 1002.0);

        assert_eq!(
            map_domain_notification(
                "item/agentMessage/delta",
                &json!({ "turnId": "turn-1", "itemId": "item-1", "delta": "hello" }),
                0.0,
            )
            .unwrap(),
            Some(DomainEvent::ItemDelta {
                turn_id: "turn-1".into(),
                item_id: "item-1".into(),
                text_delta: "hello".into(),
            })
        );

        assert_eq!(
            map_domain_notification(
                "turn/completed",
                &json!({ "threadId": "thread-1", "turn": { "id": "turn-1", "status": "interrupted" } }),
                0.0,
            )
            .unwrap(),
            Some(DomainEvent::TurnCompleted {
                turn_id: "turn-1".into(),
                status: TurnStatus::Interrupted,
            })
        );
    }

    #[test]
    fn decodes_command_bytes_and_maps_plan_diff_and_usage() {
        assert_eq!(
            map_domain_notification(
                "item/commandExecution/outputDelta",
                &json!({
                    "turnId": "turn-1",
                    "itemId": "command-1",
                    "deltaBase64": "b2sK"
                }),
                0.0,
            )
            .unwrap(),
            Some(DomainEvent::ItemDelta {
                turn_id: "turn-1".into(),
                item_id: "command-1".into(),
                text_delta: "ok\n".into(),
            })
        );
        assert_eq!(
            map_domain_notification(
                "turn/plan/updated",
                &json!({
                    "turnId": "turn-1",
                    "plan": [
                        { "step": "Inspect", "status": "completed" },
                        { "step": "Port", "status": "inProgress" },
                        { "step": "Verify", "status": "pending" }
                    ]
                }),
                0.0,
            )
            .unwrap(),
            Some(DomainEvent::PlanUpdated {
                turn_id: "turn-1".into(),
                steps: vec![
                    PlanStep {
                        text: "Inspect".into(),
                        status: PlanStepStatus::Done
                    },
                    PlanStep {
                        text: "Port".into(),
                        status: PlanStepStatus::Running
                    },
                    PlanStep {
                        text: "Verify".into(),
                        status: PlanStepStatus::Pending
                    },
                ],
            })
        );
        assert_eq!(
            map_domain_notification(
                "turn/diff/updated",
                &json!({ "turnId": "turn-1", "diff": "diff --git a/a b/a" }),
                0.0,
            )
            .unwrap(),
            Some(DomainEvent::DiffUpdated {
                turn_id: "turn-1".into(),
                diff: "diff --git a/a b/a".into(),
            })
        );
        assert_eq!(
            map_domain_notification(
                "thread/tokenUsage/updated",
                &json!({
                    "tokenUsage": {
                        "total": {
                            "inputTokens": 12,
                            "cachedInputTokens": 4,
                            "outputTokens": 7,
                            "reasoningOutputTokens": 2,
                            "totalTokens": 19
                        },
                        "modelContextWindow": 258400
                    }
                }),
                0.0,
            )
            .unwrap(),
            Some(DomainEvent::UsageUpdated {
                usage: Usage {
                    input_tokens: 12.0,
                    cached_input_tokens: 4.0,
                    output_tokens: 7.0,
                    reasoning_tokens: 2.0,
                    total_tokens: 19.0,
                    cost_usd: None,
                    context_window: Some(258400.0),
                },
            })
        );
    }

    #[test]
    fn maps_captured_auto_review_and_keeps_unmapped_notifications_nonfatal() {
        let event = map_domain_notification(
            "item/autoApprovalReview/completed",
            &json!({
                "threadId": "captured-thread",
                "turnId": "captured-turn",
                "startedAtMs": 1_785_627_335_059_f64,
                "completedAtMs": 1_785_627_339_124_f64,
                "reviewId": "captured-review",
                "review": {
                    "status": "approved",
                    "riskLevel": "low",
                    "rationale": "The user explicitly authorized this read-only git status check."
                },
                "action": {
                    "type": "command",
                    "source": "shell",
                    "command": "pwsh -Command git status --short",
                    "cwd": "D:\\\\repo"
                }
            }),
            0.0,
        )
        .unwrap()
        .unwrap();
        let DomainEvent::ApprovalReviewCompleted { review } = event else {
            panic!("expected approval review");
        };
        assert_eq!(review.id, "captured-review");
        assert_eq!(review.status, ApprovalReviewStatus::Approved);
        assert_eq!(review.description, "Run pwsh -Command git status --short");
        assert_eq!(review.risk_level, Some(RiskLevel::Low));
        assert_eq!(review.completed_at, Some(1_785_627_339_124.0));

        assert_eq!(
            map_domain_notification("new/provider/event", &json!({}), 0.0).unwrap(),
            None
        );
    }

    #[test]
    fn reports_malformed_known_frames_without_panicking() {
        assert_eq!(
            map_domain_notification("turn/started", &json!({}), 0.0),
            Err(NotificationMappingError::MissingField {
                method: "turn/started".into(),
                field: "turn.id",
            })
        );
        assert_eq!(
            map_domain_notification(
                "turn/completed",
                &json!({ "turn": { "id": "turn-1", "status": "futureStatus" } }),
                0.0,
            ),
            Err(NotificationMappingError::UnsupportedValue {
                method: "turn/completed".into(),
                field: "turn.status",
                value: "futureStatus".into(),
            })
        );
    }
}
