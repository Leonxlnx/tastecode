use harness_protocol::Model;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

const EFFORT_SUFFIXES: &[&str] = &["minimal", "xhigh", "none", "high", "medium", "low", "max"];
const EFFORT_ORDER: &[&str] = &["none", "minimal", "low", "medium", "high", "xhigh", "max"];

#[derive(Clone, Debug)]
struct Variant {
    id: String,
    effort: Option<String>,
    stem: String,
}

#[derive(Clone, Debug)]
pub(crate) struct BaseEntry {
    default_effort: Option<String>,
    variants: Vec<(String, String)>,
}

pub(crate) type AntigravityModelIndex = HashMap<String, BaseEntry>;

#[derive(Debug)]
struct Group {
    stem: String,
    variants: Vec<Variant>,
}

pub fn parse_antigravity_models(output: &str) -> Vec<Model> {
    let slugs = output
        .lines()
        .map(str::trim)
        .filter(|line| {
            !line.is_empty() && line.contains('-') && !line.chars().any(char::is_whitespace)
        })
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let (models, index) = collapse_antigravity_models(&slugs);
    remember_antigravity_index(index);
    models
}

fn collapse_antigravity_models(slugs: &[String]) -> (Vec<Model>, AntigravityModelIndex) {
    let mut groups = Vec::<Group>::new();
    for slug in slugs {
        let variant = classify(slug);
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

    let default_slug = slugs.first().map(String::as_str);
    let mut models = Vec::with_capacity(groups.len());
    let mut index = HashMap::with_capacity(groups.len());
    for group in groups {
        let efforts = group
            .variants
            .iter()
            .filter_map(|variant| variant.effort.clone())
            .collect::<Vec<_>>();
        let has_effort_choice = efforts.len() > 1;
        let anchor = &group.variants[0];
        let sole_effort = (!has_effort_choice && efforts.len() == 1).then(|| efforts[0].clone());
        let default_effort = has_effort_choice.then(|| anchor.effort.clone()).flatten();
        index.insert(
            anchor.id.clone(),
            BaseEntry {
                default_effort: default_effort.clone(),
                variants: group
                    .variants
                    .iter()
                    .map(|variant| {
                        (
                            variant.effort.clone().unwrap_or_default(),
                            variant.id.clone(),
                        )
                    })
                    .collect(),
            },
        );

        let mut unique_efforts = Vec::new();
        for effort in efforts {
            if !unique_efforts.contains(&effort) {
                unique_efforts.push(effort);
            }
        }
        unique_efforts.sort_by_key(|effort| effort_rank(effort));
        models.push(Model {
            id: anchor.id.clone(),
            display_name: antigravity_display_name(&group.stem),
            description: sole_effort.map(|effort| format!("Fixed at {effort} effort")),
            is_default: group
                .variants
                .iter()
                .any(|variant| Some(variant.id.as_str()) == default_slug),
            reasoning_efforts: if has_effort_choice {
                unique_efforts
            } else {
                Vec::new()
            },
            default_reasoning_effort: default_effort,
            service_tiers: Vec::new(),
            default_service_tier: None,
        });
    }
    (models, index)
}

pub fn antigravity_display_name(stem: &str) -> String {
    let tokens = stem.split('-').collect::<Vec<_>>();
    let mut words = Vec::new();
    let mut index = 0;
    while index < tokens.len() {
        let token = tokens[index];
        let next = tokens.get(index + 1).copied();
        if token.chars().all(|character| character.is_ascii_digit())
            && next.is_some_and(|next| next.chars().all(|character| character.is_ascii_digit()))
        {
            words.push(format!("{token}.{}", next.unwrap()));
            index += 2;
            continue;
        }
        if token.len() > 1
            && token.ends_with(['b', 'B'])
            && token[..token.len() - 1]
                .chars()
                .all(|character| character.is_ascii_digit())
        {
            words.push(token.to_ascii_uppercase());
        } else if token
            .chars()
            .all(|character| character.is_ascii_digit() || character == '.')
        {
            words.push(token.into());
        } else {
            words.push(name_word(token));
        }
        index += 1;
    }
    let display_name = words.join(" ");
    display_name
        .strip_prefix("GPT OSS")
        .map_or(display_name.clone(), |suffix| format!("GPT-OSS{suffix}"))
}

pub(crate) fn resolve_antigravity_model(
    index: Option<&AntigravityModelIndex>,
    model_id: &str,
    effort: Option<&str>,
) -> String {
    let Some(entry) = index.and_then(|index| index.get(model_id)) else {
        return model_id.into();
    };
    let want_effort = effort.or(entry.default_effort.as_deref());
    if let Some(exact) = entry
        .variants
        .iter()
        .find(|(candidate, _)| candidate == want_effort.unwrap_or_default())
        .map(|(_, id)| id)
    {
        return exact.clone();
    }
    let Some(want_effort) = want_effort else {
        return model_id.into();
    };
    let target = effort_rank(want_effort);
    entry
        .variants
        .iter()
        .filter(|(effort, _)| !effort.is_empty())
        .min_by_key(|(effort, _)| effort_rank(effort).abs_diff(target))
        .map(|(_, id)| id.clone())
        .unwrap_or_else(|| model_id.into())
}

pub(crate) fn remember_antigravity_index(index: AntigravityModelIndex) {
    *lock(active_index()) = Some(index);
}

pub(crate) fn get_antigravity_index() -> Option<AntigravityModelIndex> {
    lock(active_index()).clone()
}

fn active_index() -> &'static Mutex<Option<AntigravityModelIndex>> {
    static ACTIVE_INDEX: OnceLock<Mutex<Option<AntigravityModelIndex>>> = OnceLock::new();
    ACTIVE_INDEX.get_or_init(|| Mutex::new(None))
}

