use harness_protocol::{Model, ServiceTier};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

const DEFAULT_EFFORT: &str = "default";
const EFFORT_SUFFIXES: &[(&str, &str)] = &[
    ("extra-high", "xhigh"),
    ("minimal", "minimal"),
    ("medium", "medium"),
    ("xhigh", "xhigh"),
    ("none", "none"),
    ("high", "high"),
    ("low", "low"),
    ("max", "max"),
];
const EFFORT_ORDER: &[&str] = &[
    "none",
    "minimal",
    "low",
    DEFAULT_EFFORT,
    "medium",
    "high",
    "xhigh",
    "max",
];
const DISPLAY_EFFORT_WORDS: &[&str] = &[
    "None",
    "Minimal",
    "Low",
    "Medium",
    "High",
    "Extra High",
    "Max",
    "Fast",
];

#[derive(Clone, Debug, PartialEq, Eq)]
struct RawCursorModel {
    id: String,
    display_name: String,
    is_default: bool,
}

#[derive(Clone, Debug)]
struct Variant {
    raw: RawCursorModel,
    effort: Option<String>,
    fast: bool,
    stem: String,
}

#[derive(Clone, Debug)]
pub(crate) struct BaseEntry {
    default_effort: Option<String>,
    variants: HashMap<String, String>,
}

pub(crate) type CursorModelIndex = HashMap<String, BaseEntry>;

#[derive(Debug)]
struct Group {
    stem: String,
    variants: Vec<Variant>,
}

/// Parse and collapse the account-specific table emitted by `cursor-agent models`.
pub fn parse_cursor_models(output: &str) -> Vec<Model> {
    let output = strip_csi(output);
    let mut raw_models = Vec::new();
    let mut reading_models = false;
    for raw_line in output.split(['\n', '\r']) {
        let line = raw_line.trim();
        if line == "Available models" {
            reading_models = true;
            continue;
        }
        if !reading_models || line.is_empty() {
            continue;
        }
        if line.starts_with("Tip:") {
            break;
        }

        let (details, labels) = status_suffix(line);
        let (id, display_name) = details
            .split_once(" - ")
            .map_or((details, details), |(id, name)| (id.trim(), name.trim()));
        if id.is_empty()
            || id.chars().any(char::is_whitespace)
            || matches!(id.to_ascii_lowercase().as_str(), "auto" | "automatic")
        {
            continue;
        }
        raw_models.push(RawCursorModel {
            id: id.into(),
            display_name: if display_name.is_empty() {
                id.into()
            } else {
                display_name.into()
            },
            is_default: labels.contains(&"default"),
        });
    }

    let (models, index) = collapse_cursor_models(raw_models);
    remember_cursor_index(index);
    models
}

