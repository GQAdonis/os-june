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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn value_locator(path: Vec<ToolGuardPathSegment>) -> ToolGuardLocator {
        ToolGuardLocator {
            target: ToolGuardLocatorTarget::Value,
            path,
        }
    }

    fn key_locator(path: Vec<ToolGuardPathSegment>) -> ToolGuardLocator {
        ToolGuardLocator {
            target: ToolGuardLocatorTarget::Key,
            path,
        }
    }

    fn key_segment(key: &str) -> ToolGuardPathSegment {
        ToolGuardPathSegment::ObjectKeySha256 {
            sha256: object_key_sha256(key),
        }
    }

    fn range(start: usize, end: usize) -> ToolGuardTextRange {
        ToolGuardTextRange {
            start,
            end,
            unit: ToolGuardTextRangeUnit::UnicodeCodepoint,
        }
    }

    fn operation(
        finding_id: &str,
        locator: ToolGuardLocator,
        start: usize,
        end: usize,
        replacement: &str,
    ) -> ToolGuardRedactionOperation {
        ToolGuardRedactionOperation {
            finding_id: finding_id.to_string(),
            locator,
            range: range(start, end),
            replacement: replacement.to_string(),
        }
    }

    fn plan(operations: Vec<ToolGuardRedactionOperation>) -> ToolGuardRedactionPlan {
        ToolGuardRedactionPlan { operations }
    }

    #[test]
    fn redacts_value_and_records_mapping() {
        let value = json!({ "query": "Email alice@example.com now" });
        let locator = value_locator(vec![key_segment("query")]);
        let plan = plan(vec![operation(
            "finding-1",
            locator.clone(),
            6,
            23,
            "[[OSG.EMAIL.1]]",
        )]);

        let result = apply_redaction_plan(&value, &plan, None).expect("redaction succeeds");

        assert_eq!(result.value["query"], "Email [[OSG.EMAIL.1]] now");
        assert_eq!(
            result.mappings,
            vec![ToolGuardReplacementMapping {
                replacement: "[[OSG.EMAIL.1]]".to_string(),
                original: "alice@example.com".to_string(),
            }]
        );
        assert_eq!(
            text_for_locator(&value, &locator).as_deref(),
            Some("Email alice@example.com now")
        );
    }

    #[test]
    fn applies_multiple_ranges_from_the_end_of_the_value() {
        let value = json!({
            "items": [
                { "summary": "Alice 555-0100" }
            ]
        });
        let locator = value_locator(vec![
            key_segment("items"),
            ToolGuardPathSegment::ArrayIndex { index: 0 },
            key_segment("summary"),
        ]);
        let plan = plan(vec![
            operation("finding-1", locator.clone(), 0, 5, "[[OSG.NAME.1]]"),
            operation("finding-2", locator, 6, 14, "[[OSG.PHONE.1]]"),
        ]);

        let result = apply_redaction_plan(&value, &plan, None).expect("redaction succeeds");

        assert_eq!(
            result.value["items"][0]["summary"],
            "[[OSG.NAME.1]] [[OSG.PHONE.1]]"
        );
        assert_eq!(result.mappings.len(), 2);
    }

    #[test]
    fn selected_findings_leave_unselected_text_raw() {
        let value = json!({ "query": "Email alice@example.com or bob@example.com" });
        let locator = value_locator(vec![key_segment("query")]);
        let plan = plan(vec![
            operation("finding-1", locator.clone(), 6, 23, "[[OSG.EMAIL.1]]"),
            operation("finding-2", locator, 27, 42, "[[OSG.EMAIL.2]]"),
        ]);
        let selected = HashSet::from(["finding-2".to_string()]);

        let result =
            apply_redaction_plan(&value, &plan, Some(&selected)).expect("redaction succeeds");

        assert_eq!(
            result.value["query"],
            "Email alice@example.com or [[OSG.EMAIL.2]]"
        );
        assert_eq!(result.mappings[0].original, "bob@example.com");
    }

    #[test]
    fn redacts_object_keys_by_hashed_path() {
        let value = json!({ "alice@example.com": "secret", "other": true });
        let locator = key_locator(vec![key_segment("alice@example.com")]);
        let plan = plan(vec![operation(
            "finding-1",
            locator.clone(),
            0,
            17,
            "[[OSG.EMAIL.1]]",
        )]);

        let result = apply_redaction_plan(&value, &plan, None).expect("redaction succeeds");

        assert!(result.value.get("alice@example.com").is_none());
        assert_eq!(result.value["[[OSG.EMAIL.1]]"], "secret");
        assert_eq!(
            text_for_locator(&value, &locator).as_deref(),
            Some("alice@example.com")
        );
    }

    #[test]
    fn rehydrates_final_text_from_local_mappings() {
        let mappings = vec![
            ToolGuardReplacementMapping {
                replacement: "[[OSG.EMAIL.1]]".to_string(),
                original: "alice@example.com".to_string(),
            },
            ToolGuardReplacementMapping {
                replacement: "[[OSG.PHONE.1]]".to_string(),
                original: "555-0100".to_string(),
            },
        ];

        let text = rehydrate_text("I found [[OSG.EMAIL.1]] and [[OSG.PHONE.1]].", &mappings);

        assert_eq!(text, "I found alice@example.com and 555-0100.");
    }
}
