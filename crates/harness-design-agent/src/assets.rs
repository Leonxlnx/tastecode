use crate::common::{object, read_json, require_version_one, string, strings, write_json};
use crate::{DesignError, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AssetKind {
    Image,
    Illustration,
    Video,
    Icon,
    Font,
    Component,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AssetStatus {
    Existing,
    Needed,
    Ready,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AssetSourceKind {
    Project,
    User,
    OriginKit,
    Generated,
    External,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssetSource {
    pub kind: AssetSourceKind,
    pub reference: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DesignAsset {
    pub id: String,
    pub kind: AssetKind,
    pub status: AssetStatus,
    pub purpose: String,
    pub requirements: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<AssetSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssetManifest {
    pub version: u8,
    pub assets: Vec<DesignAsset>,
}

pub fn parse_asset_manifest(value: &Value) -> Result<AssetManifest> {
    let manifest = object(value, "asset manifest")?;
    require_version_one(manifest.get("version"), "asset manifest")?;
    let raw_assets = manifest
        .get("assets")
        .and_then(Value::as_array)
        .ok_or_else(|| DesignError::new("assets must be an array"))?;
    let assets = raw_assets
        .iter()
        .enumerate()
        .map(|(index, value)| parse_asset(value, index))
        .collect::<Result<Vec<_>>>()?;
    let mut ids = HashSet::new();
    if !assets.iter().all(|asset| ids.insert(&asset.id)) {
        return Err(DesignError::new("asset ids must be unique"));
    }
    Ok(AssetManifest { version: 1, assets })
}

pub fn read_asset_manifest(workspace_path: &Path) -> Result<AssetManifest> {
    parse_asset_manifest(&read_json(&asset_path(workspace_path))?)
}

pub fn write_asset_manifest(workspace_path: &Path, value: &Value) -> Result<AssetManifest> {
    let manifest = parse_asset_manifest(value)?;
    write_json(&asset_path(workspace_path), &manifest)?;
    Ok(manifest)
}

fn parse_asset(value: &Value, index: usize) -> Result<DesignAsset> {
    let field = format!("assets[{index}]");
    let asset = object(value, &field)?;
    let status = parse_status(asset.get("status"), &format!("{field}.status"))?;
    let source = match asset.get("source") {
        Some(value) => Some(parse_source(value, &format!("{field}.source"))?),
        None => None,
    };
    let destination = match asset.get("destination") {
        Some(value) => Some(string(Some(value), &format!("{field}.destination"))?),
        None => None,
    };
    if destination.as_deref().is_some_and(leaves_workspace) {
        return Err(DesignError::new(format!(
            "{field}.destination must stay inside the workspace"
        )));
    }
    if status == AssetStatus::Ready && (source.is_none() || destination.is_none()) {
        return Err(DesignError::new(format!(
            "{field} ready assets require source and destination"
        )));
    }
    if status == AssetStatus::Existing && source.is_none() {
        return Err(DesignError::new(format!(
            "{field} existing assets require a source"
        )));
    }
    Ok(DesignAsset {
        id: string(asset.get("id"), &format!("{field}.id"))?,
        kind: parse_kind(asset.get("kind"), &format!("{field}.kind"))?,
        status,
        purpose: string(asset.get("purpose"), &format!("{field}.purpose"))?,
        requirements: strings(asset.get("requirements"), &format!("{field}.requirements"))?,
        source,
        destination,
    })
}

fn parse_source(value: &Value, field: &str) -> Result<AssetSource> {
    let source = object(value, field)?;
    Ok(AssetSource {
        kind: parse_source_kind(source.get("kind"), &format!("{field}.kind"))?,
        reference: string(source.get("reference"), &format!("{field}.reference"))?,
        license: source
            .get("license")
            .map(|value| string(Some(value), &format!("{field}.license")))
            .transpose()?,
    })
}

fn parse_kind(value: Option<&Value>, field: &str) -> Result<AssetKind> {
    match value.and_then(Value::as_str) {
        Some("image") => Ok(AssetKind::Image),
        Some("illustration") => Ok(AssetKind::Illustration),
        Some("video") => Ok(AssetKind::Video),
        Some("icon") => Ok(AssetKind::Icon),
        Some("font") => Ok(AssetKind::Font),
        Some("component") => Ok(AssetKind::Component),
        _ => Err(DesignError::new(format!(
            "{field} must be one of image, illustration, video, icon, font, component"
        ))),
    }
}

fn parse_status(value: Option<&Value>, field: &str) -> Result<AssetStatus> {
    match value.and_then(Value::as_str) {
        Some("existing") => Ok(AssetStatus::Existing),
        Some("needed") => Ok(AssetStatus::Needed),
        Some("ready") => Ok(AssetStatus::Ready),
        _ => Err(DesignError::new(format!(
            "{field} must be one of existing, needed, ready"
        ))),
    }
}

fn parse_source_kind(value: Option<&Value>, field: &str) -> Result<AssetSourceKind> {
    match value.and_then(Value::as_str) {
        Some("project") => Ok(AssetSourceKind::Project),
        Some("user") => Ok(AssetSourceKind::User),
        Some("origin-kit") => Ok(AssetSourceKind::OriginKit),
        Some("generated") => Ok(AssetSourceKind::Generated),
        Some("external") => Ok(AssetSourceKind::External),
        _ => Err(DesignError::new(format!(
            "{field} must be one of project, user, origin-kit, generated, external"
        ))),
    }
}

fn leaves_workspace(path: &str) -> bool {
    let bytes = path.as_bytes();
    let drive_absolute = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    drive_absolute
        || path.starts_with(['/', '\\'])
        || path.split(['/', '\\']).any(|part| part == "..")
}

fn asset_path(workspace_path: &Path) -> PathBuf {
    workspace_path.join(".taste").join("assets.json")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn writes_unresolved_and_ready_assets() {
        let workspace = tempfile::tempdir().unwrap();
        let value = json!({
            "version": 1,
            "assets": [
                {"id": "hero", "kind": "image", "status": "needed", "purpose": "Lead.", "requirements": []},
                {"id": "card", "kind": "component", "status": "ready", "purpose": "Sell.", "requirements": [], "source": {"kind": "origin-kit", "reference": "card"}, "destination": "src/Card.tsx"}
            ]
        });
        let parsed = write_asset_manifest(workspace.path(), &value).unwrap();
        assert_eq!(read_asset_manifest(workspace.path()).unwrap(), parsed);
    }

    #[test]
    fn rejects_missing_provenance_and_workspace_escape() {
        let missing = json!({"version": 1, "assets": [{"id": "hero", "kind": "image", "status": "ready", "purpose": "Lead.", "requirements": []}]});
        assert!(
            parse_asset_manifest(&missing)
                .unwrap_err()
                .to_string()
                .contains("ready assets require source and destination")
        );
        let escape = json!({"version": 1, "assets": [{"id": "hero", "kind": "image", "status": "needed", "purpose": "Lead.", "requirements": [], "destination": "../outside.png"}]});
        assert!(
            parse_asset_manifest(&escape)
                .unwrap_err()
                .to_string()
                .contains("must stay inside the workspace")
        );
    }
}
