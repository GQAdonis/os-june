//! Fallback system-audio backend for platforms without a dedicated
//! implementation. It mirrors the previous `#[cfg(not(target_os = "macos"))]`
//! behavior of `system_macos`: readiness reports the source as unsupported and
//! every capture entry point fails cleanly instead of panicking. Real backends
//! live in `system_macos` (macOS), `system_linux` (Linux) and, from a parallel
//! change, `system_windows` (Windows).

use crate::domain::types::{AppError, AudioLevelDto, RecordingSource, SourceReadinessDto};
use std::{path::PathBuf, time::Duration};

const UNSUPPORTED_MESSAGE: &str = "System audio capture is not supported on this platform.";

pub struct SystemAudioCapture {
    _private: (),
}

impl SystemAudioCapture {
    pub fn start(
        _partial_path: PathBuf,
        _final_path: PathBuf,
        _timeline_offset: Duration,
    ) -> Result<Self, AppError> {
        Err(AppError::new(
            "system_audio_capture_unavailable",
            UNSUPPORTED_MESSAGE,
        ))
    }

    pub fn pause(&mut self) {}

    pub fn resume(&mut self) {}

    pub fn status(&self) -> (AudioLevelDto, i64, Option<String>) {
        (AudioLevelDto::default(), 0, None)
    }

    pub fn stop(self) -> Result<PathBuf, AppError> {
        Err(AppError::new(
            "system_audio_capture_unavailable",
            UNSUPPORTED_MESSAGE,
        ))
    }
}

pub fn system_audio_readiness() -> SourceReadinessDto {
    SourceReadinessDto {
        source: RecordingSource::System,
        required: true,
        ready: false,
        permission_state: "unsupported".to_string(),
        device_available: false,
        capture_available: false,
        recovery_action: None,
        message: Some(UNSUPPORTED_MESSAGE.to_string()),
    }
}

pub fn helper_permission_check() -> Result<(), AppError> {
    Err(AppError::new(
        "system_audio_capture_unavailable",
        UNSUPPORTED_MESSAGE,
    ))
}
