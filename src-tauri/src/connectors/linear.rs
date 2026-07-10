//! Linear local-mode connector.
//!
//! Uses OAuth PKCE with targeted issue/comment write scopes, then calls
//! Linear's GraphQL API directly from the Rust host.

use crate::domain::types::AppError;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use zeroize::{Zeroize, ZeroizeOnDrop};

use super::oauth::{self, ConnectFlow};

const AUTH_ENDPOINT: &str = "https://linear.app/oauth/authorize";
const TOKEN_ENDPOINT: &str = "https://api.linear.app/oauth/token";
const REVOKE_ENDPOINT: &str = "https://api.linear.app/oauth/revoke";
const GRAPHQL_ENDPOINT: &str = "https://api.linear.app/graphql";
const MAX_ASSIGNMENT_TRIGGER_PAGES: usize = 50;
pub const REQUESTED_SCOPES: &[&str] = &["read", "issues:create", "comments:create"];

#[derive(Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct LinearTokenResponse {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[zeroize(skip)]
    pub expires_in: i64,
    #[zeroize(skip)]
    #[serde(default)]
    pub scope: Value,
}

pub struct AuthorizedGrant {
    pub tokens: LinearTokenResponse,
    pub organization_id: String,
    pub organization_name: String,
    pub email: Option<String>,
}

#[derive(Deserialize)]
struct OAuthErrorBody {
    #[serde(default)]
    error: Option<String>,
}

pub enum RefreshOutcome {
    Refreshed(LinearTokenResponse),
    InvalidGrant,
    Transient,
}

pub async fn authorize(
    flow: &ConnectFlow,
    client_id: &str,
    client_secret: &str,
    redirect_uri: &str,
) -> Result<AuthorizedGrant, AppError> {
    let (verifier, challenge) = oauth::pkce();
    let state = oauth::random_b64url(24);
    let auth_url = build_auth_url(client_id, redirect_uri, &challenge, &state);
    let code = oauth::authorize_loopback(flow, "Linear", redirect_uri, &auth_url, &state).await?;
    let tokens = exchange_code(client_id, client_secret, redirect_uri, &code, &verifier).await?;
    let identity = viewer_identity(&tokens.access_token)
        .await
        .map_err(AppError::from)?;
    Ok(AuthorizedGrant {
        tokens,
        organization_id: identity.organization_id,
        organization_name: identity.organization_name,
        email: identity.email,
    })
}

fn build_auth_url(client_id: &str, redirect_uri: &str, challenge: &str, state: &str) -> String {
    format!(
        "{AUTH_ENDPOINT}?client_id={}&redirect_uri={}&response_type=code&scope={}&actor=user&state={}&code_challenge={}&code_challenge_method=S256",
        urlencoding::encode(client_id),
        urlencoding::encode(redirect_uri),
        urlencoding::encode(&REQUESTED_SCOPES.join(",")),
        urlencoding::encode(state),
        urlencoding::encode(challenge),
    )
}

async fn exchange_code(
    client_id: &str,
    client_secret: &str,
    redirect_uri: &str,
    code: &str,
    verifier: &str,
) -> Result<LinearTokenResponse, AppError> {
    let mut form = vec![
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("client_id", client_id),
        ("code_verifier", verifier),
    ];
    if !client_secret.is_empty() {
        form.push(("client_secret", client_secret));
    }
    let response = oauth::http_client()
        .post(TOKEN_ENDPOINT)
        .form(&form)
        .send()
        .await
        .map_err(|_| exchange_failed(None))?;
    parse_token_response(response, "exchange").await
}