fn collapse_cursor_models(raw_models: Vec<RawCursorModel>) -> (Vec<Model>, CursorModelIndex) {
    let mut groups = Vec::<Group>::new();
    for raw in raw_models {
        let variant = classify(raw);
        if let Some(group) = groups
            .iter_mut()
            .find(|candidate| candidate.stem == variant.stem)
        {
            group.variants.push(variant);
        } else {
            groups.push(Group {
                stem: variant.stem.clone(),
                variants: vec![variant],
            });
        }
    }

    let mut models = Vec::with_capacity(groups.len());
    let mut index = CursorModelIndex::with_capacity(groups.len());
    for group in groups {
        let mut efforts = Vec::<String>::new();
        for variant in &group.variants {
            let effort = variant.effort.as_deref().unwrap_or(DEFAULT_EFFORT);
            if !efforts.iter().any(|candidate| candidate == effort) {
                efforts.push(effort.into());
            }
        }
        let has_effort_choice = efforts.len() > 1;
        let unmarked = group.variants.iter().find(|variant| is_unmarked(variant));
        let first = group
            .variants
            .iter()
            .find(|variant| !variant.fast)
            .unwrap_or(&group.variants[0]);
        let anchor = unmarked.unwrap_or(first);
        let has_fast_twin = group.variants.iter().any(|variant| variant.fast);
        let display_name = unmarked.map_or_else(
            || {
                if group.variants.len() > 1 {
                    let stripped = strip_display_effort_word(&first.raw.display_name);
                    if stripped.is_empty() {
                        first.raw.display_name.clone()
                    } else {
                        stripped
                    }
                } else {
                    first.raw.display_name.clone()
                }
            },
            |variant| variant.raw.display_name.clone(),
        );
        let default_effort = has_effort_choice.then(|| {
            anchor
                .effort
                .clone()
                .unwrap_or_else(|| DEFAULT_EFFORT.into())
        });
        let variants = group
            .variants
            .iter()
            .map(|variant| {
                (
                    variant_key(variant.effort.as_deref(), variant.fast),
                    variant.raw.id.clone(),
                )
            })
            .collect();
        index.insert(
            anchor.raw.id.clone(),
            BaseEntry {
                default_effort: default_effort.clone(),
                variants,
            },
        );

        efforts.sort_by_key(|effort| effort_rank(effort));
        models.push(Model {
            id: anchor.raw.id.clone(),
            display_name,
            description: None,
            is_default: group.variants.iter().any(|variant| variant.raw.is_default),
            reasoning_efforts: if has_effort_choice {
                efforts
            } else {
                Vec::new()
            },
            default_reasoning_effort: default_effort,
            service_tiers: if has_fast_twin {
                vec![
                    ServiceTier {
                        id: "standard".into(),
                        name: "Standard".into(),
                        description: "Regular routing".into(),
                    },
                    ServiceTier {
                        id: "fast".into(),
                        name: "Fast".into(),
                        description: "Priority routing".into(),
                    },
                ]
            } else {
                Vec::new()
            },
            default_service_tier: has_fast_twin.then(|| "standard".into()),
        });
    }
    (models, index)
}

pub(crate) fn resolve_cursor_model(
    index: Option<&CursorModelIndex>,
    model_id: &str,
    effort: Option<&str>,
    service_tier: Option<&str>,
) -> String {
    let Some(entry) = index.and_then(|index| index.get(model_id)) else {
        return model_id.into();
    };
    let want_fast = service_tier == Some("fast");
    let want_effort = effort
        .or(entry.default_effort.as_deref())
        .unwrap_or(DEFAULT_EFFORT);
    if let Some(exact) = entry
        .variants
        .get(&variant_key(Some(want_effort), want_fast))
    {
        return exact.clone();
    }
    if let Some(standard) = entry.variants.get(&variant_key(Some(want_effort), false)) {
        return standard.clone();
    }

    let mut available = entry
        .variants
        .keys()
        .filter_map(|key| key.strip_suffix("|false"))
        .collect::<Vec<_>>();
    available.sort_by_key(|effort| effort_rank(effort));
    let target = effort_rank(want_effort);
    let nearest = available
        .into_iter()
        .min_by_key(|candidate| effort_rank(candidate).abs_diff(target));
    nearest
        .and_then(|nearest| {
            entry
                .variants
                .get(&variant_key(Some(nearest), want_fast))
                .or_else(|| entry.variants.get(&variant_key(Some(nearest), false)))
        })
        .cloned()
        .unwrap_or_else(|| model_id.into())
}

pub(crate) fn remember_cursor_index(index: CursorModelIndex) {
    *lock(active_index()) = Some(index);
}

pub(crate) fn get_cursor_index() -> Option<CursorModelIndex> {
    lock(active_index()).clone()
}

fn active_index() -> &'static Mutex<Option<CursorModelIndex>> {
    static ACTIVE_INDEX: OnceLock<Mutex<Option<CursorModelIndex>>> = OnceLock::new();
    ACTIVE_INDEX.get_or_init(|| Mutex::new(None))
}

fn classify(raw: RawCursorModel) -> Variant {
    let mut rest = raw.id.as_str();
    let fast = rest.ends_with("-fast");
    if fast {
        rest = &rest[..rest.len() - "-fast".len()];
    }
    let thinking_suffix = rest.ends_with("-thinking");
    if thinking_suffix {
        rest = &rest[..rest.len() - "-thinking".len()];
    }
    let mut effort = None;
    for (suffix, normalized) in EFFORT_SUFFIXES {
        if let Some(stem) = rest.strip_suffix(&format!("-{suffix}")) {
            effort = Some((*normalized).into());
            rest = stem;
            break;
        }
    }
    let stem = if thinking_suffix {
        format!("{rest}-thinking")
    } else {
        rest.into()
    };
    Variant {
        raw,
        effort,
        fast,
        stem,
    }
}

