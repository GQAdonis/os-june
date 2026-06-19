use crate::{
    charge_flow::{
        AuthorizeParams, ChargeParams, authorize_or_deny, charge, clamp_to_cap, log_settled,
    },
    error::ServiceError,
    pricing::PricingTable,
};
use scribe_domain::{
    ActionSlug, AgentChatCompleter, AgentChatCompletion, AgentChatRequest, Credits, ModelId,
    ModelKind, OsAccountsClient, Receipt, UserId,
};
use sha2::{Digest, Sha256};
use std::sync::Arc;

pub struct AgentChatServiceDeps {
    pub pricing: Arc<PricingTable>,
    pub os_accounts: Arc<dyn OsAccountsClient>,
    pub guarded_chat_completer: Arc<dyn AgentChatCompleter>,
    pub direct_chat_completer: Arc<dyn AgentChatCompleter>,
    pub hold_ttl_seconds: u64,
    pub flat_estimate_credits: u64,
}

pub struct AgentChatService {
    pricing: Arc<PricingTable>,
    os_accounts: Arc<dyn OsAccountsClient>,
    guarded_chat_completer: Arc<dyn AgentChatCompleter>,
    direct_chat_completer: Arc<dyn AgentChatCompleter>,
    hold_ttl_seconds: u64,
    flat_estimate_credits: u64,
}

impl AgentChatService {
    pub fn new(deps: AgentChatServiceDeps) -> Self {
        Self {
            pricing: deps.pricing,
            os_accounts: deps.os_accounts,
            guarded_chat_completer: deps.guarded_chat_completer,
            direct_chat_completer: deps.direct_chat_completer,
            hold_ttl_seconds: deps.hold_ttl_seconds,
            flat_estimate_credits: deps.flat_estimate_credits,
        }
    }

    pub async fn complete(&self, params: AgentChatParams) -> Result<AgentChatOutput, ServiceError> {
        self.pricing
            .ensure_model_kind(&params.model_id.0, ModelKind::Text)?;
        let estimate = Credits(self.flat_estimate_credits);
        let authorization = authorize_or_deny(AuthorizeParams {
            os_accounts: self.os_accounts.as_ref(),
            user_id: params.user_id.clone(),
            action: ActionSlug::AgentChat,
            estimate,
            hold_ttl_seconds: self.hold_ttl_seconds,
        })
        .await?;
        let body_digest = body_digest(&params.body);
        let completion = self
            .chat_completer(params.route)
            .complete(AgentChatRequest {
                body: params.body,
                model: params.model_id.clone(),
            })
            .await?;
        let actual = self
            .pricing
            .price_token_usage(&params.model_id.0, completion.usage)?;
        let charge_credits = clamp_to_cap(actual, authorization.cap_credits);
        let receipt = charge(ChargeParams {
            os_accounts: self.os_accounts.as_ref(),
            action_token: authorization.action_token,
            credits: charge_credits,
            idempotency_key: format!(
                "agent_chat:{}:{}:{}",
                params.user_id.0, params.model_id.0, body_digest
            ),
        })
        .await?;
        log_settled(
            ActionSlug::AgentChat,
            &params.user_id,
            &params.model_id.0,
            &receipt,
        );
        Ok(AgentChatOutput {
            completion,
            receipt,
        })
    }

