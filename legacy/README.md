# OS Notepad

OS Notepad is an open-source Mac desktop app for meeting notes. It records microphone and macOS system audio, transcribes the recording through a user-configured provider, and turns transcripts into notes and chat answers.

The app is intentionally personal-use first: local notes, folders, quick notes, transcript viewing, AI summaries, and chat over your own notes. Calendar, billing, sharing, and organization features are not part of the current shippable surface.

## Stack

- Electron desktop shell with a native macOS audio recorder helper
- Next.js App Router, React, TypeScript, Tailwind CSS
- Prisma 7 with SQLite for local development
- Custom session-cookie auth
- OpenAI and OpenAI-compatible transcription providers
- Vitest, Testing Library, and app-level verification scripts

## Local Setup

```bash
pnpm install
cp .env.example .env
pnpm db:generate
pnpm db:migrate
pnpm desktop:dev
```

Create an account from the login screen. In development only, the app can create a local demo session automatically if no session exists.

## Transcription

User-facing transcription is not mocked. Configure transcription in the app settings, or provide environment defaults in `.env`.

OpenAI:

```bash
TRANSCRIPTION_PROVIDER="openai"
OPENAI_API_KEY="<your-openai-api-key>"
OPENAI_TRANSCRIPTION_MODEL="gpt-4o-mini-transcribe"
```

OpenAI-compatible local or third-party server:

```bash
TRANSCRIPTION_PROVIDER="openai-compatible"
OPENAI_COMPATIBLE_TRANSCRIPTION_BASE_URL="http://localhost:8000/v1"
OPENAI_COMPATIBLE_TRANSCRIPTION_API_KEY=""
OPENAI_COMPATIBLE_TRANSCRIPTION_MODEL="whisper-1"
```

Saved provider API keys are encrypted at rest. Set `TRANSCRIPTION_SETTINGS_ENCRYPTION_KEY` before saving keys through the UI.

## Verification

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

For real-provider smoke tests:

```bash
pnpm e2e:openai
pnpm e2e:real-openai-recording
pnpm providers:real
```

## Open-Source Hygiene

Do not commit `.env`, local SQLite databases, `.next`, `dist`, generated `.app` bundles, or `native/bin`. The repository includes ignore rules for these generated and secret-bearing files.

See [docs/production.md](docs/production.md) for provider and release notes.
