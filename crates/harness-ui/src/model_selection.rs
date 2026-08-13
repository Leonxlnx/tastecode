use crate::client_state::ModelChoice;
use harness_protocol::{Model, ProviderId, ServiceTier};

pub(crate) fn source_key(choice: &ModelChoice) -> String {
    if let Some(connection_id) = &choice.connection_id {
        return format!("api:{connection_id}");
    }
    if let Some(agent_id) = &choice.agent_id {
        return format!("acp:{agent_id}");
    }
    provider_key(choice.provider).into()
}

pub(crate) fn filter_model_choices_by_query(
    choices: &[ModelChoice],
    query: &str,
) -> Vec<ModelChoice> {
    let terms = query
        .split_whitespace()
        .map(str::to_lowercase)
        .collect::<Vec<_>>();
    if terms.is_empty() {
        return choices.to_vec();
    }
    choices
        .iter()
        .filter(|choice| {
            model_search_fields_match(
                &choice.source_name,
                &choice.model.display_name,
                &choice.model.id,
                &terms,
            )
        })
        .cloned()
        .collect()
}

fn model_search_fields_match(
    source_name: &str,
    display_name: &str,
    model_id: &str,
    terms: &[String],
) -> bool {
    let searchable = format!("{source_name} {display_name} {model_id}").to_lowercase();
    terms.iter().all(|term| searchable.contains(term))
}

pub(crate) fn fast_service_tier(model: &Model) -> Option<&ServiceTier> {
    model.service_tiers.iter().find(|tier| {
        let id = tier.id.trim().to_ascii_lowercase();
        let name = tier.name.trim().to_ascii_lowercase();
        matches!(id.as_str(), "priority" | "fast") || name == "fast"
    })
}

pub(crate) fn fast_mode_off_value(model: &Model) -> Option<String> {
    let default = model.default_service_tier.as_ref()?;
    (fast_service_tier(model).is_none_or(|tier| tier.id != *default)).then(|| default.clone())
}

pub(crate) fn is_fast_mode_enabled(model: &Model, service_tier: Option<&str>) -> bool {
    service_tier
        .is_some_and(|selected| fast_service_tier(model).is_some_and(|tier| tier.id == selected))
}

pub(crate) fn next_service_tier(
    current_model: Option<&Model>,
    next_model: &Model,
    current_service_tier: Option<&str>,
) -> Option<String> {
    if current_model.is_some_and(|model| is_fast_mode_enabled(model, current_service_tier)) {
        return fast_service_tier(next_model)
            .map(|tier| tier.id.clone())
            .or_else(|| fast_mode_off_value(next_model));
    }
    if current_service_tier.is_some_and(|selected| {
        next_model
            .service_tiers
            .iter()
            .any(|tier| tier.id == selected)
    }) {
        return current_service_tier.map(str::to_owned);
    }
    fast_mode_off_value(next_model)
}

fn provider_key(provider: ProviderId) -> &'static str {
    match provider {
        ProviderId::Codex => "codex",
        ProviderId::ClaudeCode => "claude-code",
        ProviderId::Grok => "grok",
        ProviderId::Cursor => "cursor",
        ProviderId::OpenCode => "opencode",
        ProviderId::Antigravity => "antigravity",
        ProviderId::Acp => "acp",
        ProviderId::Api => "api",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(default: Option<&str>, tiers: &[(&str, &str)]) -> Model {
        Model {
            id: "model".into(),
            display_name: "Model".into(),
            description: None,
            is_default: true,
            reasoning_efforts: Vec::new(),
            default_reasoning_effort: None,
            service_tiers: tiers
                .iter()
                .map(|(id, name)| ServiceTier {
                    id: (*id).into(),
                    name: (*name).into(),
                    description: String::new(),
                })
                .collect(),
            default_service_tier: default.map(str::to_owned),
        }
    }

    #[test]
    fn fast_intent_crosses_provider_specific_tier_ids() {
        let codex = model(None, &[("priority", "Priority")]);
        let cursor = model(
            Some("standard"),
            &[("standard", "Standard"), ("fast", "Fast")],
        );

        assert_eq!(
            next_service_tier(Some(&codex), &cursor, Some("priority")).as_deref(),
            Some("fast")
        );
        assert!(!is_fast_mode_enabled(&cursor, Some("standard")));
        assert_eq!(fast_mode_off_value(&cursor).as_deref(), Some("standard"));
    }

    #[test]
    fn default_fast_tier_turns_fully_off() {
        let model = model(Some("priority"), &[("priority", "Fast")]);

        assert_eq!(fast_mode_off_value(&model), None);
    }

    #[test]
    fn model_search_matches_every_case_insensitive_visible_term() {
        let terms = ["opus", "openrouter"]
            .into_iter()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        assert!(model_search_fields_match(
            "OpenCode",
            "OpenRouter · Claude Opus 5",
            "openrouter/claude-opus-5",
            &terms,
        ));
        assert!(!model_search_fields_match(
            "OpenCode",
            "OpenCode Go · Qwen3.8 Max",
            "qwen/qwen3.8-max",
            &terms,
        ));
    }
}
