use crate::client_state::ModelChoice;
use crate::model_selection::source_key;
use crate::theme::{Accent, Backdrop};
use anyhow::{Context as _, Result};
use harness_protocol::{ApprovalMode, Model, ProviderId};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;

const PREFERENCES_VERSION: u8 = 7;
const PREFERENCES_FILE: &str = "gpui-settings.json";
const MODEL_CATALOG_CACHE_VERSION: u8 = 1;
const MODEL_CATALOG_CACHE_FILE: &str = "gpui-model-catalog-cache.json";
const MAX_MODEL_CATALOG_CACHE_BYTES: usize = 2_000_000;
const MAX_CACHED_MODELS: usize = 2_000;
const DEFAULT_RAIL_WIDTH: u16 = 248;
const MIN_STORED_RAIL_WIDTH: u16 = 176;
const MAX_STORED_RAIL_WIDTH: u16 = 420;
const DEFAULT_TERMINAL_HEIGHT: u16 = 260;
const MIN_TERMINAL_HEIGHT: u16 = 160;
const MAX_STORED_TERMINAL_HEIGHT: u16 = 4_096;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ThemePreference {
    System,
    Light,
    #[default]
    Dark,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum FontPreference {
    #[default]
    Geist,
    System,
    Humanist,
    Rounded,
    Serif,
    Mono,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct NativePreferences {
    version: u8,
    pub(crate) theme: ThemePreference,
    pub(crate) font: FontPreference,
    pub(crate) accent: Accent,
    pub(crate) backdrop: Backdrop,
    pub(crate) sidebar_glass: u8,
    pub(crate) rail_width: u16,
    pub(crate) session_order: HashMap<String, Vec<String>>,
    pub(crate) hidden_models: HashSet<String>,
    pub(crate) selected_model_key: Option<String>,
    pub(crate) model_by_source: HashMap<String, SourceSelection>,
    pub(crate) approval: ApprovalMode,
    pub(crate) terminal_open: bool,
    pub(crate) terminal_height: u16,
}

impl Default for NativePreferences {
    fn default() -> Self {
        Self {
            version: PREFERENCES_VERSION,
            theme: ThemePreference::Dark,
            font: FontPreference::Geist,
            accent: Accent::Neutral,
            backdrop: Backdrop::Default,
            sidebar_glass: 35,
            rail_width: DEFAULT_RAIL_WIDTH,
            session_order: HashMap::new(),
            hidden_models: HashSet::new(),
            selected_model_key: None,
            model_by_source: HashMap::new(),
            approval: ApprovalMode::Ask,
            terminal_open: false,
            terminal_height: DEFAULT_TERMINAL_HEIGHT,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceSelection {
    pub(crate) model_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) service_tier: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelCatalogCache {
    version: u8,
    models: Vec<CachedModelChoice>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedModelChoice {
    key: String,
    provider: ProviderId,
    source_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent_name: Option<String>,
    model: Model,
}

impl NativePreferences {
    pub(crate) fn load() -> Result<Self> {
        let Some(path) = preferences_path() else {
            return Ok(Self::default());
        };
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Self::default());
            }
            Err(error) => {
                return Err(error).with_context(|| format!("read {}", path.display()));
            }
        };
        let mut preferences = serde_json::from_slice::<Self>(&bytes)
            .with_context(|| format!("parse {}", path.display()))?;
        if preferences.version < 4 {
            preferences.sidebar_glass = 35;
        }
        if preferences.version < 5 {
            preferences.rail_width = DEFAULT_RAIL_WIDTH;
        }
        preferences.version = PREFERENCES_VERSION;
        preferences.sidebar_glass = preferences.sidebar_glass.min(60);
        preferences.rail_width = normalized_rail_width(preferences.rail_width);
        preferences.terminal_height = normalized_terminal_height(preferences.terminal_height);
        Ok(preferences)
    }

    pub(crate) fn save(&self) -> Result<()> {
        let path = preferences_path().context("the platform has no configuration directory")?;
        let parent = path.parent().context("preferences path has no parent")?;
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
        let bytes = serde_json::to_vec_pretty(self).context("encode native preferences")?;
        fs::write(&path, bytes).with_context(|| format!("write {}", path.display()))
    }

    pub(crate) fn restored_model_catalog(&self) -> Option<Vec<ModelChoice>> {
        if let Some(cache) = read_model_catalog_cache() {
            return Some(
                cache
                    .models
                    .into_iter()
                    .enumerate()
                    .map(|(index, choice)| choice.into_model_choice(index))
                    .collect(),
            );
        }
        self.restored_selected_model_choice()
            .map(|choice| vec![choice])
    }

    pub(crate) fn save_model_catalog_cache(models: &[ModelChoice]) -> Result<()> {
        let Some(bytes) = encode_model_catalog_cache(models)? else {
            return remove_model_catalog_cache();
        };
        let path =
            model_catalog_cache_path().context("the platform has no configuration directory")?;
        let parent = path
            .parent()
            .context("model catalog cache path has no parent")?;
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
        fs::write(&path, bytes).with_context(|| format!("write {}", path.display()))
    }

    pub(crate) fn reset_file() -> Result<()> {
        for path in [preferences_path(), model_catalog_cache_path()]
            .into_iter()
            .flatten()
        {
            remove_file_if_present(&path)?;
        }
        Ok(())
    }

    fn restored_selected_model_choice(&self) -> Option<ModelChoice> {
        let key = self.selected_model_key.as_ref()?;
        let (source, model_id) = key.split_once('\u{1f}')?;
        let source_metadata = restored_source(source)?;
        let effort = self
            .model_by_source
            .get(source)
            .filter(|selection| selection.model_key == *key)
            .and_then(|selection| selection.effort.clone());
        Some(ModelChoice {
            key: key.clone(),
            provider: source_metadata.provider,
            source_name: source_metadata.name,
            connection_id: source_metadata.connection_id,
            agent_id: source_metadata.agent_id,
            agent_name: source_metadata.agent_name,
            model: Model {
                id: model_id.into(),
                display_name: if model_id.is_empty() {
                    "Provider default".into()
                } else {
                    model_id.into()
                },
                description: None,
                is_default: true,
                reasoning_efforts: effort.clone().into_iter().collect(),
                default_reasoning_effort: effort,
                service_tiers: Vec::new(),
                default_service_tier: None,
            },
            catalog_order: (0, 0, 0),
        })
    }
}

impl From<&ModelChoice> for CachedModelChoice {
    fn from(choice: &ModelChoice) -> Self {
        Self {
            key: choice.key.clone(),
            provider: choice.provider,
            source_name: choice.source_name.clone(),
            connection_id: choice.connection_id.clone(),
            agent_id: choice.agent_id.clone(),
            agent_name: choice.agent_name.clone(),
            model: choice.model.clone(),
        }
    }
}

impl CachedModelChoice {
    fn into_model_choice(self, index: usize) -> ModelChoice {
        ModelChoice {
            key: self.key,
            provider: self.provider,
            source_name: self.source_name,
            connection_id: self.connection_id,
            agent_id: self.agent_id,
            agent_name: self.agent_name,
            model: self.model,
            catalog_order: (0, 0, index),
        }
    }
}

struct RestoredSource {
    provider: ProviderId,
    name: String,
    connection_id: Option<String>,
    agent_id: Option<String>,
    agent_name: Option<String>,
}

fn restored_source(source: &str) -> Option<RestoredSource> {
    let direct = match source {
        "codex" => Some((ProviderId::Codex, "Codex")),
        "claude-code" => Some((ProviderId::ClaudeCode, "Claude Code")),
        "grok" => Some((ProviderId::Grok, "Grok")),
        "cursor" => Some((ProviderId::Cursor, "Cursor")),
        "opencode" => Some((ProviderId::OpenCode, "OpenCode")),
        "antigravity" => Some((ProviderId::Antigravity, "Antigravity")),
        _ => None,
    };
    if let Some((provider, name)) = direct {
        return Some(RestoredSource {
            provider,
            name: name.into(),
            connection_id: None,
            agent_id: None,
            agent_name: None,
        });
    }
    if let Some(connection_id) = source
        .strip_prefix("api:")
        .filter(|connection_id| !connection_id.is_empty())
    {
        return Some(RestoredSource {
            provider: ProviderId::Api,
            name: "API connection".into(),
            connection_id: Some(connection_id.into()),
            agent_id: None,
            agent_name: None,
        });
    }
    let agent_id = source
        .strip_prefix("acp:")
        .filter(|agent_id| !agent_id.is_empty())?;
    Some(RestoredSource {
        provider: ProviderId::Acp,
        name: agent_id.into(),
        connection_id: None,
        agent_id: Some(agent_id.into()),
        agent_name: Some(agent_id.into()),
    })
}

fn read_model_catalog_cache() -> Option<ModelCatalogCache> {
    let path = model_catalog_cache_path()?;
    let bytes = fs::read(path).ok()?;
    parse_model_catalog_cache(&bytes)
}

fn parse_model_catalog_cache(bytes: &[u8]) -> Option<ModelCatalogCache> {
    if bytes.len() > MAX_MODEL_CATALOG_CACHE_BYTES {
        return None;
    }
    let cache = serde_json::from_slice::<ModelCatalogCache>(bytes).ok()?;
    if cache.version != MODEL_CATALOG_CACHE_VERSION || cache.models.len() > MAX_CACHED_MODELS {
        return None;
    }
    let mut keys = HashSet::with_capacity(cache.models.len());
    let valid = cache.models.iter().enumerate().all(|(index, cached)| {
        let choice = cached.clone().into_model_choice(index);
        valid_cached_model_choice(&choice) && keys.insert(choice.key)
    });
    valid.then_some(cache)
}

fn encode_model_catalog_cache(models: &[ModelChoice]) -> Result<Option<Vec<u8>>> {
    if models.len() > MAX_CACHED_MODELS {
        return Ok(None);
    }
    let mut keys = HashSet::with_capacity(models.len());
    if !models
        .iter()
        .all(|choice| valid_cached_model_choice(choice) && keys.insert(choice.key.as_str()))
    {
        return Ok(None);
    }
    let cache = ModelCatalogCache {
        version: MODEL_CATALOG_CACHE_VERSION,
        models: models.iter().map(CachedModelChoice::from).collect(),
    };
    let bytes = serde_json::to_vec(&cache).context("encode native model catalog cache")?;
    Ok((bytes.len() <= MAX_MODEL_CATALOG_CACHE_BYTES).then_some(bytes))
}

fn valid_cached_model_choice(choice: &ModelChoice) -> bool {
    if choice.key.is_empty()
        || choice.source_name.is_empty()
        || choice.model.display_name.is_empty()
    {
        return false;
    }
    let source_shape_is_valid = match choice.provider {
        ProviderId::Api => {
            choice
                .connection_id
                .as_deref()
                .is_some_and(|id| !id.is_empty() && !id.contains('\u{1f}'))
                && choice.agent_id.is_none()
                && choice.agent_name.is_none()
        }
        ProviderId::Acp => {
            choice.connection_id.is_none()
                && choice
                    .agent_id
                    .as_deref()
                    .is_some_and(|id| !id.is_empty() && !id.contains('\u{1f}'))
                && choice
                    .agent_name
                    .as_deref()
                    .is_some_and(|name| !name.is_empty())
        }
        ProviderId::Codex
        | ProviderId::ClaudeCode
        | ProviderId::Grok
        | ProviderId::Cursor
        | ProviderId::OpenCode
        | ProviderId::Antigravity => {
            choice.connection_id.is_none()
                && choice.agent_id.is_none()
                && choice.agent_name.is_none()
        }
    };
    source_shape_is_valid
        && choice.key == format!("{}\u{1f}{}", source_key(choice), choice.model.id)
}

fn remove_model_catalog_cache() -> Result<()> {
    if let Some(path) = model_catalog_cache_path() {
        remove_file_if_present(&path)?;
    }
    Ok(())
}

fn remove_file_if_present(path: &std::path::Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("remove {}", path.display())),
    }
}

fn preferences_path() -> Option<PathBuf> {
    dirs::config_dir().map(|directory| directory.join("Personal Harness").join(PREFERENCES_FILE))
}

fn model_catalog_cache_path() -> Option<PathBuf> {
    dirs::config_dir().map(|directory| {
        directory
            .join("Personal Harness")
            .join(MODEL_CATALOG_CACHE_FILE)
    })
}

fn normalized_rail_width(width: u16) -> u16 {
    if (MIN_STORED_RAIL_WIDTH..=MAX_STORED_RAIL_WIDTH).contains(&width) {
        width
    } else {
        DEFAULT_RAIL_WIDTH
    }
}

fn normalized_terminal_height(height: u16) -> u16 {
    if height < MIN_TERMINAL_HEIGHT {
        DEFAULT_TERMINAL_HEIGHT
    } else {
        height.min(MAX_STORED_TERMINAL_HEIGHT)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model_choice(source: &str, provider: ProviderId, model_id: &str) -> ModelChoice {
        ModelChoice {
            key: format!("{source}\u{1f}{model_id}"),
            provider,
            source_name: match provider {
                ProviderId::Codex => "Codex".into(),
                ProviderId::Api => "Work API".into(),
                _ => "Source".into(),
            },
            connection_id: (provider == ProviderId::Api)
                .then(|| source.strip_prefix("api:").expect("API test source").into()),
            agent_id: None,
            agent_name: None,
            model: Model {
                id: model_id.into(),
                display_name: model_id.into(),
                description: None,
                is_default: true,
                reasoning_efforts: vec!["low".into(), "high".into()],
                default_reasoning_effort: Some("high".into()),
                service_tiers: Vec::new(),
                default_service_tier: None,
            },
            catalog_order: (0, 0, 0),
        }
    }

    #[test]
    fn missing_fields_keep_stable_defaults() {
        let preferences: NativePreferences = serde_json::from_str("{}").unwrap();

        assert_eq!(preferences.theme, ThemePreference::Dark);
        assert_eq!(preferences.font, FontPreference::Geist);
        assert_eq!(preferences.accent, Accent::Neutral);
        assert_eq!(preferences.sidebar_glass, 35);
        assert_eq!(preferences.rail_width, 248);
        assert!(preferences.session_order.is_empty());
        assert!(preferences.hidden_models.is_empty());
        assert_eq!(preferences.selected_model_key, None);
        assert!(preferences.model_by_source.is_empty());
        assert_eq!(preferences.approval, ApprovalMode::Ask);
        assert!(!preferences.terminal_open);
        assert_eq!(preferences.terminal_height, 260);
    }

    #[test]
    fn stored_geometry_uses_the_web_bounds_and_fallbacks() {
        assert_eq!(normalized_rail_width(175), 248);
        assert_eq!(normalized_rail_width(176), 176);
        assert_eq!(normalized_rail_width(420), 420);
        assert_eq!(normalized_rail_width(421), 248);

        assert_eq!(normalized_terminal_height(159), 260);
        assert_eq!(normalized_terminal_height(160), 160);
        assert_eq!(normalized_terminal_height(4_096), 4_096);
        assert_eq!(normalized_terminal_height(4_097), 4_096);
    }

    #[test]
    fn preferences_round_trip_without_model_order_dependence() {
        let mut preferences = NativePreferences {
            theme: ThemePreference::Dark,
            font: FontPreference::Mono,
            accent: Accent::Lavender,
            backdrop: Backdrop::Plum,
            sidebar_glass: 35,
            rail_width: 312,
            approval: ApprovalMode::Full,
            terminal_open: true,
            terminal_height: 420,
            ..NativePreferences::default()
        };
        preferences.session_order.insert(
            "/work/harness".into(),
            vec!["thread-2".into(), "thread-1".into()],
        );
        preferences.hidden_models.insert("codex\u{1f}gpt-5".into());
        preferences.selected_model_key = Some("cursor\u{1f}composer-2".into());
        preferences.model_by_source.insert(
            "cursor".into(),
            SourceSelection {
                model_key: "cursor\u{1f}composer-2".into(),
                effort: Some("high".into()),
                service_tier: Some("fast".into()),
            },
        );
        let json = serde_json::to_string(&preferences).unwrap();
        let decoded: NativePreferences = serde_json::from_str(&json).unwrap();

        assert_eq!(decoded, preferences);
    }

    #[test]
    fn model_catalog_cache_round_trips_sources_and_order() {
        let models = vec![
            model_choice("codex", ProviderId::Codex, "gpt-5"),
            model_choice("api:work", ProviderId::Api, "open-model"),
        ];

        let bytes = encode_model_catalog_cache(&models).unwrap().unwrap();
        let restored = parse_model_catalog_cache(&bytes)
            .unwrap()
            .models
            .into_iter()
            .enumerate()
            .map(|(index, choice)| choice.into_model_choice(index))
            .collect::<Vec<_>>();

        assert_eq!(
            restored
                .iter()
                .map(|choice| choice.key.as_str())
                .collect::<Vec<_>>(),
            ["codex\u{1f}gpt-5", "api:work\u{1f}open-model"]
        );
        assert_eq!(restored[1].connection_id.as_deref(), Some("work"));
        assert_eq!(restored[1].catalog_order, (0, 0, 1));
    }

    #[test]
    fn one_invalid_entry_rejects_the_whole_model_catalog_cache() {
        let invalid = ModelCatalogCache {
            version: MODEL_CATALOG_CACHE_VERSION,
            models: vec![CachedModelChoice {
                key: "codex\u{1f}wrong".into(),
                provider: ProviderId::Codex,
                source_name: "Codex".into(),
                connection_id: None,
                agent_id: None,
                agent_name: None,
                model: model_choice("codex", ProviderId::Codex, "gpt-5").model,
            }],
        };

        assert!(parse_model_catalog_cache(&serde_json::to_vec(&invalid).unwrap()).is_none());
    }

    #[test]
    fn stored_selection_bootstraps_the_first_cache_enabled_launch() {
        let mut preferences = NativePreferences {
            selected_model_key: Some("codex\u{1f}gpt-5.6".into()),
            ..NativePreferences::default()
        };
        preferences.model_by_source.insert(
            "codex".into(),
            SourceSelection {
                model_key: "codex\u{1f}gpt-5.6".into(),
                effort: Some("high".into()),
                service_tier: Some("priority".into()),
            },
        );

        let restored = preferences.restored_selected_model_choice().unwrap();

        assert_eq!(restored.provider, ProviderId::Codex);
        assert_eq!(restored.model.id, "gpt-5.6");
        assert_eq!(restored.model.reasoning_efforts, ["high"]);
        assert_eq!(
            restored.model.default_reasoning_effort.as_deref(),
            Some("high")
        );
    }
}
