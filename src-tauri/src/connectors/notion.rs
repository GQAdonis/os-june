//! Notion local-mode connector.
//!
//! OAuth and every REST request run in the Rust host. The MCP process only
//! receives compact JSON through June's loopback connector proxy and never
//! sees the Notion bearer token.

use crate::domain::types::AppError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use zeroize::{Zeroize, ZeroizeOnDrop};

use super::oauth::{self, ConnectFlow};

const AUTH_ENDPOINT: &str = "https://api.notion.com/v1/oauth/authorize";
const TOKEN_ENDPOINT: &str = "https://api.notion.com/v1/oauth/token";
const REVOKE_ENDPOINT: &str = "https://api.notion.com/v1/oauth/revoke";
const API_BASE: &str = "https://api.notion.com/v1";
const NOTION_VERSION: &str = "2026-03-11";
const MAX_BLOCK_PAGES: usize = 5;

#[derive(Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct NotionTokenResponse {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[zeroize(skip)]
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[zeroize(skip)]
    #[serde(default)]
    pub workspace_name: Option<String>,
    #[zeroize(skip)]
    #[serde(default)]
    pub owner: Option<Value>,
}

pub struct AuthorizedGrant {
    pub tokens: NotionTokenResponse,
    pub workspace_id: String,
    pub display_name: String,
    pub email: Option<String>,
}

#[derive(Deserialize)]
struct OAuthErrorBody {
    #[serde(default)]
    error: Option<String>,
}

pub enum RefreshOutcome {
    Refreshed(NotionTokenResponse),
    InvalidGrant,
    Transient,
}

pub async fn authorize(
    flow: &ConnectFlow,
    client_id: &str,
    client_secret: &str,
    redirect_uri: &str,
) -> Result<AuthorizedGrant, AppError> {
    let state = oauth::random_b64url(24);
    let auth_url = build_auth_url(client_id, redirect_uri, &state);
    let code = oauth::authorize_loopback(flow, "Notion", redirect_uri, &auth_url, &state).await?;
    let tokens = exchange_code(client_id, client_secret, redirect_uri, &code).await?;
    let workspace_id = tokens
        .workspace_id
        .clone()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            AppError::new(
                "connector_identity_failed",
                "Notion did not identify the connected workspace.",
            )
        })?;
    let display_name = tokens
        .workspace_name
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "Notion workspace".to_string());
    let email = tokens.owner.as_ref().and_then(owner_email);
    Ok(AuthorizedGrant {
        tokens,
        workspace_id,
        display_name,
        email,
    })
}

fn build_auth_url(client_id: &str, redirect_uri: &str, state: &str) -> String {
    format!(
        "{AUTH_ENDPOINT}?owner=user&client_id={}&redirect_uri={}&response_type=code&state={}",
        urlencoding::encode(client_id),
        urlencoding::encode(redirect_uri),
        urlencoding::encode(state),
    )
}

async fn exchange_code(
    client_id: &str,
    client_secret: &str,
    redirect_uri: &str,
    code: &str,
) -> Result<NotionTokenResponse, AppError> {
    let response = oauth::http_client()
        .post(TOKEN_ENDPOINT)
        .basic_auth(client_id, Some(client_secret))
        .header("Notion-Version", NOTION_VERSION)
        .json(&json!({
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
        }))
        .send()
        .await
        .map_err(|_| exchange_failed(None))?;
    parse_token_response(response, "exchange").await
}

pub async fn refresh(client_id: &str, client_secret: &str, refresh_token: &str) -> RefreshOutcome {
    let response = match oauth::http_client()
        .post(TOKEN_ENDPOINT)
        .basic_auth(client_id, Some(client_secret))
        .header("Notion-Version", NOTION_VERSION)
        .json(&json!({
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
        }))
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
    if let Ok(tokens) = serde_json::from_str::<NotionTokenResponse>(&body) {
        if !tokens.access_token.is_empty() {
            return RefreshOutcome::Refreshed(tokens);
        }
    }
    let error = serde_json::from_str::<OAuthErrorBody>(&body)
        .ok()
        .and_then(|body| body.error);
    tracing::warn!(status, error_code = ?error, "notion token refresh failed");
    if matches!(error.as_deref(), Some("invalid_grant" | "unauthorized")) {
        RefreshOutcome::InvalidGrant
    } else {
        RefreshOutcome::Transient
    }
}

