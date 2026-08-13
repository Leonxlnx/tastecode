use harness_protocol::{ModelConnectionPreset, ProviderId};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ProviderMark {
    OpenAi,
    Anthropic,
    Grok,
    Cursor,
    OpenCode,
    OpenRouter,
    Kimi,
    Qwen,
    Zai,
    Antigravity,
    Pi,
    Acp,
    Custom,
}

pub(crate) fn provider_mark(provider: ProviderId) -> ProviderMark {
    match provider {
        ProviderId::Codex => ProviderMark::OpenAi,
        ProviderId::ClaudeCode => ProviderMark::Anthropic,
        ProviderId::Grok => ProviderMark::Grok,
        ProviderId::Cursor => ProviderMark::Cursor,
        ProviderId::OpenCode => ProviderMark::OpenCode,
        ProviderId::Antigravity => ProviderMark::Antigravity,
        ProviderId::Acp => ProviderMark::Acp,
        ProviderId::Api => ProviderMark::Custom,
    }
}

pub(crate) fn agent_mark(agent_id: &str) -> ProviderMark {
    match agent_id {
        "kimi" => ProviderMark::Kimi,
        "qwen" => ProviderMark::Qwen,
        _ => ProviderMark::Acp,
    }
}

pub(crate) fn connection_mark(preset: ModelConnectionPreset) -> ProviderMark {
    match preset {
        ModelConnectionPreset::Openai => ProviderMark::OpenAi,
        ModelConnectionPreset::Anthropic => ProviderMark::Anthropic,
        ModelConnectionPreset::Openrouter => ProviderMark::OpenRouter,
        ModelConnectionPreset::Kimi => ProviderMark::Kimi,
        ModelConnectionPreset::Zai => ProviderMark::Zai,
        ModelConnectionPreset::Custom => ProviderMark::Custom,
    }
}

pub(crate) fn provider_mark_path(mark: ProviderMark) -> &'static str {
    match mark {
        ProviderMark::OpenAi => "icons/openai.svg",
        ProviderMark::Anthropic => "icons/anthropic.svg",
        ProviderMark::Grok => "icons/grok.svg",
        ProviderMark::Cursor => "icons/cursor.svg",
        ProviderMark::OpenCode => "icons/opencode.svg",
        ProviderMark::OpenRouter => "icons/openrouter.svg",
        ProviderMark::Kimi => "icons/kimi.svg",
        ProviderMark::Qwen => "icons/qwen.svg",
        ProviderMark::Zai => "icons/zai.svg",
        ProviderMark::Antigravity => "icons/antigravity.svg",
        ProviderMark::Pi => "icons/pi.svg",
        ProviderMark::Acp => "icons/acp.svg",
        ProviderMark::Custom => "icons/custom-provider.svg",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_provider_roster_has_specific_marks() {
        assert_eq!(provider_mark(ProviderId::Grok), ProviderMark::Grok);
        assert_eq!(
            provider_mark(ProviderId::Antigravity),
            ProviderMark::Antigravity
        );
        assert_eq!(agent_mark("kimi"), ProviderMark::Kimi);
        assert_eq!(
            connection_mark(ModelConnectionPreset::Openrouter),
            ProviderMark::OpenRouter
        );
    }
}
