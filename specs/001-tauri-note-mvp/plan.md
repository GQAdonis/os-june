# Implementation Plan: Tauri Notes MVP

**Branch**: `001-tauri-note-mvp` | **Date**: 2026-05-19 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-tauri-note-mvp/spec.md`

**Note**: This plan stops at Phase 2 planning. Implementation begins only after `/speckit-tasks` generates `tasks.md` and the user approves moving forward.

## Summary

Build a macOS-first Tauri v2 desktop MVP for local notes, folders, microphone-only voice capture, saved audio validation, batch transcription, and AI-generated note output. The frontend will be a simple React + TypeScript single-window app with the required sidebar/list/editor layout and a Liquid Glass-inspired macOS visual treatment. The Rust backend owns local persistence, recording session state, audio artifact lifecycle, validation, recovery scanning, and provider calls for transcription/generation so the webview receives only scoped commands and app data, not broad filesystem or shell access.

The MVP intentionally excludes legacy Electron/Next concepts: meetings, realtime transcription, system audio, calendar, billing, chat, auth, sharing, workspaces, and account state.

## Technical Context

**Language/Version**: Rust stable with Tauri v2 backend; TypeScript with React and Vite frontend. Rust minimum should satisfy current Tauri v2 requirements, with `>=1.77.2` as the planned lower bound.
**Primary Dependencies**: Tauri v2, Vite, React, TypeScript, `@tauri-apps/api`, scoped Tauri capabilities, SQLite via Rust `sqlx`, microphone capture via `cpal`, WAV writing/reading via `hound`, checksums via `sha2`, native macOS microphone permission/signing configuration, provider adapters for transcription and note generation.
**Storage**: Local SQLite database under the app data directory for folders, notes, processing records, checkpoints, transcripts, generation metadata, and audio artifact metadata. Audio files stored separately under app-local data, e.g. `recordings/{note_id}/{session_id}.wav` plus temporary `.partial` files during capture.
**Testing**: Rust `cargo test` for backend domain, storage, validation, and recovery logic; TypeScript unit tests for UI state reducers/components; Playwright or Tauri-compatible UI smoke tests where practical; manual macOS recording verification using the quickstart scenarios.
**Target Platform**: macOS first Tauri desktop application. Other desktop platforms are not MVP targets.
**Project Type**: Desktop app with local Rust backend and webview frontend.
**Performance Goals**: Recording UI updates feel immediate; notes list remains responsive with 500 local notes; 10,000-character transcript scrolls without blocking note editing; audio validation completes before remote processing begins; 20 consecutive 30-second spoken recordings produce readable saved audio.
**Constraints**: Microphone-only capture; no system audio; no realtime transcription; audio must be finalized and validated locally before transcription/generation; provider/network failures must not delete local audio; frontend permissions must be scoped through Tauri capabilities; no broad filesystem or shell access from the webview; Liquid Glass is a UI polish constraint for the React/Tauri frontend, not a dependency on native SwiftUI `glassEffect`, and must degrade cleanly where exact native glass is unavailable.
**Scale/Scope**: Single local user, one primary window, flat folder list, local-only MVP data, no sync/import/export/search/tags/settings surface unless required to run provider credentials in development.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

The project constitution currently contains placeholder principles only and defines no enforceable gates. This plan uses the feature specification as the controlling project guidance.

Pre-design gate status: PASS, with no active constitution constraints.

## Project Structure

### Documentation (this feature)

```text
specs/001-tauri-note-mvp/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── commands.md
│   └── ui.md
├── checklists/
│   └── requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
package.json
pnpm-lock.yaml
vite.config.ts
tsconfig.json
index.html

src/
├── app/
│   ├── App.tsx
│   ├── routes.ts
│   └── state/
├── components/
│   ├── sidebar/
│   ├── notes-list/
│   ├── note-editor/
│   └── recorder/
├── lib/
│   ├── tauri.ts
│   ├── format.ts
│   └── validation.ts
├── styles/
│   └── app.css
└── test/

src-tauri/
├── Cargo.toml
├── tauri.conf.json
├── Entitlements.plist
├── capabilities/
│   └── main.json
├── migrations/
├── src/
│   ├── main.rs
│   ├── lib.rs
│   ├── commands.rs
│   ├── app_paths.rs
│   ├── db/
│   │   ├── mod.rs
│   │   ├── migrations.rs
│   │   └── repositories.rs
│   ├── domain/
│   │   ├── folders.rs
│   │   ├── notes.rs
│   │   ├── recording.rs
│   │   └── processing.rs
│   ├── audio/
│   │   ├── capture.rs
│   │   ├── validation.rs
│   │   ├── waveform.rs
│   │   └── recovery.rs
│   ├── providers/
│   │   ├── transcription.rs
│   │   ├── generation.rs
│   │   └── mock.rs
│   └── telemetry.rs
└── tests/
    ├── recording_validation.rs
    ├── storage.rs
    └── recovery.rs
```

**Structure Decision**: Use a standard Tauri v2 app layout with a lightweight React/Vite frontend in `src/` and Rust command/domain modules in `src-tauri/src/`. Persistence, recording, validation, provider calls, and recovery live in Rust to keep reliability-critical behavior outside the webview. The frontend renders the macOS-style notes workflow and invokes only scoped commands documented in `contracts/commands.md`.

## UI Polish Direction

The frontend should use a Liquid Glass-inspired macOS treatment as a polish layer over the required notes workflow. This means restrained translucency, blur, subtle borders, vibrancy-like foreground contrast, and immediate control feedback on the sidebar, editor surfaces, and bottom recorder controls. It does not mean rebuilding the app as SwiftUI, adding native `glassEffect` as an MVP requirement, or introducing decorative complexity that competes with recording reliability.

Implementation tasks should keep the glass treatment scoped, accessible, and easy to disable or simplify. Exact native Liquid Glass behavior is a best-effort visual reference for the Tauri webview, while reliable recording, validation, recovery, and local persistence remain the core MVP priorities.

## Phase 0: Research Decisions

See [research.md](./research.md). All planning unknowns are resolved there.

## Phase 1: Design Artifacts

See [data-model.md](./data-model.md), [contracts/commands.md](./contracts/commands.md), [contracts/ui.md](./contracts/ui.md), and [quickstart.md](./quickstart.md).

## Post-Design Constitution Check

The constitution remains placeholder-only and imposes no additional gates.

Post-design gate status: PASS.

## Complexity Tracking

No constitution violations are present.
