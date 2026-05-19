# Command Contracts: Tauri Notes MVP

The frontend communicates with the Rust backend through Tauri commands only. Commands return JSON-serializable DTOs and use structured errors with `code`, `message`, and optional `details`.

## Shared Types

```ts
type ProcessingStatus =
  | "draft"
  | "recording"
  | "validating"
  | "transcribing"
  | "generating"
  | "ready"
  | "failed"
  | "recoverable";

type RecordingState =
  | "idle"
  | "permission_denied"
  | "recording"
  | "paused"
  | "finalizing"
  | "validating"
  | "invalid"
  | "ready"
  | "failed"
  | "recoverable";

type AppError = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
};
```

## App Bootstrap

### `bootstrap_app`

Loads initial app state and performs recovery scan.

**Request**: none

**Response**:

```ts
type BootstrapResponse = {
  folders: FolderDto[];
  notes: NoteListItemDto[];
  activeRecoveries: RecoverableRecordingDto[];
  providerConfigured: boolean;
};
```

**Errors**:
- `storage_unavailable`
- `migration_failed`
- `recovery_scan_failed`

## Folder Commands

### `create_folder`

**Request**:

```ts
type CreateFolderRequest = {
  name: string;
};
```

**Response**: `FolderDto`

**Errors**:
- `folder_name_required`
- `folder_name_duplicate`
- `storage_write_failed`

### `list_folders`

**Request**: none

**Response**: `FolderDto[]`

### `assign_note_to_folder`

**Request**:

```ts
type AssignNoteToFolderRequest = {
  noteId: string;
  folderId: string;
};
```

**Response**: `NoteDto`

**Errors**:
- `note_not_found`
- `folder_not_found`
- `storage_write_failed`

### `remove_note_from_folder`

**Request**:

```ts
type RemoveNoteFromFolderRequest = {
  noteId: string;
  folderId: string;
};
```

**Response**: `NoteDto`

## Note Commands

### `create_note`

Creates a draft note, optionally assigned to a folder.

**Request**:

```ts
type CreateNoteRequest = {
  folderId?: string;
};
```

**Response**: `NoteDto`

### `list_notes`

Lists notes in reverse chronological order.

**Request**:

```ts
type ListNotesRequest = {
  folderId?: string;
  limit?: number;
  cursor?: string;
};
```

**Response**:

```ts
type ListNotesResponse = {
  notes: NoteListItemDto[];
  nextCursor?: string;
};
```

### `get_note`

**Request**:

```ts
type GetNoteRequest = {
  noteId: string;
};
```

**Response**: `NoteDto`

### `update_note`

Autosaves editable note fields.

**Request**:

```ts
type UpdateNoteRequest = {
  noteId: string;
  title?: string;
  editedContent?: string;
  activeTab?: "notes" | "transcription";
};
```

**Response**: `NoteDto`

**Errors**:
- `note_not_found`
- `storage_write_failed`

## Recording Commands

### `get_microphone_permission_state`

**Request**: none

**Response**:

```ts
type MicrophonePermissionResponse = {
  state: "unknown" | "granted" | "denied" | "restricted";
  recoveryHint?: string;
};
```

### `start_recording`

Requests or verifies microphone permission, creates a recording session, starts microphone capture, and begins writing a partial file.

**Request**:

```ts
type StartRecordingRequest = {
  noteId: string;
};
```

**Response**:

```ts
type RecordingSessionDto = {
  id: string;
  noteId: string;
  state: RecordingState;
  startedAt: string;
  elapsedMs: number;
  deviceLabel?: string;
  level: AudioLevelDto;
};
```

**Errors**:
- `microphone_permission_denied`
- `microphone_unavailable`
- `recording_already_active`
- `audio_writer_failed`
- `storage_write_failed`

### `pause_recording`

**Request**:

```ts
type PauseRecordingRequest = {
  sessionId: string;
};
```

**Response**: `RecordingSessionDto`

