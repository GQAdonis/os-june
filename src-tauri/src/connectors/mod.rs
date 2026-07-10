//! Private connectors, local mode.
//!
//! OAuth (PKCE/loopback where supported), Keychain token custody, provider API
//! clients, scope routing, and trigger polling. The provider proxy and trigger
//! daemon consume this module; June API and OpenSoftware infrastructure are
//! never in the connector data path.
//!
//! Secrets live ONLY in the keychain ([`store`]); the SQLite index carries
//! non-secret account metadata (emails, scopes, status) so accounts can be
//! enumerated without keychain prompts. Tokens are never logged and never
//! serialized into errors.

pub mod approvals;
pub mod commands;
pub mod google;
pub mod linear;
pub mod notion;
pub mod oauth;
pub mod scopes;
pub mod store;
pub mod triggers;

use crate::domain::types::AppError;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex as StdMutex, OnceLock},
};
use tokio::sync::Mutex as AsyncMutex;

pub use oauth::ConnectFlow;

/// Access tokens within this many seconds of expiry are refreshed instead of
/// returned, so a caller never receives a token that dies mid-request.
const ACCESS_TOKEN_EXPIRY_BUFFER_SECS: i64 = 60;
const GOOGLE_OAUTH_CLIENT_ID_ENV: &str = "GOOGLE_OAUTH_CLIENT_ID";
const GOOGLE_OAUTH_CLIENT_SECRET_ENV: &str = "GOOGLE_OAUTH_CLIENT_SECRET";
const NOTION_OAUTH_CLIENT_ID_ENV: &str = "NOTION_OAUTH_CLIENT_ID";
const NOTION_OAUTH_CLIENT_SECRET_ENV: &str = "NOTION_OAUTH_CLIENT_SECRET";
const NOTION_OAUTH_REDIRECT_URI_ENV: &str = "NOTION_OAUTH_REDIRECT_URI";
const LINEAR_OAUTH_CLIENT_ID_ENV: &str = "LINEAR_OAUTH_CLIENT_ID";
const LINEAR_OAUTH_CLIENT_SECRET_ENV: &str = "LINEAR_OAUTH_CLIENT_SECRET";
const LINEAR_OAUTH_REDIRECT_URI_ENV: &str = "LINEAR_OAUTH_REDIRECT_URI";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectorProvider {
    #[default]
    Google,
    Notion,
    Linear,
}

impl ConnectorProvider {
    pub fn as_str(&self) -> &'static str {
        match self {
            ConnectorProvider::Google => "google",
            ConnectorProvider::Notion => "notion",
            ConnectorProvider::Linear => "linear",
        }
    }

    pub fn from_db(value: &str) -> Option<Self> {
        match value {
            "google" => Some(Self::Google),
            "notion" => Some(Self::Notion),
            "linear" => Some(Self::Linear),
            _ => None,
        }
    }

    fn display_name(self) -> &'static str {
        match self {
            Self::Google => "Google",
            Self::Notion => "Notion",
            Self::Linear => "Linear",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectorAccountStatus {
    Connected,
    ReconnectRequired,
}

impl ConnectorAccountStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            ConnectorAccountStatus::Connected => "connected",
            ConnectorAccountStatus::ReconnectRequired => "reconnect_required",
        }
    }

    pub fn from_db(value: &str) -> Self {
        match value {
            "reconnect_required" => ConnectorAccountStatus::ReconnectRequired,
            _ => ConnectorAccountStatus::Connected,
        }
    }
}

/// Non-secret account descriptor returned to the frontend and used by the
/// proxy to enumerate accounts. Google ids are emails; other providers use a
/// namespaced stable workspace id.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorAccount {
    pub account_id: String,
    pub provider: ConnectorProvider,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    pub scopes: Vec<String>,
    pub status: ConnectorAccountStatus,
}

// --- Config ------------------------------------------------------------------

fn env_trimmed(key: &str) -> String {
    std::env::var(key)
        .map(|value| value.trim().to_string())
        .unwrap_or_default()
}

fn env_or_build_trimmed(key: &str, build_value: Option<&'static str>) -> String {
    let runtime_value = env_trimmed(key);
    if runtime_value.is_empty() {
        build_value.map(str::trim).unwrap_or_default().to_string()
    } else {
        runtime_value
    }
}

