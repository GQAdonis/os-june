use crate::{
    auth::authenticated_user, envelope::ApiResponse, error::ApiError, state::ApiState, validation,
};
use axum::{Json, extract::State, http::HeaderMap};
use june_domain::{DomainError, GeneratedImage, ImageGenerationRequest, ModelId};
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

/// Generates an image from a text prompt via Venice. Authenticated like every
/// other endpoint, but NOT metered: subscription metering is an explicit
/// follow-up, so there is no authorize/charge flow here yet.
pub(crate) async fn generate(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<ImageGenerateRequest>,
) -> Result<Json<ApiResponse<ImageGenerateResponse>>, ApiError> {
    // Enforce auth (a valid OS Accounts token) even though we don't meter yet —
    // the endpoint must never be open to anonymous callers.
    authenticated_user(&state, &headers).await?;

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

    let generated = state
        .image_generator()
        .generate(ImageGenerationRequest {
            prompt,
            model: ModelId(model),
            width,
            height,
        })
        .await
        .map_err(map_image_error)?;

    Ok(Json(ApiResponse::ok(generated.into())))
}

fn validate_dimension(field: &str, value: Option<u32>) -> Result<Option<u32>, ApiError> {
    match value {
        Some(value) if !(MIN_IMAGE_DIMENSION..=MAX_IMAGE_DIMENSION).contains(&value) => {
            Err(ApiError::bad_request(format!("{field}_out_of_range")))
        }
        other => Ok(other),
    }
}

/// Direct `DomainError -> ApiError` mapping (image generation never goes
/// through `ServiceError`). Exhaustive so a new `DomainError` variant forces a
/// deliberate mapping instead of silently collapsing into an upstream failure.
fn map_image_error(error: DomainError) -> ApiError {
    match error {
        DomainError::InvalidInput { reason } => ApiError::bad_request(reason),
        DomainError::MeteringProvider => ApiError::Metering,
        DomainError::UpstreamProvider
        | DomainError::ModelNotPriced
        | DomainError::InsufficientCredits => ApiError::Upstream,
    }
}