pub async fn refresh(client_id: &str, refresh_token: &str) -> RefreshOutcome {
    let response = match oauth::http_client()
        .post(TOKEN_ENDPOINT)
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", client_id),
        ])
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return RefreshOutcome::Transient,
    };
    let status = response.status().as_u16();
    let body = match response.text().await {
        Ok(body) => body,
        Err(_) => return RefreshOutcome::Transient,
    };
    if let Ok(tokens) = serde_json::from_str::<LinearTokenResponse>(&body) {
        if !tokens.access_token.is_empty() {
            return RefreshOutcome::Refreshed(tokens);
        }
    }
    let error = serde_json::from_str::<OAuthErrorBody>(&body)
        .ok()
        .and_then(|body| body.error);
    tracing::warn!(status, error_code = ?error, "linear token refresh failed");
    if matches!(error.as_deref(), Some("invalid_grant" | "invalid_token")) {
        RefreshOutcome::InvalidGrant
    } else {
        RefreshOutcome::Transient
    }
}

pub async fn revoke(token: &str) -> bool {
    match oauth::http_client()
        .post(REVOKE_ENDPOINT)
        .form(&[("token", token), ("token_type_hint", "refresh_token")])
        .send()
        .await
    {
        Ok(response) => response.status().is_success(),
        Err(_) => false,
    }
}

async fn parse_token_response(
    response: reqwest::Response,
    operation: &str,
) -> Result<LinearTokenResponse, AppError> {
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|_| exchange_failed(None))?;
    if let Ok(tokens) = serde_json::from_str::<LinearTokenResponse>(&body) {
        if !tokens.access_token.is_empty() {
            return Ok(tokens);
        }
    }
    let error = serde_json::from_str::<OAuthErrorBody>(&body)
        .ok()
        .and_then(|body| body.error);
    tracing::warn!(status, error_code = ?error, operation, "linear token request failed");
    Err(exchange_failed(error))
}

fn exchange_failed(error: Option<String>) -> AppError {
    let message = error.map_or_else(
        || "Could not complete the Linear connection.".to_string(),
        |code| format!("Could not complete the Linear connection ({code})."),
    );
    AppError::new("connector_token_exchange_failed", message)
}

pub fn granted_scopes(value: &Value) -> Vec<String> {
    let parsed = match value {
        Value::String(value) => value
            .split([',', ' '])
            .map(str::trim)
            .filter(|scope| !scope.is_empty())
            .map(str::to_string)
            .collect(),
        Value::Array(values) => values
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    };
    if parsed.is_empty() {
        REQUESTED_SCOPES
            .iter()
            .map(|scope| (*scope).to_string())
            .collect()
    } else {
        parsed
    }
}

#[derive(Debug)]
pub enum LinearApiError {
    Unauthorized,
    Request(AppError),
}

impl From<LinearApiError> for AppError {
    fn from(error: LinearApiError) -> Self {
        match error {
            LinearApiError::Unauthorized => AppError::new(
                "connector_reconnect_required",
                "Linear access expired. Reconnect it in settings.",
            ),
            LinearApiError::Request(error) => error,
        }
    }
}

struct ViewerIdentity {
    organization_id: String,
    organization_name: String,
    email: Option<String>,
}

async fn viewer_identity(token: &str) -> Result<ViewerIdentity, LinearApiError> {
    let data = graphql(
        token,
        "query JuneConnectorIdentity { viewer { email } organization { id name } }",
        json!({}),
    )
    .await?;
    let organization = data.get("organization").ok_or_else(|| {
        LinearApiError::Request(AppError::new(
            "connector_identity_failed",
            "Linear did not identify the connected workspace.",
        ))
    })?;
    Ok(ViewerIdentity {
        organization_id: required_json_string(organization, "id")?,
        organization_name: required_json_string(organization, "name")?,
        email: data
            .get("viewer")
            .and_then(|viewer| viewer.get("email"))
            .and_then(Value::as_str)
            .map(str::to_ascii_lowercase),
    })
}

const ISSUE_FIELDS: &str = r#"
  id identifier title description url priority createdAt updatedAt
  team { id key name }
  state { id name type }
  assignee { id name email }
"#;

