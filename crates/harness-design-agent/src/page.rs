use crate::common::{
    array, non_empty_array, object, read_json, require_version_one, string, strings, write_json,
};
use crate::{DesignError, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PageLink {
    pub label: String,
    pub target: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PageBlueprint {
    pub version: u8,
    pub page: PageMetadata,
    pub navigation: Vec<PageLink>,
    pub sections: Vec<PageSection>,
    pub responsive: Vec<String>,
    pub interactions: Vec<String>,
    #[serde(rename = "acceptanceCriteria")]
    pub acceptance_criteria: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PageMetadata {
    pub title: String,
    pub route: String,
    pub description: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PageSection {
    pub id: String,
    pub purpose: String,
    pub copy: PageCopy,
    pub layout: String,
    #[serde(rename = "componentNeeds")]
    pub component_needs: Vec<String>,
    #[serde(rename = "assetNeeds")]
    pub asset_needs: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageCopy {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eyebrow: Option<String>,
    pub heading: String,
    pub body: Vec<String>,
    pub calls_to_action: Vec<PageLink>,
}

pub fn parse_page_blueprint(value: &Value) -> Result<PageBlueprint> {
    let blueprint = object(value, "page blueprint")?;
    require_version_one(blueprint.get("version"), "page blueprint")?;
    let page = object(blueprint.get("page").unwrap_or(&Value::Null), "page")?;
    let route = string(page.get("route"), "page.route")?;
    if !route.starts_with('/') {
        return Err(DesignError::new("page.route must start with /"));
    }

    let sections = non_empty_array(blueprint.get("sections"), "sections")?
        .iter()
        .enumerate()
        .map(|(index, value)| parse_section(value, index))
        .collect::<Result<Vec<_>>>()?;
    let mut ids = HashSet::new();
    if !sections.iter().all(|section| ids.insert(&section.id)) {
        return Err(DesignError::new(
            "page blueprint section ids must be unique",
        ));
    }

    Ok(PageBlueprint {
        version: 1,
        page: PageMetadata {
            title: string(page.get("title"), "page.title")?,
            route,
            description: string(page.get("description"), "page.description")?,
        },
        navigation: links(blueprint.get("navigation"), "navigation")?,
        sections,
        responsive: strings(blueprint.get("responsive"), "responsive")?,
        interactions: strings(blueprint.get("interactions"), "interactions")?,
        acceptance_criteria: strings(blueprint.get("acceptanceCriteria"), "acceptanceCriteria")?,
    })
}

pub fn read_page_blueprint(workspace_path: &Path) -> Result<PageBlueprint> {
    parse_page_blueprint(&read_json(&page_path(workspace_path))?)
}

pub fn write_page_blueprint(workspace_path: &Path, value: &Value) -> Result<PageBlueprint> {
    let page = parse_page_blueprint(value)?;
    write_json(&page_path(workspace_path), &page)?;
    Ok(page)
}

fn parse_section(value: &Value, index: usize) -> Result<PageSection> {
    let field = format!("sections[{index}]");
    let section = object(value, &field)?;
    let copy_field = format!("{field}.copy");
    let copy = object(section.get("copy").unwrap_or(&Value::Null), &copy_field)?;
    let eyebrow = match copy.get("eyebrow") {
        Some(value) => Some(string(Some(value), &format!("{copy_field}.eyebrow"))?),
        None => None,
    };
    Ok(PageSection {
        id: string(section.get("id"), &format!("{field}.id"))?,
        purpose: string(section.get("purpose"), &format!("{field}.purpose"))?,
        copy: PageCopy {
            eyebrow,
            heading: string(copy.get("heading"), &format!("{copy_field}.heading"))?,
            body: strings(copy.get("body"), &format!("{copy_field}.body"))?,
            calls_to_action: links(
                copy.get("callsToAction"),
                &format!("{copy_field}.callsToAction"),
            )?,
        },
        layout: string(section.get("layout"), &format!("{field}.layout"))?,
        component_needs: strings(
            section.get("componentNeeds"),
            &format!("{field}.componentNeeds"),
        )?,
        asset_needs: strings(section.get("assetNeeds"), &format!("{field}.assetNeeds"))?,
    })
}

fn links(value: Option<&Value>, field: &str) -> Result<Vec<PageLink>> {
    array(value, field)?
        .iter()
        .enumerate()
        .map(|(index, value)| {
            let item_field = format!("{field}[{index}]");
            let link = object(value, &item_field)?;
            Ok(PageLink {
                label: string(link.get("label"), &format!("{item_field}.label"))?,
                target: string(link.get("target"), &format!("{item_field}.target"))?,
            })
        })
        .collect()
}

fn page_path(workspace_path: &Path) -> PathBuf {
    workspace_path.join(".taste").join("page.json")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn page() -> Value {
        json!({
            "version": 1,
            "page": {"title": "Northstar", "route": "/", "description": "Fresh coffee."},
            "navigation": [{"label": "Shop", "target": "#shop"}],
            "sections": [{
                "id": "hero",
                "purpose": "Lead the offer.",
                "copy": {"heading": "Fresh.", "body": [], "callsToAction": []},
                "layout": "Editorial split.",
                "componentNeeds": [],
                "assetNeeds": []
            }],
            "responsive": [],
            "interactions": [],
            "acceptanceCriteria": []
        })
    }

    #[test]
    fn writes_a_valid_blueprint() {
        let workspace = tempfile::tempdir().unwrap();
        let page = write_page_blueprint(workspace.path(), &page()).unwrap();
        assert_eq!(read_page_blueprint(workspace.path()).unwrap(), page);
    }

    #[test]
    fn rejects_duplicate_ids_and_non_local_routes() {
        let mut duplicate = page();
        duplicate["sections"] = json!([duplicate["sections"][0], duplicate["sections"][0]]);
        assert!(
            parse_page_blueprint(&duplicate)
                .unwrap_err()
                .to_string()
                .contains("section ids must be unique")
        );
        let mut remote = page();
        remote["page"]["route"] = json!("landing");
        assert_eq!(
            parse_page_blueprint(&remote).unwrap_err().to_string(),
            "page.route must start with /"
        );
    }
}
