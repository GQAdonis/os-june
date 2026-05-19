# Economy Meeting Mode Specification

## Goal

Build the first production-oriented meeting capture flow around delayed chunk transcription. The flow should let a user start a meeting, see transcript updates as audio chunks finish, receive periodic working notes, and end the meeting with a final note generated from the full transcript.

## Scope

This phase started with the economy path. Quick notes support a live microphone-only path, and meetings now support live transcription from microphone plus macOS system audio.

The first implementation should:

- Create a note as soon as the meeting starts.
- Mark the note as recording while capture is active.
- Capture microphone audio in browser-compatible chunks.
- Use the existing macOS system-audio helper as the final-recording source until chunk rotation is added there.
- Upload 20-30 second chunks to the existing transcription provider path.
- Append confirmed chunk text to the visible transcript.
- Refresh working notes every few chunks.
- End the meeting by generating a final note from the full transcript.

## Implemented Flow

The current branch implements the first note-backed economy flow:

- `POST /api/meetings` creates a recording note.
- `POST /api/meetings/[id]/chunks` transcribes one multipart audio chunk, stores it, and rebuilds the note transcript.
- `POST /api/meetings/[id]/insights` refreshes working notes from the transcript captured so far.
- `POST /api/meetings/[id]/end` creates final notes and marks the note ready.
- The home toolbar exposes Start Meeting alongside Quick note.
- The meeting screen shows elapsed time, transcript, working notes, capture warnings, and End Meeting.
- Browser microphone chunks upload through a sequential retryable queue.
- Quick note recordings use a note-backed live Realtime path for microphone captions and finalization.
- Live meetings use microphone WebRTC plus native macOS system-audio PCM streaming, then persist a source-labeled transcript for final notes.

## Non-Goals

- Speaker diarization guarantees.
- Cross-device sync.
- Cloud job queues.
- Calendar-driven meeting detection.
- A full rewrite of the current quick note screen.

## Remaining Work

- Add real-device QA that verifies macOS permissions, chunk timing, live finalization, and output quality with real meeting audio.
- Add visual QA for the meeting screen at desktop and narrow widths.
- Improve transcript ordering beyond source-labeled blocks if chronological interleaving becomes necessary.

## Architecture

The meeting flow should be a thin client orchestrator plus server-side meeting endpoints.

Client responsibilities:

- Manage browser audio capture.
- Maintain local recording state.
- Split microphone audio into uploadable chunks.
- Show upload, transcription, and note-generation progress.
- Request working-note refreshes on a schedule.

Server responsibilities:

- Create and own the recording note.
- Validate workspace access on every mutation.
- Transcribe incoming chunks through the configured provider.
- Store transcript text and chunk metadata.
- Generate working notes and final notes from server-side transcript state.

## Data Storage

Use `Note` as the meeting record. A recording note starts with:

- `status = RECORDING`
- empty or provisional `summary`
- empty `transcript`

Add persistent chunk rows linked to the note. Each chunk stores:

- note id
- source name
- sequential index
- start and end seconds
- text
- status
- optional error text

This keeps the transcript rebuildable and makes partial failures visible without losing the meeting.

## API Surface

Create focused endpoints under `/api/meetings`:

- `POST /api/meetings`: create a recording note.
- `POST /api/meetings/[id]/chunks`: accept one audio chunk, transcribe it, persist it, and update the note transcript.
- `POST /api/meetings/[id]/live-transcript`: persist confirmed live transcript text on the note, preserving source labels when provided.
- `POST /api/meetings/[id]/insights`: refresh working notes from the current transcript.
- `POST /api/meetings/[id]/end`: finalize transcript and summary, then mark the note ready.
- `POST /api/realtime/transcription-token`: create a short-lived Realtime transcription client secret for browser WebRTC.

The existing `/api/transcriptions` endpoint remains useful for generic upload transcription, but the meeting flow needs note-aware endpoints so progress can be saved incrementally.

## Client Structure

Create a feature folder for meeting-specific code:

```text
src/features/meetings/
  components/
  hooks/
  lib/
  types.ts
```

Initial files should stay small:

- `use-economy-meeting.ts`: recording lifecycle and upload scheduling.
- `chunk-upload-queue.ts`: sequential uploads with retry-safe state.
- `transcript-merge.ts`: deterministic transcript assembly helpers.
- `meeting-view.tsx`: meeting-specific screen.

The existing app shell should call into this feature instead of growing more meeting logic inline.

## Error Handling

Chunk failures should not end the meeting. The UI should show a recoverable warning and continue with later chunks.

Chunks that transcribe successfully but contain no recognized speech should be skipped without marking the upload as failed. The note should stay unchanged, and later chunks should continue to append normally.

Finalization should work with the transcript that was successfully captured. If no transcript exists, the user should see a clear error and the note should remain editable.

Quick notes must not generate from placeholder/template text. If neither transcript chunks nor typed notes exist, generation should fail with a clear validation error.

## Quick Note Live Mode

Quick notes use a microphone-only Realtime transcription session for live captions. The client creates a note, requests a short-lived Realtime client secret from the server, connects to OpenAI Realtime over WebRTC, and displays transcript deltas while audio is still arriving.

Completed transcript turns are kept in memory while recording and persisted to the note when capture stops. Final note generation uses the persisted live transcript plus any typed note text.

Typed quick-note text is treated as custom instructions/context when a transcript exists. It can define the audience, output format, language, or focus for the final note without being mixed into the transcript. If no transcript was captured, typed text remains a fallback source note so manual quick notes still work.

The home screen exposes a Quick Note mode switch:

- Batch mode: microphone chunks through the economy upload path.
- Live mode: microphone-only Realtime captions through WebRTC.

The selected mode is applied when a quick note starts. Paused quick notes resume with the mode they started with.

The live path requires the OpenAI transcription provider and uses `gpt-realtime-whisper` by default for realtime transcription. Set `OPENAI_REALTIME_TRANSCRIPTION_MODEL` to override it with another Realtime transcription-compatible model. Batch mode remains available for lower-cost chunked capture.

## Meeting Live Mode

Live meetings require both microphone permission and macOS system-audio capture permission. Capture is started before the meeting note is created, so permission failures do not leave empty recording notes behind.

The microphone stream uses the existing browser WebRTC Realtime path. The macOS helper has a streaming mode that emits PCM16 mono 24 kHz audio chunks through Electron IPC. The renderer forwards those system-audio chunks to a separate Realtime transcription WebSocket. The client keeps microphone and system transcript state separate, displays a merged transcript, and persists the final text with source labels:

```text
Microphone: ...

System audio: ...
```

If the system-audio stream cannot start, the home screen shows the permission error and an action to open macOS audio permissions.

## Final Note Assistant

The final note view composer runs real note-scoped chat prompts against the saved summary and transcript. MVP prompts include follow-up email, personal todos, and expanded notes. Responses render inline in the note view instead of opening placeholder recipe UI.

## Verification

Each implementation slice should include tests before production code:

- transcript assembly
- chunk persistence behavior
- working-note refresh behavior
- finalization behavior
- client state transitions where practical

Every committed slice should pass the targeted tests for that slice. Broader verification should run before larger integration commits.
