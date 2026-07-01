use crate::{
    auth::authenticated_user, envelope::ApiResponse, error::ApiError, state::ApiState, validation,
};
use axum::{Json, extract::State, http::HeaderMap};
use june_domain::GeneratedImage;
use june_services::ImageGenerateParams;
use serde::{Deserialize, Serialize};

/// Largest and smallest image dimension Venice accepts (pixel-based models).
const MIN_IMAGE_DIMENSION: u32 = 1;
const MAX_IMAGE_DIMENSION: u32 = 1280;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageGenerateRequest {
    pub prompt: String,
    pub model: String,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    /// Optional client idempotency id reused across retries so a dropped-response
    /// retry is not double-charged. Empty means the server sequences each call as
    /// a distinct charge.
    #[serde(default)]
    pub request_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageGenerateResponse {
    pub image_base64: String,
    pub mime_type: String,
    pub model: String,
    pub provider: String,
}

impl From<GeneratedImage> for ImageGenerateResponse {
    fn from(value: GeneratedImage) -> Self {
        Self {
            image_base64: value.image_base64,
            mime_type: value.mime_type,
            model: value.model,
            provider: value.provider,
        }
    }
}

/// Generates an image from a text prompt via Venice. Metered: the service holds
/// a wallet estimate, generates, then charges the model's flat per-image price
/// (see `ImageService`). An unpriced model is rejected `model_not_priced`; an
/// out-of-credits user gets 402 before Venice is called.
pub(crate) async fn generate(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<ImageGenerateRequest>,
) -> Result<Json<ApiResponse<ImageGenerateResponse>>, ApiError> {
    let user_id = authenticated_user(&state, &headers).await?;

    let prompt = request.prompt.trim().to_string();
    if prompt.is_empty() {
        return Err(ApiError::bad_request("prompt_required"));
    }
    validation::validate_text_len("prompt", &prompt, validation::MAX_IMAGE_PROMPT_CHARS)?;

    let model = request.model.trim().to_string();
    if model.is_empty() {
        return Err(ApiError::bad_request("model_required"));
    }
    validation::validate_text_len("model", &model, validation::MAX_MODEL_CHARS)?;

    let width = validate_dimension("width", request.width)?;
    let height = validate_dimension("height", request.height)?;

    let output = state
        .image()
        .generate(ImageGenerateParams {
            user_id,
            request_id: request.request_id,
            prompt,
            model,
            width,
            height,
        })
        .await?;

    Ok(Json(ApiResponse::ok(output.image.into())))
}

fn validate_dimension(field: &str, value: Option<u32>) -> Result<Option<u32>, ApiError> {
    match value {
        Some(value) if !(MIN_IMAGE_DIMENSION..=MAX_IMAGE_DIMENSION).contains(&value) => {
            Err(ApiError::bad_request(format!("{field}_out_of_range")))
        }
        other => Ok(other),
    }
}