pub async fn revoke(client_id: &str, client_secret: &str, token: &str) -> bool {
    match oauth::http_client()
        .post(REVOKE_ENDPOINT)
        .basic_auth(client_id, Some(client_secret))
        .header("Notion-Version", NOTION_VERSION)
        .json(&json!({ "token": token }))
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
) -> Result<NotionTokenResponse, AppError> {
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|_| exchange_failed(None))?;
    if let Ok(tokens) = serde_json::from_str::<NotionTokenResponse>(&body) {
        if !tokens.access_token.is_empty() {
            return Ok(tokens);
        }
    }
    let error = serde_json::from_str::<OAuthErrorBody>(&body)
        .ok()
        .and_then(|body| body.error);
    tracing::warn!(status, error_code = ?error, operation, "notion token request failed");
    Err(exchange_failed(error))
}

fn exchange_failed(error: Option<String>) -> AppError {
    let message = error.map_or_else(
        || "Could not complete the Notion connection.".to_string(),
        |code| format!("Could not complete the Notion connection ({code})."),
    );
    AppError::new("connector_token_exchange_failed", message)
}

fn owner_email(owner: &Value) -> Option<String> {
    owner
        .get("user")
        .and_then(|user| user.get("person"))
        .and_then(|person| person.get("email"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|email| !email.is_empty())
        .map(str::to_ascii_lowercase)
}

#[derive(Debug)]
pub enum NotionApiError {
    Unauthorized,
    Request(AppError),
}

impl From<NotionApiError> for AppError {
    fn from(error: NotionApiError) -> Self {
        match error {
            NotionApiError::Unauthorized => AppError::new(
                "connector_reconnect_required",
                "Notion access expired. Reconnect it in settings.",
            ),
            NotionApiError::Request(error) => error,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageSummary {
    pub id: String,
    pub title: String,
    pub url: Option<String>,
    pub last_edited_time: Option<String>,
}

pub async fn search_pages(token: &str, query: &str, max: u32) -> Result<Value, NotionApiError> {
    let response = notion_request(token, reqwest::Method::POST, "/search")
        .json(&json!({
            "query": query,
            "filter": { "property": "object", "value": "page" },
            "sort": { "direction": "descending", "timestamp": "last_edited_time" },
            "page_size": max.clamp(1, 50),
        }))
        .send()
        .await
        .map_err(transport_error)?;
    let body = parse_api_response(response).await?;
    let pages: Vec<PageSummary> = body
        .get("results")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(page_summary)
        .collect();
    Ok(json!({
        "pages": pages,
        "hasMore": body.get("has_more").and_then(Value::as_bool).unwrap_or(false),
    }))
}

pub async fn read_page(token: &str, page_id: &str) -> Result<Value, NotionApiError> {
    // A page id is a URL path segment, not a path supplied by the caller. Encode
    // it so malformed tool input cannot turn a page read into another Notion
    // endpoint while carrying the account bearer token.
    let encoded_page_id = urlencoding::encode(page_id);
    let response = notion_request(
        token,
        reqwest::Method::GET,
        &format!("/pages/{encoded_page_id}"),
    )
    .send()
    .await
    .map_err(transport_error)?;
    let page = parse_api_response(response).await?;
    let mut blocks = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..MAX_BLOCK_PAGES {
        let mut path = format!("/blocks/{encoded_page_id}/children?page_size=100");
        if let Some(cursor) = cursor.as_deref() {
            path.push_str("&start_cursor=");
            path.push_str(&urlencoding::encode(cursor));
        }
        let response = notion_request(token, reqwest::Method::GET, &path)
            .send()
            .await
            .map_err(transport_error)?;
        let children = parse_api_response(response).await?;
        blocks.extend(
            children
                .get("results")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(compact_block),
        );
        cursor = children
            .get("next_cursor")
            .and_then(Value::as_str)
            .map(str::to_string);
        if cursor.is_none() {
            break;
        }
    }
    let summary = page_summary(&page).unwrap_or(PageSummary {
        id: page_id.to_string(),
        title: "Untitled".to_string(),
        url: None,
        last_edited_time: None,
    });
    Ok(json!({
        "page": summary,
        "properties": page.get("properties").cloned().unwrap_or_else(|| json!({})),
        "content": blocks,
        "contentTruncated": cursor.is_some(),
    }))
}

pub async fn create_page(
    token: &str,
    title: &str,
    markdown: &str,
    parent_page_id: Option<&str>,
) -> Result<Value, NotionApiError> {
    let mut body = json!({
        "properties": {
            "title": {
                "type": "title",
                "title": [{ "type": "text", "text": { "content": title } }]
            }
        },
        "markdown": markdown,
    });
    if let Some(parent_page_id) = parent_page_id {
        body["parent"] = json!({ "type": "page_id", "page_id": parent_page_id });
    }
    let response = notion_request(token, reqwest::Method::POST, "/pages")
        .json(&body)
        .send()
        .await
        .map_err(transport_error)?;
    let page = parse_api_response(response).await?;
    Ok(json!({ "page": page_summary(&page) }))
}

fn notion_request(token: &str, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
    oauth::http_client()
        .request(method, format!("{API_BASE}{path}"))
        .bearer_auth(token)
        .header("Notion-Version", NOTION_VERSION)
        .header("Content-Type", "application/json")
}

async fn parse_api_response(response: reqwest::Response) -> Result<Value, NotionApiError> {
    let status = response.status();
    if status.as_u16() == 401 {
        return Err(NotionApiError::Unauthorized);
    }
    let body: Value = response.json().await.map_err(|_| {
        NotionApiError::Request(AppError::new(
            "connector_provider_unreadable",
            "Notion returned an unreadable response.",
        ))
    })?;
    if !status.is_success() {
        let code = body
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("request_failed");
        let message = body
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Notion request failed.");
        return Err(NotionApiError::Request(AppError::new(
            format!("connector_notion_{code}"),
            message,
        )));
    }
    Ok(body)
}

fn transport_error(_: reqwest::Error) -> NotionApiError {
    NotionApiError::Request(AppError::new(
        "connector_provider_unavailable",
        "Could not reach Notion. Try again in a moment.",
    ))
}

fn page_summary(value: &Value) -> Option<PageSummary> {
    Some(PageSummary {
        id: value.get("id")?.as_str()?.to_string(),
        title: page_title(value).unwrap_or_else(|| "Untitled".to_string()),
        url: value.get("url").and_then(Value::as_str).map(str::to_string),
        last_edited_time: value
            .get("last_edited_time")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

fn page_title(value: &Value) -> Option<String> {
    value
        .get("properties")?
        .as_object()?
        .values()
        .find_map(|property| {
            let items = property.get("title")?.as_array()?;
            let title = rich_text_plain(items);
            (!title.is_empty()).then_some(title)
        })
}

fn rich_text_plain(items: &[Value]) -> String {
    items
        .iter()
        .filter_map(|item| item.get("plain_text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("")
}

fn compact_block(block: &Value) -> Value {
    let kind = block
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let content = block.get(kind).unwrap_or(&Value::Null);
    let text = content
        .get("rich_text")
        .and_then(Value::as_array)
        .map(|items| rich_text_plain(items))
        .or_else(|| {
            content
                .get("title")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default();
    json!({
        "id": block.get("id").and_then(Value::as_str),
        "type": kind,
        "text": text,
        "hasChildren": block.get("has_children").and_then(Value::as_bool).unwrap_or(false),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_url_contains_required_public_connection_fields() {
        let url = build_auth_url(
            "client-id",
            "http://127.0.0.1:43191/notion/callback",
            "state-value",
        );
        assert!(url.starts_with(AUTH_ENDPOINT));
        assert!(url.contains("owner=user"));
        assert!(url.contains("client_id=client-id"));
        assert!(url.contains("response_type=code"));
        assert!(url.contains("state=state-value"));
    }

    #[test]
    fn extracts_owner_email_and_page_title() {
        let owner = json!({ "user": { "person": { "email": "USER@Example.com" } } });
        assert_eq!(owner_email(&owner).as_deref(), Some("user@example.com"));
        let page = json!({
            "properties": {
                "Name": { "title": [{ "plain_text": "Project plan" }] }
            }
        });
        assert_eq!(page_title(&page).as_deref(), Some("Project plan"));
    }
}
