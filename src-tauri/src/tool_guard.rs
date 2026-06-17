use crate::domain::types::AppError;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolDestinationClass {
    InternalTdx,
    TrustedUserConnector,
    ExternalUntrusted,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ToolGuardAnalysis {
    pub request_id: String,
    pub canonical_request_hash: String,
    #[serde(default)]
    pub findings: Vec<ToolGuardFinding>,
    #[serde(default)]
    pub advisories: Vec<ToolGuardAdvisory>,
    pub redaction_plan: ToolGuardRedactionPlan,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ToolGuardFinding {
    pub finding_id: String,
    pub pii_type: String,
    pub confidence_bucket: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub score: Option<f64>,
    #[serde(default)]
    pub source_roles: Vec<String>,
    pub locator: ToolGuardLocator,
    pub range: ToolGuardTextRange,
    pub replacement: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ToolGuardAdvisory {
    pub advisory_id: String,
    pub advisory_type: String,
    pub confidence_bucket: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub score: Option<f64>,
    #[serde(default)]
    pub source_roles: Vec<String>,
    #[serde(default)]
    pub categories: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ToolGuardRedactionPlan {
    #[serde(default)]
    pub operations: Vec<ToolGuardRedactionOperation>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ToolGuardRedactionOperation {
    pub finding_id: String,
    pub locator: ToolGuardLocator,
    pub range: ToolGuardTextRange,
    pub replacement: String,
}

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct ToolGuardLocator {
    pub target: ToolGuardLocatorTarget,
    #[serde(default)]
    pub path: Vec<ToolGuardPathSegment>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolGuardLocatorTarget {
    Key,
    Value,
}

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToolGuardPathSegment {
    ObjectKeySha256 { sha256: String },
    ArrayIndex { index: usize },
}

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct ToolGuardTextRange {
    pub start: usize,
    pub end: usize,
    pub unit: ToolGuardTextRangeUnit,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolGuardTextRangeUnit {
    UnicodeCodepoint,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolGuardReplacementMapping {
    pub replacement: String,
    pub original: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolGuardRedactionResult {
    pub value: Value,
    pub mappings: Vec<ToolGuardReplacementMapping>,
}

pub fn apply_redaction_plan(
    value: &Value,
    plan: &ToolGuardRedactionPlan,
    selected_findings: Option<&HashSet<String>>,
) -> Result<ToolGuardRedactionResult, AppError> {
    let mut value = value.clone();
    let mut mappings = Vec::new();
    let mut grouped: HashMap<ToolGuardLocator, Vec<&ToolGuardRedactionOperation>> = HashMap::new();
    for operation in &plan.operations {
        if selected_findings.is_some_and(|selected| !selected.contains(&operation.finding_id)) {
            continue;
        }
        grouped
            .entry(operation.locator.clone())
            .or_default()
            .push(operation);
    }

    for (locator, operations) in grouped {
        match locator.target {
            ToolGuardLocatorTarget::Value => {
                apply_value_redactions(&mut value, &locator.path, &operations, &mut mappings)?;
            }
            ToolGuardLocatorTarget::Key => {
                apply_key_redactions(&mut value, &locator.path, &operations, &mut mappings)?;
            }
        }
    }

    Ok(ToolGuardRedactionResult { value, mappings })
}

pub fn text_for_locator(value: &Value, locator: &ToolGuardLocator) -> Option<String> {
    match locator.target {
        ToolGuardLocatorTarget::Value => value_at_path(value, &locator.path).and_then(|target| {
            target
                .as_str()
                .map(str::to_string)
                .or_else(|| target.is_number().then(|| target.to_string()))
                .or_else(|| target.is_boolean().then(|| target.to_string()))
        }),
        ToolGuardLocatorTarget::Key => key_at_path(value, &locator.path),
    }
}

pub fn text_for_finding(value: &Value, finding: &ToolGuardFinding) -> Option<String> {
    text_for_locator(value, &finding.locator).and_then(|text| {
        text_slice_by_codepoints(&text, finding.range.start, finding.range.end).map(str::to_string)
    })
}

pub fn rehydrate_text(text: &str, mappings: &[ToolGuardReplacementMapping]) -> String {
    let mut text = text.to_string();
    let mut mappings = mappings.iter().collect::<Vec<_>>();
    mappings.sort_by(|left, right| right.replacement.len().cmp(&left.replacement.len()));
    for mapping in mappings {
        text = text.replace(&mapping.replacement, &mapping.original);
    }
    text
}

pub fn object_key_sha256(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn apply_value_redactions(
    value: &mut Value,
    path: &[ToolGuardPathSegment],
    operations: &[&ToolGuardRedactionOperation],
    mappings: &mut Vec<ToolGuardReplacementMapping>,
) -> Result<(), AppError> {
    let target = value_at_path_mut(value, path)?;
    let original = target_text(target)?;
    let redacted = apply_text_redactions(&original, operations, mappings)?;
    *target = Value::String(redacted);
    Ok(())
}

fn apply_key_redactions(
    value: &mut Value,
    path: &[ToolGuardPathSegment],
    operations: &[&ToolGuardRedactionOperation],
    mappings: &mut Vec<ToolGuardReplacementMapping>,
) -> Result<(), AppError> {
    let (object, key) = object_and_key_at_path_mut(value, path)?;
    let redacted_key = apply_text_redactions(&key, operations, mappings)?;
    if redacted_key == key {
        return Ok(());
    }
    if object.contains_key(&redacted_key) {
        return Err(redaction_error("tool_guard_key_collision"));
    }
    let item = object
        .remove(&key)
        .ok_or_else(|| redaction_error("tool_guard_path_missing"))?;
    object.insert(redacted_key, item);
    Ok(())
}

fn apply_text_redactions(
    original: &str,
    operations: &[&ToolGuardRedactionOperation],
    mappings: &mut Vec<ToolGuardReplacementMapping>,
) -> Result<String, AppError> {
    let mut text = original.to_string();
    let mut operations = operations.to_vec();
    operations.sort_by(|left, right| {
        right
            .range
            .start
            .cmp(&left.range.start)
            .then_with(|| right.range.end.cmp(&left.range.end))
    });
    for operation in operations {
        if operation.range.unit != ToolGuardTextRangeUnit::UnicodeCodepoint {
            return Err(redaction_error("tool_guard_range_unit_unsupported"));
        }
        if operation.range.start > operation.range.end {
            return Err(redaction_error("tool_guard_range_invalid"));
        }
        let Some(original_slice) =
            text_slice_by_codepoints(&text, operation.range.start, operation.range.end)
        else {
            return Err(redaction_error("tool_guard_range_invalid"));
        };
        mappings.push(ToolGuardReplacementMapping {
            replacement: operation.replacement.clone(),
            original: original_slice.to_string(),
        });
        let start = byte_index_for_codepoint(&text, operation.range.start)
            .ok_or_else(|| redaction_error("tool_guard_range_invalid"))?;
        let end = byte_index_for_codepoint(&text, operation.range.end)
            .ok_or_else(|| redaction_error("tool_guard_range_invalid"))?;
        text.replace_range(start..end, &operation.replacement);
    }
    Ok(text)
}

fn target_text(value: &Value) -> Result<String, AppError> {
    value
        .as_str()
        .map(str::to_string)
        .or_else(|| value.is_number().then(|| value.to_string()))
        .or_else(|| value.is_boolean().then(|| value.to_string()))
        .ok_or_else(|| redaction_error("tool_guard_target_not_text"))
}

fn value_at_path<'a>(mut value: &'a Value, path: &[ToolGuardPathSegment]) -> Option<&'a Value> {
    for segment in path {
        match segment {
            ToolGuardPathSegment::ObjectKeySha256 { sha256 } => {
                let object = value.as_object()?;
                let key = hashed_object_key(object, sha256)?;
                value = object.get(&key)?;
            }
            ToolGuardPathSegment::ArrayIndex { index } => {
                value = value.as_array()?.get(*index)?;
            }
        }
    }
    Some(value)
}

fn value_at_path_mut<'a>(
    mut value: &'a mut Value,
    path: &[ToolGuardPathSegment],
) -> Result<&'a mut Value, AppError> {
    for segment in path {
        match segment {
            ToolGuardPathSegment::ObjectKeySha256 { sha256 } => {
                let object = value
                    .as_object_mut()
                    .ok_or_else(|| redaction_error("tool_guard_path_missing"))?;
                let key = hashed_object_key(object, sha256)
                    .ok_or_else(|| redaction_error("tool_guard_path_missing"))?;
                value = object
                    .get_mut(&key)
                    .ok_or_else(|| redaction_error("tool_guard_path_missing"))?;
            }
            ToolGuardPathSegment::ArrayIndex { index } => {
                value = value
                    .as_array_mut()
                    .and_then(|array| array.get_mut(*index))
                    .ok_or_else(|| redaction_error("tool_guard_path_missing"))?;
            }
        }
    }
    Ok(value)
}

fn key_at_path(value: &Value, path: &[ToolGuardPathSegment]) -> Option<String> {
    let (key_segment, parent_path) = path.split_last()?;
    let parent = value_at_path(value, parent_path)?;
    let object = parent.as_object()?;
    match key_segment {
        ToolGuardPathSegment::ObjectKeySha256 { sha256 } => hashed_object_key(object, sha256),
        ToolGuardPathSegment::ArrayIndex { .. } => None,
    }
}

fn object_and_key_at_path_mut<'a>(
    value: &'a mut Value,
    path: &[ToolGuardPathSegment],
) -> Result<(&'a mut Map<String, Value>, String), AppError> {
    let Some((key_segment, parent_path)) = path.split_last() else {
        return Err(redaction_error("tool_guard_path_missing"));
    };
    let parent = value_at_path_mut(value, parent_path)?;
    let object = parent
        .as_object_mut()
        .ok_or_else(|| redaction_error("tool_guard_path_missing"))?;
    let key = match key_segment {
        ToolGuardPathSegment::ObjectKeySha256 { sha256 } => hashed_object_key(object, sha256)
            .ok_or_else(|| redaction_error("tool_guard_path_missing"))?,
        ToolGuardPathSegment::ArrayIndex { .. } => {
            return Err(redaction_error("tool_guard_path_missing"));
        }
    };
    Ok((object, key))
}

fn hashed_object_key(object: &Map<String, Value>, sha256: &str) -> Option<String> {
    object
        .keys()
        .find(|key| object_key_sha256(key).eq_ignore_ascii_case(sha256))
        .cloned()
}

fn text_slice_by_codepoints(text: &str, start: usize, end: usize) -> Option<&str> {
    if start > end {
        return None;
    }
    let start = byte_index_for_codepoint(text, start)?;
    let end = byte_index_for_codepoint(text, end)?;
    text.get(start..end)
}

fn byte_index_for_codepoint(text: &str, index: usize) -> Option<usize> {
    if index == text.chars().count() {
        return Some(text.len());
    }
    text.char_indices()
        .nth(index)
        .map(|(byte_index, _)| byte_index)
}

fn redaction_error(message: &'static str) -> AppError {
    AppError::new("tool_guard_redaction_failed", message)
}
