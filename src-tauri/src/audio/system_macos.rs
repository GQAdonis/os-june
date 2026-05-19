use crate::domain::types::{AppError, AudioLevelDto, RecordingSource, SourceReadinessDto};
use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

#[derive(Debug, Clone, Default)]
pub struct SystemAudioStats {
    pub level: AudioLevelDto,
    pub last_error: Option<String>,
}

pub struct SystemAudioCapture {
    pid: u32,
    stats: Arc<Mutex<SystemAudioStats>>,
    partial_path: PathBuf,
    final_path: PathBuf,
    status_path: PathBuf,
    pid_path: PathBuf,
}

impl SystemAudioCapture {
    pub fn start(partial_path: PathBuf, final_path: PathBuf) -> Result<Self, AppError> {
        let helper_app = helper_app_path();
        if !helper_app.exists() {
            return Err(AppError::new(
                "system_audio_unavailable",
                "System audio helper is not built. Run pnpm tauri:dev again.",
            ));
        }
        let status_path = partial_path.with_extension("status.json");
        let pid_path = partial_path.with_extension("pid");
        let _ = std::fs::remove_file(&status_path);
        let _ = std::fs::remove_file(&pid_path);
        Command::new("/usr/bin/open")
            .arg("-n")
            .arg(&helper_app)
            .arg("--args")
            .arg("--output")
            .arg(&partial_path)
            .arg("--status")
            .arg(&status_path)
            .arg("--pid")
            .arg(&pid_path)
            .status()
            .map_err(|error| AppError::new("system_audio_unavailable", error.to_string()))?;

        let stats = Arc::new(Mutex::new(SystemAudioStats::default()));
        let ready = wait_for_status(&status_path, Duration::from_secs(8))?;
        if ready.event == "error" {
            return Err(AppError::new(
                "system_audio_permission_denied",
                ready
                    .message
                    .unwrap_or_else(|| "System audio capture failed.".to_string()),
            ));
        }
        let pid = read_pid(&pid_path).ok_or_else(|| {
            AppError::new(
                "system_audio_unavailable",
                "System audio helper PID was not written.",
            )
        })?;
        Ok(Self {
            pid,
            stats,
            partial_path,
            final_path,
            status_path,
            pid_path,
        })
    }

    pub fn pause(&mut self) {
        send_signal(self.pid, "-USR1");
    }

    pub fn resume(&mut self) {
        send_signal(self.pid, "-USR2");
    }

    pub fn status(&self) -> (AudioLevelDto, i64, Option<String>) {
        if let Ok(status) = read_status(&self.status_path) {
            if let Ok(mut stats) = self.stats.lock() {
                if let Some(level) = status.level {
                    stats.level = AudioLevelDto {
                        peak: level,
                        rms: level,
                        recent_peaks: vec![level],
                    };
                }
                if status.event == "error" {
                    stats.last_error = Some(
                        status
                            .message
                            .unwrap_or_else(|| "System audio capture failed.".to_string()),
                    );
                } else if status.message.is_some() {
                    stats.last_error = status.message;
                }
            }
        }
        let (level, error) = self
            .stats
            .lock()
            .map(|stats| (stats.level.clone(), stats.last_error.clone()))
            .unwrap_or_default();
        let bytes = std::fs::metadata(&self.partial_path)
            .or_else(|_| std::fs::metadata(&self.final_path))
            .map(|metadata| metadata.len() as i64)
            .unwrap_or_default();
        (level, bytes, error)
    }

    pub fn stop(self) -> Result<PathBuf, AppError> {
        send_signal(self.pid, "-TERM");
        if wait_for_stopped(&self.status_path, Duration::from_secs(5)).is_err() {
            send_signal(self.pid, "-KILL");
            std::thread::sleep(Duration::from_millis(100));
        }
        if self.partial_path.exists() {
            std::fs::rename(&self.partial_path, &self.final_path)
                .map_err(|error| AppError::new("audio_finalization_failed", error.to_string()))?;
        }
        let _ = std::fs::remove_file(&self.status_path);
        let _ = std::fs::remove_file(&self.pid_path);
        Ok(self.final_path)
    }
}

pub fn system_audio_readiness() -> SourceReadinessDto {
    #[cfg(target_os = "macos")]
    {
        let capture_available = macos_version_supports_system_audio() && helper_app_path().exists();
        return SourceReadinessDto {
            source: RecordingSource::System,
            required: true,
            ready: capture_available,
            permission_state: if capture_available {
                "unknown".to_string()
            } else {
                "unsupported".to_string()
            },
            device_available: capture_available,
            capture_available,
            recovery_action: if capture_available {
                Some("openSystemAudioSettings".to_string())
            } else {
                Some("upgradeMacos".to_string())
            },
            message: if capture_available {
                None
            } else {
                Some(
                    "System audio capture requires macOS 14.2 or later and a built capture helper."
                        .to_string(),
                )
            },
        };
    }
    #[cfg(not(target_os = "macos"))]
    {
        SourceReadinessDto {
            source: RecordingSource::System,
            required: true,
            ready: false,
            permission_state: "unsupported".to_string(),
            device_available: false,
            capture_available: false,
            recovery_action: None,
            message: Some("System audio capture is only supported on macOS.".to_string()),
        }
    }
}

