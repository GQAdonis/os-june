# Desktop Development

Use these commands from the repository root when running the Electron app locally.

## First-time setup

```bash
npx pnpm@10.24.0 install --frozen-lockfile
npx pnpm@10.24.0 rebuild electron better-sqlite3
npx pnpm@10.24.0 prisma migrate deploy
```

The local app database defaults to `prisma/dev.db` when `DATABASE_URL` is not set.

## Run the desktop app

```bash
npx pnpm@10.24.0 desktop:dev
```

`desktop:dev` builds the native macOS audio helper, starts Next.js on port `3000`, waits for it, and launches Electron.

If port `3000` is already in use, stop the existing process before running `desktop:dev`; the Electron dev entry expects `http://localhost:3000`.

## Native dependency troubleshooting

If Electron or SQLite reports a missing native binding after installing dependencies, rebuild the affected package:

```bash
npx pnpm@10.24.0 rebuild electron
npx pnpm@10.24.0 rebuild better-sqlite3
```
