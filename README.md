# private-stock

A self-hosted media cataloger and viewer for large local libraries. Runs on a NAS, serves a
multi-user web UI, scans and processes in the background, and finds duplicates.

- **Design document:** [`ARCHITECTURE.md`](ARCHITECTURE.md)
- **Working conventions:** [`CLAUDE.md`](CLAUDE.md)

Status: **phase 0** — scaffold, schema, migrations, health check. The scanner and library
grid arrive in phase 1.

## Getting started

```bash
pnpm install
cp config.example.json config.json     # optional; env vars alone also work
pnpm db:init                           # build the schema on an empty database
pnpm dev                               # web on :8842, worker alongside it
```

Point `mediaDir` at a directory whose subdirectories are your media roots:

```
media/
  videos/     -> becomes a root
  photos/     -> becomes a root
```

In VS Code, **Run and Debug → "Debug: Full Stack (Web + Worker)"** starts both processes
with server-side breakpoints bound, and opens the app in your browser once Next is listening.
Stopping one of the two leaves the other running — the worker is meant to outlive a browser
window or a web restart. For client-side breakpoints, start the app yourself and use
"Debug: Browser only (server already running)". Every command above also exists as a task.

## Deploying to a NAS

```bash
docker buildx build --platform linux/amd64,linux/arm64 -f docker/Dockerfile -t private-stock .
```

Then use [`docker/docker-compose.qnap.yml`](docker/docker-compose.qnap.yml) in Container
Station. Media shares mount read-only; one writable volume holds the database, artifacts,
transcodes, trash, and backups.

## Layout

```
apps/web/        Next.js — UI, API routes, media serving
apps/worker/     scanner, job queue, ffmpeg pipelines
packages/core/   zod schemas, domain vocabulary, typed errors, path safety
packages/db/     SQLite client, schema, migrations, repositories
docker/          image, compose files, entrypoint
```