pub(crate) fn env_truthy(key: &str) -> bool {
    matches!(
        env_trimmed(key).to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

/// Cryptographically-random base64url string of `bytes` entropy. Mirrors
/// `oauth::random_b64url`; used to mint autonomy grant tokens (never a
/// time/counter source).
pub(crate) fn random_b64url(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(&buf)
}

/// Google Desktop OAuth credential. Google calls the second field a client
/// secret and requires it at the token endpoint, but an installed app cannot
/// keep it confidential: both values are shipped in the binary and neither
/// grants user-data access without the user's authorization code or refresh
/// token. Runtime env values override the build-time values for local testing.
struct GoogleOAuthClient {
    client_id: String,
    client_secret: String,
}

struct OAuthClient {
    client_id: String,
    client_secret: String,
    redirect_uri: String,
}

fn google_oauth_client() -> GoogleOAuthClient {
    crate::os_accounts::load_local_env();
    GoogleOAuthClient {
        client_id: env_or_build_trimmed(
            GOOGLE_OAUTH_CLIENT_ID_ENV,
            option_env!("GOOGLE_OAUTH_CLIENT_ID"),
        ),
        client_secret: env_or_build_trimmed(
            GOOGLE_OAUTH_CLIENT_SECRET_ENV,
            option_env!("GOOGLE_OAUTH_CLIENT_SECRET"),
        ),
    }
}

fn require_oauth_client() -> Result<GoogleOAuthClient, AppError> {
    let client = google_oauth_client();
    if client.client_id.is_empty() || client.client_secret.is_empty() {
        return Err(AppError::new(
            "connector_not_configured",
            "Google connector is not configured in this build.",
        ));
    }
    Ok(client)
}

fn oauth_client(
    id_env: &str,
    secret_env: &str,
    redirect_env: &str,
    build_id: Option<&'static str>,
    build_secret: Option<&'static str>,
    build_redirect: Option<&'static str>,
) -> OAuthClient {
    crate::os_accounts::load_local_env();
    OAuthClient {
        client_id: env_or_build_trimmed(id_env, build_id),
        client_secret: env_or_build_trimmed(secret_env, build_secret),
        redirect_uri: env_or_build_trimmed(redirect_env, build_redirect),
    }
}

fn require_provider_oauth_client(provider: ConnectorProvider) -> Result<OAuthClient, AppError> {
    let client = match provider {
        ConnectorProvider::Notion => oauth_client(
            NOTION_OAUTH_CLIENT_ID_ENV,
            NOTION_OAUTH_CLIENT_SECRET_ENV,
            NOTION_OAUTH_REDIRECT_URI_ENV,
            option_env!("NOTION_OAUTH_CLIENT_ID"),
            option_env!("NOTION_OAUTH_CLIENT_SECRET"),
            option_env!("NOTION_OAUTH_REDIRECT_URI"),
        ),
        ConnectorProvider::Linear => oauth_client(
            LINEAR_OAUTH_CLIENT_ID_ENV,
            LINEAR_OAUTH_CLIENT_SECRET_ENV,
            LINEAR_OAUTH_REDIRECT_URI_ENV,
            option_env!("LINEAR_OAUTH_CLIENT_ID"),
            option_env!("LINEAR_OAUTH_CLIENT_SECRET"),
            option_env!("LINEAR_OAUTH_REDIRECT_URI"),
        ),
        ConnectorProvider::Google => {
            return Err(AppError::new(
                "connector_not_configured",
                "Google uses its Desktop OAuth configuration.",
            ))
        }
    };
    let missing_required = client.client_id.is_empty()
        || client.redirect_uri.is_empty()
        || (provider == ConnectorProvider::Notion && client.client_secret.is_empty());
    if missing_required {
        return Err(AppError::new(
            "connector_not_configured",
            format!(
                "{} connector is not configured in this build.",
                provider.display_name()
            ),
        ));
    }
    Ok(client)
}

// --- Access tokens ----------------------------------------------------------------

/// Per-account refresh serialization: refresh tokens can rotate, so two
/// parallel refreshes for the same account must never race (one would burn a
/// consumed token and force a reconnect).
static REFRESH_LOCKS: OnceLock<StdMutex<HashMap<String, Arc<AsyncMutex<()>>>>> = OnceLock::new();

fn refresh_lock_for(account_id: &str) -> Arc<AsyncMutex<()>> {
    let locks = REFRESH_LOCKS.get_or_init(|| StdMutex::new(HashMap::new()));
    let mut locks = locks
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    locks
        .entry(account_id.to_string())
        .or_insert_with(|| Arc::new(AsyncMutex::new(())))
        .clone()
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

fn access_token_is_fresh(expires_at_unix: i64, now_unix: i64) -> bool {
    expires_at_unix > now_unix + ACCESS_TOKEN_EXPIRY_BUFFER_SECS
}

fn not_connected_error() -> AppError {
    AppError::new(
        "connector_not_connected",
        "This Google account is not connected.",
    )
}

fn reconnect_required_error() -> AppError {
    AppError::new(
        "connector_reconnect_required",
        "Google access for this account expired. Reconnect it in settings.",
    )
}

/// Resolve a usable access token for the account: the cached token when it
/// is comfortably fresh, otherwise a refreshed one. Refreshes are serialized
/// per account and handle refresh-token rotation. On a definitive
/// `invalid_grant` the account is flagged `reconnect_required` in the DB
/// index and `connector_reconnect_required` is returned.
pub async fn google_access_token(
    app: &tauri::AppHandle,
    account_id: &str,
) -> Result<String, AppError> {
    let stored = store::load_tokens(account_id)
        .await?
        .ok_or_else(not_connected_error)?;
    if access_token_is_fresh(stored.expires_at_unix, now_unix()) {
        return Ok(stored.access_token.clone());
    }
    refresh_google_access_token(app, account_id).await
}

/// Refresh regardless of cached freshness. Callers use this to retry once
/// after `google::GoogleApiError::Unauthorized` (a token revoked or expired
/// server side before its local expiry).
pub async fn force_refresh_google_access_token(
    app: &tauri::AppHandle,
    account_id: &str,
) -> Result<String, AppError> {
    // Skip the freshness fast path but still serialize on the account lock.
    refresh_google_access_token_with_freshness_gate(app, account_id, false).await
}

async fn refresh_google_access_token(
    app: &tauri::AppHandle,
    account_id: &str,
) -> Result<String, AppError> {
    refresh_google_access_token_with_freshness_gate(app, account_id, true).await
}

async fn refresh_google_access_token_with_freshness_gate(
    app: &tauri::AppHandle,
    account_id: &str,
    accept_fresh: bool,
) -> Result<String, AppError> {
    let client = require_oauth_client()?;
    let lock = refresh_lock_for(account_id);
    let _guard = lock.lock().await;
    // Re-read inside the lock: another caller may have already refreshed
    // (and rotated the refresh token) while we waited.
    let mut stored = store::load_tokens(account_id)
        .await?
        .ok_or_else(not_connected_error)?;
    if accept_fresh && access_token_is_fresh(stored.expires_at_unix, now_unix()) {
        return Ok(stored.access_token.clone());
    }

    let mut attempt = 0;
    loop {
        attempt += 1;
        match oauth::refresh(
            &client.client_id,
            &client.client_secret,
            &stored.refresh_token,
        )
        .await
        {
            oauth::RefreshOutcome::Refreshed(fresh) => {
                stored.access_token = fresh.access_token.clone();
                // Rotation: Google occasionally issues a new refresh token;
                // persist it, otherwise keep the existing one.
                if let Some(rotated) = fresh
                    .refresh_token
                    .as_deref()
                    .filter(|token| !token.is_empty())
                {
                    stored.refresh_token = rotated.to_string();
                }
                stored.expires_at_unix = now_unix() + fresh.expires_in.max(0);
                store::store_tokens(&stored).await?;
                return Ok(stored.access_token.clone());
            }
            oauth::RefreshOutcome::InvalidGrant => {
                mark_reconnect_required(app, account_id).await;
                return Err(reconnect_required_error());
            }
            oauth::RefreshOutcome::Transient => {
                if attempt < oauth::REFRESH_MAX_ATTEMPTS {
                    tokio::time::sleep(oauth::REFRESH_RETRY_BACKOFF * attempt as u32).await;
                    continue;
                }
                return Err(AppError::new(
                    "connector_refresh_unavailable",
                    "Couldn't reach Google to refresh access. Try again in a moment.",
                ));
            }
        }
    }
}

pub async fn notion_access_token(
    app: &tauri::AppHandle,
    account_id: &str,
) -> Result<String, AppError> {
    let stored = store::load_tokens(account_id)
        .await?
        .ok_or_else(|| provider_not_connected_error(ConnectorProvider::Notion))?;
    if !stored.access_token.is_empty() {
        return Ok(stored.access_token.clone());
    }
    refresh_notion_access_token(app, account_id).await
}

pub async fn force_refresh_notion_access_token(
    app: &tauri::AppHandle,
    account_id: &str,
) -> Result<String, AppError> {
    refresh_notion_access_token(app, account_id).await
}

async fn refresh_notion_access_token(
    app: &tauri::AppHandle,
    account_id: &str,
) -> Result<String, AppError> {
    let client = require_provider_oauth_client(ConnectorProvider::Notion)?;
    let lock = refresh_lock_for(account_id);
    let _guard = lock.lock().await;
    let mut stored = store::load_tokens(account_id)
        .await?
        .ok_or_else(|| provider_not_connected_error(ConnectorProvider::Notion))?;
    if stored.refresh_token.is_empty() {
        mark_reconnect_required(app, account_id).await;
        return Err(provider_reconnect_error(ConnectorProvider::Notion));
    }
    for attempt in 1..=oauth::REFRESH_MAX_ATTEMPTS {
        match notion::refresh(
            &client.client_id,
            &client.client_secret,
            &stored.refresh_token,
        )
        .await
        {
            notion::RefreshOutcome::Refreshed(fresh) => {
                stored.access_token = fresh.access_token.clone();
                if let Some(refresh) = fresh
                    .refresh_token
                    .as_deref()
                    .filter(|value| !value.is_empty())
                {
                    stored.refresh_token = refresh.to_string();
                }
                store::store_tokens(&stored).await?;
                return Ok(stored.access_token.clone());
            }
            notion::RefreshOutcome::InvalidGrant => {
                mark_reconnect_required(app, account_id).await;
                return Err(provider_reconnect_error(ConnectorProvider::Notion));
            }
            notion::RefreshOutcome::Transient if attempt < oauth::REFRESH_MAX_ATTEMPTS => {
                tokio::time::sleep(oauth::REFRESH_RETRY_BACKOFF * attempt as u32).await;
            }
            notion::RefreshOutcome::Transient => break,
        }
    }
    Err(AppError::new(
        "connector_refresh_unavailable",
        "Couldn't reach Notion to refresh access. Try again in a moment.",
    ))
}

pub async fn linear_access_token(
    app: &tauri::AppHandle,
    account_id: &str,
) -> Result<String, AppError> {
    let stored = store::load_tokens(account_id)
        .await?
        .ok_or_else(|| provider_not_connected_error(ConnectorProvider::Linear))?;
    if access_token_is_fresh(stored.expires_at_unix, now_unix()) {
        return Ok(stored.access_token.clone());
    }
    refresh_linear_access_token(app, account_id, true).await
}

pub async fn force_refresh_linear_access_token(
    app: &tauri::AppHandle,
    account_id: &str,
) -> Result<String, AppError> {
    refresh_linear_access_token(app, account_id, false).await
}

async fn refresh_linear_access_token(
    app: &tauri::AppHandle,
    account_id: &str,
    accept_fresh: bool,
) -> Result<String, AppError> {
    let client = require_provider_oauth_client(ConnectorProvider::Linear)?;
    let lock = refresh_lock_for(account_id);
    let _guard = lock.lock().await;
    let mut stored = store::load_tokens(account_id)
        .await?
        .ok_or_else(|| provider_not_connected_error(ConnectorProvider::Linear))?;
    if accept_fresh && access_token_is_fresh(stored.expires_at_unix, now_unix()) {
        return Ok(stored.access_token.clone());
    }
    for attempt in 1..=oauth::REFRESH_MAX_ATTEMPTS {
        match linear::refresh(&client.client_id, &stored.refresh_token).await {
            linear::RefreshOutcome::Refreshed(fresh) => {
                stored.access_token = fresh.access_token.clone();
                if let Some(refresh) = fresh
                    .refresh_token
                    .as_deref()
                    .filter(|value| !value.is_empty())
                {
                    stored.refresh_token = refresh.to_string();
                }
                stored.expires_at_unix = now_unix() + fresh.expires_in.max(0);
                let scopes = linear::granted_scopes(&fresh.scope);
                if !scopes.is_empty() {
                    stored.scopes = scopes;
                }
                store::store_tokens(&stored).await?;
                return Ok(stored.access_token.clone());
            }
            linear::RefreshOutcome::InvalidGrant => {
                mark_reconnect_required(app, account_id).await;
                return Err(provider_reconnect_error(ConnectorProvider::Linear));
            }
            linear::RefreshOutcome::Transient if attempt < oauth::REFRESH_MAX_ATTEMPTS => {
                tokio::time::sleep(oauth::REFRESH_RETRY_BACKOFF * attempt as u32).await;
            }
            linear::RefreshOutcome::Transient => break,
        }
    }
    Err(AppError::new(
        "connector_refresh_unavailable",
        "Couldn't reach Linear to refresh access. Try again in a moment.",
    ))
}

fn provider_not_connected_error(provider: ConnectorProvider) -> AppError {
    AppError::new(
        "connector_not_connected",
        format!("This {} account is not connected.", provider.display_name()),
    )
}

fn provider_reconnect_error(provider: ConnectorProvider) -> AppError {
    AppError::new(
        "connector_reconnect_required",
        format!(
            "{} access expired. Reconnect it in settings.",
            provider.display_name()
        ),
    )
}

/// Fired whenever an account's connection state changes (connect, disconnect,
/// or a background `reconnect_required` transition) so an open settings page
/// refreshes without a remount. The frontend `CONNECTORS_CHANGED_EVENT`
/// subscribes to this.
const CONNECTORS_CHANGED_EVENT: &str = "june://connectors-changed";

fn emit_connectors_changed(app: &tauri::AppHandle) {
    use tauri::Emitter;
    let _ = app.emit(CONNECTORS_CHANGED_EVENT, ());
}

async fn mark_reconnect_required(app: &tauri::AppHandle, account_id: &str) {
    match crate::commands::repositories(app).await {
        Ok(repos) => {
            if let Err(error) = repos
                .set_connector_account_status(
                    account_id,
                    ConnectorAccountStatus::ReconnectRequired.as_str(),
                )
                .await
            {
                tracing::warn!(
                    error_code = %AppError::from(error).code,
                    "failed to flag connector account for reconnect"
                );
            } else {
                // A background refresh just downgraded this account; tell any
                // open settings page so it does not show a stale "Connected".
                emit_connectors_changed(app);
            }
        }
        Err(error) => {
            tracing::warn!(
                error_code = %error.code,
                "failed to open repositories to flag connector reconnect"
            );
        }
    }
}

// --- Account lifecycle -------------------------------------------------------------

/// Enumerate connected accounts from the non-secret DB index (no keychain
/// access, so listing never prompts).
pub async fn list_accounts(app: &tauri::AppHandle) -> Result<Vec<ConnectorAccount>, AppError> {
    let repos = crate::commands::repositories(app).await?;
    let records = repos.list_connector_accounts().await?;
    Ok(records
        .into_iter()
        .filter_map(|record| {
            let provider = ConnectorProvider::from_db(&record.provider)?;
            Some(ConnectorAccount {
                account_id: record.account_id,
                provider,
                display_name: record.email.clone(),
                email: (provider == ConnectorProvider::Google).then_some(record.email),
                scopes: record.scopes,
                status: ConnectorAccountStatus::from_db(&record.status),
            })
        })
        .collect())
}

/// The email of an already-stored account that differs from the one being
/// connected, if any. Local mode is single-account (every connector surface
/// resolves the one connected account), so a second, distinct account is
/// refused to avoid a cross-account read/write mix-up. Comparison is
/// case-insensitive, so reconnecting or adding scope to the same email returns
/// `None` and is allowed.
fn conflicting_existing_account<'a>(
    existing_emails: impl IntoIterator<Item = &'a str>,
    connecting: &str,
) -> Option<String> {
    existing_emails
        .into_iter()
        .find(|email| !email.eq_ignore_ascii_case(connecting))
        .map(str::to_string)
}

/// Run the full connect flow (browser consent, loopback callback, code
/// exchange, custody write, DB index upsert) for the requested scope
/// bundles. With a `login_hint` for an already-connected account whose
/// granted scopes already cover the request, no browser round-trip happens
/// (incremental auth short-circuit).
pub async fn begin_connect(
    app: &tauri::AppHandle,
    flow: &ConnectFlow,
    provider: ConnectorProvider,
    bundles: &[scopes::ScopeBundle],
    expected_account_id: Option<&str>,
) -> Result<ConnectorAccount, AppError> {
    match provider {
        ConnectorProvider::Google => {
            begin_google_connect(app, flow, bundles, expected_account_id).await
        }
        ConnectorProvider::Notion => begin_notion_connect(app, flow, expected_account_id).await,
        ConnectorProvider::Linear => begin_linear_connect(app, flow, expected_account_id).await,
    }
}

async fn begin_google_connect(
    app: &tauri::AppHandle,
    flow: &ConnectFlow,
    bundles: &[scopes::ScopeBundle],
    login_hint: Option<&str>,
) -> Result<ConnectorAccount, AppError> {
    let client = require_oauth_client()?;
    let repos = crate::commands::repositories(app).await?;

    // Escalation short-circuit: an existing, healthy account that already
    // holds every wanted scope needs no new consent.
    if let Some(hint) = login_hint.map(str::trim).filter(|hint| !hint.is_empty()) {
        let hint_lower = hint.to_ascii_lowercase();
        if let Some(record) = repos.get_connector_account(&hint_lower).await? {
            let already_granted = scopes::missing_scopes(&record.scopes, bundles).is_empty();
            if already_granted && record.status == ConnectorAccountStatus::Connected.as_str() {
                return Ok(ConnectorAccount {
                    account_id: record.account_id,
                    provider: ConnectorProvider::Google,
                    display_name: record.email.clone(),
                    email: Some(record.email),
                    scopes: record.scopes,
                    status: ConnectorAccountStatus::Connected,
                });
            }
        }
    }

    let requested = scopes::requested_scopes(bundles);
    let grant = oauth::authorize(
        flow,
        &client.client_id,
        &client.client_secret,
        &requested,
        login_hint,
    )
    .await?;
    let email = grant.email.clone();

    // A login hint means the user asked to (re)connect one specific account.
    // Google only preselects it; the browser can still consent as a different
    // account. Abort on mismatch rather than silently storing the wrong account
    // (which would leave the intended account still flagged reconnect_required).
    if let Some(hint) = login_hint.map(str::trim).filter(|hint| !hint.is_empty()) {
        if !email.eq_ignore_ascii_case(hint) {
            return Err(AppError::new(
                "connector_account_mismatch",
                "That Google account does not match the one you were reconnecting. Try again and choose that account.",
            ));
        }
    }

    // Local mode v1 binds every connector surface to a single account: the base
    // Gmail/Calendar MCP servers, the per-job autonomy servers, and every
    // trigger all independently resolve "the connected account" (the first
    // connected row). A second, distinct account would let a routine created
    // against account B silently read or mutate account A's mail and calendar,
    // a cross-account privacy leak. Refuse a different account while one is
    // already stored; reconnecting or adding scope to the same email still
    // passes (the email matches). Multi-account routing is a documented
    // follow-up. Checked after auth because the account identity is only known
    // once Google returns it; the settings UI also hides "add another" so this
    // guard is the safety net, not the primary path.
    let existing_accounts = repos.list_connector_accounts().await?;
    if let Some(existing_email) = conflicting_existing_account(
        existing_accounts
            .iter()
            .filter(|record| record.provider == ConnectorProvider::Google.as_str())
            .map(|record| record.email.as_str()),
        &email,
    ) {
        return Err(AppError::new(
            "connector_single_account_only",
            format!(
                "June local mode uses one Google account at a time. Disconnect {existing_email} before connecting another."
            ),
        ));
    }

    // Persist the account's scopes. When Google omits the response scope field
    // on an incremental grant, this unions the requested scopes with the ones
    // the account already held, so add-access never makes the DB forget earlier
    // grants the token still carries.
    let existing_scopes = existing_accounts
        .iter()
        .find(|record| record.email.eq_ignore_ascii_case(&email))
        .map(|record| record.scopes.as_slice());
    let granted_scopes =
        scopes::resolve_granted_scopes(grant.tokens.scope.as_deref(), &requested, existing_scopes);

    // Scope escalation on an existing grant can omit the refresh token; keep
    // the one already in custody then.
    let refresh_token = match grant
        .tokens
        .refresh_token
        .as_deref()
        .filter(|token| !token.is_empty())
    {
        Some(token) => token.to_string(),
        None => store::load_tokens(&email)
            .await?
            .map(|existing| existing.refresh_token.clone())
            .ok_or_else(|| {
                AppError::new(
                    "connector_missing_refresh_token",
                    "Google did not return a refresh token. Remove June's access at myaccount.google.com/permissions and connect again.",
                )
            })?,
    };

    let tokens = store::StoredConnectorTokens {
        access_token: grant.tokens.access_token.clone(),
        refresh_token,
        expires_at_unix: now_unix() + grant.tokens.expires_in.max(0),
        scopes: granted_scopes.clone(),
        email: email.clone(),
    };
    store::store_tokens(&tokens).await?;

    repos
        .upsert_connector_account(
            &email,
            ConnectorProvider::Google.as_str(),
            &email,
            &granted_scopes,
            ConnectorAccountStatus::Connected.as_str(),
        )
        .await?;
    emit_connectors_changed(app);

    Ok(ConnectorAccount {
        account_id: email.clone(),
        provider: ConnectorProvider::Google,
        display_name: email.clone(),
        email: Some(email),
        scopes: granted_scopes,
        status: ConnectorAccountStatus::Connected,
    })
}

async fn begin_notion_connect(
    app: &tauri::AppHandle,
    flow: &ConnectFlow,
    expected_account_id: Option<&str>,
) -> Result<ConnectorAccount, AppError> {
    let client = require_provider_oauth_client(ConnectorProvider::Notion)?;
    let grant = notion::authorize(
        flow,
        &client.client_id,
        &client.client_secret,
        &client.redirect_uri,
    )
    .await?;
    let account_id = format!("notion:{}", grant.workspace_id);
    ensure_expected_account(ConnectorProvider::Notion, expected_account_id, &account_id)?;
    ensure_single_provider_account(app, ConnectorProvider::Notion, &account_id).await?;
    let scopes = vec!["content:read".to_string(), "content:insert".to_string()];
    let refresh_token = grant.tokens.refresh_token.clone().unwrap_or_default();
    let stored = store::StoredConnectorTokens {
        access_token: grant.tokens.access_token.clone(),
        refresh_token,
        expires_at_unix: i64::MAX,
        scopes: scopes.clone(),
        email: account_id.clone(),
    };
    store::store_tokens(&stored).await?;
    let repos = crate::commands::repositories(app).await?;
    repos
        .upsert_connector_account(
            &account_id,
            ConnectorProvider::Notion.as_str(),
            &grant.display_name,
            &scopes,
            ConnectorAccountStatus::Connected.as_str(),
        )
        .await?;
    emit_connectors_changed(app);
    Ok(ConnectorAccount {
        account_id,
        provider: ConnectorProvider::Notion,
        display_name: grant.display_name,
        email: grant.email,
        scopes,
        status: ConnectorAccountStatus::Connected,
    })
}

async fn begin_linear_connect(
    app: &tauri::AppHandle,
    flow: &ConnectFlow,
    expected_account_id: Option<&str>,
) -> Result<ConnectorAccount, AppError> {
    let client = require_provider_oauth_client(ConnectorProvider::Linear)?;
    let grant = linear::authorize(
        flow,
        &client.client_id,
        &client.client_secret,
        &client.redirect_uri,
    )
    .await?;
    let account_id = format!("linear:{}", grant.organization_id);
    ensure_expected_account(ConnectorProvider::Linear, expected_account_id, &account_id)?;
    ensure_single_provider_account(app, ConnectorProvider::Linear, &account_id).await?;
    let scopes = linear::granted_scopes(&grant.tokens.scope);
    let stored = store::StoredConnectorTokens {
        access_token: grant.tokens.access_token.clone(),
        refresh_token: grant.tokens.refresh_token.clone().unwrap_or_default(),
        expires_at_unix: now_unix() + grant.tokens.expires_in.max(0),
        scopes: scopes.clone(),
        email: account_id.clone(),
    };
    store::store_tokens(&stored).await?;
    let repos = crate::commands::repositories(app).await?;
    repos
        .upsert_connector_account(
            &account_id,
            ConnectorProvider::Linear.as_str(),
            &grant.organization_name,
            &scopes,
            ConnectorAccountStatus::Connected.as_str(),
        )
        .await?;
    emit_connectors_changed(app);
    Ok(ConnectorAccount {
        account_id,
        provider: ConnectorProvider::Linear,
        display_name: grant.organization_name,
        email: grant.email,
        scopes,
        status: ConnectorAccountStatus::Connected,
    })
}

fn ensure_expected_account(
    provider: ConnectorProvider,
    expected: Option<&str>,
    connected: &str,
) -> Result<(), AppError> {
    if expected.is_some_and(|expected| expected != connected) {
        return Err(AppError::new(
            "connector_account_mismatch",
            format!(
                "That {} workspace does not match the one you were reconnecting.",
                provider.display_name()
            ),
        ));
    }
    Ok(())
}

async fn ensure_single_provider_account(
    app: &tauri::AppHandle,
    provider: ConnectorProvider,
    connecting: &str,
) -> Result<(), AppError> {
    let repos = crate::commands::repositories(app).await?;
    if let Some(existing) = repos
        .list_connector_accounts()
        .await?
        .into_iter()
        .find(|record| record.provider == provider.as_str() && record.account_id != connecting)
    {
        return Err(AppError::new(
            "connector_single_account_only",
            format!(
                "June local mode uses one {} workspace at a time. Disconnect {} before connecting another.",
                provider.display_name(),
                existing.email
            ),
        ));
    }
    Ok(())
}

/// Abort an in-flight connect (drains the browser-handoff wait).
pub fn cancel_connect(flow: &ConnectFlow) {
    flow.cancel();
}

/// Disconnect an account: optionally revoke the provider grant (best-effort),
/// always remove local custody, and drop the account from the DB index along
/// with its triggers and cursors.
pub async fn disconnect(
    app: &tauri::AppHandle,
    account_id: &str,
    revoke_grant: bool,
) -> Result<(), AppError> {
    let repos = crate::commands::repositories(app).await?;
    let provider = repos
        .get_connector_account(account_id)
        .await?
        .and_then(|record| ConnectorProvider::from_db(&record.provider))
        .unwrap_or(ConnectorProvider::Google);
    if revoke_grant {
        if let Ok(Some(stored)) = store::load_tokens(account_id).await {
            // Revoking either token of the pair invalidates the whole grant;
            // prefer the refresh token.
            let token = if stored.refresh_token.is_empty() {
                stored.access_token.clone()
            } else {
                stored.refresh_token.clone()
            };
            if !token.is_empty() {
                match provider {
                    ConnectorProvider::Google => {
                        let _ = oauth::revoke(&token).await;
                    }
                    ConnectorProvider::Notion => {
                        if let Ok(client) = require_provider_oauth_client(provider) {
                            let _ =
                                notion::revoke(&client.client_id, &client.client_secret, &token)
                                    .await;
                        }
                    }
                    ConnectorProvider::Linear => {
                        let _ = linear::revoke(&token).await;
                    }
                }
            }
        }
    }
    store::delete_tokens(account_id).await?;
    repos.delete_connector_account(account_id).await?;
    emit_connectors_changed(app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_and_status_serialize_snake_case() {
        assert_eq!(
            serde_json::to_string(&ConnectorProvider::Google).unwrap(),
            "\"google\""
        );
        assert_eq!(
            serde_json::to_string(&ConnectorProvider::Notion).unwrap(),
            "\"notion\""
        );
        assert_eq!(
            serde_json::to_string(&ConnectorProvider::Linear).unwrap(),
            "\"linear\""
        );
        assert_eq!(
            serde_json::to_string(&ConnectorAccountStatus::ReconnectRequired).unwrap(),
            "\"reconnect_required\""
        );
        assert_eq!(
            serde_json::from_str::<ConnectorAccountStatus>("\"connected\"").unwrap(),
            ConnectorAccountStatus::Connected
        );
    }

    #[test]
    fn account_serializes_camel_case_for_the_frontend() {
        let account = ConnectorAccount {
            account_id: "user@example.com".to_string(),
            provider: ConnectorProvider::Google,
            display_name: "user@example.com".to_string(),
            email: Some("user@example.com".to_string()),
            scopes: vec!["openid".to_string()],
            status: ConnectorAccountStatus::Connected,
        };
        let json = serde_json::to_value(&account).unwrap();
        assert_eq!(json["accountId"], "user@example.com");
        assert_eq!(json["displayName"], "user@example.com");
        assert_eq!(json["provider"], "google");
        assert_eq!(json["status"], "connected");
    }

    #[test]
    fn freshness_uses_expiry_buffer() {
        let now = 1_000_000;
        assert!(access_token_is_fresh(now + 61, now));
        assert!(!access_token_is_fresh(now + 60, now));
        assert!(!access_token_is_fresh(now - 1, now));
    }

    #[test]
    fn status_from_db_defaults_to_connected() {
        assert_eq!(
            ConnectorAccountStatus::from_db("reconnect_required"),
            ConnectorAccountStatus::ReconnectRequired
        );
        assert_eq!(
            ConnectorAccountStatus::from_db("connected"),
            ConnectorAccountStatus::Connected
        );
        assert_eq!(
            ConnectorAccountStatus::from_db("unexpected"),
            ConnectorAccountStatus::Connected
        );
    }

    #[test]
    fn single_account_guard_blocks_a_different_account_only() {
        // First-ever connect: nothing stored, nothing conflicts.
        assert_eq!(conflicting_existing_account([], "a@example.com"), None);
        // Reconnect or scope-add on the same account (any casing) is allowed.
        assert_eq!(
            conflicting_existing_account(["a@example.com"], "A@Example.com"),
            None
        );
        // A second, distinct account is refused, naming the stored one.
        assert_eq!(
            conflicting_existing_account(["a@example.com"], "b@example.com"),
            Some("a@example.com".to_string())
        );
        // The stored account is reported even when the new one is also present
        // in the list (defensive: only the differing email matters).
        assert_eq!(
            conflicting_existing_account(["a@example.com", "b@example.com"], "b@example.com"),
            Some("a@example.com".to_string())
        );
    }
}
