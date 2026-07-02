pub mod capture;
pub mod live_preview;
pub mod recovery;
pub mod turns;
pub mod validation;
pub mod waveform;

// System-audio capture has a platform-specific backend. Each backend exposes the
// same public surface (`SystemAudioCapture`, `system_audio_readiness`,
// `helper_permission_check`) and is re-exported under the stable `system_macos`
// path that `audio::capture` and `commands` already import, so the consumers
// stay platform-agnostic and untouched. A parallel change adds a
// `system_windows` backend the same way; the arms below stay independent so the
// branches merge cleanly.
#[cfg(target_os = "macos")]
pub mod system_macos;

#[cfg(target_os = "linux")]
pub mod system_linux;
#[cfg(target_os = "linux")]
pub use system_linux as system_macos;

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub mod system_unsupported;
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub use system_unsupported as system_macos;
