# Research: Tauri Notes MVP

## Decision: Tauri v2 with React, TypeScript, and Vite

**Rationale**: The MVP is macOS-first but should remain small, local, and simpler than the legacy Electron/Next app. Tauri v2 gives a native desktop shell, explicit frontend-to-backend command boundaries, and macOS bundle/signing configuration without carrying a full Electron runtime. React + TypeScript + Vite is enough for the required sidebar, notes list, editor, tabs, and recorder controls without needing SSR or a server-oriented framework.

**Alternatives considered**:
- Electron + Next.js: rejected because the legacy app already shows that this path encourages meetings, auth, providers, and web app complexity outside MVP scope.
- Native SwiftUI: attractive for macOS feel, but would require a larger rewrite of provider/storage/UI patterns and would not use the requested Tauri direction.
- Svelte/Solid: viable, but React is more likely to reuse local TypeScript testing and component knowledge from the legacy reference without porting its architecture.

## Decision: Liquid Glass-inspired UI polish, not native SwiftUI Liquid Glass dependency

**Rationale**: The app should feel modern and native on macOS, but the Tauri frontend runs in a webview and should not depend on SwiftUI-only `glassEffect` APIs for the MVP. The plan will treat Liquid Glass as a visual direction: restrained translucent surfaces, blur, subtle borders, vibrancy-like contrast, and polished interaction feedback for the sidebar, editor, and bottom recorder. This keeps the UI aligned with macOS while preserving Tauri architecture and recording reliability priorities.

**Alternatives considered**:
- Native SwiftUI Liquid Glass implementation: rejected for MVP because it would move the frontend away from the planned React/Tauri architecture.
- Heavy custom blur/glass everywhere: rejected because it risks readability, performance, and visual complexity.
- No glass treatment: rejected because the user wants a more fluid and polished macOS feel than the legacy app.

## Decision: Rust backend owns recording, validation, recovery, and provider orchestration

**Rationale**: Audio reliability is the top priority. A backend-controlled recording lifecycle can checkpoint start/pause/resume/done events, write to deterministic app-local paths, finalize files atomically, validate artifacts before network calls, and recover incomplete sessions on startup. The frontend remains responsible for display and commands, while Rust owns the failure-prone parts.

**Alternatives considered**:
- Browser `MediaRecorder` as the primary artifact writer: rejected as the sole capture strategy because chunk persistence, file finalization, exact duration validation, and crash recovery are weaker when the webview owns the recording artifact.
- Hybrid web capture plus backend save: possible fallback for early spikes, but final MVP should not depend on the webview as the system of record for audio.
- Porting legacy native system-audio helper: rejected because system audio and meeting capture are explicitly out of scope.

## Decision: Microphone-only audio saved as local WAV/PCM for MVP reliability

**Rationale**: WAV/PCM is larger than compressed formats but simpler to finalize, inspect, read, measure, and validate. For a local MVP, transparent validation is more important than storage efficiency. The app can derive duration from headers/samples, compute RMS/peak/silence windows, and send provider-compatible audio after validation.

**Alternatives considered**:
- WebM/Opus: compact but less direct for native macOS validation and provider compatibility.
- M4A/AAC: practical long-term, but introduces encoder/container details that are not needed for MVP validation.
- Raw PCM only: easy to analyze but inconvenient for playback and provider upload without wrapping metadata.

## Decision: SQLite metadata via backend `sqlx` plus file-backed audio artifacts

**Rationale**: Notes, folders, statuses, checkpoints, transcripts, generation results, retry history, and validation results are relational enough for SQLite. Audio should remain file-backed to avoid bloating the database and to preserve recoverable artifacts even when provider calls fail. The database records checksums, sizes, durations, and state transitions so recovery can reconcile metadata with files.

**Alternatives considered**:
- JSON files only: simpler initially, but harder to query reverse-chronological lists, folder membership, retry history, and 500-note responsiveness safely.
- Audio blobs in SQLite: rejected because large binary writes complicate backup, validation, streaming/playback, and crash recovery.
- Tauri SQL plugin from the frontend: rejected for MVP because storage writes should go through backend domain commands that also checkpoint recording and processing state.
- External cloud database/storage: out of scope for local-only MVP.

## Decision: Use `cpal` for microphone capture and `hound` for WAV validation

