use crate::control::{ClaudeControl, run_command};
use crate::session::{ClaudeCodeSession, ClaudeCommand, ClaudeSessionState};
use harness_agent::{
    AgentError, AgentHandlers, AgentResult, AgentRuntime, AgentSession, ControlHandlers,
    ProviderControl, StartOptions,
};
use harness_protocol::{Model, Thread};
use std::collections::HashSet;
use std::ffi::OsString;
use std::sync::Arc;

#[derive(Clone, Debug, Default)]
pub struct ClaudeLaunchOptions {
    /// Extra process environment for controlled launches and tests.
    pub environment: Vec<(OsString, OsString)>,
}

pub struct ClaudeCodeRuntime {
    command: ClaudeCommand,
}

impl ClaudeCodeRuntime {
    pub fn new(options: ClaudeLaunchOptions) -> Self {
        Self {
            command: ClaudeCommand {
                program: OsString::from("claude"),
                prefix_args: Vec::new(),
                environment: options.environment,
                append_turn_args: true,
            },
        }
    }

    #[cfg(test)]
    pub(crate) fn with_command(command: ClaudeCommand) -> Self {
        Self { command }
    }
}

impl Default for ClaudeCodeRuntime {
    fn default() -> Self {
        Self::new(ClaudeLaunchOptions::default())
    }
}

impl AgentRuntime for ClaudeCodeRuntime {
    fn start(
        &self,
        workspace_path: &str,
        options: &StartOptions,
        handlers: AgentHandlers,
    ) -> AgentResult<(Thread, Arc<dyn AgentSession>)> {
        let (thread, session) =
            ClaudeCodeSession::start(workspace_path, options, self.command.clone(), handlers)?;
        Ok((thread, session))
    }

    fn resume(
        &self,
        thread_id: &str,
        workspace_path: &str,
        options: &StartOptions,
        handlers: AgentHandlers,
    ) -> AgentResult<(Thread, Arc<dyn AgentSession>)> {
        let saved = options
            .resume_state
            .as_ref()
            .ok_or_else(|| AgentError::Failed("Claude Code session state is unavailable".into()))?;
        let state = serde_json::from_value::<ClaudeSessionState>(saved.value().clone())
            .map_err(|_| AgentError::Failed("Claude Code session state is invalid".into()))?;
        if state.thread.id != thread_id || state.thread.workspace_path != workspace_path {
            return Err(AgentError::Failed(
                "Claude Code session state does not match the stored thread".into(),
            ));
        }
        let (thread, session) = ClaudeCodeSession::resume(state, self.command.clone(), handlers)?;
        Ok((thread, session))
    }

    fn list_models(&self) -> AgentResult<Vec<Model>> {
        Ok(claude_models_for_command(&self.command))
    }

    fn open_control(&self, handlers: ControlHandlers) -> AgentResult<Arc<dyn ProviderControl>> {
        Ok(Arc::new(ClaudeControl::new(self.command.clone(), handlers)))
    }
}

pub fn claude_models() -> Vec<Model> {
    const FULL_EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max"];
    vec![
        claude_alias(
            "fable",
            "Fable 5",
            "Most capable — flagship tier",
            FULL_EFFORTS,
            true,
            "high",
        ),
        claude_alias(
            "opus",
            "Opus 5",
            "Deep reasoning",
            FULL_EFFORTS,
            false,
            "high",
        ),
        claude_alias(
            "sonnet",
            "Sonnet 5",
            "Balanced speed and capability",
            FULL_EFFORTS,
            false,
            "high",
        ),
        claude_alias(
            "haiku",
            "Haiku 4.5",
            "Fastest and cheapest",
            &[],
            false,
            "high",
        ),
        claude_alias(
            "claude-opus-4-8",
            "Opus 4.8",
            "Previous Opus generation",
            FULL_EFFORTS,
            false,
            "high",
        ),
        claude_alias(
            "claude-opus-4-7",
            "Opus 4.7",
            "Older Opus generation",
            FULL_EFFORTS,
            false,
            "xhigh",
        ),
        claude_alias(
            "claude-opus-4-6",
            "Opus 4.6",
            "Older Opus generation",
            &["low", "medium", "high", "max"],
            false,
            "high",
        ),
        claude_alias(
            "claude-sonnet-4-6",
            "Sonnet 4.6",
            "Previous Sonnet generation",
            &["low", "medium", "high", "max"],
            false,
            "high",
        ),
    ]
}

pub(crate) fn claude_models_for_command(command: &ClaudeCommand) -> Vec<Model> {
    let efforts = run_command(command, &["--help"])
        .ok()
        .filter(|output| output.code == Some(0))
        .map(|output| parse_claude_efforts(&output.stdout))
        .unwrap_or_default();
    if efforts.is_empty() {
        claude_models()
    } else {
        claude_models_for_efforts(&efforts)
    }
}