pub async fn search_issues(token: &str, query: &str, max: u32) -> Result<Value, LinearApiError> {
    let document = format!(
        r#"query JuneSearchIssues($query: String!, $first: Int!) {{
          issues(first: $first, filter: {{ or: [
            {{ title: {{ containsIgnoreCase: $query }} }},
            {{ description: {{ containsIgnoreCase: $query }} }}
          ] }}, orderBy: updatedAt) {{ nodes {{ {ISSUE_FIELDS} }} }}
        }}"#
    );
    let data = graphql(
        token,
        &document,
        json!({ "query": query, "first": max.clamp(1, 50) }),
    )
    .await?;
    Ok(json!({ "issues": data.pointer("/issues/nodes").cloned().unwrap_or_else(|| json!([])) }))
}

pub async fn list_teams(token: &str, max: u32) -> Result<Value, LinearApiError> {
    let data = graphql(
        token,
        r#"query JuneTeams($first: Int!) {
          teams(first: $first) {
            nodes { id key name }
            pageInfo { hasNextPage }
          }
        }"#,
        json!({ "first": max.clamp(1, 100) }),
    )
    .await?;
    Ok(json!({
        "teams": data.pointer("/teams/nodes").cloned().unwrap_or_else(|| json!([])),
        "hasMore": data.pointer("/teams/pageInfo/hasNextPage").and_then(Value::as_bool).unwrap_or(false),
    }))
}

pub async fn list_assigned_issues(token: &str, max: u32) -> Result<Value, LinearApiError> {
    let document = format!(
        r#"query JuneAssignedIssues($first: Int!) {{
          viewer {{ assignedIssues(first: $first, orderBy: updatedAt) {{ nodes {{ {ISSUE_FIELDS} }} }} }}
        }}"#
    );
    let data = graphql(token, &document, json!({ "first": max.clamp(1, 100) })).await?;
    Ok(
        json!({ "issues": data.pointer("/viewer/assignedIssues/nodes").cloned().unwrap_or_else(|| json!([])) }),
    )
}

/// The complete current assignment set used by the local polling trigger.
/// Fetching every page lets the cursor store the current set rather than a
/// bounded recent page, so an issue that falls off a page cannot later look
/// newly assigned. The high safety cap fails closed without advancing the
/// cursor in pathological workspaces.
pub async fn list_all_assigned_issue_ids(token: &str) -> Result<Vec<String>, LinearApiError> {
    let mut after: Option<String> = None;
    let mut ids = BTreeSet::new();
    for _ in 0..MAX_ASSIGNMENT_TRIGGER_PAGES {
        let data = graphql(
            token,
            r#"query JuneAllAssignedIssueIds($first: Int!, $after: String) {
              viewer {
                assignedIssues(
                  first: $first
                  after: $after
                  filter: { state: { type: { nin: ["completed", "canceled"] } } }
                ) {
                  nodes { id }
                  pageInfo { hasNextPage endCursor }
                }
              }
            }"#,
            json!({ "first": 100, "after": after }),
        )
        .await?;
        let connection = data.pointer("/viewer/assignedIssues").ok_or_else(|| {
            LinearApiError::Request(AppError::new(
                "connector_provider_unreadable",
                "Linear returned an incomplete assignment list.",
            ))
        })?;
        for id in connection
            .get("nodes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|issue| issue.get("id").and_then(Value::as_str))
        {
            ids.insert(id.to_string());
        }
        let page_info = connection.get("pageInfo").unwrap_or(&Value::Null);
        if !page_info
            .get("hasNextPage")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return Ok(ids.into_iter().collect());
        }
        after = page_info
            .get("endCursor")
            .and_then(Value::as_str)
            .map(str::to_string);
        if after.is_none() {
            return Err(LinearApiError::Request(AppError::new(
                "connector_provider_unreadable",
                "Linear returned an incomplete assignment cursor.",
            )));
        }
    }
    Err(LinearApiError::Request(AppError::new(
        "connector_assignment_limit",
        "The Linear assignment set is too large for local polling.",
    )))
}

pub async fn get_issue(token: &str, issue_id: &str) -> Result<Value, LinearApiError> {
    let document = format!(
        r#"query JuneIssue($id: String!) {{ issue(id: $id) {{ {ISSUE_FIELDS} comments(first: 50) {{ nodes {{ id body createdAt user {{ id name }} }} }} }} }}"#
    );
    let data = graphql(token, &document, json!({ "id": issue_id })).await?;
    Ok(json!({ "issue": data.get("issue").cloned().unwrap_or(Value::Null) }))
}

