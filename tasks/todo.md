- [x] Trace session creation and message load behavior for duplicate blank sessions.
- [x] Add regression coverage for duplicate/blank Hermes sessions from one submitted request.
- [x] Patch the session persistence/merge path so one request remains one visible chat with messages.
- [x] Run targeted tests and record the result.

## Review

- `pnpm test src/test/hermes-adapter.test.ts` passed.
- `pnpm lint` passed.
