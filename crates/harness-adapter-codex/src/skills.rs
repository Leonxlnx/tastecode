use harness_protocol::{
    Skill, SkillCapabilities, SkillDependencyError, SkillDiscoveryError, SkillScope, SkillSource,
    SkillsListResult,
};
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

pub const CODEX_SKILL_CAPABILITIES: SkillCapabilities = SkillCapabilities {
    inventory: true,
    configure: true,
    install: true,
};

pub(crate) fn map_skill_list(
    response: &Value,
    cwd: &str,
    configured_mcp_ids: Option<&HashSet<String>>,
) -> Result<SkillsListResult, String> {
    let data = response
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| "skills/list is missing data array".to_owned())?;
    let entry = data
        .iter()
        .find(|candidate| {
            candidate
                .get("cwd")
                .and_then(Value::as_str)
                .is_some_and(|candidate| same_path(candidate, cwd))
        })
        .or_else(|| (data.len() == 1).then(|| &data[0]));
    let Some(entry) = entry else {
        return Ok(SkillsListResult {
            capabilities: CODEX_SKILL_CAPABILITIES,
            skills: Vec::new(),
            errors: Vec::new(),
        });
    };
    let object = entry
        .as_object()
        .ok_or_else(|| "skills/list cwd entry must be an object".to_owned())?;
    let skills = required_array(object, "skills")?
        .iter()
        .map(|skill| map_skill(skill, configured_mcp_ids))
        .collect::<Result<Vec<_>, _>>()?;
    let errors = required_array(object, "errors")?
        .iter()
        .map(map_error)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(SkillsListResult {
        capabilities: CODEX_SKILL_CAPABILITIES,
        skills,
        errors,
    })
}

fn map_skill(value: &Value, configured_mcp_ids: Option<&HashSet<String>>) -> Result<Skill, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "skill must be an object".to_owned())?;
    let path = required_string(object, "path")?;
    let scope = match object.get("scope").and_then(Value::as_str) {
        Some("repo") => SkillScope::Project,
        Some("user") => SkillScope::User,
        Some("system") => SkillScope::System,
        Some("admin") => SkillScope::Admin,
        Some(other) => return Err(format!("skill {path} has unknown scope {other}")),
        None => return Err(format!("skill {path} is missing scope")),
    };
    let dependency_errors = configured_mcp_ids
        .map(|configured| missing_mcp_dependencies(object, configured))
        .unwrap_or_default();
    Ok(Skill {
        id: path.clone(),
        name: required_string(object, "name")?,
        display_name: object
            .get("interface")
            .and_then(Value::as_object)
            .and_then(|interface| optional_string(interface, "displayName")),
        description: required_string(object, "description")?,
        source: SkillSource::Folder {
            path: Path::new(&path)
                .parent()
                .unwrap_or_else(|| Path::new(""))
                .to_string_lossy()
                .into_owned(),
        },
        scope,
        enabled: object
            .get("enabled")
            .and_then(Value::as_bool)
            .ok_or_else(|| format!("skill {path} is missing enabled"))?,
        dependency_errors,
    })
}

fn missing_mcp_dependencies(
    skill: &Map<String, Value>,
    configured: &HashSet<String>,
) -> Vec<SkillDependencyError> {
    skill
        .get("dependencies")
        .and_then(Value::as_object)
        .and_then(|dependencies| dependencies.get("tools"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|dependency| {
            let dependency = dependency.as_object()?;
            if dependency.get("type").and_then(Value::as_str) != Some("mcp") {
                return None;
            }
            let value = dependency.get("value")?.as_str()?;
            (!configured.contains(value)).then(|| SkillDependencyError {
                dependency: value.into(),
                message: "Required MCP server is not configured".into(),
            })
        })
        .collect()
}

fn map_error(value: &Value) -> Result<SkillDiscoveryError, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "skill discovery error must be an object".to_owned())?;
    Ok(SkillDiscoveryError {
        path: required_string(object, "path")?,
        message: required_string(object, "message")?,
    })
}

fn same_path(left: &str, right: &str) -> bool {
    let left = absolute_path(left);
    let right = absolute_path(right);
    #[cfg(target_os = "windows")]
    return left
        .to_string_lossy()
        .eq_ignore_ascii_case(&right.to_string_lossy());
    #[cfg(not(target_os = "windows"))]
    return left == right;
}

fn absolute_path(path: &str) -> PathBuf {
    let path = PathBuf::from(path);
    let absolute = if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(&path))
            .unwrap_or(path)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                normalized.push(component.as_os_str());
            }
        }
    }
    normalized
}

fn required_array<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a [Value], String> {
    object
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .ok_or_else(|| format!("missing {key} array"))
}

fn required_string(object: &Map<String, Value>, key: &str) -> Result<String, String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| format!("missing {key} string"))
}

fn optional_string(object: &Map<String, Value>, key: &str) -> Option<String> {
    object.get(key).and_then(Value::as_str).map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn maps_captured_skills_and_missing_mcp_dependencies() {
        let root = std::env::current_dir().unwrap().join("repo");
        let skill_path = root.join(".agents/skills/docs/SKILL.md");
        let broken_path = root.join("broken/SKILL.md");
        let response = json!({
            "data": [{
                "cwd": root,
                "skills": [{
                    "name": "docs",
                    "description": "Read product documentation",
                    "interface": { "displayName": "Docs" },
                    "dependencies": {
                        "tools": [{ "type": "mcp", "value": "officialDocs" }]
                    },
                    "path": skill_path,
                    "scope": "repo",
                    "enabled": true
                }],
                "errors": [{ "path": broken_path, "message": "invalid frontmatter" }]
            }]
        });
        let inventory =
            map_skill_list(&response, &root.to_string_lossy(), Some(&HashSet::new())).unwrap();

        assert_eq!(inventory.skills[0].name, "docs");
        assert_eq!(inventory.skills[0].display_name.as_deref(), Some("Docs"));
        assert_eq!(inventory.skills[0].scope, SkillScope::Project);
        assert_eq!(
            inventory.skills[0].dependency_errors,
            [SkillDependencyError {
                dependency: "officialDocs".into(),
                message: "Required MCP server is not configured".into(),
            }]
        );
        assert_eq!(inventory.errors[0].message, "invalid frontmatter");
    }

    #[test]
    fn trusts_a_single_cwd_entry_and_rejects_unknown_scopes() {
        let response = json!({
            "data": [{
                "cwd": "/provider-normalized-path",
                "skills": [{
                    "name": "docs",
                    "description": "Docs",
                    "path": "/skills/docs/SKILL.md",
                    "scope": "future",
                    "enabled": true
                }],
                "errors": []
            }]
        });
        assert!(map_skill_list(&response, "/requested-path", None).is_err());
    }
}