pub async fn create_issue(
    token: &str,
    team_id: &str,
    title: &str,
    description: Option<&str>,
) -> Result<Value, LinearApiError> {
    let document = format!(
        r#"mutation JuneCreateIssue($input: IssueCreateInput!) {{
          issueCreate(input: $input) {{ success issue {{ {ISSUE_FIELDS} }} }}
        }}"#
    );
    let mut input = json!({ "teamId": team_id, "title": title });
    if let Some(description) = description {
        input["description"] = Value::String(description.to_string());
    }
    let data = graphql(token, &document, json!({ "input": input })).await?;
    Ok(data.get("issueCreate").cloned().unwrap_or(Value::Null))
}

pub async fn add_comment(token: &str, issue_id: &str, body: &str) -> Result<Value, LinearApiError> {
    let data = graphql(
        token,
        r#"mutation JuneAddComment($input: CommentCreateInput!) {
          commentCreate(input: $input) {
            success comment { id body createdAt url user { id name } }
          }
        }"#,
        json!({ "input": { "issueId": issue_id, "body": body } }),
    )
    .await?;
    Ok(data.get("commentCreate").cloned().unwrap_or(Value::Null))
}

async fn graphql(token: &str, query: &str, variables: Value) -> Result<Value, LinearApiError> {
    let response = oauth::http_client()
        .post(GRAPHQL_ENDPOINT)
        .bearer_auth(token)
        .json(&json!({ "query": query, "variables": variables }))
        .send()
        .await
        .map_err(|_| {
            LinearApiError::Request(AppError::new(
                "connector_provider_unavailable",
                "Could not reach Linear. Try again in a moment.",
            ))
        })?;
    if response.status().as_u16() == 401 {
        return Err(LinearApiError::Unauthorized);
    }
    let status = response.status();
    let body: Value = response.json().await.map_err(|_| {
        LinearApiError::Request(AppError::new(
            "connector_provider_unreadable",
            "Linear returned an unreadable response.",
        ))
    })?;
    if !status.is_success() || body.get("errors").is_some() {
        let first = body
            .get("errors")
            .and_then(Value::as_array)
            .and_then(|errors| errors.first());
        let message = first
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("Linear request failed.");
        let code = first
            .and_then(|error| error.pointer("/extensions/code"))
            .and_then(Value::as_str)
            .unwrap_or("request_failed");
        if matches!(code, "AUTHENTICATION_ERROR" | "UNAUTHENTICATED") {
            return Err(LinearApiError::Unauthorized);
        }
        return Err(LinearApiError::Request(AppError::new(
            format!("connector_linear_{}", code.to_ascii_lowercase()),
            message,
        )));
    }
    Ok(body.get("data").cloned().unwrap_or_else(|| json!({})))
}

fn required_json_string(value: &Value, key: &str) -> Result<String, LinearApiError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            LinearApiError::Request(AppError::new(
                "connector_identity_failed",
                "Linear returned an incomplete workspace identity.",
            ))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_url_uses_pkce_and_targeted_scopes() {
        let url = build_auth_url(
            "client-id",
            "http://127.0.0.1:43192/linear/callback",
            "challenge",
            "state",
        );
        assert!(url.starts_with(AUTH_ENDPOINT));
        assert!(url.contains("actor=user"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("issues%3Acreate"));
        assert!(url.contains("comments%3Acreate"));
        assert!(!url.contains("scope=read%2Cwrite"));
    }

    #[test]
    fn scopes_accept_new_and_legacy_response_shapes() {
        assert_eq!(
            granted_scopes(&json!("read issues:create comments:create")),
            vec!["read", "issues:create", "comments:create"]
        );
        assert_eq!(
            granted_scopes(&json!(["read", "issues:create"])),
            vec!["read", "issues:create"]
        );
        assert_eq!(
            granted_scopes(&json!("")),
            vec!["read", "issues:create", "comments:create"]
        );
    }
}
