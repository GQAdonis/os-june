# Open-Source Production Notes

This project is ready to publish as a self-hosted Mac app codebase when secrets, generated artifacts, and non-working product surfaces stay out of the release.

## Required Configuration

Copy `.env.example` to `.env` and set:

- `DATABASE_URL`: SQLite is the default local database.
- `SESSION_SECRET`: long random secret for session signing.
- `APP_URL`: local or deployed app URL.
- `TRANSCRIPTION_SETTINGS_ENCRYPTION_KEY`: required before saving provider API keys in the UI.

AI summaries and chat use OpenAI automatically when `OPENAI_API_KEY` is set. Development can force fixture output with `AI_PROVIDER=mock`; production-like testing can set `AI_PROVIDER=openai` explicitly.

## Transcription Providers

Mock transcription is internal only. It must not be presented as a production option.

OpenAI:

- `TRANSCRIPTION_PROVIDER=openai`
- `OPENAI_API_KEY`
- `OPENAI_TRANSCRIPTION_MODEL`, default `gpt-4o-mini-transcribe`

Recommended OpenAI transcription models:

- `gpt-4o-mini-transcribe`
- `gpt-4o-transcribe`
- `gpt-4o-transcribe-diarize`
- `whisper-1`

OpenAI-compatible:

- `TRANSCRIPTION_PROVIDER=openai-compatible`
- `OPENAI_COMPATIBLE_TRANSCRIPTION_BASE_URL`, for example `http://localhost:8000/v1`
- `OPENAI_COMPATIBLE_TRANSCRIPTION_API_KEY`, optional
- `OPENAI_COMPATIBLE_TRANSCRIPTION_MODEL`, default `whisper-1`

The compatible provider sends:

```text
POST {baseUrl}/audio/transcriptions
Content-Type: multipart/form-data

file=<audio file>
model=<model>
response_format=json
```

Expected response:

```json
{ "text": "Transcript text" }
```

If segment data is returned, the app can convert it into transcript turns. If only `text` is returned, the app creates one default turn.

## Current Product Surface

Supported:

- Personal notes and folders
- Quick note recording
- Microphone and macOS system-audio capture
- Transcription through OpenAI or OpenAI-compatible providers
- AI note generation and note chat

Not part of the current shippable surface:

- Hosted billing or upgrade plans
- Share links and collaborative permissions
- Calendar sync
- Multi-organization workspaces

Leave those hidden unless you complete and verify the full provider flow.

## Release Checklist

Before publishing:

- Confirm `.env` and any provider keys are not committed.
- Confirm `.next`, `dist`, generated `.app` bundles, `native/bin`, and local SQLite databases are not committed.
- Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`.
- Run at least one real transcription smoke test with OpenAI or an OpenAI-compatible server.
- Review `git status --ignored` for generated files that should stay local.
- Treat `pnpm db:seed` as an opt-in local fixture command. It only creates sample data when `SEED_USER_EMAIL` and `SEED_USER_PASSWORD` are set.

## Packaging

Desktop development:

```bash
pnpm desktop:dev
```

Mac packaging:

```bash
pnpm desktop:build
```

The native recorder helper is generated under `native/bin`; keep it out of source control and rebuild it during packaging.