fn classify(id: &str) -> Variant {
    let mut rest = id;
    let thinking_suffix = rest.ends_with("-thinking");
    if thinking_suffix {
        rest = &rest[..rest.len() - "-thinking".len()];
    }
    let mut effort = None;
    for suffix in EFFORT_SUFFIXES {
        if let Some(stem) = rest.strip_suffix(&format!("-{suffix}")) {
            effort = Some((*suffix).into());
            rest = stem;
            break;
        }
    }
    Variant {
        id: id.into(),
        effort,
        stem: if thinking_suffix {
            format!("{rest}-thinking")
        } else {
            rest.into()
        },
    }
}

fn effort_rank(effort: &str) -> usize {
    EFFORT_ORDER
        .iter()
        .position(|candidate| *candidate == effort)
        .unwrap_or(EFFORT_ORDER.len())
}

fn name_word(token: &str) -> String {
    match token {
        "gemini" => "Gemini".into(),
        "claude" => "Claude".into(),
        "gpt" => "GPT".into(),
        "oss" => "OSS".into(),
        "flash" => "Flash".into(),
        "pro" => "Pro".into(),
        "sonnet" => "Sonnet".into(),
        "opus" => "Opus".into(),
        "haiku" => "Haiku".into(),
        "thinking" => "Thinking".into(),
        _ => {
            let mut characters = token.chars();
            characters.next().map_or_else(String::new, |first| {
                first.to_uppercase().chain(characters).collect()
            })
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn captured() -> Vec<String> {
        include_str!("../fixtures/models-2026-08-07.txt")
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_owned)
            .collect()
    }

    #[test]
    fn collapses_the_captured_listing_and_spells_names_for_people() {
        let (models, _) = collapse_antigravity_models(&captured());
        assert_eq!(
            models
                .iter()
                .map(|model| model.display_name.as_str())
                .collect::<Vec<_>>(),
            [
                "Gemini 3.6 Flash",
                "Gemini 3.5 Flash",
                "Gemini 3.1 Pro",
                "Claude Sonnet 4.6",
                "Claude Opus 4.6 Thinking",
                "GPT-OSS 120B",
            ]
        );
        assert_eq!(
            antigravity_display_name("claude-sonnet-4-6"),
            "Claude Sonnet 4.6"
        );
        assert_eq!(antigravity_display_name("gpt-oss-120b"), "GPT-OSS 120B");
    }

    #[test]
    fn exposes_only_real_efforts_and_notes_lone_baked_in_effort() {
        let (models, _) = collapse_antigravity_models(&captured());
        let flash = &models[0];
        assert!(flash.is_default);
        assert_eq!(flash.reasoning_efforts, ["low", "medium", "high"]);
        assert_eq!(flash.default_reasoning_effort.as_deref(), Some("high"));
        assert_eq!(models[2].reasoning_efforts, ["low", "high"]);
        assert_eq!(
            models[5].description.as_deref(),
            Some("Fixed at medium effort")
        );
        assert!(models[4].reasoning_efforts.is_empty());
    }

    #[test]
    fn resolves_concrete_slugs_and_uses_cli_order_to_break_ties() {
        let (_, index) = collapse_antigravity_models(&captured());
        assert_eq!(
            resolve_antigravity_model(Some(&index), "gemini-3.6-flash-high", Some("low")),
            "gemini-3.6-flash-low"
        );
        assert_eq!(
            resolve_antigravity_model(Some(&index), "gemini-3.1-pro-high", Some("medium")),
            "gemini-3.1-pro-high"
        );
        assert_eq!(
            resolve_antigravity_model(Some(&index), "claude-sonnet-4-6", Some("high")),
            "claude-sonnet-4-6"
        );
        assert_eq!(
            resolve_antigravity_model(Some(&index), "not-in-the-listing", Some("high")),
            "not-in-the-listing"
        );
    }

    #[test]
    fn parsing_remembers_the_cross_runtime_index() {
        let models = parse_antigravity_models(include_str!("../fixtures/models-2026-08-07.txt"));
        assert_eq!(models.len(), 6);
        assert!(get_antigravity_index().is_some());
    }
}
