# CLAUDE.md

Guidance for working in this repository.

## Overview

private-stock is a self-hosted media cataloger and viewer for large local libraries
(~20k–200k items). Developed on Windows, deployed to a QNAP via Container Station. Multi-user
web UI, background scanning and ffmpeg processing, duplicate detection, clip and reel
authoring.

**`ARCHITECTURE.md` is the design document and the source of truth for decisions.** It
records not just what was chosen but why, including the things deliberately rejected. Read
the relevant section before changing anything structural; update it when a decision changes.

Conventions here are deliberately inherited from the sibling `../basket-bot` project —
same package manager, monorepo tool, database layer, migration runner, auth scheme, error
handling, component library, formatting, and test runner.

## Common commands

```bash
pnpm install                 # install everything
pnpm dev                     # web + worker, both hot-reloading
pnpm build                   # build every package and app
pnpm typecheck               # tsc --noEmit everywhere
pnpm lint
pnpm test                    # unit tests, including schema drift + snapshot
pnpm test:integration        # tests that shell out to ffmpeg
pnpm format                  # prettier --write

pnpm db:init                 # build the current schema on an empty database
pnpm db:migrate              # apply pending migrations
pnpm db:migrate:rollback     # roll back the last one (development only)
pnpm db:diagnose             # row counts, sizes, and what the slow queries actually cost

pnpm models:fetch            # download + verify the §5e models (once; needed by smoke and integration)
pnpm bench:embed             # what the models cost on this machine; --smoke checks they answer
# db:baseline and db:reset were the pre-release workflow and now refuse to run — see below

./docker/smoke.sh            # after pnpm build: does the container's boot sequence work?
```

`docker/smoke.sh` is the only check that loads the compiled output the way the container does
-- plain `node` against `dist`. Development uses `tsx` and the web app is bundled by Next, so
nothing else would notice an import Node cannot resolve. Run it before shipping an image.

**Relative imports in `packages/core`, `packages/db` and `apps/worker` carry an explicit
`.js`**, even though the file being imported is `.ts`. Those three are on
`moduleResolution: "nodenext"` because their output is loaded by Node directly; the extension
is what Node requires and the compiler enforces it (TS2835). `apps/web` is on `bundler` and
does not.

In VS Code, "Debug: Full Stack (Web + Worker)" runs both processes with server-side
breakpoints bound. The two sessions are independent on purpose: the worker runs ffmpeg
jobs for hours and must not be stopped by a browser window closing or the web dev server
restarting.
Tasks mirror every command above.

## Architecture

### Monorepo layout

```
apps/web/        Next.js — pages, admin UI, /api/*, media + art serving
apps/worker/     scanner, job queue runner, ffmpeg pipelines (plain Node, no framework)
packages/core/   zod schemas, domain vocabulary, typed errors, path safety, pure logic
packages/db/     better-sqlite3 client, init.ts, migrations/, repos/
docker/          Dockerfile, compose files, entrypoint, QNAP notes
```

Two processes share one SQLite file. Next reads while the worker writes, which is why WAL
and `busy_timeout` are set on every connection.

**The worker is separate from Next on purpose**: ffmpeg jobs run for minutes and saturate
CPU, and must not share a process with request handling on a NAS. The two communicate
through the `Job` table, never HTTP.

### Layers

```
apps/web/src/app/api/*     route handlers — HTTP in/out, zod validation, withAuth()
apps/web/src/app/(app)/*   Mantine UI
apps/worker/src/jobs/*     job handlers — one file per job kind
packages/db/src/repos/     prepared statements only, no business logic
packages/core/             schemas, types, errors, pure logic
lib/services/              business logic + authorization, shared by routes and jobs
```

Services are the only place authorization is decided. Repos never contain business logic.
Route handlers validate with zod, call services, return JSON.

**Every route must be dynamic** — a cached media route serves stale bytes; a cached API
route serves another user's library. Paste this block verbatim at the top of every route
handler. It cannot be shared and re-exported: Next reads these fields by static analysis,
silently ignores a re-export, and falls back to the default config while the build still
succeeds. See `apps/web/src/lib/routeConfig.ts`.

