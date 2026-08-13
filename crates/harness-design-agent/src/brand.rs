use crate::common::{
    non_empty_array, object, read_json, require_version_one, string, strings, write_json,
};
use crate::{DesignError, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrandSystem {
    pub version: u8,
    pub creative_direction: CreativeDirection,
    pub color_palette: Vec<BrandColor>,
    pub typefaces: Vec<BrandTypeface>,
    pub interface_direction: String,
    pub image_direction: ImageDirection,
    pub motion_direction: MotionDirection,
    pub voice: VoiceDirection,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreativeDirection {
    pub summary: String,
    pub keywords: Vec<String>,
    pub avoid: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrandColor {
    pub name: String,
    pub value: String,
    pub usage: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrandTypeface {
    pub family: String,
    pub source: String,
    pub roles: Vec<String>,
    pub weights: Vec<u16>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageDirection {
    pub summary: String,
    pub subjects: Vec<String>,
    pub treatment: String,
    pub avoid: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MotionDirection {
    pub summary: String,
    pub principles: Vec<String>,
    pub avoid: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct VoiceDirection {
    pub summary: String,
    pub avoid: Vec<String>,
}

pub fn parse_brand_system(value: &Value) -> Result<BrandSystem> {
    let brand = object(value, "brand system")?;
    require_version_one(brand.get("version"), "brand system")?;
    let creative = object(
        brand.get("creativeDirection").unwrap_or(&Value::Null),
        "creativeDirection",
    )?;
    let image = object(
        brand.get("imageDirection").unwrap_or(&Value::Null),
        "imageDirection",
    )?;
    let motion = object(
        brand.get("motionDirection").unwrap_or(&Value::Null),
        "motionDirection",
    )?;
    let voice = object(brand.get("voice").unwrap_or(&Value::Null), "voice")?;

    let color_palette = non_empty_array(brand.get("colorPalette"), "colorPalette")?
        .iter()
        .enumerate()
        .map(|(index, value)| {
            let field = format!("colorPalette[{index}]");
            let color = object(value, &field)?;
            Ok(BrandColor {
                name: string(color.get("name"), &format!("{field}.name"))?,
                value: string(color.get("value"), &format!("{field}.value"))?,
                usage: string(color.get("usage"), &format!("{field}.usage"))?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let typefaces = non_empty_array(brand.get("typefaces"), "typefaces")?
        .iter()
        .enumerate()
        .map(|(index, value)| {
            let field = format!("typefaces[{index}]");
            let typeface = object(value, &field)?;
            Ok(BrandTypeface {
                family: string(typeface.get("family"), &format!("{field}.family"))?,
                source: string(typeface.get("source"), &format!("{field}.source"))?,
                roles: strings(typeface.get("roles"), &format!("{field}.roles"))?,
                weights: font_weights(typeface.get("weights"), &format!("{field}.weights"))?,
            })
        })
        .collect::<Result<Vec<_>>>()?;

    Ok(BrandSystem {
        version: 1,
        creative_direction: CreativeDirection {
            summary: string(creative.get("summary"), "creativeDirection.summary")?,
            keywords: strings(creative.get("keywords"), "creativeDirection.keywords")?,
            avoid: strings(creative.get("avoid"), "creativeDirection.avoid")?,
        },
        color_palette,
        typefaces,
        interface_direction: string(brand.get("interfaceDirection"), "interfaceDirection")?,
        image_direction: ImageDirection {
            summary: string(image.get("summary"), "imageDirection.summary")?,
            subjects: strings(image.get("subjects"), "imageDirection.subjects")?,
            treatment: string(image.get("treatment"), "imageDirection.treatment")?,
            avoid: strings(image.get("avoid"), "imageDirection.avoid")?,
        },
        motion_direction: MotionDirection {
            summary: string(motion.get("summary"), "motionDirection.summary")?,
            principles: strings(motion.get("principles"), "motionDirection.principles")?,
            avoid: strings(motion.get("avoid"), "motionDirection.avoid")?,
        },
        voice: VoiceDirection {
            summary: string(voice.get("summary"), "voice.summary")?,
            avoid: strings(voice.get("avoid"), "voice.avoid")?,
        },
    })
}

pub fn read_brand_system(workspace_path: &Path) -> Result<BrandSystem> {
    parse_brand_system(&read_json(&brand_path(workspace_path))?)
}

pub fn write_brand_system(workspace_path: &Path, value: &Value) -> Result<BrandSystem> {
    let brand = parse_brand_system(value)?;
    write_json(&brand_path(workspace_path), &brand)?;
    Ok(brand)
}

fn font_weights(value: Option<&Value>, field: &str) -> Result<Vec<u16>> {
    let values = value
        .and_then(Value::as_array)
        .filter(|values| !values.is_empty())
        .ok_or_else(|| {
            DesignError::new(format!(
                "{field} must contain font weights between 1 and 1000"
            ))
        })?;
    values
        .iter()
        .map(|value| {
            let parsed = match value {
                Value::Number(number) => number.as_u64(),
                Value::String(text)
                    if !text.is_empty()
                        && text.len() <= 4
                        && text.bytes().all(|byte| byte.is_ascii_digit()) =>
                {
                    text.parse().ok()
                }
                _ => None,
            };
            parsed
                .filter(|value| (1..=1000).contains(value))
                .map(|value| value as u16)
                .ok_or_else(|| {
                    DesignError::new(format!(
                        "{field} must contain font weights between 1 and 1000"
                    ))
                })
        })
        .collect()
}

fn brand_path(workspace_path: &Path) -> PathBuf {
    workspace_path.join(".taste").join("brand.json")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn brand() -> Value {
        json!({
            "version": 1,
            "creativeDirection": {"summary": "Warm precision.", "keywords": ["warm"], "avoid": []},
            "colorPalette": [{"name": "Ink", "value": "#171512", "usage": "Text"}],
            "typefaces": [{"family": "Geist", "source": "Project", "roles": ["UI"], "weights": [500]}],
            "interfaceDirection": "Editorial commerce.",
            "imageDirection": {"summary": "Product studies.", "subjects": [], "treatment": "Warm.", "avoid": []},
            "motionDirection": {"summary": "Tactile.", "principles": [], "avoid": []},
            "voice": {"summary": "Direct.", "avoid": []}
        })
    }

    #[test]
    fn round_trips_and_normalizes_weights() {
        let workspace = tempfile::tempdir().unwrap();
        let mut value = brand();
        value["typefaces"][0]["weights"] = json!(["400", "700"]);
        let brand = write_brand_system(workspace.path(), &value).unwrap();
        assert_eq!(brand.typefaces[0].weights, [400, 700]);
        assert_eq!(read_brand_system(workspace.path()).unwrap(), brand);
    }

    #[test]
    fn rejects_empty_typefaces() {
        let mut value = brand();
        value["typefaces"] = json!([]);
        assert_eq!(
            parse_brand_system(&value).unwrap_err().to_string(),
            "typefaces must be a non-empty array"
        );
    }
}