/// Values published beside `--effort` in the installed Claude Code help text.
pub fn parse_claude_efforts(output: &str) -> Vec<String> {
    let lower = output.to_ascii_lowercase();
    for (start, _) in lower.match_indices("--effort") {
        let Some(after_flag) = output.get(start + "--effort".len()..) else {
            continue;
        };
        let whitespace_bytes = after_flag
            .chars()
            .take_while(|character| character.is_whitespace())
            .map(char::len_utf8)
            .sum::<usize>();
        if whitespace_bytes == 0 {
            continue;
        }
        let after_whitespace = &after_flag[whitespace_bytes..];
        let Some(argument_end) = after_whitespace.find('>') else {
            continue;
        };
        if !after_whitespace.starts_with('<') || argument_end <= 1 {
            continue;
        }
        let after_argument = &after_whitespace[argument_end + 1..];
        let Some(values_start) = after_argument
            .char_indices()
            .take(201)
            .find_map(|(index, character)| (character == '(').then_some(index))
        else {
            continue;
        };
        let values = &after_argument[values_start + 1..];
        let Some(values_end) = values.find(')') else {
            continue;
        };
        if values_end == 0 {
            continue;
        }
        let mut seen = HashSet::new();
        return values[..values_end]
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .filter(|value| seen.insert((*value).to_owned()))
            .map(str::to_owned)
            .collect();
    }
    Vec::new()
}

fn claude_models_for_efforts(available: &[String]) -> Vec<Model> {
    let supported = available.iter().map(String::as_str).collect::<HashSet<_>>();
    claude_models()
        .into_iter()
        .map(|mut model| {
            let declared = std::mem::take(&mut model.reasoning_efforts);
            model.reasoning_efforts = declared
                .iter()
                .filter(|effort| supported.contains(effort.as_str()))
                .cloned()
                .collect();
            let declared_default = model.default_reasoning_effort.take();
            if model.reasoning_efforts.is_empty() {
                return model;
            }
            if let Some(default) = declared_default
                .as_ref()
                .filter(|default| supported.contains(default.as_str()))
            {
                model.default_reasoning_effort = Some(default.clone());
                return model;
            }
            let default_index = declared_default
                .as_ref()
                .and_then(|default| declared.iter().position(|effort| effort == default))
                .map_or(-1, |index| index as isize);
            model.default_reasoning_effort = model
                .reasoning_efforts
                .iter()
                .min_by_key(|effort| {
                    let index = declared
                        .iter()
                        .position(|declared_effort| declared_effort == *effort)
                        .map_or(-1, |index| index as isize);
                    (index - default_index).abs()
                })
                .cloned();
            model
        })
        .collect()
}

fn claude_alias(
    id: &str,
    name: &str,
    description: &str,
    reasoning_efforts: &[&str],
    is_default: bool,
    default_reasoning_effort: &str,
) -> Model {
    Model {
        id: id.into(),
        display_name: name.into(),
        description: Some(description.into()),
        is_default,
        reasoning_efforts: reasoning_efforts
            .iter()
            .map(|effort| (*effort).into())
            .collect(),
        default_reasoning_effort: (!reasoning_efforts.is_empty())
            .then(|| default_reasoning_effort.into()),
        service_tiers: Vec::new(),
        default_service_tier: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    #[test]
    fn documented_aliases_have_one_default() {
        let models = claude_models();
        assert_eq!(
            models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            [
                "fable",
                "opus",
                "sonnet",
                "haiku",
                "claude-opus-4-8",
                "claude-opus-4-7",
                "claude-opus-4-6",
                "claude-sonnet-4-6",
            ]
        );
        assert_eq!(models.iter().filter(|model| model.is_default).count(), 1);
        assert_eq!(models[0].display_name, "Fable 5");
        assert_eq!(
            models[0].reasoning_efforts,
            ["low", "medium", "high", "xhigh", "max"]
        );
        assert_eq!(models[0].default_reasoning_effort.as_deref(), Some("high"));
        assert!(models[3].reasoning_efforts.is_empty());
        assert_eq!(models[5].default_reasoning_effort.as_deref(), Some("xhigh"));
        assert_eq!(models[6].display_name, "Opus 4.6");
        assert_eq!(
            models[6].reasoning_efforts,
            ["low", "medium", "high", "max"]
        );
        assert_eq!(models[6].default_reasoning_effort.as_deref(), Some("high"));
        assert_eq!(
            models[7].reasoning_efforts,
            ["low", "medium", "high", "max"]
        );
    }

    #[test]
    fn parses_and_deduplicates_installed_effort_values() {
        let help = "  --EFFORT <level>  Effort level for the current session\n\
                    (low, medium, high, max, high)\n";
        assert_eq!(parse_claude_efforts(help), ["low", "medium", "high", "max"]);
        assert!(parse_claude_efforts("--effort level (low, high)").is_empty());
        assert!(parse_claude_efforts("--effort <level>").is_empty());
    }

    #[test]
    fn installed_efforts_filter_every_model_and_choose_the_nearest_default() {
        let efforts = ["low", "medium", "high", "max"].map(str::to_owned);
        let models = claude_models_for_efforts(&efforts);
        assert_eq!(
            models[0].reasoning_efforts,
            ["low", "medium", "high", "max"]
        );
        assert_eq!(models[0].default_reasoning_effort.as_deref(), Some("high"));
        assert_eq!(models[5].default_reasoning_effort.as_deref(), Some("high"));
        assert!(models[3].reasoning_efforts.is_empty());
        assert_eq!(models[3].default_reasoning_effort, None);
    }

    #[test]
    fn default_runtime_invokes_the_vendor_cli_directly() {
        let runtime = ClaudeCodeRuntime::default();
        assert_eq!(runtime.command.program, OsStr::new("claude"));
        assert!(runtime.command.prefix_args.is_empty());
        assert!(runtime.command.append_turn_args);
    }
}