```ts
// Declared literally in every route — Next ignores a re-export. See lib/routeConfig.ts.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";
```

**Error handling**: route `catch` blocks call `toErrorResponse(error, req, { userId })`.
Services and repos throw the typed error classes from `@private-stock/core`
(`AuthenticationError`, `AuthorizationError`, `NotFoundError`, `ConflictError`,
`ValidationError`, `PathSafetyError`, `ReadOnlyRootError`) — never `new Error("...")`.

## Database (SQLite + better-sqlite3)

- Schema source of truth: `packages/db/src/init.ts` (fresh databases)
- Migrations: `packages/db/src/migrations/` (timestamp-prefixed, `up`/`down`)
- TEXT primary keys from `crypto.randomUUID()`
- PascalCase singular table names, camelCase columns
- Booleans stored as `1` or `NULL` — never `0`. Partial indexes depend on this.
- CHECK constraints on text length
- Hard deletes, with one recorded exception: trashed media sit in a bounded limbo until
  purged (§10). `MediaFile.state` is a lifecycle, not a soft delete — and `'trashed'` is part
  of that lifecycle, gated by the existing `listable` column rather than by a
  `WHERE deleted IS NULL` in every query. That is the condition on the exception.

**Schema changes — the workflow depends on `packages/db/src/released.ts`.**

We have **released** (`HAS_RELEASED = true`), so real databases exist and the only way one of
them reaches a new schema is by replaying. Every schema change is three things, every time:

1. A new timestamped migration in `packages/db/src/migrations/` with `up` and `down`
2. The matching edit to `packages/db/src/init.ts`, which stays the source of truth for fresh
   databases — then `pnpm test -u` to accept the schema snapshot
3. The zod schemas in `packages/core/src/`

`pnpm db:baseline` and `pnpm db:reset` now refuse to run: the baseline is frozen history, and
rewriting it would strand the databases built from it. To start over locally, delete the
database file by hand.

Before release the workflow was the opposite — edit `init.ts`, regenerate the single baseline,
`pnpm db:reset` — because no database existed that anyone would mind losing. That is history
now; `released.ts` records it, and the flip was one commit and cannot be undone.

The guards adapted to the switch automatically:

- `migrationDrift.test.ts` builds one database from `init.ts` and another by replaying every
  migration, and requires identical schemas (column order is normalised away). Now that the
  chain is real the replay is a genuine independent check; the pre-release assertions — that
  the baseline is regenerable and the chain is one file — retire themselves.
- `schemaSnapshot.test.ts` renders any change as a readable SQL diff in
  `__snapshots__/schema.sql` — accept an intentional one with `pnpm test -u`.

## Files and media roots

**Deletion is the only write the app ever performs on a media root.** No renames, no moves,
no in-place metadata, no re-encoding originals. Everything the app produces goes to
`dataDir`. Deletion requires the `delete` scope _and_ a root flagged `writable`, moves the
file to `dataDir/trash` (copy + fsync + unlink — `/data` and `/media` are different volumes,
so `rename` fails with `EXDEV`), and records a `TrashEntry`. The one exception: a file with a
byte-identical twin that stays bypasses the bin — deleted outright and purged, with no restore (§10e).

Every path goes through `assertSafeRelativePath()` from `@private-stock/core`, including
paths read back out of the database.

Binary artifacts live on the filesystem; rows hold paths. The only BLOB in the schema is the
8-byte pHash.

## Authentication

- Short-lived JWT access token in `Authorization: Bearer <token>`
- Long-lived refresh token as an HttpOnly cookie
- JWT claims: `sub` (user id), `scopes: string[]`
- `withAuth()` in route handlers validates and extracts it
- Scopes: `admin` (roots, scans, settings, users, trash purge/restore) and `delete`
  (file deletion). Neither is implied by the other.
- Every repo function touching user data takes `userId` as an explicit parameter — never
  from ambient state.

## Key conventions

### TypeScript & React

- Strict mode; infer types from zod with `z.infer<typeof schema>`
- React components: `const MyComponent: React.FC<Props> = () => {}` — arrow functions, never
  `function` declarations