fn variant_key(effort: Option<&str>, fast: bool) -> String {
    format!("{}|{fast}", effort.unwrap_or(DEFAULT_EFFORT))
}

fn effort_rank(effort: &str) -> usize {
    EFFORT_ORDER
        .iter()
        .position(|candidate| *candidate == effort)
        .unwrap_or(EFFORT_ORDER.len())
}

fn is_unmarked(variant: &Variant) -> bool {
    !variant.fast && display_effort_range(&variant.raw.display_name).is_none()
}

fn strip_display_effort_word(display_name: &str) -> String {
    let Some((start, end)) = display_effort_range(display_name) else {
        return display_name.into();
    };
    let mut stripped = String::with_capacity(display_name.len() - (end - start));
    stripped.push_str(&display_name[..start]);
    stripped.push_str(&display_name[end..]);
    stripped.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn display_effort_range(display_name: &str) -> Option<(usize, usize)> {
    let mut match_range = None;
    for word in DISPLAY_EFFORT_WORDS {
        for (start, _) in display_name.match_indices(word) {
            let end = start + word.len();
            if is_word_boundary(display_name, start, end)
                && match_range.is_none_or(|(best, _)| start < best)
            {
                match_range = Some((start, end));
            }
        }
    }
    match_range
}

fn is_word_boundary(text: &str, start: usize, end: usize) -> bool {
    let before = text[..start].chars().next_back();
    let after = text[end..].chars().next();
    !before.is_some_and(is_word_character) && !after.is_some_and(is_word_character)
}

fn is_word_character(character: char) -> bool {
    character.is_ascii_alphanumeric() || character == '_'
}

fn status_suffix(line: &str) -> (&str, Vec<&str>) {
    let Some(details) = line.strip_suffix(')') else {
        return (line, Vec::new());
    };
    let Some((details, status)) = details.rsplit_once(" (") else {
        return (line, Vec::new());
    };
    let labels = status.split(',').map(str::trim).collect::<Vec<_>>();
    if labels
        .iter()
        .all(|label| matches!(*label, "current" | "default"))
    {
        (details, labels)
    } else {
        (line, Vec::new())
    }
}

fn strip_csi(output: &str) -> String {
    let mut cleaned = String::with_capacity(output.len());
    let mut characters = output.chars().peekable();
    while let Some(character) = characters.next() {
        if character == '\u{1b}' && characters.peek() == Some(&'[') {
            let _ = characters.next();
            for character in characters.by_ref() {
                if ('@'..='~').contains(&character) {
                    break;
                }
            }
        } else {
            cleaned.push(character);
        }
    }
    cleaned
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
fn reset_cursor_index() {
    *lock(active_index()) = None;
}

#[cfg(test)]
mod tests {
    use super::*;

    const CAPTURE: &str = include_str!("../fixtures/cursor-models-2026-08-07.txt");

    #[test]
    fn parses_concrete_models_without_the_automatic_route() {
        let models = parse_cursor_models(concat!(
            "\u{1b}[1mAvailable models\u{1b}[0m\r\n",
            "\r\n",
            "auto - Automatic\r\n",
            "composer-2.5 - Composer 2.5 Fast (current, default)\r\n",
            "claude-4.6-sonnet - Claude 4.6 Sonnet\r\n",
            "bad row - Still accepted (unknown)\r\n",
            "\r\n",
            "Tip: use --model <id> to switch.\r\n"
        ));
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "composer-2.5");
        assert_eq!(models[0].display_name, "Composer 2.5 Fast");
        assert!(models[0].is_default);
        assert_eq!(models[1].id, "claude-4.6-sonnet");
    }

    #[test]
    fn collapses_captured_efforts_fast_tiers_and_thinking_models() {
        let models = parse_cursor_models(CAPTURE);
        let codex = model(&models, "gpt-5.3-codex");
        assert_eq!(codex.display_name, "Codex 5.3");
        assert_eq!(codex.reasoning_efforts, ["low", "default", "high", "xhigh"]);
        assert_eq!(codex.default_reasoning_effort.as_deref(), Some("default"));
        assert_eq!(
            codex
                .service_tiers
                .iter()
                .map(|tier| tier.id.as_str())
                .collect::<Vec<_>>(),
            ["standard", "fast"]
        );
        assert!(
            !models
                .iter()
                .any(|model| model.display_name.contains("Extra High"))
        );
        assert!(!models.iter().any(|model| model.id.ends_with("-fast")));

        assert_eq!(
            model(&models, "claude-4.6-sonnet-medium-thinking").display_name,
            "Sonnet 4.6 1M Thinking"
        );
        let thinking = model(&models, "claude-opus-5-thinking-high");
        assert_eq!(thinking.display_name, "Opus 5 1M Thinking");
        assert_eq!(
            thinking.reasoning_efforts,
            ["low", "medium", "high", "xhigh", "max"]
        );
    }

    #[test]
    fn uses_unmarked_vendor_names_and_normalizes_extra_high() {
        let models = parse_cursor_models(CAPTURE);
        let gpt55 = models
            .iter()
            .find(|model| model.display_name == "GPT-5.5 1M")
            .unwrap();
        assert_eq!(gpt55.id, "gpt-5.5-medium");
        assert_eq!(
            gpt55.reasoning_efforts,
            ["none", "low", "medium", "high", "xhigh"]
        );
        assert_eq!(gpt55.default_reasoning_effort.as_deref(), Some("medium"));
        let index = get_cursor_index().unwrap();
        assert_eq!(
            resolve_cursor_model(Some(&index), "gpt-5.5-medium", Some("xhigh"), Some("fast")),
            "gpt-5.5-extra-high-fast"
        );

        let kimi = model(&models, "kimi-k3-max");
        assert_eq!(kimi.display_name, "Kimi K3");
        assert_eq!(kimi.default_reasoning_effort.as_deref(), Some("max"));
        assert!(kimi.service_tiers.is_empty());
        assert_eq!(
            model(&models, "cursor-grok-4.5-high").display_name,
            "Cursor Grok 4.5"
        );
    }

    #[test]
    fn resolves_every_offered_combination_to_a_captured_id() {
        let models = parse_cursor_models(CAPTURE);
        let listed = CAPTURE
            .lines()
            .filter_map(|line| line.trim().split_once(" - ").map(|(id, _)| id))
            .filter(|id| *id != "auto")
            .collect::<std::collections::HashSet<_>>();
        let index = get_cursor_index().unwrap();
        for model in &models {
            let efforts = if model.reasoning_efforts.is_empty() {
                vec![None]
            } else {
                model
                    .reasoning_efforts
                    .iter()
                    .map(|effort| Some(effort.as_str()))
                    .collect()
            };
            let tiers = if model.service_tiers.is_empty() {
                vec![None]
            } else {
                model
                    .service_tiers
                    .iter()
                    .map(|tier| Some(tier.id.as_str()))
                    .collect()
            };
            for effort in efforts {
                for tier in &tiers {
                    let resolved = resolve_cursor_model(Some(&index), &model.id, effort, *tier);
                    assert!(
                        listed.contains(resolved.as_str()),
                        "{} @ {effort:?}/{tier:?} -> {resolved}",
                        model.id
                    );
                }
            }
        }
    }

    #[test]
    fn degrades_missing_combinations_and_preserves_unknown_ids() {
        reset_cursor_index();
        assert!(get_cursor_index().is_none());
        parse_cursor_models(CAPTURE);
        let index = get_cursor_index().unwrap();
        assert_eq!(
            resolve_cursor_model(Some(&index), "gpt-5.4-medium", Some("low"), Some("fast")),
            "gpt-5.4-low"
        );
        assert_eq!(
            resolve_cursor_model(Some(&index), "not-a-model", Some("high"), Some("fast")),
            "not-a-model"
        );
        assert!(
            model(&parse_cursor_models(CAPTURE), "kimi-k2.7-code")
                .reasoning_efforts
                .is_empty()
        );
    }

    #[test]
    fn accepts_the_current_no_models_response() {
        assert!(parse_cursor_models("No models available for this account.\n").is_empty());
    }

    fn model<'a>(models: &'a [Model], id: &str) -> &'a Model {
        models.iter().find(|model| model.id == id).unwrap()
    }
}