### `resume_recording`

**Request**:

```ts
type ResumeRecordingRequest = {
  sessionId: string;
};
```

**Response**: `RecordingSessionDto`

### `get_recording_status`

Returns elapsed time, state, and current audio level/waveform summary for UI polling or event reconciliation.

**Request**:

```ts
type GetRecordingStatusRequest = {
  sessionId: string;
};
```

**Response**:

```ts
type RecordingStatusDto = {
  sessionId: string;
  state: RecordingState;
  elapsedMs: number;
  level: AudioLevelDto;
  silenceWarning: boolean;
  bytesWritten: number;
};
```

### `finish_recording`

Finalizes the audio file, validates it, and starts transcription/generation only when validation passes.

**Request**:

```ts
type FinishRecordingRequest = {
  sessionId: string;
};
```

**Response**:

```ts
type FinishRecordingResponse = {
  note: NoteDto;
  recording: RecordingSessionDto;
  validation: AudioValidationDto;
  processingStarted: boolean;
};
```

**Errors**:
- `recording_not_found`
- `audio_finalization_failed`
- `audio_validation_failed`
- `storage_write_failed`

## Processing Commands

### `retry_processing`

Retries transcription and/or generation from the saved audio or transcript.

**Request**:

```ts
type RetryProcessingRequest = {
  noteId: string;
  step?: "transcription" | "generation" | "all";
};
```

**Response**: `NoteDto`

**Errors**:
- `note_not_found`
- `audio_artifact_missing`
- `provider_not_configured`
- `transcription_failed`
- `generation_failed`

### `recover_recording`

Attempts to recover an interrupted session after startup scan.

**Request**:

```ts
type RecoverRecordingRequest = {
  sessionId: string;
  action: "validate" | "discard";
};
```

**Response**: `NoteDto`

## DTOs

```ts
type FolderDto = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

type NoteListItemDto = {
  id: string;
  title: string;
  preview: string;
  processingStatus: ProcessingStatus;
  folderIds: string[];
  createdAt: string;
  updatedAt: string;
  durationMs?: number;
};

type NoteDto = NoteListItemDto & {
  generatedContent?: string;
  editedContent?: string;
  transcript?: TranscriptDto;
  recording?: RecordingSessionDto;
  audio?: AudioArtifactDto;
  activeTab?: "notes" | "transcription";
  lastError?: string;
};

type TranscriptDto = {
  id: string;
  text: string;
  language?: string;
  status: "pending" | "running" | "succeeded" | "failed";
  lastError?: string;
};

type AudioArtifactDto = {
  id: string;
  format: "wav";
  durationMs: number;
  sizeBytes: number;
  checksum: string;
  createdAt: string;
};

type AudioLevelDto = {
  peak: number;
  rms: number;
  recentPeaks: number[];
};

type AudioValidationDto = {
  fileExists: boolean;
  nonZeroSize: boolean;
  readableAudio: boolean;
  expectedDurationMs: number;
  actualDurationMs: number;
  durationWithinTolerance: boolean;
  nonSilentSignal: boolean;
  peakAmplitude: number;
  rmsAmplitude: number;
  warnings: string[];
};

type RecoverableRecordingDto = {
  sessionId: string;
  noteId: string;
  startedAt: string;
  partialPathPresent: boolean;
  finalPathPresent: boolean;
  bytesFound: number;
};
```

## Event Contract

The backend may emit events to keep the UI responsive between command calls.

```ts
type BackendEvent =
  | { type: "recording-level"; sessionId: string; level: AudioLevelDto; elapsedMs: number; silenceWarning: boolean }
  | { type: "recording-state"; sessionId: string; state: RecordingState; message?: string }
  | { type: "note-updated"; note: NoteDto }
  | { type: "processing-state"; noteId: string; status: ProcessingStatus; message?: string };
```

Events are advisory. Commands and persisted state remain authoritative after reload.
