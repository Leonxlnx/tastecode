use crate::{DesignError, Result};
use serde_json::{Map, Value};
use std::fs;
use std::path::Path;

pub(crate) fn parse_json_text(text: &str) -> Result<Value> {
    let text = strip_json_fence(text);
    serde_json::from_str(text).map_err(|error| DesignError::new(error.to_string()))
}

fn strip_json_fence(text: &str) -> &str {
    let trimmed = text.trim();
    if !trimmed.starts_with("```") || !trimmed.ends_with("```") {
        return trimmed;
    }
    let inner = &trimmed[3..trimmed.len() - 3];
    let inner = inner.trim_start();
    if inner
        .get(..4)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("json"))
    {
        let after_language = &inner[4..];
        if after_language
            .chars()
            .next()
            .is_some_and(char::is_whitespace)
        {
            return after_language.trim();
        }
    }
    inner.trim()
}

pub(crate) fn object<'a>(value: &'a Value, field: &str) -> Result<&'a Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| DesignError::new(format!("{field} must be an object")))
}

pub(crate) fn string(value: Option<&Value>, field: &str) -> Result<String> {
    let value = value
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| DesignError::new(format!("{field} must be a non-empty string")))?;
    Ok(value.to_owned())
}

pub(crate) fn any_string(value: Option<&Value>, field: &str) -> Result<String> {
    value
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| DesignError::new(format!("{field} must be a string")))
}

pub(crate) fn array<'a>(value: Option<&'a Value>, field: &str) -> Result<&'a [Value]> {
    value
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .ok_or_else(|| DesignError::new(format!("{field} must be an array")))
}

pub(crate) fn non_empty_array<'a>(value: Option<&'a Value>, field: &str) -> Result<&'a [Value]> {
    let values = value
        .and_then(Value::as_array)
        .filter(|values| !values.is_empty())
        .ok_or_else(|| DesignError::new(format!("{field} must be a non-empty array")))?;
    Ok(values)
}

pub(crate) fn strings(value: Option<&Value>, field: &str) -> Result<Vec<String>> {
    let values = value
        .and_then(Value::as_array)
        .ok_or_else(|| DesignError::new(format!("{field} must be a string array")))?;
    values
        .iter()
        .map(|value| {
            value
                .as_str()
                .filter(|value| !value.trim().is_empty())
                .map(str::to_owned)
                .ok_or_else(|| DesignError::new(format!("{field} must be a string array")))
        })
        .collect()
}

pub(crate) fn require_version_one(value: Option<&Value>, field: &str) -> Result<()> {
    if value.and_then(Value::as_u64) != Some(1) {
        return Err(DesignError::new(format!("{field} version must be 1")));
    }
    Ok(())
}

pub(crate) fn write_json(path: &Path, value: &impl serde::Serialize) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| DesignError::new("artifact path has no parent"))?;
    fs::create_dir_all(parent).map_err(|error| DesignError::new(error.to_string()))?;
    let mut output =
        serde_json::to_string_pretty(value).map_err(|error| DesignError::new(error.to_string()))?;
    output.push('\n');
    fs::write(path, output).map_err(|error| DesignError::new(error.to_string()))
}

pub(crate) fn read_json(path: &Path) -> Result<Value> {
    let text = fs::read_to_string(path).map_err(|error| DesignError::new(error.to_string()))?;
    serde_json::from_str(&text).map_err(|error| DesignError::new(error.to_string()))
}