pub fn helper_permission_check() -> Result<(), AppError> {
    let helper_app = helper_app_path();
    if !helper_app.exists() {
        return Err(AppError::new(
            "system_audio_unavailable",
            "System audio helper is not built. Run pnpm tauri:dev again.",
        ));
    }
    let temp =
        std::env::temp_dir().join(format!("os-notetaker-audio-check-{}", uuid::Uuid::new_v4()));
    let status_path = temp.with_extension("json");
    let pid_path = temp.with_extension("pid");
    let output = Command::new("/usr/bin/open")
        .arg("-W")
        .arg("-n")
        .arg(helper_app)
        .arg("--args")
        .arg("--check")
        .arg("--status")
        .arg(&status_path)
        .arg("--pid")
        .arg(&pid_path)
        .output()
        .map_err(|error| AppError::new("system_audio_unavailable", error.to_string()))?;
    let status = read_status(&status_path).ok();
    let _ = std::fs::remove_file(&status_path);
    let _ = std::fs::remove_file(&pid_path);
    if output.status.success() {
        if let Some(status) = status {
            if status.event != "error" {
                return Ok(());
            }
            let message = status
                .message
                .unwrap_or_else(|| "System audio permission check failed.".to_string());
            return Err(AppError::new("system_audio_permission_denied", message));
        }
    }
    let message = "System audio permission check did not receive helper status.".to_string();
    Err(AppError::new("system_audio_permission_denied", message))
}

#[cfg(target_os = "macos")]
fn macos_version_supports_system_audio() -> bool {
    let output = std::process::Command::new("sw_vers")
        .arg("-productVersion")
        .output();
    let Ok(output) = output else {
        return false;
    };
    let version = String::from_utf8_lossy(&output.stdout);
    let mut parts = version
        .trim()
        .split('.')
        .filter_map(|part| part.parse::<u32>().ok());
    let major = parts.next().unwrap_or(0);
    let minor = parts.next().unwrap_or(0);
    major > 14 || (major == 14 && minor >= 2)
}

pub fn helper_app_path() -> PathBuf {
    let dev_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("native")
        .join("bin")
        .join("OS Notetaker Audio Capture.app");
    if dev_path.exists() {
        return dev_path;
    }
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(contents_dir) = current_exe
            .ancestors()
            .find(|path| path.file_name().and_then(|name| name.to_str()) == Some("Contents"))
        {
            let resource_path = contents_dir
                .join("Resources")
                .join("native")
                .join("bin")
                .join("OS Notetaker Audio Capture.app");
            if resource_path.exists() {
                return resource_path;
            }
        }
    }
    dev_path
}

fn send_signal(pid: u32, signal: &str) {
    let _ = Command::new("kill")
        .arg(signal)
        .arg(pid.to_string())
        .status();
}

#[derive(Debug)]
struct HelperStatus {
    event: String,
    level: Option<f32>,
    message: Option<String>,
}

fn wait_for_status(path: &Path, timeout: Duration) -> Result<HelperStatus, AppError> {
    let started = Instant::now();
    loop {
        if let Ok(status) = read_status(path) {
            if matches!(status.event.as_str(), "ready" | "error") {
                return Ok(status);
            }
        }
        if started.elapsed() >= timeout {
            return Err(AppError::new(
                "system_audio_unavailable",
                "System audio helper did not become ready.",
            ));
        }
        std::thread::sleep(Duration::from_millis(80));
    }
}

fn wait_for_stopped(path: &Path, timeout: Duration) -> Result<(), AppError> {
    let started = Instant::now();
    loop {
        if read_status(path)
            .map(|status| status.event == "stopped")
            .unwrap_or(false)
        {
            return Ok(());
        }
        if started.elapsed() >= timeout {
            return Err(AppError::new(
                "system_audio_unavailable",
                "System audio helper did not stop cleanly.",
            ));
        }
        std::thread::sleep(Duration::from_millis(80));
    }
}

fn read_status(path: &Path) -> Result<HelperStatus, std::io::Error> {
    let data = std::fs::read_to_string(path)?;
    let value = serde_json::from_str::<serde_json::Value>(&data)?;
    let event = value
        .get("event")
        .and_then(|event| event.as_str())
        .unwrap_or_default()
        .to_string();
    let level = value
        .get("level")
        .and_then(|level| level.as_str())
        .and_then(|level| level.parse::<f32>().ok());
    let message = value
        .get("message")
        .and_then(|message| message.as_str())
        .map(str::to_string);
    Ok(HelperStatus {
        event,
        level,
        message,
    })
}

fn read_pid(path: &Path) -> Option<u32> {
    std::fs::read_to_string(path).ok()?.trim().parse().ok()
}