- File names: camelCase for utilities and hooks, PascalCase only for component files
- Import order: React → third-party → internal packages → relative

### Formatting (`.prettierrc`)

4-space indent, 100-column width, semicolons, double quotes, ES5 trailing commas, always
parenthesize arrow parameters. Don't hand-maintain it — run `pnpm format`.

### UI

- **Mantine only** — no second component library
- The theme in `apps/web/src/theme.ts` is the single source for the wine-cellar look. Add
  tokens there rather than hardcoding colours in components.
- **Responsive from phase 1**, not retrofitted. Phone layouts are designed alongside
  desktop, touch targets stay ≥44px, and gallery mode caps concurrent video previews by
  device class — mobile browsers limit simultaneous decoders.

### Anti-patterns to avoid

- No ad-hoc `interface` declarations for domain data — define types from zod in
  `packages/core`
- No one-off inline object types in casts — narrow with `instanceof`, or fix the type
- No `useEffect` for data fetching — use TanStack Query
- **No hand-written query keys.** Every cache key is built by calling a function on the
  `queryKeys` factory in `apps/web/src/lib/api/queryKeys.ts`; a mistyped factory call is a
  compile error, a mistyped array silently refreshes nothing. `docs/CACHE_KEYS.md` is the
  registry and says which caches each mutation has to reach — update it in the same change.
  A test walks the source and fails on any `queryKey: [`.
- No duplicate type definitions across packages
- No `function` keyword for React components
- No BLOBs in the database for anything but the pHash
- No `unlink` inside a media root — always go through the trash service
- No new bootstrap config keys without a reason they cannot be a `Setting` row
- **No exported helper without a caller.** Delete it rather than keeping it for a future that
  may not arrive: `ARCHITECTURE.md` is the spec, so a documented-but-unbuilt
  feature loses nothing by being written when it is actually needed, and untested code that
  looks available is worse than no code at all. The exceptions are things a _document_ refers
  to (`routeConfig.ts`), test seams, and types paired with a schema that is in use.

## Configuration

`config.json` holds only what is needed to start the process or find the database: `port`,
`dataDir`, `mediaDir`, `logLevel`, `trustedProxyHops`, `secret`. Each has a `PRIVATE_STOCK_*`
env override; **env wins over file wins over default**. Keys beginning with `//` are ignored,
which is how the example file is annotated.

SQL statement echoing is off unless `PRIVATE_STOCK_SQL_LOG=1` is set. It used to follow from
`NODE_ENV=development` and produced ~1.6 GB of terminal output an hour, which on Windows is
enough to block the worker on its own stdout (§15).

`trustedProxyHops` is the one key that is not about starting up, and §12 explains why it is
here anyway: it describes the deployment rather than a preference, it is read before anyone is
authenticated, and it decides how a caller is identified for rate limiting — so it must not be
editable from inside the app.

Everything an admin might change at runtime is a `Setting` row edited in the UI — scan
interval, transcode profiles, hwaccel, artifact quality, trash retention, dupe thresholds.
Adding a key to `config.json` means someone has to SSH in to change it, so it needs
justification.

A **library** is a directory plus its settings, stored in `MediaRoot` and added by an
administrator. Nothing becomes a library on its own: directories under `mediaDir` are offered
as suggestions when adding one, and that is all they are. A library is identified by its
path, so moving content is a repoint — the catalogue, tags and ratings survive it. A library
whose directory is unreachable is reported and otherwise left alone; nothing is ever cleaned
up for being missing.

## Testing

- Unit tests run everywhere and stay fast — pHash, filename parsing, config merge, path
  safety, schema drift.
- Tests that invoke ffmpeg go in the `test:integration` suite, run against generated
  fixtures. CI runs both; GitHub's runners ship ffmpeg.
- Integration tests are named `*.integration.test.ts` and sit beside the code they cover. The
  unit suite excludes that pattern and the integration config includes only it, so a test is
  routed by its filename and cannot accidentally end up in the fast suite where it would make
  `pnpm test` depend on a working ffmpeg.
