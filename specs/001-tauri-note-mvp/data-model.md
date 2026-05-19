# Data Model: Tauri Notes MVP

## Folder

Local organizational container.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | UUID string | Yes | Stable local id |
| `name` | string | Yes | Unique among non-deleted folders after trimming |
| `created_at` | timestamp | Yes | Local creation time |
| `updated_at` | timestamp | Yes | Updated on rename or assignment changes |
| `deleted_at` | timestamp | No | Soft delete for recovery-safe cleanup |

**Relationships**:
- Many-to-many with `Note` through `note_folders`.

**Validation**:
- Name must not be blank after trimming.
- Duplicate active folder names are rejected or de-duplicated by UI before save.

## Note

User-created note record with generated and editable content.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | UUID string | Yes | Stable local id |
| `title` | string | Yes | Defaults to empty title rendered as `New note` placeholder |
| `generated_content` | text | No | Last generated note body |
| `edited_content` | text | No | User-edited note body, source of truth after edit |
| `active_tab` | enum | No | UI preference: `notes` or `transcription` |
| `processing_status` | enum | Yes | `draft`, `recording`, `validating`, `transcribing`, `generating`, `ready`, `failed`, `recoverable` |
| `created_at` | timestamp | Yes | Used for reverse chronological listing |
| `updated_at` | timestamp | Yes | Updated on edits and processing changes |
| `last_error` | text | No | User-facing failure summary |

**Relationships**:
- Many-to-many with `Folder`.
- Has many `RecordingSession`.
- Has zero or one current `Transcript`.
- Has many `GenerationResult` attempts.

**Validation**:
- A note may exist without audio in `draft`.
- A note with `ready` status must have either generated or edited content.
- Failed provider states must preserve links to any valid saved audio.

## NoteFolder

Join table for reversible folder assignment.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `note_id` | UUID string | Yes | References `Note` |
| `folder_id` | UUID string | Yes | References `Folder` |
| `assigned_at` | timestamp | Yes | Used for audit/debugging |

**Validation**:
- Unique `(note_id, folder_id)`.
- Removing an assignment never deletes the note.

## RecordingSession

Capture lifecycle record for one recording attempt.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | UUID string | Yes | Stable local id |
| `note_id` | UUID string | Yes | References `Note` |
| `status` | enum | Yes | `created`, `recording`, `paused`, `finalizing`, `validating`, `valid`, `invalid`, `recoverable`, `failed` |
| `started_at` | timestamp | Yes | Set before audio writer starts |
| `ended_at` | timestamp | No | Set when user selects Done or recovery finalizes |
| `expected_elapsed_ms` | integer | Yes | Active recording time excluding pauses |
| `device_label` | string | No | Best-effort microphone label |
| `permission_state` | enum | Yes | `unknown`, `granted`, `denied`, `restricted` |
| `partial_path` | string | No | App-local temporary path while recording |
| `final_path` | string | No | App-local finalized path |
| `file_size_bytes` | integer | No | Captured after finalization |
| `duration_ms` | integer | No | Parsed from readable audio |
| `checksum` | string | No | Integrity marker for finalized audio |
| `peak_amplitude` | float | No | Validation summary |
| `rms_amplitude` | float | No | Validation summary |
| `silent_window_ms` | integer | No | Longest detected near-silent span |
| `validation_summary` | JSON | No | Detailed check results |
| `last_error` | text | No | Failure details |

**Relationships**:
- Belongs to one `Note`.
- Produces zero or one `AudioArtifact`.
- Has many `RecordingCheckpoint`.

**State transitions**:
- `created` -> `recording`
- `recording` -> `paused` -> `recording`
- `recording` or `paused` -> `finalizing` -> `validating`
- `validating` -> `valid` or `invalid`
- Any active state -> `recoverable` on restart if audio bytes exist
- Any active state -> `failed` if no recoverable audio exists

## RecordingCheckpoint

Append-only checkpoint for observability and recovery.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | UUID string | Yes | Stable local id |
| `recording_session_id` | UUID string | Yes | References `RecordingSession` |
| `kind` | enum | Yes | `start`, `pause`, `resume`, `done`, `file_write`, `validation`, `transcription`, `generation`, `completion`, `failure` |
| `created_at` | timestamp | Yes | Event time |
| `details` | JSON | No | Structured details for debugging |

## AudioArtifact

Finalized local audio file metadata.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | UUID string | Yes | Stable local id |
| `note_id` | UUID string | Yes | References `Note` |
| `recording_session_id` | UUID string | Yes | References `RecordingSession` |
| `path` | string | Yes | App-local finalized path |
| `format` | string | Yes | MVP default `wav` |
| `duration_ms` | integer | Yes | Parsed from readable file |
| `size_bytes` | integer | Yes | Must be non-zero |
| `checksum` | string | Yes | Integrity marker |
| `created_at` | timestamp | Yes | Finalization time |

**Validation**:
- File must exist, be non-zero, readable as audio, and match expected duration within tolerance.
- Audio must contain non-silent signal above configured threshold before provider processing.

## Transcript

Transcription result from saved audio.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | UUID string | Yes | Stable local id |
| `note_id` | UUID string | Yes | References `Note` |
| `audio_artifact_id` | UUID string | Yes | References source audio |
| `text` | text | Yes | Raw transcript exactly as provider returned after normalization |
| `language` | string | No | Provider detected language if available |
| `provider` | string | Yes | `mock`, `openai`, or configured provider key |
| `status` | enum | Yes | `pending`, `running`, `succeeded`, `failed` |
| `retry_count` | integer | Yes | Starts at zero |
| `last_error` | text | No | Failure details |
| `created_at` | timestamp | Yes | First attempt time |
| `updated_at` | timestamp | Yes | Last status change |

**Validation**:
- Successful transcript text must not be blank.
- Empty provider responses become failed states with retry available.

## GenerationResult

AI-generated note content derived from a transcript.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | UUID string | Yes | Stable local id |
| `note_id` | UUID string | Yes | References `Note` |
| `transcript_id` | UUID string | Yes | References source transcript |
| `content` | text | No | Generated note content |
| `title_suggestion` | string | No | Optional generated title |
| `provider` | string | Yes | `mock`, `openai`, or configured provider key |
| `prompt_version` | string | Yes | Tracks generation rules |
| `status` | enum | Yes | `pending`, `running`, `succeeded`, `failed` |
| `retry_count` | integer | Yes | Starts at zero |
| `last_error` | text | No | Failure details |
| `created_at` | timestamp | Yes | First attempt time |
| `updated_at` | timestamp | Yes | Last status change |

**Validation**:
- Successful content must not be blank.
- Generation prompt must instruct the provider to use only the transcript and optional user note context.
- Generated note language should match source transcript language unless explicitly changed later.
