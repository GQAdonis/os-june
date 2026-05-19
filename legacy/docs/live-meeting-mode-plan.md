# Live Meeting Mode Implementation Plan

## Goal

Enable meeting live mode with real-time transcription from both microphone audio and macOS system audio.

## Architecture

Live meetings use two parallel transcription streams:

- Microphone stream: browser microphone capture over the existing Realtime WebRTC path.
- System audio stream: native macOS process tap emits PCM16 mono 24 kHz chunks from the helper app bundle to Electron through a localhost TCP channel; the renderer forwards those chunks to a Realtime transcription WebSocket.

The client keeps separate transcript states for each source and persists a labeled merged transcript:

```text
Microphone: ...

System audio: ...
```

Final meeting notes continue to use the existing `/api/meetings/:id/end` flow, so the final note prompt receives the full labeled transcript.

## Scope

- Add native system audio streaming mode without removing the existing final WAV recording mode.
- Add Electron IPC for starting/stopping the stream and receiving PCM chunks from the localhost bridge.
- Add a live meeting hook that creates a meeting note, starts microphone and system streams, renders live transcript, persists transcript, and finalizes notes.
- Apply the existing Batch/Live mode switch to both Quick Notes and Meetings.
- Add permission errors that explain whether microphone or system audio setup failed.

## Non-goals

- Speaker diarization.
- Cross-platform system audio capture.
- Native Tauri migration.
- Perfect chronological interleaving between microphone and system transcript turns.

## Verification

- Unit tests for labeled live transcript persistence.
- Hook tests for live meeting start, transcript updates, persistence, and finalization.
- App shell test for routing Start Meeting through live mode.
- Typecheck, lint, test suite, Next build, and native helper build.