    /// Streaming counterpart of `complete`: holds credits up front, drains the
    /// provider response on a background task, mirrors chunks to the caller,
    /// and settles billing once the provider stream completes. Billing depends
    /// on the upstream EOF, not on whether the client keeps reading.
    pub async fn complete_streaming(
        &self,
        params: AgentChatParams,
    ) -> Result<AgentChatStreamOutput, ServiceError> {
        self.pricing
            .ensure_model_kind(&params.model_id.0, ModelKind::Text)?;
        let estimate = Credits(self.flat_estimate_credits);
        let authorization = authorize_or_deny(AuthorizeParams {
            os_accounts: self.os_accounts.as_ref(),
            user_id: params.user_id.clone(),
            action: ActionSlug::AgentChat,
            estimate,
            hold_ttl_seconds: self.hold_ttl_seconds,
        })
        .await?;
        let body_digest = body_digest(&params.body);
        let stream = self
            .chat_completer(params.route)
            .complete_streaming(AgentChatRequest {
                body: params.body,
                model: params.model_id.clone(),
            })
            .await?;

        let os_accounts = self.os_accounts.clone();
        let pricing = self.pricing.clone();
        let user_id = params.user_id.clone();
        let model_id = params.model_id.clone();
        let action_token = authorization.action_token;
        let cap_credits = authorization.cap_credits;
        let usage_handle = stream.usage.clone();
        let content_type = stream.content_type.clone();
        let upstream = stream.body;
        let (downstream_tx, mut downstream_rx) = tokio::sync::mpsc::unbounded_channel::<
            Result<bytes::Bytes, scribe_domain::DomainError>,
        >();

        tokio::spawn(async move {
            use futures_util::StreamExt;
            futures_util::pin_mut!(upstream);
            let mut downstream_open = true;
            while let Some(item) = upstream.next().await {
                match item {
                    Ok(chunk) => {
                        if downstream_open && downstream_tx.send(Ok(chunk)).is_err() {
                            downstream_open = false;
                        }
                    }
                    Err(error) => {
                        if downstream_open {
                            let _ = downstream_tx.send(Err(error));
                        }
                        return;
                    }
                }
            }
            // Provider stream fully drained: settle from the captured usage frame
            // even if the downstream client disconnected before reading EOF.
            let usage = usage_handle.lock().ok().and_then(|mut guard| guard.take());
            let Some(usage) = usage else {
                tracing::warn!(
                    user_id = %user_id.0,
                    model = %model_id.0,
                    "agent chat: no usage captured from stream; not charging (hold expires)"
                );
                return;
            };
            let actual = match pricing.price_token_usage(&model_id.0, usage) {
                Ok(actual) => actual,
                Err(error) => {
                    tracing::error!(%error, model = %model_id.0, "agent chat: post-stream pricing failed; not charging");
                    return;
                }
            };
            let charge_credits = clamp_to_cap(actual, cap_credits);
            let idempotency_key =
                format!("agent_chat:{}:{}:{}", user_id.0, model_id.0, body_digest);
            match charge(ChargeParams {
                os_accounts: os_accounts.as_ref(),
                action_token,
                credits: charge_credits,
                idempotency_key,
            })
            .await
            {
                Ok(receipt) => log_settled(ActionSlug::AgentChat, &user_id, &model_id.0, &receipt),
                Err(error) => tracing::error!(
                    %error,
                    user_id = %user_id.0,
                    "agent chat: post-stream charge failed; hold will expire"
                ),
            }
        });

        let body = async_stream::stream! {
            while let Some(item) = downstream_rx.recv().await {
                yield item;
            }
        };

        Ok(AgentChatStreamOutput {
            content_type,
            body: Box::pin(body),
        })
    }

    fn chat_completer(&self, route: AgentChatRoute) -> &dyn AgentChatCompleter {
        match route {
            AgentChatRoute::Guarded => self.guarded_chat_completer.as_ref(),
            AgentChatRoute::Direct => self.direct_chat_completer.as_ref(),
        }
    }
}

/// A streamed agent-chat response: the content type plus the body stream
/// mirrored from a provider-draining background task.
pub struct AgentChatStreamOutput {
    pub content_type: String,
    pub body: std::pin::Pin<
        Box<
            dyn futures_util::Stream<Item = Result<bytes::Bytes, scribe_domain::DomainError>>
                + Send,
        >,
    >,
}

#[derive(Clone, Debug)]
pub struct AgentChatParams {
    pub user_id: UserId,
    pub model_id: ModelId,
    pub body: serde_json::Value,
    pub route: AgentChatRoute,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgentChatRoute {
    Guarded,
    Direct,
}

#[derive(Clone, Debug)]
pub struct AgentChatOutput {
    pub completion: AgentChatCompletion,
    pub receipt: Receipt,
}

fn body_digest(body: &serde_json::Value) -> String {
    let digest = Sha256::digest(body.to_string().as_bytes());
    hex_lower(&digest)
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::body_digest;
    use pretty_assertions::assert_eq;
    use serde_json::json;

    #[test]
    fn body_digest_is_stable_full_sha256_hex() {
        let body = json!({
            "model": "text-model",
            "messages": [{ "role": "user", "content": "hello" }],
        });

        let digest = body_digest(&body);

        assert_eq!(
            digest,
            "8791c5ca4cef8d9ea68549494f84e20e5f8224958d7b7aebc484dedb7b48e4ce"
        );
        assert_eq!(digest.len(), 64);
        assert!(digest.chars().all(|ch| ch.is_ascii_hexdigit()));
    }
}
