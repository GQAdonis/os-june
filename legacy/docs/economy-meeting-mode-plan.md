# Economy Meeting Mode Implementation Plan

## Goal

Deliver the first delayed meeting transcription flow with persistent progress, working notes, and final note generation.

## Architecture

Use a note-backed meeting session. The client captures and uploads chunks; server endpoints own persistence, transcription, working-note updates, and finalization. Feature-specific client code lives under `src/features/meetings` to avoid adding more recording logic to the app shell.

## Tech Stack

Next.js App Router, React, TypeScript, Prisma with SQLite, Vitest, Testing Library, Electron, native macOS audio helper.

## Task 1: Persistent Chunk Storage

**Files**

- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260515150000_meeting_chunks/migration.sql`
- Create: `src/lib/meetings/transcript.ts`
- Create: `src/lib/meetings/transcript.test.ts`

**Checklist**

- [x] Write tests for transcript assembly from ordered chunks.
- [x] Run the transcript test and confirm it fails because the helper does not exist.
- [x] Add the chunk table to the Prisma schema.
- [x] Add the SQL migration.
- [x] Implement transcript assembly helpers.
- [x] Run the transcript test and confirm it passes.
- [x] Run `npx pnpm@10.24.0 typecheck`.
- [ ] Commit with an English message.

## Task 2: Meeting Creation Endpoint

**Files**

- Create: `src/lib/meetings/service.ts`
- Create: `src/lib/meetings/service.test.ts`
- Create: `src/app/api/meetings/route.ts`

**Checklist**

- [x] Write a failing service test for creating a recording note in the user's first space.
- [x] Implement the minimal service function.
- [x] Add the route handler that delegates to the service.
- [x] Run the service test.
- [x] Run `npx pnpm@10.24.0 typecheck`.
- [ ] Commit with an English message.

## Task 3: Chunk Upload Endpoint

**Files**

- Modify: `src/lib/meetings/service.ts`
- Modify: `src/lib/meetings/service.test.ts`
- Create: `src/app/api/meetings/[id]/chunks/route.ts`

**Checklist**

- [x] Write a failing service test for accepting a chunk and appending transcript text.
- [x] Implement chunk persistence and note transcript rebuild.
- [x] Add route validation for multipart uploads.
- [x] Run the targeted service tests.
- [x] Run `npx pnpm@10.24.0 typecheck`.
- [ ] Commit with an English message.

## Task 4: Working Notes and Finalization

**Files**

- Modify: `src/lib/providers/ai.ts`
- Modify: `src/lib/providers/ai.test.ts`
- Modify: `src/lib/meetings/service.ts`
- Modify: `src/lib/meetings/service.test.ts`
- Create: `src/app/api/meetings/[id]/insights/route.ts`
- Create: `src/app/api/meetings/[id]/end/route.ts`

**Checklist**

- [x] Write failing tests for working-note generation and finalization.
- [x] Add provider methods for working notes and final notes without changing existing summary behavior.
- [x] Implement service functions for working-note refresh and meeting end.
- [x] Add route handlers.
- [x] Run provider and service tests.
- [x] Run `npx pnpm@10.24.0 typecheck`.
- [ ] Commit with an English message.

## Task 5: Economy Meeting Client Flow

**Files**

- Create: `src/features/meetings/types.ts`
- Create: `src/features/meetings/lib/chunk-upload-queue.ts`
- Create: `src/features/meetings/lib/chunk-upload-queue.test.ts`
- Create: `src/features/meetings/hooks/use-economy-meeting.ts`
- Create: `src/features/meetings/components/meeting-view.tsx`
- Modify: `src/components/app-shell.tsx`

**Checklist**

- [x] Write failing tests for upload queue ordering and retry-safe state.
- [x] Implement the upload queue.
- [x] Add the economy meeting hook.
- [x] Add the meeting view.
- [x] Wire the app shell to start the meeting flow without removing quick notes.
- [x] Run the new queue tests.
- [x] Run `npx pnpm@10.24.0 typecheck`.
- [ ] Commit with an English message.

## Task 6: Verification and Documentation Update

**Files**

- Modify: `docs/economy-meeting-mode-spec.md`
- Modify: `docs/economy-meeting-mode-plan.md`
- Modify as needed: `README.md` or `docs/production.md`

**Checklist**

- [x] Update docs with the implemented behavior and remaining work.
- [x] Run `npx pnpm@10.24.0 test`.
- [x] Run `npx pnpm@10.24.0 typecheck`.
- [x] Run `npx pnpm@10.24.0 lint`.
- [x] Run `npx pnpm@10.24.0 build` and record any environment blocker in this plan before committing.
- [ ] Commit with an English message.