**Rationale**: The backend needs direct access to microphone samples, byte-write progress, waveform summaries, silence detection, and recoverable local files. `cpal` is the standard Rust cross-platform audio I/O crate and can support the macOS-first MVP without introducing system-audio capture. `hound` keeps WAV writing and readable-file validation straightforward.

**Alternatives considered**:
- Browser `MediaRecorder`: useful as a reference for web recording patterns, but not authoritative enough for crash recovery and backend validation.
- AVFoundation-specific Swift helper: possible if `cpal` cannot satisfy macOS behavior during implementation, but it adds bridging complexity and should be a fallback, not the initial plan.
- FFmpeg-based recording: rejected for MVP because bundling and process management would add avoidable complexity.

## Decision: Explicit recording sanity checks before transcription

**Rationale**: The feature specification requires the app to avoid considering a recording successful until audio is locally finalized and readable. The validation pipeline will check microphone permission state, elapsed recording time, file existence, non-zero size, readable WAV structure, actual audio duration, expected-vs-actual duration tolerance, sample-level non-silence evidence, and validation metadata persistence.

**Alternatives considered**:
- File exists plus non-zero bytes only: rejected as insufficient because silent or truncated recordings would still pass.
- Provider transcription as validation: rejected because network/provider success must be separate from local capture success.
- Requiring user playback before upload: rejected because it creates unnecessary friction and still does not provide machine-checkable guarantees.

## Decision: Recovery scan on startup reconciles sessions and artifacts

**Rationale**: The app must survive closure, crash, and network failure after recording starts. On launch, Rust scans recording sessions with `recording`, `validating`, `transcribing`, `generating`, `failed`, and `recoverable` states, checks whether partial/final files exist, updates statuses, and exposes recoverable notes to the UI. Finalized audio remains retryable independent of transcription/generation status.

**Alternatives considered**:
- Store only current in-memory recorder state: rejected because crash recovery is a core requirement.
- Delete incomplete files automatically: rejected because recoverability takes priority over cleanup.
- Retry all failed provider calls automatically on startup: rejected for MVP to avoid surprise network usage; surface retry actions instead.

## Decision: Tauri capabilities expose only the main window command surface

**Rationale**: Tauri v2 capabilities constrain webview access to commands and plugins. The main window should receive only the app commands needed for notes, folders, recorder state, provider retry, and limited path/media display. No shell access, broad filesystem access, or remote-origin capabilities are required for MVP.

**Alternatives considered**:
- Use broad default capabilities and frontend filesystem APIs: rejected because PC-003 requires explicit scoping.
- Multiple privileged windows: unnecessary for one-window MVP.
- Remote web content: rejected because the MVP is a bundled local app.

## Decision: macOS microphone permission and signing are first-class implementation tasks

**Rationale**: macOS requires an `NSMicrophoneUsageDescription` usage string for microphone access, and sandboxed/signed builds need the audio input entitlement. Tauri’s macOS bundle configuration supports Info.plist additions and entitlements files. Implementation must include a repeatable dev/build command and a debug path for inspecting permission state and recording failures.

**Alternatives considered**:
- Wait until release packaging to handle entitlements: rejected because permission and recording failures must be testable during MVP development.
- Assume browser prompt behavior is enough: rejected because native bundle metadata and signing affect macOS microphone access.

## Decision: Provider adapters are backend services with mock-first tests

**Rationale**: Transcription and generation are network-dependent and may use configurable remote providers. The MVP should separate local capture success from provider success, persist retry state, and include a mock provider for deterministic development/testing. The generated note must use only transcript and optional note context, preserve source language, and reject empty/malformed provider results.

**Alternatives considered**:
- Hard-code a single provider/model into UI code: rejected because credentials and network failures must remain backend-managed and retryable.
- Realtime transcription: rejected by scope.
- Generate notes from audio directly without transcript persistence: rejected because transcript review is required.

## Sources Consulted

- [Tauri v2 capabilities](https://v2.tauri.app/security/capabilities/)
- [Tauri v2 capability reference](https://v2.tauri.app/reference/acl/capability/)
- [Tauri Vite frontend guide](https://v2.tauri.app/start/frontend/vite/)
- [Tauri macOS application bundle](https://v2.tauri.app/distribute/macos-application-bundle/)
- [MDN MediaRecorder API](https://developer.mozilla.org/docs/Web/API/MediaRecorder)
- [Apple NSMicrophoneUsageDescription](https://developer.apple.com/documentation/bundleresources/information-property-list/nsmicrophoneusagedescription)
- [Apple Audio Input Entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.device.audio-input)
