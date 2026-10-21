# private-stock — architecture

A self-hosted media cataloger/viewer for large local libraries (~20k–200k items). Developed
on Windows, deployed to a QNAP via Container Station. Web UI, multi-user, remote-access
friendly, background scanning and processing, duplicate detection, clip/reel authoring.

**Stack policy: mirror `../basket-bot` wherever it already has an answer.** Same package
manager, monorepo tool, database layer, migration runner, auth scheme, error handling,
component library, formatting, and test runner. New dependencies are added only where this
app does something basket-bot does not — which is essentially just ffmpeg and images.

## 1. Shape of the system

```
          +---------------- one container / one process tree ----------------+
          |                                                                  |
 browser -+-> Next.js (apps/web)  -->  SQLite (WAL)  <--  apps/worker        |
          |     pages + /api/*          ^                    |               |
          |     /api/media/*  range-streams original files    |              |
          |     /api/hls/*    on-demand transcode segments    +--> ffmpeg    |
          |     /api/art/*    covers, sprites, previews                      |
          |                                                                  |
          +-- volumes: /media/<root> (ro)   /data (db, art, cache, trash) ----+
```

One deployable unit, two processes: the Next server and a long-running worker. No Redis, no
Postgres, no message broker — a NAS user should `docker run` one image and be done.
Everything scales by _not_ needing to scale: a single box serving a handful of viewers.

## 2. Stack

Carried over from basket-bot unchanged:

| Layer                      | Choice                                                                   |
| -------------------------- | ------------------------------------------------------------------------ |
| Package manager / monorepo | pnpm 10 workspaces + Turborepo                                           |
| Runtime                    | Node 22+, TypeScript strict                                              |
| Server                     | **Next.js 15 (App Router) route handlers** — no separate HTTP framework  |
| DB                         | better-sqlite3, raw prepared statements in a repo layer                  |
| Migrations                 | the hand-rolled `migrate.ts` runner (§4)                                 |
| Validation / types         | zod in `packages/core`, types via `z.infer`                              |
| Auth                       | bcryptjs + jsonwebtoken, short JWT access + refresh cookie, `withAuth()` |
| UI                         | Mantine 7 + sass                                                         |
| Client data                | TanStack Query                                                           |
| Tests / lint / format      | Vitest, ESLint 9, Prettier (4-space, 100 col, double quotes)             |

New, and only where genuinely needed:

| Addition                      | Why nothing existing covers it                                                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `ffmpeg` / `ffprobe` binaries | probe, covers, sprites, previews, transcode; reel rendering is designed and not built (§14d). `ffmpeg-static` in dev; distro build in the image |
| `sharp`                       | image decode/resize/AVIF+WebP, and the pixel source for pHash                                                                                   |
| `@tanstack/react-virtual`     | Mantine has no virtualized grid; 200k rows needs one                                                                                            |
| `hls.js`                      | not wired in: MPEG-TS playlists (§8) play natively in Chrome; this is for a browser without native HLS, should one be used                      |

### No Fastify

Earlier drafts of this document proposed Fastify for the media edge. Dropped — Next route
handlers running on the Node runtime handle HTTP range requests fine (`export const
dynamic = "force-dynamic"`, `runtime = "nodejs"`, manual `206` + `Content-Range` over a
`fs.createReadStream`). That is roughly 80 lines of code in one file, not a reason to
introduce a second server framework, a second routing model, and a second auth integration.

The one part of that which is not obvious is handing a file to the response. `Readable.toWeb()`
is the apparent answer and is a trap: a viewer who seeks, closes the tab or drops off the wifi
cancels the response mid-read, and the adapter then calls `enqueue` on a controller the
runtime has already closed. That throws from Node's stream machinery rather than from the
handler, so it arrives as an **`uncaughtException`** — a process-level event, raised by the
most ordinary thing anyone does here. `apps/web/src/lib/fileStream.ts` writes the adapter out
instead: every controller call guarded, cancellation destroys the file handle, and the request
signal is a second path to the same teardown because an abort can beat the cancel.

Next's _caching_ is the real footgun, not its streaming: every media, art, and API route is
explicitly dynamic and uncached. Note that this **cannot** be centralised — Next reads
`dynamic`/`revalidate`/`runtime`/`fetchCache` by static analysis and silently ignores a
re-export from a shared module, falling back to defaults while the build still succeeds. The
four lines are pasted into each route; `apps/web/src/lib/routeConfig.ts` documents why.

### Native modules and the bundler (learned in phase 0)

Three facts that cost time to discover and are cheap to remember:

- **better-sqlite3 must not be bundled.** Its `bindings` helper locates `better_sqlite3.node`
  by walking up from `__dirname`; once webpack rewrites that, every candidate path is wrong
  and the failure appears at runtime with a green build. Both `better-sqlite3` and
  `@private-stock/db` are listed in `serverExternalPackages` — externalising only the leaf is
  not enough, because Next auto-transpiles workspace packages and pulls the import back in.
- **An externalised import must be resolvable from the app.** Under pnpm's strict
  `node_modules`, a transitive dependency of `@private-stock/db` is invisible to `apps/web`.
  So `apps/web` declares `better-sqlite3` directly even though none of its files import it by
  name — the runtime `require` needs it on that resolution path.
- **The database handle is opened lazily.** `next build` evaluates every route module to
  collect page data, so a connection opened at import time makes the build touch a database
  that may not exist, on a machine that is not the one that will run it.

If byte-serving through Node ever becomes the bottleneck, the escape hatch is to let Caddy
serve `/media` straight from disk with `forward_auth` back to Next for authorization — no
application change, and only if measurement demands it.

### The worker is a plain Node process

`apps/worker` is a long-running tsx/node process — the same shape as the existing `db:seed`
scripts, no framework. It owns the scanner, the job queue, and all ffmpeg subprocesses.

It is separate from Next for one concrete reason: ffmpeg jobs run for minutes and saturate
CPU, and they must not share a process with request handling on a weak NAS CPU. It talks to
Next through the database, not HTTP — the job queue _is_ a SQLite table, which also makes it
restart-safe for free. Next enqueues; the worker claims and executes.

### Mobile app (later, optional)

basket-bot's Ionic/Capacitor app is a proven path here too, and it is the cleanest answer to
the Android/TV casting problem (§10): a Capacitor app can use the native Cast SDK directly
instead of fighting the browser sender SDK. Not phase 1, but `packages/core` stays free of
DOM and Node dependencies so a mobile app can consume it unchanged.

## 3. Repo layout

```
private-stock/
  apps/
    web/             Next.js — pages, admin portal, /api/*, media + art serving
    worker/          scanner, job queue runner, ffmpeg pipelines
  packages/
    core/            zod schemas, domain types, typed error classes, pHash, pure helpers
    db/              better-sqlite3 client, init.ts, migrations/, repos/
  docker/            Dockerfile, compose files, entrypoint, QNAP notes
  scripts/           fixture media generation, release helpers
```

Deviation from basket-bot: the database layer is promoted out of `apps/web` into
`packages/db`, because **two** processes now need it. Repos, `init.ts`, and the migration
runner move as a unit; the layering rule is unchanged.

**Layers** (same contract as basket-bot):

```
apps/web/app/api/*        route handlers — HTTP in/out, zod validation, withAuth()
apps/web/app/(app)/*      Mantine UI
apps/worker/src/jobs/*    job handlers — one file per job type
packages/db/repos/        prepared statements only, no business logic
packages/core/            schemas, types, errors, pure logic
lib/services/             business logic + authorization, shared by routes and jobs
```

Services are the only place authorization is decided. Route handlers `catch` into
`toErrorResponse(error, req, { userId })`; services and repos throw the typed error classes
from `packages/core`. Same `ErrorLog` table; its viewer is parked (§12c).

## 4. Database conventions

Ported wholesale from basket-bot — this is the single biggest reuse win:

**Migrations are on: we have released.** `packages/db/src/released.ts` carries a single
`HAS_RELEASED` flag, now `true`. Until the first deployment it was `false` — no database
existed that anyone would mind losing, so schema changes were made by editing `init.ts` and
regenerating the one baseline migration, and accumulating migrations for a schema nobody was
running would have been pure bookkeeping. Real databases now hold real ratings, tags and
clips, and the only way one of them reaches a new schema is by replaying. So the baseline is
frozen history, `pnpm db:baseline` and `pnpm db:reset` refuse to run, and every schema change
is a new timestamped migration **plus** `init.ts` **plus** the zod schema — all three, every
time.

The guard did not switch off with the flag, it changed target. Pre-release the real failure
was a _stale_ baseline — `init.ts` edited, regeneration skipped — so that is what the drift
test asserted, along with the chain staying a single file. Now that the baseline is frozen
those two checks retire themselves and the replay becomes a genuine independent check: build
one database from `init.ts`, another by replaying the whole chain, and require the same
schema. The procedure that was followed is recorded in `released.ts`; it was one commit and
is one-way.

- Schema source of truth `packages/db/src/init.ts` for fresh databases.
- Timestamp-prefixed migrations in `packages/db/src/migrations/` with `up`/`down`, starting
  from a frozen `00000000_000000_baseline.ts`.
- `migrationDrift.test.ts` — builds one DB from `init.ts` and another by replaying
  migrations, and fails if the schemas differ. Keeps the three-step schema checklist honest.
- `schemaSnapshot.test.ts` — renders schema changes as a readable SQL diff.
- Booleans stored as `1` / `NULL`, never `0`. This pays off here: `favorite`, `hidden`, and
  `reviewed` all get partial indexes (`WHERE favorite IS NOT NULL`) that stay tiny.
- PascalCase singular table names, camelCase columns.
- Schema change checklist stays three steps: migration + `init.ts` + zod schema in `core`.

Two additions this app forces:

- **WAL mode**, because a worker writes while the web process reads. `busy_timeout` set on
  both connections; the worker batches writes into transactions rather than holding them.
  **The two timeouts differ on purpose** — 3 s in the web process, 15 s in the worker.
  SQLite's `busy_timeout` is a retry loop with no fairness, so the worker's steady stream of
  short writes can starve a web write for the whole timeout; and because `better-sqlite3` is
  synchronous, a web request waiting for the lock freezes every other request in the process
  rather than only itself. The web side must therefore give up long before the worker does, and
  `PRIVATE_STOCK_BUSY_TIMEOUT_MS` overrides either for an experiment — or to get a deployment out
  of a bad default without waiting for an image, which is how the 750 ms this first shipped with
  was undone: fail-fast is a property of a _write_, and a connection-wide 750 ms abandoned logins
  along with progress pings. A person typing a password got a 503. The rule that survived is
  narrower — **the write nobody waits on is the write that may be dropped** — and it lives at the
  call site, in `withBusyTimeout`, which currently has exactly one caller: the progress ping. A contended write answers
  503 with `Retry-After` rather than 500, and is deliberately _not_ written to the error log —
  that log is a table in the database that is currently contended.
- **Web transactions begin `IMMEDIATE` by default.** A deferred transaction reads first and
  takes the write lock at its first write, and SQLite refuses that upgrade outright — no
  `busy_timeout` wait — when the other process has committed since the read began. `trashRepo`
  and `mergeService` were fixed one call site at a time; saving a tag was not, and with the
  worker committing several times a second and cold reads costing hundreds of milliseconds on the
  NAS, it failed often. `openDatabase` now makes `db.transaction(fn)` immediate in the web
  process (`.deferred` remains for a snapshot read), and writes somebody waits on retry through
  `whenNotBusy` with an `await`ed backoff. Not in the worker: a read-only worker transaction
  holding the lock would stall web writes, the direction that matters.
- **The worker checkpoints; the web process does not.** SQLite checkpoints inside whichever
  commit pushes the WAL past `wal_autocheckpoint`, copying pages into the database file and
  fsyncing before that statement returns. At the default 1,000 pages the web process took that
  turn regularly — the worker writes nearly all of the WAL, but a progress ping every ten seconds
  (as it then was; see §20 for the schedule now) is a steady chance to be the commit that crosses the line — and a single-row progress update
  measured **437 ms under a 250 ms lock budget**, which only work done after acquiring the lock
  can explain. The web connection's mark is now 10,000 pages, a safety net for a stopped worker;
  the worker keeps 1,000 and runs a `PASSIVE` checkpoint every 30 s so the WAL stays drained
  while it is idle, which never blocks a writer. The progress ping also became one `immediate`
  transaction rather than two or three separate commits. If slow web writes survive both, they
  are page-cache misses (§20), and the remaining structural answer — a writer thread in the web
  process — was deliberately not taken until a number asks for it.
- **`VACUUM INTO` nightly backups** (§13).

### Keyset cursors must preserve the sort value's type

A cursor round-trips through a string, and **SQLite compares values of different storage
classes by class before value** — every integer sorts before every string, unconditionally.
So a numeric sort compared against a text-bound cursor makes `value < :cursor` true for
every row in the table: the keyset clause stops filtering, page two returns page one, and an
infinite scroll scrolls forever without advancing.

Nothing about this fails loudly. The query is valid, the rows are real, and the only symptom
is duplicates — which look like a concurrent scan, or a React key problem, or anything
except the cursor. It shipped in phase 1 on the `duration`, `size` and `rating` sorts and was
found in phase 4 only because relevance would have landed in the same trap.

`mediaRepo` therefore binds the cursor as a number for numeric sorts. Date sorts were never
affected because ISO strings sort lexically in chronological order. The regression test walks
whole result sets and asserts the union, because no single page shows the problem.

### On "hard-deletes only"

basket-bot's no-soft-delete rule is about _rows_, and it still holds — a removed file's row
is really deleted. Two things that look like exceptions are not:

- `MediaFile.state` (`active` / `missing` / `archived`) is a lifecycle state, not a deleted
  flag. A file on an offline share must not be treated as gone (§5).
- **Files on disk** are moved to `/data/trash/<date>/` rather than unlinked (§8). That is a
  filesystem policy, not a database one. The app never calls `unlink` inside a media root.

## 5. Data model

**Library (shared, objective):**

- **MediaFile** — physical: `rootId, relPath, size, mtime, inode, quickHash, contentHash, state`
- **Media** — logical item, facts only: `kind, duration, width, height, codec, container,
bitrate, fps, capturedAt, addedAt, lastSeenAt`
- **MediaFileLink** — one Media may have several files (original + web-safe variant)
- **Variant** — derived renditions: `mediaId, profile, path, codec, ready`
- **Artifact** — cover, poster candidates, hover preview, sprite sheet + VTT
- **PhashImage** — `mediaId, hash BLOB(8), band0..band3`
- **PhashVideo** — `mediaId, frameIdx, t, hash`
- **DupeGroup / DupeMember** — materialized clusters, `reviewed`
- **Tag / MediaTag** — **faceted** (see §5b): `Tag(kind, name, nameNorm, ownerId, ...)`.
  Two systems (§6): `ownerId`/`userId` NULL is public, set is that person's own, and the pair
  always agrees. `Tag.createdById` records who coined the name and `MediaTag.createdById` who
  applied it — neither of which `ownerId`/`userId` can answer once anybody may write publicly
- **MediaAttribute** — `mediaId, key, value, source` — long-tail scraped fields
- **MediaRoot, Scan, Job, Setting, ErrorLog, \_migrations**

**Per user (subjective):**

- **User** — `username, passwordHash, displayName, scopes, createdAt, disabled`
- **RefreshToken** — hashed, revocable per device
- **UserMedia** — PK `(userId, mediaId)`: `rating, favorite, hidden, viewCount, lastViewedAt,
watchedAt, note`
- **UserTag** — PK `(userId, tagId)`: `favorite` (§6 "Favourite tags")
- **Playlist / PlaylistItem** — `ownerId, name, visibility, sortMode`
- **SavedFilter** — `userId, name, queryJson, pinned, position`
- **HomeLayout** — `userId, rowsJson` (ordered shelves)
- **UserPref** — `userId, key, value`
- **Clip** — `mediaId, userId, startMs, endMs, label, speed`. `userId` is nullable: a clip is
  private to its author and readable through a reel that carries it (§14d)
- **Reel / ReelItem** — ordered clips. Shared like a playlist, pinnable like nothing
- **LibraryAccess** — `userId, rootId, allowed`

**Key decision 1 — physical file is not logical media.** Renames, moves between roots, and
exact duplicates resolve to one `Media` row, so ratings, tags, and clips survive file churn.

**Key decision 2 — nothing subjective lives on `Media`.** Ratings, favorites, view counts,
and watched marks live in `UserMedia`. This is the change that is genuinely painful to
retrofit, so it goes in the baseline migration even though the login UI comes later.

Identity: `quickHash` = hash of (size + first 1 MiB + last 1 MiB) for instant re-scan
matching; `contentHash` = full hash computed lazily by the worker, used to confirm exact
duplicates.

## 5b. Extensible descriptive metadata

Performers, sources, and whatever else a library wants to file things under are wanted
"someday". They do not need new tables — a **faceted tag system** in the baseline migration covers all of them on day one,
and the cost of building it faceted now versus flat now is one column.

```
Tag         id, kind, name, nameNorm, color, description, createdAt
            UNIQUE (kind, nameNorm)
MediaTag    mediaId, tagId, userId NULL, source, confidence NULL, position NULL
```

`kind` is an open string. Adding a facet later is a row, not a migration. `source` on the link records where
the assignment came from (`user`, `filename`, `scraper`, `ai`), and `confidence` lets AI
tagging (phase 10) write low-confidence suggestions into the same table without a parallel
system or a schema change. `position` orders performers within an item.

`nameNorm` reuses basket-bot's name-normalization convention, so "Jane Doe", "jane doe",
and "Jane Doe" collapse to one tag and filename parsing can match against existing tags.

### Three facets, not seven

The app offers **`tag`, `performer` and `source`**. It offered seven — `genre`, `series`,
`studio`, `location` and `event` as well — on the reasoning that a facet costs nothing to
declare.

Declaring one is free. _Offering_ one is not. The tag editor draws a box per facet, so seven
boxes asked seven questions about every item, six of them usually blank; and filing a tag
meant first deciding which of seven drawers it belonged in. That is the tax a faceted system
charges, and it is only worth paying where the facet changes what the value _means_ rather
than merely describing it.

`performer` earns one because it is a person: `nameNorm` folds spellings together, `position`
orders them within an item, and §5b's own promotion path turns it into a `Person` table one
day. `source` earns one because it records where an item came from rather than what it is.
Everything else a genre, a studio or a mood might have said is a word about the item, and one
box marked **Tags** is where a word about the item goes.

**The order is Performer, Source, Keyword, everywhere** — `tagKinds` in `domain.ts` is the one
list, and the item editor, the bulk dialogue's default, the filter panel, the management screen
and the sidebar all follow it. `tag` was listed first while there were seven boxes, because a
catch-all placed after six specific ones is a catch-all nobody reaches. At three that argument
is gone, and who is in an item is what most tagging actually records.

Nothing was migrated and nothing rejects a retired kind. `Tag.kind` is unconstrained, so a
`genre` tag written before the change still filters, still counts, still searches and simply
groups under "other" — which is the property that made narrowing the list safe, and the same
property that made widening it cheap in the first place.

**Using the vocabulary and changing it are different permissions.** Any signed-in user can
tag an item — that is the everyday act of curating a library, and gating it means nothing
ever gets tagged. Renaming, merging and deleting a tag need `admin`, because each changes
what every item carrying it means, retroactively and for everyone. Deleting a tag is
deliberately _not_ behind the `delete` scope, which exists for deleting files (§18.1); this
removes vocabulary and the media is untouched.

### Aliases

A tag can have other names: a performer known by a maiden and a married name, a source with an
old and a new domain, a keyword with a common synonym. They used to be filed under the future
`Person` table above. They are a property of every tag instead, because the problem they solve —
one thing, several names — is not particular to people, and waiting for `Person` meant living
with it in the meantime. Before aliases there were two answers, and both were wrong. Keeping two
tags split the items between them. Merging them deleted one name, and the next person to type
it coined the duplicate again.

```
TagAlias    id, tagId → Tag (cascade), name, nameNorm, createdById
            UNIQUE (tagId, nameNorm)
```

**`kind` and `ownerId` are not copied onto the alias.** They are read through `tagId`. A copy
would have to follow every scope change, facet change and merge, and a copy that drifted would
quietly change what a typed name resolves to. Scope stays a fact about the tag, as it is for
`MediaTag`.

**One name, one tag, per vocabulary.** Within one facet and one owner, a normalised name belongs
to at most one tag, either as its name or as an alias. That is what lets `ensureTag` treat an
alias as the tag: typing "Jane Smith" into any box — the item editor, either bulk apply, a
future parser — tags Jane Doe. The rule spans two tables, so like the ownership pairing it is
enforced in `tagRepo` (`setAliases`, `resolveName`) rather than by a constraint. Creating or
renaming onto a name another tag answers to is a 409 that names the holder. Moving a tag to
another facet is checked the same way against the facet it is moving to, for its name and every
alias. One taken there refuses the whole move rather than stranding a name.

**Merging keeps the folded name as an alias, by default.** The merge dialogue has a ticked
checkbox for it. Untick it for a stray typo nobody should be able to type their way back to.
The folded tag's own aliases move either way. Renaming offers the same checkbox **unticked**,
because most renames fix a spelling. Renaming onto one of the tag's own aliases with it ticked
swaps the two, which is the whole of "make primary" and needs no separate action.

Aliases are searched: the public ones are written into the search document beside their tag's
name, in the same column, and a private tag's are matched by its owner's tag search. The
vocabulary, facet and merge-picker boxes match them as prefixes, like names. Adding the column
needed **no index-stage version bump**. No aliases existed when the table was created, so every
document was already right, and each alias edit or merge reindexes the tag's items as a rename
does.

Editing aliases is curating, not using: `admin` for the library's tags, the owner for their own.
An alias changes what a typed name means for everybody who types it.

Tag filters are ANDed by default. Selecting two performers means items with both, because
OR as a _silent_ default would make every extra selection widen the result, which reads as the
filter being broken. "Any of" exists, but as an explicit, labelled mode a facet offers once two
values are picked, and "without" as a third state of each chip — both in §14e "Any, all and
without". The objection was always to OR nobody chose, and it stands.

**The panel shows the twenty most-used per facet, and says how many it is not showing.** The
cap is what keeps the panel usable — a facet on a real library runs to hundreds — and it is
also what hides the value somebody came for. So the count of hidden values is a control
rather than a note: "show all 340" opens that one facet in a modal, at a higher ceiling, with
a box to narrow it by name.

The twenty are a cap on the _display_, not on the query that found them: the values come from
the vocabulary rather than from a scan of the filtered library, so the list is complete before
it is trimmed and every value is reachable through the modal (§20). Ordering is by
library-wide use, which is exact and does not move when an unrelated filter does — the count
each chip displays is the filtered one, and ordering by that would make chips swap places on
every change.

**The box in the modal searches the server, not the list already on screen.** The expanded
view is a ceiling of 500, so filtering what had already been sent could never reach a
performer sitting past it — which is the one thing somebody opens that box to do.

A modal rather than the panel growing a scroll box, because the panel is a narrow column
beside the grid and a few hundred chips in it is a column of single words. The modal has the
width to wrap them and the room for the control that makes a list that long usable.

Expanded is **not** the same as complete, and the modal says so when it isn't
(`FACET_EXPANDED_LIMIT`). Thousands of chips is not a list anybody reads, it is a slow page —
so past the ceiling the honest answer is the number still hidden and the suggestion to narrow
the library first.

Expansion is a parameter of the _request_, never of `MediaQuery`. In the query it would ride
into every saved filter, every shared link and the grid's own cache key, and opening a list
would look like a different search.

**Promote to a real table only when a facet needs attributes tags cannot carry.** Two
concrete future cases, both pure additive migrations:

- **Person** — headshot, birth date, external ids. Migrate by adding `Person` and
  `Person.tagId`, keeping the existing `performer` tags as the join. Nothing re-tags.
- **Series** — `Media.seriesTagId` plus `Media.episodeNo`/`seasonNo` for ordering, which is
  genuinely per-media data and not a tag property.

For everything else scraped — source URL, release date, studio codes, arbitrary site
fields — **MediaAttribute** (`mediaId, key, value, source`) is a deliberate EAV escape
hatch. Rules: it is for _display and search_, never for logic; anything the app branches on
gets a real column. `Media.sourceUrl` is common enough to be a real column from the start.

**What a file says about itself** is the first thing to arrive here (2026-10-11), under
`source = 'embedded'`: a video's container `title`, `comment`, `description`, `artist`, `album`
and `show`. Sampled on the real library, about one video in fourteen carries any of them, and
where they say anything it is often the only record of who is in it or where it was posted — a
creator's handle in a comment, a site in an artist field. The other tags are the encoder
talking and are not kept; photographs carry nothing comparable and are not read. The `metadata`
stage keeps them, separate from the probe because a re-probe chains every rendering stage
behind it and this chains only the search document — so a version bump here is a cheap sweep.
It replaces only its own rows: a key somebody typed, or a scraper filled, keeps its value.
Markup is stripped on the way in, because descriptions arrive as the HTML of the post.

The values are shown on the item under **In the file**, absent when there are none, and they are
a mention field (`metadata`, "One rule for names" below): a handle glued into a comment —
`@AuntMargaret` — names Aunt Margaret, so the item is offered in her Find untagged and among the
performers its text names. Values only, so a tag that happens to be called "Artist" is not named
by every file that has one.

Two structural properties make all of this cheap:

1. `Media` holds objective facts, `UserMedia` holds opinions, and descriptive metadata is a
   third thing joined by `mediaId`. New descriptive tables never touch the other two.
2. The scanner's job chain (§7) is a list of independent stages, so a future `scrape` or
   `parseFilename` stage backfills the whole library without a rescan or a schema rewrite.

### One rule for names

"Does this text name this tag" used to have five answers. The search box, Find untagged, the OCR
matcher, the server's tag search and the client's tag box each matched names their own way, and
they disagreed: on accents (search found "zoe" for Zoë, the OCR fold dropped the ë and read
`zo`), on punctuation (`normalizeName` glued "Mary-Kate" into `marykate` while everything else
split it), and on a name inside a longer one. Decided 2026-10-06, one rule:

- **Accents fold** — "Zoë" is `zoe` — so Zoe and Zoë cannot become two tags. Letters with no
  plain equivalent (`æ`, other scripts) are kept.
- **Every separator splits** — spaces, hyphens, underscores, pluses, dots — so "Mary-Kate",
  `Mary_Kate`, `Mary+Kate` and "Mary Kate" are one name, and the glued `marykate` still matches
  through `squashName`. **Apostrophes join**: "O'Brien" is `obrien`.
- **A name inside a longer known name is not a second finding** — "Anna" in "Anna Smith" — and a
  short name only counts glued into a word at its start or end (§5c "Word boundaries").

`normalizeName` is the rule, and `Tag.nameNorm` stores its result; a migration renormalised the
stored names (15 rows changed, none collided). The name matcher (`ocrTagMatch.ts`) folds the text
it reads the same way, keeping each match's position in the text as read so the OCR review still
highlights and corrects what was there. Misreadings (`near`) are a switch: on for OCR text, off for
everything else.

**`MediaMention(mediaId, tagId, field)` is what that matcher found** in each item's own text —
`filename` (with its folders), `title`, `screen` (what OCR read), `metadata` (the file's own
tags, values only, §5b) — for every tag, private ones included. Facts, not decisions, written two ways: the index stage rewrites an item's rows whenever
it rebuilds the item's search document, from the same text; and the `mentionMatch` job rematches
the library whenever the vocabulary changes — any facet, any owner, coined, renamed, aliased,
merged, deleted or published — and once after startup, skipping a vocabulary it has already
matched. Both write only items whose mentions changed, outside the lock for their reads (§20).
Find untagged reads it (§5d); the Likely sections planned for tag pages will read the same rows
as their "name in the filename" and "name on screen" evidence, so there is no second rule to drift.

The search box itself is unchanged: typed text is not a name, and it still finds glued spellings
through the `variants` column (§5c), which follows the vocabulary only as items are reindexed.

## 5d. Tagging from a search, and text in the picture

The two halves below are usually described as one feature. They are not, and the second is
useful without the first — which is why the cheap half is built and the expensive one is
still waiting for evidence that it earns its cost.

### Bulk tagging from a filter — built

Select a filtered set, review it, tag what is checked. On a library whose filenames are
unreliable this is the fastest route from 200k untagged items to a usable collection, and it
is also the only action in the app that can be wrong about tens of thousands of items at
once. Three properties make it safe to attempt:

- **Scoped undo.** A batch withdraws exactly the rows it wrote. Bulk tagging without this is a
  one-way door, and one careless query mislabels fifty thousand items.
- **A preview before committing.** The count of what will be affected, shown before the
  action, not after — and the apply is refused if that number has changed since, because the
  person agreed to a number and the library is allowed to move underneath them.
- **Per-item exclusion.** A filter is an approximation of intent; the checkboxes are where it
  gets corrected.

**Undo is keyed by batch, not by `source`.** The original plan was to write bulk tags with a
distinct `MediaTag.source` so they could be told apart from typed ones. Two things were wrong
with it. A bulk apply _is_ a person's judgement — just exercised in quantity — so labelling it
alongside `filename`, `ai` and `ocr` would make it read as machine-derived to every future
consumer of that column, including the confidence UI that exists precisely to mark suggestions
as less trustworthy. And one source value cannot distinguish two bulk operations from each
other, so "undo what I just did" would have been "undo everything ever done in bulk".

So `MediaTag.batchId` references a `TagBatch` row, and withdrawing deletes by batch. The
property that matters falls out of the unique index rather than out of a label: an item that
already carried the tag is skipped by `INSERT OR IGNORE`, its row never joins the batch, and
the undo cannot reach it. A tag somebody typed by hand survives a bulk apply that covered the
same item and the withdrawal of that apply.

The `TagBatch` row outlives its assignments. After an undo there is nothing left to describe
what happened, and "you tagged four thousand items and then changed your mind" is what a
person needs to see before trusting the feature a second time. Its summary is denormalised
text, so a tag renamed or deleted afterwards cannot rewrite the history of what somebody did.

Bulk tagging records no `ChangeLog` entries. Tags do not appear on a grid tile, so no open
grid has anything to patch, and ten thousand rows in a table read every second would cost
every other client far more than the update is worth (§13b).

### Find untagged — built

A tag page's **Find untagged** opens the grid on the files whose text names the tag — its name
or any alias, in a filename, folder, title or anything else indexed — and that do not carry it
yet: `/?mentions=<id>&notTags=<id>`. It is the shortest loop from "Aunt Margaret exists as a
tag" to "everything that says Aunt Margaret is filed under her".

**The grid, not a review list on the tag page.** What follows finding is ticking and tagging,
and the library already does both, with the safety this section requires of a bulk write —
paging, a selection you can see, a count before committing, a batch that can be withdrawn. A
second list on the tag page would be a second copy of all of it. What the grid lacked was
knowing which tag the session is about, so it is told: with `mentions` set, the selection bar
leads with a filled **Add ‹tag›** that tags what is ticked in one click, and **Tag all as
‹tag›…** opens the filter-wide dialogue already holding the tag, in its own facet and audience.
Tagged items leave the result, because the filter excludes the tag, so the next page of
candidates is what remains.

**"Not ‹tag›" beside it** (2026-10-08). A common first name or a short alias names files that are
somebody else, and a list that cannot be cleared stops being looked at. So the bar also offers
**Not ‹tag›** for what is ticked: an `ItemRefusal` row per item and tag (it was
`MentionRefusal`; see "Decisions you can take back"). The match stays in
`MediaMention` — it is a fact about the text — and the mentions filter (both its forms, the
membership test and the driven source) leaves refused items out, as a performer's "Likely" does.
Whoever may file things under the tag may say it: an administrator for the library's tags, the
owner for a private one (`mentionService.ts`).

**Its own parameter, not the search box, and a stored fact, not a query.** A tag's names are
alternatives and the box ANDs what is typed (§5c), so `mentions` was its own FTS expression —
each name ORed as a phrase and as its glued spelling. That answered a different question from the
one asked, three ways: it searched the whole document, so "Anna" found every item _tagged_ "Anna
Smith" through the performers column; it could not tell "Anna" alone from "Anna" inside a longer
known name; and a name glued inside a longer word (`xxauntmargaretbeach`) reached it only through
the `variants` column, which an item gets when it is next indexed — never, for the untagged items
that are this feature's whole population, after a tag is coined. Now it reads `MediaMention`
(§5b "One rule for names"): what the one name matcher found in each item's filename and folders,
title and on-screen text. A phrase rather than the words anywhere is still the rule — "Margaret,
an aunt of nobody" is not her. It composes with everything else, the search box included, so
"names Aunt Margaret, mentions beach" is one more word typed; and it starts from the tag's few
mentions or walks the library, whichever is cheaper (§20), as the FTS form did.

Somebody else's private tag mentions nothing — an id in a shared address is not a reason to
search for what that person privately calls something. The table holds every tag's mentions,
private ones too; whether the viewer may ask about the tag is the query's rule.

### OCR

Burned-in text — studio cards, performer name cards, site watermarks, URLs — is frequently
the only trustworthy metadata a file carries, because the filename is often noise and there is
no sidecar. Extracting it feeds the same search index everything else feeds, and then the
feature above tags against it.

What the existing design already provides:

- `MediaTag.source` reserves **`ocr`**, so OCR-derived tags are distinguishable from typed
  ones, from filename parsing, and from AI inference. The value is reserved now because it is
  enforced by a CHECK constraint, and SQLite cannot alter one after release without rebuilding
  the table.
- `MediaTag.confidence` already exists, so OCR output can arrive as suggestions to confirm
  rather than assertions to trust.
- The `index` stage's `version` in the stage registry (§7b) means adding an `ocr` column to
  the search document is a version bump and a gradual backfill through the ordinary job
  queue, not a migration — so the FTS table is deliberately **not** carrying an empty column
  for it today. This used to say `Media.searchVersion`, which is one of the four conventions
  `MediaStage` replaced and no longer exists.
- The registry also already carries the three things an OCR stage needs and nothing else
  has: `mode: "optIn"` for a capability that must be opt-in, `state: "empty"` for "ran
  and there was no text", and `appliesTo` to separate stills from video.
- `normalizeName` maps `JANE DOE` onto the performer tag that already exists.

What it would need that does not exist: a per-frame table, `MediaText(mediaId, atMs, text,
confidence)`. Per-frame rather than per-item, because the timestamp is what lets a reviewer
jump to the frame and confirm a suggestion in one click instead of scrubbing for it.

**`MediaAttribute` is the wrong home for this.** That is an EAV escape hatch for short scraped
fields, for display and search only (§5b); OCR produces bulk text with positions and
confidences, and forcing it through a key/value table would lose the timestamp that makes it
reviewable.

### The three risks, and what was decided about each

Settled 2026-09-21, when OCR moved into v1. The risks are unchanged; these are the answers.

1. **Cost.** Per-frame recognition across 200k videos is far more expensive than anything the
   pipeline currently does, on hardware already sharing CPU with ffmpeg. It has to be opt-in,
   lowest priority, and targeted — title cards live in the opening seconds and watermarks are
   persistent, so the middle of a scene is mostly wasted work. Sampling strategy is the
   difference between "runs overnight" and "never finishes".
2. **Quality.** Text over moving, compressed video is a hard case. Without aggressive
   confidence filtering the index fills with noise, and a polluted index is worse than no OCR
   at all because it degrades the search that currently works.
3. **A new native dependency.** The same decision as sharp versus ffmpeg in §10: Tesseract
   native is fast but is another thing to build into the QNAP image, while `tesseract.js` is
   WASM with no native dependency and several times slower.

**Text, not tags.** v1 produces searchable text and nothing else. `MediaTag.source = 'ocr'`
and `confidence` stay reserved for the tagging that follows, and the reason for the order is
risk 2 pointed somewhere worse than search: a shared tag vocabulary is curated by hand and
read as fact, so filling it with recognition noise costs more than a few bad search results
and is far harder to undo. Search is where low-confidence text is survivable, because a
wrong hit is visibly wrong and costs one glance. The tagging that follows ("Tagging performers
and sources from what was read", below) keeps to this: a person decides that a piece of text
names somebody, once. Recognition reading that same text again on a new item is what applies the
decision there, and recognition alone never makes one.

**Sampling is tiered, and the arithmetic is the reason.** 200k items at fifty frames each is
ten million recognitions; at even 100 ms apiece that is some 280 CPU-hours, on hardware
already sharing CPU with ffmpeg. That is the "never finishes" case in risk 1, stated in
numbers. What makes it tractable is that **most files carry no burned-in text at all**, so
the strategy is built to spend almost nothing on them and to stop early on the rest.

Frames are extracted with **one ffmpeg call per position**, and recognised in **one Tesseract
call per pass**. That is the reverse of the shape first designed here, and the measurement is
why. An `fps=` filter has to decode everything between the frames it keeps, and the sweep's
frames are minutes apart — on a two-hour film that is decoding two hours of video to keep
twelve frames, against twelve keyframe seeks. Recognition is where the process starts actually
cost something: Tesseract loads its language data per process, and a batch handed a file list
measured **30 ms a frame against 131 ms** spawning one process each, a 4.3x difference for no
change in what is read.

- **Pass 1, the probe. Every item, about six frames**: three across the opening thirty
  seconds, three spread through the body — the opening because that is where a card would be,
  the body so that a file whose only text is a watermark is not eliminated for having an
  unmarked first minute. If nothing **recurred in the same place** and nothing cleared the
  storage floor, the stage records `empty` and stops.

    Both halves of that test were arrived at by being wrong twice. A probe that accepts any
    observation eliminates nothing at all — recognition returns _something_ from almost any
    frame — so the pass that makes the feature affordable silently stopped working, and
    measured 0% eliminated. But the fix for that, requiring one frame to clear a confidence
    floor, contradicts the premise the reconciler rests on and threw away a file whose watermark
    read at 0.31 in _every_ frame. Recurrence is the signal; per-frame confidence is not. The
    probe also does not run at all when the whole pass is small, because eliminating a
    ten-second clip saves one frame and can cost the file.

    This is the exit for the majority of a library and the single largest cost decision in the
    feature: it makes the common case six frames rather than fifty.

- **Pass 2, the opening burst. Only items that passed the probe**: every few seconds across
  the opening, where title and name cards live -- thirty seconds every three since the
  production calibration (below), from sixty every two. A card sits on screen for several
  seconds, so that is dense enough to catch one and sparse enough not to read the same static
  card twenty times.
- **Pass 3, the watermark sweep. Only items that passed the probe**: one frame every few
  minutes, stopping as soon as a string is _confirmed_ — same box, same normalised text, a
  minimum number of observations. Sampling past that adds occurrences and no information.

Each frame is preprocessed in ffmpeg before it reaches the engine: greyscale, scaled to a
fixed width, contrast stretched. Larger is not better past a point — Tesseract slows with
resolution and gains nothing on the large text this is looking for. The engine was built to run
in **sparse-text mode** (`--psm 11`) rather than its default, which assumes a page of document
text, at 1280 wide; the production calibration moved it to a uniform block (`--psm 6`) at 1600
wide with the strong contrast stretch, and those are the defaults now (see "Settings and the
test bench").

**Thresholds come from the library, not from a guess**, which is what `scripts/ocr-calibrate.mjs`
is for: it surveys a folder and reports distributions, timings and a grid of how many
findings survive each threshold pair, printing no recognised text and no filenames. Some
libraries cannot be shown to whoever is tuning them, and that is the ordinary case rather
than an awkward one.

Every lever is a `Setting` (§12): the opening window, both intervals, the cap on frames per
item, the confidence floor, the minimum length, and the confirmation count. They are what an administrator would
actually reach for when it runs too slowly or too noisily, and the right values depend on
the library.

Reusing the frames the pipeline already extracts was considered and rejected. It would cost
no ffmpeg at all — the cover and four posters are already on disk — but they sit at
10/30/50/70/90%, and 10% of a two-hour film is twelve minutes in, well past any title card.
It would systematically miss the highest-value text in the library.

**Native Tesseract**, resolved the way ffmpeg already is: an explicit env override, then
PATH, then failure with a message naming both. Risk 1 ranks first and WASM is several times
slower on exactly the hardware that cannot afford it. The image gains one package and the
English `traineddata`; development on Windows uses whatever is on PATH. English only — each
enabled language is scored against every frame, so an unused one is a permanent tax.

**A stage in the registry, `optIn`.** No schema change and no new machinery: the registry
carries `mode` precisely for a capability that must be opt-in, and an administrator turning it
on through §7b's processing controls is what starts the ordinary backfill, at the lowest
priority, inside §7c's working window. Promoting it to `automatic` later is a one-line edit.

`optIn` rather than `perItem` is the entire difference between a capability somebody can use
and one they can only demonstrate: recognition is worth having across a library, and a
library-wide result assembled by clicking eighteen thousand items individually is not a
result anybody will ever have. `state: "empty"` is what keeps a frame with no text from being reprocessed
for ever — the distinction the stage table exists for, and OCR is the capability that needs
it most, since most frames contain nothing. `appliesTo` is `all`: a still is one frame and
nearly free, and screenshots are where recognition is most accurate.

**Read from the original, never the web-safe rendition.** The same rule as a captured frame
(§13): a rendition is a re-encode, small text is the first thing a re-encode destroys, and
OCR on a downscale of a downscale is the worst input the engine could be given.

### Reconciling what the frames say

A watermark is read slightly differently in every frame it appears in: `PRIVATE STOCK`,
`PRIVATE ST0CK`, `PRlVATE STOCK`. Collapsing by **exact** string — which is what this
section said first — turns one watermark into three rows and splits the occurrence count
across them, defeating the recurrence argument at exactly the input where it was supposed to
be strongest. So the readings are reconciled before anything is stored.

**Position first, because it does not depend on the text being read correctly.** The engine
returns a bounding box and a confidence per line. A watermark occupies the same box in every
frame, so observations whose boxes overlap across frames are the same object however badly
any one of them was recognised — a far stronger signal than string similarity, and available
free from the same call. Boxes are stored as fractions of the frame, so a resolution change
does not break the grouping.

**A minimum length, measured rather than guessed.** Three quarters of everything recognised
on a real library was one or two characters — fragments of graphics, artefacts, single
letters lifted out of a texture. Burned-in metadata is essentially never that short, so one
rule removes most of the noise before any other threshold is consulted. **Four**, set by
reading the output on a real library rather than by reasoning about it: three-letter
identifiers are real and this loses them, but almost everything at three characters was
noise, and a floor is only worth having where the noise actually is. Recovering a
broadcaster's initials is a job for a better reading of the frame, not for admitting a band
that is overwhelmingly junk.

**A finding is stored when a second frame saw it, not when it was read confidently.** The
floor is confidence 0.5 with at least two occurrences (0.45 until the production calibration),
set against rows a person confirmed were correct on files this code cannot see — the weakest
of them read 0.54 across two frames, so the floor sits under it rather than on it. Corroboration rather than stability,
because stability is occurrences over frames sampled and therefore scales with runtime: one
confirmed finding scored 0.29 on a seven-frame item and would have scored 0.05 on the
forty-frame files beside it, so a stability gate discards real text for a reason that has
nothing to do with the text. Stability stays as the ranking signal it is good at — a permanent
watermark against a title card. Erring low is deliberate: a junk row is visible in the details
panel, dismissible and weighted below curated metadata, while text that was never stored is
invisible. The rule is `isWorthStoring`, kept out of `reconcileText` so that calibration can
still see everything the frames said — a survey that could only see what survived the floor
could never show where the floor belongs.

**A fragment is not a second finding.** Recognition routinely reports both
`example-site.com` and the `ite.com` it managed on a worse frame. They share a position and
one contains the other, so the shorter is absorbed into the longer, which keeps the _union_
of their frames rather than the sum — both were usually read from the same frames, and
adding the counts would claim corroboration that does not exist. Containment rather than
overlap decides it: a fragment sits inside the thing it is a fragment of, so
intersection-over-union reads low exactly when the two are most obviously the same text.

**What is absorbed corroborates but does not vote.** A fragment is evidence that the object
was on screen in that frame, and nothing at all about how it is spelled — the one thing
already known about it is that it is a partial reading. Merging fragments in as voters loses
the string absorption exists to protect, and loses it in the _common_ case: a watermark only
sometimes read in full is read in part more often than in full, so the fragments arrive as the
majority, carry the modal length, and elect themselves. Measured on a real file — the two most
frequently recognised strings were both substrings of the correct third, and the merge handed
them the election. So absorbed readings count towards occurrences, timespan and stability, and
are excluded from the character vote.

**The probe asks about recurrence, not about one frame's confidence.** It keeps a file if any
probe reading clears the floor _or_ if anything at all appeared twice in the same place. The
first version demanded a single confident reading, which contradicts the claim the rest of
this section rests on — that per-frame confidence is unreliable and recurrence is the signal —
and it discarded a faint watermark read at 0.31 in every frame, which is precisely the file
this feature exists for. It also skips the probe entirely when the whole pass is small:
eliminating a ten-second clip saves one frame and can cost the whole file.

**Both the length floor and absorption are switchable, because both are judgements.** They
are claims about what recognition tends to do, not facts about it, and pooled over a library
a rule that deletes one real watermark and a rule that deletes four hundred noise clusters
read identically: fewer rows. So `scripts/ocr-calibrate.mjs` reconciles the same observations
three ways — as configured, without the length floor, without absorption — and reports each
file's strongest cluster under each, flagging any file that is stronger with a rule off.
Reconciliation is pure and costs nothing beside recognition, so every run can afford to say
which rule a lost detection belongs to instead of leaving it to be inferred from two reports
taken days apart.

**Then similarity within a positional cluster**, by edit distance relative to length, so that
genuinely different text appearing in the same corner does not merge into one string. For
this comparison only, confusable glyphs are folded together — `0`/`O`, `1`/`l`/`I`, `5`/`S`,
`8`/`B`, `rn`/`m`. Folding decides _whether two readings are the same_; it never rewrites
what is stored.

**Then elect by weighted vote, not by maximum confidence.** Taking the single most confident
reading lets one lucky frame carry a wrong answer and discards the corroboration that made
the cluster worth forming. A character-wise vote across the aligned readings, weighted by
each reading's confidence, can produce the correct string _that no individual frame
produced_ — which is the whole value of having sampled more than one. Highest confidence
breaks a tie, and a cluster below a minimum number of observations is not voted on at all.

### What is stored

`MediaText` holds **one row per reconciled string**: the elected `text`, a normalised form
for matching, the earliest and latest `atMs`, the elected confidence, the mean bounding box,
`occurrences`, and `stability` — the fraction of sampled frames the string appeared in.

`stability` rather than a bare count, because a count is not comparable between a
three-minute clip and a three-hour film. It also separates the two kinds of burned-in text
for nothing: high stability with a fixed box is site identity, low stability with early
timestamps is a title card. Derivable from what is stored, so neither is recorded twice.

The earliest `atMs` is what a reviewer needs to jump to the frame. The latest gives the span
a string was present for, which costs one column and answers "is this the whole film or one
scene".

**Deferred: corroboration across items.** The same site watermark appears on thousands of
files, so a string confirmed on many _items_ is near-certainly correct and could snap
near-misses on new ones toward it. Genuinely powerful and it needs a library-wide string
vocabulary, which is more than v1 needs — recorded here so it is not rediscovered as a gap.

This is a change from the per-frame `MediaText(mediaId, atMs, text, confidence)` this section
described before the feature was scheduled. `MediaAttribute` remains the wrong home for the
reason it always was (§5b).

Text reaches the search document as its **own column**, weighted **below everything a person
curated and above a scraped blurb** — level with a library note. Both halves are deliberate.
Below the curated fields because recognition elects a reading and can elect a wrong one, and a
wrong term carrying a high weight does not merely fail to help: it pushes good matches down,
which is worse than not having the column. Above `attributes` because a watermark is about the
item itself, and is frequently the only trustworthy metadata a file carries, while a blurb
mentions many things in passing.

Every stored finding goes in, not only the confident ones. The floor that decides whether a
finding is worth a row was already applied when it was written, and a second floor here would
let the Details panel and the index disagree — somebody would read a string off the panel,
search for it, and get nothing.

Adding the column is an `index` **stage version bump**. A document written before the column
existed is not wrong, it is short, and without the bump an item whose watermark names its
studio stays silently unfindable by that name. `needsWork` treats a recorded version below the
stage's as outstanding, so the backfill rebuilds existing documents by itself.

### What it looks like

The item's Details panel lists what was found, each line jumping the player to the frame it
came from — which is the whole reason the timestamp is stored. Without that, a search hit on
text nobody can see reads as a bug, and there is no way to tell good recognition from noise
except by searching for something and seeing what comes back.

### Reviewing what was read

Watermark text is read badly often enough that searching it is only as good as somebody's
willingness to fix it. So an administrator can **confirm** a finding, **correct** its text, or
**dismiss** it as not text at all, and undo any of the three. It is admin-only, as duplicate
review is: a correction changes what everybody searches, which is curation of the library.

**A decision survives the machine.** A run used to replace an item's findings wholesale, which
would erase every correction the next time the item was read. Now `replaceMachineFindings`
replaces only the rows with no `reviewState`. The run's own readings of a reviewed string are
dropped by `keepReviewed` (`packages/core/src/ocr.ts`), so a dismissed watermark does not come
back and a corrected one is not shown twice, once fixed and once misread. A new reading counts
as the reviewed string if either:

- its normalised text equals the reviewed row's current or original text, or
- its box overlaps and its folded text is similar, by the reconciler's own thresholds. That
  catches a misreading one character away from last time's.

**Dismissed rows are kept, not deleted.** This is the one place the table holds a row nobody
sees, and it is a lifecycle state rather than a soft delete, for the same reason as `TrashEntry`:
the row is what tells the next run "seen and rejected". Everything that _uses_ the text (the
details panel for everyone but admins, and the search index) reads through `listForMedia`, which
leaves dismissed rows out.

**Corrections are one-off, not rules.** Correcting "P0RNHUB" on one item does not rewrite it on
an item read next week. A library-wide rewrite rule was considered and deferred: it would
silently rewrite text nobody looked at, which is the risk the review exists to remove. The one
correction that does reach every item showing a string is a misreading that names somebody, made
when its match is accepted ("A misreading is corrected, not aliased", below).

An identical copy (§10f) borrows its twin's findings _with_ their decisions, because the same
bytes say the same thing.

**Text is reviewed where it is read: in the item's details, not in a list.** The review page used
to list every distinct string, and every item with its strings, for confirming, correcting and
dismissing. Both lists were removed on 2026-10-06. Checking text for its own sake is a queue
that never ends: of 5,768 strings on the production library, 4,577 had been read on one item
only. Its badge counted the work nobody meant to finish, and it hid the one count that matters,
which is the items whose text names somebody (below). Text is corrected in the details drawer
now, by administrators, through the same endpoints acting on findings by id. A string dismissed
there stays on screen, struck through, with its undo, until the drawer closes. The test bench's
"Copy from reviewed strings" reads the same details.

`MediaTextString`, the per-string summary the list was built on, stays. The matcher walks it,
and the Rules list (below) pages in the order of its count index. It is kept by triggers, never
by application code, for the reason the `Media.list*` columns are (§20): a stale summary is a
string that silently drops out of matching. The four indexes that served only the string list's
sorts and its default filter went with the list, because the triggers wrote each of them on
every finding.

**Pages continue from a cursor, not an offset.** This departs from the grid (§20) on purpose:

- A review queue has no use for "jump to page 40".
- It shrinks as it is worked through. Tagging the twenty items on screen moves the next twenty up
  into an offset already read, so an offset would skip them unseen.
- A cursor resumes after the last row seen, whatever was removed before it.

The lists draw only the rows near the screen. No total is computed while scrolling; the queue's
count is one query over the open pairs, which are few.

**Each row is shown beside its frame.** The thumbnail is the tile of the item's own sprite sheet
at the moment the text was read, with its box drawn on it. The sheets already exist for the
scrubber, so this costs nothing, and the box often settles the question at a glance: a box over
a face is not a watermark. `spriteTileAt` is the arithmetic the VTT is written with, so the two
cannot disagree about which picture belongs to which moment. Without sprites the cover stands
in, with no box, since it is a different moment.

### Settings and the test bench

The levers were constants calibrated on one library (`scripts/ocr-calibrate.mjs`). They are now
a `Setting` row, `ocr`, whose defaults are constants in the source. There are three groups,
trading three different things:

- **Storage floors**: what is kept. These are cheap to change and are the first thing to reach
  for when the queue is mostly junk.
- **Sampling**: which frames are read. CPU against the chance of catching text.
- **Recognition**: how each frame is read. The layout mode, the frame width, and an opt-in
  strong contrast stretch for faint watermarks. These are the biggest lever on watermark
  quality.

**The defaults are the production calibration.** The settings were tuned on the production
library's test bench (nine videos) and saved there as revision 1 on
2026-10-02; the source defaults were then set to exactly those values, so a new library starts
where that one ended. Against the first calibration: confidence floor 0.45 → 0.5, opening burst
60 s every 2 s → 30 s every 3 s, sweep every 180 s → 300 s, frame cap 60 → 40, layout mode
11 → 6, frame width 1280 → 1600, contrast stretch off → on. The occurrence floor (2), minimum
length (4), probe (6 frames) and confirmation count (6) were unchanged. `ocrSettings.test.ts`
pins the whole set, so changing one is a deliberate recalibration recorded here.

The cost of moving defaults: an outcome with no recorded recipe counts as revision 0, read with
"the defaults" (`OCR_RECIPE_UNRECORDED`). In a library that had never saved its settings, what
it read before the change and what it reads after are both revision 0, so the earlier reads do
not show as out of date. Production saved its settings before the change and is unaffected.
Another library that matters would need its revision advanced before those reads show as
outdated -- saving a changed value does that; saving the defaults unchanged does not.

The page saves them through its own route rather than the admin settings object, because saving
does two things the generic save does not: it advances a **revision**, and it reports how much
of the library that leaves reading under older settings. Saving unchanged values does not
advance the revision.

**Where they live: Processing › OCR, one form, collapsed.** The review (the queue of names) is
in Review › OCR; the settings sit with the other stages, with OCR's on/off switch at the top of
them. The three groups are collapsed by default, each summarising its values on its header and
marked where it differs from the defaults; field explanations sit behind an info icon. There used
to be two copies of the form — one to save, one for the bench — and three buttons that made
settings live. Now the form's unsaved draft _is_ the bench's candidate: "Compare on bench" reads
the bench videos with it, a tuning result loads into it, and **Save is the only path** that
changes what the library is read with. The bench still stores one candidate per video beside the
current settings (`OcrTrial`); only where the candidate comes from changed.

### What happens when OCR settings change

**A change governs what is read from then on. It never re-reads anything by itself.** Re-reading
200k items because a floor moved is hours of CPU, so it is always an explicit choice.

- **Finished items keep their text.** Each OCR outcome records the revision that produced it as
  its recipe (`MediaStage.recipe`, §7b), so the library knows which items were read under older
  settings. They are not re-queued, because the stage `version` did not change. A version bump is
  for a better _recipe_, which every item deserves; a settings change is a preference, which only
  the admin can say is worth paying for.
- **Queued jobs use the new settings.** A job reads settings when it starts, not when it is
  queued, allowing for the worker's settings cache of about half a minute.
- **Running jobs finish with the settings they started with.** Settings are read once per job,
  so one file is never read under two sets, and the outcome records the older revision.
- **Identical copies** (§10f) borrow a twin's text only if the twin's recipe is current.
- **Floors discard rather than hide.** A lower floor shows more text only on items read again.
- **Catching up is a button.** "Re-run these" queues the outdated items as ordinary background
  work at OCR's own priority, with no requester. They therefore wait their turn and respect the
  working window (§7c), unlike a per-item request. It queues in batches that can be stopped
  between. Reviewed strings survive, as on every run.

### The test bench

A few nominated videos (at most 20, in a `Setting` row) are each read twice: once under the
current settings and once under a candidate, side by side. Strings only one side read are marked,
which is usually the whole answer: a candidate that finds the watermark the current settings miss,
or one that adds three lines of junk for it.

- **Both sides are read fresh.** Comparing a candidate against the stored text would compare it
  against whatever settings that text was read under, which after a few changes is nobody's.
- **It reads through `readText`**, the code the `ocr` job reads with, so the comparison measures
  the settings and nothing else.
- **Results are scratch.** They go to `OcrTrial`, never to `MediaText`, and each run replaces
  the last.
- **One `ocrTrial` job per video runs every pending trial it has**, and keeps going until none are
  left. The queue holds one pending job per item and kind, so a comparison started again
  mid-run is picked up by the running job rather than dropped.
- **It is requested work.** Somebody is waiting at the bench, so it goes ahead of background work
  and outside the working window. It is `CPU_BOUND` like `ocr`.

"Use the compared candidate" saves the settings the latest comparison actually used, not whatever
the form has been changed to since. After that, everything in the previous section applies.

**Known limit:** a trial whose job is lost to a worker crash stays "running" until the next
comparison replaces it. Recovering it would mean a sweep for a table whose every row is
replaced the next time anyone presses Compare.

### Tuning against expected text

Comparing one hand-made candidate at a time is guesswork across twelve settings. So the
administrator says what each bench video _should_ read, and the tuner searches for the settings
that read it with the least junk and the fewest frames.

**It is a search, not a model.** With typed ground truth there is nothing for an AI to infer:
every candidate can be scored exactly. An LLM was considered, as a labeller, as an advisor
proposing settings outside the grid, and as a replacement reader. All three were deferred:

- **Labelling** would make its misreadings the target.
- **The advisor** is speculative where the grid already reaches the target.
- **A replacement reader** would send frames off the box and cost money per frame across the
  library.

**What it is scored against.** Each nominated video carries `expected` strings and a `complete`
flag (the `ocr.testSet` Setting; the old list-of-ids shape is read as entries with nothing
expected).

- **Matching is by word, folded the way the reconciler compares** (`scoreVideo`,
  `packages/core/src/ocrTune.ts`), because sparse mode reads a banner as three findings. An
  exact word earns 1, a near one 0.7.
- **Junk counts only on a video marked complete**, so partial labelling never punishes settings
  for finding real text.
- **The score** is recall, minus half the junk rate, minus a chosen weight times the frames read
  beyond the current settings'.

**Why it is affordable: reading is cached and everything else is replayed.** Only recognition
(layout mode, frame width, contrast) changes what Tesseract sees. Sampling and floors choose
among frames already read.

- The tuner reads each video's frames once per recognition config into
  `dataDir/ocr-tune/<mediaId>/<config>.json`, a derived cache keyed to the file's size and mtime.
- Every candidate is then **replayed** through `runReadPlan` (`packages/core/src/ocrRead.ts`).
  That is the same three-pass driver the `ocr` job reads with, given a reader that answers from
  the cache. A simulated read is therefore what the real job would have done with those frames,
  by construction rather than by a second implementation.

**Three stages, each narrowing the next:**

- **Recognition.** "Quick" walks one axis at a time and keeps the best of each (about seven
  configs). "Thorough" tries all eighteen.
- **Sampling.** A 972-combination grid for the best one or two configs. Their frames for the
  whole grid are read in one batch first.
- **Floors.** A 144-combination grid for the best five so far, replay only.

A run evaluates hundreds to thousands of candidates. The cache survives across runs, so tuning
again after adding expected text reads nothing.

**Three answers, not one:**

- the most expected text read;
- the best score at the chosen cost weight;
- the same quality as now for fewer frames, if one exists.

Each can be compared on the bench, which reads both sides for real, or used directly. "Use"
saves through the settings route, so everything in "What happens when OCR settings change"
applies.

**Before it starts, the page says what it will read**, from the same plans and cache the worker
uses, at the frame rate the last run measured.

- The run is one requested `CPU_BOUND` job, with progress on its row.
- It is stopped like a transcode: its job is marked cancelled and its next heartbeat aborts it.
- A failure is not retried. Whatever was read stays cached, so starting again resumes.

### Tagging performers and sources from what was read

Built 2026-10-04. Reshaped 2026-10-06 around items and rules.

Many stored strings name a performer or a source. Name cards do, and so do watermarks, which
often carry the performer's name beside the provider's address. So one string can name both.
A performer's Find untagged already reaches exact readings through `mentions`. But it starts
from the performer, one page at a time across a thousand of them, cannot see a misreading, and
shows no frame. This review starts from the text instead, and it is the whole of Review › OCR.

**What it is for: keeping the names up to date as the library grows.** The question an
administrator brings is "which new items name somebody?". It is not "is every string read
correctly?" (that was the Strings list, removed above), and not "which strings have been read
the most?". Everything below follows from that.

**The queue is items, newest first.** A row is a video or a still with at least one open pair: a
string it shows, a tag that string names, nobody has decided, the item does not carry the tag
and was not left out of it. Rows are ordered by when the match appeared — the later of when the
item was read and when the pair was made — so a video read today and an old video a performer
added today both come to the top. A badge says which it was: "New item", or "New name" when every
name it matches was coined after it was read.

**It opens on videos.** A Videos / Photos / All control over the queue, each kind's waiting count on
it, and the review nav's OCR count is of videos — the number beside the link is what the link opens
on. Photos are still read and matched; the collection is mostly video and photos are the exception,
so they wait behind the control rather than filling every page of decisions (decided 2026-10-09).

- The row shows the frame, the file, and each string it shows with what named somebody picked
  out. Each candidate tag has a tick, and says how many items it tags: this one, and the others
  showing the same text. "Check the others" lists them, each with a tick to leave it out.
- Three decisions: **Tag** (accept the ticked pairs), **Not on this one** (leave this item out;
  the pairs stay open for the rest), and **Never for this text** (reject the pairs).
- Keys: `j`/`k` move, `a` tags, `s` leaves this item out, `d` marks never, `o` lists the others.

It was a row per _string_, ordered by how many items the string was read on, which is how much one
decision settles. That was the right shape for clearing a backlog. It was the wrong one for
keeping up: a new video showed up as an "accepted · 1 new" chip on a string row from weeks
before, and nothing on the page said what had arrived since the last visit. With the backlog
cleared (720 pairs on 2026-10-06, none ever rejected) the queue holds only what is new, and that
is measured in items. One click on a watermark row still settles every item showing it, and
those rows leave the queue at once.

A row per _pair_ was considered too, and would put `janedoe · examplesite.com` on screen twice,
separating two decisions that are obviously made together.

**Performers and sources, public only.** Those two facets are names, and names are what burned-in
text carries. Keywords are short ordinary words, so matching them against bulk text mostly finds
noise. Private tags belong to one person's vocabulary, and this review curates everyone's.

**How a string matches** (`matchTagNames`, `packages/core/src/ocrTagMatch.ts`), against every
name and alias:

- **exact**: the whole string is the name.
- **contains**: the name as a phrase within it, or glued (`janedoe`, `examplesite.com`). Glued
  matching uses §5c's word-boundary rule, through the same helper the index's `variants` column
  uses: six characters or more match anywhere in a word, four or five only at its start or end.
- **near**: equal once the reconciler's confusable glyphs are folded (`JANE D0E`, `VALENTlNA`),
  or one edit away from that. One edit, rather than the reconciler's similarity threshold,
  because a threshold loose enough to forgive a misread name also joins names that differ by a
  letter. The one-edit rule applies only to names of six characters or more (folded, spaces
  removed): at five a single edit is a fifth of the name, and `Nina` is one letter from `Nine`,
  `Gina` and `Ninja`. Folded equality goes down to four, because it claims only what the
  reconciler already believes. The lookups go through a deletion neighbourhood, so a string
  costs a few hash probes rather than a comparison with every name.

The words are tried as they were read and as their camel-case parts. Each finds what the other
cannot: `JaneDoe` is two words only once split, and `D0E` or `VALENTlNA` is one misread word that
splitting at its digit or its stray lowercase letter would break apart.

Overlapping matches keep the longest, so "Jane" does not also propose itself inside "Jane Doe".

**A confirmed match is a person's tag.** Accepting writes `source = 'user'` with a `TagBatch`,
for the same reason bulk tagging does (above): the decision is a person's judgement, exercised
in quantity. The batch summary names the string it came from, which is the provenance. One batch
per string, even when one row accepts pairs from two of its strings, so that withdrawing one rule
leaves the other.

**A misreading is corrected, not aliased.** Accepting a near match first runs a whole-string
correction, replacing the misread span with the tag's name, so search is fixed as well as the
tags. Adding the misreading as an alias was rejected. An alias is a name people use for the tag,
`JANE D0E` is not one, and the vocabulary is shared and read as fact. That is the risk "Text, not
tags" was written to keep out.

**Decisions are remembered per pair**, in `OcrTagMatch(textNorm, tagId, kind, state, …)`. A
rejected pair never returns. Items left out are remembered per pair (`OcrTagMatchSkip`), whether
at an accept or by "Not on this one". Pending pairs that stop matching are dropped on the next
run. Decided pairs are kept.

### An accepted pair is a rule

Until 2026-10-06 an accepted pair came back as "accepted · N new" whenever the string was read on
another item, and nothing was tagged without a click, even on an exact match. The reasoning was
the one corrections follow: a rule tags items nobody looked at. Two things changed that.

- **The decision is not about the item.** "`JANE DOE` names Jane Doe" was decided by a person
  who looked at the frame. A new item showing the same string — the same normalised text — adds
  nothing for a second person to judge, so asking again was confirmation for its own sake.
- **The record says it could be trusted.** 265 accepted pairs, and not one rejection, on the
  production library.

So accepting a pair makes it a rule, and the rule tags every item the string is read on
afterwards. What still asks: a first-time pair (new text, or a name or alias just added), every
misreading, which is a different string from the one corrected, and anything left out.

- **Written as `source = 'ocr'`**, attributed (`createdById`) to whoever accepted the pair. That is
  the value reserved for this, and it is what tells a tag a rule applied from one a person
  clicked. `confidence` stays unused: a rule applies a person's decision, it does not guess.
- **Only to text read since the decision.** Every item showing the string when it was accepted
  was in front of the person deciding: they tagged it or left it out. One that has lost the tag
  since is somebody having taken it off, and a rule must not put it back.
- **A tag taken off is declined.** Removing a performer or source from an item by hand
  (`tagsChangedOn` → `declineRules`) leaves the item out of every accepted pair of that tag for a
  string it shows. Without that, reading the item again would recreate its findings, now newer
  than the decision, and the rule would undo the person's edit.
- **Where it runs.** `ocrTagMatchRepo.rematchStrings` applies rules after matching, so the `ocr`
  job applies them as it reads and a correction in the drawer applies them too. The worker's
  `ocrMatch` pass applies whatever accepted pairs are still owed after its recount, which catches
  an apply the database was too busy to finish.
- **Checked in a log.** "Tagged for you" lists the `ocr` tags newest first, from a partial index
  holding only those rows (`idx_MediaTag_ocr`). Taking one off is the same as taking it off the
  item: the rule is declined there.
- **Withdrawn as a whole.** The Rules list shows every decided pair by its string. Withdrawing an
  accepted one undoes its batch, deletes the `ocr` tags it applied, reopens it, and lets any other
  rule for the same tag re-apply where it holds. **The tags a rule applies carry its accept's batch**, so
  undoing the batch reaches every one of them — including a copy handed to the kept item when a
  duplicate was trashed (§10c), which may not show the string at all and so could not be found by
  it. A rule whose accept was withdrawn from the bulk history writes unlinked tags rather than
  reviving the batch. One consequence, deliberately: undoing the accept from the bulk-tag history
  takes the rule's tags with it. Undoing a "never" lets the pair be suggested
  again.

A misread string is not covered by a rule made for a correct one, and not by the correction
either: corrections are one-off. Folding new readings toward an accepted string is the deferred
"corroboration across items" above.

### When matching runs, and the counts

`ocrTagMatchRepo.rematchStrings` matches a set of strings, stores the result and applies rules. It
lives beside the statements it drives, as `replaceMachineFindings` calls `keepReviewed`, because
the worker and the web both need all of it and neither may skip a step.

- **The `ocr` job** matches the item's strings right after writing them, twin adoption included,
  and the strings the item read last time, which are now owed one item fewer.
- **A correction or dismissal in the drawer** rematches the strings it touched. A correction moves
  findings to another string, which may name somebody the misreading did not, and a dismissal
  leaves a string that names nobody.
- **The `ocrMatch` job** rematches every string when a performer or source is coined, renamed,
  aliased, moved or merged, and once when the worker starts. The services enqueue it freely. It
  does nothing when the vocabulary's fingerprint is the one this process last matched against,
  so a fresh process always runs it once in full. At about a thousand names and fifty thousand
  strings a full run takes seconds and needs no index. Several thousand names would change that,
  and a trigram table is the answer then.

**Counts.** `pendingCount`, the number of items carrying the string but not the tag, is stored on
the pair, and it decides only which pairs the queue joins at all. The services that tag (one item,
a bulk apply, its undo, a merge) refresh it for the items they touched, through `ocrMatchHooks`, a
module of repos only because those services are the ones the match service calls. That is not a
trigger on `MediaTag`, so a path that forgets leaves the count stale, and nothing depends on it
being exact: the queue computes the counts it shows live, for the rows on screen, and the startup
`ocrMatch` run recounts everything.

**Another tag.** A string on a row can be filed under a performer or source the matcher did not
propose, by name or coined there. That adds a `manual` pair as a proposal, with its own count, and
rejects the proposal it replaces when there was one. It is not accepted on the spot, because its
count is a number nobody has seen yet.

**An accept carries the item count it was shown.** The row says how many items one click tags. The
server refuses if OCR has read the strings on more items since.

**Deferred:**

- Proposing a new performer or source from a name-like string that matches nothing. Asked again
  on 2026-10-06 and still deferred: telling a name from other text is guesswork, and its misses
  would bring back the noise this review was reshaped to leave out.
- Sharing the review with faces (§5f), which proposes performers from a different kind of
  evidence and reuses this row for it, and later with §5e's "keep suggesting".

## 5c. Search — SQLite FTS5, not Elasticsearch

**Decision: FTS5. Elasticsearch is rejected for this deployment.** Revisit only if the
trigger conditions below are actually hit.

### Why not Elasticsearch

The disqualifying constraint is memory, not capability. Elasticsearch wants a 2 GB heap
before it is comfortable, on a QNAP that typically has 4–8 GB total — and it would be
competing for that RAM with the one workload that genuinely needs it, ffmpeg transcoding
(§8). Trading transcode headroom for search speed is backwards when the corpus is 200k
short documents.

The rest compounds it:

- It breaks the "one `docker run`" promise — a second stateful service with its own JVM,
  disk layout, health states, index mappings, and version upgrade path.
- **Two datastores means a sync problem.** Every write needs dual-write or a reindex queue,
  and the failure mode is user-visible and confusing: search returns an item the library no
  longer has, or a freshly scanned file is invisible for a while. SQLite gives
  read-your-writes for free because the index is in the same transaction.
- Index mapping changes need reindexing, which is a second migration system alongside the
  one in §4 — and that one has drift tests keeping it honest. The ES mappings would not.
- 200k documents is small. This is comfortably inside what FTS5 handles without tuning; ES
  would be idling on hardware that has nothing to spare.

### What FTS5 actually gives us

Everything the feature list in §14 needs:

- **BM25 relevance** with per-column weights, same ranking function ES uses — filename and
  title weighted above tags, tags above attribute values.
- **Prefix and boolean queries**, phrase search, `NEAR`.
- **Stemming** via `porter unicode61`, and a **trigram** tokenizer (SQLite 3.34+) for
  substring and typo-ish matching over names.
- **Faceted counts** — "how many items per performer, given the current filter" — are a
  `GROUP BY` over `MediaTag` joined to the filtered set. At 200k rows with the right
  indexes this is milliseconds, and it composes with the per-user `LEFT JOIN` (§6), which a
  separate search service could not do without denormalizing every user's ratings into it.

### Design

One external-content FTS5 table over a denormalized document per media:

```
MediaSearchDoc  (ordinary table)   rowid, mediaId, filename, title, performers,
                                   tags, attributes, notes, ocr, variants
MediaSearch     (fts5, content='MediaSearchDoc')
```

**Built as two tables rather than one.** FTS5 addresses rows by integer rowid and ours are
TEXT uuids, so without a real row holding that mapping, re-indexing one item means finding
it by an `UNINDEXED` column — a full index scan, which at 200k items turns every tag edit
into a table scan. The doc table gives the mapping an actual unique index, and costs nothing
in storage: external content means the FTS5 side keeps no copy of the text.

It is also what makes deletion correct. External content cannot read back the values it
needs to remove an entry, so the three canonical sync triggers on `MediaSearchDoc` supply
them. Deleting a `Media` row cascades to the doc, and **a foreign-key cascade does fire the
delete trigger** — verified, not assumed, and pinned by a test — so the index entry goes
with it and nothing has to remember to clean up. Those triggers are mechanical; the document
itself is still assembled by the worker.

Tokenizer: `porter unicode61 remove_diacritics 2` with `prefix='2 3'`. Stemming, accent
folding, and a real as-you-type prefix index. Substring-inside-a-word matching is
deliberately not covered — that needs a second table with the trigram tokenizer, doubling
index size for a case prefix search already handles. The substring case that actually
matters — a name glued inside a longer word — is covered more cheaply under "Word boundaries"
below.

Maintained by the worker as an `index` stage in the job chain (§7), not by SQL triggers —
the document is assembled from six tables, and a stage is re-runnable, batchable, and
backfills the library when the recipe changes. `Media.searchVersion` marks stale rows the
same way `generatorVersion` marks stale artifacts. An edit marks rows stale _and_ enqueues
the job in one transaction: the version bump survives a worker restart, the job makes it
happen within seconds, and neither alone is sufficient.

Filenames are tokenized before indexing. `Studio.Name.2019.1080p.x264-GROUP.mp4` is a single
token to any tokenizer that respects word boundaries, which would make the densest metadata
in the library unsearchable; separators become spaces and directory names are kept, because
a folder is often the only place a studio or series is recorded.

### Word boundaries

A messy library writes one name many ways — `Aunt Margaret`, `aunt.margaret`, `aunt+margaret`,
`AuntMargaret`, `auntmargaret` — and searchers type it just as many. Punctuation was never the
problem: it is a boundary to the tokenizer on both sides, so the dotted and spaced forms already
meet. What does not meet is a **glued** form, one token on one side and two on the other. That
is a disagreement about where words end, and neither case folding nor stemming touches it.
Both sides now carry both spellings:

- **The index stage splits compound words in place**, keeping the original: `AuntMargaret` is
  indexed as `AuntMargaret Aunt Margaret`, in its own column at its own weight, so "margaret"
  finds it as a title match. Split where the text marks a boundary — a lower-to-upper case change,
  an acronym running into a word, letters meeting digits.
- **A `variants` column holds every adjacent pair glued**: `Aunt Margaret Beach` adds
  `auntmargaret margaretbeach`. Per phrase — one title, one folder, one tag — never across them,
  and never two numbers. Its weight is below every column it is derived from, so the item written
  the way the searcher typed it ranks first.
- **The search box also tries each adjacent pair glued**: "aunt margaret" becomes
  `("aunt" AND "margaret") OR ("auntmargaret")`, which finds `auntmargaret.mp4`. One pair at a
  time, at most four alternatives, never inside a quoted phrase; a glued pair that ends the query
  is prefix-matched, so "aunt marg" reaches it while it is typed.
- **Known names are found inside glued words.** An all-lowercase `auntmargaretbeach` marks no
  boundary at all, so the curated tag vocabulary is the dictionary: every library-wide tag name
  and alias found inside a filename or title word is written into `variants` in its spaced form.
  Library-wide only — this is the shared document. Short names are trusted only at the edge of a
  word (`anna` is inside `hannah`); from six letters, anywhere. The worker caches the vocabulary
  for a minute, and an item indexed before a tag existed only gains it on its next reindex.

Adding the column meant recreating the FTS table, because FTS5 cannot gain one; the migration
rebuilds the index from the existing documents so nothing goes unsearchable while the `index`
stage's version bump refills them through the queue. The cost is roughly one extra token per word
in the short curated columns, against `ocr`, which dwarfs them.

**Typos are not handled here.** A trigram table would not help — FTS5 trigram matching requires
every trigram of the query, and `margret` has two that `margaret` lacks. The candidate for the
library search is expansion against the index's own vocabulary (`fts5vocab`), fired only when an
exact search finds nothing. It has not been built.

**Tag boxes match the same way, and do handle typos.** Every box that finds a tag by typing —
the vocabulary screen, the facet modal, the tag pages, the private-tag half of the library search,
and since 2026-10-06 the box tags are typed into (`TagNameInput`, which used to filter the 500
most-used names in the browser by a substring rule of its own) — folds names by the one rule
(§5b "One rule for names") and matches a prefix of _any word_ of a name or alias ("margaret" finds "Aunt Margaret", which a
prefix of the whole name never did) or the glued spelling anywhere in it. When nothing in scope
matches, and only then, it falls back to names one slip away (two for eight letters or more, none
under four): a vocabulary is thousands of short names, so an edit-distance pass in JS is cheap
there in a way it is not over two hundred thousand documents. A near spelling is never mixed into
results that matched, because a close spelling ranked beside an exact one is how fuzzy search
buries what was typed. The tag-assign box offers the near spellings _beside_ "Add …", not instead
of it: in a vocabulary that already has "Aunt Margaret", "margret" is most likely a slip, but it
may be a different person, and the box should show the existing tag without taking the choice
away.

### The search box is not a query language

Everything typed is treated as literal words. `MATCH` takes a _language_ — `AND`, `OR`,
`NOT`, `NEAR`, `*`, `^`, `:`, `(`, `)`, `"` all mean something, and anything that does not
parse **raises** rather than returning nothing. On a library of scene files, punctuation in
the search box is the normal case, so passing it through would make a 500 the normal case
too. `buildMatchExpression` in `@private-stock/core` emits every token double-quoted, which
is containment rather than escaping: inside a string there is no way out. Two conveniences
survive, because every other search box has them — `"a phrase"` and `-excluded`.

### Where FTS5 is actually spoken

`searchRepo` owns document maintenance, the match expression, and two SQL fragments the
library query embeds. The originally planned `query(criteria) → mediaIds` interface did not
survive the library size: a broad search on 200k items either builds a statement with 200k
bound parameters, past SQLite's limit, or caps the list and silently truncates the library
with paging and totals both wrong beyond the cap. Handing SQLite a subquery instead lets it
intersect the FTS index with the access filter itself — the one thing a separate search
service could never do. Route handlers and services still never write FTS syntax, and
swapping the engine still touches one file.

Facet counts live in `mediaRepo` beside the filter they count, built from the same
`buildFilters` the grid uses. Two separate expressions of one filter drift, and the symptom
— a panel offering "Drama (12)" that returns eight results — looks like corrupt data and is
near impossible to diagnose from a bug report. The _values_ live in `tagRepo` instead, where
they are read from the vocabulary and never touch the filter at all (§20). Selected values
are always counted even when they fall below the per-facet cap: a chip that vanishes leaves
the user filtered with no visible control to unfilter.

### One search across what you can see

The search box looks in two places: the shared document, and the viewer's own private tags, which
are matched by name because one shared index cannot hold per-user text (§6). It used to require
all the words in one place or all in the other, so "beach funny" — beach in the file's name,
funny a tag you gave it — found nothing, and `-funny` excluded nothing you had tagged funny.

Now (2026-10-06) an item matches when **the whole query matches its document** — the full
expression, glued alternatives and exclusions as before — **or every word is found on it one way or
the other**, each word in the document or among your tags; and in either case **no excluded word
is found on it either way**. `searchTerms` produces both halves of every word from one
tokenisation. The per-word document lookups go through the same rowid index as the full match, so
none reads a document. Relevance ranks the document's matches by bm25 and puts items found only
partly through your tags after them, as it already did for private-only hits.

Deliberately not included, by decision: private notes, capture captions and clip labels. The box
searches an item's own name, text and tags; moments are searched in their own browsers.

### When to revisit

Concrete triggers, not vibes. Any of these makes the decision worth reopening:

- The library passes ~2M items, or documents grow long (transcripts, OCR, subtitles).
- Typo tolerance and synonyms become a primary requirement rather than a nicety.
- Search latency exceeds ~200 ms at p95 with indexes in place and the query plan checked.

**And even then, Elasticsearch is not the next step — Meilisearch or Typesense is.** Both
are single static binaries in the ~100 MB range with excellent typo tolerance and native
faceting, they fit the one-container deployment model, and they slot behind the same
`SearchRepo`. ES only earns its weight with cluster-scale corpora or heavy aggregation
analytics, neither of which describes this app.

### The AI phase is not an argument for it

Phase 10's semantic search needs vector similarity, and ES's kNN is not the cheap way to
get it here. 200k CLIP embeddings at 512 dimensions is ~400 MB of float32 — a brute-force
cosine scan is tens of milliseconds in plain Node, and `sqlite-vec` gives an indexed
version in-process if that stops being true. Keyword search and vector search stay separate
mechanisms whose results are merged in the service layer, which is what a dedicated engine
would do internally anyway.

The arithmetic in that paragraph assumed one vector per item. Embedding the frames instead
makes it several hundred thousand vectors, which no longer fit the NAS's memory as float32 or
as anything else; §5e is the design that measured this and works around it.

## 5e. Watching by look

**Designed, not built.** Phase 10. Everything here was decided on 2026-10-04, from an interview
about what the library is for and a measured bake-off on a random sample of it.

**The library should be watchable by look**: everything with glasses, the beach, this lighting,
that feel — as something to sit back and watch, usually whole videos, sometimes moments. That
is the job this section serves, and it is narrower than "AI features". It is not finding a file
by its name, which search already does, and it is not predicting what anybody will like.

**Every look becomes an ordinary Library set.** The showcase (§14f) and the tasting (§14g)
already do the watching, and they already take any Library address. So this section adds new
ways to _make_ a set, and one change to the tasting, and no new viewing mode.

### What is stored

| layer                                   | state                    | what it is for                                      |
| --------------------------------------- | ------------------------ | --------------------------------------------------- |
| facts: probe, hashes                    | built                    | everything                                          |
| pictures: covers, sprites, pHash, OCR   | built                    | browsing, duplicates, burned-in text (§5d, §9, §10) |
| **frame vectors** — what a moment means | this section             | every way of asking for a look                      |
| **faces** — who is in a moment          | §5f                      | performer suggestions a person confirms             |
| pixel statistics — light and colour     | deferred (below)         | describing and discovering looks precisely          |
| what people do: ratings, views          | stored; **not inferred** | ratings stay the person's own (below)               |

The model turns a picture into 512 numbers, and a sentence into 512 numbers in the same space,
so that a picture and a sentence describing it land close together; similarity is one dot
product. Every frame of the sprite sheets gets a vector. Looking for words, for a tag, or for
"more like this moment" are then the same operation asked different questions: which stored
frames are nearest this vector.

### Three ways in, one way out

| asked for by         | address                   | the query vector                        |
| -------------------- | ------------------------- | --------------------------------------- |
| words                | `/?lookText=golden light` | the text, in a few phrasings, averaged  |
| a tag                | `/?looks=<tagId>`         | the tag's names, or its members (below) |
| the moment on screen | `/?like=<itemId>@<ms>`    | that frame                              |

Each opens the Library grid as a **ranked set**: best match first, capped at 120 of each kind —
videos and photographs apart, so a library of mostly one does not crowd out the other (decided
2026-10-09, down from 300 in all) — the way relevance is (§20 "Relevance does not page
indefinitely"), because past the point where the hits stop the order is noise. **Always best match first** (decided 2026-10-06): the server orders
any query with a look by it, whatever sort the address carries, and the sort control says so — the
list _is_ the best matches, and sorting them by title would hide which those were. The other
filters narrow it and compose as always, and the few hundred are the best of what they allow, not
the best of the library cut down afterwards: "beach" narrowed to one performer is that performer's
most beach-like items. Only one look per address — two rankings do not intersect into anything
meaningful, and the server refuses `lookText` and `like` together. "More with this look" in the
viewer and the tasting is `like` at the current frame; the item it starts from is left out of its
own list.

**Where a look is asked for: the Filters panel, not the search box** (decided 2026-10-06). A
search is _narrowing_ — the box, the facets, the measures — plus at most one _ordering_ lens, and a
look is a lens. The search box stays what it is, names, text and tags, with no mode; a switch on
it, considered first, would have made one box mean two things. The panel gets a **Look** section:
a "Looks like…" field for words, or the frame "More like this" put there, shown as its thumbnail —
one or the other. Not a row of the Advanced editor: that edits conditions that are true or false,
and a look is neither — as a rule it would have to mean "the top N", which cuts results off
quietly. An active look is a pill above the grid like every other filter's ("Looks like: neon ✕",
or the frame's thumbnail), so it is visible and removable without opening the panel. Typed words
and a look combine as narrowing and ordering: "jane" in the box with a frame look is Jane's
items, ordered by how much they look like it. Faces keep the same shape when they come: a
confirmed performer is a facet filter as now, and a "same person as this frame" lens, if one is
ever wanted, is a second option of the Look section rather than a new place.

**The header search asks for a look too, by name** (2026-10-10). The library's own box stays
modeless, as above. The box in the header (§14 "The header search") carries a visible kind, and
"Look" is one of them: it opens a clean library with the words as `lookText`, exactly what the
panel's "Looks like…" field would have written. What made a switch on the library box wrong was
one box quietly meaning two things; the header box shows its kind as an icon and says it in its
placeholder, so it means one thing at a time and says which.

In this mode a tile shows **the frame that matched, with its time**, not the cover: the match is
the evidence, and the cover of a twenty-minute video rarely shows the glasses. Opening a tile
opens the item at that moment, and the list row carries the matched time so the tasting can use
it.

**The one change to the tasting:** given a look, each video's taste starts at its matched moment
(a second before it) instead of at a random point (§14g "The segment"). "Glasses" then opens on
the glasses. Without a look the tasting is unchanged. The showcase's voice (§14f "A voice in the
wall") plays the same taste of a look's item, so a tile that speaks again in a look's set replays
its match rather than finding a new moment: one moment per item is what a look keeps.

**As built (M4).**

- **The Look section** heads the Filters panel: a "Looks like…" box asked on Enter, not per
  keystroke — each look ranks the whole library, and the first after a quiet spell waits for the
  text model to load — or, after "More like this", the starting item's picture, title and time
  with a way to clear it. Choosing one clears the other (`withLook`).
- **The chip** above the grid reads "Looks like “neon”" or "Looks like “‹title›” at 4:10".
- **The sort control** shows "Best look match", disabled, with the same kind of note the untagged
  override gives; the view's own sort returns when the look is cleared.
- **A tile** in a look's list shows the matching frame — the sprite tile nearest the moment, as a
  clip's face is (§14d), so it costs no ffmpeg — as **a square from the centre of the frame**,
  centred in the tile: the whole frame cropped into the grid's 16:9 stretched every upright one.
  A brass "4:10 / 22:31" badge stands where the duration was, and the tile opens the item a second
  before the match. Its hover preview plays as ever.
- **"More like this" is the viewer's alone** (decided 2026-10-06). It was on every tile's hover as
  well, and was obtrusive there: a rack of sixty pictures with a button over each. The viewer is
  where the moment on screen is, which is what it asks about.
- **The viewer** has "More like this" beside Add to playlist: the moment on screen, or the
  photograph, over the **whole library** in the grid — not the set it was opened from, which may
  have been narrowed to something this frame has nothing to do with. Stepping through a look's
  set opens each item at its match, from the moments the ids pages carry.
- **Facet counts leave the look out.** They are counted by the database, and the look's list is
  ranked in the web process; they say what each facet matches among the filters, which the look
  then orders.
- **What a look cannot do yet**, both for the saved-filter reason under "Search runs in two
  passes": "Tag everything matching" and the suggested "Tag all as ‹tag›" are absent while a look is
  active (selecting tiles still works), and so are "Save view", "Save changes" and "Save as a new
  filter". A look within a saved filter is not an edit to it.

**A look replaces the tags that only described what is on screen** (2026-10-06, the owner's words:
"now that I can search for glasses, I don't need a manually maintained list of tagged glasses
items anymore"). This reverses what this section first said — that a look set was for finding
things to tag, and a tag for watching again. Asking for "glasses" is cheaper than keeping a list
of them current, and is never out of date as items arrive. **Tags become subjective**: matters of
taste and of what a person knows, which no model can see — who is in it, where it came from, what
it is to them. That is why Find untagged by look, below, is deferred rather than next.

### Find untagged by look

**Deferred** (2026-10-06), and less wanted than when it was written: it is a tool for maintaining
visual tags, and a look has taken their place (above). What follows is kept for a tag that is both
visual and a matter of taste, if one turns out to want it.

A tag page has **Find untagged** (§5d), which finds the items whose _text_ names the tag. Beside it,
**Find untagged by look** opens `/?looks=<tagId>&notTags=<tagId>`: the items that _look_ like the tag
and do not carry it. The grid is the same one, with the same filled **Add ‹tag›** and the same
batch and undo; a confirmed hit is a person's tag, `source = 'user'` with a `TagBatch`, for the
reason §5d gives. Tagged items leave the set, so the next page is what remains.

**Two buttons, not one.** `mentions` is a set — a file names the tag or it does not — and `looks`
is a ranking. Merging them would mean ordering text hits against look hits, and the two scores do
not compare.

**What the tag looks like** is decided one of two ways, and a chip in the grid's header switches:

- **By its names.** Each name and alias in a few phrasings ("glasses", "a person wearing glasses"),
  averaged. Right for a tag whose name is a visual idea, and the only choice for a tag with few
  members. It worked for "glasses" in the bake-off.
- **By its members.** The vectors of items already carrying it, in a few clusters for a varied tag.
  Right for a tag whose name means nothing to the model — "the blue room" — once it has five or so
  members.

The header shows the phrasing in use and it can be edited on the spot ("clear eyeglasses", once
sunglasses turn up).

Describing a tag by its members reads which items carry it, so **somebody else's private tag
cannot be described that way** — the same reason it mentions nothing (§5d).

**Later: keep suggesting.** Once a tag has been worked through, where the ticks stopped is a
threshold. New items scoring above it could arrive as unconfirmed suggestions, `source = 'ai'`
with a `confidence` — the first real use of that pair. They would be reviewed in the same queue as
the OCR matches and the face matches (§5f); the OCR section already lists that as deferred.

### Ruled out, and why

- **Predicting ratings.** Ratings are personal taste, and their owner culls the 1s and 2s by hand.
  Nothing is inferred from them: no "you'd probably love", no predicted culls, no reranking by
  taste. A model of somebody's taste is not a feature they asked for, and it would be wrong in ways
  that are hard to see.
- **Sound.** The library is mostly watched muted. Speech, music and audio fingerprints are not
  stored.
- **Colour and brightness controls.** A look is asked for in words, from a moment, or (later) from
  looks the app finds — not with swatches and sliders.
- **Processing off the NAS.** No desktop helper and no rented GPU; the bake-off below is what made
  that affordable.
- **Unsupervised piles of whole videos.** Clustering the sample into twelve piles produced two of
  six that could be tagged as one, for either model. A pile that needs picking through costs more
  than tagging its members one at a time.
- **A separate voyage mode.** A drift through the library by similarity reduces to tasting a `like`
  set, which the addresses above already give.

### Deferred

- **Looks the app discovers.** Piles of _videos_ failed, but a look belongs to moments — one video
  can hold a lamp-lit bedroom and a white bathroom — so clustering _frames_ might find recurring
  looks worth naming and keeping as channels. Unproven; it waits for words and moments to show
  what they cannot do, and then for its own blind bake-off.
- **Pixel statistics.** Brightness, colour temperature, saturation and dominant hues per frame,
  computed from the sprites with no model, about 16 bytes a frame. CLIP knows "neon" and is vague
  about "dim and warm"; these are exact. Their use is the discovered looks above, so they wait
  with them.
- **The same scene in another file.** With every frame embedded, whether a run of A's frames
  appears in B costs nothing new to ask. It would link compilations to their sources and find
  re-cropped copies pHash misses, and it serves culling rather than watching.

### Order of work

1. The frame vectors and the two-pass search (below), the three addresses, matched-frame tiles,
   and the tasting starting at the match. This is the whole of "watch by look" for words, tags
   and moments.
2. Find untagged by look — **deferred** (2026-10-06): a look replaces visual tags rather than
   feeding them (above), so faces come first.
3. Faces (§5f), after their own bake-off.
4. Whatever of the deferred list the first three leave wanting.

### The model

- **CLIP ViT-B/32, image encoder stored as 8-bit integers**, run by `onnxruntime-node` inside the
  worker. Not SigLIP 2.
- **Input: the sprite frames that already exist**, thinned of near-duplicates. Never the
  originals.
- **Runs on the NAS** as an opt-in stage.
- **Vectors live on disk, outside the database**; a small index of representative frames lives in
  memory, and the best **100** candidates are rescored against every frame.

The point of recording how this was decided is that the obvious choice lost.

**The models are built into the image**, not downloaded on demand. `models/manifest.json` pins
each file by Hugging Face commit and sha256. `pnpm models:fetch` downloads and verifies them (the
`.onnx` files are not committed), and the Dockerfile runs the same script in a stage keyed on the
manifest, so they are fetched once per manifest change. They live in `/app/models` rather than
`/data`: a model belongs to the build that knows how to use it, and a release that changes model
must not find the old one waiting in a volume. `findModelsDir` walks up to the manifest from the
working directory or its own location, because the web app's standalone server runs from
`apps/web`. Both text encoders are carried until the gate in "Memory" below picks one.

`openModel` imports `onnxruntime-node` on first use, not at module load. Both processes import
`core/server` for other things, and a library that never turns this on should not pay for the
native runtime. `pnpm bench:embed` measures the models on whatever machine runs it — in the
container, `node apps/worker/dist/bench/embed.js` — including the cgroup's memory, and `--smoke`
is what `docker/smoke.sh` runs.

The package carries its runtime for every platform. Only `linux/` is kept in the image: the
build stage deletes the rest, 190 MB that would otherwise be copied twice.

### The bake-off

300 videos and 100 images chosen at random, every sprite tile of each video — 25,105 frames —
embedded by three candidates on the development desktop: CLIP B/32 at full precision, CLIP
B/32 at 8 bits, and SigLIP 2 B/16 (2025, scores far higher on public benchmarks). The
comparison was **blind**: for each of 18 searches the three result sets were shown as A, B and
C in shuffled order and judged before the names were revealed. Thumbnails were cut from the
sprite sheets and never left the machine.

| judged on this library                  | CLIP | SigLIP 2 | same / tie | neither |
| --------------------------------------- | ---- | -------- | ---------- | ------- |
| 18 searches (best column)               | 2    | 2        | 12         | 2       |
| 6 more-like-this rows                   | 1    | 2        | 2          | 1       |
| 6 largest visual piles, taggable as one | 2    | 2        | —          | —       |

**Quality was a wash, and the costs were not.** Twelve of eighteen searches were ties. The
library is visually uniform enough that both models sort it equally well by setting and
format, and SigLIP 2's benchmark lead does not show up in it. Meanwhile:

|                                      | CLIP B/32, 8-bit | SigLIP 2 B/16 |
| ------------------------------------ | ---------------- | ------------- |
| first pass on the NAS                | ~12 h (measured) | ~68 h         |
| worker memory while embedding        | ~250 MB          | ~810 MB       |
| text encoder, in the web process     | 135–448 MB       | ~1.1 GB       |
| frames per video kept after thinning | 65%              | 55%           |

SigLIP 2 on the NAS is nine overnight windows, and a gigabyte or more of resident model inside
a container capped at 1.5 GiB including its page cache (§20) — on a host with 3.8 GB in all and
~530 MB free with Plex and QTS resident. Choosing it would have meant building
a **desktop helper** — a process on another machine that claims embedding jobs and posts
vectors back, the first thing other than the worker to do background work. That was costed
(8.7 h for the whole library on a 16-core desktop) and is not needed: the model that fits the
NAS was as good as the one that does not.

**The two families genuinely disagree** — they share only 41% of their top ten for the same
search — so "a tie" is not "the same results". It is two different sets of results that the
person who owns the library judged equally good. A re-run with sharper, more specific searches
is the cheapest way to reopen this, and is the first thing to do if typed search disappoints.

### Eight bits, and why the single-image test was misleading

The 8-bit model is a quarter of the size and about 40% faster. On single photographs its
vectors were 93–96% identical to full precision, which looked like a free win. **In search it
is not identical**: of the full model's top ten, the 8-bit model keeps 58% in its own top ten
and 73% in its top twenty. Small per-vector errors reorder a ranking whose scores sit close
together. It was kept anyway because the blind judgement split 1–1 with 12 ties between the
two CLIP builds — the reordering is real and was not visible to the person using it. SigLIP
2 was worse here, which settled any thought of an 8-bit SigLIP: 85–94% per image, and too much
drift to trust.

The text encoder was judged at full precision only. Its 8-bit build is the obvious saving — 135 MB
resident against 448 on the NAS — and whether it ranks as well is **untested** (the gate in
"Memory" below).

### Embed the sprite frames, never the originals

Every video already has about 85 frames on disk as sprite tiles (§9). Embedding those reads
~1.7 GB of sheets for the whole library and **not one byte of the originals** — on four HDDs
already short of IO (§20), that is the difference between a stage that can run overnight and
one that competes with playback. The cost is resolution: tiles are 200 px wide, so the model
sees a scene, not small detail. That is what CLIP B/32 resolves anyway.

**Consecutive frames that look the same are dropped** — a frame is kept only if it is less than
0.95 similar to the last frame kept. That keeps 65% of them, which puts the whole library
(13k items today) at ~462k frames — before framing, below. Each new video afterwards costs
seconds, less than its sprite render.

The stage needs the sprites to exist, which makes it **the first stage that genuinely requires
another**. The registry's `requires` names the stage it waits for by the item's kind — `sprite`
for a video, `cover` for a photograph, whose single moment is its generated cover — and the
sweep, the count, the per-item request and the worker all hold the item until that stage has
_settled_: done or empty at its current version, or failed past its attempts. Settled with
nothing to read is the handler's to answer, and it records `empty`. This is `needsProbe`
generalised, enforced in the same four places.

**Framing: a frame is seen as several squares, not cropped to one.** CLIP sees a square, and
the bake-off fed it each frame's centre square. 37% of the videos and 76% of the photographs are
portrait and the rest of the video is 16:9, so a centre square loses a fifth of the frame at
each end — on vertical phone video, usually where the face is. Asked, the owner chose coverage
over cost: a frame within 1.2:1 of square is one centred square; anything longer is covered by
evenly spaced squares from end to end — two for 16:9 and 9:16, at most three. Each square is its
own vector, and a match on either is a match on the moment. Thinning compares square by square,
so a moment is kept when any part of it changed. The cost is roughly double: **~24 hours** for
the first pass at one thread — the per-job cap the NAS's two-core quota gives (§7c) — inside
§7c's window, and ~480 MB of vectors. Shrinking the whole frame into one padded square was the
cheap alternative, rejected as untested and at half the detail.

### Where the vectors live

**Not in the database.** 462k frames × 512 bytes at 8 bits is ~240 MB, against a database of
~130 MB whose working set is already fighting for ~720 MB of page cache (§20). Putting it there
would double every backup and evict the pages the library query lives on. It also is not a
pHash, and that is the only BLOB the schema allows (§9).

So the frame vectors are files under `dataDir`, one per item — `embed/<xx>/<mediaId>.vec`,
fanned out like `art` — classified **derived** in §13d's `DATA_DIR_KIND`: losing them costs a
night of re-embedding, nothing more. Each holds a small JSON header (model, stage version,
dimensions, which entries are the representatives), a table of entries (moment time, square,
scale), and the vectors at eight bits with a per-vector scale. The format is in
`packages/core/src/embedding.ts`, so the web app reads exactly what the worker writes.

**No `Artifact` rows.** The `embed` stage row is the record, and the path follows from the id. A
new artifact kind would have been a CHECK change and so a table rebuild; instead the orphan
sweep (§13d) treats `done` `embed` rows as what references `embed/`, deletes files nothing
vouches for, and drops a `done` row whose file has gone so the stage runs again — refusing,
like the artifact sweep, when every file is missing at once. Bumping the stage's version (§7b)
is how a new model re-embeds the library.

**The representatives go to one log as well**, `embed/reps.log`: each embedded item's up-to-eight
representatives appended as a length-prefixed record. The web process needs all of them in
memory and must not open thirteen thousand files to get them (§5e "Search runs in two passes");
it reads the log once and keeps the last record per item. A record cut short by a crash is
recognised and dropped. Only the `embed` job writes it, one at a time, so it has one writer;
records for items since purged are the reader's to skip — the rest of the query never allows them
— and a re-embedded item's older records are dead weight. Neither is compacted: the log grows by
what is re-embedded, which is little, and compaction would be one writer rewriting a file a reader
holds an offset into. If it ever is, the reader already copes: a log shorter than its offset, or a
different file, is read again from the start.

**The model runs in a child process** (`apps/worker/src/embed/`), for "Memory" below: the worker
forks it on the first job, sends it paths and rectangles, and kills it after a minute with
nothing to do, which is the only way its memory goes back. It decodes the sheets with ffmpeg,
cuts the squares, embeds in batches of sixteen, thins, picks the representatives and writes the
file under a temporary name before renaming it into place. It touches no database. A crash in
it fails one job and the next starts a fresh child. It inherits the worker's loader flags and
not its debugger: `--inspect` would have it fight the parent for the port.

An identical copy borrows its twin's file by hardlink (§10f) — safe because the child writes by
rename — and appends its own record to the log.

### Search runs in two passes

The frame vectors do not fit in memory, so search does not scan them:

1. **An in-memory index of up to eight representative frames per item**, chosen to be as unlike
   each other as possible (farthest-point picking) — about six per item on average, ~42 MB at
   today's 13k items. The query is scored against these.
2. **The best 100 items are rescored against all of their frames**, read from disk. This also
   yields the frame that matched, which is the timestamp the result opens at.

Measured against a scan of every frame, rescoring 50 recovered 83% of the true top ten and
rescoring 100 recovered 91%. 100 was chosen: it is about a hundred small reads per search.

**As built (M3)** — `apps/web/src/lib/services/lookIndex.ts` and `lookService.ts`:

- **The index reads only what was appended.** It remembers the byte offset just past the last
  whole record and reads from there, in 8 MB chunks; a record the worker is halfway through
  appending is read whole next time. The last record per item replaces its entry in place, so a
  ranking taken earlier still points at the right items. Unchanged, a use costs one `stat`. It is
  dropped after 30 minutes without a look and read back in under a second.
- **The first pass ranks every item**, not a top few hundred, because the rest of the query is not
  known to it. The ranking is then walked in slices of 500 ids, the database asked which of each
  slice the query allows (`mediaRepo.matchingIds`), until 120 of each kind are found — one slice
  for a look over the whole library, more for a narrow one or a kind the library has few of; a query
  for one kind waits only for that one. The best 100 of _those_ are rescored, so what is read in
  full is what will be looked at first; the rest keep their first-pass order behind them.
- **The list is a kept order** (§20 "A shuffle is sorted once"): taken once, then paged, counted
  and walked by the viewer from memory, with membership checked again for each slice served. Each
  item's matching moment rides beside it, and a look's list and ids responses carry them as
  `moments`, by id, absent for a photograph.
- **Words are the one asynchronous step.** They become a vector in the text encoder's process; every
  reader of a list is synchronous. So the three routes that list (`/api/media`, `/count`, `/ids`)
  call `prepareLook` first, which encodes, ranks and leaves the look ready; the kept order is taken
  from that, and refuses a look nobody prepared rather than answering with the library. Vectors for
  words are kept an hour, shared by everyone — words mean the same thing to every viewer.
- **"More like this" reads the item's own vectors file**: the kept moment nearest the time asked
  for, all its squares together — the person pointed at the frame, not its top half — or the whole
  item without a time. It must be an item the viewer can see; one not yet embedded is a 409 that
  says so.
- **A saved filter cannot keep a look yet.** Every reader of a saved filter — home shelves, card
  faces, bulk tagging, freezing into a playlist — is synchronous and would answer it as the library
  without the look, so `savedQuerySchema` leaves `lookText` and `like` out. For the same reason the
  grid must not offer "every matching item" bulk actions while a look is active; selecting tiles,
  which sends ids, is unaffected. Lifting either means preparing the look in those paths.

Measured on the desktop against the production log (11,980 items, 67,574 representatives —
5.6 an item): loading 86 ms; the vectors 33 MB, packed one array per item; the process +79 MB
resident including V8's heap headroom from the decode; ranking every item 36–60 ms. The first
read once copied the log twice on the way in — the whole file, then a slice per vector — for
+162 MB resident that glibc would have kept; the decoder now returns views and the log is read
in chunks.

Representatives as real frames was not the first design. Averaging each item's frames into
centroids recovered only 54–61% even at the same candidate count, because a single strong
frame in a long video is exactly what an average dilutes — and that single frame is usually
why the video should be found.

**The in-memory index stops fitting at the top of the library range.** At 200k items it would
be ~650 MB. The response then is binary quantisation — one bit per dimension, 64 bytes a
representative, ~100 MB at 200k — for the first pass, with the 8-bit rescore unchanged behind
it. `sqlite-vec` is the other way out. Neither is built until the item count asks for it.

### Memory, process by process

**The budget is the container's, not the host's.** `mem_limit` is 1.5 GiB and it covers the
page cache, which §20 found already at the cap with ~260 MB of process memory and the rest
cache. Resident model memory is not free headroom being used; every megabyte of it is a
megabyte the database's pages can no longer occupy, on disks where a missed page costs
~100 ms. So nothing stays loaded that is not working:

Measured on the NAS on 2026-10-04 (i3-4170, in the container, idle), each model in a fresh
process with one thread:

| model                | on disk | resident while working | kept after release | one frame or query |
| -------------------- | ------- | ---------------------- | ------------------ | ------------------ |
| vision, 8-bit        | 89 MB   | +246 MB                | +47 MB             | 96 ms (54 at two)  |
| text, full precision | 254 MB  | **+448 MB**            | +69 MB             | 15 ms              |
| text, 8-bit          | 65 MB   | +135 MB                | +77 MB             | 8 ms               |

The first pass is therefore **~12 hours at one thread, ~7 at two** — the estimate of 13 held.

**Releasing a model does not give its memory back on Linux.** On the Windows desktop it did, all but
the runtime's own ~40 MB, and the design above was written from that. In the container, glibc keeps
what a released session freed, and loading and releasing again in the same process adds to it:
`bench:embed`'s own run climbed from 69 MB to 288 MB across sessions. Turning off onnxruntime's
memory arena lowers the peak by about a quarter and then keeps _everything_ after release, at the
same speed, so the arena stays on. The consequence is that "load while working, release when idle"
only works where the process itself ends:

- **Worker:** `embed` jobs run in a **child process** the worker spawns for a batch and that exits
  when the queue holds none — as ffmpeg and tesseract already do. ~250 MB during the first pass and
  for a few seconds per new video, and all of it returned when the child exits. A crash in native
  code takes the child, not the worker.
- **Web:** the text encoder and the representative index are needed to answer a search. The
  index is ~33 MB of vectors and is dropped after half an hour unused. The encoder cannot be loaded
  and released inside the web process, for the reason above, so it runs in a **child process that
  exits after five idle minutes** (decided 2026-10-06; `core/server/textEncoder.ts`), paying a cold
  load (~0.8 s on the desktop) on the first search after a quiet spell and ~10 ms a search after
  that. It is the **8-bit text build** (~135 MB): in a blind review of 31 of the library's own
  searches it matched the full-precision build on 23, each won 2 and 4 were poor for both — which
  is the library, not the model. The child lives in `core/server` because it must be a file Node
  can run on its own, and the web app's code exists only inside Next's bundle; the web process
  finds it by walking up to `packages/core/dist/server`.
- Raising `mem_limit` by the size of what is loaded is a reasonable answer here, unlike §20's
  case for rejecting it: that was about cache that any size would flush, and this is fixed
  process memory that would otherwise displace cache. It is a deployment change, so it waits
  until a measurement says the cache is losing.
- `onnxruntime-node` is a native module on both sides, so it joins `better-sqlite3` in §2's
  bundler arrangements, and `docker/smoke.sh` has to load it.

### Measured how, so it can be measured again

The harness lives outside the repository on purpose — its sample was 85 MB of the library's own
thumbnails. Its shape, if this is reopened: sample items and their sprite sheets read-only from
the NAS; cut and embed every tile per model with `onnxruntime-node`, tokenisers from
`@huggingface/transformers` (which must be imported _after_ `onnxruntime-node`, because it
bundles an older runtime and whichever loads first wins); then a blind, blurred, local-only page
of shuffled columns that tallies a verdict per search.

One trap that cost a full re-run: **sprite sheets are always a 10×10 grid**, padded when a
video has fewer than 100 tiles. Cutting tiles by the number of rows actually used misaligns
every tile of a short video and reads past the image.

## 5f. Faces, and one review for every suggested tag

**Designed and measured, not built** (bake-off 2026-10-07, below): faces read from the sprite tiles
name the right performer first 83% of the time, where CLIP's overall look managed 51%.

Performers are how this library is organised — 299 of them on 2,962 items (2026-10-06), nearly
all of them one performer to an item — and they cover 23% of it; 5,293 videos carry none. Burned-in text names some of the rest (§5d "Tagging performers
and sources from what was read"); faces can name more, because most videos show a face and few
show a name. The rule is the OCR review's: **the machine proposes, a person confirms, and the tag
is theirs.** Nothing is tagged on recognition alone.

### What is stored

Two models, both ONNX and both run in the worker like §5e's: a **detector** that finds faces and
their five landmarks in a tile (**SCRFD-10G**, 17 MB), and a **recogniser** that turns a face aligned
on those landmarks into 512 numbers so that two pictures of the same person land close together
(**ArcFace R50**, 174 MB) — InsightFace's large set, chosen by the bake-off (decided 2026-10-07). Its
trained weights are licensed for non-commercial use, which a personal deployment is.

**Every second tile, at most twelve faces a video** go to the recogniser: the largest, best
detected first, and none smaller than 10 px between the eyes. Measured, that cost almost nothing
(below) and halves the work: about 14 s a video on the NAS at one thread — ~31 h of processing
windows for the first pass over today's library, then seconds per new video.

- **`Face`** rows: `mediaId, atMs, box, quality, groupId`, and what a person has said about it (below).
  Metadata only.
- **Face vectors** beside the frame vectors, in files under `dataDir`, for §5e's reasons: they are not
  a pHash, so not a BLOB. At a handful of faces a video they are a few tens of MB.

**Faces come from the sprite tiles, and from photos' covers — never the originals** (decided
2026-10-06). The recogniser wants the face at 112 pixels, aligned; in a 200 px tile a close-up face
is about that and a wide shot's is a smudge, so tiles will miss faces that a full-resolution frame
would find. Reading those frames was the alternative — a few seeks into each original, about thirty
thousand for today's library, overnight on disks that are already the bottleneck — and it is not
taken: the bake-off measures what tiles alone give, and the stage is built on that. The portrait
third of the library helps, since an upright 200 × 356 tile holds a larger face. Photos are in
scope, read from their covers, which are already in `dataDir`.

### The stage, as built

- **`faces`**, opt-in, after `sprite`, priority 160 — behind `embed`, which is cheaper per item and
  whose search is wanted sooner. Window-only and one at a time, for `embed`'s reasons. The face
  math is in `packages/core/src/faces.ts`; the job is `apps/worker/src/jobs/faces.ts`.
- **Two passes over an item's pictures.** Every second tile is run through the detector and every
  face kept with its place; then the twelve worth recognising are chosen across the whole item,
  and only the pictures they are in are read again. Holding every decoded sheet of a long video
  between the two would be a few hundred MB; reading one twice is tens of milliseconds.
- **One model child, one family at a time.** The faces models run in the child `embed` already
  had (`apps/worker/src/embed/`), not a second one: the two families hold ~210 and ~230 MB, and
  together they would crowd out the database's page cache. A request for the other family waits
  for the child to finish, retires it, and starts it afresh — a model load on each switch. Each
  family has its own memory lines. **The faces ones came from the container, the second time**
  (2026-10-07): drawn first from the desktop's ~230 MB, they stopped nearly every item at 459–507
  MB. Measured in the container, the recogniser alone loads ~300 MB, and at onnxruntime's full
  graph optimisation the pair settled at ~572 MB; at `basic` ~440 MB, with the same outputs
  (recogniser cosine 1.0000000, detector within ~2e-6), detection ~30% slower and recognition ~30%
  faster. So the face models open at `basic`, and the lines are 480 MB to be replaced and 576 MB
  to be stopped. Stage version 2 re-ran the items whose attempts the first lines had used up.
  Raised to 544 and 640 MB on 2026-10-08, when a large item reached 578 MB in the first pass.
- **And not alternating** (`apps/worker/src/embed/affinity.ts`, 2026-10-07). One child keeps the
  two families from holding memory together, but not from the claim alternating between them —
  each newly scanned item's `embed` cutting into a faces pass, with a model reload each way, read
  from the disks the database waits on. So while the child holds one family and that family has
  work queued, the other's jobs are not offered until the oldest has waited 30 minutes; then the
  child switches, and the same rule holds it there. At most two switches an hour, and nothing
  waits for ever. Work somebody asked for is claimed apart from this and is never held back.
- **Rows and a file.** `Face` holds each kept face — moment, box as fractions of its picture, size
  between the eyes, confidence — and the item's faces file in `faces/<xx>/<id>.vec` holds the
  vectors at eight bits, in the vectors file format §5e defined. `FaceRefusal` holds "not this
  performer". The orphan sweep treats `faces/` as it treats `embed/`.
- **A re-run keeps what people said.** The stage replaces an item's faces each time it runs, and
  each confirmation or refusal moves to the new face at the same moment whose box mostly overlaps
  the old one. A decided face the detector no longer finds takes its decision with it, and the
  review asks again. An identical copy borrows its twin's file and rows, decisions included.

### Grouping

_Superseded 2026-10-11: face groups, the `faceGroups` job, Matches, Unnamed and Likely are gone. What replaced them is "A person in a video", "Suggestions", "New people" and "Their faces"; this section is kept for what it decided and why._

Faces of one person are gathered into **groups**, incrementally and disjointly — the pattern §10b
already uses for duplicates: new faces seed the work, a face joins the group it is close to, and two
groups that a face bridges merge.

**Decisions are recorded on faces, not on groups.** This is the one way faces cannot copy the OCR
review. A string is a stable key — `OcrTagMatch` is keyed by its normalised text, and a decision on
it holds for good. A group is not: it merges and splits as faces arrive, so a decision filed against
a group id would be lost or misapplied on the next run. So:

- **Accepting** labels the faces shown with the performer, as confirmed.
- **Rejecting** records, for those faces, "not this performer".
- **A group proposes a performer** when it holds faces confirmed as them. **"Accepted · N new"** is a
  group whose confirmed faces all say one performer, holding faces on items that do not carry the
  tag yet. One click tags them, as in the OCR review; nothing is tagged automatically.
- Items excluded at accept are remembered per item and performer, as `OcrTagMatchSkip` does.

**The tagged items seed it** — 2,887 videos carry exactly one performer. On such an item, where one
face group dominates, that group proposes that performer — a proposal, shown for confirmation like
any other, not a label taken on trust. Items with two performers seed nothing: which face is which
is exactly what is not known. **Proposals are computed when asked for**, not stored: they follow
the groups and the tags as both change, and a stored copy would only fall behind them.

**As built (2026-10-07)** — the `faceGroups` job, `apps/worker/src/jobs/faceGroups.ts`:

- **One coalescing job for the library**, as `dupes` is: queued after each item's faces, held ten
  minutes so a burst is grouped once.
- **Incremental.** The groups' sums and how far the last run got are kept in `faces/groups.bin`, so
  a run reads only the items whose faces arrived since. Without that file — lost, or a format
  change — every face is grouped again from scratch.
- **People within an item first**, at the bake-off's 0.35 (`peopleInItem`); then each person joins
  the nearest group within **0.5** (`placePerson`), stricter because a wrong join is copied into
  every later comparison with that group, and the review is better shown two groups of one person
  than one group of two. A person within 0.5 of several groups joins them into one.
- **A face seen once in a video is in no group** — a passer-by, or a half-found face. A photograph's
  single face is, since one picture is all there will ever be.
- **Drift, accepted.** A re-run of the stage gives an item new faces, which are grouped again; the
  old faces' share stays in their groups' sums until a rebuild. Both thresholds are a first guess,
  to be checked against the tags once the first pass has run.

### One review, two sources

_Superseded 2026-10-11: face groups, the `faceGroups` job, Matches, Unnamed and Likely are gone. What replaced them is "A person in a video", "Suggestions", "New people" and "Their faces"; this section is kept for what it decided and why._

Review gets a **Faces** section shaped like OCR's queue, so that confirming who is in a video
is one experience whichever evidence proposed it:

|             | OCR                                                     | Faces                                                       |
| ----------- | ------------------------------------------------------- | ----------------------------------------------------------- |
| a row is    | one item, with each string it shows                     | one face group                                              |
| evidence    | each string beside its frame                            | a strip of face crops, each opening its item at that moment |
| candidates  | every performer or source it names, ticked              | the performers its confirmed faces say, ticked              |
| counts      | untagged items per candidate                            | the same                                                    |
| accept      | one batch, `source = 'user'`, summary names the string  | one batch, summary names the group                          |
| reject      | the pair never returns                                  | those faces are "not this performer"                        |
| another tag | file it under one the matcher missed                    | the same, and **coining a performer is first-class**        |
| returns as  | a rule: the string read again is tagged by itself (§5d) | accepted · N new                                            |

**Coining is the difference that matters.** For OCR, proposing a new performer from a string that
matches nobody is deferred. For faces it is the main event: a group of forty videos of somebody
nobody has named is the most useful row on the page, and "Who is this?" with a name box is its
action. So Faces has two tabs: **Matches**, groups with a proposal, ordered by how many untagged
items one decision settles; and **Unnamed**, the largest groups with none.

**Both open on faces in videos**, under the same Videos / Photos / All control as the other queues,
with each kind's row count on it: the collection is mostly video and photos are the exception, so
they wait behind the control rather than filling every page of decisions (decided 2026-10-09). The
control narrows what a row _asks_ about — which faces, and so whether a group has anything to ask
under that kind — never what decides it: a group is still proposed, and its counts kept, from every
item, so photos go on naming people. A performer's page links here with All, because its count is of
every item. "Would tag" has no control: it is a fair sample of what the rule would do, and a
narrowed one would not be.

**Shared parts, extracted when the second caller exists.** The row's layout, its candidate list with
counts and ticks, accept, reject and "another tag" are the same component in both places; only the
evidence slot differs. It is pulled out of `OcrMatchRow` when Faces is built, not before.

§5e's "keep suggesting" joins the same queue later, as a third kind of evidence: the matched frame.

### Starting from the performer

**A performer's page starts the work; Review › Faces does it** (decided 2026-10-04, revised
2026-10-08 and 2026-10-09). The page was first meant as where faces are confirmed. In use that
gave three places asking about the same untagged items, each with its own rules — "Likely",
Review › Faces and the grid's "Find untagged" — and nobody could tell which was the real one. Each
kind of evidence has one way of being decided, and since 2026-10-09 the performer's Organise page
holds all three, strongest first, under "To check":

| evidence                 | how it is decided                                |
| ------------------------ | ------------------------------------------------ |
| a face and the name both | "Likely", item by item                           |
| a face alone             | Suggestions: a card for each person in each item |
| the name alone           | "Find untagged", in the grid                     |

The seam is what a decision is about rather than where it is made: a person in an item
(Suggestions, across every performer in Review, or narrowed to one on their Organise page), an
item ("People in this item", in the viewer), or what is already decided about a performer (their
Faces tab, below). The cards are the same component and the same reads wherever they appear.
(Until 2026-10-10 the unit was a face group, and the face tab was "Their face"; see "Their
faces".)

- **Likely**, below the items already tagged: untagged items that are probably this performer,
  **gathering all the evidence** — a face matching a confirmed one, the name in a filename, title
  or the burned-in text (`MediaMention`, §5b) — each row saying which, best first, with the same
  "Add" and batch undo as everywhere. It is where the facet-by-facet "Find untagged" buttons end
  up (§5d).
- **Review › Faces** keeps the two tabs below: **Matches** for groups with a proposal, across every
  performer, and **Unnamed**, "Who is this?", for the largest groups with none.
- **In the viewer: "People in this item"** (2026-10-10, replacing "Maybe in this item" of
  2026-10-08). Every person in the item (appearance), with what is known of them: confirmed — by
  you, or tagged by the app from their face — suggested at the lines Suggestions uses, or nobody
  yet. One control each: "That's ‹name›" (tags the item if it does not carry them, and confirms all
  the person's faces there), "Not ‹name›" (refuses the person for them, taking back a
  confirmation), and "Name…" / "Someone else…" for somebody new or other, coined if new. Below,
  the performers the item's own text names who are not on it, with "Add" and "Not them" (`notThem`,
  as an untag by hand). Pressing a face goes to its moment. Each is one decision in History. Above
  the item's tags, for administrators. Who is on screen _now_, during playback, is not built: it
  is a way of watching more than of organising.
- **Comparing, and which file** (2026-10-11). A face asked about as somebody is set beside them:
  their picture next to the name on the card (Would tag, the item page's "‹name›?", the head of a
  performer's Suggestions), and in "Look" their face from up to four of their other items
  (`comparisonFaces`: one confirmed face an item, the largest and surest first; none confirmed, the
  person most like them on items tagged with them, which the row says is not confirmed). Fetched
  when Look opens, once a performer. Look, the "Play it here" drawer's heading and a History
  face's tooltip name the item by its file — the file name whole, its folder below — since a title
  may be scraped and the file name is often where a performer or a studio is written.
- **One with Performers** (2026-10-11). Two lists — who the item is tagged with, and who the faces
  found in it — were one question asked twice: a confirmed person is a performer tag, so they
  showed in both. The viewer's Performers section (`ItemPerformers`, across the page's width) is
  now the only one. A tagged performer is one card, carrying their face in the item where one was
  found — solid when confirmed, dashed when it only looks like them — whose menu goes to the
  moment, says "Yes, that's their face" or "Not their face" (the tag stays). After the cards, for
  administrators, who else may be in it as dashed cards: "‹name›?" with Yes / No for a face that
  looks clearly like somebody not tagged, "‹name›?" with Add / Not them for a name in the item's
  text, and "Also ‹name›?" with Yes / No for a second person who looks like a performer it is
  tagged with — one person split in two, who was shown nowhere once the tag was on (2026-10-21);
  No refuses those faces and leaves the tag. A tagged performer's card carries a confirmed face
  of theirs where there is one. The faces nobody matched come first, ahead of the box a name is
  typed into, each with "Who is this?" and its name box open — the three most seen, the rest
  under "N more faces" (2026-10-21: a face found is better evidence than a name remembered, and
  folded under a dim link it was never answered). A performer's × asks how: **Remove tag** only takes it off (`notThem: false` on the tag edit), and their face may
  be suggested again; **Not them** is the untag-by-hand of "Corrections stick", refused on the
  item's faces and name. Everybody else sees the cards, without the faces.

**As built (2026-10-07)** — `apps/web/src/lib/services/faceService.ts`, `components/faces/`:

- **Administrators, library performers.** What is decided here becomes the library's tags, so it
  is the OCR review's audience. A private performer is one person's vocabulary, and faces are
  read for everyone.
- **On the tag's Organise page, not its browsing page** (moved 2026-10-09; first built above
  the shelves). `/tags/[id]/organise`, reached by "Organise" beside the tag's other actions, has
  two tabs, held in the address: **To check** — "Likely", then the performer's Matches rows
  (`FaceReviewSheet` narrowed to them, with its kind control and keys), then the name-only
  hand-off — and **Their face**. Any other tag, or anybody but an administrator, gets only "Find
  untagged". Above the shelves they were asked for on every visit, since
  they were within reach of the viewport, and each read crosses every face in the library
  (`reviewPairs`) — synchronous SQLite on the web process's one thread, from pages the worker's
  commits keep evicting. With the worker busy that took over a minute, and held up the shelves'
  covers and every other request with it. A separate route, so browsing can never mount it.
  Organising still matters most; it now has a page of its own rather than a toll on browsing.
- **"Their face" is one strip of confirmed faces, not a list of groups** (revised 2026-10-07).
  The faces stage splits one person into several groups — angles, light, makeup, years — and once
  confirmed they are all simply them; showing each as a card asked the same question several
  times. So the section shows up to twelve of their confirmed faces, one an item, largest and
  surest first, whichever groups they are in, cropped square from the sprite tile or cover
  (`faceCrop`), each opening its item at that moment, and "Confirmed on N items".
- **Groups still to check are Matches rows, on the page** (revised 2026-10-09). They were a
  link, "N items with their face to check", to Review › Faces › Matches narrowed to the performer —
  a second page for the same question. The rows themselves now sit under "Likely", asking about
  them face by face, with ticks; Review's `?performer=` remains for links from elsewhere.
- **The groups themselves are behind "Show face groups"**, collapsed: how the stage grouped their
  faces, each with "Not ‹name›", for taking back a confirmation that was wrong. A group's state is
  `groupStateFor` over its counts, computed per request.
- **"Likely" is where a face and the name agree** (revised 2026-10-08): untagged items with a
  face in one of their groups — confirmed, proposed, or like their confirmed face — _and_ their name
  in the filename, title or burned-in text. The strongest evidence there is, and the one thing no
  other place shows. Confirmed faces first, then proposed, then resembling; more names first
  within each. Each card has "Add ‹name›" — a `TagBatch` the undo list can withdraw — and "Not
  ‹name›", which refuses both what put it there: its faces in their groups and its name match
  (`ItemRefusal`), so it is asked about nowhere again. "Add ‹name› to all N" tags the whole list
  as the server counts it, not the pages that happen to be loaded. Above it, "N with only their
  name → Find untagged". It was a list of every kind of
  evidence, which duplicated both, and its "add to all shown" swept weak name-only cards in with
  confirmed faces.
- **"Find untagged" stays beside "Likely"** (restored 2026-10-07; on the Organise page since
  2026-10-09, where every tag kind has it). It was removed
  when "Likely" arrived, on the reasoning that "Likely" lists the same named files; but matching by
  filename alone and tagging from the library's grid is the way through a performer just added,
  before any of their faces are read, and the grid's selection is the faster tool for a long list.

**Review › Faces as built (2026-10-07)** — `reviewFaces` and `decideFaceReview` in
`faceService.ts`, `components/faces/FaceReviewSheet.tsx`, `/api/faces/review`:

- **One row a group, and only the faces being asked about can be ticked** (revised 2026-10-07).
  The first version showed the group's largest faces and tagged "N items", a subset nobody could
  see: some faces shown were on items already tagged, some untagged items were not shown. Now a
  row shows one face for each item the decision would tag, up to 24, all ticked to start with,
  each with a link to its item at that moment. On Matches, up to four faces from items already
  tagged with the performer sit apart above them, "for comparison" — what proposed the match,
  not part of it.
- **What is ticked is what is tagged.** Tagging tags exactly the ticked items, as one `TagBatch`
  the undo list can withdraw, and confirms their faces in the group; the unticked ones' faces
  there are refused for the performer, so they are not asked about again. The rest of a group
  larger than a row comes back as the row afterwards.
- **Matches** is every pair of a performer and a group that `groupStateFor` calls confirmed or
  proposed and that is on items not tagged with them, most such items first. "None of these are
  ‹name›" refuses the whole group, as "Not ‹name›" on the performer's page does. "Someone else…"
  asks a different question, so it starts with nothing ticked: tick the faces that are the person
  named, then a name — picked, or new and so coined as a library performer. Those faces are
  refused for the one proposed and tagged as the one named; the rest of the group is left as it
  was. (It used to reuse the ticks set under "untick any that are not ‹name›" to mean "these are
  someone else", and refused the whole group.) Once a row is tagged as somebody, "More for ‹name›"
  narrows Matches to their rows: the face just compared is the one in mind. (Their rows used to
  jump to the top by themselves — `prefer` — which reloaded and re-sorted the list under the
  person working it; see "A list that holds still".)
- **One person split across groups is asked about as that person.** See "One face, one score"
  below: a group with no tags or decisions of its own whose items look like somebody's reference
  is a Matches row, "Looks like them", with their confirmed faces for comparison — not an Unnamed
  row asking "Who is this?" of somebody already named.
- **Unnamed** is every group on two or more items that no performer is confirmed, proposed or
  resembled for, most items first, each with "Who is this?" and the same ticks. Naming one tags
  the ticked items, which makes the group that performer's; what is left of it moves to Matches.
  **Only undecided faces are ever asked about** — nobody's, not set aside (revised 2026-10-08).
  Naming a few faces of a mixed group refuses the many unticked ones for that name, so by count
  the group was not theirs, and it came back whole, the named faces with it. Now it comes back
  only while two or more items' faces in it are still undecided, showing only those.
- **A group of two people.** The grouping line is a single threshold, and a group occasionally
  holds two people. Untick the ones who are not the person, name the rest; the unticked faces are
  refused for that name. What is left over — faces nobody's, not set aside, and refused for
  somebody — comes back to Unnamed on its own once it is on two or more items, showing only those
  faces, to name the other person.
- **"Can't tell" is remembered** (revised 2026-10-08): `Face.skippedAt` on the faces shown,
  carried across a re-run of the stage as decisions are. The group leaves Unnamed until three
  items' faces join it that nobody set aside, and then shows only those. A skip on Matches is
  remembered the same way (revised 2026-10-08): a row skipped only for the visit was asked about
  again on every one.
- **Keys, as OCR's**: `j`/`k` move, `1`–`9` and `0` tick the first ten faces, `x` ticks all or
  none, `a` tags, `d` none of these, `n` someone else (Matches) or the name box (Unnamed), `s`
  skips. What each row has ticked is held by the list rather than the row, so the keys reach it.
- **Coining is checked.** A typed name that is not already a performer, but is near some — the
  vocabulary's own search, typos and aliases included — shows "Already in the library:" with
  those names to pick, and the button says "New performer". Two performers for one person are a
  merge somebody has to notice later.
- **Computed per request** from the faces' counts — one query for every pair, one for every group's
  size — and paged after. Twelve milliseconds on the NAS with the pages warm, three seconds cold,
  at the first few hundred faces; to be measured again when the first pass is done.
- **Measured again (2026-10-09), at 75,000 faces in 3,500 groups**, on a copy of the NAS's
  database (`db:diagnose --cost`, timings on an SSD with the pages warm). Four things had grown
  with the library, and a performer's page paid all of them twice, once for "Their face" and
  once for "Likely":
    - **One query for each group that looks like somebody** — about 390 — counting its untagged
      items. Now one query for them all (`untaggedCounts`).
    - **The planner started from every item the viewer can see**, the one condition it has an
      index for, and walked the whole library to reach a few groups' faces. Reads narrowed to some
      groups now `CROSS JOIN` from the faces to their items, which SQLite never reorders.
    - **"Does the item carry them" walked every item the performer is on, once per face**:
      `MediaTag`'s indexes by item are partial (the library's tags, people's own), so a condition
      on item and tag could use neither. It is two probes now, one per index (`carries`).
    - **A performer's page asks only about their own groups** (`performerPairs`): those their tags
      or confirmations reach (`performerGroupIds`), and those with faces whose best match is them
      (`likenessGroupIds`). Each group's pairs depend on nothing but the group, so the answer is the
      library-wide one, narrowed. The pairs for the performer with the most confirmed faces went
      from 2.0 s to 0.08 s; Review › Faces' library-wide pairs from 2.0 s to 1.2 s, before the
      per-group queries, which are gone from both.
- **The row is not shared with OCR's.** The plan above was to pull the row out of `OcrMatchRow`
  when this was built. In the event they share the long list (`VirtualFeed`) and nothing else: an
  OCR row is an item with strings, candidates ticked and rules made; a face row is a group with
  one candidate or none, and naming is its main action rather than a fallback. A component bent
  to fit both would have been harder to read than the two.
- **No count beside the queue's name**: knowing it costs the whole computation, so the page says
  its size instead.

### Corrections stick

Before anything tags by itself, a correction must stay corrected (2026-10-08, from a review of the
whole pipeline):

- **A confirmation follows the item's tag.** A trigger on `MediaTag` (`MediaTag_face_ad`) clears
  a face's confirmation as a performer when their library row leaves the item — an undo, a
  withdrawn OCR rule, an untag by hand. It used to stay, so the group stayed theirs and the item
  came straight back. `replaceFacet` deletes only what leaves the facet now, so a performer kept
  through a re-edit keeps their confirmed faces.
- **Taking a performer off by hand is "not them".** The item's tag box, the bulk untag and taking
  off an OCR rule's tag refuse them on every face of the item and on its name match (`notThem`),
  so nothing that tags by itself puts them back. An undo is not a refusal: it puts things back as
  they were.
- **A merge carries faces.** `mergeTags` moves the merged-away tag's confirmations, face refusals
  and name refusals to the tag it joins; the delete used to take them.
- **Nothing is confirmed unseen, and every decision says how it was made.** `Face.decidedHow`
  and `FaceRefusal.how`: `shown` — the face was on screen; `item` — said of the whole item, as an
  untag is; `inferred` — carried to a face nobody saw, an item's other faces in the group. A
  group's "That's ‹name›" on the performer page confirms the faces it showed and no others (it
  used to label the whole group from six samples), and "None of these" no longer refuses faces on
  items already carrying them, which nobody was asked about. What is measured — `FACE_DOUBT`, and
  the lines that will tag by themselves — is measured again on `shown` and `item` decisions as
  they accumulate; the first table above predates the distinction.
- **A re-run keeps its decisions across a small shift.** The face found again may be up to two
  seconds from the one decided about (`SAME_MOMENT_MS`), nearest first, the box still mostly the
  same box. Exactly the same moment used to be required, so a re-made sprite dropped them all.

**And the loops** (2026-10-08). A group's state counts _items_ now, not faces — one video with
eight confirmed faces is one item's say, and used to outvote seven items refused once each.
Naming a leftover face as the very performer it was unticked for withdraws that refusal and tags
it; it used to tag nothing, say so, and come back. The grouping job writes `groups.bin` with each
batch, so a run that dies midway leaves the file and the rows in step.

### Decisions you can take back

**A face decision had no identity** (2026-10-10, from a review of the whole workflow): nothing
recorded which rows one press wrote, so nothing could be listed or undone exactly. 84% of
confirmations and 95% of refusals were never on screen; refusals, "can't tell" and "not one person"
had no list and no undo; undoing a review's tags cleared its confirmations but kept the refusals the
same press made; an untag's refusals outlived the tag being added back; and a single refusal carried
to an unseen face vetoed tagging the whole item by itself, unseen.

- **`FaceDecision`, one row a press**, by a person or by the app tagging by itself: the verdict
  (`is`, `isNot`, `notOnePerson`, `later`), of whom, from which surface, the tag batch it made, what
  it wrote, and when it was undone. Every row a press writes points at it — `Face.decisionId`
  (confirmations, can't-tells, not-one-persons), `FaceRefusal.decisionId`, `ItemRefusal.decisionId`
  — stamped by `faceDecisionRepo.record`, which wraps the writes: while it runs, `activeDecision()`
  is the press, and a batch made inside it is attached (`attachBatch`). A press that wrote nothing
  leaves nothing; one inside another is part of it. Writes outside any press carry none, as before.
- **Undo takes back exactly what one decision wrote that still stands**: its tag batch withdrawn if
  it still stands, its confirmations and can't-tells cleared, its refusals deleted. A later
  decision's rows are that decision's. Undoing a refusal makes faces undecided again; it does not
  restore a confirmation the refusal had taken back. For the app's own tags the action is
  **Wrong**: undone, and "not them" on those items, counted against tagging by itself.
- **History** (Review › Faces) lists every decision newest first — everybody's, yours, or the
  app's — with a few of its faces, what it did, where, and Undo.
- **`ItemRefusal` replaces `MentionRefusal`**: "not them on this item", said from "Find untagged",
  by untagging by hand (now on every item, not only those whose text names them), from "Likely",
  or from an item's page. Adding the tag again withdraws it, and the item's face refusals the
  untag made (`item`), by trigger (`MediaTag_refusal_ai`): the later word wins. Refusals of faces
  seen on screen stay.
- **A refusal carried to an unseen face no longer vetoes an item** for tagging by itself; a refused
  item, or a face somebody saw, still does.
- **What was decided before is carried over** as decisions ("Before history was kept"), grouped by
  the press that wrote it — one statement stamps one `CURRENT_TIMESTAMP`, so its rows share their
  performer, person and second. A confirmation and the refusals made with it are one decision, its
  tag batch attached where one of the same second still stands. The app's tags are one decision a
  batch. On production that was 290 confirming presses (2,007 items), 26 refusing ones, 3 can't-tell
  or not-one-person, and 386 of the app's batches (537 items), in under a second.

### A person in a video

**A face is the wrong thing to ask about** (2026-10-10). The stage keeps up to twelve faces an
item, and on videos with a face confirmed on screen a median 92% of them are that one person:
asking "which of these crops is them" asked one question twelve times, and a library-wide group
made the same person into several rows and several people into one.

- **An appearance is one person in one item** (`FaceAppearance`): the item's faces gathered at
  `APPEARANCE_NEAR` (0.30 — the grouping's 0.35 split one person in 57 of 576 such videos, 0.30 in
  37; looser began to take in faces refused as them), with its clearest face (largest × surest)
  and whether that face is **legible** (`LEGIBLE_EYES` 16 px, `LEGIBLE_SCORE` 0.6: a line for being
  read, not for being right — refused faces pass it as often as confirmed ones; 20 px and 0.7 hid a
  quarter of what people confirmed). In a video a person is seen at least twice
  (`APPEARANCE_MIN_VIDEO_FACES`); a photograph's single face is its person. Faces taken out of
  grouping as "not one person" are nobody's person.
- **Scored as a person**: the centre of its faces against every reference, best match and runner
  up kept, by the `faceAnchors` run. Nothing is filed against an appearance: decisions land on its
  faces, so a run may make them anew, with new ids, and lose nothing — though a person gathered
  from the same faces as before keeps their row (§5f "Only what changed").

### Suggestions

**Replaces Matches** (2026-10-10). Matches asked about a group because a group was mostly tagged
as somebody, and only then scored its faces — so rows came mostly doubtful: of 169 faces refused on
screen, 2 had the refused performer as their best match. Suggestions asks only what the score
backs:

- **An appearance is suggested for its best match** when it is legible, at `SUGGEST_LINE` 0.55
  with `SUGGEST_MARGIN` 0.1 over anybody else — or `SUGGEST_NAMED_LINE` 0.45 where the item's text
  names them — on an item not carrying them and not refused for them (`ItemRefusal`), with none of
  its faces confirmed as anybody or refused for them by somebody who saw it. Scored per
  appearance, leave-one-item-out on production: 83% of the appearances people confirmed pass, and
  none of the 170 they refused (their highest scored 0.552, and failed the margin). Per face the
  same line kept fewer than half of the confirmed faces. About a thousand suggestions at the start,
  most of them photographs.
- **A performer at a time**: everyone with suggestions, most first; then one card for each person
  in each item, the surest first, every card ticked as them. A press makes a card not them, another
  unsure — left undecided, asked again later. "Look" shows the frame and their other moments in the
  item; "Play it here" the item. One save is one decision (History): those that are them tag their
  items, as one batch, and confirm all their faces in the item (the one shown `shown`, the rest
  `inferred`), withdrawing any earlier refusal of them — the later word; those that are not are
  refused for the performer — the person, not the item, which may hold the performer elsewhere.
- **It holds still**: decided cards stay where they were, saying so; the list is read again only
  on Refresh, or the next visit.
- **Matches stays for now**, off the tab list, behind a link in Suggestions, and goes once
  Suggestions has carried the work for a while.

### New people

**Replaces Unnamed** (2026-10-11). Unnamed asked "Who is this?" of library-wide groups, which
chained unrelated faces together — the largest held 1,537 faces from 171 items — and of any group
on two items. New people asks only of strangers seen often enough to be somebody:

- **Who is a stranger**: a legible person in an item matching no reference (best match below
  `NEW_PERSON_UNMATCHED` 0.40), with a clear face (`NEW_PERSON_EYES` 20 px, `NEW_PERSON_SCORE`
  0.7 — stricter than to be shown, since a stranger is named from a few faces alone), and none of
  their faces confirmed, put off or taken out.
- **Gathered in the references run** (`gatherNewPeople`): each stranger joins the gathering whose
  centre is `NEW_PERSON_NEAR` 0.55 like them, or starts one; nothing merges by a bridging face. A
  gathering on fewer than `NEW_PERSON_MIN_ITEMS` 3 items is a face in passing and is not asked
  about. `FaceAppearance.newPersonId` holds it, gathered anew whenever anything changed — decisions
  land on faces, so nothing depends on a gathering surviving; a gathering keeps the id most of its
  people already had, so an unchanged one is not rewritten. Measured: about 110 gatherings of three or more,
  covering some 460 videos, median four items.
- **Asked a few at a time**: up to eight of a gathering's items, one card each, all ticked; press
  one that is somebody else to leave it out. **Name** them — picked, or coined with the typo check
  — and the ticked items are tagged and the people's faces confirmed, which is a reference the
  next run matches all their other items against. **Not one person** takes their faces out of
  every person and gathering for good (`scatteredAt`); **Later** puts them off (`skippedAt`). Each
  is one decision in History.
- **What went with the groups**: `Face.groupId`, `FaceGroupStat`, `FaceGroupDissolved`,
  `faces/groups.bin` (swept as an orphan), the `faceGroups` job — the faces stage now queues the
  references run itself, once a burst has settled — and with them Matches, Unnamed, Likely (a face
  and their name together is a suggestion at `SUGGEST_NAMED_LINE`), "Looks like them" and the
  per-row face scoring.

### Performers with no single face

**Some performers have no one face** (2026-10-09): theirs never shows — masked, their own point of
view, always cropped out — or the name is not one person. Left alone they mislead the matcher: their
tagged items count as evidence for whoever is on screen, and a partner on most of their items can
become their reference, and then a name the auto-tagger applies.

**"No single face"** is said of a performer once, on their page, by an administrator
(`PerformerNoFace`, carried by a merge), and every part of face matching then leaves them out:

- no reference is built for them (`confirmedFaceRefs`, `taggedFaceRefs`);
- their tags are no evidence about any group, either way — an item tagged with them and one other
  performer is that other performer's single-performer item, and one tagged only with them says
  nothing (`singlePerformer`, `performerGroupIds`); faces confirmed as them propose no pair;
- so nothing is proposed, looked like or tagged by a face for them; "Likely", "Find untagged" and
  "People in this item" suggest them by name only;
- their page says so in place of their faces, with "Undo". What was confirmed for them is kept,
  ignored, so undoing it restores everything, and their reference is rebuilt at once.

No prompt asks about likely candidates: few performers need it, and the person who knows says so.

### Their faces

**A performer's Faces tab** (2026-10-10) replaces "Their face", its face groups and "Pick their
face". "Their face" let a person confirm faces sometimes and not others, refuse a group only whole
when some of it was them and some not, and gave no way to see or undo what was refused. Now every
person in every item is a card (`PersonCardView`), and each section says one thing of them:

- **Confirmed**: one card an item, the faces confirmed as them, most recently decided first.
  Pressed and saved, "take back": the confirmations go and the faces are refused for them, so they
  are not suggested again. The item's tag stays — that is the undo list's.
- **Their items**: their own items — tagged by hand or by name, never by a face — with nobody on
  them confirmed, each with its people (appearances). Press whoever is them; saved, all those
  people's faces there are confirmed. More than one an item since 2026-10-21: grouping at
  `APPEARANCE_NEAR` still splits one person in a video in about one in sixteen, and "one an item"
  left the other half to be suggested again, or never asked about once the item was tagged.
  Always there, where "Pick their face" disappeared once three items were confirmed.
- **Ruled out**: one card an item, the faces refused for them — those somebody saw, or every one
  with "Also faces nobody saw". Pressed and saved, "restore": undecided again, to be suggested
  again. A restore is itself an undoing, and is not listed in History; the rest are one decision
  a save.
- **"No single face"** sits above, as before. Their Suggestions are on the "To check" tab, where
  the face groups were.

Each section holds still while worked (`faceReview.performerPeople`), as Suggestions does.

### Grab bags

_Superseded 2026-10-11: face groups, the `faceGroups` job, Matches, Unnamed and Likely are gone. What replaced them is "A person in a video", "Suggestions", "New people" and "Their faces"; this section is kept for what it decided and why._

**Faces turned away or obscured have vague fingerprints**, each weakly like the average of the
rest, so they pile into one group of many people — the largest unnamed group in the library was 480
faces on 51 items (2026-10-08). Measured: faces from two of its items matched at 0.22 typically,
against 0.35 in groups confirmed as one performer; its faces sat 0.49 from its centre on average,
against 0.62. Nor were they small or unsure — eyes 24 px apart, detection as sure as anywhere — so
no floor on size or confidence would have kept them out.

- **"Not one person"** on an Unnamed row takes the group's undecided faces out of grouping for good
  (`Face.scatteredAt`, carried across a re-run): never grouped again, never evidence, never tagged
  by themselves. Faces somebody confirmed stay theirs. The group is dissolved too
  (`FaceGroupDissolved`): the grouping job drops its sums on its next run, or its averaged-out
  centre would go on drawing in the next obscured face. "Can't tell" stays the button for one
  person nobody can name — it brings the group back when new faces join, which a grab bag always
  does.
- **"Loosely grouped — may be several people"** marks a group whose faces sit below `LOOSE_GROUP`
  (0.52) from its centre on average — `|sum| / count`, written per group by the grouping job to
  `FaceGroupStat` — and Unnamed asks about those last. A mark, not a verdict: the loosest twentieth
  of groups confirmed as one performer sit at 0.50 too.
- **Not yet:** which way a face is turned. The stage could record it from the landmarks and keep
  faces turned well away out of grouping from the start, at the cost of reading every item again;
  worth it only if the button and the mark are not enough.

### A list that holds still

_Superseded 2026-10-11: face groups, the `faceGroups` job, Matches, Unnamed and Likely are gone. What replaced them is "A person in a video", "Suggestions", "New people" and "Their faces"; this section is kept for what it decided and why._

**Matches and Unnamed were a list that moved while it was worked** (2026-10-09): every decision
re-read every page loaded — each one counting every group in the library again, 0.8–3 s a page —
re-sorted it to bring the decided performer's rows first, and dropped rows a decision had made
moot from under the reader. Each row then fetched its faces' scores and reordered its faces when
they came. So it was slow, it shifted, it jolted, and things vanished and flew in.

- **One list a visit, made on the server.** The first page counts the library and keeps the
  ordered list in memory (an hour, a few dozen lists at most); every later page is a slice of it
  (`list` in the query), so only the first costs anything. Rows are still read as they are now,
  and a row of a kept list with nothing left to ask — settled since — is left out of its page.
- **Nothing re-reads it by itself.** The list is not under `tags`, so no tag edit reaches it, and
  it is never fetched again on focus. A decided row stays where it was as one line saying what was
  done ("More for ‹name›" beside a tagging); faces another decision settled — the same items tagged
  in another row of the group or of the performer, set aside, or scattered — stay in their rows,
  dimmed and done, and leave that row's decision. A row with none left says "Settled by an earlier
  decision" in one line. "Refresh list" makes a new one.
- **A row is drawn once, finished.** Every row's faces are scored as soon as its page arrives
  rather than as it nears the screen, and the row holds a placeholder until then, so its faces
  never reorder and its "?" defaults never flip under a finger. The note under the faces keeps its
  space when empty, so ticking does not change a row's height.
- **What went wrong is said over the page**, not above the list, where a message pushed every row
  down; what went right is said in the row.

### Checking faces quickly

_Superseded 2026-10-11: face groups, the `faceGroups` job, Matches, Unnamed and Likely are gone. What replaced them is "A person in a video", "Suggestions", "New people" and "Their faces"; this section is kept for what it decided and why._

**Twenty-four faces that all look equally likely are twenty-four to inspect** (2026-10-08). And the
only way to look closer was "Open", which left the review, lost the ticks, and came back to a list
that might have moved. So a row now does three things:

- **The doubtful first.** Each face is scored by how alike it is to the person asked about — to
  the performer's confirmed faces (and this group's tagged items' faces), each face's own item
  left out so a video never vouches for itself; or, where there is nobody to compare with, to the
  row's own faces, their mean taken again without the least alike quarter so a few strangers
  cannot drag it. The row shows the least alike first, marked with a dot, below `FACE_DOUBT`. Asked for
  per row as it nears the screen (`/api/faces/review/likeness`): one small vectors file per item,
  read per request and not kept.
- **A closer look in place.** Hold a face, press "Look" under it, or Shift with its digit: the
  whole frame it was found in, the face marked, the same item's other moments of that person,
  and tick or untick from there (`FacePeek`).
- **Play it beside the review.** From the closer look, the item plays in a drawer at that moment
  (`FaceViewDrawer`); closing it returns to the row as it was. The ticks are also kept in the
  browser for the visit, so leaving through "Open the full item" and coming back finds them.

**The line, measured on what was decided** (2026-10-08): 2,341 confirmed faces and 147 refused
ones, across the 72 performers with five or more confirmed faces, each scored against the rest of
that performer's confirmed faces with its own item left out.

| likeness at least | confirmed above | refused above | precision | confirmed kept |
| ----------------- | --------------- | ------------- | --------- | -------------- |
| 0.35              | 2,162           | 17            | 99.2%     | 92%            |
| 0.40              | 2,025           | 9             | 99.6%     | 87%            |
| 0.45              | 1,826           | 4             | 99.8%     | 78%            |
| 0.50              | 1,538           | 3             | 99.8%     | 66%            |
| 0.55              | 1,231           | 0             | 100%      | 53%            |
| 0.60              | 883             | 0             | 100%      | 38%            |

The highest-scoring refused face was 0.523; half the confirmed faces score above 0.556. The refused
faces are hard ones — the review only ever showed faces the groups or a likeness put forward — so
they are the right negatives for the question. `FACE_DOUBT` is 0.35: 92% of confirmed faces above,
88% of refused ones below.

**Tagging by itself** — see its own section below.

### One face, one score

**The question "is this face them" had four answers** (2026-10-08, from the pipeline review): a
group's state from its counts, kin likening group sums to group sums, a row's likeness for its
order, and the name evidence — and they disagreed. Now a face is scored one way, everywhere: its
similarity to the performer's **reference**.

**A reference** is the mean of a performer's faces item by item, then across items, so one video
with twelve faces of them has one item's say (`performerCentre`). Its faces come from two places:

- **What people confirmed.**
- **The face their tagged items share** (`sharedFace`): across every item carrying them — scenes
  with two or three people included, which the group proposals ignore — the face that recurs,
  where everybody else on screen varies. Two faces counted as one person at 0.45; the face must be
  on at least 60% of the items, and the next most shared face on at most half as many (two people
  always tagged together decline). Measured on the library on 2026-10-08, from tags alone: for all
  33 performers with five or more confirmed items, the face found was the confirmed one, and none
  of the 1,293 decided faces in it had been decided otherwise; 158 of 201 performers with read
  faces had one clearly, 78 of them with nothing confirmed yet. Where people have confirmed a face,
  a tags' face that is not like it — the partner they are always tagged with — is left out. Tags
  made by a face itself (`source = 'ai'`) never count: a reference would vouch for itself.

A reference needs three items. The `faceAnchors` job builds them, writes the vectors to
`faces/anchors.bin` and what each is built from to `FaceAnchor`, then scores every person in an
item against every reference (§5f "A person in a video"). It runs once a burst of the faces stage
has settled, a minute or two after decisions, and once at start-up. It used to keep every single
face's best match too, in `FaceMatch`; nothing read that after Matches and "Looks like them" went,
and the table was dropped on 2026-10-13 (below).

**What read it** (most of this went with the groups, §5f "New people"):

- **The review's order and default ticks.** A row's faces are scored against the candidate's
  reference; below `FACE_DOUBT` they come first, marked with a dot, **and start unsure** — left
  undecided rather than refused, since the app's doubt is not a person's "not them" (of refused faces
  nearly nine in ten score below it, of confirmed ones fewer than one in ten). Without a reference
  (Unnamed), against the row's own faces, and none start unsure.
- **Unsure, face by face** (2026-10-09). A face goes round three states as it is pressed — ✓ them,
  ✕ not them, ? unsure — or by its digit, or from the closer look's "Them / Not them / Unsure". An
  unsure face is a decision put off, not made: nothing is written for it — not tagged, not refused,
  not set aside — so its group asks about it again later. Later, not at once: a row decided with
  faces left unsure is hidden for the rest of the visit. The app's own "less like the rest" is a
  dot, so a "?" is only ever a person's.
- **"Looks like them"** replaces kin. A group no performer is confirmed or proposed for, with half
  or more of its items (and at least two) having a face whose best match is somebody at
  `LOOKS_LIKE` (0.45) and `LOOKS_LIKE_MARGIN` (0.1) more than anybody else, is a Matches row for
  them — `resembles` — unless faces of it were refused for them. `FaceGroupKin` is dropped.
- **"Likely"** counts a face that looks like them by its best match, grouped or not — so faces in
  no group are reached at last.
- **A performer with nothing confirmed** shows the face their tagged items share, labelled as
  such, in place of "No face confirmed yet".
- **Tagging by itself**, next.

### Only what changed

**A run used to redo the library** (2026-10-13, from the NAS logs). Naming one person queued a
run that read every faces file and four whole-library statements — 15 s for the confirmed faces
alone, a table probe each on the NAS's disks — scored all 74,000 faces against all 300 references,
deleted and rewrote 56,000 `FaceMatch` rows and every person in every item: some 45 s of reads and
writes on the disks the web app serves from, and every page slower while it ran. Now:

- **The first run in a process does the whole library and keeps its work**: every item's face
  vectors as stored (a byte a dimension, ~40 MB), every reference, every person with their centre
  and their two best matches, and what the tables hold. That is the start-up run, which a deploy
  or a restart pays once.
- **After that a run takes what changed**, from `FaceStale`, kept by triggers so that every path
  is covered — a press, an undo, a merge, an untag, a library switched off, a cascade from a
  deleted item: `'item'`, an item whose faces were found again, deleted, confirmed, set aside or
  taken out of grouping; `'tag'`, a library performer whose confirmed faces, tagged items,
  refusals, "no single face" or tag changed. The run takes the rows as it starts; a change made
  while it works is the next run's. Each trigger errs wide — too much costs arithmetic, too little
  a stale score.
- **Those items are gathered again** (their files read again), **those performers' references
  rebuilt** — with the performers on the regathered items, whose shared face may have moved — and
  a reference rebuilt to the same centre has not moved.
- **Everybody is rescored only against references that moved, exactly.** A person's best match
  and runner-up are kept; every reference that did not move scores what it did, at most the old
  runner-up, so the new two best are among the old two and the moved. Where one of the old two is
  among the moved, the third was never kept, and that person is ranked against everybody. Exact
  ties go to the lower tag id, so the order references are offered in does not matter.
- **New people are gathered again whole** when anything changed — a gathering depends on the
  order people join it — from what is kept, which is arithmetic, not reading.
- **Only rows that differ are written**: a person gathered from the same faces keeps their row,
  so a run after a naming writes a few dozen rows, not the library.
- **A failed run forgets what it kept**, and the next starts from the tables again.
- **`FaceMatch` is gone**: nothing read it since Matches, "Looks like them" and Likely went, and
  filling it was most of the arithmetic. `idx_Face_tag` gained `vectorIndex`, so a performer's
  confirmed faces are read from the index alone.

Measured on a synthetic library of the production's size (11,000 items, 66,000 faces, 460
performers, 22,000 people), on the development machine: the whole library 38 s; a run with
nothing changed 78 ms (the Would tag query); after naming a new person on 21 items 1.7 s, 57 rows
rewritten; after confirming 20 people as the largest performer 1.3 s, 117 rows — no faces file
read but those of the items that changed. What runs keep is about 80 MB there, nearer 65 MB on
the production library's 12,000 people.

### Tagging by itself

**Per person in an item, since 2026-10-10.** The rule below, read from single faces, caught only
29% of the people people confirmed. It is replaced by one read from appearances (`autoTags`,
`FaceAutoTag.rule` 2): a person in a **video**, seen at least `AUTO_TAG_MIN_MOMENTS` (3) times, whose
faces together match them at `AUTO_TAG_LINE` (0.6) with `AUTO_TAG_MARGIN` (0.1) over anybody else,
their reference resting on `AUTO_TAG_MIN_ITEMS` (5) items; legible; the item not refused for them,
and no face of the person confirmed as anybody or refused for them by somebody who saw it. It takes
in 73% of the people confirmed, and no person refused scored above 0.552. **Photographs never** —
there is no measure of them yet — and a name never tags.

- **A new rule earns tagging by itself.** Its proposals go to Would tag as before; it tags by
  itself, with the switch on, only once `AUTO_TAG_TRIAL` (30) of _its own_ proposals were checked
  Right and none Wrong (`autoTagTrusted`, `faceAutoTagRepo.trial`). Until then it proposes, and Would
  tag says how far the trial has got. Right and Wrong speak for the whole person: all their faces in
  the item confirmed, or refused.
- **What the app tagged is in History**, one decision a performer a pass, where **Wrong** takes it
  off and says not them on those items (counted against it by the brake). "Tagged for you" is gone.

The rest of this section is the first rule, kept for what it found.

**Per item, scored per face** (2026-10-08). Groups merge and drift, so they are the wrong thing to
decide on; an item is tagged as a performer when its faces say so (`autoTags`):

- at least two faces, at different moments, whose best match is them at `AUTO_TAG_LINE` (0.6) and
  `AUTO_TAG_MARGIN` (0.1) more than anybody else — or, where their name is in its filename, title
  or burned-in text and not refused, one face at `AUTO_TAG_LINE_NAMED` (0.45);
- their reference resting on `AUTO_TAG_MIN_ITEMS` (5) items;
- nothing on the item refused for them, by face or by name; not already carrying them; and no
  person having checked the pair before. **A name alone never tags** — that stays OCR's rules.

0.6 sits above every refused face measured (the highest was 0.523), with a margin, because that
measurement was of faces the groups proposed: scoring every face against every performer gives a
lookalike stranger more chances.

**Shadow first: "Would tag".** After every `faceAnchors` run the rule's proposals are rewritten into
`FaceAutoTag` as `proposed`; nothing is tagged. Review › Faces › Would tag shows them in a random
order a visit keeps — so whatever is checked from the top is a fair sample — each with the face
that matched best and why. **Right** tags the item (a batch the undo list can withdraw) and
confirms that face as `shown`; **Wrong** refuses that face as `shown` and the item's other faces
matched to them as `inferred`, so the rule never proposes it again. The tally above the list says
how often the rule was right: the number that decides whether it may tag by itself.

**Then live, behind a switch** (2026-10-08). "Tag automatically" on the Would tag tab — off by
default, an administrator's to turn on, with the tally beside it — is the `faces.autoTag` setting,
which keeps who turned it on. After every pass the worker tags what the rule proposes: one
`TagBatch` per performer, in that administrator's undo list, its rows `source = 'ai'`, and the
pairs marked `applied`.

- **Correctable later.** Review › Faces › Tagged for you (now History) listed what faces tagged;
  "Not ‹name›" takes the tag off and is "not them" as any untag by hand is (`notThem`): the item's
  faces and name match refused, so it is never tagged again. Taking a face-made tag off anywhere
  else — the item's tags, a bulk untag — does the same, and marks the pair `removed`. Undoing a
  pass's batch takes all of it back and proposes none of it again.
- **A brake.** Once 50 have been tagged, if more than one in a hundred were taken back
  (`autoTagBraked`), faces stop tagging by themselves until the share falls, and the tab says so.
- **Never its own evidence.** Tags with `source = 'ai'` count toward neither a group's proposal
  (`SINGLE_PERFORMER`) nor a performer's shared face; and a face-made tag confirms no face. Only a
  person's decisions build a reference.

### What faces give back

- **Performers on the untagged 88%**, which is the point.
- **Not a tasting of a performer's moments** (dropped 2026-10-07). A face carries a time, so a
  performer's page could play only the moments their face is on screen. Faces are here to organise a
  large, disorganised library — to put a name on files that have none — not to make another way to
  watch it.
- **A performer's picture.** Until somebody chooses one, a performer's picture is read from their
  largest confirmed face, framed head and shoulders from the original (§6 "A tag's picture").
- **A performer tether for looks.** CLIP does not know who anyone is (§5e); a face does. "Glasses,
  with her" becomes a look set narrowed by a tag the faces made trustworthy.

### Order of work

1. ~~A bake-off on a sample~~ — done 2026-10-07, below.
2. The `faces` stage, opt-in, after `sprite`.
3. ~~Review › Faces, Matches and Unnamed~~ — done 2026-10-07, above.

### The bake-off

**Scored by the tags already given, then looked at blind** (decided 2026-10-06). 2,887 videos
carry exactly one performer, across 290 performers, 88 of them on ten or more — a ground truth that
needs nobody to look at a face:

- **Sample:** the performers with ten or more single-performer videos, up to twelve videos each so
  the busiest do not decide it; the 75 single-performer photos; and ten performers held out
  entirely, as the strangers a library is mostly full of.
- **Per video:** every sprite tile through each detector; each face aligned on its five landmarks
  and through each recogniser; faces grouped within the video.
- **Closed set:** half of each performer's videos enrol them, the rest are asked who they show —
  right first time, and in the first three. CLIP by overall look managed 51% and 64% (§5e); faces
  have to beat that clearly to be worth a stage.
- **Open set:** the held-out performers' videos must name nobody. Each threshold gives a pair — how
  many suggestions would be right, and how many of the true matches it finds — and the stage's
  threshold is chosen from that curve.
- **Coverage:** how many videos yield a usable face at all from tiles, by orientation and
  resolution.
- **Cost:** per tile and per face on the desktop, scaled by §5e's desktop-to-NAS ratio, and resident
  memory.
- **Then a blind look** at the borderline: pairs of crops, the model's verdict hidden, "same person?"
  — in a local page, blurred until pointed at, never published — to tell a model's mistakes from
  a tag's.

**The candidates**, both licences (decided 2026-10-06): InsightFace's large set (SCRFD-10G and
ArcFace R50) and small set (SCRFD-500M and the MobileFaceNet ArcFace), licensed for non-commercial
use, which a personal library is; and OpenCV's YuNet and SFace, Apache-licensed. Chosen on the
results: accuracy first, then memory and speed on the NAS.

### What the bake-off found (2026-10-07)

78 performers enrolled from half their single-performer videos, 10 held out as strangers; 1,030
videos, 90k tiles, 4,112 posters, 41 photos. Tiles and posters, faces of 10 px between the eyes or
more:

| set                         | first guess | top 3 | videos with a face | found, 95% right | NAS a video |
| --------------------------- | ----------- | ----- | ------------------ | ---------------- | ----------- |
| CLIP's overall look (§5e)   | 51%         | 64%   | —                  | —                | —           |
| **InsightFace large**       | 86%         | 88%   | 92%                | 81%              | ~30 s       |
| … every 2nd tile, ≤12 faces | 83%         | 84%   | 89%                | 80%              | **~14 s**   |
| SCRFD-500M + R50, thinned   | 80%         | 81%   | 87%                | 77%              | ~3 s        |
| InsightFace small           | 78%         | 83%   | 91%                | 53%              | ~4 s        |
| YuNet + SFace               | 34%         | 41%   | 97%                | never 90% right  | —           |

- **Tiles beat posters.** Four posters a video at ~630 px found a usable face in 60% of videos; a
  hundred 200 px tiles in 93%. Upright videos did as well as wide (92% against 94%).
- **Photos**: 33 of 41 named right from their covers.
- **Strangers get named.** At the 95% point the large set still put a name on 9–11 of the 116
  strangers' items. Requiring a larger face did not help — from 10 px to 26 px lost a third of the
  videos and named as many — so these are lookalikes, not smudges. That is what confirmation is
  for, and why a refusal ("not her") is remembered on the faces.
- **The blind look** (55 pairs of crops, verdicts hidden): of the 12 confident disagreements with the
  tags, the owner saw the same person in 5, a different one in 3, and could not tell in 4 — so
  the tags, not the faces, are sometimes what is wrong, and a performer tagged under two names is
  worth looking for. Of 28 named strangers: 17 different, 1 the same, 10 too poor to tell. The 15
  controls: 13 the same, so thumbnail crops are good enough for a person to confirm from.
- YuNet + SFace's figures may owe something to the harness's preprocessing for SFace; they would
  have had to more than double to matter.
- Costs are single-thread desktop times scaled by CLIP's desktop-to-NAS ratio (×1.9): SCRFD-10G
  ~245 ms a tile, R50 ~200 ms a face, SCRFD-500M ~18 ms, MobileFaceNet ~21 ms.

The harness lives outside the repository, as §5e's did, and for the same reason; its shape is the
list above.

## 6. Multi-user

Real accounts from the baseline migration, using basket-bot's JWT scheme verbatim: short
access token in `Authorization: Bearer`, long refresh token in an HttpOnly cookie, `scopes`
carrying `"admin"`, `withAuth()` in every route handler.

| Shared (library-wide)                 | Private (per user)                                                                                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| media, files, probe metadata          | rating, favorite, hidden; favourite tags                                                                                                  |
| covers, sprites, previews, transcodes | view count, last viewed, watched                                                                                                          |
| duplicate groups                      | saved filters, home layout, prefs                                                                                                         |
| library tags (admin-curated)          | personal tags and assignments, notes                                                                                                      |
| —                                     | playlists and reels (shareable by opt-in), clips and their tags (private; a clip is readable through a shared reel, its tags never, §14d) |

Derived artifacts are expensive and objective, so they are never duplicated per user.
Everything a person _decides_ is theirs alone.

**Tagging is two separate systems: the library's and each person's own.**

- **Public tags** are the library's. Everybody sees them, and **anybody may set or remove
  one** — including a tag somebody else added, which is the collaborative norm and symmetric
  with adding. "Only the person who added it" would make correcting a typo impossible, which is
  most of the reason to let everyone tag at all.
- **Private tags** are one person's. Invisible to everyone else **including an administrator**,
  and searchable only by their owner.

Which system a write addresses comes from the **request**, never from the role. This replaced a
split on _who you are_ — an administrator's tagging was the library's, everybody else's was
silently private — which made a second household member unable to contribute to the shared
vocabulary at all, and an administrator unable to keep a note to themselves. Neither was chosen;
both fell out of one expression, `writesTo`.

**Two boxes, not one control with a toggle.** A toggle's failure mode is publishing something
you meant to keep: a wrong default, a sticky preference, a switch nobody noticed. Separate boxes
make publishing a different gesture rather than the same gesture in a different mode — and there
is no default to get wrong, because `scope` is required on every write and omitting it does not
compile.

**The two vocabularies do not fall back into each other.** Typing "beach" privately makes _your_
"beach", separate from the library's. Resolution used to go private-then-library, so one chip
meant "the library's tag, applied privately" in one place and "my own tag" in another. The price
is that a curated name cannot be reused privately; the gain is that a chip has one meaning.

`Tag.ownerId` carries the name's system and `MediaTag.userId` the assignment's, and **the pairing
is exact in both directions** — a tag with an owner is only ever assigned to that owner, a tag
without one only ever publicly. That was prose in `init.ts` and nothing implemented it; it is
enforced in `tagRepo.assign` now, because it spans two tables so a CHECK cannot see it and a
trigger would fire on a hot write path to restate what one function already guarantees. Two
partial uniques rather than one table constraint, so there is one "beach" in the library and one
"beach" each for as many people as want their own.

**`MediaTag.createdById` records who applied it**, separately from who it is _for_. Those were
the same fact while only an administrator could write a public row; the moment anybody can, a
public assignment has no record of its origin and a collaborative vocabulary has nothing to
review or revert. `ON DELETE SET NULL`, not CASCADE: a public tag belongs to the library, so
losing the account that applied it must not silently untag it.

Renaming, merging and deleting still follow ownership: `admin` for the public vocabulary, the
owner for their own. A private tag reports as not-found rather than forbidden — `admin` manages
the library, not other people's collections, and forbidden would confirm the tag exists, which is
half of what was being kept private. Merging across the two is refused, which is now simply the
two systems not touching.

**Facet counts are each system's own.** A public count is library assignments only, so the number
against a shared chip is the same for everybody; a private count is the viewer's. They used to be
ORed together, which made a public tag's count the viewer's own total — two people seeing
different numbers against one chip, with no number that was simply correct. The panel renders the
two as separate groups.

**Private tags are searchable, to their owner alone.** They are still absent from the FTS
document: `MediaSearchDoc.mediaId` is UNIQUE, so there is exactly one document per item, and one
shared index cannot hold per-user text without leaking it. They are matched on their _names_
instead — every word typed must prefix-match one of the viewer's own tags on that item, scoped by
a `userId` bound from the session.

A second, per-user FTS table was the obvious alternative and was rejected on evidence.
**bm25 is corpus-relative**, so scores from a table of four hundred documents are not comparable
with one of two hundred thousand, and ordering a union by relevance has no honest answer. It also
does not fit the stage machinery at all: `MediaStage` is keyed `(mediaId, stage)` and `Job` has no
user column. The cost of the chosen route is stemming — "performing" will not find "performance"
— which is the right trade for a short label as opposed to prose.

**Only `tag` can be private.** Performers and sources are facts about the item — who is in it,
where it came from — and those are true whoever is looking. A private one is either a fact the
library ought to know and does not, or a fact somebody has got wrong on their own. The catch-all
facet is where personal annotation belongs, and it is the only one that gets a private half.

It also removes a question with one right answer: with three private boxes, filing "to cut"
means first deciding whether it is a tag, a performer or a source — the faceting tax §5b already
charges, paid twice.

Enforced in `tagRepo.ensureTag` and `setScope`, not merely left unoffered. "Not offered" is not
a rule: a bulk apply, a hand-written request or a future scraper all arrive with a `kind` of
their own choosing. The schemas refine the same check so the refusal reads as a 400 naming the
facet rather than as whatever the repo throws — the message and the guarantee, in that order.

**Anyone coins, an administrator curates.** Creating a public tag is open to everybody — typed
in the box, applied in bulk — while renaming, merging and deleting one that exists is not. The
two halves look like one permission and are not, which is why the management screen says so:
without the first nobody contributes to a shared vocabulary, and without the second nobody can
clean up after them. `requireCurator` is the whole of it.

`Tag.createdById` records who coined a name, separately from `ownerId`, which says whose
vocabulary it is in. On a public tag `ownerId` is NULL whoever created it, so an open
vocabulary anybody may add to had no record of where any of its names came from — and that is
exactly the vocabulary in which somebody asks. The earliest `MediaTag.createdById` was
considered as a free substitute and answers a different question: a tag can be coined and never
applied, or first applied by somebody else.

**A tag can move between the two systems, and only its owner may move it.** For a public tag the
owner is whoever coined it (`createdById`): "nobody else has used it" is not ownership, and without
the check anybody could take a name somebody had just added to the library into their own vocabulary
before it was ever applied. A tag whose coiner is gone stays public. Publishing carries every item
you put it on into public view; unpublishing is refused once anybody else has used the tag, because
it would take a shared name away from everybody and strand their work. Not an administrator's call
either way: `admin` curates the library, and moving somebody's private tag into it is a decision
about their collection.

**Aliases travel with a tag that moves**, except any the destination vocabulary already gives to
another tag. The move is the owner's decision and should not fail over a nickname, so those
aliases stay behind and the result counts them (`aliasesDropped`). Publishing a name that the
library holds as an _alias_ folds the tag into that alias's tag, just as publishing onto a
library _name_ does.

Moving is not `mergeTags`, which keeps refusing cross-scope. That refusal exists so nobody can
publish _somebody else's_ private tagging; it must not stop the owner publishing their own, and
the ownership guard is what tells the two apart. When the public vocabulary already holds the
name, publishing folds the assignments into the existing tag rather than failing — the items
end up tagged either way, and the name everybody already uses survives.

Publishing is also the one vocabulary change that reaches accounts that were not looking at it:
public tags are in the search document and private ones are not (§5c), so it changes what other
people's searches return and must reindex every affected item.

**An administrator can withdraw anybody's public bulk apply**, and only their own private ones.
While a non-admin's batch was necessarily private, an owner-only undo was sufficient; once anyone
can publish `BULK_SELECTION_LIMIT` assignments in one gesture, an administrator who cannot
withdraw them is the one accident in the app with no remedy.

**Looking at the vocabulary is a different screen from tidying it.** The Tags section is four
pages: Performers, Sources and Keywords to browse, and Manage for the table, the unused tags and
the bulk applies that can be withdrawn. Browsing is for "show me everything with Dad in it";
managing is for "where is the one I misspelled". One screen served the second question and made
the first one a table of names with a count column.

- **Rows with a filmstrip, not cards.** A performer facet runs to hundreds, so a browse page is
  a list that scans downward, loaded thirty rows at a time as it scrolls. Each row is the name,
  its videos and photos counted apart — each count a link straight into the grid of just those —
  and as many whole thumbnails as the width allows. Cards were rejected for density: a wall of
  portraits holds a dozen people per screen where rows hold twenty, and a single cover shows one
  frame of somebody where a strip shows their range. A name's aliases sit under it ("also …"),
  since a performer is often known by the other one.
- **Tiles as the alternative, never the default.** A Rows/Tiles switch, kept in the address
  like the sort, shows each tag as one large card instead: the strip's first picture, wider
  than a library grid thumbnail and portrait-shaped for a performer, with the name over it.
  That is for somebody who knows the library by sight rather than by name. The density
  argument above still holds, so rows are what Sources and Keywords open to.
- **Performers is tiles only** (changed 2026-10-14). In use, people are found by face: once
  most performers had a portrait, the card was what got looked at and the rows were a detour
  through the switch. The page offers no switch; the other two keep it.
- **"Most videos", not "most items".** The count order ranks by videos, with photos only
  breaking a tie: a performer with forty photos and two videos is not who somebody browsing
  for something to watch is looking for. The counts shown stay split by kind.
- **The browse pages share their controls with Views & playlists (§14c).** One toolbar
  (`BrowseToolbar`) in one order — which shelf if there is a choice, search, order, Rows/Tiles,
  filters — pinned under the header on a wide screen as the library's working row is, and one
  row (`FilmstripRow`) for a tag, a companion, a view and a playlist.
- **Only tags that carry something.** An unused tag has nothing to show and belongs to Manage.
- **Keywords lists yours, then the library's.** It is the one facet that can be private; the
  other two pages have one list.
- **Each row's ⋯ menu opens Manage's own dialogues** — edit, merge, delete, publish — so a
  one-off fix does not mean leaving the page, and there is one set of dialogues rather than two.
- **A tag has its own page** (`/tags/<id>`): a picture window like the room's, the counts, a
  tasting and a showcase of the set, three shelves (recent, top rated, shuffled) that are ordinary
  library queries, and for a performer the people they appear with. "See all" is the library
  filtered to the tag; the page is a way in, not a second grid.

**The thumbnails change daily, not per visit.** A strip is a seeded sample: one windowed query
per page of tags, ordered by the same computed permutation the shuffled grid uses (`shuffle.ts`),
applied to rowids. The seed is the local day unless somebody presses reshuffle, which writes
`?seed=` into the address. Random per visit was rejected: Back from somebody's page landed on a
wall that had rearranged itself, and the art cache never got a second hit. Sampled items go
through `listByIds`, so a strip never shows an item the viewer could not open.

**Favourite tags.** Anybody can heart a tag they can see, with the item's heart — the same ♥/♡
in oxblood, one `FavoriteToggle` for both — on each browse row and on the tag's own page, where
`h` toggles it as it does on an item. The mark is in `UserTag`, beside the shared row rather than
on it, for `UserMedia`'s reason: nothing subjective lives on `Tag`. No ChangeLog row; it is
private state.

- **A filter, not pinning.** Browse pages get a "Favourites only" switch (`?favorite=1`). Pinning
  favourites to the top, or a Favourites section above the list, was rejected for scale: somebody
  with three hundred favourite performers would scroll past all of them to reach anybody else,
  and a section would show each of them twice.
- **The Tags area only, for now.** The flag is on the browse row and the profile, not on `Tag`
  itself, so pickers, Manage, the library filters and the room do not see it. Each of those is a
  separate decision when somebody wants it.
- **The mark follows the tag.** A merge, or a private tag published onto an existing name, moves
  people's marks to the survivor (a favourite on either side stays a favourite). Making a tag
  private drops everybody's mark but the new owner's — otherwise it would lie invisible and come
  back on publishing. A favourite keeps an emptied tag from being pruned, as an alias does. A
  favourite with nothing listable under it leaves the browse page (only tags that carry something
  are listed) but its own page still answers.

### A tag's picture

**A tag can have a picture of its own** (decided 2026-10-07). This was deferred at first, on the
reasoning that a headshot is what the `Person` promotion in §5b would carry. That reasoning was
reversed for the same reason aliases were taken off `Person`: the need is not only about people.
A source wants its logo frame, and a keyword wants a typical shot. And `Person` keeps the tag as
its join (`Person.tagId`), so a picture stored against the tag never has to move.

```
TagPicture  tagId → Tag (cascade), source ('user' | 'auto'), relPath, smallRelPath,
            mediaId → Media (set null), atMs, crop x/y/w/h, setByUserId, generatedAt
            PRIMARY KEY (tagId, source)
```

- **Two pictures at most, and the chosen one wins.** `user` is one somebody chose. `auto` is read
  by a job: `tagPictures` from a performer's confirmed faces, `tagLookPictures` from how a
  source's or a keyword's items look (below). The automatic one shows until somebody chooses, and
  again if they take their choice back. Neither job touches a chosen one, and each sees only its
  own facets' automatic pictures.
- **The picture is a file of its own under `tags/`, not a pointer to an `Artifact`.** An artifact
  is deleted with its item, so purging the item would take the picture too, and the purge of a
  byte-identical duplicate (§10e) happens all the time. `tags/` is `irreplaceable` (§13d) because
  chosen pictures cannot be regenerated. The orphan sweep takes files no row names, and drops an
  automatic row whose file has gone so the job draws it again. A chosen row whose file has gone
  is reported and kept, as a capture's is (§9).
- **Two renderings: 600 pixels wide and 240.** The large one is the browse tile and the tag
  page's inset. The small one is everything drawn at 72–88 CSS pixels. A performer's picture is
  a 4:5 portrait. A source's or a keyword's is a 16:9 frame.
- **The picture is cut from the original, never from what the screen showed.** Choosing one is a
  moment of an item and a crop as fractions of the frame. The server takes that frame from the
  original again inside the request, under the same bounded exception and the same ceiling on
  concurrent frames as a capture (`frameSlot.ts`, §9). The crop dialogue previews the moment as
  `/api/media/<id>/still`, read from the original and kept nowhere.
- **Visibility follows the item it came from.** If the item is in the trash, viewers see the
  fallback until it is restored. Once per-library access exists, a viewer who cannot reach the
  item's library will too (`tagPictureRepo.effectiveFor`). If the item is purged, the pointer is
  cleared and the picture stays: it was chosen on purpose.
- **Anybody who can see a tag may choose its picture**, as anybody who can see an item may choose
  its cover. It is curation that everybody sees, it changes nothing anybody else made, and it is
  undone by choosing again. A private tag's picture is its owner's, because nobody else can see
  the tag.
- **A stand-in that is right can be kept** (decided 2026-10-08). A browse tile with no picture of
  its own shows one of its items' covers, which changes with the seed. The tag's page shows the
  same one in the inset: the window's item, from the same seed. "Keep this picture…" in the
  tile's menu, or "Keep it…" in the tag page's picture dialogue, opens the framing dialogue at the
  moment that cover came from — framing, not a straight copy, because a cover is 16:9 and a
  performer's picture a portrait.
- **One picture dialogue on the tag's page** (2026-10-09). The ⋯ menu's "Choose a picture…" and
  the inset's menu open the same dialogue (`TagPicturePicker`), with every way to a picture in
  it: their confirmed faces (a library performer, to an administrator — every moment, largest
  first, the box starting around the face pressed, on the frame it was really seen in, with the
  other frames it may be offered beside it: §9 "What a tile shows"), their items' frames, and keeping the
  stand-in. Choosing used to start from three places — those two and a "Choose their picture"
  mode of "Their face" — each with some of the sources. On an item's page the tag's menu still
  frames the moment the player is at; that is a different question, asked where the player is.
- **A merge carries the folded tag's chosen picture to the survivor**, unless the survivor has a
  chosen one of its own. Publishing onto an existing name does the same. The folded tag's
  automatic picture goes with it, and the job reads the survivor's faces again.

**From faces, until somebody chooses** (§5f). For each library performer, the job takes the
confirmed face that is largest in its frame and surest (at least 0.7 sure, and filling at least a
fifth of the frame's height), reads the frame it was really seen in (§9 "What a tile shows") from
the original at full size, and frames head
and shoulders around it (`pictureAroundFace`): the face's centre 40% of the way down, kept inside
the frame. Confirmed faces come first, because those are ones a person said are this performer.
A face under 96 pixels tall in the original is passed over for the next, up to three.
The frame's real size is measured from the decoded frame, never taken from `Media`, because a
phone's portrait video is stored landscape and turned on playback. A performer whose best face is
the one their picture already shows costs nothing, so the job runs once at startup, after each
grouping run, after faces tag anything by themselves, and two minutes after face decisions in the
review or a performer taken off items.

- **Without such a face, it falls back a tier at a time** (decided 2026-10-08). A picture is what
  makes a tag a card on an item rather than a chip, and a performer without one was the commonest
  chip. Second: a face one of their automatic tags rests on (§5f "Tagging by itself"), under the
  same bars, while that tag stands — applied or checked right, still on the item, the face not
  refused for them. A wrong one is corrected the way the tag is, and taking the tag off withdraws
  the picture. Last: their best confirmed face below the bars, cut from a face as small as 48
  pixels (`FALLBACK_PICTURE_MIN_FACE_PX`). A soft picture of the right person beats a chip;
  smaller than that it is a blur, and the chip is better. Each tier gets its own three tries, so a
  tier whose faces are all too small does not use up the next.
- **~~No fallback to a cover.~~ Every performer on an item has a picture** (decided 2026-10-11,
  reversing "no fallback to a cover"). Chips beside cards were two sizes of the same thing in one
  row, and that cost more than an arbitrary picture does. After the three tiers above, a fourth:
  nobody having confirmed a face of theirs, the person matched most like them (at least
  `SUGGEST_NAMED_LINE`) on an item the library tags with them, whose face is neither confirmed as
  somebody else nor refused for them, cut at the smaller size. Then a stand-in, as sources and
  keywords have (`standInFor`, framed 4:5 and centred), for every library performer on a listable
  item (`performersCarried`), kept while its item carries them. A wrong picture is the nudge to
  choose one, and any confirmed face replaces it on the next pass. The pass runs daily too, and two
  minutes after a performer is added to an item, so a new performer is not long without one; until
  then the item page holds the picture's place empty, and a performer is always a card there.

**From looks, for sources and keywords** (`tagLookPictures`, §5e). Nothing says what a source or
a keyword is except the items carrying it, so its picture is its **most typical frame**. Each
item's look is the mean of its representatives, the tag's look is the mean of its items', and the
picture is the representative nearest the tag's look, framed 16:9 around the square it was seen
in (`pictureAroundSquare`). It is read from `embed/reps.log`, one sequential read, not a file per
item. It runs at startup and daily, since a typical look moves slowly. A picture whose own frame
is within 0.01 of the best is left alone, so tagging one more item does not redraw it.

- **Only where the tag has a look at all.** It needs at least five items whose looks have been
  read. Those items must also be at least two standard deviations more alike than random sets of
  the same size drawn from the library (`LOOK_PICTURE_MIN_Z`). Otherwise the "most typical" frame
  is an arbitrary one.
- **A tag without a look gets a stand-in** (decided 2026-10-08; this reverses "the day's sample is
  as good"). It is somebody's capture from one of its items, else one of its items' covers,
  framed 16:9 and centred (`tagPictureRepo.standInFor`), and only a frame whose moment is known.
  Arbitrary, but better than none: it makes the tag a card on an item rather than a chip, there
  are few such tags, and a wrong picture is the nudge to choose a right one. It is the first by
  artifact id, which is random but stable, and it is kept while its item still carries the tag,
  so it does not change from day to day. A typical frame, once the tag has one, replaces it, and
  a chosen picture is drawn over both. The same applies before anything has been embedded, when
  every source and keyword has a stand-in.
- **The baseline is drawn at the tag's own size**, 40 seeded random sets. How alike random items
  are falls steeply with how many there are: any five measure about 0.917, any 25 about 0.901,
  the whole library 0.898. A baseline drawn at a nearby size flattered small tags, and a test
  caught it doing so.
- **Measured on the library (2026-10-07, 13,070 items with looks):** every source with five or
  more items clears it (z 2.6–7.2). So do 16 of the 20 keywords with five or more; the other four
  score 1.9 to 0.0, no more alike than items picked at random. Performers, measured the same way
  for comparison, reach 10.7.
- **A private keyword gets one too.** It is drawn from its owner's own tagging, and the tag and
  its picture are shown only to them.
- **Not for performers.** A performer's typical frame is not their face, and the faces job
  answers that question properly.

**Where it is drawn, and never smaller than 72 pixels across on a phone or 88 on a desktop.**
That is the size Review › Faces draws a face at. At chip size a face is a smudge, which is worse
than the name alone.

| place                      | drawn as                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| browse tile                | the tile's picture, in place of the day's sample                                                                   |
| browse row, companions row | a performer: an 88-pixel square in a column before the name's; anything else: the first frame of the strip, ringed |
| the tag's page             | an inset beside the name over the window (above it on a phone); the window keeps the day's sample                  |
| an item's tags             | a card (the picture, the name beside it, ×) in place of the chip; tags without a picture stay chips, below them    |
| the tag boxes' suggestions | beside the name, at the card's size                                                                                |
| Review › Faces, Matches    | first among the faces for comparison                                                                               |

Deliberately not: the filter panel, whose twenty chips a facet would become a wall of pictures;
grid tiles; Manage, which is for tidying names; a clip's tags, which are in a dense list.

**Choosing one.** On an item, each tag's menu offers "Use this frame as their picture…" (for a
photograph, "Use this photo…"). The page's action row is full on a phone, and the tag's own menu
is where the question about that tag is asked. On any tag's page, "Choose a picture…" in its ⋯
menu (and "Choose another…" on the inset) offers the page's own shelves, then the chosen item's
frames — the generated ones and anybody's captures — then the crop. Any other moment of a video is
chosen on the item, where the player is. On a performer's page, "Choose their picture" turns
"Their face" into choices, and the crop starts around the face pressed. The inset's menu takes a
chosen picture back. Uploading a file is not offered: the app faces the internet, an upload is an
image parser fed by a stranger, and the library is where the pictures are.

**Query shape.** The grid is `Media LEFT JOIN UserMedia ON mediaId AND userId = :me`, so a
new user sees the whole library with empty ratings rather than nothing. Covering indexes on
`UserMedia(userId, rating, mediaId)` and a partial index on `UserMedia(userId, mediaId)
WHERE favorite IS NOT NULL` keep rating/favorite sorts fast at 200k rows.

**Every repo function that touches user data takes `userId` as an explicit parameter**,
never from ambient state — a missing filter is then a type error, not a privacy leak.

**Scopes.** `admin` manages roots, scans, transcode settings, users, trash purge and restore.
`delete` is a separate scope (§18.1) granting file deletion from writable roots — some
accounts curate without administering. Everything else is available to any account.
`LibraryAccess` controls which roots a user sees at all.

**Home page.** `HomeLayout.rowsJson` is an ordered list of shelf descriptors — saved filter,
playlist, or builtin (recently viewed, recently added, top rated, random, tag). One API
call returns every shelf with a capped item count. Admins set the default layout new
accounts inherit.

**Playlists and saved filters are the same idea twice**, one fixed and one dynamic, and are
deliberately shaped alike: name, description, pin and position, private by default with
`visibility: shared` exposing them read-only. Sharing grants reading and never writing, to
administrators included — `admin` manages the library, not other people's collections. No
cross-user writes; collaborative editing is not worth the conflict handling.

A pin and a position describe _your own_ sidebar, so they are only ever the owner's: someone
else's shared list falls to the end of yours and sorts by name. Honouring their position would
let one account reorder everyone else's sidebar by sharing something pinned.

Three things stay different, each for a reason:

- **Ordering.** Position _is_ a playlist's content — the sequence is the thing. A filter
  carries a sort instead, so positions on it could never be set meaningfully.
- **The item total.** A playlist's is a count of a small table. A filter's is a scan of the
  matching set — 188 ms at 200k against 0.4 ms for the page — which is why the grid returns no
  total and counts separately (§20).
- **What sharing means.** A shared playlist names the same items for everyone, filtered by
  each viewer's access. A shared filter is re-run _as the viewer_, and `MediaQuery` can test
  the viewer's own ratings — `favorite`, `unrated`, `minRating` — so a shared filter containing
  one of those can name different items for each person.

**`SavedFilter.resolveAs` is the owner's answer to "whose ratings?"** `viewer`, the default,
means the query resolves against whoever opens it — "unwatched, five stars" is more useful
per-person than frozen to one person's taste. `owner` means it resolves against the person who
saved it, so their picks stay their picks for everyone who looks. `showsOwnerRatings` on the
response is the conclusion a UI needs: true only when the filter resolves against its owner,
the viewer is not the owner, and the query asks about ratings at all.

Three parts of the query never move with it:

- **Library access** is always the viewer's. That is what makes sharing safe at all.
- **Hidden** is always the viewer's. Hiding is a standing instruction to the app — "do not
  show me this" — not a predicate somebody wrote into a filter, and resolving it against the
  owner would resurface exactly what the viewer had put away.
- **The rating on each tile** is always the viewer's. The overlay decides what is _asked_,
  never what is _shown_: you would have no way to tell somebody else's stars from your own,
  and rating from that screen would look like editing a value already there.

So `sort: "rating"` on an owner-relative filter orders by the owner's ratings while the tiles
show yours. That is intended — it is "staff picks, in their order" — and is the reason
`showsOwnerRatings` exists for the UI to label.

**It is the whole filter's choice, not one per predicate.** Per-predicate would have to live
inside `mediaQuerySchema`, which travels in every grid URL, and would leave `sort: "rating"`
with no answer to "whose". The obvious next request — "films Dad rated highly that _I_ have
not rated" — is better read as the viewer's `unrated` applied on top of Dad's filter, a view
option rather than part of what Dad saved. Per-predicate overrides can still be added later
with the filter's choice as their default; the reverse is not available.

Mechanically the overlay is a second `LEFT JOIN "UserMedia"`, bound only when the query
actually consults a personal overlay and the owner is not the viewer. Everything else produces
the SQL it produced before this existed, which matters because it is the hottest query in the
app. `overlayUserId` is a repo parameter and deliberately _not_ a field on `MediaQuery`: a
client able to name the account whose ratings to filter by could read anyone's ratings one
probe at a time, so only `savedFilterService` can produce one, and only from a filter whose
owner chose to share it that way.

**A playlist can be created with its items already in it.** "Make a playlist out of what I have
selected" is how most first playlists start, and the menu on the selection bar used to end at
"No playlists yet" — a dead end reached by exactly the person most likely to want one. The ids
travel with the create and are written in the same transaction, because a create followed by an
add can half-fail and what survives is an empty playlist named after something it does not
contain. They go through `addPlaylistItems`, so the visibility filter is the same one rule
rather than a second copy of it.

**Freezing** crosses between them: adding to a playlist accepts either a list of ids or a saved
filter, in which case everything the filter matches right now is added, capped at
`BULK_SELECTION_LIMIT` and evaluated as the person doing the freezing. This is the reason the
two remain separate features rather than one — nothing can freeze a set that has no separate
identity to freeze into.

## 7. Scanning and change detection

Watchers are unreliable on NAS shares and SMB mounts, so detection is layered:

1. **Walk** — periodic (default 15 min) `readdir` + `stat` per root; compare `(size, mtime)`
   against `MediaFile`. Unchanged entries cost one stat and no hashing.
2. **Watch** — optional `fs.watch` on local disks, one watch per directory (not per file; §20
   "The worker's own memory"), treated as a hint that schedules a targeted walk, never as the
   source of truth.
3. **Settle** — a new file is ignored until its size is stable across two polls, so
   in-progress copies are not probed half-written.
4. **Reconcile** — files missing from disk go to `state = 'missing'`, not deleted; after 3
   consecutive scans they become `archived`. A share being temporarily offline must never
   destroy user metadata.

Each discovered file enqueues a chain: `filehash → probe → cover → sprite → preview → phash →
websafeCheck → index → metadata → (later) aiTag`. Stages are independent `Job` rows, so one failure retries one
stage, and adding a stage later backfills the library without a full rescan. The identity hash
leads so that an exact copy is known before anything renders it (§10f).

## 7b. What has been done to each item

Every capability records one row per `(item, stage)` in **`MediaStage`**, and a **stage
registry** in `packages/core` declares what the capabilities are.

Before this, the pipeline answered "has this been processed" four different ways: a timestamp
for probing, a version integer for the search index, the existence of an `Artifact` row for
covers, and a non-null column for file hashes. Each new capability invented its own marker
and its own "what needs work" query, and there were five of those.

**Those recorded what output exists, which is a different question from what processing has
happened.** The two agree until a stage legitimately produces nothing — a blank image has no
perceptual hash, a five-second clip has no preview, an OCR pass finds no text — and then "no
output" cannot be told apart from "never tried". The sweep re-queued those items every five
minutes, for the life of the library, and nothing about it looked like an error.

### The registry

```
name        also the job kind that performs it
version     bump to re-run the stage across the library
mode        automatic (swept) | optIn (swept once turned on) | perItem (never swept)
appliesTo   all | video | image
priority    queue order; lower runs first
maxAttempts failures before the item is left alone; null to keep trying
needsProbe  wait for the probe: not swept, counted or requestable until it has run
```

Adding a capability is an entry here and a job handler. No column, no backfill query, no new
convention — which is the whole point, and was not true of any of the four schemes it
replaced.

**The probe is a stage too**, and was the last of the four schemes to go. It stayed a job
kind recorded only as `Media.probedAt`, and that left nothing remembering a probe that
failed: the job dead-lettered, `probedAt` stayed null, and the item was never looked at again
unless its bytes changed. In production one of those was a perfectly good file whose probe
timed out during a first import, and the sweep meanwhile ran every rendering stage on it with
no duration — a sprite planned for a guessed length wrote sheets claiming negative tile counts.
A truncated download fared worse: nothing gated on the probe, so cover, preview, sprite and
phash each failed on it in turn, about a dozen ffmpeg launches per file.

So the probe is recorded, retried and listed like any stage, and the stages that render from
the picture carry **`needsProbe`**. The sweep does not offer them an unprobed item, the
worker drops a job queued for one before this existed rather than spending an attempt, the
per-item route refuses one with "run the probe first", and their progress bars are measured
against probed items only — a file nobody can read shows once, as the probe's failure, rather
than as "remaining" on five bars forever. The search index does not wait: it is built from
the name and tags as much as the probe, and an item nobody can find by its own filename looks
like search is broken. A migration recorded the library's existing probes as `done`, because
without it the sweep would have re-probed every item and each probe chains a cover behind it.

`mode` is what makes expensive capabilities practical to offer before they are affordable
everywhere, and it has **three** values because there are three genuinely different answers
to "how does this come to run":

- **`automatic`** — swept across the library unless an admin switches it off.
- **`optIn`** — not swept until an admin switches it on, and then swept exactly like an
  automatic stage: ordinary queue, lowest priority, inside the working window (§7c). For a
  capability that is affordable, but only once somebody has decided to spend it.
- **`perItem`** — never swept, whatever the settings say. The per-item route is the only
  route.

The middle value is the one the first draft of this section did not have, and its absence was
a real gap rather than a simplification: OCR (§5d) is affordable on a chosen library and
ruinous on 200k items, and with two values that could only be expressed as "never sweeps",
which left **no way at all to ask for it across a library**. Every item had to be requested by
hand, one at a time, which is not a policy anybody would choose — it is what you get when the
vocabulary cannot say what you mean.

Promoting a stage is still a single edit, and items already processed on request are skipped
because their row is already current — no migration, no backfill script.

`perItem` has no member today. It is here because the admin screen has to distinguish "you may
turn this on" from "you may not", and because without it `optIn` would quietly become the
floor — every future capability sweepable by an admin who wants it, including ones where that
is the wrong thing to offer.

### Outcomes

`done`, `empty`, `failed`, `skipped`. **`empty` is the one that matters**: the stage ran
correctly and there was nothing to produce. That is a result, not a gap, and it must never be
retried.

`failed` retries to a limit, because one corrupt file must not occupy the queue on hardware
whose whole problem is having no spare capacity. A success resets the count — the count exists
to abandon work that cannot succeed, and work that just succeeded plainly can. A version bump
supersedes every outcome including an exhausted failure, since a better recipe deserves a
fresh attempt at the files the old one choked on.

`skipped` means the stage does not apply. It is recorded when a _job_ finds the item
inapplicable, but `appliesTo` filters the sweep so that a sprite sheet for a photograph is
never queued in the first place — writing 200k rows to say nothing needs doing would be worse
than useless.

**`recipe` records which configuration produced an outcome**, for a stage whose output depends
on admin settings. A handler returns `{ state, recipe }` instead of a bare state. A failure keeps
the previous recipe, since it produced nothing. Only OCR uses it today, recording its settings
revision (§5d "What happens when OCR settings change"). It is deliberately _not_ the version: a
version bump re-runs everything because the recipe got better, while a settings change only
records that something differs, and leaves to an admin whether that is worth re-reading for.

### Two places decide, and a test proves they agree

`needsWork` decides in TypeScript; `mediaIdsNeedingStage` decides in SQL. A property test
checks every combination of state, attempt count and version against both. If they drift, the
sweep selects work the worker then declines to do — a loop that burns queue capacity and never
reports an error, which is the same shape of silent failure this table exists to remove.

### An admin turning stages on and off

**Built.** It needed no schema change, which is what the registry was for: a `Setting` row,
one filter in the sweep, and a list derived from `STAGES` rather than stored.

**Only the deviations are stored.** The setting is a record of stage name to boolean, and a
stage the admin has never touched is absent from it — which means "ask the registry". A
capability added later therefore arrives at whatever its `mode` says, in every existing
library, without anybody's stored settings being touched.

That is the generalisation of an earlier rule rather than a departure from it. The setting
used to be a list of **disabled** names, chosen so that a new stage would be on by default;
storing only the exceptions is the same idea, freed of the assumption that the exceptions all
run in one direction. With three modes they do not: `optIn` deviates by being switched on.

```
policy[name] ?? mode === "automatic"      // and perItem short-circuits to false
```

A stored `true` against a `perItem` stage is ignored on read, so a stage demoted from `optIn`
cannot be resurrected by a value left behind. Writing one is refused outright rather than
stored inert — the same rule `requestProcessing` follows for an unknown stage name: a mistake
should say so, not appear to have worked.

An admin turns each step on or off for the whole library, and can still run any of them
against one item.

**Turning one on is a commitment, and its size is shown first.** A stage that is off carries
the count of items outstanding, because "enable OCR" and "enable OCR on eighteen thousand
files" are different decisions and only one of them is on the screen otherwise. The count is a
scan of the matching set (§20), so it is computed only where a decision is actually pending —
a stage already running has nothing left to decide, which in practice means one count per page
load rather than one per stage.

No estimate of _time_ accompanies it. Throughput is measurable; how a particular library
divides into two-hour films and stills is not, and a confident wrong number on that screen is
worse than no number.

**The per-item half lives in the provenance ledger**, on the item's own Details panel, which
already listed every stage with its state and date. It looked like a control panel and was a
list: `POST /api/media/:id/process` existed from the day the registry did, and nothing in
the app called it. Each row now carries a run control, revealed on hover or focus because
the ledger is read far more often than it is acted on.

Three cases show no control rather than a disabled one, the rule every other affordance here
follows: a viewer without `admin`, a stage that waits on a probe that has not run
(`needsProbe` — the probe is the thing to ask for), and a stage that cannot apply to this kind
of item. The last of those also
fixed the ledger itself, which reported a sprite sheet on a photograph as _pending_ and so
left every image permanently looking half-processed — it is `skipped`, and always was.

This matters more as the registry grows. A capability can be runnable per item long before,
or without ever, being swept across a whole library, and requested work is exempt from the
working window (§7c) — which together are what make an expensive stage practical to offer at
all. OCR is the first capability designed to arrive that way (§5d).

**Asking has to look like something happened, and the answer has to arrive by itself.** The
first version of the control did neither. The request deleted the stage's `MediaStage` row
and queued a job; the ledger, built only from those rows, then read "on request" — exactly
what it had said before the click — while the spinner lasted as long as the POST and the
button came straight back. Asking a second time for text already read made the text
_disappear_: the panel shows it only when the ledger says the stage ran, and the row saying
so had just been deleted, though the findings themselves were untouched until the new pass
replaced them. And nothing refetched the item when the work finished, so the result appeared
on a reload or not at all. Three changes, one per failure:

- **The outcome row is kept until the new outcome replaces it.** A request resets only the
  attempt counter. What last happened stays true until something else has.
- **What is on its way comes from the queue.** Each ledger entry carries `inFlight` —
  `queued` or `running` — from the live `Job` rows for the item, read through the live-job
  unique index. The row says so, its dot changes, and the run control spins for as long as
  the _work_ is outstanding rather than the request, which also stops a second click.
- **The item's detail polls while, and only while, something is in flight** (every three
  seconds), so the row settles and the text section fills in without a reload. An item with
  nothing on the way costs no requests.

A request for an item whose sweep job is already waiting **takes that job over** — lowering
its priority and setting `requestedByUserId` — rather than being dropped by the one-live-job
rule and waiting behind the rest of the backfill under the throttle. That does not contradict
the paragraph below: the job became requested because a person asked for that one item,
which is exactly the case the exemption exists for.

**A swept stage is never "requested", and that distinction is load-bearing.** §7c exempts
requested work from the working window, and the claim query keys on `requestedByUserId IS NOT
NULL` — so if turning `optIn` on enqueued its backlog the way the per-item button does,
enabling OCR would bypass quiet hours and saturate the box at two in the afternoon. The sweep
leaves that column null and therefore gets this right by construction, which is precisely why
it is asserted in a test rather than trusted to a comment: nothing about the code looks
fragile, and a later tidy-up that "helpfully" attributed swept jobs to the admin who enabled
them would be silent.

Nothing structural is required. The pieces exist and meet at one point each:

- **Enablement is a `Setting` row.** §12b already rules that anything an admin changes at
  runtime is a setting rather than config, and `Setting` is key/value with unconstrained
  keys — so a new stage needs no column and no migration.
- **The sweep filters in one place**: a single `for (const stage of automaticStages())`. Admin
  control is that list intersected with the enabled set.
- **Per-item runs already work for every registered stage.** `requestProcessing` resolves a
  stage by name and deliberately does not consult `mode`, so the "run a subset against one
  item" half is done.

### Two layers, not one switch

`mode` in the registry and the admin setting look like the same flag and are not:

- **`mode` is the default and the ceiling**, declared in code. It says what a library should
  do about this stage when nobody has said otherwise — and, for `perItem`, that there is no
  otherwise.
- **The setting is a policy**, chosen at runtime: _should it be swept in **this** library?_

Effective behaviour is both. Keeping them separate is what lets an expensive capability ship
switched off, be promoted to a default in code, and still be left off by an admin who does not
want it — three independent decisions that would collapse into one confusing flag if merged.

`perItem` is where the two layers stop being symmetrical: it is a ceiling rather than a
default, and the policy cannot raise it. That asymmetry is deliberate. A default exists to be
overridden by whoever knows their own library better than the registry does; a ceiling exists
because some work should not be offered library-wide at all, and a setting that could lift it
would make the ceiling advice rather than a rule.

**A stage that is not swept stays runnable on demand.** Switching one off means "do not sweep
this", not "never do this": an admin asking for one item explicitly has overridden the policy
by asking. `requestProcessing` therefore does not consult `mode` at all — every registered
stage is requestable, including a `perItem` one, which is the whole of what `perItem` offers.
Recorded here so it is a decision rather than something the implementation settles by
accident.

### What it would still need thinking about

- ~~**Dependencies are not declared.**~~ `requires` arrived with the first stage that needed
  it, `embed` (§5e). What follows is kept because the chain between the others is still
  implicit. The chain is implicit in who enqueues whom — `cover`
  queues `preview` and `sprite`, `phash` queues `dupes`. Today nothing breaks if a link is
  disabled, because the sweep queues each stage independently, but a future stage that
  genuinely requires another (translating OCR text needs the OCR) has no way to say so. Cheap
  to add: the registry is code, so a `requires` field costs nothing to introduce later. That
  is the reason the registry is code and only the _outcomes_ are schema.
- **Disabling does not stop work already queued.** An admin switching something off probably
  expects pending jobs of that kind to be cancelled, which is a deliberate choice rather than
  an obvious one.
- ~~**Enabling a stage on 200k items is a commitment**, and the admin should see its size
  first.~~ Built; see above. The remainder of that line stood: it is the same
  count-before-you-commit that §5d asks for on bulk tagging.

### What stays outside it

Transcoding is selected by whether a browser can play the file (§8), which is a question about
the file rather than about what has been done to it. Scanning belongs to a root and duplicate
clustering to the library, not to an item. Folding those in would answer a question nobody
asked and blur the one this table is for.

The output tables are unchanged. `Artifact`, `Variant` and the pHash tables hold what was
_produced_; `MediaStage` holds the fact that a stage _ran_ and how it went.

## 7c. When the pipeline is allowed to work

§7b decides **what** processing is owed. This decides **when** it may be done.

A NAS cataloguing at full tilt at eight in the evening is technically working and practically
broken: the library browses badly, playback stutters, and the cause is invisible because every
indicator agrees the box is busy — which is exactly what it should say. Plex solves this with
two independent knobs, a maintenance window and a "run at low priority" checkbox, and the
separation is worth copying: _when may this be busy_ and _how hard_ are different questions.

An admin sets one daily window — a start hour and an end hour, wrapping midnight — during
which the pipeline runs flat out. Outside it, background work continues at a reduced rate. The
feature is **off by default**: a first import should catalogue as fast as the box allows, and a
default that halved it would be read as the app being slow.

### One lever is not enough, and the obvious one is the weakest

Four levers, because no one of them covers the ground:

| lever                | what it actually does                   | where it falls short                                                                                            |
| -------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Concurrency**      | fewer slots per kind outside the window | nothing for `transcode`, `sprite` or `preview` — all three are pinned at one job at every hour already          |
| **Process priority** | ffmpeg yields under contention          | decides who _wins_ a contested CPU, not how much of an idle one ffmpeg takes; touches neither I/O nor bandwidth |
| **Threads**          | a hard ceiling on every ffmpeg it runs  | software work only; meaningless to a hardware encoder                                                           |
| **CPU budget**       | one shared cap on jobs that hold a core | a count of processes, not of load — three cheap jobs and three encodes spend it alike                           |

The uncomfortable part is that concurrency — the lever that looks like the feature — does
almost nothing to the job that actually saturates the machine. `transcode` runs one at a time
regardless, so throttling it by slot count is a no-op. Only the thread cap genuinely bounds
it, and it is the one of the three that leaves the output unchanged: the same file at two
threads and at eight differs in how long it took, not in what a viewer sees. A cheaper x264
preset was considered and rejected for exactly that contrast — it would make an artifact's
quality depend on what time of day it was produced, which is invisible, permanent, and
impossible to explain to whoever eventually notices.

`limitFor` asserts the transcode no-op in a test rather than leaving it as folklore, so if the
full limit ever rises above one, the copy describing this stops being true loudly.

### The per-kind table never bounded the total, and that was the actual bug

Every limit above is per kind, and nothing added them up. At full speed they sum to **26
concurrent jobs**; throttling brings that to **24**, because the throttled table caps five kinds
by a single slot each. Nine of the 26 spawn ffmpeg or decode frames. So the considerate mode,
on a four-core NAS, permitted nine encoders against four cores — and the lever named
"concurrency" was moving the ceiling by two.

This is what a seizing UI turned out to be (§20). The web process was not running slow queries;
it was not being scheduled. A HAR showed six API calls with no browser queueing finishing at
1.2, 1.3, 2.6, 3.1, 5.9 and 7.4 seconds — a staircase, because Node serves on one thread and
`better-sqlite3` is synchronous, so requests that cannot get a core do not interleave, they
line up.

`cpuSlots` is therefore a single budget across every `CPU_BOUND` kind: `cores - 1` at full
speed, halved inside the window. **Holding back a core is the point.** The other three levers
all assume a contended CPU eventually gets shared; none of them can reserve one, and reserving
one is the only thing that keeps the app answering while the library processes.

**A slot is only a core if the job in it uses one, and ffmpeg does not.** It sizes its decoder,
encoder and filter pools from the cores it can see, and inside a container that is the host's —
so under `cpus: 2.0` on the four-core NAS one sprite, preview or cover ran four threads and
spent the whole quota alone. The budget counted one job and reserved nothing. `threadsPerJob`
states it in threads as well: the cores left after the web process's one, divided among as many
`CPU_BOUND` jobs as can actually run together, which on the NAS is one thread each. `capThreads`
applies it to every ffmpeg argument list the worker builds — decoder, encoder and both filter
pools, because a cap on any one of them leaves the others to fill the machine — and tesseract
gets it as `OMP_THREAD_LIMIT`. It holds for requested work too, for the reason the budget does.
The measured cost of not having it is in §20.

Two boundaries were drawn deliberately:

- **Membership is about holding a core, not about doing work.** `scan`, `filehash`, `trash` and
  the sweeps are I/O against a share or the data volume, so they keep running while the budget
  is full. Capping them by core count would slow the library to protect a CPU they never used.
  `probe` and `websafeCheck` are out for the reason `THROTTLED` leaves `probe` out: they are
  short, they gate every other stage, and an item stuck with no duration reads as a broken
  import rather than a considerate one.
- **The budget is not lifted for requested work**, which is the one place this departs from the
  exemption below. The window is a policy about when background work is welcome, and somebody
  waiting on a button is a good reason to ignore it. The budget is a statement about how many
  cores exist, which wanting does not change — a requested job let through a full budget takes
  its core from the web process serving the page that asked for it.

The sums are asserted as literals in `throttle.test.ts` rather than described here and nowhere
else, so adding a kind or raising a limit cannot quietly restore the ceiling this removed.

**The budget counts the quota, not the box.** `docker-compose.qnap.yml` runs the container under
`cpus: 2.0` on a four-core NAS, and `os.cpus()` inside a container reports the machine rather
than the allowance — so a budget derived from it handed out three CPU-bound slots against two
cores' worth of quota. Over-subscribed by exactly the margin the budget exists to hold back, and
invisible from inside, because every tool in there agrees there are four cores. `effectiveCores`
reads the cgroup limit and takes the smaller of the two, flooring rather than rounding so that
2.5 cores cannot license a third job. Both cgroup layouts are parsed: QTS kernels are not
reliably v2, and a v1 box silently falling back to the host count would be the same bug wearing
a different hat.

### The window gates claiming, not running

`capacityFor` is consulted on every pass of the claim loop, so turning the concurrency table
into a function of the clock is the whole of the scheduling half — and it gives the boundary
behaviour for free. A transcode that started at 07:58 runs to completion; what changes at
08:00 is that nothing new is picked up. Aborting at the boundary was the alternative and is
worse in the case that matters: a forty-minute encode killed at minute thirty-nine throws away
all of it and starts again tomorrow, possibly forever if the file is long enough. The cost of
letting it finish is bounded by one job.

Priority, by contrast, is applied at **spawn** rather than at claim, which is deliberately the
later moment: a job claimed at 07:59 and started at 08:01 should run politely, because by then
people are using the NAS.

### Requested work is exempt, and that needed a column

Throttling is a policy about _background_ work. Somebody who clicked "regenerate this cover"
is sitting in front of the page waiting for it, and a considerate pipeline that makes the
button feel broken has optimised the wrong thing.

That turned `requestedByUserId` from a bookkeeping detail into a scheduling input. It used to
ride inside `Job.payloadJson`, which was enough while the only reader was the handler
recording an outcome — but the claim query has to ask "did anyone ask for this" about rows it
has not selected yet, and `json_extract` over every pending job is the wrong shape for a
statement that runs twice a second. So it is a column on `Job`, mirroring the one `MediaStage`
already had.

Priority looks like it could have stood in for it and cannot: priority decides the order work
is claimed in, the column decides which limits apply, and the throttle needs the second.

**Requested work goes before all automatic work, of every kind.** It was first enqueued at the
stage's priority minus fifty, which outranked that stage's own sweep and nothing else, and this
section used to accept that a requested phash would still sit below an automatic cover. On the
NAS that was a requested OCR pass at 150 behind **8,415 automatic sprites at 140**, still
waiting the next morning — the claim takes the lowest priority among kinds with a free slot,
and every CPU-bound kind competes for the same few (§7c). `requestedPriority` now places a
request at a tenth of its stage's priority: the registry's order survives among requests, and
every one lands below the lowest automatic stage, which a registry test enforces. The comment
on `Job.requestedByUserId` in `init.ts` still describes the old arithmetic; it is part of the
stored schema, and correcting it is not worth rebuilding the table.

The claim statement therefore takes two kind lists: kinds with room under whatever limit
applies, and kinds that have run out of throttled room but not full room, where only requested
work may go. One statement, not two passes — a claim that is immediately released has already
bumped `attempts` and already raced every other worker for the row. On real data both shapes
take the same index (`idx_Job_claim`) with the same plan, so the exemption costs nothing.

**The bulk "transcode everything unplayable" button is not exempt.** It is admin-triggered but
it is a request for a _sweep_, not for an item, and marking its output as requested would
exempt the entire library and leave the throttle with nothing left to govern.

### Politeness travels with the async stack

An automatic cover sweep and a cover an admin just asked for can be in flight at the same
moment, one throttled and one exempt. A module-level flag would hand whichever spawned second
the other's answer, and the symptom — an occasionally slow button — is not something anyone
would trace back here. So it is an `AsyncLocalStorage`, read by the ffmpeg wrapper at spawn
time rather than threaded through four media-layer signatures.

Priority is set on the **child**, never on the worker: the worker holds heartbeats for every
job in flight, and a niced one would start losing claims under load rather than merely
finishing later. It is only ever _lowered_, and never restored — on POSIX an unprivileged
process may lower a priority and may not raise it again, so a design that niced itself and
tried to undo it would need `CAP_SYS_NICE` in the container. Each child spawns fresh at the
parent's priority, so there is nothing to put back. `os.setPriority` rather than a `nice`
binary, so the Windows dev box and the Linux container take the same path.

`probe` is deliberately never throttled. It is cheap and it gates every stage that reads a
stream, so slowing it would leave a freshly imported item with no duration and no dimensions
for hours — which reads as a broken import rather than a considerate one.

### It has to say it is doing this

A throttled library and a dead worker look identical: bars that barely move, a queue that does
not drain. §13c added a liveness badge for exactly that confusion arriving by one route; this
is the same confusion arriving by another, and without a note the feature working correctly
looks like a fault. So the processing card carries "throttled until 02:00", and the tooltip
says that anything asked for by hand still runs at full speed.

The card also shows **the clock those hours are read on**, named zone included. A container
running UTC while its owner reads the page in another zone is the single likeliest way this
appears broken, and an offset of several hours is invisible unless something states what time
the server thinks it is. `14:00` alone is plausible from anywhere on earth; `14:00
America/Chicago` is either right or obviously wrong.

It was there and it did not show, which is worth recording because the mistake is an easy one
to repeat. The clock was a field _inside_ the throttle object, and that object is null when no
window is configured — so the one library that needed it, the one whose owner was about to
choose hours, was the only kind that never saw it. Meanwhile the quiet hours card said in as
many words that the server clock was on the processing card. **A fact that explains a setting
has to outlive the setting being off.** It is now reported separately and rendered
unconditionally.

### The hours belong to a zone, and the zone is stored

Two numbers are not a time until something says whose clock they are on. That used to be the
container's, which on a QNAP image is whatever `TZ` was left at, usually UTC. An admin in
Chicago choosing "2 to 8" was configuring 20:00 to 02:00 of their own evening: the busiest
hours of the day throttled, the quiet ones flat out, the schedule firing exactly as written,
and every screen in the app agreeing with them. Nothing to notice and nothing to debug.

So `throttle.timeZone` is an IANA name, and `hourIn` converts an instant to that zone's hour.
Null means the host's own zone, stored rather than resolved at save time so that a container
given a correct `TZ` needs no setting, and one corrected later is followed rather than
overridden by a value captured from what it used to be.

**Scoped to the schedule, not made an app-wide display setting**, although it was tempting to
call it one. Every timestamp a person reads is rendered by their browser, which knows their
zone and is right about it for each of several users at once; an app-wide zone would make all
of those wrong together. The server's zone matters only for what the server decides
unattended, and this is the only such decision.

**No date library.** `Intl` has carried the full IANA database since Node 14 and in every
browser this app supports: it enumerates the zones, validates one, and converts an instant
into a zone's local hour with the daylight-saving rules included and historically correct. A
date library would ship a second copy of that database to answer two questions. What one would
buy is arithmetic _on_ zoned times — "add a month in Auckland" — and nothing here does any.
The picker is a Mantine `Select` over `Intl.supportedValuesOf("timeZone")`, which keeps the
"Mantine only" rule that a dedicated timezone-picker component would have broken.

Three things `Intl` does that are worth knowing, each handled rather than assumed:

- **A bare offset is a valid `timeZone`.** `"-06:00"` is accepted and resolves to itself, and
  it reports the same hour in January and July. Storing one would give an admin a window an
  hour out for as long as summer time lasts, via a value nothing objected to. Since following
  daylight saving is the whole reason a zone is stored rather than an offset, the settings
  schema requires a _named_ zone.
- **`hour12: false` can render midnight as 24.** `hourCycle: "h23"` instead. An off-by-one
  that appears for one hour a day is exactly the kind that ships.
- **The enumerated names may be the backward-compatible ones.** This engine lists
  `Asia/Calcutta` and `Europe/Kiev`, not their modern spellings, and omits `UTC` entirely. All
  of them convert correctly, so the picker shows what it is given and adds `UTC`; relabelling
  would mean storing something other than what was clicked.

Daylight saving needs no handling beyond using a zone, and its two edges are already truthful.
The hour that spring forward skips never arrives, so a window starting in it does not open
that day; the hour autumn repeats arrives twice, so such a window opens twice. Both are the
honest reading of "between 2 and 3, local time".

### Pausing

The window slows background work; the pause stops it. It is a kill switch in the Processing
page's header, on every tab — including OCR's, which is where the case that asked for it happens
— for holding the library still while something is decided. The case that
asked for it: tuning OCR on the bench before a whole library is read with the result.

**What stops, and what does not.** While paused, every background kind becomes _requested
only_ (`pausedKinds`, `apps/worker/src/throttle.ts`), the same mechanism the window's exemption
uses.

- **Still runs:** work somebody asks for. That is the OCR test bench, tuning, a stage run from
  an item's page, and "Read again". This is how the bench works while everything else waits.
- **Still runs:** the bin's moves (trash, restore, purge). They are deletions already made, and
  holding one would leave an item hidden but not gone.
- **Waits:** everything else, including scans and "Scan now", which is not requested work. The
  queue keeps filling, so resuming carries on where the pause left off.
- **The CPU budget still holds** for what does run.

**It takes effect at once.** Pausing hands the background jobs running at that moment back to
the queue (`jobRepo.releaseBackgroundClaims`). Their next heartbeat matches nothing and they
stop within a tick, as a cancelled transcode does. Without this, an OCR pass started just before
the pause would store text read with the settings the administrator paused in order to change.

- They go back to `pending`, not `cancelled`, and the attempt the claim counted is refunded.
  Being paused is not a failure.
- The cost is a restart from the beginning on resume. For a transcode near the end of an hour's
  encode, that is an hour.

**The worker reads the flag every two seconds**, not on the throttle's half-minute cache,
because this is the setting somebody changes expecting the box to stop. A malformed row reads
as not paused: a library that silently stops processing over a parse error is the worse failure.
The pause time is set by the server on the transition, so saving "paused" again does not reset
it.

### Deliberately absent

- **A per-day-of-week grid.** More capable, and a much larger surface to get right than the
  need justifies.
- **A CPU percentage target.** A feedback loop sampling load oscillates, and gets blamed for
  slowness it did not cause.
- **Pausing while someone is streaming.** Better in principle, and it needs a notion of active
  playback the app does not have. A clock is predictable; this would not be.

## 7d. The queue runs in the order the library reads

§7b decides **what** work is owed, §7c decides **when** it may run. This decides **which of
it goes first**.

The answer used to be "whatever was queued first", which is the order files were walked. The
library's default view is newest-first. Nothing connected the two, and the result was a
library that processed itself from the end nobody was looking at.

It is not a subtle effect. In a 4,277-item import, 2,790 covers had been generated — two
thirds — and the first item that had one sat at **grid position 982**. Twenty screens of
blanks, while every count in the admin view honestly reported the work as more than half done.
The reasonable conclusion from the outside is that covers are broken.

### Two bands made it worse

Cover jobs were queued at priority 60 by the probe chain and at 70 by the sweep. The claim
reads `priority ASC` first, so **every** chain-queued cover ran before the first swept one,
whatever item either belonged to. The sweep selects `addedAt DESC` — it was already trying to
do the right thing — and was overruled for its entire backlog.

The chain now uses the registry's priority, read from `findStage` rather than written out, so
a stage cannot drift into two bands again. Chaining still buys what it was for: the job exists
the moment the probe finishes rather than within five minutes. It just no longer claims to
matter more than the same work queued by something else.

### The ordering key

`Job.mediaAddedAt` is the owning item's `addedAt`, copied at enqueue, and the claim orders by:

```sql
ORDER BY "priority" ASC, "mediaAddedAt" DESC, "createdAt" ASC
```

Priority first, because that is a statement about what _kind_ of work matters — a probe before
a sprite, whatever they belong to, since nothing about an item can be rendered before it has
been probed. Within a band, the newest item wins.

**Copied rather than joined.** The claim runs twice a second over every pending row; a join to
`Media` to sort by a column of it means a primary-key probe per candidate on every claim. At
7,452 pending rows that is not a trade worth making for a column that never changes after
insert.

**Derived inside `enqueue`**, from `(SELECT "addedAt" FROM "Media" WHERE "id" = ?)`, rather
than passed in. A caller that has to remember is eventually a caller that forgets, and the
symptom — work happening in the wrong order — is invisible until somebody counts. The handful
of places that write to `Job` directly rather than through `enqueue` do the same subquery.

**`createdAt` survives as the final tiebreak**, and has to. This library added 4,277 items
across 44 seconds and **32 distinct `addedAt` values**, so hundreds share a timestamp; without
a last tiebreak their order is whatever the index happened to return.

**Null sorts last**, which is what work belonging to the library rather than to an item should
do: a duplicate pass has no business preceding the items it is about to compare.

### What it cost, and what it starves

The index gains the column — `("state", "availableAt", "priority", "mediaAddedAt" DESC,
"createdAt")`. `availableAt` is an inequality, so SQLite still cannot read the ordering columns
in order and sorts regardless; the columns are there so that sort reads index entries rather
than gathering rows. Measured on the real 7,452-row queue the plan is unchanged and the claim
runs in 1.5 ms median, against 2.6–10.6 ms before.

After the change, all 50 items on the grid's first page fall within the first 77 cover jobs to
be claimed. Before it, the newest item in the library was 849th of 1,348.

The deliberate cost is **starvation under sustained load**: if items arrive faster than they
can be processed, newer ones keep preempting older ones indefinitely. That is accepted, and it
is the same trade the old order made in the opposite direction. A library that is permanently
behind is going to disappoint somebody either way; it should at least have processed the part
being looked at. When nothing newer needs work the sweep reaches the rest, so nothing is
unreachable — only deferred.

### Testing this needs care

The obvious test passes for the wrong reason. `CURRENT_TIMESTAMP` has second granularity, so
two jobs queued in a row share a `createdAt`, the old ordering ties, and SQLite resolves the
tie from whichever index it read — which now carries `mediaAddedAt` and therefore gives the
right answer even with the `ORDER BY` reverted. The tests backdate `createdAt` so that queue
order and library order genuinely disagree, which is what makes them tests of the `ORDER BY`
rather than of the index.

## 7e. A long job must give the loop back

The worker is a single Node process on purpose (§2). Every synchronous millisecond a handler
spends is a millisecond in which nothing heartbeats, nothing is claimed and nothing finishes.
Past about a second that stops being slowness and becomes indistinguishable from a hang: the
jobs in flight freeze at whatever moment it began, the processing card reports the worker as
not running (§13c), and nothing in the log says otherwise, because the process that would do
the logging is the one that stopped.

Two whole-library passes were exactly that shape. A duplicate-detection pass held the loop for
**nine seconds with a 15 ms ticker beside it firing zero times**. The orphan sweep's row check
held it for four, and it runs at startup — precisely when somebody is watching to see whether
the worker came up.

`breathe()` in `eventLoop.ts` is the whole remedy: a pass records when it last yielded, and
hands the loop back once it has held it for 25 ms. Measured on this library the duplicate pass
still takes the same nine seconds in total, but the worst uninterrupted stretch falls from the
entire pass to **68 ms**, and the ticker fires 349 times instead of none.

25 ms is well inside what nobody perceives and far below the fifteen-second heartbeat, so a
pass can no longer put a claim at risk however long it takes. `setImmediate` rather than
`setTimeout(0)`, because it runs _after_ pending I/O callbacks rather than ahead of them, and
pending I/O — ffmpeg pipes, the heartbeat's write — is the entire point.

The helper returns the new mark rather than closing over mutable state, so a loop that forgets
to keep the value yields on every iteration: slower, never wrong.

### Coalescing has to mean waiting

The duplicate pass is enqueued after every perceptual hash, and the queue's partial unique
index collapses duplicate _pending_ jobs — which made it look coalescing when it was not. Each
pass finished in about ten seconds, the next hash queued another immediately, and it ran
again. One import produced **3,599 whole-library passes**: the same comparison of the same
library, over and over, for a handful of new rows each time.

The index only collapses what is still pending, so the fix is to leave the job pending for a
while. It is now enqueued with `availableAt` two minutes out, and every hash finishing inside
that window hits the index and adds nothing.

Deliberately a **rate limit rather than a debounce**. Pushing the deadline out on each new hash
would be the more obvious reading of "once the burst has settled", and it would mean a library
that is importing for ten hours has no duplicate detection at all until it stops. A fixed
window gives incremental results during the import and bounds the cost.

### SQLite has no date type, and it matters here

`availableAt` was written with `toISOString()`. Nothing had ever passed the option, so that
had never run.

`CURRENT_TIMESTAMP` in SQLite is the **text** `"YYYY-MM-DD HH:MM:SS"`, and these columns are
compared as text. An ISO string differs in exactly the character that decides the comparison —
`T` (0x54) against a space (0x20) — so `"2026-09-17T09:00:00.000Z"` sorts _after_
`"2026-09-17 09:00:00"` for the same instant, and after every later time that day as well.

A job deferred with an ISO timestamp would therefore satisfy `availableAt <= CURRENT_TIMESTAMP`
essentially never. It would sit pending for ever and, through the unique index, block its own
kind from ever being queued again — a far worse failure than the one the deferral was
introduced to fix, and one that would have looked exactly like "duplicate detection stopped
working". Enqueue converts; a test pins the stored format.

## 8. Playback

**Direct play first.** H.264/AAC in MP4/MOV is served as bytes with range support — no
transcoding, and the only path that performs acceptably on a NAS CPU with several viewers.

**Serving those bytes is not free, and an open-ended range is bounded to 8 MB.** "Zero CPU
cost" is what this said, and it was wrong in the way that mattered: no ffmpeg does not mean no
work, because the bytes are pumped by the one thread that also serves every page. A `<video>`
opens with `Range: bytes=0-`, and answering that literally meant a single 206 carrying a whole
565 MB file, chunk by chunk, for as long as the transfer took. Measured on the NAS: 2.6 s of
server time for a 131-byte stats read, 5.5 s to deliver an 11-byte progress save, and an
unrelated delete that looked like the app had locked up. `blocked` in the HAR was 1 ms, so this
was not §20's connection queue — it was one thread, busy.

So the window is the server's decision, not the browser's: `bytes=N-` is answered with
`N … N+8 MB-1` as a valid 206, and the player comes back for the next window as it buffers,
which over HTTP/2 is one multiplexed request. An **explicit** end is honoured as asked, and so
is a suffix range — both are already bounded, and a suffix is how a player finds the index it
needs before it can ask for anything else. 8 MB is far more than the moov atom plus a few
seconds of video, so nothing starts any slower; it is also a fraction of a second of pumping,
so nothing else waits behind it. The same change stopped copying every chunk into a fresh
`Uint8Array` on the way out — `Buffer` already is one — and raised the read size from 64 KB to
1 MB, which cuts the number of event-loop turns per megabyte by sixteen.

The bound matters most for the item **nobody is watching**: §8b warms the next one with
`preload="auto"`, and "the browser decides how much" meant it decided on the whole file. The
capture that started this was a 565 MB download of the _next_ video while a different one
played.

**The stream URL does not name fixed bytes, so it carries validators.** It was cached for an
hour on the belief that an id's bytes never change, and that is false three ways: the same
`/api/media/:id/stream` serves the original, then the web-safe variant once one is ready, then
the original again if the retention sweep clears the variant; and an original overwritten in
place keeps its row. With a lifetime and no validator, a browser holding ranges of one file had
no `If-Range` to send, and so no way to avoid splicing them onto ranges of another — and once
the hour ran out it could only download the file again. Every response now carries a strong
`ETag` (`original|variant`, size, mtime — the scanner's own identity) and `Last-Modified`;
`If-None-Match` is answered with a 304 before any range is considered, and an `If-Range` that no
longer matches gets the whole current file as a 200, which is what RFC 9110 prescribes and what
tells the player its cache is stale. The lifetime stays an hour because the file genuinely can
change; the validators make what follows it a 304 rather than a re-download, which matters most
for stills, which go through this route at full resolution. The pure logic is
`lib/httpValidators.ts`.

**MPEG-TS plays as a playlist of byte ranges of itself**, which is still direct play: nothing is
converted or copied. See "Playing an MPEG-TS file without copying it" below.

**Otherwise transcode**, by a _background web-safe variant_: a low-priority job writes an
H.264/AAC MP4 into `/data/variants`, and once it is ready playback is direct play again. On the
NAS this now applies to six files out of eight thousand (2026-10-17): what no browser in the
household plays, after the playback check moved HEVC, MKV and MPEG-TS out of it.

_On-demand HLS_ (ffmpeg writing segments into a session directory as somebody watches) was the
second mechanism in this section and is **shelved, not built**. It was the answer to a library
whose unplayable files were common, and measured on the household's own devices they are not;
`hlsDir` is reserved for it should that change.

**Transcoding itself is opt-in, and off until an admin switches it on.** It is the one feature
here that spends a resource the operator cannot cheaply get back: hours of NAS CPU, and a
second copy of every unplayable file. For the common remux case that copy is _the same size as
the original_, so a library of MKVs approaches double its size — a cost nobody chose, arriving
on the first scan, on a box bought for its disks. A library with it off is not broken: files
that cannot be played say so and explain why (§8's notice), which is a known gap rather than a
black rectangle.

**The switch is an entry in the stage policy** (`stages.policy.transcode`, §7b), not a flag in
the transcode settings. It used to be `transcode.enabled`, saved with the encoder's quality and
preset — a second on/off mechanism beside the one every stage uses. Transcoding is still not a
registry stage (it has its own job, backfill and teardown), but "what runs across the library"
now has one answer in one record, read by `transcodeEnabled`; the transcode settings describe
only the output. Migration `20261002_150000_transcode_in_stage_policy` moved existing libraries
across. The switch sits at the top of Processing › Transcoding and saves at once, like every
stage switch, with a queue card beneath it: depth, and "Queue unplayable files".

Switching it off again **removes the renditions it made**. Leaving them would be the worst of
both: the feature is gone and the disk it was spending is still spent, which is usually the
reason somebody switched it off. The queue is cancelled in the request — an admin turning this
off wants the box to stop _now_, not when the worker next looks — and the deletion runs as a
`variantPurge` job, because there can be tens of thousands of files and that is not something a
settings PUT should hold a connection open for. The transition is read off the stage policy's
previous value, so saving it off again queues nothing. The admin screen asks first: the files are
derived and so the app is willing to delete them, but remaking them is hours, and flicking a
switch to stop new work starting is not the same as asking to discard work already finished.

**Renditions expire after seven days unwatched** (`retentionDays`, zero to keep them for ever).
A derived copy kept for ever is a choice about disk rather than about data: an item watched
once in January should not still be holding a second copy of itself in December.

The trap is that retention and the five-minute backfill cancel out _exactly_. The sweep deletes
a rendition nobody has watched; the backfill sees an unplayable item with no ready rendition
and queues the encode that recreates it. Naively implemented, retention costs a library its CPU
and saves it no disk at all.

So eviction is **remembered rather than undone**: the `Variant` row outlives its file, with
`ready` cleared and `evictedAt` set. The backfill skips those rows, and the only thing that
brings a rendition back is somebody opening the item — a write on a read path, which is the
point, because the request _is_ the demand. That path is deliberately narrow: it fires only for
a row carrying `evictedAt`, meaning this file encoded successfully at least once. A file that
has never managed it has no row at all, so a permanently unencodable item cannot be made to
retry on every page open.

`lastUsedAt` is written **at most once an hour per variant**, not once per request. A viewer
dragging the scrubber issues range requests by the dozen, all of them through the one path that
must not stutter, and a timestamp accurate to the hour answers "was this watched this week"
exactly as well. A rendition that has never been played counts as unused since it was _made_
(`coalesce(lastUsedAt, createdAt)`) — otherwise a transcode finishing just as the sweep runs
would be deleted before the person waiting for it could watch it.

**Hardware acceleration** is opt-in: `qsv`, `vaapi`, `nvenc` or `none`, default `none`, with
`/dev/dri` passed through only when enabled.

It is a `Setting` row rather than the environment variable this section originally named,
because it is exactly the thing someone needs to try, get wrong, and change back (§12b).
Requiring an SSH session and a container restart for each attempt is how a NAS ends up
running with the wrong one forever. The compose mount stays a deployment concern; which
backend to use is runtime.

### Deciding what needs transcoding at all

The verdict lives in `packages/core/src/playback.ts` because both processes need it and two
implementations would drift: the worker uses it to decide what to enqueue, the web app to
decide what to serve. **It is measured against the household's devices**, not against "every
mainstream browser" (see "Checking the verdict on real devices"): HEVC, MKV and 16-bit PCM sound
are playable because Chrome on the Pixel and on the Windows PC played them. A trap it still
exists to avoid, which fails silently:

- **`codec = h264` is not sufficient.** High 10 and High 4:2:2 are common in anime encodes and
  camera output, play fine in VLC, and no browser decodes them. Checking the codec alone
  produces a library that mysteriously half-works.

It used to separate MKV from WebM by the file's extension, because ffprobe names both
`"matroska,webm"` and only WebM was thought to play. Chrome plays both, so the distinction went.

**Remux before re-encode.** A file of perfectly good H.264 and AAC in the wrong container (an
AVI, now that MKV plays) needs only a container
change: seconds of I/O rather than minutes of CPU, and on a NAS that is the difference between
watchable now and watchable this evening. The assessment reports this as `remuxOnly` so the
job knows before it starts rather than discovering it inside.

Output is always written to a temporary name and renamed on success. A transcode that dies
halfway - a killed container, a full disk, a corrupt region two hours in - otherwise leaves a
truncated MP4 exactly where the player expects a complete one, and the `Variant` row is only
written after the rename, so there is no window in which a row points at a partial file.

`-movflags +faststart` is not optional: without it the moov atom lands at the end and a
browser must download the whole file before it can start, which defeats the point of having
made it. The muxer is named explicitly (`-f mp4`) rather than inferred from the extension,
because the path ffmpeg is actually handed ends in `.partial`.

**The scale filter is unconditional, and both axes are forced even.** H.264 with yuv420p
cannot encode an odd dimension at all, so `445x345` is not an unusual size, it is an
unencodable one. The filter used to be skipped whenever the source was already under the
height cap — true of the size, false of the parity — and even when it did run, `scale=-2:h`
rounded only the width. Both holes produced the same thing: `Error while opening encoder`,
three times, on every pass of a sweep that then queued the file again. The height is written
as `trunc(min(H,ih)/2)*2` rather than computed in TypeScript because the probed height is null
often enough to matter, and ffmpeg evaluating `ih` is the version that holds when we do not
know the dimensions.

**A failed transcode has to be remembered, and nothing was remembering it.** Stages record an
outcome in `MediaStage` and stop after `maxAttempts`, but a transcode is a job kind rather than
a registry stage (§7b), so it writes no such row and `needsWork` has no opinion about it. The
backfill selects on "no ready rendition", which a permanently failing file satisfies forever.
`settledMediaIds` is what closes that loop: the sweep skips an item whose most recent job of a
kind was cancelled _or_ failed, and a later job for the same item overrides either — so an
explicit "try this one again" still works and only the automatic path is silenced.

**The candidates are chosen in SQL, by the verdict's own translation (fixed 2026-10-17).**
`mediaRepo.listTranscodeCandidates` used to return at most 500 probed videos without a ready
rendition, with no `ORDER BY`, and both callers (the worker's `backfillTranscodes` and
`POST /api/admin/transcode`) dropped the playable ones afterwards in TypeScript. Most of a library
plays, so the 500 could be entirely playable files: the sweep queued nothing, the same 500 came
back five minutes later, and the files that needed a rendition were never reached. It now filters
with `playbackBlockedSql`, the SQL form of the verdict that the library's playback filter already
used and that `playbackFilter.test.ts` holds to `assessPlayback` case by case. It is ordered by
id, and a test puts the one file that needs work behind 600 that do not. The callers still ask
`assessPlayback` of what comes back, so the TypeScript keeps the last word.

### Checking the verdict on real devices

`assessPlayback` gives one answer for every device, and devices differ: HEVC decodes in hardware
on most recent phones and GPUs, and Chrome opens more containers than it advertises. Measured on
the NAS (2026-10-17): 7,902 of 8,107 videos play directly; the other 205 are mostly HEVC in
MP4/MOV (~100) and H.264 in MPEG-TS (~81). Before building anything to convert those, the
question is which of them the household's own devices already play. That decides between
deciding per device, repackaging in the browser, handing off to an external player, and
transcoding on demand.

**What it found (2026-10-17), identically in Chrome 155 on a Pixel 10 Pro and on a Windows PC:**
every HEVC sample played (8- and 10-bit, MP4, MOV, MKV), as did H.264 in MKV and MOV with 16-bit
PCM sound, 118 files in all. Every MPEG-TS sample was refused (81). Six odd files did not play:
ProRes and MPEG-4 Part 2 gave sound with no picture, MP2 sound gave a picture with no sound,
and AVI and WMV were refused. The verdict now says exactly that. MPEG-TS plays as segments
(below), and the six are what background transcoding converts, kept by a copy in `/data` rather
than by replacing the original. Replacing originals was asked about and not chosen: it would
break the rule that deletion is the only write to a media library.

**The item page plays every video**, including one the verdict expects to be refused. A
refusal falls back to the cover with the notice saying why (`playerFailed`), which is also what
keeps a rolling show moving. Trying costs one failed request; not trying costs every device that
could have played the file. A refusal is either an error or **no picture**: a browser that can
decode the sound but not the video track (HEVC without a decoder) plays the one and drops the
other, so a `loadedmetadata` with `videoWidth` 0 counts as refused too. The verdict still decides
what the worker converts, what is warmed as the next item, and what a show or a reel counts as
playable.

**Processing › Transcoding › Playback check** asks each device directly. Its page
(`/admin/playback-check`) groups the flagged videos by kind (`describePlaybackKind`: "HEVC in
MP4", "H.264 in MPEG-TS"), takes the same two samples of each for every device, and tries them in
one small muted player, one at a time because phones have few decoders. It records a picture
(decoded frames), sound (`webkitAudioDecodedByteCount`; Chrome decodes a muted element's audio
because that audio is its clock) and whether playback kept going. Opening it on a device is the
whole test, and its summary is plain text for comparing devices. The card's switch
(`playback.check`, off by default) adds "Won't play in a browser" to the filter panel
(`playback=blocked`) for looking at the files themselves. It is off by default because it is a
test bench, not a way of browsing. That filter is the one place the verdict is asked in SQL
(`playbackBlockedSql`). It is built from the same lists (`PLAYBACK_RULES`), and
`playbackFilter.test.ts` asks both implementations about each edge case, so they cannot drift
silently.

### Playing an MPEG-TS file without copying it

No browser opens `.ts`/`.mpg` files, and nothing can seek in one without knowing where its
keyframes are, because the container has no index. HLS solves exactly this, and a playlist may
name **byte ranges of a single file** as its segments. ffmpeg writes that layout itself with
`-hls_flags single_file`. So:

- The `segments` stage (automatic, video, priority 110, ahead of the previews because until it
  runs the file does not play) reads each MPEG-TS file once with ffprobe's packet listing and
  writes its keyframes, `[ms, byte offset]` pairs, to `/data/segments/<xx>/<id>.json`, stamped
  with the file's size and mtime. Every other video answers `skipped` without reading anything.
  The files are swept like the tile prints: kept while the stage records them done, and a
  missing one clears that record so the stage runs again.
- `/api/media/:id/stream` answers an MPEG-TS item with the playlist (`buildSegmentPlaylist`):
  keyframes grouped into segments of four seconds or more, the first from byte 0 so it carries
  the stream's tables, the last to the end of the file. The segments are `stream?raw=1`. This
  address was already "what this browser should play", an original or a rendition, and the
  player keeps not knowing which, so **the player did not change**. Chrome plays HLS natively,
  which is both of the household's devices.
- An index that describes different bytes (the file was replaced in place) is ignored, and the
  original is served, which the browser refuses and the item page explains.

`mpegts.js`, which repackages TS in the browser, was the first idea, and it was dropped because
its seek gives up without a keyframe index. Before this was built it was proved on a generated
clip in Chrome: picture, sound, and seeking to unbuffered points, both natively and through
hls.js. `segments.integration.test.ts` keeps that proof: ffmpeg decodes every frame of a real
clip through the playlist without an error.

### Open in another app

When a browser refuses a file, the notice offers it to a player that will play it: **Open in
another app** on Android, where an `intent:` link offers every installed video player, and
**Copy stream link** elsewhere, for VLC's "Open Network Stream" (VLC on Windows registers no
link type to hand it to). The link is a signed media token (§12d) for the original's bytes
(`POST /api/media/:id/token` with `{ original: true }` → `…/stream?t=…&raw=1`). It is not refused
for a file with no playable version, unlike a link for a TV, because VLC plays what neither a
browser nor a TV does. It lasts the token's day.

## 8b. Opening the next item

Pressing next used to do four things in series, and only the last of them was video:

1. `router.replace("/media/:id")` — a round trip for the route's payload, which nothing
   prefetched, because stepping through a set is a router call rather than a `<Link>`.
2. The page blanked to a loader while the new item's details loaded, **which threw the player
   away**.
3. `GET /api/media/:id`.
4. A fresh `<video>` started from nothing: `HEAD`, then ranged reads to find the index — two or
   three more round trips on an MKV whose cues sit at the end of the file — and only then the
   first frames.

Now the first three are warmed while you are still watching the current item, and the fourth is
warmed too, by a second `<video>` element.

### Two elements, and why neither of them ever moves

`VideoPlayer` renders two `<video>` elements and shows one. The hidden one holds the next item,
with `preload="auto"` so that it buffers picture rather than merely asking how long the file is.
Pressing next then changes **which element is on screen**, and nothing else.

That last part is the whole design, and `lib/videoSlots.ts` exists to keep it true. The slots
are positional and keyed by the id they hold:

- **A slot's index never changes.** The warmed element does not slide into first place when it
  starts playing; the _active index_ moves to it. Reordering them would make React move a node,
  and a moved `<video>` may drop everything it buffered — for nothing anybody can see.
- **An element belongs to an id.** React reuses a node whose key stayed put and builds a new one
  for an id that has just arrived, which is exactly the distinction between the item that was
  warmed and an item nobody saw coming. Jumping in from the grid overwrites the element on
  screen and pays the old price, which is the correct outcome rather than a missing feature.

A version that quietly threw the warmed element away would still play everything, just always
from cold, so the arithmetic is pure and tested rather than folded into the component.

### What this cost: the element now outlives the item

The player was written when every item got a fresh mount — step 2 above guaranteed it — so
every counter in it started at zero because it had just been constructed. One comment in it
already claimed the element was reused across a set; that had been false for as long as the
loader existed. Making it true means saying out loud what used to be free:

- **A reset per arrival**, clearing the watched-run counters and the opening-seek latch, and reading duration, position, buffer and paused state **back off the element**
  rather than assuming they are zero — because a warmed element is already several seconds into
  being ready. It is read back rather than zeroed for an ordering reason too: the effect that
  binds the listeners is declared above the reset, so on a swap it has already reported the
  element ready by the time the reset runs.
- **The opening seek happens immediately when the metadata is already there.** It used to hang
  on `loadedmetadata`, which a warmed element fired before anybody looked at it and will not fire
  again. The latch is cleared per _arrival_ rather than remembered per id, because stepping back
  to the item you just left is a new arrival at it — and it has a position to return to
  precisely because you were there a moment ago.
- **Listeners follow the element.** It is held in state as well as in a ref: the ref is what the
  handlers read when they fire, and the state is what the effects depend on, so an effect that
  bound itself to the outgoing element rebinds to the incoming one.

### Who pays for it, and what gets warmed at all

Three gates, each refusing for its own reason:

- **The item has to be playable as it stands.** `directPlay` was once on the details only; it is
  on every list item now (the tasting skips on it, §14g), but the viewer still fetches the next
  item's details, which removes step 3. An item awaiting a transcode is not warmed.
- **The device has to be a reasonable place to spend the bandwidth** (`lib/videoWarming.ts`).
  `saveData` settles it alone, being the one signal that is a request rather than an inference;
  a slow `effectiveType` refuses; and a phone is recognised by a coarse pointer _and_ a narrow
  window, because either alone is a resized desktop or a television on a LAN — which is the
  device that benefits most, not the one to protect.
- **The current item has the prior claim.** Warming waits for the playing element to reach
  `canplay`. Two streams off the same disk is how a preload for later becomes a stutter now.
  `canplay` rather than `canplaythrough`, which on a four-gigabyte file may never arrive.

### What is warmed has to be the part that will be played

Warming worked and looked broken, which is the worst combination there is. On a library anybody
has actually watched, pressing next still stalled for seconds — and inspecting the page showed the
hidden element exactly as designed: `preload="auto"`, `readyState: 4`, fourteen seconds buffered.

The bytes were real and they were the wrong bytes. `preload="auto"` buffers from the element's own
`currentTime`, the page passed `preloadStartMs={null}` for the library, and the player then sought
to a stored resume point **on arrival** — so an item with a position warmed fourteen seconds of its opening,
arrived, seeked to 4:32, and opened a fresh range request into the middle of a file on a NAS. The
comment that justified the null said "the next item always opens at its beginning", which is true
of an item nobody has watched and false of every item anybody has.

The mechanism to fix it already existed: `preloadStartMs` was built for reels, where a clip's in
point made the same problem obvious immediately (§14d). Stepping through the library had the
identical bug and hid it, because **warming the wrong offset and not warming at all produce the
same symptom** — there is nothing on screen that distinguishes them, and the one measurement
anybody would take says the warm succeeded.

So the rule moved to `lib/resumePoint.ts` and both sides ask it — still, now that the only position
is one left earlier in the same visit (§14b): the player, deciding where to seek
on arrival, and the page, deciding where to warm from. Two callers of one function rather than a
condition copied into a second place, for the reason §7b gives about the stage registry — if they
can disagree the bug returns silently, and this is a bug whose whole character is that it is
silent. `resumeTarget` returns null rather than zero for "the beginning", because "start at the
beginning" and "seek to zero" are the same playback and very different instructions to an element
that is buffering speculatively.

### The stage has a still sibling, and the show walks past what it cannot play

Everything above is about `<video>`, and the slot arithmetic turns out to be about neither. The pure
part in `lib/videoSlots.ts` serves a still stage unchanged, for a different payoff: two stacked
`<img>` elements, keyed by the id each holds and never reordered, so the picture that was warmed is
already decoded in the other slot and arriving at it is a change of _which_ slot is active. For a
video that survival buys a buffer; for a picture it buys something to cross-fade **from**. A picture
nobody saw coming — a jump in from the grid, or a device the warming gate refused — overwrites the
slot on screen, and there a cut is the honest answer, because there is no decoded replacement in
hand to dissolve to.

What is warmed widened with it. `warmable` used to be "the next item if it is a directly playable
video, otherwise nothing", on the grounds that warming an image is a cover the grid already has.
That is true of a _tile_ and false of the stage: a photograph here is the original file, and it is
the one thing on this page that can take four seconds to arrive. So the next item is warmed in
whichever form it will be shown in — the file for a picture, the cover for a film awaiting
conversion — behind the same device gate, which is now `mayWarmNextItem` because nothing inside it
was ever about video. A pending transcode is still never warmed: that would download an original
nothing can decode.

And **an unplayable item is something the show walks past rather than something it stops at.** No
player is mounted for it at all: `directPlay` is on the details, which are already fetched, so the
decision is made before an original nothing can decode has been requested. What used to happen —
mount, request, error, remove itself — spent a download to arrive at an empty stage. The player's
own "there is no player here" branch went with it, because two components answering that question is
how the empty stage happened. What remains is `onUnplayable`, for the case `directPlay` cannot see:
a file that claimed it could play and whose bytes have gone. Without it a show would stall there
exactly as it used to.

**This is a different answer from a reel's, deliberately.** A reel filters unplayable clips out of
its set entirely, so "3 of 12" counts what you will actually see; a reel is an authored work and a
missing clip is a hole in it. The library set is everything you filtered to, and quietly dropping
members would make "23 of 312" a lie and a counter that jumps by two. So the reel skips, and the
library holds for a few seconds and moves on.

### Seeing it work

Everything above is invisible by design. The element doing the work is a transparent pixel, and,
as noted earlier, a warm at the wrong offset looks the same from outside as a warm that worked.
So there is an overlay that says what is happening. It is for admins only, it is per device, and
you switch it on under the About dialog's admin tools (§15). It is a badge, top centre, over the
page, a fullscreen player and the tasting. Fullscreen costs it nothing, because the document is
what goes fullscreen.

- **The badge** reads the hidden element directly:
    - `READY`: its buffer holds the start it will be joined at.
    - `LOADING` or `WAITING`: it is still buffering, or the current item has not reached `canplay`.
    - `OFF` / `NO NEXT`: the device refuses, or nothing was offered.
    - `MISS`: it is parked away from the start, which is exactly the failure described above.
- **Every join is watched for ten seconds**, then written to the panel and as one `console.info`
  line (not `debug`, which DevTools hides under "Verbose"). A record holds:
    - the kind, from `advanceTo`: `SWAP`, `SEEK`, `COLD`, or `CUE` for a tasting's held element
      when it is let go — or the showcase's, whose voice is cued the same way (§14f) and
      reports as `showcase`;
    - whether the buffer already covered the start;
    - how much was buffered past the start at the moment of the switch;
    - how long until a decoded picture appeared, and **where it landed**. A picture that lands
      more than 2 s from its start is flagged `OFF TARGET`;
    - how long until it was actually **playing**. A picture in 40 ms and playback in 2 s is a
      warm that did not do its job, and a warmed join slower than 500 ms to play is coloured
      as a failure;
    - everything the element said afterwards, in order and timed: `play`, `waiting`, `stalled`,
      `playing`, seeks, and `play-refused`. The browser fires nothing when it refuses `play()`,
      so the player fires that one itself, with the error's name. "Never asked to play",
      "refused" and "starved of bytes" are three different causes of one symptom.
- **The server's side of each stream** goes into the response headers, for admins only:
  `X-PS-Stream` (a number), `X-PS-Active-Streams` (how many the server was already pumping),
  `X-PS-Source` (original or web-safe) and `Server-Timing` (auth, lookup and stat). With these
  a HAR can separate time queued in the browser from time spent on the NAS.
  `PRIVATE_STOCK_STREAM_LOG=1` adds a log line per stream as it ends, with the bytes sent and
  whether it finished or was abandoned. That line shows whether an element nobody is watching
  is still draining a connection.
- **The viewer says why it offered nothing**: an end of set, details still loading, or a next
  item of the other kind. A bare "nothing offered" would hide the gap in the known limits below.

The players report into module state (`warmMonitor.ts`) through `useWarmReport`, and the overlay
polls that state, so a player is never re-rendered on the overlay's behalf. With the overlay off,
each report returns at its first line.

### A removed element keeps its request

React unmounting a `<video>` does not stop it loading. The detached element keeps its player, and
the player keeps its request open — deferred, reading nothing — until the element is garbage
collected, which can be minutes later. The tasting makes a new element for every film it plays,
so a long tasting left a trail of them, and over HTTP/2 that is worse than a leak: bytes a stream
has received but not read still count against the **connection's** flow-control window, which
every request to the app shares. Once a few abandoned streams had filled it, every later stream,
cover and API call arrived as headers and no body — DevTools showing a column of `206`s at
0.1 kB, "Pending", while the server's event loop sat at 21 ms and it had no media file open.

Every `<video>` in the app is a `ReleasingVideo` (`components/media/ReleasingVideo.tsx`), which on
unmount removes `src` and calls `load()` — the spec's way to drop a media resource, which aborts
the fetch there and then. It releases only an element that has left the document, because
Strict Mode's rehearsed cleanup runs on a node that stays mounted.

### Known limits

- **The amount buffered is the browser's decision.** `preload="auto"` says "buffer this"; there
  is no way to say "buffer four seconds of this" without taking over the buffering with Media
  Source Extensions, which is a different and much larger feature. What is bounded is the count:
  one item ahead, never two.
- **The hidden element is outside the preview budget** (§14's decoder arbitration). It is one
  more `<video>` than that budget knows about, which on a desktop sized for eight is
  immaterial — and the alternative, letting a hovered tile evict the preload, would silently
  spend the bandwidth and then discard the result. The showcase's voice is the exception: its
  cued player is a whole player in a tile rather than a hidden second element, and it takes a
  slot above every silent montage (§14f).
- **Only forwards.** The previous item's route is prefetched but its bytes are not: warming both
  directions doubles the cost for a gesture that is rarer, and the two elements are exactly
  enough for one item ahead.
- **Not across stages in the viewer.** A film followed by a photograph, or the reverse, warms
  nothing: each stage warms only its own kind, and the stage for the other kind is not mounted.
  The tasting does cue across kinds (§14g); the viewer does not yet. The overlay names this case
  when it happens.

## 9. Visual artifacts

- **Cover** — frame at ~10% in, skipping near-black frames, plus 4 alternates the user can
  switch between.
- **Hover preview** — 6 × 1 s clips sampled across the video, concatenated into a silent
  ~480p WebM (≈300 KB). Plays on hover in the grid and autoplays for in-viewport tiles in
  **gallery mode**, staggered and capped so a screen of 40 tiles does not decode 40 streams
  at once. Pauses offscreen; respects `prefers-reduced-motion`.

    Segments are encoded separately and concatenated, rather than trimmed out in one
    filtergraph. A `trim`/`concat` graph reads tidier and makes ffmpeg decode the entire file to
    reach the last segment — minutes of CPU for six seconds of output.

### The preview budget

Each `<video>` holds a hardware decoder and browsers cap how many may exist; mobile Safari
historically allowed **one**. Exceeding the cap does not queue — playback silently fails or
stalls the streams already running, which reads as a broken app rather than a busy one.

So concurrency is budgeted by a module-level singleton, not decided per tile: forty tiles
each deciding for themselves is exactly the situation that breaks. Tiles request a slot and
obey the answer. A hovered tile outranks an autoplaying one and displaces it; **equal
priorities never displace each other**, because two tiles of the same rank taking turns
evicting one another is a permanent flicker rather than a preview. The limit is inferred from
coarse device signals and deliberately errs low: guessing high fails invisibly, on the devices
least able to explain why.

- **Scrubber sprites** — `fps=1/N, scale=200:-1, tile=10x10` WebP sheets plus a WebVTT
  thumbnail track; the scrubber positions a background sprite from the VTT.

    **Scrubbing a touch drag** (2026-10-17). A finger dragging the scrubber seeks once, when it
    lifts; until then the handle follows the finger and the filmstrip is the preview. The bar
    used to seek on every `pointermove`, which on a phone is 60–120 seeks a second, and each
    one outside the buffered range is a new range request against `/stream`. A mobile browser
    did not abandon them as fast as it made them, so a long drag left dozens of streams queued
    and the whole session -- pages, ratings, the next item -- waiting behind them on the one
    disk (§20). A mouse still seeks live, because frame-accurate dragging is how an in point is
    found (§14d), but the player keeps one seek in flight and applies only the newest target
    when it lands: a drag costs a request per seek the NAS can answer, not one per pixel.

    **The interval is derived from a target tile count (100), not fixed.** A fixed ten seconds
    gives a 30-second clip three thumbnails and a three-hour film a thousand; targeting a count
    makes scrubbing feel the same at either length and bounds the disk cost per video, which is
    the number that matters at 200k of them.

    **100 is calibrated against the pointer, not against the video.** A measured sheet runs
    ~2.3 KB per tile, so the target sets the per-video cost directly: ~210 KB for a 12-minute
    video, against ~700 KB at the 300 this section used to specify. The extra tiles were
    unreachable. On a 900px scrubber 100 of them change the thumbnail every 10px, which is
    already about a thumb's precision; 300 changed it every 3px, and on a 360px phone every
    1.2px. At a 12-minute average the interval lands at 8s — Netflix and Jellyfin territory,
    a little coarser than Plex's 5s default.

    The original 300 was reasoned about feature films, which is the one thing a library of
    5–25 minute videos does not contain. Rounding the interval up to a whole second also made
    the old target non-monotonic across exactly that band — a 10-minute video took 300 tiles
    and a 12-minute one 240, so the shorter video cost more disk.

    **100 is also where the savings stop paying for themselves.** Across a 200k library, 300 →
    150 saves ~55 GB and 150 → 100 another ~24 GB; 100 → 75 saves only ~9 GB and 75 → 60 about
    5 GB, while each step adds seconds to the interval. Below ~100 the preview visibly holds
    still while the pointer moves, which reads as lag rather than as economy. Going _finer_
    than 100 is the cheaper mistake to correct in principle, but not in practice: the `sprite`
    job reads the whole file, so re-rendering a library is the most expensive sweep in the
    system. Settle this before the first full scan.

    **Only keyframes are decoded, when they are dense enough to be the tiles.** Sampling every
    N seconds through `fps` otherwise decodes every frame to keep a hundred of them, and that
    decode is the whole cost of the job — reading the file and encoding the sheet are each
    under a second. With `-skip_frame nokey` the decoder skips everything but keyframes and
    `fps` keeps one of them per tile (which one: "What a tile shows", below): on a 10-minute 1080p file held to two threads,
    roughly what the NAS gives this job, 69s became 10s, and the keyframe path stays flat as
    cores are taken away where the full decode does not.

    The condition is that no gap between keyframes exceeds the interval, measured from packet
    flags over the first minute (~130ms, no decoding). Past that, consecutive tiles would show
    the same keyframe — a scrubber that holds still under a moving pointer — so long-GOP encodes
    (x264 allows ten seconds by default) and anything unmeasurable take the full decode:
    slower, never wrong. Phone and screen recordings, keyframing every second
    or two, nearly always qualify.

    **AV1 seeks instead** (2026-10-07). Its decoder here, libdav1d under ffmpeg 5.1, does not take
    "keyframes only", so the one pass decodes every frame whatever it is told: a 22-minute 4K AV1
    file stopped at the 30-minute limit, twice. For a codec in `SEEK_CODECS` each tile is read on
    its own — `-ss` to its time with `-noaccurate_seek`, so the keyframe at or before it is the one
    frame decoded — and the tiles are packed into the same sheets by one more ffmpeg. Measured on
    the NAS, 0.19 s a tile, against 5.4 s for the exact frame: about twenty seconds for that file.
    A tile is at most one keyframe interval early, and one that cannot be read repeats its
    neighbour, since every later tile's place on the sheet depends on the count. The tiles are
    written in a per-attempt `.sprite-tiles-XXXXXX` directory, removed afterwards and swept if
    abandoned, as a preview's parts are. Other codecs keep the one pass, which is faster for them.

    **What a tile shows** (measured 2026-10-17). A tile's moment is `index × interval`, and its
    picture is seldom that frame. `fps=1/N` rounds each frame's time to the nearest slot and
    keeps the _last_ frame of each, so on both one-pass paths a tile shows what was on screen
    just short of half an interval **later**: measured with a frame-numbered fixture, the tile at
    10s of a 10s interval was the frame at 14.9s on the full decode and the keyframe at 14s on
    the keyframe path. On a long video that is fifteen seconds. The seeking path's tile is the
    keyframe at or before the moment on the image's ffmpeg 5.1; on 6.1 `-noaccurate_seek`
    returns a frame or two short of the moment instead. Which path made a sheet is not recorded.

    For the scrubber this is harmless, arguably right: the cue spans the interval, and the tile
    is from within half an interval of its middle. It was not harmless for faces, which are found on tiles and record the
    tile's moment (§5f): framing a picture from a face read the frame at that moment, a
    different picture from the face pressed, with the face's box over where the face had been.

    **The moment is found when it is needed, not corrected in the data** (decided 2026-10-17).
    A face's `atMs` stays the tile's nominal moment. Where the exact frame matters,
    `readTileMoments` lists the packets around it (headers only), takes the frames each path
    could have kept (`tileCandidates`: the last frame and the last keyframe before half an
    interval on, the keyframe at or before the moment, and the moment itself), reads each at the
    tile's size, and keeps the one whose pixels are nearest the tile's. `/api/media/:id/moments`
    serves that, under the frame ceiling, cached in memory by face. Two things ask: the picture
    dialogue opened from a face, which frames the match and offers the other candidates beside
    the tile to choose instead, and "Go to this moment" and the faces on an item's page, which
    seek to the match and fall back to the nominal moment if it cannot be read. Links to an item
    at a face's moment (History, a performer's faces) keep the nominal moment, which lands
    within the interval.

    _Rejected: re-rendering sprites and re-reading faces to record each tile's real time._ About
    four days of the NAS to correct moments that matter for the handful of faces anybody frames
    or goes to, and a resolver would still be needed for the sheets in between. _Rejected:
    recording real times for new sprites only._ Two kinds of moment forever, and the old ones,
    nearly all of them, would still need the resolver.

    **The automatic pictures use it too** (§6 "A tag's picture"). A performer's is chosen by a
    face and a source's or a keyword's by a look representative, and both are found on tiles.
    `drawFromTile` cuts the picture from the frame the tile really shows (`seenAt`, falling back
    to the tile's moment with no sheet to compare with), with the lowered priority background
    work runs at. The row keeps both: `atMs` the frame it was cut from — where "the moment it
    came from" leads — and `tileAtMs` the tile's moment, which is how the next run knows the
    picture already shows what it would choose (`showsTile`). Pictures drawn before
    `tileAtMs` existed have none, so each is drawn again once, from the right frame: one pass
    over the performers, sources and keywords with a picture from a video, not a sweep of the
    library.

    **One filter graph for the whole file (`-reinit_filter 0`).** By default ffmpeg rebuilds
    the graph whenever a decoded frame's format changes, and the rebuild discards what `tile`
    had collected towards the sheet in progress. A file spliced from clips with different
    colour metadata — full-range yuvj420p beside yuv420p bt709, found in production — changes
    format at every join: sheets silently lost their start, and on the keyframe path a
    five-minute video produced no sheet at all. `scale` adapts to a new input size by itself,
    so nothing downstream needs the rebuild. An empty keyframe render still falls back to the
    full decode rather than failing, for whichever cause is not known yet.

    **stderr is kept as a tail, not buffered.** `-max_error_rate 1` tells ffmpeg to decode
    past damage, and it logs several lines per bad packet doing so; one file wrote 7 MB of
    them, and `execFile`'s 1 MB `maxBuffer` killed the very run that had been told to
    tolerate them — sixteen sprites failed three times each that way. The render is spawned
    and keeps the last 64 KB, which is where ffmpeg says why it stopped, and its error names
    the program and exit rather than the command line, so a stage row's 500 characters hold
    the reason rather than the filter graph.

    _Rejected: seeking to each tile._ A seek per tile is a process per tile, and on Windows a
    hundred ffmpeg spawns measured 21s against 17s for decoding the same file end to end. It
    remains the only approach that would avoid reading the whole file off a share, if that
    ever becomes the bottleneck rather than the CPU.

    **Sheets encode at `-q:v 70 -compression_level 6`.** Measured on a real sheet, 70 is ~11%
    smaller than the 78 this started at for an SSIM of 0.985 against 0.990 — these thumbnails
    are 200px wide, shown for a fraction of a second under a moving pointer, and never studied,
    which is the most forgiving viewing condition in the app. Cover art is the opposite case and
    keeps its own quality. Maximum encoder effort is a further ~6% at identical fidelity for
    ~160ms per sheet, which is free beside the seconds of decoding the job spends even on its
    keyframe path.

    Quality is the weakest of the three levers, though: it moves the per-video figure by ~16%
    where the tile count moved it by 67%. Reach for the target first.

    **The grid holds exactly the target, so the usual case is one sheet**: below 50 minutes the
    interval can always stretch far enough to stay inside 100 tiles, and only past that does
    `MAX_INTERVAL_MS` bind and a second sheet open. One file, one request, one decode. Keep
    `SPRITE_COLUMNS * SPRITE_ROWS` equal to `TARGET_TILE_COUNT` — a target above it silently
    doubles the file count for a few extra thumbnails. Partial sheets are nearly free: ffmpeg
    pads the last one and the padding compresses to nothing, so tile count is what costs disk,
    never sheet count.

    Sheets **must** be written with `-c:v libwebp -f image2`. Without both, a `.webp` output
    selects ffmpeg's animation encoder: every sheet is packed into one file as ANMF frames,
    `%d` never expands, and the result is an animated image that ffmpeg's own decoder then
    refuses to read. Nothing about the code looks wrong when this happens, which is why the
    integration suite asserts the sheets are separate and measurable.

    The VTT carries the same version tokens the web app would generate, so the browser caches a
    sheet for a year instead of revalidating it on every open. That is why `artifactVersion`
    lives in `@private-stock/core/server` rather than in the web app: the worker needs it too.

### Binary artifacts live on the filesystem, never in SQLite

**Rule: the database stores paths and metadata; bytes go on disk.** The only BLOB in the
schema is the 8-byte pHash, which is an index key rather than content.

```
/data/art/<xx>/<mediaId>/
    cover.webp  poster-1..4.webp  preview.webm
    sprite-0.webp  sprite-1.webp  ...  sprite.vtt
/data/variants/<xx>/<mediaId>/websafe.mp4
/data/hls/<xx>/<mediaId>/<profile>/*.m4s
```

`<xx>` is the first two hex characters of the media id — 2-level fanout, because NAS
filesystems handle 100k-entry directories badly.

Why this matters more than it looks: sprite sheets for a 200k-item library run to tens of
gigabytes. In SQLite that bloats every backup, makes `VACUUM INTO` impractical, forces
reads through the same write-locked file the worker is hammering, and gives up the OS page
cache and sendfile. On disk they are served as plain static files with long cache headers,
and the database stays small enough to snapshot nightly.

`Artifact` rows therefore carry `mediaId, kind, ordinal, relPath, width, height, tileCount,
intervalMs, bytes, atMs, source, createdByUserId, label, generatedAt, generatorVersion` —
enough to serve and to invalidate, and no pixels. `generatorVersion` is what lets a changed
sprite recipe re-enqueue only the stale artifacts.

### User-chosen covers and captures

People will want to override the frame that represents a video, and to keep several stills
grabbed from the player. Three columns carry that, and they are in the schema from the start
because retrofitting them means migrating a table that by then holds a million rows.

- **`source` (`auto` | `user`)** — the important one. An `auto` artifact is disposable output
  the generator may replace whenever the recipe changes; a `user` artifact is something a
  person made and is never touched by regeneration or by a cleanup sweep. Without this, the
  distinction has to be inferred from `kind`, and the first cleanup pass that gets the
  inference wrong destroys someone's work irreversibly.
- **`atMs`** — where in the source the frame came from, so the player can jump back to it and
  a regenerated cover can keep a position someone chose.
- **`Media.coverArtifactId`** — a nullable pointer to any image-like artifact of the same
  item. Null means "whatever the generator produced". Choosing a cover is therefore a
  one-row update that overwrites no file, so reverting costs nothing and the generated cover
  stays available. Deleting the frame it points at reverts the item to the generated cover on
  its own: the column is declared `ON DELETE SET NULL`, so that case needs no code.

**Capturing a frame is the one place ffmpeg runs inside a request, and the exception is
deliberate.** §2 keeps ffmpeg out of the web process because transcodes saturate CPU for
minutes and must not share a process with request handling. A single frame is not that: with
`-ss` before `-i` the work is a seek and one decode, whatever the length of the file. The
alternative is a job, and a job cannot keep the promise the button makes — that the picture
has changed by the time you are back at the grid — because the worker's idle poll alone is
two seconds and longer while it is busy. The exception is bounded to exactly this: one frame,
one hard timeout, and nothing else. `frameArgs` and the ffmpeg lookup therefore moved to
`core/server`, so the worker and the web app cannot disagree about the argument order that
makes it affordable.

**Capturing and choosing are two presses, not one — except for the first capture.** The
primitive is the capture; making it the cover is a pointer update on top, and the two have
completely different costs and lifecycles. So the player captures, and the strip of frames on
the item's page, under its title, is where one of them is made the cover (§14b, "The viewer's
layout").

The first capture on an item is the exception, and it earns it: capturing a frame for an item
that has never had one is almost always somebody fixing a thumbnail they dislike, and making
them then open a panel and click the picture they have just made is a second step with no
decision in it. Once there is more than one candidate there _is_ a decision, and it goes back
to being manual — nothing after the first silently changes what the library shows.

**That promotion is guarded by two conditions, and the second is the interesting one.** It
happens only when this is the item's first capture _and_ no cover has been chosen. Keying it
on "no cover has been chosen" alone reads as equivalent and is not: pressing "use the
generated cover" clears the pointer, so the next capture would be promoted straight back over
a choice somebody had just deliberately made. The rule is meant to fill an absence of
curation, never to overrule it — which is the same line `source = 'user'` draws for the files
themselves. Deleting every capture does reset it, because the foreign key clears the pointer
and clearing the shelf should behave like starting over.

The button says which of the two happened. The strip that shows it used to live behind the
details panel, and a press that quietly did one of two different things would have made the rule
look arbitrary; it is on the page now, and the message stays because it says _why_.

**There is no cap on captures per item.** A 640px WebP is some tens of kilobytes, so the
argument for a limit would be about the strip becoming unreadable rather than about disk —
and a limit that exists to tidy a UI is a limit that refuses somebody's work for the
convenience of a scrollbar.

Cover selection is **library-wide rather than per-user**, which is the one arguable call
here. Picking the frame that represents a video is curation, not a private preference: if it
were per-user, two people would see different grids and neither could fix the other's. A
per-user override can still be added to `UserMedia` later without moving this.

The cover job already writes four alternates alongside the cover, so "use a different frame"
costs no ffmpeg work at the moment someone asks for it — the candidates are sitting there.
`capture` is a separate kind from `poster` for exactly the lifecycle reason above.

**Ordinals are recycled after a delete, and the version token is what makes that safe.**
`nextOrdinal` is max-plus-one over the rows that still exist, so deleting the third capture
frees `capture-3` for the next one. This section used to claim the opposite — that ordinals
were never reused, so a removed capture's URL could not be resurrected from a cache — which
was never true of the code and was solving the problem twice. Every artifact URL already
carries `?v=`, a hash of the path _and_ the time the artifact was written (§9), so a new
frame in a recycled slot is a URL no browser has seen; a page still holding the old token
gets the short revalidating response rather than the year-long immutable one. That is a
stronger guarantee than a monotonic counter, because it tracks the bytes changing rather than
a slot being recycled.

**A capture is library-wide to read and its owner's to destroy.** Everybody sharing a
library sees everybody's frames, which is the point -- a good still of an item is good for
whoever looks at it, and duplicating them per user would be duplicating expensive output for
no gain. Discarding one is the opposite case: nothing else in the app permits a cross-user
write, sharing grants reading and never writing even to administrators (§6), and a capture
is stronger than a playlist because it cannot be regenerated. So a capture may be discarded
by the person who took it, or by an administrator; the strip does not draw the control
otherwise.

An unattributed capture is admin-only. `Artifact.createdByUserId` is `ON DELETE SET NULL`,
so a capture outlives the account that made it and loses only its attribution -- and the
alternative to admin-only is that deleting an account quietly hands that person's frames to
everyone. Choosing the cover stays open to anyone who can see the item, deliberately: it is
library-wide curation, it writes nothing, and it is undone by choosing again.

**`/api/art/<id>/cover` is an alias; every other name is a specific artifact.** The bare
name resolves the _effective_ cover, which is what lets a grid tile ask for "whatever
represents this item" without knowing whether anyone has curated it. `cover-0` names the
generator's own cover and `cover-n` a capture's rendering, and those have to resolve to the
row named rather than to the alias -- otherwise the frame strip, which asks for each frame
by name, draws the current cover in every slot. That was live and stayed invisible for as
long as covers shared a filename: the wrong row named the right file, so the wrong answer
was indistinguishable from the right one until the ordinals reached the filenames.

**Frames are listed in the order they occur in the video, never in the order they were
made.** They are pictures of one thing that happened in a fixed order, and that is the only
ordering a viewer can reason about: scanning the strip left to right is scanning forward
through the clip, and a frame stays where it is however many more are taken around it.
Sorting by creation puts a still from the closing shot beside one from the opening titles
because somebody happened to grab them in that order, and shunts everything along by one on
the next capture. The strip draws captures and generated frames as separate rows; both
inherit this order.

**A capture is paired with its cover-sized rendering by ordinal, and ordinal 0 is not part
of the pairing.** The still kept in `/data/captures` is at the source's own resolution; the
grid must never be handed that, so `Media.coverArtifactId` names a 640px `cover-n` written
beside it. Sharing the ordinal is what makes the pairing need no column -- capture _n_ is
rendered by `cover-n` -- and it is why captures are numbered from 1: `cover-0` is the
generator's own cover, permanently.

The reservation has to be enforced where the pairing is _read_, not only where captures are
written. Numbering new captures from 1 is a guard on one writer; a lookup of
`(mediaId, "cover", 0)` still answers with the generated cover for any capture that reached
ordinal 0 anyway, and that row is indistinguishable from a rendering at the point of use.
Both consequences were live and both were silent: choosing such a capture pointed the column
at the generated cover, which the reader correctly normalises back to "no choice" -- so the
button did nothing, reported nothing, and left nothing to find it by -- and deleting one
would have removed the generated cover's row and file, a `user` action destroying `auto`
output by mistaking it for user work, which is the single thing the `source` split exists to
prevent.

### Your captures, in one place

The strip answers "what stills exist of this item". `/captures` answers "what have I grabbed",
across the library, and it has its own nav entry beside Reels and Clips.

**It lists your own, although captures are library-wide to read.** The question is about you,
as it is on `/clips`. Everybody's captures stay on each item's strip, where the library-wide
rule above still holds. The list also respects the rest of the library's rules: roots this
account can reach (`accessibleRootIds`), and items that can be listed (`listable`). An item
in the trash takes its captures off the page until it is restored, and `/clips` does the same
with its clips.

**A capture can carry a caption.** It is `Artifact.label`, which existed from the start and
was never written. Whoever may discard a capture may caption it (`mayAlterOwnWork`), and the
caption is shown to everybody who can see the item, like the still. Search matches the
caption and the item's title. Writing a caption leaves `generatedAt` alone: that column is
the capture's `?v=` token and the page's "recently captured" order, and a caption changes
neither.

**The page has its own index, partial on `kind = 'capture'`.** Nothing indexed
`createdByUserId`, and `Artifact` holds five to ten rows an item, so every page and every
count would have scanned a million or more rows to find a few hundred stills. The index is
partial on `kind` rather than `source = 'user'`, so the captures' own `cover-n` renderings
stay out of it and the generator's output never enters it. Its second column is
`generatedAt DESC`, so the default sort walks the index in order.

**Discarding in bulk asks first, and removes rows before files.** The strip's single discard
is a deliberate press on a picture you are looking at. A selection is dozens gathered across
pages, so it is confirmed, with the pictures shown rather than a count. The service reports
per capture rather than refusing the batch, because a selection held across pages can go
stale in part.

Rows go first because a row without its file renders as a broken image, while a file without
its row is invisible and swept up later. The single discard used to do the opposite, beneath a
comment arguing for this order. Both now share one path.

**Opening the video at the moment** is the item page with `?at=` (§14b).

Deliberately not built:

- **An ownership toggle.** Somebody else's captures are browsable where they belong: on the
  item.
- **Choosing the cover from this page.** That is a decision about an item, made on the item.
- **Downloading a selection as an archive.** The lightbox serves the full-resolution still,
  one at a time.

### Choosing the cover frame

The cover is the first candidate that is not a black frame, sampled at 10% and falling back
through 30/50/70/90%. Two mechanisms, because either alone is insufficient:

- **ffmpeg's `thumbnail` filter** scores a batch of sixty frames against the batch average
  and picks the most representative, which is what makes it step over fades, hard cuts and
  title cards rather than taking whatever landed on the seek point. This is deliberately
  _not_ used for a user's capture: someone who paused on a frame means that frame.
- **An explicit luminance check** on the produced file, by decoding it back at 16x16
  greyscale and averaging 256 bytes. The obvious alternative — the `signalstats` filter over
  a `movie=` source — needs the input path escaped _inside_ a filter string, where a Windows
  drive letter's colon and every backslash are filter syntax; decoding one 640px WebP is
  cheaper than solving that.

If every candidate is dark, the video genuinely is dark and the first candidate still wins: a
dark cover beats none.

`-ss` goes **before** `-i` so ffmpeg seeks by container index instead of decoding from the
start. For a two-hour video that is the difference between milliseconds and minutes, and it
is the entire reason cover generation is affordable on a NAS.

Because artifacts are disposable and regenerable (§13), `/data/art` is explicitly excluded
from backups — losing it costs CPU, not data.

## 10. Duplicate management

- **Exact** — equal `contentHash`, grouped automatically.
- **Near-duplicate images** — 64-bit DCT pHash (in `packages/core`, pure and unit-testable).
  Candidates come from a band index, then exact Hamming distance confirms. Scales to 200k
  rows in SQLite.
- **Near-duplicate videos** — pHash over N sampled keyframes; a match needs a sufficient
  fraction of frames to pair within threshold. Catches re-encodes and resolution changes,
  but not a copy offset in time: frames are sampled at fixed fractions of each file's own
  length, so an offset moves every sample point, and in moving footage a few hundred
  milliseconds is already 12–30 bits.
- **Offset copies of similar length** — a second test over the sprite tiles, lined up over a
  small shift (§10h). **Clips cut from longer files are still not caught**; this section used
  to claim they were.
- **Review UI** — a triage sheet of compact rows with resolution/length/size/bitrate on each
  copy, a "keep best" preselection that is ordered first and states its reason, and a page
  resolved in one press (§10c). Admin-only.
- **Hashing runs ahead of previews and sprites.** The perceptual hash comes after the cover
  and the search index, because a duplicate has to be visible before anyone can judge it. It
  comes before the two expensive artifacts, which share its CPU budget (§7c). It used to trail
  them, so on a new library no near-duplicate appeared until every preview and sprite had
  been built, including those for the copies about to be deleted. Hashing first gives an admin
  the chance to prune the library before paying to process all of it.
- **Deletion is a recycle bin, in two stages** — trashing hides the item and moves its
  bytes to `/data/trash/<date>/`; purging, after a retention window, is the irreversible
  one. Only from a root flagged writable (§18.1).

### Limbo keeps the catalog entry, not only the file

§18.1 designed trash around restoring a **file**. That is not enough, because this is a
cataloger: most of an item's value is the catalog entry, not the bytes.

Hard-deleting `Media` at trash time would make restore mean "put the bytes back and let the
next scan find them". The file returns and the item does not — its tags, rating, favourite,
watch state, perceptual hash and processing records are gone, and it reappears under a new
id as something the library has never seen. An undo that silently discards everything a
person recorded about an item is not an undo.

So the `Media` row survives trashing, and **purge is the hard delete**.

**This costs one CHECK constraint.** `Media.listable` is already the single gate on every
library query, and it is derived by trigger from `MediaFile.state = 'active'`. Adding
`'trashed'` to that state therefore removes an item from the grid, facets, counts, search and
shuffle through machinery that already exists — no query changes anywhere, because the
existing triggers recompute `listable` to NULL the moment the state changes.

**This is a soft delete, which §4 forbids, and the exception is deliberate.** That rule
exists to prevent soft-delete rot, where every query in the system grows a
`WHERE deleted IS NULL` that someone will eventually forget. No such clause appears here:
`listable` absorbed it before this feature existed. The exception is bounded — an item is in
limbo for a retention window, not indefinitely — and it is recorded rather than assumed.

### The four states, and what is irreversible

1. **Trash** — checks the `delete` scope, a writable root, and free space on `/data`.
   Sets `MediaFile.state = 'trashed'`, writes `TrashEntry` with `purgeAfter`, and the item
   leaves the library at once. A `trash` job then copies the bytes to `/data/trash/<date>/`,
   fsyncs, and unlinks the original — copy rather than rename because `/data` and `/media`
   are different volumes (§18.1), and a job rather than a request because a 10 GB file is
   not a round trip. **The exception is an identical copy** (§10e): when a file with the same
   `contentHash` stays, it bypasses the bin — the job deletes the original and purges the item.
2. **Limbo** — visible only in the admin trash view. **Artifacts are kept deliberately**: a
   trash view without covers cannot be reviewed, only guessed at.
3. **Restore** — bytes copied back, state returns to `'active'`, `restoredAt` set. The item
   returns with its id and everything attached to it intact.
4. **Purge** — after the window or on admin demand. Bytes unlinked, artifacts removed,
   `Media` hard-deleted. `TrashEntry.mediaId` is `ON DELETE SET NULL`, so the audit row
   outlives the item it describes — which is the point of an audit row, and is why the column
   was made nullable before anything used it.

    Artifact files are resolved against `dataDir`, because `relPath` already names its tree
    (`art/…` or `captures/…`), and they are checked against both roots before the unlink.
    They were once resolved against `art`, which unlinked `art/art/…`. The swallowed error hid
    the miss, so every purge leaked the item's files, captures included, until the orphan
    sweep found them. This is the §13d two-path-spaces bug again, in the one place that sweep
    was meant to be a backstop rather than the mechanism.

**Retention defaults to 7 days**, as `trash.retentionDays`, admin-editable at runtime like
every other operational knob (§12b).

**The trash page can also be emptied at once.** "Empty trash…" queues a purge for every entry,
the same job the sweep and the per-entry button use, behind one confirmation that states the
count, the space and that nothing comes back, with Cancel focused. It skips entries whose move has
not happened yet: purging one of those would delete the catalogue row and leave the original in
the media root, where the next scan would adopt it as something new. It says how many it left, and
emptying again once they have landed takes them.

### Two locks on the irreversible door

A file can come back without the app's help — someone puts it where it was with a file
manager — and the scan then revives its row. The entry left open keeps counting down, and the
purge at the end of it destroys an item the library is, by that point, happily showing.

So it is closed twice. The scan path resolves the entry at the moment it revives the file, and
the purge job refuses outright to act on a file whose state is no longer `trashed`. The second
check is redundant whenever the first one worked, and it is there because this is the only
step in the app that cannot be undone.

**Not yet gone is not back.** Between the delete and its `trash` job, the original is still at
its path, and a scan walking past it used to take that for a file put back by hand: the row
revived, the entry closed, and the move job, finding a restored entry, did nothing. The deletion
was undone without anyone asking — after §10c had already merged its ratings and tags away. A
pending scan outranks the move in the queue, so this was the ordinary case, not a corner.

So a trashed row is revived only when its bytes are provably back. An entry without `movedAt`
says no, unless the bytes at the path are no longer the ones catalogued; that is the case the
move job refuses to touch, and its "rescan and try again" relies on the revival. An entry with
`movedAt` still looks at the path again inside the batch's transaction, because the scan's own
`stat` can predate the move's unlink. The worker is single-threaded and `movedAt` is written
only after the unlink completes, so that second look cannot be stale.

### Trashing stops the item's work

Trashing an item also removes its pending jobs and cancels its running ones, in the same
transaction that hides it. Otherwise that work either ran against an item in the bin or failed
on the missing file after the move. A transcode could run for an hour on a deleted file, and
each failed attempt counted against the item's stages, so a restored item came back marked as
unprocessable.

Pending rows are deleted rather than cancelled, because `cancelled` is not neutral:
`settledMediaIds` reads it as a decision not to transcode, and that would outlive a restore. A
running job has to be cancelled, because that is how its runner learns to stop (§18.7). Restoring,
whether by the app or by a scan, then forgets the failed stages and the failed or cancelled jobs
recorded since the delete. They describe a file that was out of its library, not the one coming
back. Anything settled before the delete is kept.

### A move that is owed is a move that is found again

Trashing hides the item first and moves the bytes second, so a lost move leaves a file sitting
in a media root that the app believes it emptied — invisible in the library, present on disk,
reported to nobody. `TrashEntry.movedAt` is what makes that state visible: an open entry
without it is work still owed, and housekeeping re-queues it.

This is not only for crashes. The job queue permits one live job per (kind, file), so a file
trashed, restored and trashed again while the first move is still queued has its second move
refused — quietly, because a refused enqueue must never turn a delete request into an error.
The sweep is what makes that safe rather than silent.

### What this has to get right

- **The scanner must not overwrite `'trashed'`.** A trashed file is genuinely gone from its
  root, so the next scan will want to call it `'missing'`. If it does, the library loses the
  difference between "someone deleted this" and "the share was unplugged" — and any future
  reaper of missing files becomes an unannounced purge of things people meant to keep.
- **Restore can find its old path occupied** by a different file. Needs a decided policy, not
  whatever the copy happens to do.
- **Trashing a duplicate must drop it from its group**, or review offers deletions of files
  that are already deleted.
- **Trashed bytes sit on `/data`**, beside the database. A retention window is a disk
  commitment, which is the argument for 7 days rather than 30 on a NAS.

### The band index guarantees D < B, not D < bits-per-band

**This section previously specified four 16-bit bands and claimed recall to Hamming 8. That
was wrong**, and wrong in the way that never reports an error: the review queue would simply
have been emptier than the library deserved.

Candidate lookup is an equality match on a band. The guarantee is pigeonhole — if two hashes
differ in at most D bits and the hash is cut into B bands, then at least one band is free of
differing bits precisely when **D < B**. The bits _per_ band do not enter into it. Four bands
therefore guarantee only distance 3; at distance 8 about 70% of genuine near-duplicate pairs
share no band at all and would never be compared.

The schema uses **eight 8-bit bands**, guaranteeing distance 7 — enough for ordinary
re-encodes and rescales. The cost is selectivity: 256 buckets per band rather than 65536, so
a lookup returns a few hundred rows rather than a handful. That is the right trade, because a
candidate costs one XOR and a popcount while a missed duplicate is kept forever. The
threshold setting is clamped to this ceiling, since a larger number would not widen the net —
it would only make results depend on which pairs happened to share a band.

**One shared band is necessary, not selective.** A video brings twelve frames, so a lookup is
96 one-byte equalities, and on the live library that reached ~98% of all videos. The lookup
then had an unordered `LIMIT 200`, so it compared an arbitrary 2.5% of the library and missed
a 720p/1080p pair whose frames matched 9 of 12. The same pigeonhole gives a stronger condition
for free: hashes at most D apart differ in at most D bands, so they **share at least B − D**.
Both lookups now require that many shared bands per frame (and, for videos, that
`minMatchingFrames` distinct seed frames reach the candidate), which is still exact — nothing
that would pass `compareVideos` is excluded — and they have no limit, because a limit on a
candidate set is a decision about which duplicates to miss.

### ffmpeg rather than sharp

The decoder is ffmpeg, not sharp as this section first said. sharp is a large native
dependency and the app already ships ffmpeg, so adding it would mean two image stacks in a
container that has to build for the NAS; ffmpeg reads stills and video frames through one
call, so images and videos need no separate code paths; and it handles what a real library
actually contains — HEIC, odd TIFFs, animated WebP — without a second decoder behind a
feature check.

Frames are scaled _then_ converted to gray, deliberately. The other order discards the colour
that should have contributed to each averaged pixel, which makes the result depend on the
source resolution — and two copies of one picture at different resolutions hashing
differently defeats the entire feature.

### Blank frames are skipped, measured from the transform

A flat frame — a fade to black, a letterbox bar — has AC coefficients that are zero in
theory and floating-point dust in practice. The median then sits in that dust and roughly
half the bits land above it _by rounding_, so the hash is unstable noise: two identical black
frames hash differently and unrelated ones occasionally collide. Flatness is therefore
measured from the DCT's peak AC amplitude, not from the finished hash — a bit-balance test
on the hash looks like it would catch blank frames and catches none of them, because the
noise is balanced.

### Two identity hashes, and why the expensive one is lazy

`quickHash` is size plus the first and last mebibyte — three seeks regardless of file size.
`contentHash` is the whole file, and the only thing that _proves_ two files identical.

Hashing everything in full is not affordable: a 4 TB library over SMB would take days and
saturate the share the app serves from. So every file gets a quick hash, and a full read
happens **only where a quick hash collides**, on both sides of the collision, and only for a
side that has no content hash yet. A library with no duplicates never reads a whole file, and a
file is read in full once however many copies of it arrive later. Size is mixed into the quick hash because a truncated
download is a byte-for-byte prefix of its original — without it, an interrupted copy would
look identical to the complete file, and the app would offer to delete the good one.

### Clustering treats similarity as transitive

Groups are built by union-find over confirmed pairs, so A–B and B–C put all three in one
group even when A and C are further apart. The alternative — requiring every member to match
every other — splits an obvious family of re-encodes into overlapping pairs, and the reviewer
then sees the same file in three groups and has to reason about which deletion affects which.
One slightly loose group is one decision. The cost is chaining, so `maxDistance` is reported
and shown, and the thresholds are tight enough that chains stay short. Where a chain joins
things that are not the same, a person can sort it apart, and clustering keeps to that (§10i).

Groups are identified by their sorted member list. Without that key a re-run would create a
fresh group for the same files every pass and the queue would fill with duplicates of
duplicates; with it, a reviewed group stays reviewed while its membership is unchanged, and a
group that _gained_ a member is correctly treated as new.

Video frame pairing is greedy but **one-to-one**. Without that, a locked-off shot — many
near-identical frames — matches any other video containing one similar frame, because that
frame pairs with every frame on the other side and the ratio reaches 100% on the strength of
a single coincidence.

## 10b. Clustering is incremental, and groups are disjoint

§10 describes what a duplicate group is. This is how the library gets one without comparing
itself against itself for ever.

### Seeds, not everything

The pass used to compare the whole library against the whole library on every run. That is
linear in library size for a handful of newly hashed rows — ten seconds at 4,277 items, and
the library is expected to reach 200k.

Comparison is symmetric, so an item compared against the library when it arrived never needs
comparing again: a pair between two old items was found when the later of the two was the
seed. So the pass now seeds only with items that have never been compared, and their
_candidates_ still come from the whole library — incremental, not partial.

**"The later of the two" only holds if a mark means the item was compared with what it has
now.** An item seeds on a content hash alone, and the perceptual hash comes after the cover
and the search index (§10), so an item can be marked before its frames exist. If its copy was
marked before that too, neither is ever the later seed, and the pair is never compared: on the
live library 690 videos had frames newer than their mark, among them a re-encode pair matching
9 frames of 12. So **writing an item's perceptual hash, or a new content hash, forgets its
mark**, inside the same transaction as the write, and the item seeds again with what it has.

`DupeClustered` records which items have been through it. A row per item rather than a
"clustered through T" watermark, because these timestamps have one-second granularity while a
bulk import writes hundreds of rows a second, and a watermark silently drops whatever shares
its second. Marking the items has no such window, and a pass that dies half way simply leaves
the rest unmarked for the next one — marks are written only after the pass succeeds.

A pass is bounded at 500 seeds and **re-queues itself immediately while a full batch keeps
coming back**. The two-minute settle window (§7e) is right for a trickle and wrong for a
backlog: at 500 seeds a pass, an import of 200k items would take days if every pass waited.

Changing a threshold clears every mark, because the thresholds decide which pairs count at
all — otherwise lowering `imageDistance` would apply only to items hashed afterwards, and the
setting would appear to do nothing to the library it was changed for. Only the marks are
cleared; `upsertGroup` returns the identical group rather than replacing it, so anything that
still clusters the same way keeps its id and its review state. A change to how candidates
are found does the same — the fingerprint the marks are checked against carries a recipe
number alongside the thresholds, bumped when a pass can find pairs an earlier one could not.

### Merging is what makes it correct

Cheapness is the easy half. Clustering is transitive (§10), so an item linking two items that
were in separate groups **must merge those groups** — a pass that considered only its own new
pairs would write a third group overlapping both.

So every group the new pairs touch is pulled back in and re-clustered alongside them, as a
star of edges from each group's first member rather than a clique: `n-1` edges instead of
`n(n-1)/2`, and union-find only needs connectivity. Whatever comes out is upserted, and any
group that was absorbed rather than reproduced exactly is deleted.

**That deletion is the bug that prompted all of this.** A group is identified by its member
set, so a cluster that gains a member is correctly a _different_ group — and nothing removed
the smaller one it grew out of. On the live library one item sat in ten overlapping
near-duplicate groups of 2, 3, 4, 5, 6, 7, 8 and 9 members, each written as the previous one
grew. A reviewer scrolling the page met the same file ten times and reasonably concluded it
was being reported as a duplicate of itself.

### Two invariants, enforced against the table

The merge deletes what it absorbs, so in ordinary running the sweeps below find nothing. They
run anyway, because what they catch is silent and a reviewer's only symptom is a queue full of
the same files:

- **No group contains another.** `pruneSubsumed` removes a group whose members are all in a
  larger same-kind group, with equal sets broken by id so the choice is deterministic.
- **Same-kind groups are disjoint.** `mergeOverlapping` folds together any two groups of one
  kind that share a member — if an item is in both then it links them, so they were always one
  group. `pruneSubsumed` cannot catch this and should not: the live library held two
  nine-member groups sharing eight members and differing by one, and neither contained the
  other. Iterative to a fixed point, because each merge can create a new overlap, and bounded
  so a bug here cannot become an unbreakable loop inside a job.

A merged survivor loses `reviewed` when it actually gains members. A group somebody approved
is not the group they looked at once it has grown.

Kinds never merge into each other. An exact group and a near group over the same files answer
different questions (§10), and 251 items on the live library are legitimately in one of each.

### Belt and braces further down

Two more guards, both cheap, both preventing a group that shows a file against itself:

- `clusterPairs` drops a link from an item to itself, at the single point every pair passes
  through rather than at each of the four places pairs are built. A self-pair would otherwise
  produce a cluster of one.
- `upsertGroup` collapses a repeated member and refuses anything that is not two distinct
  items. `UNIQUE (groupId, mediaId)` would otherwise turn a repeat into a thrown constraint
  that fails the whole job, and a group listing the same file twice is exactly what the review
  screen must never show — worth being unable to express rather than merely unlikely.

The band-index lookups already exclude the item itself, which is where a self-pair would most
naturally have come from.

## 10c. Eliminating a copy must not eliminate what people recorded about it

§10 settled that deleting a _file_ does not destroy the catalog entry. It left the other half
open, and the reasoning that closed the first half applies to it unchanged: most of an item's
value is what people recorded about it, so removing one copy of something must not remove one
person's rating of it.

Before this, it did. Trash a duplicate and its rating, favourite, watch history, private note,
tags and playlist places went into limbo with it and were destroyed at purge — silently,
because nothing about a successful deletion looks like a loss. The copy that was kept was the
one the reviewer thought worth keeping, and it was the one carrying nothing.

So **the surviving copy inherits**, on the way to the trash.

### Nobody is asked, and that is the design

Every conflict resolves by rule. The alternative — a dialogue offering "this copy's rating or
that one's" — fails on its own terms: it appears at the moment somebody is thinking about disk
space, about content they have already declared identical, and the answer it wants is one
nobody has. A question with no informative answer trains people to click through it, and the
click-through would be the thing deciding.

The rules are in `mergeOverlay` in `packages/core/src/merge.ts`, and each is chosen so that
**eliminating a copy can only ever add to what is left**:

| Field       | Rule                    | Why this one                                                                                                                                                                                                                                         |
| ----------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rating      | the higher              | Copies of the same content; a tidy-up must not lower the library's opinion of what remains. "Most recently edited" cannot be implemented honestly — `updatedAt` is per row and cannot say _which_ field was edited.                                  |
| Favourite   | either                  | There is no reading under which deleting a copy means you like it less.                                                                                                                                                                              |
| Hidden      | **not inherited**       | The one field that does not flow. Hiding is a statement about a row in your grid, and the commonest reason to hide something is that it is a duplicate — inheriting it would make the copy you deliberately kept vanish at the moment you tidied up. |
| View count  | the higher, not the sum | The sum is truer and cannot be made safe to repeat: trash, restore, trash again would count the same views twice, and telling the second merge from the first would mean recording every merge the app has ever done.                                |
| Last viewed | the later               | The copy viewed more recently says when the content was last viewed.                                                                                                                                                                                 |
| Watched     | the earlier             | The column records when you _first_ finished with the item, which is what `markWatched` already promises by refusing to move it on a rewatch.                                                                                                        |
| Note        | both, survivor's first  | The only field here that cannot be given again in a second. Deduplicated by containment so a repeat merge does not stack the same paragraph up, and trimmed to the column's 2000 rather than dropping one side.                                      |

Every rule is **commutative and idempotent**. That is not tidiness: a group of three is two
deletions somebody may work through in either order, a trashed copy can be restored and
trashed again, and neither must change where the library ends up.

### Tags are copied, the playlist slot is moved

Tags travel in every scope — the library's and each viewer's private ones — because the merge
runs as an administrator over data they cannot see (§6), and a copy that carried only the
visible half would discard the rest on the way past. `batchId` travels too, so withdrawing a
bulk apply still reaches the row that apply is responsible for.

A playlist entry is **moved**, not copied, and it is the only thing here that is. A playlist is
an order somebody arranged, so the survivor takes the departing copy's slot rather than being
appended to the end of a list it was already partway through — and copying would leave both
copies in the list for the length of the retention window, so anyone playing it through would
watch the same thing twice.

Everything else is copied, which is what keeps restore honest: §10 promises an item returns
"with everything attached to it intact", and a merge that emptied it first would make that
sentence false.

### Who inherits

`preferredKeep` over the group's members that still have an active file — **the same function
that marks "Best copy" on the review screen**. An heir chosen by a second, unseen rule would
put the ratings on the copy the reviewer was just told to delete.

One heir, not every survivor. It makes a chain work: eliminate the heir later and its
inheritance, by then its own record, moves on again. A copy already in the bin is passed over —
it is on its way out and its window may close first.

### It runs at trash, not at purge

Waiting for the retention window would mean a rating disappearing at the delete and
reappearing a week later on a different item, which is indistinguishable from a bug. It also
runs _before_ the trash entry is written, so a failure leaves the library untouched rather than
an item deleted with its record stranded on it — the other order fails the wrong way, since
merging twice is harmless and deleting without merging is the loss this exists to prevent.

### Deliberately not merged

- **Captures and chosen covers.** A capture is a still of a particular file's frames. Near
  duplicates differ, and a still that no longer comes from the item it hangs on is a small lie
  the library would have no way to correct.
- **Saved filters.** They are queries, not statements about an item; they re-run and find the
  survivor on their own.
- **Clips and reels** (§14d). Timecodes are a claim about one file's timeline, and the copies in
  a near-duplicate group do not share one — a span moved onto a different encode would point at
  the wrong frames, which is a silent wrong answer rather than a visible loss. Since clips can
  now be destroyed by a purge, the delete confirmation says how many are on this copy and which
  reels it would shorten; §14d has the rest.

### The UI argues for the better copy, rather than presenting both neutrally

The ordering has been right since §10 and the review screen still lost to instinct, because a
grid of numbers with one badge on it is an assertion and **"keep the bigger file" is a
belief** — and size is the rule the ordering deliberately puts last, since an inefficiently
encoded 720p copy routinely outweighs an efficient 1080p one. So three things changed.

**The group is ordered.** Members arrive best-first from `rankCopies`, the same function
`preferredKeep` is now defined in terms of, so the order on screen and the copy marked "Best
copy" cannot disagree. Ordering is a recommendation that costs nothing to read: unordered, a
reviewer compares six numbers across four cards before learning what the app would have done.

**Every card carries the argument, not just the verdict.** The recommended copy says why it
won, measured against the _runner-up_ rather than against the field — with four copies on
screen, "highest resolution" is only useful if the next-best one is lower. Every other card
says what keeping it would cost, quantified where the number means something on its own:
"1280×720 — 44% of the pixels" ends an argument that "fewer pixels" would start, and the
quartering is the figure people underestimate most. A copy genuinely indistinguishable from the
best says nothing, because a card claiming a disadvantage that does not exist would undermine
every card that names a real one.

**The reason comes from the comparison itself.** `keepDimension` reads the dimension off the
same comparator that does the sorting, so there is no second implementation to drift — a card
saying "highest resolution" about a copy that won on bitrate is a recommendation nobody reads
again.

### What "best" means: the best-looking complete copy, not the most frames

The ordering in `rankCopies` is **completeness, then pixels, then bitrate, then size, then
age**. Saving disk is not a goal anywhere in it; size is a quality proxy of last resort ("more
data at the same resolution"), never a reason to prefer the smaller file.

It used to rank pixels first and then length for any gap over five seconds. Both halves were
wrong in a way the review screen could not show:

- **Seconds of length decided against quality.** At equal resolution a 12:08 copy at 3 Mbps
  beat a 12:00 copy at 8 Mbps. A few seconds is an intro card or a bumper far more often than
  content, so a length difference below a tenth of the longer copy now decides nothing and
  picture quality does.
- **Resolution decided against completeness.** Video matching measures against the shorter
  video (§10), so a sharp two-minute clip clusters with the 720p film it was cut from — and
  pixels first kept the clip and trashed the film. Now a copy missing more than a tenth of the
  longer one is a different cut (`isDifferentCut`), and the complete copy wins before resolution
  is consulted.

**Padding scales with the video.** `lengthTolerance` allows five seconds below ten minutes and
thirty from ten minutes up. A fixed five was too tight on a long video, where a studio card or a
few seconds of black at each end is ordinary, and the triage sheet flagged nearly every long
group for it.

The gap between padding and a different cut — more than the tolerance, less than a tenth — is
where the ranking could be wrong in either direction (an intro, or a truncated download). It
does not guess louder; it asks. A group whose recommended copy is shorter than another by more
than the tolerance carries a caution and starts unticked on the triage sheet, as does any group
holding a different cut.
The cautions read the same `isDifferentCut` and tolerance as the ranking, so "a different cut"
cannot mean one thing to the sort and another to the warning.

Bitrate is compared across codecs as it stands, which undersells an efficient encode (HEVC at
4 Mbps against H.264 at 8). Weighting by codec was considered and left out: the factors are
folklore rather than measurement, and a wrong constant is a silent wrong answer. Resolution
decides most groups before bitrate is reached.

### The queue can be worked through, not only read

The review screen first compared copies and could not act on the comparison: four navigations
and four confirmations to eliminate a group of four. Then it could resolve one group in one
action, which was still one confirmation per group — and with ~870 groups at ten a page, 87
pages and roughly 1,700 presses. A queue that size is read and abandoned, and an unworked
duplicate queue costs more than every mistake the ceremony was protecting against.

So the screen is a **triage sheet**, built for the glance that decides nearly every group:

- **Compact rows**, 25/50/100 a page. Each copy is a picture with one line of numbers under it
  (resolution, length, size, bitrate) and what keeping it would cost; the path and full title
  move to a tooltip because they almost never decide anything.
- **The picture is the control.** Pressing a copy makes it the keeper; each copy says on its
  picture what will happen to it (Keep, Trash, Read-only). A row whose keeper the reviewer moved
  says "Not the app's pick" where the reason used to be.
- **Identical rows start ticked** with the recommendation, and one button on a pinned bar — "Trash 73
  copies… · frees 184 GB" — sends the page. Look-alikes do not: they are decided one at a time
  (below). **Unless a glance could get the row wrong**: a group
  with a caution (a different cut, a recommended copy shorter than another, a copy with no
  picture — see above) or with clips on the copies that would go starts unticked, and says why
  on the row. Clips are drawn on the client because they depend on which copy is kept.
- **A kind filter**, with each kind's pending count on it. Identical files need no judgement,
  so filtering to them first clears the easy half of the queue fastest.
- **Videos, Photos or All**, over every tab, opening on Videos: the collection is mostly video and
  photos are the exception, so they wait behind the control rather than filling every page of
  decisions (decided 2026-10-09). A group never mixes the two, so whole groups are filtered; the tab
  counts, Identical's summary and its "delete every identical copy" all follow the control, so the
  button deletes what the line above it counted. The review nav's Duplicates count is of videos,
  matching what the page opens on.
- **Keyboard**: `j`/`k` between rows, a digit to choose the keeper, `y` for "these are the same"
  and on to the next, `n` for "none match" (§10i), `p` to play the copies, `o` to open the copy
  it would keep, `r` to mark reviewed, `x` to tick or untick, Shift+Enter to confirm. In the play
  drawer, digits switch copies and `y`/`n` decide the group there, closing the drawer and moving
  on, because watching is where a look-alike gets settled. Identical rows left unticked can be marked reviewed together, which is its own press
  rather than part of trashing because "unticked" can also mean "not decided yet".

### Look-alikes are decided one at a time

Ticking every row by default suited a matcher that found little beyond near-identical encodes.
Once look-alikes came from tile prints and offset copies too (§10h), "looks the same" stopped
being a safe default. A page of rows trashed in one press was a page of bets, and the cautions
could not catch every wrong one. So, decided 2026-10-18:

- **A look-alike never starts ticked, and nothing in bulk reaches it.** "Tick all" and "Mark
  reviewed" for the page apply to identical rows only. A look-alike is ticked by somebody
  saying its copies are the same: `y`, or **These are the same** on the row, which is the
  same press on a phone.
- **A decided row folds to one line**: the keeper's picture, "Keeping …", what goes and what it
  frees, and **Undo**. The page stays about the groups still to decide. Unticking it opens the
  row again.
- **Trashing still goes by the page.** The bar sends every decided row in one confirmation, as
  before. What changed is that every row in it was decided, not defaulted.
- **No batch button for the clear-cut ones.** One was considered — tick every group whose
  copies all match each other directly — and rejected. It is the same default under another
  name, and `y` per group is fast enough.

Moving on with `j` is the skip: an undecided row is simply left, and comes back on the next
visit.

**Decisions survive opening an item.** The sheet unmounts when an item opens, and Back used to
find every decision gone. They are kept for the tab in `sessionStorage` (`dupeChoices.ts`), per
user and per sheet, as the library keeps its selection (§14b), with the row the keyboard was on.
Retaining them was chosen over warning before leaving: a warning still costs the decisions when
the reviewer does leave, and leaving to check an item is the ordinary way of working. **Each
decision carries the copies it was made about**, and it is dropped if the group has changed
since. A tick restored onto a group that has gained a copy would trash that copy unseen. Page
changes keep them as well, by group, for coming back to the page.

**The request names the copies, not just the keeper.** `POST /api/dupes/resolve` takes, per
group, the keeper _and_ the copies the row showed going. Naming the keeper was always required —
the reviewer may disagree with the ranking, and "resolve this group" would delete whatever was
best when the request landed. Naming the doomed copies is new with the page: a clustering pass
can merge a copy into a group between the page loading and the press (§10b), and with fifty
rows loaded minutes earlier "everything but the keeper" would trash a copy nobody was shown. The
list is an allowlist; a newcomer is left alone, the group stays in the queue, and the report
says so. A group whose keeper has gone is refused outright, and one stale row refuses only
itself.

**Judging stays separate from deleting.** Marking a group reviewed touches no file, trashing has
its own confirmation, and the copies land in the bin under the ordinary retention window where
an administrator can restore them (§18.1). The confirmation leads with **totals and
exceptions** rather than a list of seventy paths nobody would read: how many copies, how much
they free, every group where the reviewer overrode the recommendation (in the server's own
cost-of-keeping words), every group ticked past a caution, and the clips purging would destroy.
The full list of paths is one press away inside it.

**The free-space check counts what the bin already owes.** Each copy is refused if `/data`
could not hold it — but free space only shrinks once a move lands, and moves are queued. Checked
against free space alone, two hundred 3 GB copies against 50 GB free would each pass and then
fill the volume holding the database. So the check subtracts `trashRepo.unmovedBytes()`, the
bytes of entries accepted and not yet moved. The library's own bulk delete had the same hole.

**Partial success is the expected outcome, and is reported per group.** Copies are trashed one
at a time, like every other multi-item deletion (§14b); a refusal is recorded against its copy
and named afterwards rather than ending the run.

**A group is marked reviewed only when nothing is left to decide**: no failures, and every copy
still there besides the keeper on a read-only root, which no decision could remove. One still
holding a deletable copy stays in the queue, because hiding it would take it off the only screen
that could finish the job. The report is rendered on the page rather than in the dialogue: the
resolved rows leave the sheet as soon as the caches refresh.

**The scopes are both, and neither implies the other.** The screen is admin-only for the reason
above; deleting needs `delete` (§18.1). An administrator without it sees the comparison with no
ticks, and the service checks that once rather than letting `trashMedia` refuse identically per
copy for a permission that was never going to apply to any of them.

### The warning belongs where the deletion happens

Deletion is offered on the item as well as from the review screen, and the item page said
nothing about the comparison. Removing the best copy of a group was exactly as quiet as removing
the worst.

`MediaDetail.duplicate` carries the standing — how many copies, whether this is the one to
keep, and one sentence of advice — so the confirmation can repeat the comparison at the moment
it matters. On the best copy the dialogue says so, names what would be left in its place, and
the button reads "Delete the best copy" in outline while Cancel takes the weight.

**It stays possible.** The reviewer may have a reason the numbers cannot see — a file the
scanner mis-probed, a copy with burnt-in subtitles they want gone — and a disabled button
would leave them no way to act on it. The default moves; the door does not lock.

**And the reassuring half is not optional.** Every other copy gets the same alert in brass
saying a better copy stays. A warning that only ever appeared would read as a general
discouragement from tidying up, which across a library this size costs more than the mistake
it prevents.

### What else the reviewer is told

The duplicates page says the merge in a line under the heading, because a merge nobody was told
about is indistinguishable from a loss, and both delete confirmations — the item's and the
group's — repeat it for the copies in hand, along with the clips that deliberately do not travel
(§14d). The trash response carries what actually moved, so the answer is in the API rather than
only in the database.

## 10d. Deleting an item offers its copies too

§10c's delete confirmation assumed tidying up: one copy goes, the best stays, and the dialog argues
for keeping the right one. That is how an administrator on the duplicates page deletes. In the
viewer, deleting usually means **"I do not want this"**, and anyone who does not want an item does
not want its copies either. Deleting it and leaving three copies behind lets the same thing keep
turning up in the library.

So the item's confirmation lists its other copies, one checkbox each, and trashes whichever are
ticked along with it.

### One checkbox per copy, and only identical copies start ticked

A single "and all its copies" switch was the simpler design and was rejected. A near-duplicate group
is not a set of copies in the ordinary sense. Video matching is measured against the _shorter_
video (§10), so a two-minute clip clusters with the two-hour film it was cut from. Clustering chains
pairs (§10b), so the two ends of a group may not look alike at all. One switch would treat the film
exactly like a byte-for-byte copy.

- **Identical copies start ticked** (same `contentHash`). Nothing about them could differ, so Delete
  then Enter takes them with the item.
- **An identical copy with clips on it starts unticked.** A triage row does the same (§10c): clips
  are the one thing that neither moves nor survives a purge.
- **Every other copy starts unticked** and carries the reason to look before ticking it. A copy
  that runs much longer _may hold more than this_; one much shorter _may be a part cut from it_;
  one with no cover has not been judged by eye. The length rule is `isDifferentCut`, the same one
  the ranking and the review screen use.
- **A copy on a read-only root is listed but cannot be ticked**, so the dialog never claims the
  group is gone while a copy stays behind (§18.1).

Each cover opens its copy in a new tab: looking properly at a copy must not close the question.

**The copies are fetched when the item loads, not when the dialog opens.** Because identical copies
start ticked, what Delete then Enter removes depends on this list. Fetched on open, a quick Enter
would trash the item alone and a slow one the item and its copies: the same two keys, two outcomes.
Only an item with copies asks, and only for a viewer allowed to delete it.

### Worst first, best last

Each trash hands the departing copy's ratings, tags and playlist places to the best copy still in
the library (§10c). The server trashes the ticked copies from worst to best, so that heir is the
best copy being deleted, right up until it goes itself. When the whole group goes, everything anyone
recorded ends up on the one copy worth restoring rather than scattered across the bin. When some copy
stays, it inherits exactly as it would from a single deletion.

The copies are named in the request rather than implied, for the reason `dupeResolveItem` names
them: a clustering pass can add a copy while the dialog is open. The server trashes only copies that
are named, are still copies of the item, and are in a library the viewer can see. It works through
them one at a time and records each refusal against its copy. If anything is refused, the dialog
stays open and lists what went and what did not; the viewer moves on once they have read it.

### What the dialog says

- **When no copy stays**, the best-copy warning disappears, since there is no copy left to keep. It
  says instead that what people recorded goes to the bin gathered on the best copy. "No copy stays"
  also counts copies in libraries the viewer cannot see, so it is never claimed while one remains
  somewhere else.
- **When the best copy would go and a worse one stays**, whether because the item is the best copy
  or because the best copy is ticked, the warning appears and focus moves to Cancel. This is the one
  mistake §10c exists to prevent.
- **Clips on the ticked copies** are added up beneath the item's own.

### Not admin-only, unlike the review screen

The duplicates page is admin-only partly because a group spans roots, and listing it would reveal
items in roots the viewer was never granted. The copies list answers that by showing only copies in
the viewer's own roots. The ranking still reads every copy, so "Best copy" means what it means on
the item's detail. The duplicates page itself is unchanged and always keeps one copy: it exists for
tidying up, and the "I do not want this" decision is made in the viewer.

### After the delete

The viewer steps on as before, but past anything that went with the item. Copies tend to sit side by
side in a set (same name, same date), so the next item is often a copy that was just trashed.

## 10e. Identical copies: decided by a rule, and deleted outright

Byte-identical files leave nothing to judge. `contentHash` is SHA-1 over the whole file, computed
only after a cheaper hash (size plus the first and last mebibyte) has already collided (§5). SHA-1's
weaknesses matter only against deliberately forged files, not a personal library. The scanner
clears both hashes when a file's size or mtime changes, so a stored hash describes the file as it
was last seen. Reviewing identical groups a page at a time, seventeen pages of them, was a chore
with no decisions in it. Two changes follow from that.

### An identical copy bypasses the bin

The bin exists so a deletion can be undone. A copy whose exact bytes survive in another file in the
library has nothing to undo: the content is still there, and so is everything recorded about it,
merged onto the copy that stays (§10c). Holding it for the retention window only cost space. A few
hundred identical videos is hundreds of GB on the volume that holds the database, and the
free-space check would refuse partway through a bulk run. So deleting an identical copy deletes it,
with no trash and no restore.

It still runs through the trash machinery, because that is where everything a deletion needs
already lives: the merge, hiding the item at once, stopping its work, and the move job that is the
only code allowed to write inside a media root. `TrashEntry.twinFileId` names an active file with
the same `contentHash`, preferring the file of the copy that inherits the merge. An entry with a
twin is not the bin's:

- **The trash job deletes the original and purges the item in one go.** It does so only once the
  twin provably still holds the bytes. The twin's size and mtime must still match the catalogue,
  which is what keeps its hash true between scans, and the original must pass the same check, as
  every trash already did. A twin that is itself in the bin with its own bytes also counts, which
  is the whole-group case below. Purging takes the item, its file row, its artifacts and every job
  it still has; the entry stays only as the audit row.
- **If the twin cannot vouch for the bytes** (changed on disk, gone), deleting outright could lose
  the content. The entry clears its twin and is copied into the bin as an ordinary, restorable
  entry. That is the one way an identical copy ever reaches the trash page.
- **It is never listed, counted, emptied or restorable.** The trash list, its count, the scheduled
  purge, "Empty trash", `heldBytes` and `unmovedBytes` all leave twin entries out. The restore and
  purge endpoints refuse them.

**Deleting a whole group of identical copies keeps one in the bin.** The viewer deletes ticked
copies worst first and best last (§10d), and each prefers the merge's heir as its twin, which is
the best copy still waiting its turn. Every copy but the last therefore goes outright, and the last
has no identical file left, so it is trashed with its own bytes. The content stays restorable
until that entry is purged, and the confirmation says so.

### Work for an item that has gone

Trashing already deletes an item's queued jobs and cancels its running ones (`stopWorkFor`), and
purging deletes the item, which takes every `Job` row it has: the table cascades from both
`Media` and `MediaFile`. A handler still running when its row goes finds out at the next
heartbeat and stops as a lost claim, not a failure.

That left one gap: **a job that reaches its handler after the item has left**. Examples are a job
enqueued by a scan or a finished stage between the trash and the move, or one claimed in the
instant before the cancel. It then failed on the missing file and counted as a failure: retried
with backoff, dead-lettered, and recorded as a failed stage of an item in the bin. The runner now
asks `subjectGone` before starting a job, after it finishes, and when it fails. If the item has
been deleted, or its original is in the bin, the job is closed as `cancelled` with a line in the
log, and nothing is recorded against the item. The three bin jobs are exempt, since a trashed
subject is exactly what they act on. A restored item loses nothing by this: the backfill offers it
every stage it is missing.

### When a duplicate comes back

Someone can obtain the same file again, and the app has to treat it as a duplicate to decide about,
not as something already settled:

- **Deleted outright, then obtained again.** The old item was purged along with its group
  membership, so the file arrives as a new item. Clustering finds it and the result is a group
  nobody has reviewed. A group that gains a member is a different group, and merging overlapping
  groups drops the "reviewed" mark. No special handling is needed.
- **Trashed, then obtained again at its old path.** The scan revives the old row and closes its
  entry (§10). The copy rejoins its old group, which is usually marked reviewed from when it was
  resolved. The member list has not changed, so clustering cannot help: the group it would build
  is a subset of this one and is pruned. So bringing a copy back, by the scan or by an
  administrator's restore, reopens every group it belongs to (`reopenGroupsOf`). "Reviewed" was a
  decision about the copies the group had then, and it no longer describes them.

The copy left in the bin by the second case is a spare of bytes the library has again. The orphan
sweep used to protect any trash file an entry named, closed or not, so those spares stayed on
`/data` for good. It now protects only open entries' files.

The review page's counts follow the same definition of a group as its lists. A group needs two
copies still in the library, and one whose copies have mostly gone is neither counted nor shown.
It had been counted and not shown, which put "Reviewed · 1" over an empty tab.

### "Delete every identical copy", across the whole queue

The Identical tab opens with the whole queue in one line ("1,204 identical copies to clear · 843
groups · frees 412 GB") and one button. The rule is stated where it is applied:

- **Which copy stays: a copy on a read-only library if there is one, else the one catalogued
  first** (`identicalKeeper`). The quality ranking cannot separate identical files and falls
  through to age. It used to preselect a writable keeper beside a read-only copy, which removed
  nothing, so such groups sat in the queue indefinitely. The review sheet's default keeper for
  identical groups now follows the same rule.
- **Which groups it will not decide** (`planIdentical`) are shown as the ordinary review sheet under
  "Needs a look":
    - groups whose copies are no longer all provably the same bytes (a hash cleared or changed since
      the group was stored);
    - groups where a copy that would go has clips on it, which neither move nor survive a purge
      (§10c).

    Groups where nothing could be removed are left out of both lists.

- **The rest are cards, one picture each**, since the copies are the same picture. They are biggest
  first, each saying what it frees and which path stays. "Keep all" on a card marks it reviewed,
  which takes it out of the run.

The run is batches of 50 groups. The page keeps asking until the server says it has reached the
end, and shows progress; "Stop after this batch" is honoured between requests. The server plans
each batch afresh from one query over the queue (`pendingIdenticalCopies`), so a group edited,
given clips or kept since the page loaded is judged as it is when its turn comes. Each group goes
through `resolveOne`, exactly as a hand-resolved row would: it re-reads the group, removes only
the named copies, and marks the group reviewed once nothing is left to decide. Groups are taken in
id order from a cursor, so a group that refused is tried once per run rather than retried by every
batch after it. Failures are reported by reason and count, and their groups stay in the queue.

**A busy database is waited out, not reported.** The first bulk run on a real library lost 23 of
748 copies to "database is locked". The worker was purging as fast as the web process trashed,
and the web process gives up on the lock after three seconds (§4). The trash path's write
transactions are now `immediate`, so they take the lock at `BEGIN`, where the timeout applies,
instead of upgrading from a read midway, where SQLite refuses outright if the other process has
committed in between. The trash entry and its move job are also written in one transaction. If
the lock is still busy, the step is tried again after an `await`ed backoff, which leaves the rest
of the web process running. Every step it retries is safe to repeat.

### The page, reorganised

The All / Identical / Looks-the-same filter, the page-size picker and the "Show reviewed" switch
were one sheet serving three different visits. They are now three tabs:

- **Identical**, as above.
- **Look alike**, the triage sheet as it was, for near duplicates, where comparing copies is the
  whole point.
- **Reviewed**, the groups somebody chose to keep as they are, for reopening.

"All" is gone because it mixed two different kinds of decision on one page. The page size is fixed
at 50, because the reason to pick 100 was getting through identical groups faster. "Show reviewed"
became a tab because it mixed decided groups into the queue of undecided ones.

## 10f. An identical copy borrows its twin's work

Finding a duplicate used to change nothing about what the pipeline did. An exact copy was
probed, covered, fingerprinted, previewed, sprited and transcoded in full, and then — being an
exact copy — usually deleted (§10e). Identical bytes render identically, so all of that was
work the library already had.

### The hash goes first

The scanner queues `filehash` rather than `probe`, and the hash queues the probe when it is
done. A quick hash is three seeks, cheaper than ffprobe, and it is I/O rather than a core, so
leading with it delays nothing that holds one (§7c). Where it collides, both files are read in
full before the probe — which is a wait only for files that are almost certainly duplicates,
exactly where waiting buys something. The registry puts `filehash` below every other stage, so
the sweep agrees with the chain (§7d).

The probe is a promise the hash keeps whether or not hashing succeeds: an unreadable file still
deserves a probe, and an unprobed item reads as a broken import. It is kept **once**. The payload
records the item's `probedAt` when the scanner made the promise, and a retry that finds it
changed knows an earlier attempt's probe has already run. Probing twice is not harmless — the
probe chains the cover, and the cover chains the preview and sprite. When the scanner's insert
collides with a hash the sweep already queued, which carries no promise, the scanner queues the
probe itself.

### What is borrowed

Before rendering, `cover`, `preview`, `sprite`, `phash`, `ocr` and `transcode` look for another
item whose original has the same `contentHash` and is still in the library, and take what it
has:

- **A twin counts only if its stage is settled at the current version**, by `needsWork` — the
  rule the sweep uses — so an old recipe is not copied into a new item only to be redone. An
  `empty` outcome carries over: a clip too short for a preview is too short in every copy. A
  failure does not; it may have been the twin's bad luck.
- **Only generated output.** The cover and its posters, never a twin's captures or its chosen
  cover. Those are decisions about that item.
- **Covers, previews and sprite sheets are copied, not linked.** ffmpeg writes them straight into
  their final path, truncating the inode, so a later regeneration of one item would rewrite its
  twin's file through a link while it was being served. They are small. **The transcode is
  hardlinked**: it lands by rename and is removed by unlink, neither of which reaches the other
  name, and it runs to gigabytes.
- **The sprite VTT is rebuilt, not copied.** Its cues name sheets by URL, and the URL carries the
  item's id and a version token; a copied VTT would point at the twin's sheets, which disappear
  with the twin. It is borrowed only when the twin's sheets were cut to the layout this item
  would get.
- **Probe and search index are not borrowed.** The probe is cheap and establishes the item's own
  facts; the search document includes its own path and title.

Anything that fails on the way — a twin whose `art` was cleared to reclaim space (§13), a file
that cannot be copied — falls back to rendering. A borrowed artifact is an optimisation and must
never be the reason an item has none.

### What it does not do

Two new copies of the same file in one scan race: both may render a cover or a fingerprint at
once, since those run two at a time. Previews, sprites and transcodes run one at a time and long
after both covers, so by then one copy has finished and the other borrows — and those are where
nearly all the cost is. Holding the second copy until the first is
done would serialise a first import on its duplicates, which is the wrong trade for a saving
this size.

The contentHash is only ever computed where a quick hash collided (§10), so this costs nothing
in a library with no duplicates.

## 10g. Files that cannot be read

A file the probe cannot open — nearly always a download that never finished, an MP4 whose index
was never written — has no cover, no duration and no preview. It cannot be watched, and it
still takes its full size on the media volume. The first production review found ten of them in
13k items, all from one downloader, several of them exact multiples of a MiB.

**"Cannot be read" is a settled probe failure** (§7b): the probe stage at its current version,
failed, out of attempts — whether it used them all or failed with a container error that settles
at once (`isUnreadableSource`). Nothing else is listed. A failure still below its attempt limit
is about to be tried again, and a failure at an older version is about to be redone by the sweep.

**Review › Unreadable**, beside OCR and built the same way: admin only, a
plate, two tabs, lists that load by cursor, ticks and a sticky action bar. Largest first, because
the list exists to give space back. Each row has no picture to show — that is the point — so it
carries the file name, its library and folder, its size, and what ffprobe said: the line that
names the damage, not the command line or the closing summary.

**Two lists, because reclaiming the space is two steps.** Moving a file to the trash copies it to
`/data` and removes it from the media root, so the media volume gets its space back at once and
`/data` holds it until the entry is purged. "In the library" moves ticked files to the trash
through the ordinary bulk action, so it needs the `delete` permission and a writable library and
gets the free-space check and per-item reasons every deletion gets. The trash's **Unreadable
only** filter purges the ticked ones now rather than when the bin's window closes. Only
unreadable entries are listed there, so the rest of the bin keeps its retention window — this is
not a second "empty trash". It was a second tab on this page, a copy of the trash reached from
elsewhere; it is now the bin narrowed, and the page links to it with a count.

_Rejected: skipping the bin, as an identical copy does (§10e)._ A twin's bytes provably survive
elsewhere. Here the evidence is error text, and §7 records a match that settled
damaged-but-decodable files as unreadable; a truncated download can also sometimes be repaired.
The bin is the safety net, and the filter makes using it one more click rather than a week.

**On a NAS where `/data` and `/media` are one volume, the trash frees nothing until the purge.**
The two-step account above assumes two volumes, which is the documented layout and not the one
the production NAS has: a single volume holds both. There, moving a file to the trash copies it
onto the same disks and then removes the original, so for the length of the copy it takes twice
its size, and afterwards exactly what it took before. The space comes back at the purge, which
is why the **Unreadable only** purge matters more there than the bin's window suggests -- and
why a large unreadable file needs its own size free to be trashed at all (the free-space check
every deletion gets refuses it otherwise). Not changed in the app: skipping the bin was rejected
above for reasons that do not depend on the volume layout.

**Processing › Activity does not list these files' failures** (§12c). It counts them, with what
they hold, and links here.

**A row that cannot be acted on has no tick**: a read-only library in the library list, an entry
still being copied in on the second. A purge of an entry whose move has not finished is refused
— its original is still in the media root, and purging would delete the catalogue row and leave
the file for the next scan to adopt as something new. Emptying the bin always had that guard;
purging one entry from the Trash page did not, and has it now.

**A failure that does not name damage is not called corrupt.** A probe that ran out of attempts
on timeouts during a first import, or on a share that dropped, says nothing about the file. Those
rows carry "May be temporary" and a "Read again" control that asks for the probe; a file that
reads leaves the list on its next load. That is what fixed the one good file the first review
found here.

## 10h. Offset copies: lined up by their sprite tiles

**Built 2026-10-17**, after a user noticed two videos whose preview frames looked identical and
which the duplicate review had never paired. One was the other with 1.5 s more lead-in. The
perceptual hash compared frame 7 of one with a moment 0.8 s away in the other and found 24 bits
between them; re-hashed 1.5 s later the same frame was 0 bits away. No threshold fixes that.

### Why the sprite tiles

The sprite sheet is cut on a whole-second grid from zero (§9), so two copies of similar length
get the same interval, and an offset is a _constant_ shift of the tiles rather than one that
drifts across the video as the hash's proportional samples do. The tiles also mostly land on
the scene-cut keyframes both encodes share, because the keyframe path takes the last keyframe
before each point. So the sequences line up over a shift of a tile or so — and they are already
on `/data`, so reading them costs no decode of an original.

### What is compared

Measured on the live library on 2026-10-17, against 52 pairs the fixed hash pipeline confirms,
474 random pairs of similar length, and 297 look-alikes (similar length and CLIP representatives
≥ 0.97: same setting, same lighting, different video). Each candidate signal was scored as the
fraction of the shorter video's non-flat tiles that matched at the best shift:

| per-tile signal                           | weakest true pair | worst random | worst look-alike |
| ----------------------------------------- | ----------------- | ------------ | ---------------- |
| **4×4 RGB grid, correlation ≥ 0.85, ±1**  | **0.46**          | **0.19**     | **0.07**         |
| colour histogram, intersection ≥ 0.80, ±1 | 0.60              | 0.38         | 0.38             |
| CLIP cosine ≥ 0.95, ±1                    | 0.72              | 0.05         | 0.12             |
| 64-bit pHash of the tile ≤ 12, ±1         | 0.07              | 0.01         | 0.01             |
| mean-luma time series correlation         | 0.50              | 0.95         | 0.99             |

The 4×4 colour grid is coarse enough to survive the shift and specific enough that nothing
negative came near: the threshold is a 0.30 score, between 0.19 and 0.46. The tile pHash is the
opposite failure — too fine to survive the jitter of a tile snapping to a different keyframe in
each encode. CLIP separates well but is no better, costs a model, and is opt-in; as a _gate_ it
is useless (millions of pairs pass a representative threshold). A tile matches if any of the
three partners around its moment correlates, and shifts of −1, 0 and +1 are tried.

### Which pairs are compared

Every pair of videos whose lengths are within 1%, or 2 s for a short video. All 52 hash-confirmed
pairs were within 0.96%, and it is the only gate that does not depend on one sampled frame
lining up by luck: the offset pair above passed a "one hash frame within distance" gate only
because its first sample is a static opener. On 8k videos it is ~214k pairs, which sounds like
a lot and is not: a pair is a few hundred dot products, and a full pass is seconds. What costs
is reading each video's prints, once per pass.

It runs as the second leg of the clustering pass, on the seeds' pairs the hash did not confirm,
and a confirmed pair joins the near-duplicate group like any other — at the frame threshold as
its distance, since the tiles say the videos are the same and not how many bits apart.

### The stage

`tileprint`, automatic, behind `sprite` which it requires. ffmpeg shrinks each sheet so every
tile becomes exactly 32×32, the print is the tile averaged into 4×4 cells of RGB, and a tile
whose luma deviates by less than 6 is flat and recorded as such — a fade matches every other
fade. One small file per video under `tileprints/` (~4 KB), not a BLOB. Writing it forgets the
item's clustering mark (§10b), so a video printed after it was compared is compared again.

The first pass over 8k videos was measured at about a third of a second each on the NAS, from
/data alone. When it was built, about 115 offset pairs were waiting for it; the user checked
the 20 strongest and all were duplicates.

### Not yet

- **Clips cut from longer files.** Their sprite intervals differ, and their lengths fail the
  gate. Pairing tiles by time already handles the intervals; the gate would need another way in
  (the hash-frame hits, which do surface them, are the obvious one).
- **The thresholds are constants**, not settings. They came from one measurement, and an admin
  has nothing to tune them against until the review queue says they are wrong.

## 10i. Look-alikes that are not all one thing

**Built 2026-10-17**, once §10h brought in looser candidates. The example that set the
requirement: five videos A–E where A and B are one video, C and D another, and E a third, linked
into one group by a chain. The only decision the app could store was the group's `reviewed`
flag. Marking it hid two real duplicate pairs; leaving it open kept E in the queue forever. And a
split made by hand would not have lasted: a group is only its member set (§10b), rebuilt by any
pass that touches a member, and the A–C link is still above the threshold.

### Decisions are stored per pair, not per group

`DupeVerdict` holds what a person said about two items: `same` or `different`, one row per pair
(`aId < bId`), with the decision it came from. A pair of items does not change when groups merge,
grow or are rebuilt, so the decision outlives all of that. Storing a split on the group was
rejected for exactly that reason: it would be lost the moment the group gained a copy, which
is when new candidates arrive.

**Clustering follows the verdicts** (`clusterPairs(pairs, apart)`). A `different` pair is never
joined: links are taken closest first, and a join that would put two such items in one cluster is
refused. So a new copy X that looks like both A and C joins the one it is closer to and does not
tie them back together. A `same` pair is a link of its own, taken first. Only a person's word does
this; the transitive rule in §10 still decides everything nobody has spoken about. Identical
groups ignore verdicts, since bytes are bytes.

Inheritance follows too, for free: §10c's heir is chosen among a copy's group, and after a
sorting E is in no group with A, so a trash of B never hands anything to E.

### Three ways to say it, one request

`POST /api/dupes/sort` takes the group and every copy the row showed, divided into sets. A set is
one thing; a set of one is a copy on its own. Every pair gets a verdict: `same` within a set,
`different` across sets. The group is replaced by one group per set of two or more, in the same
transaction. A copy merged in since the page loaded makes the request fail: nobody has said
anything about it.

- **None match**: every copy in a set of its own. This is the usual false positive from §10h
  (same room, same light, a different video).
- **Not the same as the others**, from a copy's Look: that copy alone, the rest left together.
  The rest are sent with `alike: false`, so they are kept apart from it and nothing is said
  among them. Leaving them together is not saying they are the same.
- **Sort into sets…** (`s`): the row opens in place. Each copy carries its set's letter and
  colour; pressing the set (or the copy's digit) moves it to the next set, then to a new one.
  Pressing a picture makes it its set's keeper. **Record and trash** resolves each set through
  `resolveOne`, exactly as a row would, after the ordinary confirmation with one line per set.
  **Just record** saves the sets, and they come back as groups marked "You said these are the
  same", with no looseness caution.

### The app sorts first

A group's ends need not match, so for three or more copies the server checks which copies match
each other **directly**, with the same tests and thresholds as the pass (`dupeLinks.ts`: frame
hashes from the database, tile prints from `/data`). `suggestSets` places each copy, best first,
in the first set where it matches every copy already there. For A–E it gives {A,B}, {C,D}, {E}.
A verdict overrides the comparison for any pair it covers. Sorting starts from this suggestion,
so agreeing with it takes one press. When there is more than one set, the row gets a caution and
starts unticked, because trashing it under a single keeper would trash a different video.

The comparison only runs for pairs nobody has decided, and only for groups of three or more, so
a confirmed group or a pair costs nothing.

### Looking quickly, as with faces

Every copy has a **Look**, as a face does (§5f): a popover with eight moments spread across the
video (tiles from its sprite track rather than its cover, because two look-alikes are usually
alike at the cover's moment), its file, and **Play it here**. That opens a drawer beside the
sheet that plays the copy. It switches between the group's copies at the **same second**, by
press or by digit, because watching one and then the other at the same point is what settles
"same video?". It uses the same second rather than the same percentage: copies of one video
run within a second or two of each other. `p` opens it from the keyboard.

### Taking it back

The Reviewed tab lists each sorting that kept anything apart, folded by default, with its sets
side by side. **Take back** deletes that decision's verdicts and forgets its copies' clustering
marks. The next pass then regroups them the way it does everything else; nothing stitches the
groups back by hand. A pair decided again later belongs to the later decision.

### Comparing by the generated cover

Wherever copies are compared — the review rows, the delete confirmation, an item's other copies,
and Sorted apart — each copy shows its **generated** cover, even where someone chose another
(§9 "User-chosen covers and captures"). Every generated cover is taken the same way, 10% into
its file, so two copies of one video show the same picture. A chosen cover can come from any
moment, and it made true duplicates look different at exactly the glance the sheet relies on. A
chosen cover stands in only for a copy with nothing generated yet. Everywhere else the chosen
cover is still the item's face.

Nothing warns that a copy about to be trashed had a cover chosen for it. Losing a chosen frame
costs a few seconds to pick again; a warning on every such row would cost the screen's
quickness.

## 11. Casting to TVs

Two different protocols; there is no single mechanism that hits both.

- **Chromecast / Android TV / Google TV** — Cast sender SDK in the web UI. The receiver
  fetches the media itself, so the URL must be reachable from the TV, send CORS headers, and
  carry no cookie → a **signed media token** (§12d, built). Its claims bind `sub` (user) _and_
  `mediaId`, so it cannot be replayed for a different file or a root the user lacks.
- **Samsung (Tizen) TVs are not Cast receivers.** Realistic paths: DLNA/UPnP push (SSDP
  discovery + AVTransport `SetAVTransportURI`), an Android app using the native Cast SDK
  (see §2 — Capacitor), or the TV browser with a trimmed "TV mode" layout.
- Order: Cast SDK first, DLNA push second, TV-browser mode as a cheap fallback.

Both force the `websafe` variant rather than the original wherever the original failed
playback assessment — Samsung and Chromecast disagree about HEVC, subtitles, and HLS variants.
An original that passed assessment is already the profile receivers want, and is served as-is;
see §12d for why re-encoding it would cost CPU to arrive where we started.

## 12. Remote access and security

Behind Caddy with TLS terminated there — `docker/docker-compose.proxy.yml` and
`docker/Caddyfile`, an overlay rather than part of the app's own compose file, because the
front door is the part of a deployment most likely to already exist. `docker/README.md` has
the operational detail; this section records the decisions.

- basket-bot's auth scheme unchanged; first boot creates an admin via `/setup` (§12c), after
  which admins invite accounts. **Not built** — there is still no way to create a second
  account.
- Media roots mounted read-only; every request path canonicalized and checked against a root
  prefix before any filesystem access.
- No directory listing; `Secure` + `HttpOnly` + `SameSite=Lax` cookies.

### The app sets its own security headers

In `next.config.ts`, not in the proxy, because the LAN-first deployment has no proxy — and a
security header that only exists in a config file on another machine is a header that is
missing half the time. Setting them in both places is worse than either: the sibling Pi apps
do exactly that and serve two different HSTS lifetimes and a contradictory `X-Frame-Options`
on the same response.

`Referrer-Policy: no-referrer` is the strictest available and this app specifically needs it:
a signed media URL carries its token in the query string (§12d), and any weaker policy hands
that whole URL to whatever a page links out to.

**HSTS is conditional on the proxy reporting TLS.** Sent to a browser that reached the app
over plain HTTP on a LAN, it would pin the hostname to HTTPS for a year against a deployment
with no certificate — unreachable from that browser, with no cure short of clearing site data.
No `preload` and no `includeSubDomains`: the hostname is very likely a DDNS name shared with
other services, and neither is ours to decide for it.

`'unsafe-eval'` is sent only by the dev server, which needs it for React's development build
and Fast Refresh; a production build evaluates no strings and does not get it.

**API responses are `Cache-Control: private, no-store` by default, set in the same place.** Next
gives a route handler no `Cache-Control` at all, and "no header and no validator, so nothing
stores it" is a browser heuristic rather than a guarantee — a CDN rule to cache everything, or a
proxy added once the app faces the internet, would serve one user's library to another. The
catch is that Next applies config headers first and copies a route's own headers only where the
config set none, so the default cannot be overridden from inside a route: it would silently win
over the art route's year-long `immutable`. The rule therefore excludes, by path, the three
routes that set their own policy — art, stream and the change feed — and
`lib/apiCachePolicy.test.ts` runs Next's own matcher over every route file and fails if one sets
`Cache-Control` without being excluded, or is excluded without setting one.

**Signing out clears the browser's HTTP cache** (`Clear-Site-Data: "cache"` on the logout
response). Covers and captures are cached for a year, and without it the next person to use a
shared browser would be looking at a disk cache of someone else's library. Browsers honour the
header only in a secure context, so a plain-HTTP LAN deployment gets nothing from it; the
internet-facing one, which is where a shared machine is likeliest, does.

The CSP keeps `'unsafe-inline'` for now. Next inlines its own bootstrap and Mantine injects
styles at runtime, so removing it needs nonce plumbing through the document — the UI rewrite's
work. What is there still closes the cheap holes: no cross-origin loads, no plugins, no
injected `<base>`, no framing. The Cast sender SDK (§11) will need `https://www.gstatic.com`
in `script-src`, and the comment in `next.config.ts` says so where it has to change.

### Trusted proxies are config, not a Setting

`trustedProxyHops` is the one place the §12b rule needs explaining. It describes the
_deployment_, exactly as `port` does, it is read before anyone is authenticated, and it
decides how a caller is identified for rate limiting — so leaving it editable in the UI would
put the lock on the inside of the door.

Next's standalone server hands a route handler no socket address, so the only thing that can
name a client is a header, and a header is only as good as whatever put it there.
`X-Forwarded-For` is a list each proxy appends to, so the entry `hops` from the right is the
one our outermost proxy actually saw; everything left of it is a claim. Zero trusts nothing
and reports no address at all, even when the header is present and looks plausible — because
with no proxy in front, honouring it would let anyone rate-limit somebody else out of their
account by forging an address, or evade their own by rotating one.

Setting it _higher_ than the number of proxies present is the dangerous direction, and the
reason the value is written down in both compose files rather than defaulted optimistically.

### Login rate limiting: a delay for the account, a refusal for the address

Two controls of deliberately different kinds, because the two keys belong to different people.

**Per account — a progressive delay, never a refusal.** Three free attempts, then a wait that
doubles from half a second and stops at ten. Guessing a password means guessing against one
address over and over, so this is the control that meets the attack.

It was a lockout — ten attempts per fifteen minutes — and that was right while the app was
LAN-only. It cannot survive being reachable from the internet. The account name is an email
address, the one thing about a person that is public by construction, and a lockout keyed on
it is a remote off switch anybody can pull: a handful of junk requests every window, from
anywhere, and the owner never gets back into their own library. The attacker spends nothing,
needs no password, and there is no way to clear it from outside.

So the account is throttled instead. A person who mistyped a password they know notices
nothing; somebody working through a dictionary is reduced to about six guesses a minute,
permanently, with no window to wait out and no state they can reset by walking away.

**This is knowingly weaker against a patient attacker than the lockout it replaced**: six
guesses a minute forever is more attempts per day than ten per window allowed. That is the
price of not shipping a denial of service, and it is only payable because the attempts can be
stopped a layer down — see the jail below. Availability of somebody's own library was judged
the more valuable property, given that the password is bcrypt at cost 12 and the throughput
that buys an attacker is still far short of a weak password's search space.

**Per source — a refusal**, sixty per fifteen minutes across all accounts. Spraying one
password across many accounts never trips the per-account throttle, since no account sees more
than a couple of attempts. Here refusing is the right shape, because the key is the caller's
own address: the person inconvenienced by a false positive is the one making the attempts.
It is also what bounds how many delayed attempts can be holding a socket at once.

The cap on the delay exists for that reason. An unbounded wait is a held connection an
attacker chooses the length of.

Both controls advance on every attempt even when the source has already been refused.
Short-circuiting would let an attacker who has tripped the source limit keep hammering one
account for free — its delay frozen, and back to nothing when they move to a fresh address. A
correct password clears the account's delay and deliberately **not** the source's count: it
proves something about the account, not about the address.

Counted before the password is checked, and the delay paid before it too, because `login`
deliberately runs a comparison even for an address that does not exist — so response time
reveals nothing, and every unauthenticated attempt otherwise costs a bcrypt hash on a NAS
whose CPU is the binding constraint (§17).

In memory, not in the database. A login attempt that costs a write is a login attempt an
attacker can use to make the disk work, against a file the worker already holds for minutes at
a time. The cost is that counts reset when the container restarts — and `entrypoint.sh` takes
the container down when either process exits, so a worker crash clears them without anyone
asking. That is accepted rather than merely tolerated: the delay is a throttle, not a budget,
so a reset costs a handful of fast attempts rather than a fresh allowance, and the jail's bans
live outside the container entirely.

The refusal message names no account and distinguishes no failure mode, for the same reason
`login` returns one message for every way it can fail. The delay is silent for the same
reason — an invented address is counted exactly like a real one, so the wait cannot be used to
tell them apart.

### The two authenticated credential endpoints are metered too

`POST /api/auth/password` and `POST /api/auth/refresh` are refusals, not delays, and the
reasoning that makes a lockout wrong for login does not apply: the password-change key is the
caller's own account, which they are already signed in to, and the refresh key is their own
address. Nobody else can spend either budget, so nobody else can shut anyone out with it.

Neither is a way in. Password change needs a bearer token; a refresh token is 128 random bits.
The limits are about what an internet-facing deployment pays to answer somebody who has
noticed the endpoints exist. Password change verifies the current password with bcrypt at cost
12 **before** rejecting anything, which unmetered is an unbounded CPU oracle on the machine
that is also transcoding. Refresh is only a database read, so its limit — 240 per address per
fifteen minutes, against roughly one per open session per window — is a ceiling on volume
against the file the worker holds, not a guard on the token.

`POST /api/setup` is deliberately **not** metered. Its token is sixteen random bytes and
guessing 128 bits is not a thing that happens; a limiter there would only add a way to make
first boot fail.

### The endpoints that answer strangers refuse other sites, and read small bodies

Everything past sign-in authenticates with a Bearer header, which a browser never attaches by
itself, so forged cross-site requests reach nothing there. Login, logout, register and setup
are the exception: they answer before anyone is signed in, and two of them set or clear the
session cookie. `SameSite=Lax` stops the cookie being _sent_ on a cross-site POST, not a
response _setting_ one, and a `text/plain` form can carry a body that parses as JSON — so any
page could sign a visitor into an account of its choosing, or out of their own.

These routes refuse `Sec-Fetch-Site: cross-site` (`lib/auth/requestGuards.ts`). The browser
sets that header and page script cannot; a client that sends none — curl, a test — is not a
browser being steered, and passes. `Origin` against `Host` was the alternative and was
rejected: behind a proxy `Host` is whatever the proxy forwards, and getting that comparison
wrong locks everybody out of the sign-in form.

They also read at most 16 KiB of body. Route handlers set no limit and `request.json()`
buffers everything, so an unauthenticated endpoint held however many bytes a stranger sent,
in memory, before validation could refuse any of them. Malformed JSON now answers 400 rather
than reaching the error log as a 500.

### The jail is the only layer that can make attempts stop

`docker/docker-compose.fail2ban.yml`, a second overlay on top of the Caddy one. Five failures
in ten minutes gets the source dropped at the host firewall for an hour, multiplying towards a
day on repeat.

This is load-bearing rather than belt-and-braces, and it is what the account throttle's
weakness is paid for with. A throttle by design never makes the attempts stop arriving: every
one still costs a connection, a log line and — once it is past the free attempts — a socket
held for up to ten seconds. Only a layer in front of the app can refuse to receive them at
all, and on this deployment that layer is the host's firewall.

It reads `request.remote_ip` from Caddy's access log — the peer of the TLS connection —
and deliberately not any `X-Forwarded-For` the client sent, which would let anybody get
anybody else banned. That is the same rule the app's own limiter follows, for the same reason.

**It requires the Caddy overlay**, which is where both the log and a trustworthy address come
from. An internet-facing deployment must be behind that overlay regardless: it is also what
sets `trustedProxyHops=1` and overwrites `X-Forwarded-For`, without which the per-source
limiter degrades to a single shared bucket for the whole world and `isPrivateRequest` falls
back to judging the `Host` header.

Private ranges are never banned. A tablet retrying a stale password is not an attacker, and
locking the household out of the front door from inside the house is the failure to avoid.

### A rotated refresh token keeps working for thirty seconds

Every refresh replaces the refresh token and revokes the old one. With no grace, any two
requests carrying the same cookie signed the person out: only the first could rotate it, and
the second presented a token revoked a moment before. That happened all the time in
development and occasionally in use:

- two tabs reloading together, which a code change always causes;
- a reload that cut off a refresh the server had already finished, so the browser never stored
  the new cookie.

The database kept the evidence: new tokens that were never presented, each followed minutes
later by a fresh sign-in.

A token a refresh replaced within `REFRESH_ROTATION_GRACE_SECONDS` is now still accepted, and
the request that presents it gets a token of its own. It cannot be given the one the race
produced, because only hashes are stored.

What opens the window is `RefreshToken.rotatedAt`, set only by rotation. Signing out and
changing a password clear it for the whole account, so neither can be undone by replaying an
older token. A disabled account is refused inside the window as outside it.

The cost is small and bounded. A stolen token replayed within thirty seconds of its owner
refreshing gets a session. Without the grace, the same token worked for as long as the owner
went without refreshing.

Rotation is also one transaction now. It used to be a revoke and an issue, so a busy database
between the two could leave somebody with neither.

On the client, **only a 401 means signed out.** A failed refresh used to send people to the
login page whatever the failure was: a recompiling dev server, a 503 while the worker held the
write lock, a 429, a dropped connection. Those are now retried for about seven seconds before
the page gives up.

The library stats query no longer runs before the session is restored. It sits outside the auth
gate, so on every load it took a 401 and started a second refresh of its own.

**One refresh at a time, across tabs.** The grace made a race survivable; it did not stop
races. The client holds a Web Lock (`private-stock-refresh`) around the refresh, so a second
tab's request leaves only after the first tab's `Set-Cookie` has landed, and the refreshing tab
posts the result on a `BroadcastChannel` so waiting tabs skip their own request and settled tabs
showing the same account adopt the newer access token — memory only, never `localStorage`. A
request whose 401 arrives after its tab's token has already changed retries without refreshing.
A refused refresh now signs the shell out instead of leaving it to retry on every poll, which is
what produced repeated refused refreshes in production. Web Locks need a secure context, so over
plain HTTP each tab refreshes on its own and the grace still covers it. The server is unchanged:
returning "the same successor" inside the grace is impossible while only hashes are stored.

### Open, and decided before the name goes public

Rate limiting is a control on _attempts_, and none of these help against a password that
leaked somewhere else. Three things are missing and are decisions rather than patches:

- **No second factor.** A single bcrypt-protected password is the whole perimeter for a
  library holding material the owner has described as confidential.
- **No account recovery**, which is the other half of the same decision — a second factor
  nobody can recover past is a way to lose the library rather than protect it.
- **Nothing pins a session to a device.** Refresh tokens rotate, so a stolen one is usable
  only until the real client next refreshes, but a stolen _password_ grants a session from
  anywhere with no signal to the owner.

Settled, and the reason the setup window is not a worry in practice: **the public name is
pointed at the app only after setup has been completed.** `completeSetup` then refuses on
`needsSetup()` before anything else it checks, so the first-boot grant is not reachable from
the internet at all.

### Casting decides the certificate

A Cast receiver fetches the URL itself and will not accept a certificate that is not publicly
trusted — so `tls internal` and self-signed certificates are out, and this is why the
otherwise complete LAN-only deployment cannot cast. It also means the hostname the app hands
out has to resolve to the NAS _from the TV_: without split-horizon DNS the receiver fetches
the video out through the upstream and back, or fails outright on a router that will not
hairpin.

**The Pi that fronts the sibling apps is not in the media path**, having proved unable to carry
video — a proxy sends and receives on one NIC, so whatever its throughput is, proxying halves
it, and on a Pi that NIC is the weakest link in the house.

It keeps ports 80 and 443 and keeps serving its own apps. What it does for this one is relay
the ACME challenge: a site block declared `http://` so it binds port 80 without trying to claim
the certificate itself, forwarding `/.well-known/acme-challenge/*` to the NAS and answering 404
to everything else.

The reason it has to is that **a certificate binds to a name, not a port** — so the issued
certificate is valid on any port the router cares to forward — but **obtaining** one is not
port-agnostic: Let's Encrypt validates on 80 or 443 and follows no redirect to anywhere else.
The NAS cannot answer on either, because the Pi does. DNS-01 would sidestep this and needs API
control of TXT records that a free DDNS hostname does not offer.

So the NAS owns and renews its own certificate, and the Pi carries a few hundred bytes every
sixty days. The cost is an unusual dependency — the NAS needs the Pi up at some point inside
the 30-day renewal window — and it is the price of not moving port forwards that already work.
TLS-ALPN-01 is disabled on the NAS so issuance does not first attempt the one challenge that
cannot succeed there.

`docker/README.md` has the steps, and the list of ways it fails.

## 12b. Configuration

**Rule: if it is needed to start the process or to find the database, it is file/env config.
Everything else is a `Setting` row edited in the UI.** A NAS admin should never SSH in to
change a thumbnail quality or a scan interval.

That leaves the config file genuinely small — **`/data/config.json`**, every key optional
and every key overridable by an environment variable:

```json
{
    "//": "every key is optional; env vars override this file",
    "port": 8842,
    "dataDir": "/data",
    "mediaDir": "/media",
    "logLevel": "info",
    "secret": null
}
```

| Key        | Env override              | Meaning                                       |
| ---------- | ------------------------- | --------------------------------------------- |
| `port`     | `PRIVATE_STOCK_PORT`      | HTTP listen port                              |
| `dataDir`  | `PRIVATE_STOCK_DATA_DIR`  | database, artifacts, variants, trash, backups |
| `mediaDir` | `PRIVATE_STOCK_MEDIA_DIR` | parent directory of the mounted roots         |
| `logLevel` | `PRIVATE_STOCK_LOG_LEVEL` | `error` \| `warn` \| `info` \| `debug`        |
| `secret`   | `PRIVATE_STOCK_SECRET`    | JWT and media-URL signing key (see below)     |

JSON rather than YAML or INI: it needs no parser dependency, `pnpm format` already covers
`*.json`, and it matches how the repo configures everything else. The one JSON annoyance is
the lack of comments, so the loader **ignores any key beginning with `//`** — enough to
annotate an example file without reaching for JSON5.

Precedence: **env > file > default**, because Container Station's UI makes environment
variables easy to set and editing a file inside a container is not. Secrets may also come
from a `.env` alongside it, as in basket-bot. The merged result is parsed through a zod
schema in `packages/core`, so a typo fails at boot with a readable message naming the key
rather than silently defaulting. `config.example.json` is checked in; `config.json` is not.

`secret` is generated on first boot into `/data/secret.key` (0600) if neither env nor file
supplies one. Nobody should have to invent a signing key to use the app, and nobody should
accidentally run with a default one.

**Media roots need no config at all.** The compose file already declares them as mounts —
`/share/CACHEDEV1_DATA/Videos:/media/videos:ro` — so the app discovers roots by listing
`mediaDir`, and an admin enables, labels, and sets access on each in the UI. The mount _is_
the configuration; duplicating it into a second file is how the two drift apart.

Everything operational lives in `Setting`, typed by a zod schema and rendered from it: scan
interval and watch toggle, transcode profiles, hwaccel mode, artifact quality and sprite
interval, trash retention, backup schedule and count, duplicate thresholds, default home
layout, whether self-registration is allowed. Settings are validated on write and cached in
each process with a change notification, so no restart is needed.

Hwaccel is the one split case: the `/dev/dri` passthrough is necessarily compose-level, but
_choosing_ it is a `Setting` with a "test" button that runs a probe transcode and reports
what the container can actually reach. Configuration that lies about hardware is worse than
no configuration.

**Built, after the first deployment made the case for it.** The button posts to
`/api/admin/transcode/probe`, which encodes one second of `testsrc` with the selected backend
and reports ffmpeg's own first diagnostic on failure. That wording matters more than a
friendly message would: "Failed to initialise VAAPI connection" is a missing driver,
"Permission denied" is the device node, "Unknown encoder" is the ffmpeg build, and the three
call for entirely different fixes.

Two decisions inside it. **The arguments come from `buildHwaccelProbeArgs` in `transcode.ts`,
assembled from the same `hwaccelInputArgs`, `scaleFilter` and `videoEncoder` that
`buildTranscodeArgs` uses** — a probe written separately would drift, and a probe that passes
while the jobs fail is worse than no probe, because it turns "my transcodes fail" into "my
transcodes fail and the test says they should not". A test asserts that correspondence rather
than trusting it. **And a failed probe returns a result, not an error**: throwing would render
as a 500 and an error toast, which reads as a broken button rather than an unavailable
encoder, and those two readings send someone in opposite directions.

It runs in the web process, the second ffmpeg call there after `frameService` and deliberate
for the same reason (§2): the answer is only useful while someone is looking at the settings
page, and a queued job cannot promise that. It is one second of 640x480 with a hard timeout,
admin-scoped, and POST so that no prefetch or retry can spawn a process on its own.

The first deployment is what proved the need. `/dev/dri` was mounted, readable and correct;
Debian's ffmpeg depends on `libva2` but on no VA driver, so every hwaccel path failed inside
ffmpeg on every job with nothing anywhere naming the cause. The image now carries `i965-va-driver`
and `intel-media-va-driver`, and the button is what makes the next such gap visible on the
settings page instead of in a job log.

### Libraries are added, not discovered

This reverses an earlier decision, and the reversal is the interesting part. Roots were
discovered by listing `mediaDir`, on the reasoning that the compose mounts are already the
configuration and a second list would just be somewhere else to keep in sync.

That holds right up until content lives somewhere the app cannot be pointed at by a mount —
a second drive on a dev machine, a share that moves — and it fails in two ways at once:

- **A discovered library cannot be repointed.** Editing its path is meaningless when the next
  scan recreates the row from whatever is on disk, so moving content means re-importing and
  losing every tag, rating and duplicate group attached to it.
- **Naming was the identity.** `dirName` was `UNIQUE`, which confined every library to one
  parent directory and made two drives that each hold a `Videos` folder collide.

So a library is now a row an administrator created: a **path** plus its settings. Three
properties follow, and each is a decision rather than an accident:

- **Nothing creates a library on its own.** Directories under `mediaDir` are offered as
  one-click suggestions when adding one — which keeps the NAS case a click, since the bind
  mounts put everything there anyway — but nothing is catalogued until someone says so.
  Mixing the two would produce two kinds of library, one repointable and one the next scan
  puts back, and "edit this library's path" would mean different things for each.
- **Nothing removes one for being unreachable.** An unavailable path is a misconfiguration or
  an offline share, and both are fixed by repointing — which is only possible if the row is
  still there. The scanner already refuses to reconcile a library it cannot reach, for
  exactly this reason (§7); this applies the same rule one level up. The admin page reports
  it as unavailable and touches nothing.
- **Libraries may not nest.** A file inside two libraries is catalogued twice, counted twice,
  and offered as a duplicate of itself — and the two rows can disagree about whether deletion
  is allowed. Overlap is refused when the path is typed.
- **A library may not overlap `dataDir`**, in either direction. It holds the database, the
  signing key, the trash and every capture; as a library its artifacts would be catalogued as
  media, and made deletable all of it would be one trash action from gone — the trash
  included. So `/` is refused too, for containing it.

**The path is checked as it is typed**, by the same code the write runs — a form that
approves a path the server then rejects is worse than no check, because it teaches people to
trust it. An admin can type a path or browse for one; the browser lists directories only,
never file names, which grants no reach an admin lacked (they can already type any path and
learn from the error whether it exists) while declining to hand out a file listing.

A side effect worth recording: **a Windows junction now works as a library path.** It is
listed by the browser, accepted by the check and descended into, because the browser resolves
a link rather than trusting `isDirectory()` — which reports false for a junction and would
have hidden exactly the directories someone linked deliberately. This is the case §12b could
not serve when libraries had to be children of one parent. The limit: a junction _inside_ a
library is still skipped by the scan walk, which filters on `isDirectory()`.

**The path is checked before it is stored.** In a container, a host path nobody mounted is
the most likely way to configure this wrongly, and without the check it would look like it
worked and then find nothing forever.

What did not change: the mounts still decide what the container can _see_. Making a share
visible and cataloguing it are now two steps rather than one, which is the cost of being able
to move a library without losing what is recorded about it.

### A renamed file is the same file

Without this, renaming a directory is indistinguishable from deleting every file in it and
creating new ones: the old items archive, taking their tags, ratings, watch positions and
processing history out of sight, and the files come back as blank new items. Reorganising
folders is a normal thing to do, so that is the difference between a cataloguer and a file
lister.

Identity is `(dev, inode)`, captured by the scanner already and preserved by a rename on every
filesystem worth using — confirmed on NTFS as well as POSIX, which is the part worth checking
rather than assuming. `dev` is stored alongside because an inode is unique only within a
filesystem and a library can span a mount point.

Three conditions, and each rules out a specific wrong answer:

- **Size must agree.** Inode numbers are reused once a file is deleted, so an unrelated new
  file can inherit one.
- **Exactly one candidate, or none.** Two matches mean the evidence does not identify a single
  file, and a wrong merge attaches one file's history to another — worse than missing the
  move, which only costs what the old behaviour cost anyway.
- **The old path must be gone**, which is what separates a move from a copy. A copy takes a
  fresh inode and would fail the first test regardless, but this is the check that says so
  directly.

Where a filesystem reports no usable inode — FAT32, some SMB shares — it falls back to size
and mtime, which is a far weaker claim and is why the old path still has to have gone.

The cost is one `stat` per path that has no row of its own, so an unchanged rescan does no
extra work at all and a reorganisation pays once per moved file.

**One-second timestamps nearly disabled this.** The candidate query excludes rows the current
scan has already placed, and comparing `lastSeenAt < scanStartedAt` looked right — but
SQLite's `CURRENT_TIMESTAMP` has one-second resolution, so two scans inside the same second
share a timestamp and every row from the previous scan was excluded. Detection silently did
nothing. It is `<=` now, and the real proof was always the missing old path rather than the
timestamp.

**The name follows the file.** Keeping the item was only half of it: the title is derived from
the filename when the item is created, and the search document is built from the path, so a
renamed file kept its old title and stayed findable only by its old name — nothing ever rebuilt
either, because the index stage had settled. A move now retitles the item, but only while its
title is still the old name's (`retitleAfterMove`): a title that says anything else was chosen.
And the batch's moved items are reindexed once it commits (`searchRepo.requestReindex`), so a
renamed folder of a thousand files costs one statement per item, not a transaction each.

### Repointing hides the library until a scan confirms it

Changing where a library points says nothing about whether the files are there. Until a scan
looks, the honest position is that we do not know — and an item shown from a directory nobody
has checked can be played, transcoded or deleted against whatever happens to occupy that
relative path.

So a repoint marks every file `unverified`, which hides its items (only `active` is listable)
without asserting anything, and queues a scan of that library immediately. Rows, tags and
ratings are untouched; this is a curtain, not a deletion. Trashed files are left alone: they
sit in `/data/trash` rather than in the library, and their state is a decision rather than an
observation.

`unverified` is a fifth state rather than reusing `missing` because `missing` is a claim about
the filesystem, and after a repoint no such claim has been earned. That distinction is the
same one `trashed` was added for.

**Pending jobs for that library are cancelled.** A job resolves its file's path when it runs,
not when it is queued, so a probe or a hash queued before the repoint would open whatever now
sits at that relative path and write its duration, codec or perceptual hash onto the item that
used to be there. The hash is the worst of them, because duplicate detection then spreads it.

### Nothing is destroyed without checking it is the right file

Deletion resolves a stored relative path against the library's _current_ directory, so a
repoint — or any drift between the catalogue and the disk — can aim it at a different file.
The trash job therefore compares the file's size and mtime against `MediaFile` before touching
it, and refuses if they disagree: the file stays, the item stays, and a rescan makes the
deletion possible again.

Size and mtime are what the scanner already treats as identity (§7), so this agrees with the
rest of the system rather than inventing a second notion of sameness. It costs one stat, and
it is what makes every other kind of staleness merely wrong rather than destructive.

### Path comparison follows the platform

Windows and macOS treat two spellings of a path as the same directory. Comparing raw strings
there would let both be added as separate libraries — the same content catalogued twice, every
count doubled, and every file reported as a duplicate of itself. Overlap is therefore compared
case-insensitively on those platforms, while the admin's own spelling is what gets stored.

### Forgetting a library, and the rows that used to survive it

Deleting a `MediaRoot` cascades to `MediaFile` and its links and stops there, because `Media`
hangs off the **file** rather than the library — there is no `rootId` to cascade from. That
left every item behind as an orphan: invisible, because the `listable` trigger had just
cleared it, and carrying its tags, ratings, artifact rows, processing history and search
document with it indefinitely. Measured rather than reasoned about, which is the only reason
it was found.

So the delete is two statements in one transaction: the library, then every item with no
`original` link remaining. Asking about the link rather than deleting everything that lost a
file is what lets an item catalogued from two libraries survive losing one of them.

`Media` deliberately did **not** gain a `rootId`. It would duplicate a fact the links already
carry, and would have to be maintained by trigger exactly like `listable` is — a second
derived column to keep honest, to avoid one extra statement.

### Bytes are swept, not listed

Rows and files are separate, so the row deletion leaves covers, previews, sprite sheets,
transcoded variants and trashed bytes on disk. The worst of those is the trash: `TrashEntry`
cascades away with its library, and a trashed file whose entry is gone is reachable by
nothing — no restore, no purge will ever find it. Disk lost for good.

The cleanup is therefore a sweep over what exists rather than a list handed over by whoever
deleted the rows. Two reasons: a 200k library's list does not fit in a job payload, and a
sweep also catches litter from every other cause, such as a container killed between writing
a file and inserting its row.

**It skips anything written in the last hour.** That is the whole safety argument: a cover job
writes its file and then inserts the row, so for a moment the file legitimately has nothing
pointing at it, and a sweep running in that window would delete the artifact of a job about
to report success — leaving a row with no bytes, which is worse than the litter because
nothing looks wrong.

### One settings contract; each setting beside what it configures

Settings arrived feature by feature, each reading its key where the code that needed it
happened to live: `"dupes"` in a job handler, `"transcode"` in another, two `"scan.*"` strings
inlined in a route. Individually reasonable; collectively there was no answer to "what can an
admin change", and **two of the four groups had no interface at all** — the library ran on
transcode and duplicate-detection defaults that nobody could see, let alone alter.

So the names and shapes live in one contract, and the screens are built from the same schemas
the worker validates against.

**The screen is not one page.** It was, deliberately — eleven cards on `/admin` — and it read as
a cockpit: four processing cards scattered between People and Invitations, duplicate thresholds
two pages from the duplicates, trash retention away from the trash, OCR switched on in one place
and configured in another. Each setting now sits beside what it configures, by one rule: a
**stage's** settings are on Processing (Stages, OCR, Transcoding tabs, quiet hours with the
stages); a **queue's** settings are in that queue's **Rules** drawer (Duplicates, Trash); the
scan schedule is on Libraries. Review tabs hold decisions, never configuration. Every section
still reads and writes the one `admin.settings()` contract, so nothing can disagree.

Two properties are deliberate:

- **Writes are partial.** Each card saves alone, so an admin editing transcode settings cannot
  overwrite a retention window someone changed a minute earlier with the value their page
  happened to load — a loss nobody attributes to the settings screen, because the form still
  said the right thing when they left it.
- **One writer per key.** The scan route kept its status and trigger endpoints but lost its
  `PUT`, because two write paths for one key is how two screens end up disagreeing about which
  value won.

## 12c. No separate admin app

**One app, `/admin` routes gated by the `admin` scope in `withAuth()`.** Not a second
Next app, not a second login.

basket-bot separates its admin portal for a good reason that does not apply here: its
primary client is the Ionic mobile app, so the web surface is _only_ admin. Here the web app
is the product, and the admin is a person who also watches videos.

Concretely, a separate portal would cost more than it saves:

- Admin actions are **contextual**. "Rescan this root", "regenerate this item's sprites",
  "resolve this duplicate group", "why did this file fail to probe" all start from a normal
  library view. Bouncing to another app to act on the item you are looking at is the wrong
  shape.
- One session, one theme, one component set, one deploy target, one set of route
  conventions. A second app duplicates all of it for no user-visible gain.
- The authorization boundary is identical either way — it is the `admin` scope check in the
  service layer, which has to be right regardless of which app the request came from. A
  separate portal creates the _feeling_ of a security boundary without adding one.

So: an admin tier in the nav, visible only with the scope, of four entries — one per question an
administrator arrives with. **Review** (`/review/*`: duplicates, OCR, unreadable files, trash —
one entry over four queues, returning to the last used), **Libraries** (`/admin/libraries`:
libraries, scanning, the scan schedule), **Processing** (`/admin/processing`: activity, stages
and quiet hours, OCR, transcoding, with the pause in its header) and **Household**
(`/admin/household`: people and invitations). `/admin` itself redirects to Processing, and the
old `/duplicates`, `/ocr`, `/unreadable` and `/trash` redirect to their new homes. Processing ›
Activity lists failed work that still stands — nothing of that kind queued for that item
since — with Retry through the door each kind already has: a stage through the same request as
"Run stage now", a transcode through the transcode queue (`jobService`). Failed rows are kept
for the backfill (§20), so counting every one would report problems fixed long ago; the
progress card's count uses the same rule.

The list leaves out **every failure on an item the probe has settled as unreadable** (§10g).
Such a file fails each stage after the probe as well, so it stood here once per stage with a
Retry that could only fail again; the first production review found 8 files making 24 of 49
rows. They get one line instead -- how many, how large -- linking to Review › Unreadable, where
the decision on offer (trash them) is the one that fits. The rule is in `STANDING_FAILURE`, so
the progress card's count, the per-kind counts and a wide retry all agree with the list.

Each row shows **the line that says why** (`failureReason`, shared with §10g), not the first
line of the error: that was usually `Command failed:` and the whole command, the same for every
file, with ffmpeg's complaint cut off behind it. **Retry all** takes the filter's kind, or
every standing failure when none is picked. The same review found the rest were mostly a
since-fixed bug's (`stderr maxBuffer length exceeded`, §9) on files that were fine -- the case
where nobody wants to make the decision one kind at a time.

**The error-log viewer is parked, not forgotten.** The `ErrorLog` table is written (`errorLogRepo`)
and nothing in the app reads it; the original plan promised an `/admin/error-logs` page. It was
left out of the admin reorganisation on purpose: it is a new screen, not a gap in an existing
one, and nobody has yet looked at what the table holds or how fast it grows -- which decides
whether it needs paging, filtering by route or user, and retention. When it is built it belongs
on Processing (a section of Activity, or a tab of its own), beside the failed-job list it
resembles, not as a fifth sidebar entry. Plus inline admin
affordances on library items — a "regenerate artifacts" action in the item menu, a failed-job
badge — which is where they are genuinely useful.

Destructive operations (deleting duplicates, removing a root, purging trash) stay
admin-scoped and confirm explicitly. Everybody gets their own **Account** page (`/account`,
below) — their own data, never the library's.

**First boot**: no users exist, so `/setup` creates the first admin. It is reachable only
while the user count is zero, and only from an address a trusted proxy vouched for as private
or with the one-time token printed to the container log — otherwise exposing the port before
finishing setup would hand the library to whoever arrived first. With no proxy configured
nothing can vouch for anybody, so the token is the normal path rather than the exception.

### Every account after the first comes from an invitation

`/register`, gated on a code an administrator mints. **There is no open registration and no
setting that turns one on.** A toggle whose ON state hands an internet-facing library of
private material to whoever finds the URL is a control that exists in order to be set wrong
once, and the absence is the feature.

This is modelled on `../chance-a-maran`, with one deliberate departure. That app has the
setting — `REGISTRATION_INVITATION_CODE`, exposed on its admin screen as `inviteCodeRequired`
— and it does not work: `authService.register` validates the code unconditionally, and the
setting is read only by `GET /api/config`, which the client uses to decide whether to _render
the field_. Turning it off makes the client send an empty code and registration fail for
everybody. The gate was always shut and the switch was decoration. Rather than fix it here,
the switch is not built.

**The code is generated, never chosen.** Ten characters of a 32-symbol alphabet — Crockford
base32 less `I`, `L`, `O` and `U` — which is about fifty bits, grouped in fives for reading
aloud. This is the decision the route's security rests on, and it is what makes the rate
limiter a volume control rather than the thing holding the door: a code somebody picks carries
whatever thought went into picking it, which is usually none, and `HOUSEGUEST` falls to the
first dictionary run. So the admin names the _invitation_ with a label, and the code is drawn
from `crypto.getRandomValues`. Normalisation forgives the typed form — case, grouping, and the
characters people substitute by ear (`O` for `0`, `I` and `L` for `1`) — while storage and
comparison both use the canonical string, so "which spellings are the same code" has one
answer.

An invitation carries a label, the scopes it grants, an optional use limit and an optional
expiry, and can be withdrawn. What it cannot carry is **more than its maker holds**: an
administrator without `delete` cannot mint a code granting `delete`, or minting would be a way
to promote yourself.

**Uses are counted, never stored.** The number of accounts naming an invitation _is_ its use
count, so the two cannot drift apart. It also means removing an account gives its use back,
which is right: a stored counter would leave a five-use invitation permanently spent by
somebody who was removed the same afternoon. The consequence accepted deliberately is that two
people submitting the last use simultaneously can both pass the check — a millisecond-wide
window, needing two valid codes, producing one extra invited account, against a transaction
that would hold a write lock on the worker's file for the length of a bcrypt hash.

A used invitation is **withdrawn rather than deleted**. Deleting it would set `invitationId` to
NULL on the accounts that name it and throw away the only record of how they got in; the repo
enforces that in the DELETE statement rather than by a check that a registration could land
between.

**Order inside `register` is load-bearing.** The invitation is checked first, so the
email-already-registered answer — an account enumeration oracle — is reachable only by somebody
holding a live code. A code that exists but cannot be used, by contrast, says exactly why:
that does distinguish a real code from an invented one, and it is the right trade _because the
code is generated_, so nobody reaches that branch by guessing and the only person who learns
anything is the one holding an expired code.

### Managing accounts, and the doors that must not lock from the inside

Admin › People lists every account with its permissions and the invitation it arrived through.
An administrator can grant or remove scopes, disable an account, or remove it.

Three things are refused, because `/setup` reopens only when the account count reaches zero —
so a library nobody can administer has no recovery path short of editing SQLite over SSH:

- removing your own `admin`
- disabling your own account
- deleting your own account

There is also a "last administrator" check, and it is honestly **defence in depth rather than
a live path**: the caller is necessarily an enabled administrator, so any _other_ enabled
administrator makes the count at least two. It is kept because it states the actual invariant
and because the self-checks that make it unreachable sit three lines above it.

Scopes and `disabled` travel in one request for the same reason. As two, "keep admin" and
"disable" would each pass their own check and still arrive at an account holding administrator
access that nobody can sign in to.

Disabling bumps `tokenEpoch`; granting a scope does not. Scopes are read from the row on every
request, so a grant lands without revoking anything — and bumping would stop the person's
playback mid-item in order to give them something. Taking access away is the opposite: without
the bump, a disabled account goes on streaming until each signed media URL expires (§12d).

Removing an account takes their ratings, watch state, private tags, saved views, playlists,
preferences and sessions with it, by cascade. The catalogue stays: media, public tags and
shared playlists belong to the library and lose their attribution rather than themselves.

An administrator can also edit a display name and the address an account signs in with. The
address is worth being explicit about: **nothing is ever sent to it.** It is a username that
happens to look like an email, which is why a typo in one locks somebody out until it is fixed
here, and why fixing it disturbs neither their sessions nor the signed media URLs they hold —
nothing about identity has changed.

### Resetting a password is the only account recovery, and it re-authenticates

`POST /api/admin/users/:id/password`. The administrator sets a password — typed, or generated
from the same unambiguous alphabet as an invitation code, because it is going to be read down
a phone — and passes it on themselves. There is no email to send it to.

**The caller supplies their own password to do it.** An access token is fifteen minutes of
ambient authority, and setting somebody's password is the one administrative action whose
effect _outlives the session that performed it_: with a stolen token and no re-authentication,
an attacker takes permanent ownership of every other account in the library, and disabling the
compromised admin afterwards does not undo it. `changePassword` already demands the current
password for exactly this reason (§12d); this is that rule applied to acting on somebody
else's behalf. It also means the administrator has to _be_ the administrator rather than
merely be sitting at their unlocked desk.

The route is header-authenticated with no `allowCookie`, as `/api/auth/password` is, and
rate-limited against the caller's own account — sharing the bucket with their own password
changes, because both are this account performing password operations and the wrong-password
branch is a guess that costs a bcrypt comparison.

It refuses on your own account, and the refusal is not fussiness: your own password change
lives in Settings, where it asks for the one you are replacing. Allowing a self-reset here
would be that endpoint without the check, which is the hole the re-authentication exists to
close. So the menu item is absent on your own row rather than present and refused.

Both halves of the lockout happen: `setPassword` bumps `tokenEpoch` in the same statement,
which invalidates every signed media URL the person holds (§12d), and every refresh token is
revoked. A reset that left either alive would not have locked anybody out of anything.

### Your own account

`/account`, reached from your name at the foot of the sidebar. That entry is a menu —
**Account settings** and **Sign out** — rather than a link, because until this page existed it
was only the second, and the one control with your name on it signed you out the moment it was
touched.

- **Your name is yours to change.** It is how the household sees you and has nothing to do
  with signing in.
- **Your sign-in address is an administrator's to change**, on every account — so an
  administrator can change their own here, and nobody else can. Everybody sees theirs,
  read-only, because "which account am I in" is a question anybody can have. The route
  (`PATCH /api/auth/me`) _refuses_ `email` from a non-administrator rather than dropping it,
  and the schema is strict, so a request that tried to set something is never answered "saved". The
  same clash check as Admin › People applies; neither change disturbs sessions or signed URLs.
- **Your password**, with the current one required (§12d). Every other session and every
  signed media URL ends — **but not this device's session.** `changePassword` revokes every
  refresh token and then issues one new one to the caller, and the route sets it as the
  cookie. It used to keep only the caller's access token, which read as the same thing and was
  not: fifteen minutes later the refresh behind it failed, and the person who had just secured
  their account was signed out of the tab they did it in.

### What a new account can see, and what is still open

Everything shared: every library, every public tag, every shared playlist. Their own ratings,
watch state, private tags, saved views and playlists are theirs alone, which the schema
already enforced — `tagScope.test.ts` existed to prove it against two accounts precisely
because the app could not yet create a second one.

**Per-library access is not built.** Granting an account specific `MediaRoot`s means a
per-account root filter on every media query, the home page, search, facet counts and the
change feed, where one missed query is a content leak. It is its own piece of work (ROADMAP
phase 8), and until it exists an invitation is an invitation to the whole library.

Also still open: **nobody can recover an account without an administrator.** The reset above
is the whole of account recovery, and it needs somebody who can already sign in as an
administrator — so a single-administrator library whose administrator forgets their password
has no way back in short of editing SQLite over SSH. A self-service path is a second way in
and needs deciding rather than adding; a second administrator is the cheap mitigation and is
now possible.

## 12d. Signed media tokens

`<video>` and `<img>` cannot set an `Authorization` header, so the media and art routes have
always accepted the refresh cookie as a stand-in. That works for this browser and nothing
else: a Cast receiver fetches the URL _itself_, from another device, with no cookie jar and no
way to be handed a header (§11). Same for a DLNA renderer, and for anything the TV-browser
fallback ends up doing.

A **signed media token** closes that gap. `POST /api/media/:id/token` mints a JWT whose claims
are `sub`, `mediaId` and `purpose: "media"`, and returns it with the path to use it on. It is
presented in the query string, so the URL carries its own proof and needs nothing from the
client that fetches it.

**Bound to one item.** A token names a single `mediaId`, checked against the item actually
requested. This is the whole difference between a media token and a second session credential
that happens to live in a URL — and a URL is exactly the credential most likely to leak, since
proxies log them and devices keep them in history. With the binding, a leaked token is a day's
access to one file the holder could already see. Unguessable ids (§18.2) complete it: there is
no adjacent id to try.

**It authenticates; it does not authorize.** The token carries no scopes and no root access.
`contextFor` re-reads the user row and `LibraryAccess` on every request exactly as it does for
a Bearer token, so disabling an account or withdrawing a library kills every outstanding token
at once. That is what removes the need for a revocation list, and it is why the lifetime can
be generous.

**Twenty-four hours**, governed by watch duration rather than session security. A receiver
holds a URL for the length of a film and has no refresh flow; minutes would strand playback
part-way through with nothing the user could do. The `mediaId` binding is what buys the
headroom to be relaxed about it.

**The two token kinds are not interchangeable.** `purpose: "media"` and the disjoint claim
sets mean an access token cannot be pasted into a URL and a media token cannot be presented as
a Bearer credential. Both directions are tested; without it, the generous lifetime above would
be a generous _session_ lifetime.

**CORS is sent only for a token-authenticated request.** `Access-Control-Allow-Origin: *` on a
cookie-authenticated response would let any page in the browser read the user's library
cross-origin, using authority the browser attaches by itself — the precise thing the
same-origin policy prevents today. A token request has no ambient credential to borrow, so the
wildcard is safe there and nowhere else. `Allow-Credentials` is never sent, and must not be.

**The grid keeps the cookie.** A token is part of the cache key, so minting one per tile would
give every cover a new URL on every page load and defeat the year-long `immutable` cache the
art route depends on (§9). Tokens are for the cast and out-of-browser path; the browser
already has something that works.

**A password change kills every outstanding token.** `User.tokenEpoch` is a generation
counter bumped in the same `UPDATE` that writes a new password hash; the token carries the
value it was minted under, and `contextFor` compares for equality. Nothing is stored and
nothing is listed, so there is no revocation record to go stale — and no window in which the
thing the user just did to lock someone out has not yet done so. `POST /api/auth/password`
also revokes every refresh token; all three effects are one action because leaving any of
them behind would defeat the reason someone changed their password.

Equality rather than a floor: the epoch is opaque, so a token claiming a _newer_ generation is
as wrong as one claiming an older. A floor would make a forged high value valid forever.

**Nothing records that a token was minted.** Deliberately: statelessness is what makes
revocation free, and re-reading the user row and `LibraryAccess` per request already covers
every case a revocation list would. The cost is that the active-sessions page (§12c) answers
"what can reach my library right now" for sessions but not for signed URLs. A password change
is the blunt instrument that covers both.

**A token request is held to a playable file.** A browser that hits a codec it cannot decode
has a detail page explaining why and a "prepare a version" button; a TV has neither, and a
receiver handed something it cannot play simply stops with nothing on screen. So a
token-authenticated request refuses a `pending` item — one known unplayable with no rendition
ready — where a cookie-authenticated one still serves the original. `issueMediaToken` asks the
same question, so a UI learns before starting a cast rather than after.

This is narrower than §11's "force the web-safe variant". For a file that failed assessment it
is the same thing: the variant is what gets served. But an original that _passes_ assessment is
already H.264/AAC in MP4 — the profile every receiver handles — and re-encoding it to arrive
back where we started would spend the NAS CPU that §17 names as the binding constraint for
nothing. What §11 is protecting against is the third case, and that is the one ruled out.

**HLS will reuse the same token, not one per segment.** A playlist is a list of segment URLs,
and a media token is already session-shaped: bound to one item, good for many requests,
lifetime measured in watch duration. The segment URLs carry the token the playlist was fetched
with. The alternative — a credential per segment — would buy nothing, since every segment
belongs to the item the token already names.

**The token is kept out of logs.** The Caddy access log rewrites `t` to `redacted` in every
logged URI, and the app's opt-in slow-request log does the same. The parameter's presence is
kept, so a reader can still tell a token request from a cookie one; its value is a day's
access to an item and has no business in a file that is rotated five deep and read by
fail2ban.

**The returned path is relative.** Building an absolute URL server-side would mean trusting
`Host` or `X-Forwarded-Host` to name an address the TV can reach, and behind a reverse proxy
those are whatever the proxy was configured to send. The browser knows the origin it loaded
from and joins the two.

## 14c. Collections: one idea, two mechanics

A **saved view** is a query and a **playlist** is a list. That is the only difference between
them: both exist so somebody can reach a subset of the library without finding it again. So
everything about _who may see one_, _who may change one_, _who may share one_ and _where it sits
in a sidebar_ is deliberately identical, and the parts that decide those things live in one
place — `packages/core/src/collections.ts` — rather than being written twice.

They had been written twice, and had drifted. The sidebar filtered views on `filter.pinned` and
playlists on `playlist.pinned && playlist.editable`, so **a shared view's owner-pin appeared in
everybody's sidebar and a shared playlist's appeared in nobody's**. The same gesture on the same
kind of object did two different things depending on which one you had made, and neither
behaviour was reachable from the other screen.

### Sharing is curation, so sharing is an administrator's

`SHARE_SCOPE` is `admin`. An ordinary account keeps as many private views and playlists as it
likes; what it cannot do is put one in everybody else's list.

This is a deliberate narrowing — every account could share before — and the reason is that
"shared" has to be able to mean something. A shared collection is one the house offers, and the
owner's pin on it becomes the default in everybody's sidebar (below); that is not authority to
hand to every account on an internet-facing library.

**Unsharing is not privileged the same way.** Whoever owns a collection can always make it
private again, whatever scopes they hold. Otherwise an administrator who lost the scope would
leave something shared that nobody could withdraw — the same shape of trap as the
last-administrator rule in §12c, and avoided the same way.

The UI hides the control rather than disabling it, per the house pattern. The service is where
the rule is true.

### A pin means three different things, and all three are needed

`Playlist.pinned` and `SavedFilter.pinned` are the **owner's** columns. On a private collection
that is their own sidebar and nothing more. On a _shared_ collection the owner is an
administrator, so their pin is the **household's default** — the curated baseline a new account
arrives to.

That alone would make the default permanent and hand one person everybody's sidebar, so
`CollectionPin` holds a per-viewer override. It is keyed `(userId, kind, collectionId)` and
**the absence of a row is one of its three states**:

|                  | Meaning                                   |
| ---------------- | ----------------------------------------- |
| no row           | no opinion — follow the household default |
| `pinned = 1`     | I want this in my sidebar                 |
| `pinned` IS NULL | I have taken this out of my sidebar       |

So the row says _that_ somebody decided and the column says _what_. This is the one place in the
schema where a NULL boolean and a missing row differ, which is exactly why "clear my decision"
needs its own spelling in the API: `PUT .../pin` takes `pinned: true | false | null`, and `null`
is not a synonym for `false`.

`resolvePin` is the whole rule, and the order of its branches is the rule:

1. **The viewer's own decision wins.** Whatever the house says, somebody who has pinned or
   unpinned a collection has said where they want it, and an administrator repinning must not
   move it back.
2. **Otherwise a shared collection follows the owner's pin**, which is what makes a curated
   baseline possible at all.
3. **Otherwise it is yours or it is nowhere**, and the owner's pin means only what it always
   meant.

`curated` travels with `pinned` in the response because the two look identical on screen and
decide what an unpin control means: removing your own bookmark, or opting out of something the
house offered. It is false on your own collections and false once the viewer has decided
anything, since telling somebody the house chose what they chose themselves would offer to undo
their own gesture.

**Pinning is not editing.** It needs only the right to _see_ the collection, which is why
`setPlaylistPin` and `setSavedFilterPin` go through the readable gate rather than the writable
one, and why the pin is its own route rather than a field on the PATCH that edits a collection —
one endpoint with two authorization rules is how the weaker one gets applied to both.

### Ordering, and why the service re-sorts what the repo ordered

Both repos order by the **owner's** pin, which is all SQL can see without joining a per-viewer
table into the most intricate query in each file. The service applies `resolvePin` and re-sorts:
your own first (as the repo's `ORDER BY (ownerId = :userId) DESC` has always done), then this
viewer's pin, then position, then name.

Deleting a collection clears everybody's pin on it. Those rows are somebody's data rather than a
cache, and nothing else would ever remove them; there is no foreign key to do it automatically,
because `collectionId` names a row in one of two tables depending on `kind` and SQLite cannot
express that.

### What is shared between them in the UI

- `CollectionSections` — yours, then the household's, with one wall geometry. Both pages had
  grown their own copy and the wording had already diverged.
- **`/collections` is the only index for either kind**, and it is where a playlist is made. There
  was briefly a second one: `/playlists` listed half of what `/collections` lists, from its own
  sidebar entry, directly under an entry called Collections — a hierarchy nobody could explain,
  and two pages that would have had to be kept saying the same thing. It is gone. A playlist
  keeps its _own_ page at `/playlists/:id`, because a hand-ordered list is not expressible as an
  address into the grid the way a query is; that page's back link points here, so arriving from
  Collections and pressing back returns to the page you left rather than to a lesser copy of it.
- **The pinned rows in the sidebar are one list, not two.** A heading called "Saved" carried the
  pinned views and the Playlists entry doubled as a heading over the pinned playlists — with the
  Collections entry between them insisting the two were one thing. Kind is now a mark on the row
  (`▽` a view, `≡` a playlist) rather than a section it sits in: it is a property of the
  collection, and saying it per row is what lets the list keep one order.
- That order is **alphabetical**, which is the only order a reader can predict across two
  sequences. Each kind's `position` counts from zero independently, so merging on position would
  interleave two arbitrary sequences and present the result as an arrangement. Cross-kind
  ordering is what the reordering UI below would have to supply.
- **The index is labelled by what is in it: "Views & playlists".** It was labelled
  "Collections", which is our word for the pair and not one anybody looking for a saved view
  would guess, so an unpinned one was reachable and still not found. The sidebar entry, the
  page's title and a playlist's back link say "Views & playlists"; the route, the code and this
  document keep "collection". **"N more…" under the pinned rows** leads there too, whenever
  some collections are not pinned: one row and a count, not the rows themselves — listing them
  is the unscannable sidebar pinning prevents — so the sidebar no longer looks like everything
  there is.
- **The index is the only list of every view, so it is searchable.** The library's ⋯ menu used
  to list every saved view as well, and was where people actually went to open one. It could
  not list playlists (the grid cannot open a hand-ordered list), and at eighty views it ran off
  the bottom of the screen with the current view's rename, pin and delete beneath it. The list
  is gone: the ⋯ menu is housekeeping for the view you are on and appears only on one. The page
  took the job with a search over names and descriptions (every word, any order) and All /
  Views / Playlists tabs counting what each would show. Filtered on the client — both lists
  are already on the page and a person keeps hundreds at most — and kept in the address
  (`?kind=&q=`), remembered like every other list page, so Back, the sidebar and a playlist's
  back link return to the same search. The row is pinned under the header on a wide screen,
  as the library's is, and scrolls away on a phone.
- **And it browses like the performer page**, because it is the same kind of page: a long list
  of named things somebody recognises by a glimpse. The same toolbar in the same order
  (`BrowseToolbar`, §6 "Tags"), so each control is where the other page taught somebody to look:
    - **A–Z or Recently changed.** Not "Most items": a view's count is a scan of everything it
      matches, and nothing pays that for a number in a list (§20).
    - **Rows or tiles, rows by default**, for the performer page's reason — hundreds scan
      downward. A row is the performer page's row (`FilmstripRow`): the name, the facts and the
      description, then up to eight covers; a tile is the mosaic card. A row's frames open the
      collection rather than the item: a collection's covers are its face, not a range to step
      along.
    - **Pinned only**, where the performer page has Favourites only — a pin is what marks a
      collection as one somebody reaches for.
    - **No Reshuffle.** A view's face holds still on purpose, so it can be recognised.
    - **A ⋯ on every row and tile** (`CollectionMenu`), as a performer row has: pin or unpin on
      anything this viewer sees, rename and delete on their own. On your own the owner's pin is
      written; on somebody else's, this viewer's (`CollectionPin`), so taking a curated view out
      of your sidebar leaves everybody else's alone.

`Playlist` also gained `UNIQUE (ownerId, name)`, which `SavedFilter` has had since it was
written. Three playlists called "Christmas" are indistinguishable everywhere they are listed.

### Still open

- **Reordering a curated collection** is storable (`CollectionPin.position`) and has no UI. The
  column is there because it is the same write as the pin and adding it later would be another
  `db:reset`; nothing sets it yet. It is also now the answer to the sidebar's ordering: one
  position per pinned collection, counted across both kinds.
- **Unpinning happens away from the sidebar**, by design: the pinned rows are links and nothing
  else, because a row that could also be dismissed is a row with two gestures on it and the one
  people want is always the link. It is now one step away rather than a hunt — the ⋯ on the
  collection's row or tile on Views & playlists, or on the open view.

### A view's face

The card said what a view asks rather than showing what it holds, on the grounds that drawing
four thumbnails would run every stored query on every page load. That was already untrue as a
cost: every pinned view is a home shelf (§6), and the room runs each one's query on every visit
— first page, ids only, never counted — and is affordable because an ordered query walks an
index and stops at its limit. A face is the same work at two dozen ids — a row's strip of eight
covers, oversampled — where a shelf asks for a shelf's worth.
What would not have been affordable is doing it for _every_ view at once, so it is not:

- **Per card, as it comes near the screen.** `GET /api/filters/:id/covers`, asked by `ViewCard`
  through `useNearViewport`. A page of eighty views costs the dozen somebody can see. The
  covers do not travel with the list, as a playlist's do, because a playlist's members are a
  lookup and a view's are an answer.
- **A shuffled view shows its newest items.** A face that changed on every look could not be
  learned, and a shuffle cannot stop early — it would be the one face that read the whole
  matching set.
- **The walk is remembered for ten minutes, the hydration never.** The ids sit in the same
  per-process cache the room's shuffled samples use (`createTtlCache`), keyed by viewer,
  libraries, overlay and query, so an edited view is a new key. Every request hydrates them
  again through `listByIds`, so a face never shows anything trashed or hidden since; it can only
  be behind on what newly matches.
- **No face is not an error.** A view this viewer cannot see, one whose query no longer parses,
  one that matches nothing or nothing with artwork yet: the card shows its terms, which is the
  next most useful thing to see. Until the answer arrives the panel is the bare well, so a face
  replaces nothing on screen.
- **No table and no job.** A stored face would need a migration, a staleness rule, and one copy
  per viewer for any view that asks about whoever opens it.

The one cost this does not bound is a view that matches very few items under a sort that does
not help find them — the walk can cover much of the sort's index before it has a dozen. The
room has always had the same exposure for pinned views; if one turns up, the remedy is for that
view, not for faces.

Playlists, reels and views now share the mosaic (`coverMosaics`, `CoverMosaic`): one lookup for
every card's candidates, access applied by `listByIds`. A playlist and a view carry up to eight,
for a row's strip; a card shows four of them, or what stands in for them.

## 14d. Clips and reels

A **clip** is a span of one item, marked by one person. A **reel** is an ordered arrangement of
spans. Both were in the schema from the baseline with no repo, no service and no UI; this is
what they became, and the half that is still only designed is at the end.

A reel plays **virtually**. There is no rendered file, no ffmpeg and no new job: the player seeks
to each span's in point, stops at its out point, and moves to the next using the two `<video>`
elements §8b already has. Rendering a reel to a file is a real feature and is deferred rather
than rejected — it buys casting, downloading and an artefact that outlives the app, and it buys
none of them for somebody who wants to watch their holiday.

### A clip is private raw material, and a reel is what grants the read

This is not §9's rule for captures, and the difference is deliberate.

A capture is library-wide to read because a good still of an item is good for whoever looks at
it. A clip is a **working note about where something happens**, and most are never used.
Listing everybody's working notes over every item would make the item page and the browser worse
for everyone, so the read has two doors and only one of them is shared:

- `/clips` and the strip under the player show **your own** clips. `clipRepo.listForMedia` and
  `clipRepo.search` take `userId` as a query parameter rather than filtering after the fact, so a
  caller cannot read somebody else's spans and then forget to compare.
- **A reel entry is readable because the reel is readable.** `clipRepo.listByIds` is the one read
  here with no viewer filter, and `reelService.readable` has already decided.

Clip ids are not sensitive — they travel in a shared reel's entries — but nothing lists another
person's clips anywhere.

### A reel holds only its owner's clips

`Reel.ownerId == Clip.userId` for every `ReelItem`, enforced in `reelService.addReelItems` and
again in the repo's insert. Nothing in the UI can offer the refused case, because `/clips` lists
only your own; it is a guard on the API surface.

It is worth stating separately because of how much it **removes**:

- Deleting a clip can never shorten a stranger's reel, so there is no argument to have about
  cascade versus refusal.
- "Used in 3 reels" can always name all three. There is no "and 2 you cannot see".
- A shared reel's spans all belong to the person already named on the reel, so an entry carries
  no author of its own.

**It is a service rule rather than a composite foreign key, and the reason is specific.** The
textbook move — `UNIQUE (id, ownerId)` on `Reel`, `UNIQUE (id, userId)` on `Clip`, an `ownerId`
on `ReelItem` referencing both — would make the invariant true of the table. It is rejected
because `Clip.userId` is **nullable**: SQLite treats a composite foreign key with a NULL
component as satisfied, so the constraint would lapse for exactly the rows where it is subtle,
namely a clip whose author's account has been deleted. A guarantee that switches itself off in
the interesting case is worse than an explicit check with a test on it.

`mayAlterOwnWork` in `lib/services/collectionAccess.ts` still governs editing and discarding, and
after the invariant it has one case left: an **unattributed** clip — `Clip.userId` is
`ON DELETE SET NULL`, so a clip outlives the account that made it — sitting inside a shared reel
that still plays. That one is an administrator's. Without the rule, deleting an account would
either break reels or hand that person's spans to everyone.

That file also now holds `assertMayShare`, which existed **twice, verbatim**, in
`playlistService` and `savedFilterService`. §14c claimed it was "the same function, word for
word"; it was two copies that happened to agree, which is the drift §14c was written to stop. A
third copy for reels was the obvious shortcut, so removing the temptation came first.

### A reel is not a collection, and `/reels` is not the `/playlists` mistake

§14c deleted a second index page once already: `/playlists` listed half of what `/collections`
listed, from its own sidebar entry, directly underneath it. A reader will pattern-match `/reels`
to that, so the distinction has to be written down.

`/collections` keeps its exact current meaning and its exact current contents. A collection is a
**way back into the library** — a query or a list of items — and there are few enough to pin. A
reel is a **work**, made of spans, and there will be hundreds. The two share no rows, so nothing
has to be kept saying the same thing.

What a reel takes from §14c is the **sharing rule**, unchanged: `visibility` is
`private | shared`, `SHARE_SCOPE` is `admin`, unsharing stays unprivileged so nothing can get
stuck shared, and `writable` is the owner alone — not an administrator, who manages the library
and not other people's work (§6).

What it does not take is the pin machinery: no `pinned`, no `position`, no `CollectionPin` row,
no `resolvePin`, no `curated`, and no place in the sidebar's merged list. `CollectionKind` stays
`"filter" | "playlist"`, and **not widening that CHECK is the one thing here that would have been
expensive to get wrong** — a CHECK value cannot be altered in SQLite, so adding one post-release
is the twelve-step table rebuild.

Numerousness is also why `/reels` is a page with a sort, a filter, a search and paging rather
than a wall with two sections. `CollectionSections` stacks "yours" above "the household's", which
reads perfectly at a handful each and hides the second section entirely at a screenful — so
ownership is a control here, not a layout.

Captures (§9) sit beside Reels and Clips in the nav for the same numerousness reason. They are
your own work and there will be hundreds, so they get an index with sort, search and paging,
and they are not a collection either.

The search is `LIKE` over name and description. §5c's argument against a trigram index — it
doubles the index for a case prefix search handles — applies with far more force to a few hundred
short names than it does to the library, so nothing here earns a second search table.

### Keeping a few hundred clips usable

The working case is a reel of a holiday: forty spans marked across dozens of videos over weeks,
gathered afterwards. Four things make that possible, and the first changes the feel of the page.

**A clip's face is free.** Every video already carries a scrubber sprite sheet — a tile every few
seconds, generated for the filmstrip and paid for whether or not anything else uses it — so a
clip's thumbnail is a crop out of one. No ffmpeg, no `Artifact` row, no disk, nothing for
`db:reset` to clear, and usually a sheet the browser has already fetched for the same item. The
tile is found by arithmetic in `spriteThumb.ts` rather than by parsing the VTT: `cueAt` is right
for the player, which has already downloaded the cues, and wrong for a list that would otherwise
read a file per row. Null is ordinary — a freshly scanned item has no sheet until the `sprite`
stage runs — and the caller falls back to the item's cover.

**Cards, not rows.** A clip is a picture of a moment: the thumbnail is what anybody recognises
it by, and a row gives that the least space while spending the most on horizontal rules. The wall
reads at a glance the way the shelf of reels does, which is what makes forty of them something to
scan rather than read. Everything that is not words sits on the picture — the running time and the
speed in one corner, the selection box in the other, each on its own scrim, because a frame can be
any colour and an unchecked outline disappears against half of them. The crop is expressed in
percentages rather than pixels so a card can size itself: a fluid grid does not tell a component
its width in advance, which is the one thing a pixel crop needs.

**The selection bar holds its space.** It used to appear when the first clip was ticked, which
pushed the whole wall down at exactly the moment somebody was working along a row clicking
several — the next card was no longer under the pointer, and the click that followed landed on
whatever had slid into its place. A control that rearranges the thing it acts on is worse than one
that sits there looking empty. It costs nothing to keep, because it _is_ the select-all row, which
was already permanent; what a selection changes is the wording and whether the buttons do
anything, never the height.

**Cards, not rows.** A clip is a picture of a moment: the thumbnail is what anybody recognises it
by, and a row gives that the least space while spending the most on horizontal rules. The wall
reads at a glance the way the shelf of reels does, which is what makes forty of them something to
scan rather than read. Everything that is not words sits on the picture — the running time and the
speed in one corner, the selection box in the other, each on its own scrim, because a frame can be
any colour and an unchecked outline disappears against half of them. The crop is expressed in
percentages rather than pixels so a card can size itself: a fluid grid does not tell a component
its width in advance, which is the one thing a pixel crop needs.

**One toolbar, and it holds its space.** Filters on the left, what to do with the selection on the
right, in a single sticky row. These were two rows with labels over the fields, and between them
they spent more height on chrome than a row of cards spends on clips; "Sort" over a control
reading "Recently marked" is a line of type to say what the control already said. The selection
half used to appear only once something was ticked, which pushed the whole wall down at exactly
the moment somebody was working along a row clicking several — the next card was no longer under
the pointer, and the click that followed landed on whatever had slid into its place. A control
that rearranges the thing it acts on is worse than one that sits there looking empty.

The same rule had to be applied **sideways**, and it was missed the first time. "Clear" appeared
with the first tick and "2 clips" grew into "2 selected", both of which widen the right-hand group
and walk the select-all box leftwards — so clicking select-all moved select-all, and the click
after it landed somewhere else. The button is always drawn and disabled rather than conditionally
rendered, and the status sits in a box of fixed width that clamps. What a selection changes is the
wording and whether the button does anything, never a position.

**There is no "Clear" button, and the checkbox does both jobs.** It was clutter of the plainest
kind: the box is already ticked or half-ticked whenever there is anything to clear, and unticking
a ticked box is the first thing anybody tries. So ticking takes the page and unticking drops the
whole selection — the more useful half, since it also catches clips picked on a page that has
since been paged away from, where clearing only the current page would leave a count nothing on
screen accounts for. The direction is keyed off what the box _looks_ like rather than off the
selection, so it never does the opposite of what it appears to offer.

The library grid keeps its own Clear (`SelectionBar`), deliberately: there it is one control among
rating, tagging and deletion, where the proportion of clutter to use is completely different.

The status slot **reports rather than instructs**: the count of what the filter matches when
nothing is picked, the number picked when something is, and what just happened after an add. It
briefly read "Select clips to gather them", which is a caption explaining the button beside it —
and a disabled "Add to reel" says that much on its own.

**Grouped by source item**, collapsible, with a flat toggle. Two hundred rows is unreadable;
thirty videos holding a few spans each is navigable, and it matches how they were made.

**"Not in a reel yet", and a reel as a target.** `reelCount = 0` answers "what have I not used?",
and picking a reel turns every row into a membership toggle — so the browser _is_ the reel's
editor rather than a place to copy out of. The target list is ordered by most recently updated,
because the reel being filled is nearly always the one just made.

**Label autocomplete over your own past labels.** Typing "be" offers "beach", so a clip's name is
offered rather than retyped. The label is a title; the facets the browser filters on are tags
(below).

### Tagging clips

Labels were meant to converge into de-facto tags by reuse, and stopped being enough at the first
reel that cut across videos: "the kids jumping into pools" needs who, what, and something true of
the source video, and one free-text slot holds one of them. So clips take tags.

**One vocabulary, a separate assignment.** `ClipTag(clipId, tagId, position, batchId)` beside
`MediaTag`, against the same `Tag` table. "Mia" on a clip is the tag "Mia" on a video, so a rename,
a merge, an alias or a publish reaches both, and autocomplete is one list. A separate vocabulary
was the alternative and was rejected: "pool" twice, with nothing to merge them and two lists to
keep tidy.

**Performer and keyword, never source** (`clipTagKinds`). Where something came from is a fact
about the whole video, and the browser already searches the video's tags as a field of its own. A
list in code rather than a CHECK, so widening it is an edit.

**No `userId` on the row.** A clip is private raw material, so every assignment on one is for the
clip's owner, and a column restating that would be a copy free to drift. The §6 pairing is kept
against the clip instead — a tag with an owner goes only on that owner's clips — in
`clipTagRepo.assertFits`, for the reason the item pairing is in `tagRepo`: it spans tables. A
public tag on a clip is still seen by the owner alone; "shared" there says whose word it is, and
the UI says so once, where the choice is made.

**Seen by the owner, never through a reel.** `clipsByIds`, the reel's door, returns no tags: a
shared reel grants the span, not its owner's filing of it. Only the owner writes them —
`mayAlterOwnWork` would let an administrator retime an unattributed clip, and tags written there
would be written for nobody.

**Two search fields, strict by default.** /clips filters on **Video has** (the library's own tag
predicate, pointed at `c."mediaId"`) and **Clip has** (`ClipTag`), each with the filter panel's
three-state chips and all-of/any-of. "Video has: pool, Clip has: jumping" is the pool reel. A clip
does not inherit its video's tags: a two-hour video tagged "Mia" says nothing about which span she
is in, and inheriting would make every clip of it match. Where that is what somebody means, the
**"or its video"** toggle widens one clip-side pick at a time (`orVideo`); on a without, it means
neither the clip nor its video. The fields are flat id lists rather than `FilterGroup`s, which
carry rules that mean nothing to a clip and would carry `orVideo` into `MediaQuery`.

**Tagged three ways**: while marking (the clip bar sends them with the save), in the clip editor
(chip by chip, queued like an item's), and on a selection in the browser as one `TagBatch` with
`clipCount` set, withdrawn by the same route as a batch of items. A clip batch writes no public
`MediaTag`, so it is never on an administrator's list (§5d) — it is its owner's alone, like the
clips. The bar's tags start empty for every span: carried over from the last, they would be wrong
as often as right, and silently so.

**What it does not do.** Clip tags are not in any search document; the browser's text box stays a
match on the label. The library's own filter does not gain "has a clip tagged…" — the clip browser
is where clips are found. And a reel is still built by ticking and adding: a query-backed reel
would refill itself in no particular order, and a reel's order is the cut.

### A clip carries a speed, and it changes what a duration is

`Clip.speed` is `NULL` or a multiplier between 0.25 and 4 — the range the player's own rate
control offers, because a rate the element refuses is not a span anybody can watch.

**NULL rather than a stored 1.0**, which is the same NULL-means-undecided the schema uses for
`Playlist.sortMode` and `MediaQuery.direction`: a stored 1.0 cannot be told from a deliberate
one, and the badge in the strip is drawn for a speed somebody chose.

**It multiplies with the viewer's rate rather than replacing it.** A clip's speed is part of the
cut — "this bit is meant to be slow" — while the rate control is about how fast somebody is
getting through the reel in front of them. Letting the clip's speed replace the viewer's takes
the control away inside exactly the spans people most want to slow down further; letting the
viewer's replace the clip's discards what the author arranged. `effectiveRate` clamps the
product, because half speed watched at a quarter is an eighth, which the element refuses outright.

**Every duration in the app is a run time, not a span length.** Twenty seconds at 0.5× is forty
seconds of somebody's evening, so the reel card's subtitle, the `duration` sort, the browser's
column and the progress readout all use `spanRunMs`, and `reelRepo` transcribes the same
expression into SQL. Summing raw spans is the mistake waiting to be made: it is right in the
common case where every clip is 1×, so it would be wrong only on the reels somebody took trouble
over.

### Playing a reel: three things §8b did not have to know

**The warmed element must be seeked to its in point.** `preload="auto"` buffers from
`currentTime`, which is zero, so warming a two-hour file for a span that begins at 01:40 buffers
its opening titles — the wrong thirty seconds, and the join stalls exactly as if nothing had been
warmed. Stepping through the library never noticed, because there the next item starts at its
beginning. This is the single detail that decides whether warming helps a reel at all.

**`videoSlots.ts` did not change, and the tempting fix is wrong.** The instinct is to key a slot
by the reel item, since one media id can appear twice in a reel — which the working case
guarantees, several spans coming from the same afternoon's video. That is backwards. Keyed by
media id, a reel of A, B, A finds slot 0 still holding A when it comes back: nothing is rebuilt,
the buffer survives, and the join is a seek or a swap onto a warm element. Keyed by reel item,
slot 0 would hold "item 1", the reel would want "item 3", and React would rebuild the element and
download a file that never changed. The slot layer's question is _which element has file X open_;
the reel's position lives in `ReelPlayer`, which is the only thing that needs it. What the module
gained is `advanceTo`, which names the three transitions — `seek`, `swap`, `cold` — that were
implicit while every next item was a different file.

**Arriving at a span starts it, and reaching its end stops it.** Both halves shipped missing and
both looked like different features failing. The arrival used to seek and set the rate and stop
there, so "preview this clip" moved the playhead under a picture that never started — a button
that had visibly half worked. And the out point used to notify without pausing, leaving each
caller to decide what that meant: on an item page nothing did, so a preview ran on into the rest
of the film, and in a reel the only thing that ever halted the overshoot was the next span's
seek. So the player owns both: `watchOutPoint` pauses before it calls back, and the arrival
effect plays. A reel's advance is then a pause and a play a seek apart, and an item page's
preview simply ends.

**A span carries a token, because two consecutive spans can be identical.** The arrival is keyed
on the span, and timecodes alone are not an identity: a reel may hold the same clip twice, which
is a refrain and a legitimate cut, and pressing preview again on the clip that has just finished
is the same request twice. Keyed only by `startMs` and `speed`, neither re-arrives — the effect
never re-runs, the one-shot latch in `watchOutPoint` is never rebuilt, and the second press does
nothing at all. The reel passes the `ReelItem.id`; the item page passes a counter.

**The frame is held across a join, because the incoming element may have nothing to show.** The
warmed element being seeked to its in point fixes the join only when there _is_ a warmed element.
When there is not — warming refused, or the next file's metadata had not arrived, which a
two-second opening clip and a fifty-megabyte MP4 with its index at the end make ordinary — the
incoming element is cold, has no decoded frame at all, and the browser paints the poster or black:
the first frame of the next video, before it has seeked anywhere.

Keeping the outgoing _element_ on screen is the obvious answer and does not work: the hidden slot
is a one-pixel transparent box, and `assignSlots` empties it whenever there is nothing worth
warming, so the element holding the frame is often unmounted by the time the swap happens. What
survives is a **copy of its last frame**, drawn to a canvas while it is still there — one
`drawImage` per join, from a same-origin element, at the one moment nothing else is happening.
`freezeRef` is how the reel asks for it, handed downwards like `seekRef` because only the player
owns the element and only the reel knows it is about to change what is playing. It is released the
moment the new element has a decoded frame **at its in point**, and after four seconds regardless,
because a file that stalls should cost one bad join rather than leave a still standing in for a
video.

**The bar measures the reel, and a reel can end.** Both were missing and the three complaints
they produced looked unrelated: the bar was inaccurate, there was no way to start again, and
pressing play at the end kept going.

The bar was measuring whichever _file_ the current span came from, so a reel ending on a clip cut
from the middle of a long video finished at a puzzling 88% and every join made it jump backwards.
It now measures the reel: `timeline` gives the player the run time before the current span and the
run time of the whole thing, and `locateInReel` maps a position on it back to a span and an offset
inside that span — the same conversion `spanRunMs` does, read the other way round, which is why it
lives beside it in core rather than in the component.

It was briefly **read-only**, on the reasoning that dragging a bar spanning the whole reel would
have to mean either scrubbing one span or seeking across them, and that the strip of spans was
enough. That was wrong twice over: a bar that fills as you watch is a bar people expect to drag,
and with no way to move in a reel there was no way to watch one a second time.

And a reel **ends**, which is a fact the player cannot work out — a file ends at its own end and
the element knows, while a reel ends when its last span does. Without being told, the element sat
on the last out point and the transport still said "play", so pressing it resumed the underlying
file straight past the out point and ran on through the rest of whatever that clip was cut from.
Now the last span sets `atEnd`, the transport becomes **replay**, and `outPoint.ts` refuses on its
own account to let a finished span resume — the useful behaviour comes from the reel, but the
guarantee that a span never outlives its out point belongs to the thing that owns the out point.

**The out point needs three layers.** `timeupdate` fires at roughly 4 Hz, so it overshoots by up
to a quarter of a second, and at 2× by half. On a whole film that is invisible; on a twelve-second
span it lands on the join, which is the one frame of a cut anybody looks at. So `outPoint.ts`
uses `requestVideoFrameCallback` where it exists (one call per presented frame, so within a
frame), a timer armed for the remaining wall clock otherwise, and a `timeupdate` comparison as an
unconditional backstop under both. The rate division is the part that is easy to forget and is no
longer rare: a half-speed span whose timer was armed as if it were 1× fires twice as early and
cuts the span in half. The rVFC body does one float comparison and no `setState`, or the page
re-renders at frame rate.

**Known limits.** In a background tab no frames are presented and timers clamp to the second, so
a reel left in the background overruns its out point by up to a second — bounded by the backstop,
and acceptable, because nobody is watching. And a forward seek within the _same_ file past the
buffered window is a fresh range request plus a decode from the preceding keyframe. The available
trick — putting one file in both elements at different offsets — doubles the decoder count and
puts two seek-heavy readers on one platter, which is the stutter §8b's warming gate exists to
prevent. Not built.

### A reel is its own page, and writes no history

`/reels/:id` plays through; a reel is **not** a `ViewerSet`. `viewerSequence.ts` is built on
finding a media id in a page of ids, which is ambiguous the moment a reel holds one item twice;
`/media/:id` is a page about one item — title, rating, tags, note, captures — and a span has none
of those; and §14b's "a position in a set" is about resuming, back links and stepping, while a
reel is something you press play on and watch to the end.

**`reportProgress` is false in reel mode, and that is not a nicety.** `VideoPlayer` marks an item
watched after thirty seconds of uninterrupted playback and remembers where it was left for the rest
of the visit, so a reel of twenty spans would otherwise mark twenty films watched and reopen each
in its _middle_ — from a viewing that was never about any of them. The gate is inside `reportView`
and `keepPosition` rather than at each of their call sites, so a new one cannot forget it.

**A reel does not shuffle.** A playlist's order is a convenience somebody arranged and shuffle is
a second order laid over it for a while (§14b); a reel's order _is the work_. The test of that is
the deferred renderer, which would have to answer "does the export shuffle too?" with two wrong
answers. Mechanically it would buy nothing either: `shuffle.ts` exists to make any _page_ of a
permutation addressable without a sort, and a reel is played in one pass from position zero.
What a reel gets instead is **loop**, which is what people actually want from a highlight reel,
device-local and writing nothing.

**A span that cannot be played is skipped with a notice** rather than left on a black rectangle.
`directPlay` is computed server-side for every entry, which is why `GET /api/reels/:id/items`
returns entries rather than clip ids: when this was built the verdict lived on an item's detail
and not on a list row, and a reel cannot pay a round trip per span. It is on list rows now
(§14g); the reel still computes its own, since its entries are clips rather than list rows. On-demand HLS is the one outstanding
phase-3 item, so until it lands a reel assembled from unconverted files will mostly skip.

**The reel is read whole, never paged.** Paging it would make the player ask a second question
part way through, which is the one moment it must not; `REEL_ITEM_LIMIT` is what makes that
promise affordable.

### The span is the single source of truth, and the cost is paid in notice

`ReelItem` holds a `clipId` and no timecodes. Retiming a clip therefore changes every reel
holding it — and by the owner invariant, every one of those is the editor's own, so the cost can
be shown rather than absorbed:

- The edit dialogue names the reels, in full, before the press.
- The confirm button reads "Change it in 2 reels" rather than "Save".
- Both are **absent at zero**, because a warning that is always there is a warning nobody reads,
  and most clips are in no reel at all.
- Passively, `runningMs` is derived live, so a span somebody shortened makes the reel visibly
  shorter next time it is opened.

Not built, deliberately: a "changed since you last looked" marker, which needs a table and a
write on every page open to say what the running time already says.

**Deleting a clip cascades, with a sentence.** This was the hardest question in the design until
the owner invariant removed it. Pure cascade would have removed content from a stranger's reel
with no notice; refusing would have been worse, because reels can be private, so a refusal hands
a veto to an object the deleter cannot see and a refusal you cannot act on is worse than either
outcome. With the invariant there is no stranger's arrangement to protect, so the foreign key
keeps `ON DELETE CASCADE` and `clipService.deleteClip` reads the affected reels, deletes, and
**renumbers each of them** in one transaction.

**Positions are dense, and two cascades break that.** `ReelItem` rows leave through a foreign key
— purging an item (§10c) and forgetting a library both delete `Media` — without going through
`reelRepo.removeItem`, so nothing else closes the holes, and a hole makes "3 of 12" a number that
can exceed twelve. `trashRepo.purge` collects the affected reels **before** the delete, while
there is still a clip to join through, and renumbers after; `mediaRootRepo.remove` deletes every
orphan in one statement and so has no single id to collect against, and uses
`reelRepo.renumberGapped` instead.

**`ReelItem` has no `UNIQUE` on `(reelId, position)`, and that is load-bearing.** `PlaylistItem`
has only a plain index for the same reason: renumbering runs
`UPDATE … SET position = position - 1 WHERE position > ?`, SQLite does not define the row order
of an UPDATE, and against a unique index that statement can collide with itself part way
through. The failure would be an intermittent constraint violation on a removal, which reads as a
database fault rather than as a schema decision. There is no `UNIQUE (reelId, clipId)` either: a
refrain is a legitimate cut, which is also why `removeItem` and `moveItem` name a `ReelItem.id`
and not a clip id.

### What eliminating a duplicate costs

§10c's list of things that are deliberately not merged includes clips, and the reason holds
unchanged: a timecode is a claim about one file's timeline, and the copies in a near-duplicate
group do not share one. Moving a span onto a different encode would point it at the wrong frames,
which is a silent wrong answer — worse than a visible loss.

Three things follow now that clips exist.

**Exact duplicates are unaffected**, and that is the reassuring half: §5's first key decision
already resolves exact copies to one `Media` row, so a clip is attached to the logical item and
survives file churn, renames and moves between roots. Only near-duplicate elimination can cost
anything.

**Nothing is lost at trash; it is lost at purge.** `Clip.mediaId` cascades from `Media`, and
`Media` survives the trash — `trashRepo.purge` is the only thing that deletes it — so trashing a
near duplicate leaves every span intact and restoring brings them back, which is what §10's
promise that an item returns "with everything attached to it intact" requires.

**The reviewer is told, where §10c says the warning belongs.** `MediaDetail.duplicate` carries
`clipsAtRisk`, and the delete confirmation says how many spans are on this copy, how many are the
reader's, which of their reels would be shortened, and that purging is when it happens. Their own
reels can be named because of the owner invariant; everybody else's clips are a bare count, since
a count of spans discloses nothing and destroying work with no notice at all is the worse failure.

### A limit worth stating

Invalidation is per browser. Retiming a clip corrects the editor's own caches; another viewer
with that reel open keeps the old span until they refetch. §13b's ChangeLog and SSE is the
mechanism that would close it — `entity` would need a `clip` member — and that is a §13b change
rather than a phase-7 one. A reel is watched far more often than a clip is retimed.

### Designed and not built

- **Rendering and export.** A `reelRender` job concatenating the spans, per §9's
  segment-then-concat pattern: `apps/worker/src/media/clips.ts` already does exactly this for
  hover previews, and `renderPreview`/`concatenate` are the model — including _why_ each segment
  is encoded separately, because a `trim`/`concat` filtergraph makes ffmpeg decode the whole file
  to reach the last segment. It needs `setpts` and `atempo` for a span carrying a speed, which is
  the part that makes `Clip.speed` worth having in the schema now rather than later. Output under
  `/data/reels` with a §13d classification, and the `state`, `outputRelPath` and `lastError`
  columns and `ReelItem.transition` returning with it — dropped from the baseline because
  `ALTER TABLE ADD COLUMN` is the one schema change SQLite does natively, so reintroducing them
  is one line, while `state NOT NULL DEFAULT 'draft'` in the meantime is a field a UI would
  render, saying "Draft" for ever about a reel somebody finished. `reelRender` stays reserved in
  `jobKinds` for the opposite reason: that is a CHECK-constrained vocabulary, where reserving a
  word costs a line and adding one after release costs a rebuild.
- **`preservesPitch`** is left at the browser's default, so a span at 0.25× or 4× has audible
  artefacts. A per-clip mute would be the fix.
- **Warming the same file into both elements** at different offsets, for two spans of one file
  separated by more than the buffered window — the reel's own entry list can detect that case.
- **A `?at=` deep link** into a position in a reel.

## 13. Backup and durability

- WAL mode; nightly `VACUUM INTO /data/backups/YYYY-MM-DD.db`, keeping N.
- **Sidecar export** — tags, ratings, clips, playlists, and collections written periodically
  as JSON into `/data/sidecars`. If the database is ever lost, rescan + import restores
  everything human-authored.
- Covers, sprites, and transcodes are explicitly disposable and regenerable.
- Migrations run in a transaction at boot, with a DB snapshot taken first.

## 13b. Live updates — the grid updates itself

The library should behave like Plex: files appear as they are scanned, thumbnails fade in as
they are generated, and a transcode finishing flips an item from "processing" to playable —
without anyone pressing refresh.

### Mechanism: a change feed plus SSE

The awkward part is that the process which _knows_ about changes (the worker) is not the one
holding the browser connections (Next). The rule from §2 still applies — they communicate
through the database, not HTTP — so the notification path is:

```
worker  ──writes ChangeLog row in the same transaction as the change
                      │
Next    ──one poller reads ChangeLog every ~1s, coalesces, fans out
                      │
browser ──EventSource (SSE) ──► TanStack Query cache patch
```

**One poller, not one per client.** A single `SELECT ... WHERE id > :cursor` per second in
the web process serves every connected browser, so cost is flat in viewer count. This is
still polling underneath, but it polls a tiny indexed table in-process rather than making
each browser poll the library.

**Server-Sent Events, not WebSockets.** The traffic is entirely one-way, and SSE gives
reconnection, backoff, and event-id resumption for free in the browser. WebSockets would also
mean a custom server or a second listener, which is exactly the complexity avoided by
dropping Fastify.

### The ChangeLog table

The id is `INTEGER PRIMARY KEY AUTOINCREMENT`, and the `AUTOINCREMENT` is load-bearing rather
than decorative. Without it SQLite reuses the ids of deleted rows — and this table is pruned
hourly, so a browser reconnecting with `Last-Event-ID` set to a reused id would be told there
is nothing new, having silently missed everything written since.

```sql
CREATE TABLE "ChangeLog" (
    "id"       INTEGER PRIMARY KEY AUTOINCREMENT,  -- deliberate exception, see below
    "entity"   TEXT NOT NULL,   -- media | artifact | variant | scan | job
    "entityId" TEXT,
    "rootId"   TEXT,            -- so the feed can be filtered by LibraryAccess
    "op"       TEXT NOT NULL,   -- insert | update | delete
    "at"       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

**The integer autoincrement id is a deliberate exception to the UUID convention** (§18.2),
and the only one. This table needs a _total order_ and a resumable cursor, which a UUID
cannot provide. It also lines up exactly with SSE's `Last-Event-ID`: a browser that
reconnects sends the last id it saw, and the server resumes from there rather than
resynchronising the whole grid. A tab that slept through a scan wakes up correct.

Rows are written **in the same transaction as the change they describe**, so a change can
never be committed without its notification. The table is a feed, not history: rows older
than a retention window (default 1 hour) are pruned by the existing backup job.

### Coalescing is the hard part

A scan of 200k files emits 200k rows. Streaming those to a browser one at a time would melt
the grid and, on a NAS, the box.

The split: **the worker writes fine-grained rows; the web poller decides how much detail to
send.** Keeping the data faithful and the policy on the read side means the thresholds can
change without a migration.

- Below ~25 changes per tick: discrete events, so a single new file appears immediately and
  a thumbnail pops in exactly when it is ready. This is the case that feels alive.
- Above that: one summary event (`{ added: 1240, updated: 33, scanning: true }`), at most one
  per second. The client shows progress rather than a thousand animations.
- Artifact-ready events are never summarised away for items currently on screen — a
  thumbnail appearing is the single most visible sign the app is working.

### What the client does with them — and does not

The restraint matters more than the plumbing. **Never reorder the grid under someone's
cursor.** If 400 files land while a user is halfway down the library, moving what is under
their pointer is hostile.

- **The library grid never inserts on its own.** New items increment a "Show N new items"
  button beside the count, and only clicking it refetches the page (§14b). It used to refetch
  immediately — a page is a fixed window, so nothing scrolls out from under you — but a changed
  window is still the list moving: during a scan a newest-first page turned over every few
  seconds. The room and a playlist still apply as items arrive; neither is a list you are
  working through.
- **What is already on the grid is kept current in place.** A change or removal — a probe
  finishing, a tag, a trash in another tab — makes the grid ask `/api/media/lookup` about the
  items it is showing, debounced so a scan's burst costs one request. Each item that comes back
  replaces its tile where it stands; one that does not has left the library and drops out, and
  the rest of the page closes up behind it. Nothing new is added that way. Trashing records a
  `media`/`delete` change in the same transaction, since otherwise no other tab would hear of it.
- Per-item changes (cover ready, rating, transcode finished) always patch in place via
  `queryClient.setQueryData`, wherever the user is. In-place patches are never disruptive.
- List-level invalidation is debounced (~500 ms) and skipped entirely while a modal or the
  player is open.
- Scan progress renders in a status strip, not as grid churn.

### Every stage that changes a tile has to record it, and one did not

A newly scanned item is a filename and nothing else: the tile reads "processing…", with no
duration, no dimensions and the raw file name in place of a title. The **probe** is what
replaces all of that — and it was the one stage in the chain that finished silently. Covers,
previews and sprites each record an `artifact` row; the probe recorded nothing, so an item stayed
"processing…" on every open page until somebody reloaded. That looks exactly like a library that
has stopped working, which is the failure this whole section exists to prevent.

It records `media`/`update` now, in the same transaction as the metadata. **`update`, not
`insert`**: the row has been in the list since the scanner found it, and an insert is what tells
a client something has _arrived_ — reporting one here would count the same file twice in the
"N new items" the grid offers to apply.

That makes an update the common event rather than a rare one, which changes what the client may
do with it. A refetch is the whole page again, and while a scan inserts items at the top of a
newest-first library, the whole page again is a _different set of items_. So a media update
refetches the list only for a viewer at the top; anyone scrolled away keeps their place and their
unapplied count, and gets everything current the moment they apply it.

### Patching an item into a list that is on screen

`lib/events/patchList.ts`, pure and tested, because the version it replaces was written against
**a cache shape this app does not have**. It patched `InfiniteData<MediaListResponse>` —
`data.pages.map(…)` — under the prefix `["media"]`. There is no infinite query anywhere in the
app: the grid caches one `MediaListResponse` per page under `["media", "list", filter, page]`,
and that prefix also matches `["media", <id>]`, which holds a single item's details. The updater
threw on the first artifact event it ever saw, so **no cover has ever patched into an open grid**
— invisibly, because a tile that says "processing…" looks identical whether the app is waiting
or has stopped listening.

Three things follow from that, and each is now a rule rather than an accident:

- **Patch the caches that exist, named precisely.** `media.list()` for the grid and `home()` for
  the room's shelves, which hold the same items in a different shape and had never been patched
  at all — and the room is where a newly added item is most likely to be sitting when its cover
  is made. Not `media.all()`, which reaches shapes this cannot patch.
- **The patch depends on which artifact finished.** A cover and a preview are not
  interchangeable: an item can have a preview first, and writing a cover URL because a preview
  became ready points the tile at a file that is not there — a broken image where "processing…"
  at least told the truth. A sprite sheet changes nothing a list draws, so lists are left alone.
- **Return the cached object unchanged when the item is not in it.** There is one of these calls
  per cached page; a fresh object from each would re-render the whole grid for an item it is not
  showing.

Playlist item pages are the one list left out: their key puts the playlist id before the word
`items`, so there is no prefix that reaches every such page without also reaching shapes that
have no items at all. They refresh on the debounced invalidation instead.

### Details that decide whether this works remotely

- **Reverse proxies buffer.** Send `Content-Type: text/event-stream`,
  `Cache-Control: no-cache, no-transform`, and `X-Accel-Buffering: no` (nginx; Caddy does not
  buffer by default). Without these the stream arrives in silent chunks or not at all.
- **Idle connections get killed**, so emit a heartbeat comment every ~20 s. Set `retry:` to
  control reconnect backoff rather than letting a restarted container get hammered.
- **HTTP/1.1 allows only ~6 connections per origin**, and an SSE stream holds one open
  indefinitely — three tabs can starve the app of ordinary requests. Serve over HTTP/2 (the
  reverse proxy handles this), and share one stream across tabs with `BroadcastChannel` so
  the connection count stays at one per browser regardless of tabs.

    Which tab holds that stream is decided by the **Web Locks API**, not by a hand-rolled
    leader election. A lock is held for as long as a promise is unresolved and is released by
    the browser when the tab goes away, so a closed leader hands over immediately and nobody
    has to implement heartbeats, stale-lock timeouts, or the long tail of bugs those attract.
    A browser without Web Locks falls back to one stream per tab, which spends connection
    budget rather than breaking the feature.

- **Auth**: `EventSource` cannot set an `Authorization` header, so the stream authenticates
  with the HttpOnly cookie rather than the Bearer token. The alternative — `fetch` with a
  `ReadableStream` — allows headers but means reimplementing reconnection, backoff, and
  `Last-Event-ID` by hand, which is where the bugs live. Cookie plus `EventSource` is the
  better trade.
- **Per-user filtering happens per connection**: `rootId` on each row is matched against that
  user's `LibraryAccess`, so the feed never reveals the existence of media in a root they
  cannot see.
- **Fallback**: if the stream fails to connect (an old proxy, a hostile network), the client
  falls back to a 30 s `refetchInterval`. The app degrades to "updates eventually" rather
  than breaking.
- Connections are capped, and each one holds no database handle of its own.

### Phasing

The `ChangeLog` table goes straight into `init.ts` — we are pre-release (§4), so it needs no
migration, just a `pnpm db:baseline`. The SSE endpoint and client arrive in phase 2, alongside
artifact generation, because that is when live updates become visibly worth having:
thumbnails appearing one by one is the moment the app starts feeling like Plex.

## 13c. Processing progress — what the library is actually doing

A scan is not the thing anyone is waiting for. The walk inserts `MediaFile` rows and enqueues
probes, and for four thousand files it is over in about a minute; the hours that follow are the
job queue working through probe and then six stages. A progress bar bound to the `Scan` row
would therefore fill to 100% and sit there while the app still looked half-built, which is
worse than showing nothing.

So the view is **pipeline progress**, of which the scan is phase zero.

### The two phases have different information, so they get different widgets

This is the decision everything else follows from.

**The walk has no denominator.** `scanner.ts` does not know how many files exist until it has
finished finding them. `Scan.filesSeen` climbs and nothing says toward what. A percentage here
would be invented, which is how progress bars come to be distrusted.

**The stages have an exact one.** Every stage's population is decided by `appliesTo` against a
known library size, so "done out of applicable" is a fact rather than an estimate.

A first scan therefore renders as a counter and every later scan as a bar measured against the
same library's last _completed_ walk (`scanRepo.lastCompletedFilesSeen`). Failed runs are
excluded from that estimate deliberately: a walk that died a tenth of the way through would
otherwise become the baseline, and the next scan would hit 100% almost immediately and stay
there — an answer that is confidently wrong, rather than an honest absence of one.

### Stacked bars, one per stage

Small multiples on a shared scale, in registry order, so adding a stage adds a bar and nothing
else changes. The value is comparative: one glance says covers finished an hour ago and sprites
have not started, which a single aggregate percentage destroys.

The four `MediaStage` states stay separate rather than being collapsed into "done". `empty` —
ran, nothing to produce — and `skipped` are settled but are not successes, and that distinction
is the reason the table exists (§7b). `failed` gets its own colour because it is the only
segment that asks for a decision.

### Three ways the arithmetic can lie while still rendering perfectly

All of it lives in `packages/core/src/pipeline.ts`, away from SQL and away from React, because
none of these are visible in a screenshot:

- **A superseded recipe.** Bumping a stage's `version` makes the sweep redo every row below it.
  Counting those as settled holds the bar at 100% for the whole resweep — exactly when someone
  would be looking at it. So `summary()` groups by version, and the comparison happens in core.
- **The wrong denominator.** `mediaIdsNeedingStage` filters by kind rather than writing a
  `skipped` row for every photograph, so a video-only stage is measured against the video count
  alone. Measured against the whole library, the sprite bar would stop at the share of the
  library that is video and look permanently stuck. `mediaRepo.countProcessable` repeats that
  query's `FROM` and `WHERE` on purpose — it is the denominator for that numerator, and a test
  asserts the two select the same population.
- **Segments that do not sum to their own total.** A `MediaStage` row outlives its item being
  trashed or archived. Counted, those rows put `13,209 / 13,028` on the index bar in
  production, so `summary()` subtracts the stage rows of every item that is not `listable` —
  the same population `countProcessable` divides by. _Superseded (§20, "The Processing page
  counted the library"):_ the subtraction was planned backwards on the NAS and read every stage
  row, and the totals are now kept in `MediaStageTally` by triggers, counting only listable
  items, so there is nothing left to subtract. `remaining` stays clamped against any brief
  disagreement; unclamped, that renders as a bar running backwards out of its box.

### Liveness is the part a bar cannot show

A stalled bar looks identical whether the worker is grinding through a long transcode or died
in the night, and those call for opposite responses. `queueSummary` answers it: the runner
beats every fifteen seconds (§18.7), so a claim whose heartbeat is inside the last minute is
proof something is running. No claims at all reports `false` rather than raising an alarm — an
idle worker and a dead one both hold nothing, so silence is not evidence.

This was the first thing the view reported on real data, and it was right: fourteen claims
frozen at one timestamp eleven minutes earlier, which is a worker that stopped holding them.
Note that the reclaim sweep cannot fix that on its own, because the sweep also lives in the
worker; the claims return to `pending` when it next starts.

### Polled, not pushed

The obvious move is to put this on the SSE feed (§13b), and it is wrong twice over. That feed
is per-user and filtered by library access, while these are whole-library totals — so it would
either leak the size of libraries a viewer cannot see, or need a second filtering rule. And the
change poller would have to compute the summary every tick for every subscriber whether or not
anyone had the page open.

So: `GET /api/admin/processing`, polled at two seconds, and only while something is outstanding.
It costs nothing in the normal case, which is nobody looking.

Kept separate from `/api/admin/scan` for the same reason: that endpoint is cheap and loaded
once, this one aggregates over a table holding a row per item per stage. Behind one endpoint the
expensive half would run every time the cheap half was wanted.

`idx_MediaStage_stage_state_version` is what makes the aggregate affordable — the three grouped
columns are the whole index, so it reads entries in order and never touches a row. Without it
the same query is a full scan of a table six times the size of the library, every two seconds.

### Deliberately absent

- **No ETA.** It is computable from successive polls and it will be wrong in the way that
  matters: transcode dominates the tail and its per-item cost varies by an order of magnitude.
  A confident "12 minutes" that becomes four hours is worse than no number.
- **No per-item detail.** Unbounded, churning, and the one running transcode's `Job.progress` is
  the only per-item number that exists anyway.

## 13d. Derived files and the database say the same thing

Everything under `dataDir` is one of two things: a copy of something the originals and the
database can produce again, or the only copy there is. The distinction is declared once, in
`DATA_DIR_KIND`, exhaustively over the directories `dataPaths` names — so adding a directory
without deciding which it is fails to compile.

| directory    | kind          | why                                                             |
| ------------ | ------------- | --------------------------------------------------------------- |
| `art`        | derived       | covers, posters, previews, sprites; excluded from backups (§13) |
| `captures`   | irreplaceable | stills somebody framed by hand; nothing regenerates one (§13)   |
| `variants`   | derived       | web-safe renditions; expensive, still only a copy               |
| `hls`        | derived       | cached on-demand segments                                       |
| `sidecars`   | derived       | an export _of_ the database                                     |
| `trash`      | irreplaceable | removed from a media root; no other copy exists (§10)           |
| `backups`    | irreplaceable | the undo behind a migration that succeeded and was wrong        |
| `embed`      | derived       | vectors and the representatives log, rebuilt by the stage (§5e) |
| `tileprints` | derived       | a colour grid per sprite tile, rebuilt by the stage (§10h)      |
| `database`   | irreplaceable | the thing the rest is derived _from_                            |

Two directions of drift follow, and both were real.

### Files with no row

`db:reset` used to be `rimraf` over three SQLite files. The derived tree stayed exactly as it
was — and was never read again, because media ids are fresh UUIDs, so a rescan writes new
paths and the old tree becomes litter that only grows. Several schema changes into
development that was 2.2 GB, referenced by nothing and reclaimed by nothing.

So reset is now a real command: it empties every `derived` directory, **and `captures` with
them**. That is the one place the two lists differ, and it is why `resetDataDirs` exists
alongside `derivedDataDirs` rather than reusing it. `DATA_DIR_KIND` answers "can this be
rebuilt", which is what decides backups and what the orphan sweep may touch, and a captured
still can be rebuilt by nothing. Reset asks a different question: what could the _new_
database account for? It destroys every `Media` row and the next scan writes fresh UUIDs, so
no still written beforehand can ever be named again — captures are not merely unreferenced
afterwards but unreferenceable, and the sweep will never reclaim them because it only visits
items that exist. Keeping them is not caution; it is precisely the litter above, wearing the
appearance of having saved something. They are counted and reported on their own line,
because destroying somebody's work and destroying it silently are different failures.

It **refuses** when the bin is not empty, because resetting destroys the `TrashEntry` rows
while leaving the bytes, and a trashed file with no entry can never be restored and never
purged — it is simply lost disk with no way back. That is the sharper loss: a capture is
work, a trashed file is the only copy of something the app did not create. `--force` accepts
it; nothing else does. `db:init` deletes nothing, but says how many derived files it
has just orphaned, because drift nobody mentions is drift nobody fixes.

Reset is the immediate fix. The general one is `orphanSweep`, which reconciles what is on disk
against what is referenced. It used to be enqueued from exactly one place — forgetting a
library — so a reset left its litter behind permanently. It now runs at worker startup and
daily, and the startup pass is the one that matters: it is what notices a database that was
reset, restored from a backup, or initialised fresh beside a `/data` belonging to one that no
longer exists.

Daily rather than hourly: it is a full walk of a directory holding several files per item,
which on a 200k library is a real cost to pay for a reconciliation that almost always finds
nothing (§17).

### Two path spaces, and the bug that came of assuming one

The sweep compared what it walked against what the database stores. Those are not the same
thing:

- `Artifact.relPath` and `Variant.relPath` are **dataDir-relative and carry their directory in
  the value** — `"art/19/<id>/cover.webp"`. Every consumer resolves them with
  `path.resolve(config.dataDir, relPath)`.
- `TrashEntry.trashRelPath` is **trash-relative with no prefix**, because the trash job
  resolves it against `dataPaths(config).trash`.

The walk yields paths relative to the directory it walked, so art and variants arrived without
their prefix and matched nothing. Every live artifact in the library classified as an orphan.
The job had never run outside the forget-a-library path, so nothing had noticed — and putting
it on a timer, which is what this section is about, would have deleted the entire derived tree
on the next worker start.

It had already fired once. A single forget-a-library removed 875 artifact files across 187
items, leaving their directories empty and their `MediaStage` rows saying `done`.

`storedPrefix` is now stated per target rather than assumed, and there is a circuit breaker
underneath it: **a sweep that finds nothing at all to keep has found a bug, not a windfall.**
If every file in a non-empty directory looks unreferenced while the database names something,
the likelier explanation is a path mismatch or an unmounted volume, and the sweep declines and
says so. It still empties a directory when the database genuinely references nothing, which is
the state immediately after a reset.

That breaker is also what keeps the regression cheap. Reintroduce the prefix bug and the test
that goes red is "removes a file nothing references" — the sweep stops distinguishing, so it
stops deleting. Loud and harmless, in that order.

### Rows with no file

The mirror image, and the half that was missing entirely. A row whose bytes are gone shows as
a broken cover in the grid, and nothing in the app would ever notice: every "what still needs
doing" query asks `MediaStage`, and `MediaStage` said done.

So the sweep also drops rows naming files that are not there — and, crucially, **clears the
stage that produced them**. Dropping the row alone fixes nothing, because §7b selects work
from `MediaStage`; the item would keep its missing picture forever. Variants need no such
clearing: transcoding is selected by whether a browser can play the file (§8), so removing the
row naming an absent rendition is enough for the backfill to find the item again.

Two limits on it, for the same reasons as above:

- **User-chosen artifacts are left alone.** A capture someone picked may not be deleted and
  regenerated at will (§9). Its bytes are already lost; removing the row would additionally
  lose the fact that a choice was made, so it is reported instead.
- **The same circuit breaker.** Every artifact missing at once is an unmounted `/data`, not a
  library that lost all its pictures, and dropping every row on that reading would be the same
  mistake in the other table.

Both directions share the sweep's one hour of grace, and for the same race: a job writes its
file and then inserts its row, so for a moment each legitimately exists without the other.

## 14. UI

**Views**: Home (user-configured shelves) · Library grid (virtualized, adjustable density) ·
Gallery mode (all-previews, autoplaying) · Detail/player · Playlists · Duplicates · Reels ·
Tags · Settings (prefs, saved filters, sessions) · Admin — now Review, Libraries, Processing and
Household (§12c); the error-log viewer is parked.

**Mantine only**, per basket-bot's rule — no second component library. `@mantine/hooks`
`useHotkeys` for the keymap, the header search for `/` (below), and TanStack Virtual under a plain
CSS-grid tile list for the library (Mantine has no virtualized grid of its own).

**Filter/sort**: URL-encoded query state, shareable and back-button correct — kind, duration,
resolution, codec, rating, tags, dates, folder, "has duplicates", "unrated". Sorts: added,
captured, name, duration, size, resolution, bit rate, frame rate, last viewed, rating, random
(seeded), and relevance when there is search text. `mediaSortSchema` is the one list: the URL
parser checks `?sort=` against it rather than keeping its own, because a copy that did fell
behind and read `?sort=bitrate` back as the default, so the menu choice was silently ignored.

**Hotkeys**: `space` play/pause · `←`/`→` ±5 s, shift ±30 s · `,` `.` frame step · `0`–`9`
jump to 0–90% · `[` `]` clip in/out · `j` `k` `l` shuttle · `-` `+` speed (0.25×–4×) · `f`
fullscreen · `m` mute · `1`–`5` rating in grid · numpad `1`–`5` rating in the viewer (the same
number again clears it) · `h` favourite in the viewer · `Delete` (or `Backspace`) trash in the
viewer, `Enter` to confirm · `/` search · `g g` top · `?` help.

**Every rating and favourite answers over the picture**, clicked or pressed. It started with the
keys: somebody rating from the numpad is looking at the film, often in fullscreen, often with the
stars scrolled off; the stars changing was the only acknowledgement, which from the picture is none
— and a press that seems missed gets pressed again, which clears the rating. `StageFlash` puts the
result at the top centre of the stage for about a second: five stars, or the heart. It says what was
_stored_: shown at once, ticked when the server answers, replaced by "Could not save" if it does
not. A toast was the alternative and lost, because a corner is where nobody watching is looking and
rating by feel — 3, no, 4 — would stack them. The same text goes to a polite live region. `h` is for
heart; the numpad beside the ratings was the natural home and is full, since numpad `+` is the
player's speed key. The tooltips on the stars and the heart name both keys, because nothing else
did.

**Five stars and a new favourite are celebrated**, on purpose and a little too much. They are the
two verdicts somebody would say out loud: the message over the picture grows, glows, counts the
stars in one by one (or beats the heart twice) and throws a spray of them behind it — with a word
for five that changes each time (Chef's kiss, Masterpiece, Top shelf, Bravo), because the same
praise on the fortieth item reads as a label rather than a reaction. Clicks and keys take one path —
the stars and the heart are controlled by the page, which saves for them — so either one gets the
message over the picture and a spray from the control under the title. A four, a cleared rating and
an un-favourite stay quiet. Under reduced motion the glow and the size stay and the movement goes.

**Trashing from the viewer is a key, an icon and a confirmation.** Weeding happens while looking at
the thing, and the only way to trash an item from the viewer was the button at the foot of the
Details drawer — a scroll away on a phone, and no key at all. `Delete` opens the same confirmation
that button does, and `Backspace` too, because a Mac laptop's "delete" key sends it. A trash icon
sits last on the title row, the size of the heart, so a phone reaches it with one tap. All three
open one dialog owned by the page (`TrashConfirm`), just as clicks and keys share one path for
ratings. The dialog focuses the button it recommends, so weeding by keyboard is `Delete` then
`Enter`, which also takes any identical copies (§10d). When the best copy of a duplicate group would
go while a worse one stays, the recommendation — and so the focus — is Cancel.
A held key's repeats are ignored, so autorepeat cannot answer the dialog it opened, and the player
gives up its keys while the dialog is open. There is still a confirmation, and no undo toast
replacing it, because restoring from the trash is an administrator's act (§10): a viewer with only
`delete` would be offered an undo they could not use. Without the `delete` scope the key does
nothing and the icon is absent (§18.1). With the scope on a read-only library, the key says so over
the picture, because a documented key that silently does nothing reads as a broken one. The tasting
(§14g) does not take the key: it is for sitting back, not weeding.

`space` and `f` reach a photograph too: `space` holds and resumes its dwell, `f` gives it the whole
screen. Everything else in that list is a video verb and stays one. A key the table documents that
does nothing on a third of the library is a key people stop trusting — which is what both of these
were until the still stage grew a transport of its own (§14b).

**The hotkeys stand aside for typing, and typing is not every form control.** The guard was
`["INPUT", "TEXTAREA", "SELECT"].includes(tagName)` written out in three handlers, and it was too
broad in the way that matters: a star rating renders as `<input type="radio">`, so clicking a star
to rate something focused a radio and silenced every key on the page — including the numpad that
rates, which is the control those keys exist to duplicate. Reaching for the keyboard straight
after the mouse is the ordinary way to work through three hundred items, and the one place it
failed was the place it was needed. `isTypingTarget` asks the question that was meant all along —
would this key have been a character somebody meant to type — so a radio, a checkbox, a range and
the scrubber (a `div` with a slider role) all let the keys through, and a text field, a textarea,
a select and a rich-text `div` still take them. The list names the input types that take _no_
characters, so anything unrecognised counts as typing: a hotkey that does not fire is obvious at
once, and a swallowed keystroke inside a field is not.

### The header search

**One box in the header, on every page** (2026-10-10), for starting a question from wherever you
are. It asks one of five kinds, chosen from the icon at its left: **Library** (a magnifier --
the library's text, §5c), **Performer** (head and shoulders), **Source** (a clapperboard),
**Keyword** (a luggage tag) and **Look** (an eye -- §5e; not the overlapping frames of "More like
this", which starts from a picture rather than words). The glyphs are `Glyph.tsx`'s, drawn at
16-18px with no label, so each has to read on its own.

- **Enter goes to a page that already existed.** Every kind had one that takes the words in its
  address, so the box is mostly a router (`searchHref`): Library to `/?view=grid&search=`, Look to
  `/?view=grid&lookText=`, and the three tag kinds to their browse pages with `?q=`. Library and
  Look land on a **clean** library -- a new question, not a refinement of the view that was open.
  Already on the page it sends you to, it replaces that page's search; there is nothing to merge.
- **The library keeps its own box.** The two are different jobs: the header starts a search, the
  working row's box refines the one in front of you, keeping its filters. Removing the second
  would have made "search inside this view" a filter-panel errand.
- **The kind is remembered, on the device** (`ps:headerSearchType`), like the playback
  preferences. The risk of a remembered mode is yesterday's Look quietly changing what "jane"
  means today, so the kind is never hidden: its icon is in the box and the placeholder names it
  ("Find a performer", "Looks like…").
- **Names are suggested for the kinds that have them** -- Performer, Source, Keyword -- through
  the same server matching and the same `tags.search` cache as every tag box (§5b "One rule for
  names"), pictures at the tag boxes' size, eight at most. Keywords ask both systems, yours first;
  close spellings appear only when nothing matched as typed in either. Arrowing to a name and
  pressing Enter, or clicking it, opens that tag's page; Enter on the text lists every match,
  because "jan" may be three people. Library and Look suggest nothing: text and looks are not
  names, and a guessed completion of free text would be a second, worse search.
- **Nothing is asked until the box is in use.** Suggestions wait for focus and typing, debounced
  as the tag boxes are; the library is searched once, on Enter, not per keystroke (§20 "Typing
  paid for the tab nobody was reading").
- **On a wide screen** it is a rounded well centred in the bar, 560px wide (640 from `75em`),
  sunk into the surface with a hairline that warms to brass in use, and a `/` key cap at its end
  while idle. **On a phone** it is a magnifier at the bar's end that opens the box over the whole
  header -- burger and wordmark covered rather than squeezed -- and folds away on close, Escape,
  a search, or leaving it empty.
- **`/` focuses it from anywhere** (§14 "Hotkeys"), unless you are typing (`isTypingTarget`) or a
  dialogue is open: the box is behind it, and focus would leave the dialogue for something you
  cannot see. It was listed as a hotkey long before anything answered it.

_Rejected: one modeless box with grouped suggestions_ ("Search library for…", "Look like…",
performers, sources, keywords in one list). One tap fewer and no remembered mode, but Enter on
the text could only ever mean the library, and the choice of kind would be made again on every
search rather than once.

### Sort direction has a per-sort default

Every sort used to default to descending, which made choosing "Title" list the library from Z
to A. Nothing about it looked like a fault — the order was stable, paging worked — it simply
made the obvious choice produce the surprising result, which is the only way a default is ever
wrong.

`naturalDirection` in `@private-stock/core` is a table keyed by sort, not a rule about column
types. The intuitive end is a fact about what a field _means_: newest first for a date, best
first for a rating, largest first for a size, longest first for a duration, and A–Z for a
title. A rule inferred from the type would quietly assign one to the next sort added instead
of making somebody decide; the table is exhaustive by type, so adding a sort without choosing
is a compile error.

It lives beside the schema rather than in the grid because the grid, a saved filter and a home
shelf all have to agree about what "sort by title" means. `MediaQuery.direction` is therefore
**optional rather than defaulted** — absent means "however this sort naturally reads", and the
single place that builds the `ORDER BY` resolves it. It cannot be a zod default, which cannot
read a sibling field, nor a `.transform`, which would stop the schema being a `ZodObject` that
`savedQuerySchema` can `.omit()` from.

Two consequences in the UI:

- **Changing the sort clears the direction.** Someone who reversed Title to get Z–A and then
  picks Recently Added means "recently added", not "oldest first" — the preference belonged to
  the sort they left.
- **The control is hidden, not disabled, for `random` and `relevance`.** A permutation read
  backwards is just another permutation, and the far end of relevance is "worst match", which
  nobody is looking for. A disabled control invites "why can I not use this"; an absent one
  does not raise the question.

The direction is omitted from the URL when it is the one the sort would have taken anyway, so
`?sort=title` still means A–Z and only a deliberate reversal costs a parameter. A URL saved
before any of this existed carries no direction and therefore means exactly what it always did.

### Responsive from phase 1

Phone and tablet layouts are designed alongside desktop, not retrofitted. Mantine's
breakpoints and `useMediaQuery` drive it; the grid is already virtualized, so density and
column count are the main variables.

Three things that are genuinely different on a phone, not just narrower:

- **Simultaneous video decoders are limited.** Mobile browsers cap how many `<video>`
  elements can decode at once — iOS Safari historically one, Android a handful. Gallery mode
  must therefore cap concurrent previews by device class (desktop ~8, mobile 1–2) and fall
  back to animated-WebP or static covers when the cap is hit. Building this desktop-first and
  discovering it later would mean rewriting gallery mode, which is why it belongs in phase 1.
- **Hotkeys need touch equivalents.** Double-tap sides to seek ±10 s, vertical drag for
  volume, long-press for speed, swipe down to dismiss the player, and a tap-to-reveal control
  bar. The keymap (§14) stays the desktop path; neither is a translation of the other.
- **Bandwidth and data.** The `remote-720p` profile (§18.8) is the default on a cellular
  connection, and hover previews are off by default on metered connections.

Touch targets stay at least 44 px, the scrubber gets a larger hit area than its visual
height. On a touch drag the filmstrip is the preview and the video seeks once, when the finger
lifts (§9 "Scrubbing a touch drag").

**Look — "wine cellar"**: one Mantine theme file is the single source. Custom `oak` and
`oxblood` color scales, `brass` as `primaryColor`, a high-contrast serif for headings against
a clean sans body, tight `defaultRadius`, and component `defaultProps`/`classNames` so Card,
Badge, and Rating carry the racked-bottle look without per-usage styling. Deep oak-brown and
near-black ground; candle-warm glow on hover instead of a blue focus ring; hairline brass
edges and inset shadow so tiles read like bottles in a rack. Texture lives in the chrome,
never behind the media. Dark-first, all values as tokens so a lighter "tasting room" variant
stays possible.

### The room and the cellar

`/` was the rack: every library merged into one paged grid of sixty tiles. That is the right
screen for finding one item among two hundred thousand and the wrong one to arrive at, and
merging the libraries to do it threw away the only structure an administrator had actually
declared.

There are two places now, at one address:

- **The room** (`/`) — a hero offering what you were last watching, the home shelves beneath
  it, and each library as a named door. Built on `/api/home`, which had been shipping since
  §6 with no page consuming it.
- **The cellar** (`/?root=<id>`, `/?view=grid`) — the grid, unchanged. Same pager, same
  facets, same sorts, now scoped to one library.

The paragraph above this one has always ended "a lighter 'tasting room' variant stays
possible", meaning a theme. It turned out not to be a theme: the cellar treatment was right
all along and there was simply nowhere to be received. Warmth is still chrome-only — firelight
and a low sun as fixed background layers on `<body>`, film grain, brass hairlines in place of
grey dividers — with one deliberate exception, the bloom behind the player, because a lit
screen in a dark room does throw light and without it the player reads as a rectangle pasted
onto the page.

**This cost no schema change.** `MediaQuery.rootId` already existed, `buildFilters` already
applied it, and `listRootId` is the leading column of every partial list index (§20), so a
root-scoped grid is the cheapest question the schema can answer. Only the UI and one
count-and-cover-per-root endpoint were missing.

**The view is a three-way mode, not a `gallery` boolean.** The room used to be "no root and
nothing else set", which is not a state anything can navigate _to_. `mode` is `room | grid |
gallery`, and its default depends on whether a root is named — so `/` and `/?root=abc` still
cost no parameter, and every link to either is one spelling.

**The detail page pours first.** It is the film, its name, a rating and one way in; the facts,
the provenance and the delete live in a drawer. (The tags and the note lived there too, and
moved to the page — see the viewer's tiers below.) Provenance is `MediaStage` read per
item rather than in aggregate — the same rows the admin page counts, which had never been
shown to the person whose file they describe. It is driven by the stage registry rather than
by the stored rows, so a stage that has not run yet reads as pending instead of being absent.

### What a phone actually broke

Three faults that a desktop browser could never have surfaced, all found by measuring rather
than by looking:

- `minmax(190px, 1fr)` resolved to **one column** on a phone. A Pixel 10 is 412px, the content
  box is 388, and two 190px tracks plus the gap need 392. Four pixels, failing silently,
  because `auto-fill` has no way to report that it wanted two. Grid minimums are capped at
  half the container now, so the grid is never narrower than two across.
- `viewport-fit=cover` was set with no `env(safe-area-inset-*)` anywhere. That flag is what
  lets the ground colour reach the edges of a notched phone, and its price is paying the
  insets back in the shell — otherwise the header draws under the status bar and the library
  ends under the gesture bar.
- Six toolbar controls wrapping across 412px cost about 200px of chrome before a single tile
  appeared, more than the first row of the library they arrange. Sort and direction move into
  the filter drawer below `62em`; search and grid/gallery earn the space. The kind was in the
  drawer too, and came out of it: it is the choice made first and most often, and it is now the
  tabs under the title on every screen size (§14e, "The cellar's header").

### Installing

The app is installable — a manifest, the seal as its icon — and has **no service worker**. The
two are separate halves of what gets called a PWA, and only the first earns its place.

- **The manifest** (`app/manifest.ts`) is what lets a phone put the app on its home screen
  and open it in a window of its own. `standalone`, not `fullscreen`, because the player has
  its own fullscreen. No orientation lock. Its colours are the `themeColor`, so Android's
  splash is the seal on the cellar ground. The icons are rendered from `app/icon.svg` by
  `pnpm icons:render`, the maskable one with the seal inside the 80% safe circle. iOS
  captures its icon when the app is added and never asks again; Android re-reads the
  manifest on its own schedule.
- **A service worker would cost more than it gives.** Nothing works offline — the library is
  on the NAS — so caching buys nothing. The usual app-shell cache makes updates _slower_: a
  new worker waits for every window of the app to close, and an installed app is rarely
  closed, so it runs the old build indefinitely. And it would keep thumbnails and API answers
  in device storage past sign-out, which is the "a cached API route serves another user's
  library" failure in a new place. Chrome no longer requires one before it offers to
  install. Do not add one as an obvious improvement; the reasons above have to have changed.

Installing needs a secure origin. Over plain `http://nas:8842` a phone can only bookmark the
page, which opens in an ordinary tab. Through the Caddy front door it installs on devices that
trust Caddy's root (on iOS that is also "full trust" under Certificate Trust Settings), and
with a real certificate it simply works.

**Updates are ordinary HTTP caching**, which already gets them right: `/_next/static/*` is
content-hashed and immutable, and every page, its data and `/api/*` are `no-store`. The gap is
a page that is never reloaded, and an installed app is mostly that — resumed for days, with no
reload button. It keeps running the old JavaScript against the new server, its API calls meet
response shapes it was not written for, and a screen it has not opened yet asks for chunks the
new image does not have. Next reloads on a mismatched navigation; a page sitting open never
navigates.

So the page checks. `/api/build` answers with the build's identity — the commit _and_ the
build time, since two `-wip` builds share a commit — and `useBuildCheck` compares it with the
identity baked into the page, whenever the page comes back into view and every quarter hour
while it is in view. On a mismatch `UpdateNotice` reloads where it stands (the URL carries the
view) when nothing would be lost, and otherwise asks: something playing, or a field with the
focus, is not interrupted. It asks rather than reloading a second time for the same server
build, because a page that still disagrees after one reload would only loop. The build time is
written back into the environment in `next.config.ts` so the build's several evaluations of
that file agree with each other; if they did not, the server and the page would differ for no
reason.

**An installed app has no back button.** iOS gives it no browser chrome and an unreliable edge
swipe, so every screen reached by navigation needs a way back of its own — the header's
wordmark home, the viewer's close — and `router.back()` is only ever a shortcut for one, never
the only way out.

### Motion

Chosen on 2026-10-11 from eighteen live demos on the motion plates
(<https://claude.ai/artifact/AiYx5Ae5eoL8sux5KkKi9f>); sixteen were taken, at the **unhurried**
tempo. Two were declined and are not built: favouriting as a pressed wax seal, and trashing as
a tile that pours itself into the nav.

**One tempo, in one place.** `lib/motion.ts` holds the durations — brisk 200 ms for a control
answering, leave 450, move 600, arrive 800, and 900 for the few signature moments — and the
easings, mirrored as `--ps-dur-*` and `--ps-ease-*` in `globals.scss`. Arrivals take their time
because the room is in no hurry; acknowledgements do not, because a control that answers slowly
reads as one that did not hear you. `animate()` is the one way the app's code starts a Web
Animation, and **under reduced motion it starts nothing**: the stylesheet's global rule
collapses CSS animation but cannot reach WAAPI, so the guard has to live where the animations
start, not at forty call sites.

**Grids change in place (`useFlipGrid`).** Every keyed grid and list — the cellar, the home
shelves, Trash, Duplicates, Captures, Clips, Reels — compares each child's position at the last
commit with its position now. Survivors that moved slide to their new place; a set with nothing
in common with the last is racked in on a diagonal wave from the top left, 45 ms a step and over
in about 0.6 s; newcomers to an overlapping set (a filter or sort change) fade up 70 ms apart.
Leavers are caught by a MutationObserver after React has removed them, put back as inert ghosts
at their old places with any `<video>` stripped, sunk 6 px and faded, and removed — React never
knows about them. Only children within about a screen of the viewport animate. **Genuinely new
items arrive only when the caller says so** — `expectArrivals()` from the cellar's "Show N new
items", or `live` on the home shelves — because a filter change also brings in tiles that are
new to the screen but not to the library; arrivals settle from just above, 120 ms apart, and
carry `data-arrived`, drawn as a gilt outline that holds and fades over 4.5 s. A resolved
duplicate group plays its merge before it leaves: the copies being trashed slide into the keeper
chosen at resolve time, and the keeper's frame glows once.

**Navigation is a View Transition, for in-app links only.** A capture-phase listener vets a plain
left-click on an internal link and prevents Link's default (Next's Link stands down on
`defaultPrevented`); a window-level listener re-issues it as `router.push` inside
`document.startViewTransition`, so a React handler that stops the click — the tile's selection
checkbox — still cancels the navigation. `html[data-vt]` is set only for the length of one
transition, so nothing carries a `view-transition-name` the rest of the time, and its value
picks the kind: `turn`, where the shell holds still and the page sinks out and rises in under a
plate title that inks itself in, or `morph`, where a tile's frame grows into the viewer's stage
at 900 ms and shrinks back into its own slot when the viewer's Back button is used. A link to an
item does not start its transition on the click: it is opened first ("Opening an item", under
"Waiting" below), and the morph or the turn begins once the item's details are in the cache, so
it plays at once and lands on a stage that already has its item. The transition still waits for
the new route (1.5 s at most) and a morph for its target (0.7 s more), but those are safeties
now, for a warm that ran out of time and for the turn between pages, which nothing warms.
Browser Back is a plain cut, as is everything without View Transitions (Firefox) or under
reduced motion -- though an item link there is still opened the same way, only without the
movement. The morph moves the frame; no filter is ever applied to the picture.

**The snuff into Tasting and Showcase is not a View Transition.** Full screen is requested inside
the click, and the resize makes the browser abandon a transition, so the room's light closes to a
point under an overlay outside React; the mode's `CandleArrival` takes the dark over before
paint, holds a candle flame for 900 ms, and lifts. The dark is chrome — nothing is drawn over a
film once it is playing.

**The plate** inks in once per mount — out of an 8 px blur, then the double rule draws. As it
scrolls under the header it shrinks away on a scroll-driven timeline (where supported), and an
IntersectionObserver puts its name, in blackletter, in the header beside the wordmark.

**Smaller things.** The rating is five wine glasses that fill in turn from the level shown
before; Mantine mounts a symbol when it turns full, so hovering pours a preview, once per glass.
A saved private note says "kept" with a chalk tick for 2.8 s, because a save on blur that says
nothing looks exactly like one that was lost. Counts that change while watched — the library
count, Processing, the Duplicates eyebrow — roll like an odometer (`Odometer`), units first, and
never on first render. The header seal grows a cork ring naming the work and turning once in 24 s
while a scan runs or a job is claimed (`BusySeal`); pending jobs and stages that cannot finish
here do not count, or the ring would never stop.

**Candlelight** is one viewport-fixed radial gradient, positioned from `--ps-mx`/`--ps-my` that
`CandleLight` writes at most once a frame and sampled by `::after` overlays in `overlay` blend on
`[data-candle]` (the plate title and rule), the current nav item and filled buttons. A finger
never carries the candle: touch and reduced motion get a fixed light. The **foil glint** is a
background-image band that crosses a filled, enabled button once per hover or keyboard focus.

### Waiting

Added on 2026-10-14, because only the cellar said it was loading, and only with pictures: its
grid dimmed to 0.6 while a filter change loaded, which nobody saw on tiles with empty wells, and
every other screen kept the old answer up and said nothing at all.

**The activity rail** (`ActivityRail`) is a gilt hairline along the header's bottom edge with a
candle carried along it, there and back, at 1.8 s a pass. It is on every page and needs nothing
from any of them: it lights while a link you followed has not rendered (`PageTurn`, which decides
what is a navigation, says when one starts; the address changing is when it ends), while any
mutation is pending, or while a query with **nothing to show yet** is fetching — a first load, or
a new key whose list is still showing the previous answer. A refetch of data already on screen is
not waiting, which is what keeps every poll in the app from lighting it without being listed; a
query that only reads ahead — the viewer's neighbouring pages, its count, the up-next tiles —
carries `meta: BACKGROUND`. It appears only after 250 ms, so a quick answer never flashes it, and
once lit holds for 700 ms. Under reduced motion the light stands still in the middle of the rail.

The seal's ring and the rail are two signals and stay two: the ring is the worker busy, the rail
is you waiting for an answer.

**Settling** (`settling()`, `lib/settling.ts`) is the local half, on every list that keeps its
previous answer while the next loads (`placeholderData`): after 150 ms the list dims to half and a
faint band of candlelight crosses it every 2.2 s, so a list of names or empty wells shows it as
plainly as a wall of pictures. It marks the list `aria-busy`. Under reduced motion it only dims.

**Opening an item** (`lib/openItem.ts`) is one path for every way into the viewer: a tile in the
cellar, a shelf, a playlist or a filmstrip row, a title in Duplicates or Captures, a picture on
the showcase's wall, the tasting's Open control and its `O` key. Measured on the NAS, the server
answered the viewer's two requests quickly -- the item's details in about 250 ms, the route's
payload in about 450 -- and the time went on the client, in series: the click started a view
transition, which froze the screen; the route was fetched inside the freeze; the details only
once the viewer had mounted; and for up to two seconds nothing moved, the rail could not paint,
and the showcase and the tasting, which have no rail, said nothing at all. Three rules replace
that. **Warm on intent, not on release**: a press on an item, or a mouse resting on one for
150 ms, starts both requests for that one item -- `prefetchQuery` on the viewer's own
`mediaDetailQuery(id)` and `router.prefetch` -- marked `BACKGROUND`, because a pointer resting on
a tile is not somebody waiting. Delegated from the document (`useItemWarming`, mounted by
`PageTurn` and by the two full-screen modes), so no link has to know; grids keep
`prefetch={false}`, because sixty route payloads for a page nobody opens is what that avoided.
**Acknowledge the press within a frame**: the pressed tile's frame is marked `data-opening`, drawn
as the rail's candle bent into a ring and carried round the edge at the rail's pace -- on the
edge only, masked to two pixels, never over the picture -- and the rail is told a navigation has
started; under reduced motion the edge is plain gilt and still. A text link has no frame and is
acknowledged by the rail alone. **Wait before freezing, not inside the freeze**: the navigation
starts when the details are cached, or after 1.5 s regardless; the route's prefetch cannot be
awaited, but it started at the same moment and is a few kilobytes. A second press supersedes the
first and puts its light out; the light goes when the address changes, or after 15 s if it never
does. Firefox and reduced motion get the same open, with a plain push at the end in place of the
morph. When the wait did run out, the viewer stands the picture the item was opened from -- the
one the tile was showing, already in the browser's cache -- on a stage lit the same way, until
the details arrive, rather than a loader; opened from a shared link, there is nothing to show
yet but the loader.

## 14b. What the library and viewer pages actually do

§14 lists the views. This section records the decisions taken about what lives _on_ the two
that matter most — the library grid and the item page — and, as importantly, what was
considered and left out. It was settled in one pass rather than accumulated, so the
rejections are as load-bearing as the choices.

**A note on when to make the schema changes — this window has now closed.** Pre-release,
changing the schema meant `init.ts` → `db:baseline` → `db:reset`, and `db:reset` empties
`art`, `variants`, `hls`, `sidecars` and `captures` (§13d) — so it also meant re-scanning
every library, re-running every derived job, and losing every still anybody framed by hand.
Against a real catalogue that is hours of ffmpeg to add one field; the 4,282-item test
library this was measured on carried 13,577 completed jobs.

**`HAS_RELEASED` was held at `false` for exactly as long as that was free**, and the reason
to delay was that delaying stayed free: everything catalogued was test data, re-deriving it
was a cost paid by a machine overnight rather than by a person, and the single-baseline
workflow kept the schema one readable file instead of a file plus a growing chain. The flip
happened at the first deployment to the NAS, when the catalogue stopped being disposable.
The ordering rule it implied — batch the schema changes into the window where there is
nothing to lose — was honoured: `watchedAt` and everything else §14b asks for went in before
the flip. From here a new column is an ordinary timestamped migration (§4), which costs no
re-derive at all; what it costs instead is that it can never be edited again once shipped.

### Saved filters

A saved filter is the current library view — search, tags, kind, rating, root, sort — stored
under a name. The API (`/api/filters`) and `savedFilterService` already exist and have never
had a caller.

**It appears in three places, which is the point.** In the nav beside the libraries, with a
live count, so the way you actually browse sits next to the way the files happen to be
organised. On Home as a shelf, so the front door reflects your filters rather than a fixed
set of rows chosen once. And in the grid itself, as the thing you are currently looking at.

**Editing saves over the filter rather than forking it.** Open a saved filter, change the
sort, save: the filter changes. A "save as" makes a new one. The alternative — every tweak
silently creating "Unrated 4K (2)" — is how a list of saved filters becomes a list nobody
reads.

**Sharing is deliberately not built.** `mediaRepo` carries a complete `overlayUserId`
mechanism for reading _another_ user's ratings through a filter they shared, including the
rule that hidden stays the viewer's own (§6). It is tested and it works and nothing calls it.
That is fine: it is the hard half, it costs nothing to leave sitting there, and a
single-household install has no one to share with yet. When there is, the UI is the only
missing piece.

### Coming back to the library: the address, not the list

**What is remembered is the address** — filter, sort, kind tab, shuffle seed and page.
`rememberedPages.ts` stores it whole and the sidebar's Library link points at it. If the list
has shrunk past the remembered page, the cellar moves to the last page that exists once it
knows the count.

**The list itself is fetched as usual.** Nothing is pinned or cached beyond the app's ordinary
staleness, so items that arrived while you were away are in it, and if they change the order,
that is the library changing. An earlier pass held the grid's pages as a snapshot — never stale,
kept half an hour, shielded from the live feed — and it was taken out again: it bought a
frozen list at the cost of tiles that never finished processing and machinery nobody asked for.
The shuffle prime is fixed (`rowidShuffleParams`), which is the one piece kept: it costs a
constant, and without it a single new file reshuffled the entire list rather than slotting in.

**A new list** is anything that says what to show — a performer's or a tag's "view in Library",
a shelf's "see all", a saved filter, or changing a filter, the sort or the shuffle yourself.
Those build a complete address, a seedless shuffle is dealt its seed on arrival, and landing
there replaces what is remembered.

While you are on the grid it does not move on its own: new items wait behind a button, and
changes to what is showing apply in place (§13b).

### Every list page is an address, and the sidebar remembers it

The library was the only page that worked this way, and every other list page paid for it:
Duplicates forgot its tab when you opened an item and came back, a tag search was gone after
looking at one performer, and the Manage tables reset after checking a count in the library. The
rule is now the same everywhere a list is browsed:

- **View state lives in the address** — tab, search, filters, sort, layout, page. Declared once
  per page as fields in `urlView.ts` (`defineView` plus `useUrlView`), which leaves defaults out
  of the URL, reads nonsense as the default, writes with `replace` so Back leaves the page rather
  than stepping through its filters, and guards against two writes close together undoing each
  other. A page holding several lists gives each a `prefix`: the Manage tables are
  `performer.public.page`, `tag.private.q` and so on, in one address. Back and the item page's
  "Back to …" then return to it unchanged, because both go back to an address.
- **The sidebar returns you there.** `rememberedPages.ts` lists the pages it remembers (the
  library, Captures, Clips, Reels, Duplicates and the four tag pages). The sidebar records each
  one's address as it changes, per device, and links to it. A page opts in by being listed. The
  tag profile's "← Performers" and the reel page's "← Reels" point at the same remembered
  addresses rather than at the plain ones.
- **What is not persisted:** selections, open dialogs, drafts, status messages, the lightbox, and
  how far an infinite list has loaded. They describe one sitting, not where you were.
- **The one exception: a library selection outlives a trip into the viewer** (`librarySelection.ts`).
  Ticking three items, opening one to check it and pressing Back used to find nothing ticked — the
  grid unmounts. The ids cannot go in the address, so they go in `sessionStorage` with the user
  and the exact address they were ticked on, and come back only on that address. One slot, not a
  map: the grid already clears its selection whenever the view changes, and that empty selection
  overwrites the slot, so nothing is ever restored onto a set it was not chosen from. Ticked items
  that are no longer on the page when it loads (trashed, retagged out of the filter) are dropped.
- **Back closes a full-screen overlay before it leaves the page** (`useCloseOnBack.ts`). On a
  phone an enlarged capture is the page as far as the person holding it can tell, and Back threw
  away the list under it too. While it is open one history entry is pushed at the same address;
  Back pops it and closes the overlay, and closing it any other way takes the entry back off, so
  the next Back leaves the page. A link followed from inside it uses `replace`, overwriting that
  entry rather than stranding it. The open overlay is still not in the address.

    The face review's overlays do the same (2026-10-09): a face's closer look, the item played
    beside the review, and "Someone else…". They share **one entry**, not one each: a closer look
    hands over to the played item in a single render, and an entry each would take one off and push
    the next together — the pending `back()` then popped the new one and closed it as it opened. The
    entry comes off a tick after the last overlay closes, so one opening meanwhile keeps it.

- **A pinch zooms inside a drawer or lightbox** (`removeScrollProps={{ allowPinchZoom: true }}`):
  Mantine's scroll lock otherwise swallows two-finger gestures, and zooming in is how a watermark
  OCR missed gets read.

Playlists keep their own address (`playlistView.ts`) and remember only the grid or gallery choice,
per device: a list that likes a fresh shuffle should get one each time it is opened. Admin,
Account, Trash and Collections have nothing to remember; what they hold is forms and dialogs.

### The item page is a position in a set, not a destination

Today the viewer is a dead end: one way in, one way out. It becomes a place you can move
through.

**Previous and next walk the set you arrived from** — the exact filter, the exact sort,
across page boundaries, with the position shown ("23 of 312"). Not the whole library, and not
the page you happened to be on. The set is already recorded for the back link (`returnTo`),
which is what makes this affordable: the address you came from _is_ the query.

**The recorded address moves with you.** Stepping onto an item from the next or previous page
rewrites the page in `returnTo` before navigating (`pageOfId`, `returnAtPage`). The address
is read again for every item, because stepping remounts the viewer. Without the rewrite, the
item after a page boundary is looked for on the page before it and is not found. The viewer
then loses its place: no next, no position, nothing warmed.

**Back lands where you are, not where you started.** Back is still `history.back()` whenever
there is history. That restores the list exactly, scroll and all, and leaves one history entry
for it. But what it restores is the page you _opened_ from. So before going, the viewer leaves
the address it has reached. A library or playlist page replaces its own address with that one
on arrival (`useReturnCorrection`). The showcase instead centres the item you were last on
(`lib/showcase/restore`). With no history behind it, the viewer navigates to the address
directly.

**Only something that describes a set is walked.** A set comes from `/` with a query, a
playlist, the showcase, or a shelf in the room. Every other place the viewer can be opened
from, such as duplicates or clips, records itself so that Back names it and returns to it.
None of them is read as a filter. Reading `/duplicates?page=1` as a library query walks a set
nobody was looking at.

**A room shelf is a small playlist for the length of a visit.** Open the first tile of
"Recently viewed" and, when it finishes, the viewer carries on to the second. It stops after
the last tile on that shelf, not somewhere in the library beyond it. A shelf is not a query the
address can carry, because "recently viewed" is an ordering over one viewer's views. So the
opener records the shelf's items next to `returnTo` (`rememberShelf`), and the viewer walks
that snapshot. It is a snapshot rather than a re-read of `/api/home` because watching an item
moves it on that shelf. A set recomputed at every step would send the viewer back to the item
it had just finished. The snapshot is matched to the address it was written with, and any
later recording clears it, so it only ever describes the opening that wrote it.

**An address can name a moment: `/media/<id>?at=<ms>`.** This is how the Captures page (§9)
opens a video where a still was taken. The moment is carried in the address, so a reload
returns to it. It wins over where the item was left earlier in the visit, and it is exempt from
that position's edges (`openingTarget`). Those edges discard noise in a position recorded while somebody
watched, and a moment somebody chose, even one two seconds in, is not noise. It is clamped
to the duration.

Stepping to the next item replaces the address without it, so that item opens where it was left
this visit, or at its beginning. It is `at` rather than `t` because `t` is already the signed media token on
the API routes (§12d).

**An address outlives the visit that wrote it, so it is not trusted blindly.** Opened fresh
(typed, pasted, a bookmark, a new tab, an outside link), the viewer ignores the recorded
address unless this page load wrote it. `sessionStorage` would otherwise hand a pasted item
URL the set a tab browsed an hour ago, and "Back to library" would go wherever the history
happened to lead. A reload or a trip through the history keeps it: the list is still behind
you. An item opened out of context stands alone, with no next and Back going home. That is
deliberate: a default set would be a guess at a set nobody chose.

**The keyboard is the primary control, not a convenience.** `n` and `p` to move (the arrows and
`j`/`k`/`l` belong to the player's transport), space to play, `f` for the whole screen, digits to rate, `esc` back. Someone working through three hundred
unrated items is doing the same four things over and over, and reaching for a mouse between
each is the whole cost.

**An up-next strip** under the player shows what is coming and jumps to it. It costs vertical
space, which is the reason to keep it to one row and to consider hiding it on a phone.

**Autoplay has three parts and they are set separately.** Playing _onward_ when the thing on
screen ends is the queue behaviour. Playing _on arrival_ is a preference about opening an item at
all. And **how long something with no end is held** is the third, because without it the queue
only works on half a library.

**A photograph has no end, so it is given one.** The viewer is a position in a set and the set is
mixed: letting it roll walked the videos and stopped dead at the first picture. The rule that
fixes that is deliberately not about pictures — **the show advances when the thing on screen ends,
and anything with no end ends after N seconds.** A photograph has no end. Neither does a video
awaiting a rendition, and that case was worse than a stall: the player mounted, asked for an
original this browser cannot decode, got an error and removed itself, leaving an _empty stage_ for
autoplay to sit in front of for the rest of the evening.

So the stage has two **modes** rather than two **kinds**. `stageMode` in `lib/stageDwell.ts`
answers "player" for a directly playable video and "still" for everything else, and the dwell
belongs to the mode. A photograph is a still; an unconverted film is a still of its cover, with the
conversion notice above it saying why — which was always the better answer to "why is this blank"
than hiding the one picture we have. Written as "a video _and_ direct-play is a player", so that a
third kind of media added later lands on the side that keeps moving rather than the side that
stalls.

**The dwell is four values, not a number.** Three, five, eight or fifteen seconds, and five by
default: five is the beat every photo slideshow people have already used runs at, and with a 420 ms
crossfade at each end the picture is _still_ for about four and a quarter seconds — roughly the
dwell somebody gives a photograph they are not studying. A closed set rather than a free number
because it removes a class of bug instead of guarding against it: there is no representable value,
no zero and no negative, that could turn the show into a stroboscope or stop it forever, and
anything already in storage can be shown as selected by the control that sets it. `snapDwellSeconds`
takes a string, a `NaN`, a `1e9` or nothing at all and returns one of the four, and a tie goes to
the shorter dwell because that rule has to be written down rather than fall out of a fold's seed.

**The clock starts when the picture can be painted, not when the element mounts.** These are
original files on a NAS, and a photograph whose bytes took four seconds to arrive would be shown
for one — the feature failing in precisely the conditions it exists for. So the still stage starts
its own clock, on `complete`, which also covers the case easiest to miss: a picture already decoded
in the other slot has fired `load` and will never fire it again. A picture that cannot be shown at
all — no cover generated, or a file that will not decode — starts immediately, because there is no
decode to wait for and stalling is the thing being removed.

**A photograph that completes its dwell counts as watched; a cover standing in for a film does
not.** The whole of a photograph is on screen for the whole dwell, which is the same claim
`min(30s, 90% of duration)` makes about a short video — and without it "unwatched only" over a
library of pictures is a filter that can never change. A thumbnail of an unconverted film is not
the film, so that path records nothing at all. Only an _elapsed_ dwell counts: never on arrival,
never on pressing Next early, and never while the tab was hidden, because the clock does not run
then. "Opened at all" was rejected once and does not return through a side door.

**A held show needs a transport, and a photograph had none.** A play and pause control over the
picture, and a line showing how much of the dwell is left — a picture with a clock running on it
and nothing saying so reads as frozen, where a video at least has a scrubber. It is the
photograph's own play button and not a second way to turn the queue on: what it does is hold and
resume a show the switch already started, so it is absent when no show is running, because a pause
button for a clock that is not counting is a lie. **The picture itself is that button too**, as the
film already was — clicking a video toggles it, and stopping on a photograph you want to look at is
the same gesture aimed at the same thing, so reaching for a small control in the bar was friction
with nothing behind it. The pointer says so only while there is a show to hold. The line is animated by CSS and never by React
state, for the reason `positionRef` exists on the video side, and it **pauses in place** rather
than restarting — the first version remounted it on every arm, which made holding a show at four
seconds of five and letting it go sweep the bar back to empty first. It is also the one thing here
that reduced motion does not collapse: it is information, not decoration.

**Autoplay on arrival is sound-only, and is allowed to fail.** Browsers refuse to autoplay
with sound until the origin has earned enough interaction, and the usual workaround is to
start muted and offer a "tap for sound" control. That was considered and rejected: a library
of home video played silently by default is worse than one that occasionally sits paused
until you press play. So the attempt is made with sound, and if the browser refuses, the
video waits. This is a deliberate, visible inconsistency on first visit in a fresh browser.

**The preference lives on the device, not the account.** `localStorage`, not `UserPref`.
Autoplay on the sofa and silence on the train is the common case, and it is a property of
where you are rather than who you are. The `prefs` API stays uncalled for now.

### The viewer's layout

Four tiers, top to bottom, each with a fixed place:

1. **The way back, and the way through** — back on the left; on the right the position ("12 of
   116"), Prev and Next, and a **Playback** menu.
2. **The stage** — the player or the still, capped at `max(40dvh, min(75dvh, 100dvh − 17rem))`
   so the title row is on screen when the page opens on a laptop. Three quarters of the
   viewport plus the player's bar put it below the fold; the floor keeps a picture on a phone in
   landscape.
3. **The item** — its name, then the rating, favourite, add to playlist and Details, every one
   at one height. They were 22, 28 and 36px, which read as three different systems. On a phone
   they go icon-only: labelled, they overflowed a 360px screen.
4. **Its content** — Frames, the clip being marked, Clips, then each tag facet and the note,
   then Up next, under one label style.

**What you write about an item is on the page, not in the drawer.** Tags and the note sat in
the Details drawer below the facts, which meant describing a film with a panel covering it, and
one tap more than anything else you do while watching. They are always open, after Clips — the
things the item already has — and before Up next, which is the way off it. The drawer keeps what
you read: facts, provenance, the delete.

**Each facet is its own section.** Performers, Sources and Keywords each get a heading at the
same tier as Frames, not one "Tags" heading over three boxes. They are one mechanism underneath,
but the navigation gives each its own page, and the item should present them the same way.
Keywords alone has two boxes, Shared and Private, because it is the only facet that can be
private (§6). The note is its own section beside them. Four columns on a wide screen, two on a
tablet, one on a phone.

**Every field has the same line above it**, holding a line's height even when empty, and nothing
on it that can wrap. On Keywords it says whose the box is — Shared or Private, as one word. On
Performers and Sources it says nothing of the kind: they are always the library's, and a word
true of every box it appears on distinguishes nothing. The line was once drawn only where it had
something to say, and then the first box of each section started at a different height: down a line under Keywords, down a line under
Performers only once somebody had tagged it (the contributor names), level under Sources. The
contributors share that line and truncate, and the save spinner is inside the box.

**A note left mid-sentence is saved anyway.** It saves on blur, and the page moves on by itself
— autoplay goes to the next item, which unmounts the box without blurring it. It also saves on
unmount now.

**The playback preferences are a menu, not a row.** Play on open, Autoplay next and Hold each
picture sat between the title and the item's content, with the same weight as the frames and
clips below them, for settings made once and left. And the row moved: "Play on open" was shown
only for a film, so "Autoplay next" slid sideways every time a mixed set changed between a film
and a picture. In the menu every one is always present except the hold, and nothing moves. They
are still device settings, one tap away, and still not a settings page.

**Hold each picture is offered only where it can apply**: a still on the stage, a next item
that will be shown as a still (its details are already fetched), or a photograph anywhere in the
loaded stretch ahead. A film further on that cannot play is not predictable from a list row, but
it becomes a still the moment it arrives. It was offered always — across a set of nothing but
films, where it governs nothing. While a show runs the hold is also in the still's own bar,
which is the one place certainly on screen, full screen included.

**A still always has a full-screen button.** It had one only while a show ran, so `f` was the
only way to give a photograph the screen, where a film always had its button.

**Every frame is on the page, and the cover is chosen there.** The strip used to appear only
once somebody had captured a frame, which hid the generated frames — and the choice of cover —
behind the Details button, and the panel carried a second copy of the strip. It is always shown
for a film now, captures first, and the panel no longer has a Cover section. A photograph is its
own cover and has no strip.

**Marking a clip has a button.** `[` and `]` were the only way in and nothing said so; a scissors
button in the player's bar marks the start, and once a start is marked and the playhead is past
it, the end.

**Speeds go down to a tenth.** 0.1× and 0.25× join the menu, and `-` steps below a quarter to a
tenth: the slow end is for studying a moment frame by frame without pausing, and a quarter is
often still too quick for it.

**The name is two lines at most**, in the display face every other screen's heading uses — it
was the one heading in the UI sans, and the most important one. Names come from filenames and
some run to a paragraph; the whole of it is the heading's tooltip, and the Details panel's title
does the same.

**The Details panel's title had no background** — the study dims the shell's header and navbar,
and did it with bare `header, nav` selectors, which also caught the panel's sticky `<header>`.
The rule is scoped to the shell's own classes now, and Drawer and Modal wear `--ps-surface`
rather than Mantine's neutral grey, with a hairline under the sticky header.

### Fullscreen is given to the document, and the player is laid over the page

The obvious implementation is `requestFullscreen()` on the player's own container, and it was
the first one. It has a fault that cannot be fixed from inside it: the fullscreen element
belongs to _this item's_ player, so stepping to the next item removes it from the document and
leaves a fullscreen window with nothing filling it.

Re-requesting on the arriving player was tried and is not good enough. Entering fullscreen
needs a user gesture; pressing Next is one, but a video _ending_ is not — so the single path
that runs unattended, autoplay rolling through a set, is exactly the one that falls out of
fullscreen. That is the viewer this feature is for.

So what goes fullscreen is `document.documentElement`, which no navigation replaces, and the
player _fills_ the screen rather than being it: `data-fullscreen` on its container, and the CSS
lays it over the page. Moving between items then makes no fullscreen call at all — the window
never left it — and the intention lives outside React, where a player that mounts inherits the
screen and a player that unmounts holds it open for a moment in case another arrives. Walking a
set stays fullscreen; going back to the library does not.

Two things fell out of it. A menu in the control bar is a portal at the end of the body, which
is _outside_ a fullscreened container and was therefore never painted: the speed menu did
nothing in fullscreen, and now works. And the stage's frame gives up its stacking context while
a player inside it is fullscreen (`:has()`), because a `z-index` of 200 inside a context of 1 is
still under the app shell — which is how the sidebar came to be painted across a film.

**The bar leaves when it is not wanted, and only on a full screen.** In the page it sits under
the picture and hides nothing. Over a film it is a permanent caption, so it goes after three
seconds and comes back on the first pointer move, key or touch — the rule every player people
already know uses — and the cursor goes with it. What holds it open is everything that says the
viewer is still using it: a paused video, a scrub in progress, the pointer resting on the bar,
an open menu.

### The screen stays on while something is being watched

A browser keeps the screen awake by itself for a video playing with sound, and for nothing else.
A muted film or a slideshow of photographs let a phone dim and lock part way through.
`useScreenWakeLock` asks for a screen wake lock while the player is playing (`VideoPlayer`) and
while a show's clock is running (`useStillDwell`, so the item page and the tasting both get it).
That covers every place something is watched rather than browsed.

- **It needs a secure page.** Over plain `http://` the API does not exist, and the hook does
  nothing there instead of failing.
- **The browser drops the lock whenever the tab is hidden**, so it is asked for again when the
  tab comes back.
- **It is released three seconds late.** Each item holds its own lock, and handing the screen
  from one item to the next would otherwise leave an instant with none, in which a phone whose
  timeout had already run out would dim.

### Playlists

Hand-ordered lists, built by picking items and dragging them. The API — CRUD plus item
reordering — had been complete since phase 0 with nothing calling it, exactly as saved filters
had; the pages below are that caller.

**They sit in the nav beside saved filters**, because both are answers to "a collection I
care about" and splitting them across two places makes neither findable.

**Opening an item from a playlist makes previous/next follow the playlist**, not the library
filter. This is the same mechanism as above with a different set behind it, and it is the
reason the two features were chosen together.

**Shuffle is a permutation of the stored order, never an edit to it.** A playlist has an
order someone arranged by hand; shuffle is a second order laid over it for a while. The grid,
the up-next strip and previous/next must all agree on which of the two they are showing, and
the library already had the same problem in the `random` sort. It is solved once, for both.

**The permutation is computed over a dense key.** `shuffle.ts` turns a seed into an
addressable permutation of a dense integer key, which is why any page of it can be jumped to
without a sort (§20). A playlist feeds it `PlaylistItem.position`, which is already indexed
and _is_ its membership, so every slot hits. The library used to feed it `Media.rowid` and
filter afterwards, which made a filtered shuffle draw slots that mostly missed; it now sorts
the matching set by the same arithmetic instead (§20, "A filter never depends on the sort").

**The seed lives in the URL and nowhere else.** That is what makes the three views agree —
they do not ask a second question, they parse the same address. `returnTo` already records it,
`LibraryView` already carries `seed`, and `useViewerSequence` already latches the first answer
it gets, so previous/next and the strip follow a shuffled playlist with no new plumbing.
Session state or a column would each give the viewer somewhere else to read a different answer
from.

**Nothing is written when you shuffle, and dragging is switched off while you are.** The seed
never touches `PlaylistItem.position`. The one gesture that could still be mistaken for an
edit is a drag: moving an item in a shuffled view would have to infer a stored position from a
shuffled one, and any inference is a surprise. So reordering is disabled while shuffled, with
the toggle as the way back to it — a shuffled playlist is something you are playing, not
something you are arranging.

**A shuffled playlist still says "7 of 40", and so does a shuffled library.** A shuffle is
an order over a set, not a different set, so its total is the set's. A playlist's is a cheap
indexed count; the library's is the same once-per-filter count every other sort uses (§20).
The shuffled case is where you most want to know how much is left. That readout is only honest if positions
are dense, which is why removing an item now closes the gap it leaves — see `removeItem`.

**`Playlist.sortMode` holds the list's default, and the toggle never writes it.** Opening a
playlist with nothing in the URL uses the stored default; the toolbar toggle changes this
visit only. "Shuffle this time" and "this is a shuffle list" are different statements, and a
toggle with a lasting consequence would collapse them — so the default is set deliberately,
from the playlist's own menu. `NULL` means nobody has chosen, which is the stored order.

**Reshuffle is its own button.** Turning the toggle off and on again would reach the same
place, and a fresh seed is the thing people actually want from a shuffle that has gone stale —
consecutive seeds are already mixed so that the next one is an unrelated order rather than the
last one shifted by a row (`shuffleParams`).

**The address says which order it means, even when that order is the stored one.** `seed=N`
is a shuffle and `order=stored` is not, and one of the two is always present once anybody has
touched the toggle. Leaving the stored order unmarked was the obvious spelling and is wrong:
switching shuffle _off_ would produce a bare address, a bare address falls back to the list's
default, and a list that prefers shuffle would switch itself straight back on. The undecided
state therefore exists for exactly one render, on first arrival, and the page writes the
resolved order into the URL before anything downstream reads it.

**Arranging is a mode, and it is a list rather than a grid.** Ordering is the task, and a grid
asks you to reason about a sequence in two dimensions — "third" is obvious in a column and not
in a rack. Each row carries both a drag handle and a pair of arrows. The pair is deliberate
rather than redundant: dragging is the natural gesture and the one §14b describes, and HTML
drag events do not fire for touch, so a drag-only implementation would make arranging a
playlist a thing you cannot do on a phone. The arrows are the same operation stated as a
control, and they are the accessible route as well.

**Items get in one at a time, from the page of the thing you are watching.** That is where the
decision is made. Adding a whole selection belongs to bulk select, which has its own toolbar
and is not built yet — but a playlist with no way to put anything in it is furniture, so the
single-item route exists first rather than waiting for the general one.

**The index page exists for this reason** (now Views & playlists, §14c). The sidebar
carries the pinned few; without a page listing all of them, an unpinned playlist would be
written to the database and then be unreachable. Pinning decides whether a list is _also_ in
the sidebar, never whether it exists.

**A playlist wears a few of its own covers.** It is the one thing in the app with no picture
of its own, so a list of them was a list of names on empty panels — every playlist looked
alike, and a full one looked identical to an empty one. Each card carries up to four covers
drawn from _across_ the list rather than off the top of it: a playlist frozen out of one
filter would otherwise show four near-identical stills from its opening minute. Evenly spaced
rather than random, because a card whose face changes on every visit is a card nobody can
learn to recognise, and the arithmetic costs the same either way. `PlaylistItem.position` is
dense — `removeItem` closes its gaps for the shuffle's sake (§14b) — so evenly spaced indices
land on entries that exist.

The sample is each viewer's own: it goes through `mediaRepo.listByIds` exactly as the items
do, because a thumbnail is as much a disclosure as a row, and a shared playlist reaching into
a library this account cannot open shows a blank card rather than a peek at it. One media read
serves the whole list, so the cost of the page is not the number of playlists somebody keeps.
The sample is deliberately wider than the four shown — an entry can fail to yield a cover
twice over, by being invisible or by not having had its artwork generated yet, and a mosaic
with one thumbnail and three holes reads as broken rather than as sparse.

**The room lists libraries only when there is more than one.** A section headed "Your
libraries" holding a single card is a door beside the door you came through: everything on the
page is already that library, and the grid is one nav item away regardless. The sidebar
already applies the same rule to its own list.

**The grid does not mark an item as watched.** It used to, with a brass tick in the top-right
corner of the frame — which is the same object, at a glance across a rack, as the brass
selection checkbox eight pixels away on the other side. Two small brass marks in the corners of
one frame are read for each other, and this is the second time that mistake has had to be
corrected on this tile: the favourite was a brass star until it was mistaken for a rating and
became an oxblood heart. "Have I seen this" is either a question about one item or a question
about the whole library, and the second is answered better by the filter panel's Watched
control, which can also ask it the other way round. The progress bar stays: it says where you
stopped, which is a different fact and has no twin on the tile.

**"Tag" is the umbrella; the catch-all facet is a **keyword**.** The word was doing both jobs —
the general word for anything you can attach to an item, and the name of one facet beside
`performer` and `source` — so every list of facets named one of its members after the whole
set. The umbrella keeps the word, because it is the word everybody already uses for the
concept and the one the table, the routes and the page are named after. The catch-all gets the
narrower one: _Performers · Sources · Keywords_.

This is a display label and nothing else. `Tag.kind` still stores `"tag"`, so no row moves and
no query changes; `apps/web/src/lib/facetLabels.ts` is the single table, replacing the three
copies that had grown up in the filter panel, the item editor and the vocabulary screen — they
had already drifted, "Source" being plural in one and singular in another, and a rename
reaching two of three would be worse than no rename at all. The fallback still capitalises a
facet it has never heard of, because `kind` is an open string and a tag that cannot be seen is
a tag nobody can remove (§5b).

**A tag section is named for whose it is, never for what is in it.** Sections say **Shared**
and **Private** rather than "Tags" and "My tags" — the distinction that actually separates the
two systems (§6), and the one thing the word "tag" could never carry, since everything in both
is a tag. The scope control on the two write dialogues says the same two words, so the heading
you read and the button you press are the same vocabulary.

**And the word stands alone.** Each heading used to carry a badge restating it — "Shared ·
everyone", "Private · private to you", and on the vocabulary screen "anyone can add" and "only
you" — so one distinction had three vocabularies and every box said it twice. The word is the
label everywhere; what it means in practice ("Everyone sees these…") is its tooltip.

**And it is said of keywords only.** Performers and sources share the table with keywords but
can never be private (§6), so nothing calls them shared: not the item editor, the filter panel,
the Tag or Untag dialogue, or the vocabulary screen. Wherever public and private keywords meet,
the distinction is drawn; wherever it could only ever have one answer, it is left unsaid.
`ScopeLabel` is the one component that says it, and its callers ask `allowsPrivate(kind)`
first. The Keywords page's private list is headed Private rather than Yours.

**Tags › Manage is split the same way.** It was two cards, one per system, each a table with a
facet filter over it — so the first put every performer under "Shared". Now it is a card per
facet in `tagKinds` order, each a `VocabularyTable` fixed to that facet (no facet filter, no
Facet column), and Keywords holds two, Shared then Private. The known facets are drawn empty too.
A facet a scraper invented gets a card after them, found through `GET /api/tags` with no kind
(`tags.kinds()`), because this is the screen where a stray facet gets tidied and one with no
card could not be. The administrator-only note sits on the card for Performers and Sources and
on the Shared half of Keywords: your private keywords are always yours to rename. Each table
sorts by Count or A–Z, A–Z by default, and the sort is the query's (`sort` on the vocabulary
request) rather than the component's: a table paged fifty at a time and sorted in the browser
would show the busiest of the first fifty names, not the busiest tags.

**The filter panel's tags are laid out exactly as the item page's.** It used to have a Shared
section holding Keywords, Performers and Sources as dividers, then a Private one: one list that
happened to change subject partway down, and grouped differently from where the tags were
written. Now each facet is a section, in `tagKinds` order, and inside it the same boxes the
editor has — Shared, then Private, for Keywords alone (§6) — under the same line, which is one
component (`ScopeLabel`) used by both so the words cannot drift. Every known
facet and box is drawn even when empty ("No performers yet"), as the editor draws them, so the
panel does not rearrange itself the first time somebody tags a source. The filter's only
additions are the count badge on each heading and "show all" on the line.

**Watched is said one way.** The filter control was labelled "Watched" with options "Seen" and
"Unseen", and the chip it produced said "Seen" — one filter wearing two vocabularies, which
reads as two filters. The control keeps its name and its options are Yes and No, because the
row has already asked the question.

**The cellar is set in Young Serif over Atkinson Hyperlegible.** Inter and Bitter were the
theme's first answer and neither was chosen so much as reached for; Inter in particular is the
house face of everything, which is the opposite of what a private room should sound like. The
display face is old-style with heavy slabbed serifs — estate letterpress rather than luxury
branding, and solid at 18px where a high-contrast face goes thin. The interface face was drawn
by the Braille Institute for low vision, which answers the binding contrast requirement in the
typeface rather than around it: the app is dark, the room is dark, and metadata runs at 11px.

Both are loaded by `next/font` at build time and served from our own origin, so a NAS with no
outbound internet still has its fonts and no page load reaches a third party. **The CSS
variables are named for the role — `--font-display`, `--font-ui` — not for the face**, because
a variable called `--font-inter` holding something else is how a theme starts lying about
itself, and this theme spent its first year naming two fonts it never loaded and rendering
every heading in Georgia.

Two constraints come with the pairing and are accepted rather than worked around. Young Serif
ships **one weight**, so headings are 400 and hierarchy comes from size and colour; a
synthesised 600 thickens the slabs unevenly at the sizes headings run at. Atkinson shipped
**400 and 700 and nothing between**, so `fw={500}` resolved down to 400 — a real step lost. Since
2026-10-11 the interface face is **Atkinson Hyperlegible Next**, the same family redrawn by the
Braille Institute as a variable font from 200 to 800 with an italic, so the step is back and
every weight the code asks for is real.

The four pairings this was chosen from, each set on the app's own hero, tile and filter panel:
<https://claude.ai/artifact/RSCXVzz1b93qHmTVRYhrY2>.

**Two more faces, each with one job (2026-10-11).** The plate title is set in **Grenze Gotisch**,
blackletter, as an estate's name is on a German wine label; the same face sets the single
oxblood initial that opens a collection's description, and nothing else. The private note is
set in **Homemade Apple**, a hand, in chalk white: the app's voice is typeset and a person's is
written, and the note is the one field that is nobody's words but yours. Both load through
`next/font` like the first pair, as `--font-label` and `--font-hand`, named for the role. The
old rule was "no third family"; the rule now is that an extra face has one named job and does
not leave it, because a blackletter that spreads from the plate to the nav is a costume rather
than a label. The plate keeps one size on every page, raised to 2.5rem because a Gothic's
counters close below it, and its rule is doubled -- two hairlines, as a label rules its name.
The rule stays gilt rather than the label's oxblood, since oxblood means deletion everywhere
else. The seal is shown large on the sign-in card and in About as a **cork stamp** (`CorkStamp`):
the estate's words run round it on a ring that turns once a minute and stops under reduced
motion. The worlds these were chosen from: <https://claude.ai/artifact/1gURobsJMFdZTLcUTxX1QB>.

### One box for typing a tag, and a list for taking one off

Four screens took tag names and only one of them suggested anything. The item editor fetched
its facet's vocabulary on focus; the selection bar's dialogue and the filter-wide apply — the
two controls that can write thousands of assignments in a gesture — rendered a bare box. That
is backwards, and it is how a library ends up holding `beach`, `Beach ` and `beaches` as three
different words for one thing.

**`TagNameInput` is the one box now**, used by all three. It suggests from
`GET /api/tags?kind=&scope=&q=` — what is typed, debounced, searched across the facet's whole
vocabulary by the server's rule and ordered by how well each name matches (`orderTagMatches`,
§5b "One rule for names"); it used to fetch the 500 most-used names and filter them in the
browser, so a rare name was never offered and the box invited its duplicate. **The count is
shown beside each name** — without it a stray `Beach ` on one item looks exactly like the
library's `beach` on four hundred, and the stray is what somebody is about to apply to four
hundred more. It still surfaces `beachfront` while you type `beach`, and Enter still commits
what was typed. A fragment from inside a word ("ach" for "beach") no longer finds it; a word's
start, a glued spelling of four letters or more, and a near spelling still do. A vocabulary
nobody can add to stops describing the library within a week, so coining a name that is a
_prefix of an existing one_ has to keep working.

**Untagging takes tag ids, and the screen lists them.** It used to be the Tag dialogue in
another mode, inheriting a box for typing — so removing a tag meant remembering how somebody
else had spelt it, and a near miss did nothing. Worse than nothing, in fact: the service
resolved names through `ensureTag` _before_ it consulted the mode, so a misspelt untag **coined
the tag and then removed nothing**. Taking ids makes that unsayable rather than merely
unlikely; there is no name in the request to create. `POST /api/media/bulk/tags` answers what a
selection carries, with how many of it carries each, because nothing could: `getFacets` counts
a `MediaQuery` and a selection is a list of ids, while the grid's tiles hold a truncated two
names and a `+3`.

It is also **the one tag dialogue with no facet control and no scope control**. Both are
properties of a tag that already exists, so they are reported rather than chosen — which is
what lets it show both systems at once. It is laid out as the item editor is — a section per
facet, Shared and Private boxes inside Keywords only. There is no switch to be wrong about
before removing something from everybody, and the audience is stated in a sentence instead,
naming what is ticked ("Shared keywords and performers are removed for everyone."), because no
single word is true of a mixed set.

**Tag and Untag stayed two buttons.** One dialogue holding present-tags-as-chips plus an add
box would be fewer screens and reads well on paper; it also makes adding and removing the same
gesture in different places on one surface, which is the property that made the old mode switch
dangerous in the first place.

**Tagging a selection and tagging a filter are one dialogue** (`BulkTagDialog`), told which set
it is for. They were two copies of one layout that had already started to drift. A filter gets
the preview count, the refusal above the limit and the withdraw note; a selection gets none of
those, because it is on screen and was ticked by hand.

**Where the names go is one four-way control:** Keyword (shared), Keyword (private),
Performer or Source — the two keyword segments together, and only they saying whose. It used to be a Shared/Private switch plus a facet dropdown. On a phone the
dropdown cost two taps and a full-screen list before anything could be typed, which made adding
a performer the slowest thing in the dialogue. Only `tag` can be private (§6), so the
combinations number four and fit on one row. Each keyword segment names its audience under it,
so the audience is still chosen in front of the confirmation, and for keywords the Apply button
still says "for everyone" or "privately". The name suggestions open **above** the box, sized to
the room there: below, they covered Apply for as long as the box had focus. They also wait for the first
letter. The box is focused when the dialogue opens, so a list shown on focus alone covered the
facet control at the moment somebody reached for it. By the first letter the facet has already
been chosen.

**The library's selection bar is sticky, not fixed.** Laid over the page, it permanently
covered the last row of tiles, and on a phone, where it wraps to two or three lines, those
tiles' names could not be read however far you scrolled. Sticky keeps it pinned while
scrolling but gives it a place of its own at the end of the page, so every tile can be
scrolled clear of it without anything measuring the bar.

Two things the merge screen had wrong came out with it. Its "Merge into" picker offered only
the vocabulary rows then on screen, so the commonest merge there is — a stray spelling into the
canonical name — was the one sort order put on another page; it is server-searched now, through
the table's own endpoint. And the merge and delete routes answered `{ ok: true }` while the
screen read `result.affected` off it, so both confirmations said "undefined items moved". The
services had always counted; the routes were throwing it away.

### Taking off the last use of a tag deletes it

A typo applied to one item and then taken off again used to stay in the vocabulary — in every
suggestion list, with a count of zero — until somebody went to the Tags page to delete it. Now
**removing a tag's last assignment deletes the tag**, silently, in the same transaction:
untagging one item, a replace that drops it, untagging a selection, withdrawing a bulk apply.
It lives in the repo (`tagRepo.pruneUnused`, called by `unassign`, `replaceFacet`,
`clipTagRepo.unassign` and `tagBatchRepo.undo`) rather than in each service, so no path that
removes assignments can forget it. A tag a clip still carries is in use (§14d "Tagging clips"),
and so is never pruned or listed as unused. No client change: every one of those mutations already invalidated `tags.all()`,
because untagging could always retire a name from the counts.

Three things are deliberately not pruned:

- **Only tags an assignment was just taken from** — never a sweep. A tag coined on the Tags
  page has no items on purpose, and deleting it for being empty would delete what somebody had
  just asked for.
- **A tag with aliases.** Somebody curated its other names; that is not what a typo looks like.
- **Tags emptied by a purge.** An item leaving the library takes its assignments by cascade,
  and the performer who was on it is still a performer. The rule is about a person taking a tag
  _off_, which is the moment a mistake is corrected.

Not a trigger on `MediaTag`, for the reason the ownership pairing is not one: it would fire on
the cascade from a purge and from deleting the tag itself, which are exactly the cases above
that must not prune.

### The cellar, turned up

The theme was coherent and quiet to a fault: a ground and a surface five points apart,
hairlines at eight per cent of a warm white, and an accent that appeared almost nowhere at
full strength. Read at candlelight that is one flat brown field with borders drawn on it.
Three changes, each at the token level so nothing had to be restyled by hand.

**Three planes, far enough apart to be three.** Ground `#0f0d0b`, surface `#1e1a16`, well
`#0a0807` (they were `#14100d`, `#251d16` and `#0e0b08` until the gilt palette below). The rack is furniture: a shelf stands off the wall and a bottle sits back into the
shelf, and the eye should get that before it finds a single hairline. The lit top edge of
`rackEdge` doubled, because that edge is what does the lifting and the shadow beneath it is
only there to let it. Deepening the ground also _raised_ every contrast ratio on it, which is
the one direction the binding requirement will accept.

**A scale with drama at the top.** Mantine's headings run 34 / 26 / 22 / 18 / 17 / 15 — a flat
1.3 at the top and barely a percentage apart at the bottom. `headings.sizes` now steps by
roughly a third, and h1 is fluid up to 60px. This is not decoration, it is forced: **the
display face ships one weight**, so every step of the hierarchy has to be carried by size,
colour and space, and a scale that steps by a tenth cannot carry it. h1 is fluid because it is
the one place a heading is meant to be an event; everything below it stays fixed `rem`,
because fluid type in a dense product UI makes the same row a different size on two machines.

**Gilt and verdigris (2026-10-11).** The accent moved from aged brass (`#cfa659`) to gilt
(`#e4b955`), and the ground went blacker with it, so the room reads as gold leaf on black
rather than as brown wood. Oak keeps the text and is pulled a little towards the gold and away
from red. Verdigris -- what old brass turns into -- joins as the one cool colour, and has one
job so far: the "ready" state of the warming instrument, which had been a borrowed traffic-light
green. Oxblood is unchanged. Every text colour still clears 4.5:1 on every plane it sits on;
the closest is oxblood on an input's fill, at 4.3, and oxblood is not set as text there. The
Mantine colour is still called `brass`, because §14 and every call site use that word.

**One loud place per screen: the page plate.** Six screens opened identically — a 22px title
in a 2px stack, a grey subtitle, then the controls — and you could not tell Trash from
Playlists without reading. `PagePlate` replaces all of them: an 11px brass eyebrow at 0.2em,
a serif title (one size on every page; see House rules), the screen's one real action beside it, and a brass rule underneath that
travels and gives out. The rule is the **only** place in the app the accent is spent at full
strength, which is the entire reason brass reads as an accent anywhere else; it draws itself
in over half a second on mount, and not at all under `prefers-reduced-motion`. The eyebrow
carries the state that used to be a subtitle — "A scan is running…", "412 groups to review" —
so a line that was furniture became the line that tells you what is happening.

What was deliberately _not_ done: no glassmorphism, no glow, no gradient text, no second
accent hue. The room already had its light and its grain; it needed contrast and a voice, not
effects.

### House rules

A review of every page the navigation reaches found the plate on half of them and a 38px
`Title` with nothing under it on the other half, six styles of section heading, three kinds of
Cancel, a spinner in the top-left corner on some pages and centred on others, error handling
on three screens out of twelve, and — the largest single thing — every card, input, default
button and the shell itself in Mantine's neutral grey. These are the rules the pages now
follow, written down so the next page starts from them.

1. **Every page opens with `PagePlate`, at one size.** There were two: a 60px display title on
   screens you "arrive at" and a section-sized one on screens you "work in". The reasoning held
   and the result did not -- Reels and Clips sit side by side in the navigation, and moving
   between them made the heading jump from 60px to 26px, which read as inconsistency rather than
   as meaning. So every page uses the working size; the eyebrow, the serif and the rule carry
   the letterhead, and the content keeps its room. The title is the navigation's label for the page; a
   detail page's title is the thing's own name. The eyebrow is the page's **state** when it has
   one ("12 clips", "3 items held", "412 groups to review") and where it sits when it has not.
   A back link only on a detail page — a playlist back to Collections, a reel back to Reels.
   The library keeps its "← Home" on a phone only: it is reached by drilling in from the room's
   shelves, and there the navigation is behind the burger. On a wider screen Home is in the
   sidebar beside it, and the link was a second copy (`back.phoneOnly`).
2. **One primary action, filled brass, in the plate's `actions` slot** — New reel, New playlist,
   Scan now, Play. Secondary actions are `default` in the same slot. Rare actions go behind a
   `MoreGlyph` menu. What a list _shows_ — filters, order, layout — is a working row under the
   plate, never in the action slot.
3. **Headings:** `Title order={4}` for a page's sections and a card's title; `SectionLabel`
   (uppercase, tracked) for a group inside a panel or under the viewer's title. Bold `Text` is
   not a heading.
4. **States:** loading is `PageLoader` (centred, brass) _under_ the plate, never instead of it,
   and a list showing its previous answer while the next loads is `settling()` (§14, "Waiting");
   a failure is `LoadFailed`, whose wording distinguishes a sleeping server from a missing
   item from a permission; nothing-here is `EmptyState` — a line in the display face and one
   sentence of what would fill it.
5. **Colour:** no hex or `rgb()` in a component; the tokens are `--ps-*`, and Mantine's `dark`
   tuple is warmed in `theme.ts` so every surface Mantine draws for itself is warm too. No
   Mantine `red`, `yellow` or `gray` as meaning — destructive and urgent are oxblood,
   in-progress is brass, neutral is oak.
6. **Icons come from `Glyph.tsx`**, drawn at the size the control needs; no typed `▶ ⋯ × ✕ ↑ ↓`.
7. **Dialogs:** Cancel (and "Keep it") is `variant="default"`; a destructive confirmation is
   filled oxblood, and anything that deletes asks first. No `window.confirm`.
8. **Two layouts of one list are a `SegmentedControl` showing both**, never a button labelled
   with the state it is not in. The same job gets the same control on every page: Grid/Gallery
   is `LayoutSwitch`, Arrange is one button on a playlist and on a reel.
9. **On a coarse pointer every control is 44px** — buttons, segmented controls, switches, stars
   and text inputs, by one rule in `globals.scss` rather than per component. Icon buttons
   keep Mantine's size: a 36px square stretched to 44 tall stands off the line of its row.
10. **Mantine sits in a cascade layer** (`styles.layer.css`), so our rules beat its rules by
    being ours, not by arriving later. Next orders stylesheets differently in a production
    build than in dev, and every tie between a class of ours and one of Mantine's went
    opposite ways in the two. Nothing of ours needs a second class to win.
11. **A page's content may keep a readable measure; its plate does not.** The rule runs the
    page's width, and a narrower column of cards sits under it.

### The study next door

The library is the cellar: racks, hunting, a hundred thousand things. The viewer is the next
room along, where you sit down with one of them — and it had no way of saying so. It was the
same room with a video in it.

**`useStudyRoom` closes the door.** It puts `data-room="study"` on `<html>` while an item is
open and takes it off when you leave. That is one flag driving token overrides in
`globals.scss`, not a prop threaded through the shell, so changing rooms re-renders nothing:
the ground drops to `#0b0806`, the grain comes up (a darker room shows more of it), the
firelight that plays across the cellar goes **out**, and the shell gives up its border and its
contrast without moving a pixel. Light you can see coming from two places at once is not light
from a screen. The tokens carry a 420 ms transition, which is what makes the two rooms feel
adjacent rather than swapped; the active nav link keeps its brass, because where you are is
the one thing in the receding shell still worth reading.

**`useSpillLight` makes the glow the film's own.** The frame has always thrown warm light onto
the page, and that was the design's one sanctioned exception to _warmth lives in the chrome_:
a lit screen in a dark room genuinely does throw light. But it was a fixed amber — the same
colour for a night scene and a snowfield, which is the one thing real spill light never is. A
32×18 canvas now samples the picture five times a second, averages it, pushes the chroma back
out around its own luminance (an averaged frame is muddy by construction), eases toward the
result, and writes `--ps-spill` and `--ps-spill-amp` for the stage's shadow to draw from. The
amplitude matters as much as the hue: a dark scene should dim the room rather than merely tint
it. Measured on a harness rather than guessed — amber reads `233, 103, 38` at 0.90, a dark
scene `52, 43, 44` at 0.59, a frost scene `150, 177, 198` at 1.00.

Every part of it is an enhancement over a page that already looked right. 576 pixels is a
rounding error next to the frame the GPU drew anyway; sampling is 5 Hz rather than per-frame
because light on a wall has no business being frame-accurate; it stops when the tab is hidden;
and under `prefers-reduced-motion` it never starts. In that case the CSS default stands, and
the CSS default is the static amber that was there before.

**The element that lights the room volunteers.** The first version preferred the `<video>` and fell
back to an `<img>`, in that order rather than by a `"video, img"` selector, so that no decorative
image the player grew later could quietly become the thing lighting the room. Stills in a show broke
it the way document order always breaks: a still stage holds _two_ stacked images, one of them the
picture you are about to see, and `querySelector("img")` would have lit the walls from a photograph
nobody can see yet. So the source is marked — `data-spill`, which the player puts on its live
`<video>` and the still stage on its active `<img>`. That is a stronger rule than the ordering it
replaces rather than a relaxation of it: a decoration cannot light the room because it would have to
ask, and "the active one of two identical elements" is not something document order can express at
all. A photograph in a show now lights the room, which it should always have done.

The harness the light was tuned on, lit by a drawn film rather than by anything from the
library: <https://claude.ai/artifact/JEt3vYLdgFwLajw75RhvRT>.

### The front door is about the collection, not the machine

The room fetched `/api/library/stats` — polling every three seconds while a scan ran — for a
single consumer: an empty state reporting how many folders were found, how many were enabled,
whether a scan was running, and offering an administrator a button to go and turn roots on.
All of that is true and useful, and none of it is about the collection. It is the state of the
installation, and the front door is where somebody arrives hoping to be handed something.

So the room says a sentence and offers a door. **The diagnosis still exists in the two places
that can act on it**: the library, which is where you go when you expected to find things and
did not, and the admin screen, where they get turned on. The poll went with it.

The shell's "14 queued" badge went too. It is the worker's depth rather than the library's —
up when something is being made, down when it is made, and nothing a person can do with the
number in between — and it sat on every screen including this one. The admin screen shows the
queue in full. "Scanning" stays: a catalogue growing under you changes what you are looking at.

The room gained the thing it was missing. **Playlists are the most personal thing in the app**
— an order somebody chose — and until now the only route to one was the sidebar. Four at most,
above the doors into everybody's shelves, absent entirely when there are none. They earn the
place only now that a playlist has a face to show.

### The library link remembers where you were

Filter state lives in the URL, which is what makes a view shareable and the back button honest.
It also made the _Library_ item in the sidebar a constant: step out to Tags or a reel, come back,
and you were at the top of an unfiltered rack with the filter you had built gone. On a collection
this size rebuilding it is the whole cost of having left, and the answer people reach is to stop
leaving.

So the address is remembered and the sidebar link points at it. Nothing about the URL's meaning
moves — a remembered view is an ordinary library address, and every other way in still says what
it means: a tag, a shelf, a shared link and a saved view are all unchanged. Only the one control
whose job is "take me back to the library" learned what that means.

**The page is not part of it.** Page seven of a filter is a position in a view rather than the
view, and a set that has shrunk since would restore somebody to nothing at all. The viewer's own
"back to library" still keeps the page, because that _is_ a return to a position (§14b).

**The room is not remembered either.** It is the front door, it has no filter to restore, and
remembering it would make Library point at what Home already is.

**Videos are what the first visit opens on** — no longer because this link says so, but because
an address without a kind is the videos everywhere (§14e "Videos unless you ask"). This link
used to be the only way in that said `kind=video`, and every other one opened on everything.

**On the device, not the account**, with the playback preferences and for the same reason: what
you were last looking at is a property of where you are sitting, and it is not worth a round trip
to restore a link in the sidebar.

**Then it split in two: Library opens clean, and "Last search" goes back.** Pointing the one
entry at the remembered search meant every visit paid for the old filter and sort before a new
one could be asked for -- and "clear all" after arriving cannot save that, because the server's
SQLite calls are synchronous and the clean request queues behind the one already running. So
the clean library got the entry, and the remembered search a row beneath it, shown only when
there is one. It is still one click either way.

Only a search is remembered now: the library as it opens, or one library as its own row opens
it, is skipped. Otherwise stepping into the clean library to look around would overwrite the
search you meant to come back to.

The row's line is the search in a few words (`searchSummary.ts`), for recognition rather than
description: the first term and a count of the rest -- "Alice +2" -- because a list cut off at
the sidebar's edge says neither what is missing nor how much. Terms name the value, not the axis
("Alice", not "With Alice"; "1–5 min", not "Length: 1–5 min"), run from what was typed or chosen
by name down to the broad strokes most searches share, and a saved view is just its name. The
sort is said only when it is the one thing that differs. Tag names come from the library page,
which writes them down as its facets arrive: the sidebar asking for them would be the cost the
clean link exists to avoid.

An × at the row's right edge forgets the search and the row goes with it, until the next search
is made. It sits beside the link rather than inside it, since a button inside an anchor is
invalid markup.

### A saved view can be closed

There was no way out of one. Opening a view put its name in the page title and its id in the
address, and the exits were: delete it, pick a different one, or clear the filters — which
left the name in place and reported the result as **"Edited"**, the app insisting you had
changed a view when what you had done was leave it.

**A view is its query**, so an unfiltered grid is not a view of anything. `clearFilters` drops
the `filterId`, and `leaveViewIfEmpty` applies the same rule when the filters are emptied one
chip at a time — the two routes end in the same grid and have to mean the same thing. Paging
and switching to the gallery are not departures, because they hide nothing.

`closeSavedFilter` is the explicit exit, on a × beside the name it closes rather than inside
the menu: leaving is as ordinary as arriving. It gives back the **plain library** — the videos
(§14e "Videos unless you ask") — rather than the current filters wearing no name — a grid nobody can account for with no title over it is
worse than either state it came from. Keeping the view and throwing away an edit is a
different intention and keeps its own control.

### A failed read is not an empty library

Every screen treated _no data_ as _no items_. The room announced that the cellar was empty,
the grid offered to clear filters that were not the problem, and the viewer said an item
"could not be loaded" over a dead NAS, a deleted file and a library this account cannot reach
alike. On a box at the end of a house's Wi-Fi the commonest cause of all three is a dropped
connection, and **"everything you own is gone" is the worst available way to report one.**

`LoadFailed` says what happened and offers to ask again, and it distinguishes the fault on
this side from the fault on the other: offline is checked first, because `fetch` fails with a
`TypeError` carrying no status at all and "something went wrong" is a poor way to say "you
have no network"; a fetch that never reached the server says the box may be asleep, which on a
NAS is usually true and is rarely fixable in the browser. Each page checks `isError`
**before** its empty state, never after.

### Titles come from filenames

So they break every assumption a title gets to make. A filename can be three hundred
characters with no space in it — a hash, a release string, a path flattened into a name — and
an unbroken run does not wrap: it runs out of its box and takes the column with it.
`overflow-wrap: anywhere` rather than `break-word`, because only `anywhere` lets a container
shrink below the run while it measures itself.

Clamping is the other half, and the hero is why it is not optional: it is a fixed-height
window with `overflow: hidden`, so an unclamped title does not overflow visibly — it pushes
the Play button out of the frame with no clue why. Three lines there, two on a library card,
one on a shelf heading that sits beside a "See all" link. The viewer's own title is
deliberately unclamped: it is the page's subject and the only place the whole name is
readable, so it may be as tall as it needs while never being wider than its column.

Keyboard shortcuts guard on `isContentEditable` as well as on tag names. A rich-text field is
a plain `div` to `tagName`, so the list alone would let every keystroke typed into one seek
the video behind it.

### Who is allowed to claim the library

`POST /api/setup` is the one request that hands out `admin` **and** `delete`, guarded by two
facts: there are no users yet, and the caller is on the LAN. The second guard could be talked
out of. `isPrivateRequest` read the **leftmost** `X-Forwarded-For` entry unconditionally —
which is the entry the _client_ appends, the most attacker-controlled value in the chain, and
the opposite of what the code's own comment claimed. On a deployment whose port was reachable
before setup finished, `X-Forwarded-For: 10.0.0.1` was judged private, the setup token was
skipped, and the library changed hands. The same wrong answer leaked through the
unauthenticated `GET /api/setup/status`.

The address now comes from `clientIpFrom` under `trustedProxyHops` — **the same arithmetic
that identifies a caller for rate limiting (§12)**, counting from the right and returning
nothing when no proxy is trusted. One rule for "who is this caller", used by both.

**The Host fallback is gone, and the deferred §12 decision above is now taken.** That
paragraph used to argue for keeping it: spoofable, but load-bearing, because LAN users reach
the app at `http://nas:8842` with nothing in front and tightening it blind risked making first
boot impossible.

Both halves were wrong, and the first deployment proved it. The fallback did not read the
`Host` header. It read `new URL(request.url).hostname`, and Next's standalone server builds
that URL from `HOSTNAME` — which `entrypoint.sh` sets to `0.0.0.0` so the server binds every
interface. So it read `0.0.0.0` for every caller, matched no private range, and judged
everyone remote. The behaviour being protected as load-bearing did not exist. Worse, first
boot was already impossible: the token those callers were asked for was generated lazily
inside the comparison that rejects a wrong one, and printed nowhere, so no one could obtain
it. `curl http://localhost:8842/api/setup/status` on the NAS returned `isLocalRequest: false`.

The unit test passed throughout because it built `new Request("http://nas:8842/")` by hand —
asserting the URL shape its author expected Next to produce rather than the shape Next
produces. A test that constructs the framework's input is testing its own assumption.

So: no fallback. A caller no trusted proxy vouches for supplies the setup token, which is now
printed the moment it is generated. Reading the real `Host` header instead was considered and
rejected — it fixes the `0.0.0.0` fault and keeps the one that matters, since `Host: nas` is
one line of `curl` and this is the request that hands out `admin` and `delete`. The cost is
that the LAN deployment's first boot needs one `docker logs` to read the token; that is a
step, not an obstacle, and it is the same step the remote path always claimed to require.

A second, smaller one: `reclaimMissingRows` resolved `Artifact.relPath` and `Variant.relPath`
with a separator swap instead of `assertSafeRelativePath`, breaking the rule that paths read
**back out of the database** get the same treatment as paths that arrive in a request. The
value only ever reached `existsSync`, but that answer decides whether a row is deleted. A row
whose path will not resolve safely is now reported as _present_ and left alone, matching this
file's existing posture: refuse to be destructive when confused.

### Bulk selection

Checkboxes on tiles, a bar that says how many are selected, and four verbs: tag/untag, rate
and favourite, add to playlist, move to trash. Tagging is the one with a server already built
(`/api/tags/bulk`, including batch tracking for work too long for a request).

**Select-all takes the page, and only the page.** The Gmail pattern — select the page, then
offer to extend to all 312 matching — was considered and rejected. It is genuinely more
powerful, and the power is pointed at a Trash button. A selection you can see is a selection
you can check.

### What a tile says

Today: duration, favourite, title, height, rating. Added:

**Tags**, at most two chips and then `+3`. A fixed number rather than "as many as fit",
because a tile whose height depends on its content makes a five-column grid ragged, and the
grid's regularity is most of what makes it readable at a glance.

**Watched or not.** There is no partial-progress bar; nothing is resumed across visits (below).

**Date added**, which is what you are actually scanning for under the default sort.

**Favourite is a heart, not a star.** The rating under the title was brass stars, and is now
five wine glasses (§14, "Motion"); a favourite drawn as a brass star said "rated" to anyone
glancing at the grid, and cost a real misdiagnosis before it was fixed. One glyph, one
meaning. The rating's celebration burst still throws a ★, which `Burst` limits to ★ and ♥.

### What "watched" means

**Thirty seconds of uninterrupted playback**, or the whole item if it is shorter than that —
`min(30s, 90% of duration)`. The short-item clause is not a detail: without it, anything
under thirty seconds could never be marked watched at all, and a library of short clips would
have a feature that silently never applied to it.

Three definitions were rejected. _Opened at all_ (`viewCount > 0`) marks a video watched for
a mistaken click. _Reached the end_ is wrong for the
three-hour film you stopped ten minutes early, and cannot be corrected by hand. Both are
derived, which is attractive — no column — but neither can be overridden, and being unable to
say "yes I have seen this" is the failure that matters.

So: **an explicit `watchedAt` on `UserMedia`**, set automatically by the rule above and
toggleable by hand. It survives a rewatch, and it is filterable, which is the point — the
companion to "unrated only" is "unwatched only".

### Nothing is resumed across visits

There was a stored resume position, a "Continue watching" shelf, a progress bar on every tile, and
a hero that offered "Resume". They went (2026-10-07). Nothing in the library is long enough to be
watched in more than one sitting, and the position save was the most frequent write in the app —
the one that took the site down (§20) — to keep a number almost nobody came back for.

**What the server still hears is a view that counted:** the watched threshold reached, or the end
(`PUT /api/media/:id/progress` with `watched` or `finished`, at most two per arrival; a still sends
both when its dwell runs out). Each moves `lastViewedAt` and the end counts a view. A glance that
reached neither records nothing — "opened at all" is no better a meaning for _viewed_ than it was
for _watched_. "Recently viewed" walks `idx_UserMedia_viewed` and takes the old shelf's place.

**What survives is within one visit.** Leaving an item for a moment — a tag, a duplicate, Back —
and coming straight back must not start it again, or it reads as a bug. So the player remembers
where it left each item in `lib/resumePoint.ts`, in memory, for as long as the page is loaded, and
returns there on arrival. A reload or a new tab starts at the beginning, and nothing of it reaches
the server.

**The room's hero skips "Recently viewed"** while another shelf has something: the item you viewed
last is one you have just finished, and offering it back is nearly always wrong.

### Cover from the current frame

Pause where you want and make that the cover. Small, self-contained, and already anticipated:
the CSP admits `blob:` in `img-src` precisely so a canvas-captured frame can be previewed
before upload (§9), and `extractFrame` already distinguishes an exact frame from a
representative one for exactly this reason — someone who paused here means _this_ frame, not
a better one two seconds later.

### Casting

Not built, and not in this round. `/api/media/[id]/token` (§12d) is complete and tested, so
what is missing is the sender SDK, a `script-src` entry for `https://www.gstatic.com` (§11)
and a device picker. It was considered and deferred rather than forgotten.

### Order of work

Saved filters first — self-contained, and it gives the filters API its first caller. Then
viewer navigation and autoplay, which is where the daily friction is. Then playlists, which
reuse the navigation. Then bulk selection, then the tile fields, then cover-from-frame.
Shuffle is settled above and is built with the playlists it belongs to, over the same
permutation the `random` sort already uses.

Schema changes were made first and together, while the database was still empty, for the
reason at the top of this section. That is also what let `HAS_RELEASED` be flipped once this
round landed rather than carrying a chain of migrations through it.

## 14e. Filtering by what a file is

Search asks what an item is _about_. Sort asks what order to read it in. Neither answers "show
me the ones worth re-encoding", which is a question about the file itself — how long, how
detailed, how big — and until now the library could not be asked it at all.

### One shape, five axes

Every measurable property is filtered the same way: a minimum, a maximum, or both, half-open
so that `min` is inclusive and `max` is not. One shape rather than five bespoke ones, because
five spellings of "between" is five chances for one of them to be inclusive at the wrong end,
and because a single shape means a single control, a single chip, and a single place the URL
is parsed.

| Axis       | URL                                 | Column               |
| ---------- | ----------------------------------- | -------------------- |
| Length     | `minDurationSec` / `maxDurationSec` | `durationMs`         |
| Resolution | `minResolution` / `maxResolution`   | `MIN(width, height)` |
| Bit rate   | `minBitrateKbps` / `maxBitrateKbps` | `bitrate`            |
| Frame rate | `minFps` / `maxFps`                 | `fps`                |
| File size  | `minSizeMb` / `maxSizeMb`           | `listSize`           |

**Units are the URL's, not the column's, and the names say which.** `?minDurationSec=60` is
something a person can read and edit; `?minDuration=60000` is something they get wrong. The
conversion happens in the one function that builds the SQL.

Plus three that are not ranges: `orientation` (landscape, portrait, square), `animated` for
stills, and `maxRating` to close the rating band.

No schema change. Everything above is already on `Media`, `listSize` included.

**Orientation was compared, and is now a generated column (2026-10-14).** It was first compared
from the two sides on every row and deliberately not stored, because a third column would be a
third thing to keep in step on every re-probe. A _generated_ column answers that objection —
SQLite computes `Media.orientation` from `width` and `height` and nothing writes it, so it cannot
drift — and gives the planner an index the comparison could not have: a portrait shuffle read every
item's row for its two sides, 1,429 pages for the videos on the production replica (§20 "The disk,
not the CPU"). It is VIRTUAL, the only kind `ADD COLUMN` allows and the kind wanted anyway, and NULL
when either side is unknown, exactly as the comparisons were: an item never probed has no
orientation rather than a square one.

### Resolution is the shorter side, not the height

The obvious reading, and wrong for a third of a modern library. "1080p" names a 1920×1080
frame however it is turned, so an upright phone video is 1080×1920 and still 1080p — but its
_height_ is 1920, which would file it under 1440p, a tier it has no pixels to justify. Every
portrait item would be promoted a band or two and the bands would stop meaning anything.

The shorter side is the scanline count the tier names come from. It gives the same answer for a
rotated frame, and it keeps the two awkward cases right for free: a 2560×1080 ultrawide is
1080p rather than nearly-4K, and a 1080×1080 crop is 1080p rather than a tier of its own.

The cost is `MIN(width, height)`, an expression. As a filter it is affordable because `listable`
and the root clause have already narrowed the candidate set — and if it ever measures slow, the
established fix is a denormalised column, which is what `listSize` already is. As a **sort** it
has an index of its own, `idx_Media_list_resolution`, built on the expression itself: SQLite
walks an expression index when the ORDER BY spells the same expression, so sorting by
resolution pages like any column sort (1.1 ms for page one at 200k). Like the other four measure
indexes it carries `kind` after `id`, so a kind's page, count or shuffle never reads a row (§20). The filter, the sort and
the tile's "1080p" label all read the short side, so none of them disagrees with another.

### The bands must cover the axis, and the labels have to say so

A gap between two bands is not a missing feature. It is a file that no offered filter can find,
and it presents in the worst way available: the filter works, the results look reasonable, and
one item is simply unreachable. So the first band is open below, the last is open above, every
band meets its neighbour exactly, and `ranges.test.ts` checks all three rather than trusting
this paragraph.

**Labels name the band's edges, never its contents.** The frame-rate band covering 31–60 was
first called "48–60", after the rates that actually occur in it — which tells somebody holding a
45 fps file to look elsewhere, and there is nowhere else. That is how a set of filters that
genuinely covers everything still manages to lose a file.

The resolution tiers carry their pixel range on the chip — "SD (under 720)", "720p (720–1079)"
— because they are classes rather than measurements, and the class boundary is exactly what
somebody with an 800-pixel file cannot guess. Minutes and megabytes are self-describing and are
left in plain words.

The half-open convention is stated once in the panel rather than in nine labels, along with the
one hole no band can cover: an item the worker has not probed has no measurements at all and
matches none of them. That is real, it is deliberate — a "not measured" band needs a predicate
the range shape cannot express — and it is better said than discovered.

### A filter that cannot apply is absent, not disabled

Length, bit rate and frame rate are questions about a video; whether a picture moves is a
question about an image. Filtered to images, the video measurements are simply not there.

With no kind chosen, all of them are offered — and **setting one narrows the view to the kind
that can answer it.** The alternative is worse in both directions: leaving `kind: "all"` drops
every image from the results anyway, because an image has no duration and so matches no
duration range, and the person is left looking at a library that lost half its contents with
nothing admitting why. Doing it explicitly moves the Kind control, which is visible, reversible
and in the same panel. Clearing the range does not put the kind back: it was a real choice once
made, and undoing one filter is not a licence to undo another.

### Three sections, because they behave differently

The panel divides into **Your marks**, **The file** and **Tags**, and the division is not
decoration. The first resolves against whoever is looking and travels differently in a shared
filter (§6); the second is a fact about the file and reads the same for everybody; the third is
a vocabulary that grows. A single column of switches makes three unlike things look like one.

`maxRating` had to be added to two lists to work at all — `isViewerRelative`, so a shared filter
asking about ratings is recognised as one, and `usesPersonalOverlay`, so the query joins the
overlay it reads. Missing the second produced `no such column: um.rating` on a query that
typechecked perfectly, which is the failure that list exists to prevent.

### The measurements are one row each, closed

Rendered open, the five ranges cost about 500px in a 260px column — a label and three wrapped
rows of chips apiece — which pushed the tag facets, the oldest and most-used thing on the
panel, entirely below the fold on a 1080p screen. Measured on the real page: the Tags heading
sat at 747px in a 911px viewport with everything closed, and opening a single axis moves it
197px further down.

So each axis is a row that states its own name and its current value — "Length · 1–5 min" —
and opens on click, one at a time. **Nothing is hidden by closing it**: the row says what the
filter is, so opening is for changing rather than for finding out. Each section heading carries
a count of how many of its filters are on, which is what a collapsed panel owes a reader who
would otherwise have to scroll to find out whether anything is set.

The half-open convention moved with them. It used to sit permanently above all five axes,
costing two lines on every visit to explain a rule that only matters while somebody is choosing
a band; it is now shown inside whichever axis is open.

`Collapse` was the first attempt and does not work here — the button reported
`aria-expanded="true"` while the panel stayed pinned at `height: 0px`, which is the hardest
kind of broken to catch from the code, since the state was right and only the pixels were
wrong. The expanded content is rendered conditionally instead. The animation was decoration,
and mounting five sets of band chips nobody can see cost DOM on every render for nothing.

### Grouped by what each filter can describe

On a combined view the section mixed three concepts with nothing saying which was which:
length, bit rate and frame rate are questions about a video, movement is a question about an
image, and resolution, size and orientation apply to anything. Interleaved, the list quietly
says the library holds one kind of thing.

So the rows are grouped — **Any item**, then **Videos**, then **Photos** — with the shared ones
first, since those are the rows whose position should not move as the kind changes.

**The headings appear only on a mixed view.** Filtered to videos every row applies and three
headings would label a distinction that no longer exists. "Videos" rather than "Videos only",
which reads as a filter that shows only videos — confusing beside the Kind control, and doubly
so because setting a row underneath does exactly that.

Which rows appear, in which group, is `fileFilterGroups` rather than conditionals in the panel.
It is a question with a right answer, and a JSX tree of `showVideoMeasures &&` is one nobody can
check — while the two ways it goes wrong are both silent: a row offered to a kind that cannot
answer it is an empty grid, and a row withheld from a kind that can is a feature nobody finds.
The test asserts that no row is unreachable from every kind.

Orientation and movement are rows like the rest. They are not measurements — there is no
"between landscape and portrait" — but they sit in the same column answering the same kind of
question, and two rows drawn differently in one section would suggest a difference in behaviour
that does not exist. `FilterRow` is the shape they share; `ChoiceFilter` and `RangeFilter` are
what goes inside it.

### The cellar's header

The header grew one control at a time into a single wrapping row of eleven, all the same grey
weight: search, kind, sort, direction, reshuffle, tag matching, showcase, tasting, grid/gallery,
plus the saved-view control and "Select page" in the lines beside the title. Nothing was
primary, and the row moved — "Tag matching" came and went with the filter, and the whole cluster
dropped to a new line whenever the chips made the title block wide — so the control wanted most
had no fixed position. It is three tiers now, each with a fixed place — and on a wide screen the
second and third share one line (below):

1. **The plate** (`PagePlate`): the eyebrow, the title, the saved view's state beside it, and on
   the right the two ways of looking at this set — **Play** and Grid/Gallery. The cellar was the
   one list screen without the letterhead the others carry, and the place people spend the most
   time had the weakest heading. The title is at section size, as on every page (§14, "House
   rules"): the display size pushed the first row below the fold.
2. **The kind, as tabs** — Videos, Photos, All (`KindTabs`). Most sessions stay in one kind, so
   it is the page's first control and never moves. Tabs say "which shelf", the same distinction
   `clearFilters` draws. Videos and Photos carry the current filter's count for that kind; the
   tab you are on shares the grid's own count key, so the cost is one more count, for the other
   kind, once per filter (§20). **All** comes last with no count: it is still wanted — a search
   across both, a showcase of everything — but it is not where anybody starts. Videos is the
   default of the address itself, below.
3. **The working row**: search and the order, then a `⋯` menu at the far end holding **Tag
   everything matching** — a rare bulk write, which had sat among the everyday controls.

The count and the filter chips sit under the working row; "Select page" moved to just above the
grid it acts on, where it no longer reads as one more filter.

### Quieting the cellar

A review with fresh eyes found the screen intimidating rather than wrong: two columns of small
labels side by side on the left, about 345px of header before the first tile, a filter panel
that looked busy with nothing set, and four lines of small print on every tile. The fixes take
nothing out of reach — the constraint was that no everyday errand costs another click:

- **One working row, pinned.** On a wide screen the kind tabs, search and order are one line,
  the tabs' underline sitting on the row's own rule, and the row sticks under the header. The
  filter column sticks beneath it and scrolls on its own. Both used to leave with the page, so
  refining from the fortieth row began with a trip back up, and below the first screen the
  left 260px was an empty strip. On a phone nothing is pinned: the screen is too short to give
  it up, and the controls are the tabs and a Filters button.
- **An unset filter says nothing.** The file rows show a value only when set (seven rows of
  "Any" read as data to be checked); the rating rows are faded until pointed at or set; and a
  tag section with nothing in it is not drawn — "No sources yet" was a filter nobody could use,
  shown on every visit. The panel keeps the previous filter's facets on screen while the next
  are counted (`placeholderData`), or every change would empty the column and refill it.
  Drawing every section always, empty or not, was meant to stop the panel moving the first
  time one filled; but tags are never made from the panel, so that move happens while nobody
  is pointing at it.
- **The sidebar has tiers.** Review, Libraries, Processing and Household are upkeep: visited
  when something needs doing (§12c). They sit at the foot above the account, ruled off, smaller and in
  oak (`AppNavbarUpkeep`) — still one click. The four tag pages are always listed, indented
  under Tags; Tags itself goes to the one last used. Captures, Clips and Reels are listed the same
  way under **Studio** (decided 2026-10-09): your own stills and spans, one errand rather than
  three peers of Library and Tags. Studio returns to whichever of the three was used last — the
  list, not a reel opened from it.
- **The tile is a title and one line.** The title is one line, cut in the middle rather than at
  the end (it was two lines, reserved). A library's names share their beginnings and differ at
  their ends — `FallGuys client 2026-03-12 21-04-33`, sixty times over — so an end cut kept
  exactly the part they all have in common. `MiddleEllipsis` is the shared control for any name
  like that: two spans, the tail held whole and the head cut by the browser, with no measuring;
  `splitForMiddleEllipsis` picks the tail at a word start, preferring a space or a dot to a
  hyphen so a date stays whole, and leaves a short or run-on name to the end cut. It is for
  names only — a sentence cut in the middle reads worse than one cut at the end. And the line
  under it is a **byline**: the performers, two names and a `+N`, in the warm small print the
  tag page uses for aliases, clipped to one line. The line holds its height when it is empty, so
  the rack stays even. The rating is a badge on the picture, bottom left, opposite the duration
  — it was half that line and left the rest of it empty on most tiles, and on the picture it
  costs no height. The caption is 6px top and bottom rather than a card body's 10px: at 10px it
  was half the height of the picture above it. Performers came back out of the hover because
  they are what a rack is scanned for, and a phone has no hover to find them behind; they are
  plain text, because the tile is already a link. The date went the other way — a detail, not a
  reason to pick a tile. In the grid, resolution, date and the other tags appear along the foot
  of the picture on hover, faded in so nothing reflows; Gallery, and so a phone, keeps the tags
  under the title. The list sends performers apart from the other tags (`performers`,
  `performerCount`), so a tile with five keywords still names its people.

_Not done, yet:_ folding the navigation into an icon rail beside the filters on the library.
It would return about 140px at 1280 wide, at the price of destinations named only on hover.

**Play** is one button with From the top, Showcase and Tasting behind it. All three answer the
same wish — put this set on the screen — and all leave the page (§14f, §14g), so they are one
decision rather than three buttons among the page's own controls. §14f's "a button, not a third
segment" still holds.

**A playlist plays the same way.** Its page wears the same Play menu (`PlayMenu`, one component
for both), in the order on screen: a shuffle is shown and tasted in that shuffle. A playlist is
not a query, so the showcase and the tasting carry it as `playlist=<id>` beside the playlist's own
`seed` or `order=stored`, and walk it in the playlist's own pages of sixty under the playlist
page's own keys — so the viewer opened from either, and the playlist page behind it, find those
pages cached. There is no count to size the wall from: a shuffled playlist's pages run past its
item count, so the end is the page that says `hasMore: false`, as the tasting already reads it.

**From the top** is listed first, being the plainest reading of "Play": it opens the first item
of the set — whichever page is on screen — in the viewer, with the set recorded at page one so
next and previous walk it from there, and "Autoplay next" carries it on unattended. The first
item, photo or not: the viewer's set is mixed, and a photo is a still that advances after its
dwell (§14b), so skipping to the first video would start somewhere other than the top.

**The title names the shelf** when the grid is not a library or a saved view: "Videos",
"Photos", or "All items". **One word:** "Photos", everywhere — the tab, the panel's group label.
The chip said "Images" beside a control saying "Photos".

**On a phone** the tabs share the width equally, and every control left on screen — the tabs,
search, Filters, Play, Grid/Gallery — stands 2.75rem. The chips stay small in a line of text,
but their hit area grows to 44px on a coarse pointer. Sort and direction stay in the drawer.

_Rejected: splitting Videos and Photos into two sidebar entries._ A library or a saved view
would then have to be chosen twice, and the navigation already carries libraries, views and
playlists.

### Videos unless you ask

The app is for watching videos; photographs are kept, catalogued and processed like everything
else, but wanted only now and then (decided 2026-10-09). Videos-first used to be one link's
opinion: the sidebar's first visit said `kind=video`, and everything else — a shelf's "see all",
a tag's shelves, closing a saved view, a new device — omitted the kind and so opened on
everything. People saw that as the library "switching to All" on its own.

**An address without a kind is the videos** (`DEFAULT_VIEW.kind`). Photos and All are spelled
out (`kind=image`, `kind=all`), so every link built without thinking about kind lands on the
videos, and nothing has to remember to say so. The household shares the rule; there is no
per-user setting, because one tap on the tabs is the whole cost of wanting photos.

**The address and the stored query spell it oppositely.** An address leaves out the videos; a
`MediaQuery` leaves out "all", because to the server no kind means both
(`viewToRequestParams`). A saved view is stored in the query's spelling, so one saved before the
default moved — with no kind — still opens on everything (`savedQueryToParams` writes
`kind=all`). No stored row needed rewriting.

**Videos are not a filter.** `isFiltered` compares the kind against the default, so a saved view
emptied down to Videos is the plain library and drops its name, and "clear all" behaves as it
did. The empty state asks about the kind separately: Videos over a library of photos is "nothing
matches" with a way to everything, not "nothing here yet".

**Every surface that shows a set follows it:**

- **The room's shelves** — Recently added, Top rated, Favourites, Something else, and tag shelves
  — ask for videos (`homeService.ts`), as the grid their "see all" opens does. A saved view's
  shelf keeps the view's own kind, and a playlist shows what somebody put in it. Recently viewed
  stays mixed: a photo in it is one somebody opened.
- **A tag's strip, page and companions** show its videos, or its photos when it has no videos
  (`tagProfileKind`; the samplers in `tagRepo.ts` rank videos first and drop the photos of a tag
  that has any). The page's tasting, showcase and "see all" take the same kind. The tag's photos
  are one click away on the counts beside its name, which link to `kind=image`.
- **The review queues** (faces, OCR, duplicates) open on Videos, with the same three choices (§5f,
  §5d, §10c). The counts beside their links in the navigation are the videos too.

_Rejected: not cataloguing photos, per library or at all._ They are wanted sometimes, faces in
them help name people, and they are not kept in folders of their own, so a library-level switch
would have nothing to switch.

### Telling a filter from a sort

Both change what the grid shows; only one of them hides things. The panel cannot carry that
difference on its own — it is a column of mostly-off controls, several below the fold, behind a
button entirely on a phone, and a set filter looks exactly like an unset one until you go and
look.

So every active filter gets a removable chip **beside the item count**, which is the number the
filters are responsible for. Nothing about the sort appears there, and that is not an omission:
the sort control states its value at all times because it has exactly one, reordering hides
nothing, and a removable "Newest first" chip would imply there is a way to have no order.

The chips are derived from the same view the request is built from, so a filter cannot be in
force without appearing — the failure being prevented is precisely a narrowing nobody can see.
Each removes only itself, because the common repair is undoing the last thing tried rather than
starting again, and "clear all" is the only escape a panel offers.

**"Clear all" keeps the kind.** Videos or Photos narrows the grid, so it counts as filtered
for what an empty result means, but it is closer to which shelf you are browsing than to a
filter: most sessions stay in one or the other, and clearing a stack of filters used to drop
you into the mixed library as a side effect. Leaving it takes its own click, on the tabs. So
"clear all" is offered only when something besides the kind is set (`hasClearableFilters`) —
one shown over a grid narrowed only to Videos would do nothing.

**The kind has no chip.** The tabs show it, fixed and always visible, so a chip repeating it was
a second copy of a fact already on screen — and one that looked like a filter. The rule that no
narrowing may be invisible still holds; the tab is where this one is seen.

**Nor does the kind alone offer "Save view" or "Tag matching".** Both are gated on
`hasClearableFilters`, not `isFiltered`. Picking Videos used to put both on screen, and "Tag
matching" then offered to tag every video in the library — the one case it exists to refuse
(§5d). A saved view still records its kind; it just is not offered for the kind alone.

**One "clear all" at a time.** The panel's own is shown only in the phone drawer, which covers
the chips; in the desktop rail the chips' "clear all" is on screen beside it.

**Tags that match nothing here are dimmed, not hidden.** The numbers are the filter, and a tag
that vanished whenever another choice excluded it would make the list reshuffle under the
pointer. A selected one is never dimmed. The one exception is the empty
state's "Clear filters" when the kind is all that is left, which does let go of it, or it too
would be a button that does nothing. Closing a saved view still resets the kind: a view's kind
is part of the view, and the plain library — the videos — is what closing promises.

### Any, all and without

The flat panel answers "with all of these" and nothing else, and household questions are not
all that shape: _either_ grandparent, Son _without_ Daughter, any of my favourite performers,
(unrated or two stars at most) with Aunt. What was built, and why this much and no more, came
from how other libraries handle it: per-criterion _includes / includes all / excludes_,
Linear's operator that appears once a second value is picked, Lightroom's and Plex's one level
of all/any/none rule groups, and Hydrus's and Danbooru's negated tags. The pattern that works
for non-technical users is a flat chip panel with the logic **said in words**; the pattern that
works for everything else is one level of groups behind a door.

- **The filter is still the flat `MediaQuery`,** plus `notTags` (without any of) and `groups`
  (`packages/core/src/schemas/filterLogic.ts`): each group is _any_, _all_ or _none_ of up to
  twenty rules, and every group is ANDed with everything else. One level — a group holds rules,
  never another group. "(a or b) and c" is the shape the questions take, and one level is still
  readable back as a sentence, which the Advanced editor does in its footer.
- **A facet becomes "any of" only when asked, and only once it means something.** With two or
  more picks the section offers _Items with [all of these | any of these]_; with one or none the
  two are the same filter and nothing is offered. The picks then live in a group whose `facet`
  names the section, and the mode is _read off_ the groups rather than stored beside them — a
  second copy of one fact would disagree with the first the moment a hand-edited address or an
  old saved filter touched one and not the other. A facet group left with a single tag collapses
  back into `tags` (`tagLogic.ts`, `normalizeTagLogic`).
- **A chip has three states: off, with, without,** one click moving it along — the
  Eagle cycle, kept because it is one gesture for a mouse and a thumb. Its known trap is the
  third click silently dropping a filter, so "without" is said three ways and never by colour
  alone: an oxblood outline, a minus where the tick goes, the name struck through, and an
  accessible name that says the state and what the next click does.
- **Never "AND" and "OR" as operators.** People reliably swap them — "photos of Mum and Dad"
  usually means either. A requirement says _all of_; alternatives are joined by a lowercase "or"
  ("Son or Daughter", "my favourite performers or no performer yet"), the one reading of that
  word nobody gets backwards; a `none` group turns each rule around and joins them with "and"
  ("without Grandma and not unrated") (`filterWords.ts`). The chips above the grid name each
  clause rather than counting tags, because "3 tags" stopped being an answer once three tags
  could be three requirements, three alternatives or one of each.
    - **An "any of" group used to read "any of a, b".** Beside the ♥ that came out as "any of my
      favourite performers, no performer yet", which parses as "any favourite" plus a second,
      separate condition — and so as a contradiction.
    - **The picked chips say it too.** In an "any of" facet every "with" chip after the first, in
      the order they are drawn, shows "or" where its tick would be (`TriChip`'s `or`). The
      _Items with [all of these | any of these]_ control says the same, but it sits under every
      tag in the section and was easy never to see.
- **Favourites ♥.** Each facet section opens with a chip for any of the viewer's favourite tags
  of that facet, shown once they have one. It is a `favTags` rule, resolved when the query runs
  rather than frozen into ids, so a saved "my favourite performers, unwatched" keeps up as
  favourites change; it is viewer-relative and follows a shared filter's `resolveAs` exactly as
  ratings do (§6). Alone it means "at least one favourite"; beside other picks under "any of" it
  is one more alternative.
    - **It says "♥ (3)"**, the count being items like every chip beside it; "your 2 favourite
      performers" is its tooltip and accessible name. It first said "Favourites ♥ (3)", and
      beside "brian (3)" the word made the number read as "you have three favourites". The fix
      was then both numbers with units — "♥ 2 favourite performers · 3 items" — which was the
      widest thing in the section; dropping the word removes the misreading without the width.
    - **It has the same three states as the chips under it.** "Without my favourite performers"
      is a real question (somebody new, not the usual faces), and a ♥ that stopped at two states
      would be the one chip in the section whose third click did something else. "Without" is the
      facet's second group, `match: "none"`, so the ♥ is only ever in one of the two.
- **None.** Beside the ♥, every facet section has a None chip — on Performers a face, drawn
  whole while the chip is off (its first click is "any performer") and in dashes once it means
  nobody, and "—" everywhere else, the tooltip saying "No performer
  tagged". Nothing of this facet tagged yet — the Advanced editor's "has none", an `untagged`
  rule. Its third state means "has some performer" and shares the facet's `match: "none"` group
  with the ♥'s without.
    - **The face is drawn, not typed.** It was 🫥, whose dotted outline is the whole idea, and
      Windows' emoji font fills it peach — the same reason the player's transport is SVG
      (`Glyph.tsx`).
    - **Its third state is a positive, not a "without".** Drawn like every other chip's without
      — oxblood outline, minus, the face struck through — it read as "not nobody", a double
      negative. It is drawn as what it means instead: the face whole, the word "any", filled like
      a "with" (`TriChip`'s `opposite`). The pill above the grid says "With any performer".
    - **"Any performer" is the first click, "nobody yet" the second** (`cycleNone`). Having some
      performer is the question asked more often, and it narrows the library without moving the
      facet into "any of"; the other chips keep with-then-without.
    - **It is always an alternative.** "chris and no performer" matches nothing, so turning None
      on moves the facet into "any of" — "chris, or nobody tagged yet" — and switching the facet
      back to "all of" drops it. The mode is still read off the group: a facet group holding
      `untagged` is "any of".
    - **It has no count.** Every other number in the panel is a lookup per assignment; "how many
      have no performer" is a scan of the whole filtered set (§20), once per facet per filter
      change. If one is wanted it should be one grouped pass for every facet, cached like
      `/api/media/count`.
- **The Advanced editor** writes the groups no section owns: "or" across facets, "none of", and
  your marks and the file mixed into one condition (`AdvancedFilterModal.tsx`,
  `advancedDraft.ts`). Its first version was rebuilt after a review, and what changed is the
  design:
    - **Every row says what it is about:** `[Subject ▾] [value] [×]` — "Performer is chris, ♥ my
      favourites", "Length 20–60 min". Rows used to be bare values, so "chris" and "Unrated" sat
      side by side with nothing saying one was a person, added from a 25-item menu that ran off
      the screen. The subject is a searchable list in the panel's words and order; a facet's ♥
      and "has none" are options of its row; subjects the current kind cannot answer are not
      offered, and "videos or photos" is not offered at all — the tabs own it.
    - **Measures pick a band, with "Custom range…" as the way out.** A new row has no bound until
      one is chosen; seeding the first band's missing lower end as 0 produced "0–60 sec".
    - **It shows what it will do:** what else is already filtering (from `activeFilters`, the
      grid's own chips), the sentence the groups make, and a live count — the button is "Show 37
      items", disabled until something changes.
    - **Escape and a click outside do not close it.** A draft is minutes of work, and Escape is
      also how a dropdown inside it is dismissed; Cancel and × are the ways out.
- **No query language** (§5c stands). The research's power-user layer is a typed syntax that
  mirrors the chips; here the address already round-trips every filter, saved views cover
  anything asked twice, and a second way to spell a filter is a second way to get it wrong.
- **Text search is not a rule.** An FTS match inside an OR is a per-row probe, and its private-tag
  fallback doubles that; the search box stays one AND condition on the whole filter.
- **`none` coalesces each rule to false before negating.** "None of: four stars up" is
  `NOT (rating >= 4)`, which is NULL for an unrated item, and NULL is not true — so without the
  coalesce every unrated item vanished from a filter that, read aloud, plainly includes them.

### Deliberately not built

Proposed and left alone, with the reason:

- **Nested groups.** One level answers the questions asked; two is where rule builders stop
  being read and start being debugged.
- **"Only these people"** — the exact set, nobody else in it. Immich users ask for it; it needs
  "and no other performer", which is a different query shape from every rule here.
- **Codec, container, audio channels** — real, and a facet rather than a range. They are closed
  vocabularies with a handful of values, so they belong in the tag panel's shape (counted
  chips) rather than as a sixth number control.
- **Date added / date captured ranges** — obviously useful and the only one here that needs a
  control this pattern does not already have. A date picker is not a band chip.
- **Aspect ratio** — orientation covers the question people actually ask; an exact ratio needs a
  tolerance, and a tolerance is a rule nobody can see.
- **"Not measured"** — the hole named above. Needs `IS NULL`, which the range shape cannot say.
- **Has a note, has captures, in a duplicate group** — each is a one-off predicate rather than a
  family, and each would earn its place only once somebody wanted it twice.

## 14f. The showcase

The cellar is for finding one thing. The showcase is for looking at all of them: the filtered
library, full screen, as a justified wall of preview clips that drifts slowly downward when
nobody is touching it and goes round forever. Almost no text — the chrome is a close button
and a full-screen toggle, and both fade out with the cursor.

**Its own route, not a fourth `mode`.** `/showcase` sits outside the app shell: no header, no
nav, no pager. What it shares with the cellar is the filter, and it takes that the same way —
the library's own query string, parsed by `parseView` — so any library view opens as a
showcase and closes back into the view it came from. Full screen is requested in the library's
click handler, because browsers grant it only in answer to a gesture. It shows exactly the
grid's set, kind included. It was once videos only, on the grounds that a still has no clip —
but that turned a showcase opened from Images into a wall of the videos just filtered away. A
still shows its cover, which is all any tile shows until it is granted a decoder.

**A conveyor, not a scroller.** A native scroll offset needs the height of everything above it,
which at 20,000 items means laying out 20,000 tiles to show thirty, and there is no scroll
position after the last page that is also the first. Instead each fetched page (200 items, the
API's ceiling) is laid out on its own as a _block_, and the position is a block and an offset
into it. Block `k` shows page `k mod pageCount`, so wrapping is arithmetic rather than a seam.
Only blocks near the viewport are held — the rest are released and come back from the query
cache — and only rows within a screen of it are mounted, so the DOM and memory are bounded by
the screen, not by the library. One `requestAnimationFrame` loop moves a single layer with a
transform; React renders only when a row enters or leaves.

A set that fits on a screen or two does not wrap — wrapped, it shows the same tiles twice at
once, which reads as a fault. It drifts to the bottom instead, rests there a moment, and drifts
back up: a drift that simply stopped at the end looked like the wall had died. A set shorter
than the screen sits still in the middle.

**Justified rows.** Tiles keep their video's shape (clamped to 0.6–2.2 so a row never fills with
slivers) and each row is scaled to span the width exactly. A block's short last row folds into
the one above rather than stretching into a banner, so blocks butt together without a seam.

**Rows are large, because decoders are few.** Every clip is a `<video>` and the preview budget
(§9) still applies — two on a phone, eight at most on a desktop. Rows of ~360px on a desktop
keep the wall to about as many tiles as can play; only rows in the middle band of the screen
ask for a decoder, so a row half out of frame never holds one a row in full view is waiting
for. A tile without one shows its cover.

_Rejected: sprite-sheet flipbooks._ The scrubber's sheets are still images, so stepping through
one costs no decoder and every tile could move at once. Built and tried: a hundred frames spread
across a whole video, shown as a time-lapse, read as flicker rather than as footage. Fewer,
real clips won.

**Drift.** After four seconds of stillness the wall eases into a slow downward drift (~22 px/s
on a desktop). Any input stops it at once. Resting on a tile holds it — for twelve seconds, not
forever, since a parked cursor is always over some tile. While drifting the layer ignores the
pointer, so a tile sliding under a still cursor does not start its clip as if it had been
chosen. Wheel, drag with momentum, and the arrow and page keys all move it by hand.
`prefers-reduced-motion` turns the drift off, and the budget already refuses clips.

**A tap while the controls are hidden only brings them back** — the tasting's rule too (§14g),
in one hook, `useWakingTap`. A mouse brings the controls back on its way to a click; a finger
cannot, so the tap is the first thing the wall hears and it lands on a tile. Every phone tap meant
to reach the controls opened whatever was under it. Once the controls are up, a tap opens the tile
as before. The controls showing is the visible cue for which kind of tap the next one is, and
after a touch they stay four seconds rather than 1.8 (`useIdleControls`), long enough to look,
decide and reach. Considered and rejected: a first tap that picks a tile and a second that opens
it. It gives a phone a preview on demand, but the tasting has nothing to pick, and the two modes
must answer a tap the same way. A mouse is never swallowed.

**Coming back.** Opening a tile records the page and the fraction of it the viewport was at,
in `sessionStorage`, keyed by the filter; returning from the player puts the wall back there.

**Going on.** The viewer steps through, and warms the next item of, the set it was opened from
(§14b), and reads that set from the recorded return address. A showcase address is not a
library address: the set pages in two hundreds, and the address alone does not say which
page the tile was on. So the showcase records its address with the tile's
`page` added, and the viewer recognises the path and asks the showcase's own question —
`lib/showcase/set.ts` states it once for both, down to the cache key, so arriving is a cache
hit. Read as a library address it asked a different question: past the first sixty items
there was no next at all, so nothing was warmed.
The set still ends where the showcase's wrap would begin; the viewer does not go round.
The tasting walks this same set, and the viewer recognises its address the same way (§14g).

### A voice in the wall

A per-device switch — **Spotlight**, behind the sound button in the chrome, or `s` — gives the
wall one voice: a
single tile at a time plays a taste of its film **with sound**, the tasting's few seconds
(§14g) in the middle of the showcase's silence. When its taste is over the next tile, already
waiting on its first frame, takes over at once. Off by default: opening a wall of pictures is not
a request for sound, where opening a film is. `ps:showcaseSound`, beside the other playback
preferences (§14b).

**In the tile, not over it.** The speaking tile mounts the tasting's bare `VideoPlayer` over its
montage, cropped to the tile (`fit="cover"`, since the wall's tiles are already cut to their
pictures' shapes and bars inside the wall would read as a fault). A single floating player
moved from tile to tile was the alternative; it has to chase a layer that is moved by a
transform every frame and re-based whenever a block scrolls away, and it cannot be in two
places at a handoff. In the tile, it moves with the wall for nothing.

**Random, but low in the middle.** `lib/showcase/voice.ts` carries each playable film's centre
along at the current drift over the seconds it would play. A tile must start inside the middle
band and have at least six seconds there (or the whole taste, if shorter) before it drifts out;
without that floor, a tile with any overlap at all was eligible when nothing could see a long
taste through, and one about to leave the top was picked and slid off as it began. Of those
eligible, tiles that see the whole taste through are preferred — while drifting, the ones low in
the band, where rows come in. Among them the draw leans towards
the middle of the screen. Playable is the tasting's rule: a film with `directPlay` on its row.
Recently voiced items wait their turn, so a short set does not repeat one tile — but only while
something else is eligible. A still wall has one row in the middle, often three tiles, and
refusing every recent one left it mute until it drifted on; variety is a preference, silence the
failure, so the recent items and then the tile that just spoke are let back in before giving up.

**Handing on.** Five seconds before a taste ends the next tile is chosen and **cued**: a held
player already sought to its reserved segment, as the tasting cues across layers (§14g), out
of sight under its montage until its turn. A tile that drifts — or is dragged — out of the
middle hands on early rather than talking from the edge of the screen; a cued tile that drifts
away is dropped and another chosen. On a phone nothing is cued, for the warming reasons
(`mayWarmNextItem`), and every handoff is cold. A sixty-second taste outlasts the band at the
drift's speed, so at that length the voice is usually cut by position rather than by its out
point; that is accepted rather than slowing the wall for it.

**The budget.** The voice takes decoders from the preview budget (§9) at a priority above a
hover, so a silent montage is what gives way — the oldest autoplaying one first. The speaking
tile's own montage lets its decoder go once the voice has frames. The other middle rows keep
their silent clips: the wall is still the wall.

**Lit, not pointed at.** The speaking tile lifts off the wall — scaled up a little, a touch
brighter, with a dark drop shadow under a brass ring and halo (`--ps-voice-glow`) that fades onto
it as it fades off the last and breathes slowly while it plays; a line along its bottom edge
fills with the taste. The rest of the wall steps back slightly while a voice is live. The ring
alone was built first and was too subtle: against bright footage a glow is lost. A heavy dim of
the others found the tile but greyed the wall the showcase is for, so the lift does most of the
work and the dim only a little.

**Refused, it keeps going.** A browser that will not start sound without a gesture — a reload,
a link opened cold — gets a wall that carries on silent and a small "Tap for sound" chip; any
touch, click or key answers it. This is where the showcase and the tasting part: the tasting
stops on one large play button, because a tasting with nothing playing is nothing (§14g), and
a silent wall is still the showcase. Starting muted instead was rejected for §14b's reason.

**Shared, not copied.** The taste's length is the tasting's own preference, offered again in
the sound menu: the same few seconds of the same film in both. Mute is the shared `ps:muted`,
and `m` toggles it. **Nothing is written** — no watched marks, no position — for the
tasting's reason.

The stage counts as a holder of the full screen while it is up (`usePlayerFullscreen`), as the
tasting's does: the voice mounts and unmounts players continually, and the last one out would
otherwise take a full screen the viewer had asked for with it.

## 14g. The tasting

The same set as the showcase, one item at a time: a random few seconds of each film, each
photograph held for a few seconds, then the next — round and round. A lean-back mode for a
library too large to watch and too varied to judge from its covers.

**Its own route, and the showcase's set.** `/tasting` sits outside the shell like `/showcase`,
is entered the same way (`lib/fullScreenEntry.ts`, which requests full screen in the click)
and reads the same address through the same `showcaseFilter`: the grid's filter and order,
pages of two hundred, the same cache keys. So the viewer opened from a tasting walks a set it
has already cached, and `walksShowcaseSet` is the one test both the viewer and the way back use.
A switch that turned the showcase into a tasting was considered and rejected: the two are
different moods, and a wall with a mode toggle is two screens sharing a URL. The showcase's
voice (§14f) is not that switch — the wall stays a wall and gains one tile with sound — and it
borrows the tasting's segment, player and clip length rather than its stage.

**The segment.** `lib/tasting/segment.ts` picks a start uniformly inside the middle nine tenths
of the file, so that a whole taste lands before the last twentieth — the ends are where black
lead-ins, title cards, credits and the camera being put down live. Anything no longer than a
taste plays whole; an unprobed file plays from zero, and `ended` covers an out point past the
end. The next film's segment is **reserved before it arrives**, because the player warms it
from its in point (`preloadStartMs`, §14d) and a warm from a start the arrival then did not use
is bandwidth on the wrong seconds. Arriving takes the reservation, so the next lap round the set
plays a different moment. The preview montages were considered and rejected as the source:
one-second silent segments at fifteen frames a second, at fixed positions, cut together.

**Lengths.** Clip length and photo hold are separate per-device preferences, each one of
5/10/20/30/60 s (10 and 5 by default) — a closed set, for the dwell's reasons (§14b), and
longer-leaning than the dwell because a moving scene needs time to say what it is. Their own
keys rather than the viewer's dwell: a tasting's photo hold and a show's are chosen in different
moods. A change applies from the next item. `lib/snapChoice.ts` is the one snapping rule the
numeric preferences share.

**Skipped, not held.** A video the browser cannot play is passed over, where the viewer holds on
its cover for the dwell (§14b). The viewer is a position in a set you chose and must stop on
every item; a tasting is a sequence of moments, and an item with nothing to play contributes
none. Showing the cover as a still was the alternative, rejected for exactly that. The verdict
is `directPlay` **on the list row** (§8b), so skipping costs no round trip; it is computed by
the same `resolvePlaybackPlan` as the item page's, from probe columns on the row already being
read. A batch playability endpoint was rejected as a second request per page and a second
source of truth; a `playable` filter, because it would change the set — and so the count and
the order the viewer walks. A stale verdict is caught at run time: an item that errors, or has
not moved for fifteen seconds while not held and not hidden, is given up on for the rest of the
visit, and the cursor simply resolves to the next thing that can be tasted. A lap that finds
nothing says so rather than circling.

**The walk** (`lib/tasting/sequence.ts`) is a page and an index, never a global index — a
shuffled page can come back short in the middle — and the end is the page with `hasMore: false`.
Forward past the end wraps to the start; back from the first item wraps to the end once it is
known. A page is fetched when the walk reaches it; the first answer for a page is kept for the
life of the tasting, so a live update cannot shift what the show is on, and pages more than two
from the current one are let go, except the last.

**Two layers, one lit.** A film layer (a bare `VideoPlayer`) and a picture layer (`StillSlots`,
the slots taken out of the viewer's still stage for this) crossfade as the set changes kind.
`lib/tasting/targets.ts` decides what each holds: the next item of the same kind is warmed in
the showing layer's own second element, as the viewer does (§8b); the next item of the other
kind is **cued** in the layer that is not showing — a held player already sought to its
segment, or a picture decoded out of sight — so every kind of join starts warm. The outgoing
layer keeps what it had until the fade is over, or the dissolve would flash the next item's
first frame. Cueing is refused wherever warming is, so on a phone joins are cold and at most one
decoder is ever busy. Film-to-film joins hold the last frame, as a reel does (§14d).

`VideoPlayer` gained `bare`, `held`, `muted` and `onPlayRefused` for this rather than a
span-only core being extracted from it: its arrival, reset and warming effects depend on their
order (§8b), and splitting them across two files is how that order gets lost. `bare` also keeps
the player from styling itself full screen, which would lift it over the tasting's controls.
The full-screen handoff now counts mounted holders, so a layer unmounting while the stage and
the other layer remain does not drop out of full screen.

**Nothing is written.** No position and no watched mark, for films or photographs — a
few seconds of the middle of something is not watching it (§14d).

**Controls.** Space holds and resumes, → or `n` next, ← or `p` previous, `m` mute, `f` full
screen, `o` opens the item in the viewer, Escape closes (after the browser has had it to leave
full screen). Clicking the picture holds; a horizontal swipe steps; stepping lets go of a hold.
On a touch screen a tap while the controls are hidden only brings them back, as on the showcase
(§14f); a mouse click always holds, since the pointer moving to make it has already brought them.
The controls fade after a moment of stillness and stay while held; the progress line along the
bottom stays, being information rather than a control. A start refused for want of a gesture —
a reload — shows one large play button rather than a show silently waiting for an out point.

**Coming back.** Opening an item records the tasting's page and item; the viewer rewrites it
with the item it was last on (`leaveViewer`), and the tasting resumes there, playing. Entering
from the library forgets it and starts at the beginning.

**Known limits.** A background tab may overrun a segment, since the out point is watched by the
page. On a phone every join is cold.

## 15. Dev here, run on the QNAP

**Local (Windows).** `pnpm dev` runs `next dev --turbopack` and the worker under tsx watch, against a
small fixture library generated by `scripts/seed-media` — a few dozen synthetic clips with
varied codecs, resolutions, and deliberate near-duplicates, so duplicate detection and the
transcode fallback are testable without touching the real library. ffmpeg comes from a
pinned `ffmpeg-static` dev dependency; the image uses the distro build.

Paths are stored as POSIX-style relative paths under a root id, never absolute, so a database
created on Windows means the same thing on the NAS. `better-sqlite3` needs the
`onlyBuiltDependencies` entry in `pnpm-workspace.yaml` that basket-bot already uses, plus a
rebuild inside the Linux image — never copy `node_modules` across platforms.

**Release.** `docker buildx` produces a multi-arch image (`linux/amd64` for Intel QNAPs,
`linux/arm64` for ARM models). Multi-stage: build web (`output: "standalone"`), worker, and
packages, then a slim runtime layer carrying ffmpeg and compiled output only.

**Container Station.** Push to GHCR and pull, or `docker save`/`docker load` a tar over the
LAN for a fully private setup. Compose file:

- media shares mounted read-only — `/share/CACHEDEV1_DATA/<share>:/media/<name>:ro`
- one writable volume for `/data` (db, artifacts, variants, trash, backups)
- `PUID`/`PGID` so files the app writes land with sane QNAP ownership
- a host port well clear of QTS's own (it takes 8080, 8081, 443, 8443) — use 8842
- `restart: unless-stopped`, a `/api/health` endpoint, and a memory limit, because Container
  Station will happily let a runaway ffmpeg take the box down
- `/dev/dri` passed through only when hwaccel is enabled

The same image runs locally under compose, so "works here" and "works on the NAS" differ
only in mounts and CPU speed.

**Which build is running is baked in, not asked for.** The About dialog (in the account menu)
shows the short commit and the build time, so "is the fix on the NAS yet" has an answer on
screen. `.dockerignore` leaves `.git` out of the context, so the image cannot work this out:
`docker/ship.sh` passes `BUILD_SHA` (with `-wip` for a dirty tree, as the image tag does) and
`BUILD_DATE` as build args, declared after the dependency install so a new commit does not
invalidate it. `next.config.ts` inlines them as `NEXT_PUBLIC_BUILD_*`, and outside Docker asks
git itself. The build line is also the door to the admin tools (seven taps, `admin` scope only),
which hold per-device diagnostics such as §8b's warming overlay.

### The dev server is on Turbopack, and the reason is navigation

`next dev` compiles a route the first time it is opened, so "it takes forever to click
around" is a different measurement from "it takes forever to start" or "it takes forever after
I save" — and only the first one was ever wrong here.

`optimizePackageImports` on the Mantine barrel fixed the startup number and the note recording
it concluded the two bundlers were "within noise of each other". That was true of what it
measured: one cold request to one route, where process start and the shared dependency graph
dominate. It was the wrong question. Timed across every page of the app, first visit each:

|                                         | per route   |
| --------------------------------------- | ----------- |
| webpack, cache a few sessions old       | 4.5 – 5.0 s |
| webpack, cache deleted                  | 1.1 – 2.3 s |
| webpack, one-session-old cache (110 MB) | 1.0 – 6.7 s |
| turbopack                               | 0.8 – 1.1 s |

Recompiling after an edit is a wash — both land near 0.3 s — which is why this went unnoticed
for so long: the loop that gets measured constantly was never the slow one.

**Webpack's filesystem cache is not simply "help or no help".** A large one is slower than no
cache at all, and the third row is that effect arriving unpredictably. On a machine where
every figure here moved between runs, turbopack's spread being the tightest of the four is
most of the value — a dev server that is reliably a second beats one that is usually two and
occasionally seven.

There is a third reason, unmeasured and worth knowing: under the debugger,
`autoAttachChildProcesses` attaches to Next's Node compile workers. Turbopack compiles in Rust
and spawns none, so the inspector stops taxing compilation at all.

`next build` is deliberately left on webpack. Nothing above is evidence about production
output, and the image is the one artifact that has to be right.

### SQL echoing is opt-in, because stdout can stop the worker

`getDb()` used to pass `verbose: process.env.NODE_ENV === "development"` to better-sqlite3,
which echoes **every statement** through `console.log`. Since the worker's launch config sets
`NODE_ENV=development` on purpose, that was the default state of every debug run.

Measured on a 4,277-item library, the worker emitted **9.6 MB and 35,000 lines in twenty
seconds** — about 1.6 GB an hour. The claim loop logs a query every couple of seconds forever,
and every job logs its whole bookkeeping on top.

The volume is not the real problem; what it causes is. On Windows `process.stdout` is
**synchronous** when it is a console, so once a terminal stops draining that firehose the next
write blocks the event loop. The worker then sits at **0% CPU with every timer dead**: no
heartbeats, no claims, no completions, and its in-flight jobs frozen at the exact second it
stopped. It is indistinguishable from a killed process except that the process is still there
— which is exactly how it presented, twice: seven jobs `claimed` with `heartbeatAt` equal to
`startedAt`, an 807 MB resident worker, and nothing in the log to say why.

So echoing is now `PRIVATE_STOCK_SQL_LOG=1`, a deliberate request, and `NODE_ENV` no longer
implies it. The same run after the change produces **738 bytes**. The lesson generalises past
this one flag: a long-lived process that logs per-operation to an attached terminal has a
liveness dependency on that terminal, and nothing about the failure points back at the logging.

### The container is the only thing that runs this output as plain ESM

Development runs TypeScript through `tsx`, and the web app is bundled by Next. The container
is the one place that hands `node` the compiled `dist` and expects it to load. That gap held
two bugs, both of which stopped the container before it served anything, and neither of which
a type check, a unit test or a successful build would have found.

**Extensionless imports.** `moduleResolution: "bundler"` accepts `import { db } from "../db"`
and `tsc` emits that specifier verbatim. Node's ESM loader does no extension guessing, so
`node packages/db/dist/cli/migrate.js` and `node apps/worker/dist/index.js` {D} the two commands
the entrypoint runs {D} both died on `ERR_MODULE_NOT_FOUND`. `packages/core`, `packages/db` and
`apps/worker` are therefore on `moduleResolution: "nodenext"` with explicit `.js` on every
relative import, which reads oddly in a `.ts` file and is what Node requires. The point is not
the extensions; it is that the compiler now **refuses** the import that would break the
container, rather than emitting it and leaving the failure for a NAS. `apps/web` stays on
`bundler`, because Next is a bundler.

**A migration's identity must not depend on what ran it.** The applied-migrations table stored
the filename, which is `.ts` under tsx and `.js` in the container. A database created by
`pnpm db:init` on a dev box therefore arrived in the container with one migration apparently
unapplied, and replaying the baseline over a populated schema fails on the first
`CREATE TABLE`. A fresh volume never sees this, which is what makes it dangerous: it waits for
the first time somebody copies a catalogued library up to the NAS. Migrations are now recorded
by their extension-free stem, and rows already written either way still match.

`docker/smoke.sh` runs the whole boot sequence against a throwaway data directory {D} first
boot, second boot, a dev-stamped database, the worker staying up, and the entrypoint parsing
{D} in a few seconds and without Docker. It exists because everything above was invisible to
every other check in the repo.

## 16. Build order

| Phase | Deliverable                                                                                                                                                          |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Monorepo scaffold from basket-bot's config, `packages/db` with baseline migration + drift/snapshot tests, Dockerfile, health check                                   |
| 1     | User/auth (`withAuth`, JWT, refresh), scanner + probe + catalog, virtualized **responsive** grid, direct-play player with touch controls                             |
| 2     | ~~Covers, sprite scrubber, hover previews, gallery mode, live grid updates (ChangeLog + SSE)~~ — complete                                                            |
| 3     | ~~Transcode pipeline (background web-safe)~~, on-demand HLS still to do, ~~hwaccel config~~                                                                          |
| 4     | ~~Faceted tags, FTS5 search, filter/sort, per-user ratings + favorites~~ — hotkeys and the wine-cellar theme pass still to do                                        |
| 5     | ~~Playlists, saved filters, home shelves, prefs, bulk tagging from a filter (§5d), admin controls for processing stages (§7b)~~ — API complete, UI pending a rewrite |
| 6     | ~~pHash, duplicate clustering, review UI, recycle-bin trash, restore and purge~~ — complete                                                                          |
| 7     | ~~Clips, the clip browser, and reels that play virtually (§14d)~~ — rendering and export deferred                                                                    |
| 8     | ~~Signed media tokens (§12d)~~, per-root access, reverse-proxy docs, backup + sidecar export                                                                         |
| 9     | Cast SDK, then DLNA push, TV-safe profile                                                                                                                            |
| 10    | Watching by look (§5e): CLIP B/32 8-bit over sprite frames, on the NAS — look sets by words, tag and moment; tasting from the match; Find untagged by look           |
| 11    | OCR of burned-in text, feeding search and bulk tagging (§5d) — cost and quality unproven; then matching what was read to performers and sources                      |
| 12    | Faces (§5f): performer suggestions confirmed in a review shaped like OCR's queue — after a bake-off                                                                  |

Auth is phase 1 rather than late: `userId` threads through every repo function from the first
one written, and adding it afterward means touching every route.

## 17. Open risks

- **NAS CPU** is the binding constraint. Direct play and pre-generated web-safe variants
  matter far more than clever streaming.
- **Network-share I/O** — a full walk of a 200k-item library over SMB is slow; hence
  stat-based change detection and never re-hashing unchanged files.
- **Samsung TV support** is the least certain requirement; DLNA behavior varies by model year
  and deserves a spike before any UI depends on it.
- **Two processes, one SQLite file** — WAL plus short transactions should be sufficient at
  this scale, but worker write batching needs to stay disciplined or the UI will see
  `SQLITE_BUSY`. It did, on the first container restart with a 2000-job artifact backlog: short
  transactions were not enough, because it is the _rate_ of writes that starves a reader-turned-
  writer, not the length of any one of them (§4's split timeouts, §20's log).
- **Artifact inode count** can rival the library itself; the 2-level fanout and a
  configurable cache ceiling keep it bounded.

## 18. Gaps closed before phase 0

Review of the design against the baseline migration turned up one contradiction and several
schema-shaping omissions. Resolved here so the first migration does not need amending.

### 18.1 Contradiction — read-only mounts vs. trash

§12 mounts media roots `:ro`; §10 moves deleted files to `/data/trash`. Both cannot be true.

Resolution: **`MediaRoot.writable`**, plus a hard narrowing of what "writable" permits.

**Deletion is the only write operation the app ever performs on a media root.** No renames,
no moves, no in-place metadata writing, no re-encoding originals. Everything else the app
produces goes to `/data`. That single rule keeps the blast radius of any bug to "a file the
user asked to delete", and it makes the filesystem code small enough to audit.

Roots mount `:ro` by default and are genuinely immutable — the UI hides delete for them, and
duplicate review offers "which to keep" as advice. A root to be curated from is mounted
`:rw` and flagged.

The two must agree, and only one of them is the app's. The flag is refused — when set on an
existing root and when chosen while adding one — unless `access(W_OK)` succeeds on the root's
directory, and the error names the fix. The app cannot add the mount: mounts are fixed when
the container is created, and changing them from inside means the Docker socket, which is root
on the host and not something an internet-facing process gets. So the list of deletable folders
lives in the compose file, one `:rw` line per folder laid over the read-only tree at the same
container path, and a folder not on it stays immutable at the kernel whatever the flag says.

**Deletion is a per-user permission, not an admin action.** basket-bot's `User.scopes` is
already a comma list, so this is a `delete` scope alongside `admin` — some accounts curate,
most only watch. The check lives in the service layer with every other authorization
decision.

Because several people can now delete, deletion needs an audit trail and an undo:

- **TrashEntry** — `id, mediaId, rootId, relPath, bytes, deletedById, deletedAt, trashPath,
restoredAt, purgeAfter`. Admins see who deleted what and can restore until purge. This
  section originally scoped restore to the _file_; §10 extends it to the catalog entry, which
  is where the retention window and the `'trashed'` file state come from.
- `/data` and `/media` are different volumes, so `rename()` across them fails with `EXDEV`.
  Trashing is therefore **copy + fsync + unlink**, which for a 10 GB file is slow and runs as
  a job with progress, never in a request handler.
- **The app's own deletions do not wake the watcher** (2026-10-09). The trash job records the
  removal in the catalogue as it goes, so it tells the watcher (`expectRemoval`) and the event
  queues nothing. Before, each removed file queued a scan of its directory: deleting 120 videos
  (45 GB) at the top of a 13k-item library was 120 full walks, on the same four disks the copies
  were saturating, and the web process stalled behind its own reads for minutes at a time.
- Free space on `/data` is checked before trashing, or cleaning up duplicates fills the
  volume holding the database.
- Purge and restore are admin-only even though deletion is not.

### 18.2 Identifiers

`TEXT` primary keys from `crypto.randomUUID()`, matching basket-bot, with its CHECK length
constraints, `createdAt`/`updatedAt`, and `ON DELETE` clauses. Artifact fanout `<xx>` is the
first two hex characters of the uuid. Unguessable ids are also worth something here: a leaked
signed URL exposes one item and reveals nothing about its neighbours.

### 18.3 Images are not small videos

The design drifted video-first. Images need their own probe path:

- **EXIF** — `capturedAt`, orientation, camera make/model, lens, GPS. `Media.capturedAt`
  comes from EXIF for images and container metadata for video, stored UTC.
- **Orientation-aware** thumbnails, or half the library renders sideways.
- **Animated GIF/WebP** behave like video for preview purposes — they get a hover preview,
  not a static cover.

**Input formats are JPEG, PNG, WebP, and GIF only.** That is sharp's default build with no
extra system libraries, which keeps the image small and the Dockerfile boring. HEIC/HEIF,
AVIF input, and RAW are non-goals (§19) — adding HEIC later means libheif in the image and a
larger sharp build, so it is a deliberate decision rather than a drift. AVIF and WebP remain
available as thumbnail _output_ formats regardless.

**And yet a photograph needs an end.** Everything above is about ingest, where the two genuinely
differ. Playback is where the drift ran the other way: the viewer grew a queue only videos could
enter, because the queue advances on an `ended` event and a photograph never fires one. The answer
was not a photo feature. An end is given to _anything on the stage that lacks one_ — a photograph,
and a film awaiting a rendition — and the queue stops caring what kind of thing it is walking
(§14b). An image still has exactly one artifact and still is not a small video; it is simply, for
the five seconds it is on screen, the same kind of thing.

### 18.4 Subtitles and audio tracks — missing entirely

Add:

- **MediaStream** — `mediaId, kind (video|audio|subtitle), streamIndex, codec, language,
title, channels, isDefault, isForced` — the embedded tracks ffprobe reports.
- **MediaSubtitle** — external sidecar files (`.srt`, `.ass`, `.vtt`) the scanner finds
  beside a video, with `language` parsed from the suffix.

Serving converts to WebVTT on the fly (cached as an artifact). This touches the scanner, the
player, and the cast profile — casting must burn in or drop subtitles depending on receiver
support, which is another reason casting forces the `tv-safe` variant.

### 18.5 Companion files need a classification policy

`.srt`, `.nfo`, `folder.jpg`, `cover.jpg`, `*-thumb.jpg`, `Thumbs.db`, `@eaDir` (Synology),
`.@__thumb` (QNAP). Without an explicit policy the library fills with thousands of junk
"images" on first scan and the mistake is tedious to undo.

The scanner classifies every file as **media**, **companion** (attaches to a sibling media),
or **ignored**, driven by extension lists plus admin-editable ignore globs in `Setting`.
NAS-generated thumbnail directories are ignored by default.

### 18.6 Filename and folder parsing

Folder structure is the strongest metadata available before any scraping, and the scanner
currently throws it away. Add a **`parse`** stage to the job chain that derives
`Media.title` (editable, distinct from filename) and seeds `series` / `studio` / `performer`
tags from configurable regex rules.

`MediaTag.source = 'filename'` (§5b) is what makes this safe to re-run: re-parsing replaces
only its own assignments and never touches user- or AI-assigned tags.

### 18.7 The job queue needs real semantics

"A SQLite table" is not yet a queue. `Job` columns: `kind, mediaId, priority, state,
attempts, maxAttempts, availableAt, startedAt, heartbeatAt, claimedBy, lastError, progress`.

- **Claiming** is one atomic `UPDATE ... WHERE state = 'pending' ... RETURNING`, so two
  workers never take the same row.
- **Crash recovery** — a claimed job whose `heartbeatAt` is stale returns to pending. Every
  running job beats, on a ticker started by the runner rather than by the handler: only
  `transcode` has progress to report, and leaving the rest silent meant any job outliving the
  stale window — a sprite decoding a whole file, a purge copying between volumes — was
  reclaimed underneath itself, and for a kind with concurrency above one was then run a second
  time alongside the first. The ticker is liveness only; a handler that blocks the event loop
  stops it, and that job _is_ stuck.
- **Per-kind concurrency** — phash and probe can run several at once; transcode runs one, or
  the NAS stops serving pages.
- **Backoff and dead-lettering** — exponential `availableAt`, then a terminal `failed` state
  after `maxAttempts` with `lastError` visible in the admin job view. A corrupt file must not
  retry forever.
    - **Nor at all, when the error is about the file.** Counting attempts stops a corrupt file
      eventually, but only after spending every attempt, at every stage, on an answer already
      known: a truncated download (`moov atom not found`) cost three ffmpeg launches per stage.
      `isUnreadableSource` recognises a short list of container errors, and a match
      dead-letters the job and settles its `MediaStage` row on the first failure. The list is
      short on purpose — a missed case costs the retries it always did, a false match settles
      work that could have succeeded — and `Input/output error` stays off it, because that is
      what a share dropping mid-read looks like.
    - **Read line by line, and never from a decode error.** AVERROR_INVALIDDATA prints the
      same "Invalid data found when processing input" for one undecodable packet
      (`Error while decoding stream #0:0: …`) as for a file that cannot be opened at all. A
      substring match settled damaged-but-decodable files as unreadable on their first
      failure — two sprites in production, on items whose covers and previews had rendered.
    - **A changed file clears the item's failures.** They are evidence about bytes that are no
      longer there, and the case that makes this matter is the same download, caught
      half-written by a settle check that saw it pause, then finished. The probe chain
      re-queues cover, index, phash and filehash on a change, but preview and sprite come only
      from the sweep, which would otherwise never offer the item again.
- **Cancellation** — `DELETE /api/media/:id/transcode` moves a `pending` or `claimed` row to
  `cancelled` and nothing else. The worker is a separate process reachable only through this
  table, so cancellation is a _state it discovers_, not a message anyone delivers: the
  heartbeat is already `UPDATE ... WHERE state = 'claimed'`, so a cancelled job's next beat
  matches no row, the runner aborts the handler's signal, and `runTranscode` kills its ffmpeg
  child with SIGKILL and removes the `.partial`. Latency is one heartbeat interval.
    - SIGKILL rather than SIGTERM, because ffmpeg answers SIGTERM by _finalising_ the file —
      spending more time producing output that was just refused.
    - The partial is removed by the worker, never by the request handler, which would race an
      encoder still writing to it and would need a second copy of the logic that chose the path.
    - A cancelled job is neither retried nor dead-lettered: `complete` and `fail` are both
      `WHERE state = 'claimed'`, so a handler that ignores the signal and finishes anyway cannot
      report `done`, and three cancellations cannot exhaust `maxAttempts`.
    - **The sweep has to agree.** A cancelled transcode still owes a rendition, so the
      five-minute backfill would re-queue it and the cancellation would last five minutes.
      `cancelledMediaIds` excludes an item whose most recent transcode job was cancelled; a
      later job for the same item overrides that, which is what keeps "re-queue everything"
      working. Cancelling is a decision, not a pause.

### 18.8 Transcode profiles are plural

Only `websafe` was defined. At minimum three, declared as a `Setting`:

| Profile         | Purpose                                                                 |
| --------------- | ----------------------------------------------------------------------- |
| `websafe-1080p` | LAN direct play replacement for incompatible originals                  |
| `remote-720p`   | WAN viewing — bitrate-capped, the thing that makes remote access usable |
| `tv-safe`       | cast/DLNA target with conservative codec, audio, and subtitle choices   |

`Variant(mediaId, profile)` already allows this; the player picks by context, and only
`websafe` is generated eagerly.

### 18.9 Watch history

`UserMedia.viewCount` / `lastViewedAt` is a thin aggregate — enough for a "continue
watching" shelf, not enough for a real history view. Decision: keep the aggregate now, add
**MediaView** (`userId, mediaId, startedAt, positionMs, completed`) at phase 5 if wanted. It
is purely additive, so it is not a phase-0 concern — noted so it is not later mistaken for
an oversight.

### 18.10 Repo and process

This directory is **not yet a git repository**. Before code: `git init`, `.gitignore`,
`.prettierrc` and `tsconfig.json` copied from basket-bot, a `CLAUDE.md` porting the
conventions that apply here, and a `ci.yml` mirroring basket-bot's.

Testing policy: unit tests (pHash, filename parsing, config merge, path safety) run
everywhere and stay fast. Tests that invoke ffmpeg are a separate `test:integration` suite
run against generated fixtures — GitHub runners ship ffmpeg, so CI can run both.

## 19. Non-goals

Stated so scope stays honest: no live TV or DVR; no multi-node or clustered deployment; no
music-library or audio-first experience; no i18n/localization; no public share links to
non-accounts (phase 8's signed URLs are for cast devices, not sharing); no download-client or
torrent integration; no RAW, HEIC/HEIF, or AVIF _input_; and no writing to media roots beyond
deletion (§18.1) — no renames, no moves, no in-place metadata, no re-encoding originals.

## 20. Performance budget

**The rule: no read path may cost O(result set).** Every query is bounded by the page it
returns or by an index it walks. This is a first-class constraint in the same way responsive
layout is (§14) — not a later optimisation — because it is expressed in the _API contract_,
and a contract that promises an exact total has already committed every caller to a scan.

It was added after measuring, and the measurement was unkind. At 200k items the grid's first
page took **6.0 seconds**, and page fifty took the same, because the paging was real in the
API and imaginary in the database. Three causes, all invisible in a test library of four
files:

- The filter columns lived on `MediaFile` and the sort columns on `Media`. No index can
  serve a filter and an ordering on different tables, so SQLite drove from the file side and
  sorted every match into a temp B-tree. **Fixed by denormalising `listRootId`, `listable`,
  `listSize` and `listRelPath` onto `Media`**, maintained by triggers, so one partial index
  per sort covers both halves.
- Three sorts ordered by `COALESCE(column, 0)` to make NULLs predictable. An ORDER BY over an
  _expression_ cannot use an index on the column inside it, so this silently disabled the
  index that existed for exactly that sort. **NULLs now sort where SQLite puts them.**
- `random` used OFFSET over a computed hash — a full sort per page, and it repeated rows
  across page boundaries.

| Target                              | Budget                                                 | Measured at 200k |
| ----------------------------------- | ------------------------------------------------------ | ---------------- |
| Library grid first paint            | < 1 s (server-side paging, 60 items/page)              | 0.6 ms           |
| Page 1000                           | same as the first                                      | 3.5 ms           |
| Page 3000 (the last)                | same as the first                                      | 32 ms            |
| Shuffled page 1 / last page         | < 1 s (a sort of the matching set, like rating)        | 33 / 255 ms      |
| Favourites, any sort                | < 1 s (per-user, cannot be denormalised)               | 52–61 ms         |
| Exact count, once per filter        | < 1 s                                                  | 190 ms           |
| Sort by rating                      | < 1 s (per-user, cannot be denormalised)               | 205 ms           |
| Sort by last viewed, page 1 / last  | < 1 s (per-user, like rating)                          | 236 / 388 ms     |
| Facet counts (capped)               | < 200 ms p95                                           | 45 ms            |
| Search, narrow (1.4k hits)          | < 200 ms p95                                           | 19 ms            |
| Search, broad (35k hits)            | < 200 ms p95                                           | **215 ms**       |
| Grid scroll                         | 60 fps with previews capped and offscreen paused       |                  |
| Rescan of an unchanged 200k library | < 5 min (stat-only, no hashing)                        |                  |
| Direct-play seek                    | < 500 ms                                               |                  |
| HLS start (cold transcode)          | < 5 s to first frame                                   |                  |
| Idle RAM, whole container           | < 1 GB, leaving the NAS room for ffmpeg                |                  |
| Live-update latency                 | < 2 s from worker commit to grid patch                 |                  |
| Change-feed poll cost               | one indexed query/second, flat in viewer count         |                  |
| Phone grid scroll                   | 60 fps with previews capped at 1–2 concurrent decoders |                  |

A 200k-item library is a ~580 MB database including the FTS index and tags.

### The budget above measures queries, and a page is not a query

Every number in that table is server-side. They were all met and the app was still unusable on
the NAS: a cold grid load took **43 seconds** of wall clock while the database work inside it
cost milliseconds. The budget had no line for the transport, so nothing in it was violated and
nothing in it was relevant.

What a HAR of that load showed:

|                                      |           |
| ------------------------------------ | --------- |
| Peak requests in flight              | 76        |
| Queued in the browser (`blocked`)    | **854 s** |
| Answered by the NAS (`wait`)         | 93 s      |
| Server time for 120 covers, together | 0.1 s     |

**The cause is HTTP/1.1's six-connections-per-origin limit**, and the LAN deployment is plain
HTTP so there is no HTTP/2 to have. Three things then share those six lanes, in descending
order of damage:

- The live-updates `EventSource` (§13b) is a connection that never closes. Six become five for
  the life of the tab — the one cost of the change feed that the polling design it replaced did
  not have, and it is worth it, but it is not free.
- Viewport prefetch. App Router prefetches every `<Link>` on screen, which meant the whole
  navbar — seven RSC page renders nobody asked for — plus one per grid tile, sixty more.
- Sixty covers, which is the legitimate traffic and the thing everything else was starving.

Two decisions came out of it:

**The transport is part of the budget, and the proxy is not optional.** Caddy (§12) was
introduced for TLS and treated as the deployment someone graduates to. It is also the only
thing that makes the grid behave, because HTTP/2 multiplexes the six-lane queue away entirely,
and that reframes plain-LAN mode as a way to get started rather than a way to run. `docker/README.md`
says so now, including the split-horizon DNS step — previously documented only under casting,
where a browser-performance reader would never look for it.

**Viewport prefetch is off; hover prefetch stays.** `prefetch={false}` on the navbar and on
`MediaTile`. The default spends a request on presence; hover spends one on intent, and there is
only ever one of it. This is worth doing regardless of the transport — sixty-seven speculative
RSC renders is CPU the NAS does not have (§17) whether or not there is a queue to wait in.

**The server had to be able to say how long it took.** Chasing this from a HAR could establish
what the slowness was _not_ — the queries bench at 0.0–3.1 ms at the real library size of 14k,
and a production route handler answers in 4–6 ms — without being able to say what it was,
because nothing recorded a duration. `apps/web/src/lib/requestLog.ts` (started from
`instrumentation.ts`) now logs slow requests and event-loop delay behind `PRIVATE_STOCK_REQUEST_LOG`, hooked through `diagnostics_channel`
rather than a per-route wrapper: route handlers have no shared entry point by design (§3), so
anything opt-in would measure only the routes somebody remembered to annotate.

Event-loop delay is the half that assigns blame, and it is why request timing alone was not
enough. Node serves on one thread and `better-sqlite3` is synchronous, so a handler starved of
CPU by the worker beside it and a handler doing real work for the same duration are identical
from outside the process. The first shows as lag; the second does not.

**The second time the app looked hung, the HAR ruled this section out, and that was the
finding.** Same symptom — a delete that hung for minutes — but over HTTPS and `h2`, with
`blocked` at 1 ms on every entry and 2.6–7.2 s of `wait` on endpoints returning a few hundred
bytes. Two reads of that: requests that had waited 7.2 s and 5.1 s completed five milliseconds
apart, which is one thread being released rather than a queue draining; and `/api/library/roots`
is a read, so in WAL it cannot have been waiting on the worker's write lock. What was holding
the thread was the media route serving a whole 565 MB file for one open-ended range (§8). The
lesson is the general one: **a six-lane queue and a busy thread look the same from a browser and
different in a HAR**, and `blocked` versus `wait` is the column that separates them.

### What the instrumentation found once it was actually on

Three stalls, in the order they were mistaken for each other. Worth recording as a set, because
each one produced the identical symptom — "the site locks up" — and each was invisible to the
measurement that found the one before it.

| Stall                                                                | Duration                          | Found by                                                 |
| -------------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------- |
| A whole 565 MB file for one open-ended range (§8)                    | minutes                           | a HAR: `blocked` 1 ms, `wait` seconds                    |
| `bcrypt.hashSync` at module scope, cost 12, pure JS                  | 5.2 s, once per process           | `[loop] max` with `p99` near zero                        |
| `/api/library/stats` polled every 3 s, 4 aggregates                  | 5–13 s, repeatedly                | `[loop] max` matching a `[slow]` line to the millisecond |
| Page cache far smaller than the database, on a disk ffmpeg was using | 0.3–1 s per statement, everywhere | `PRIVATE_STOCK_SQL_SLOW_MS`: a PK update at 1,021 ms     |
| `idx_Job_claim` ordered so every claim sorted the queue              | 1.2–3.7 s per claim               | the same log, plus `EXPLAIN QUERY PLAN`                  |

The third is the one that took the longest to see and the shortest to fix, because the number
that identified it was sitting in plain view: a `[loop] max` of 13,279 ms beside a
`[slow] 13273ms GET /api/library/stats`. When the longest stall in a window equals the duration of
a request in that window, the request _is_ the stall — no further reasoning required. Two defences
now, deliberately independent: the client asks every 10 s rather than every 3 (`useLibraryStats`,
one hook so the two callers cannot drift), and the server answers from a 3 s per-viewer cache.
Making the count itself cheap was left open then; it was closed by not polling it at all (below,
"The disk, not the CPU").

**And the queue had no retention at all.** `ChangeLog` was pruned from the first version; `Job`
never was, so a succeeded row stayed for ever — **97,717 rows for a 14,181-item library**, a large
share of a 113 MiB database, in the table every insert, claim and completion maintains four indexes
over. The sweep now takes `done` rows after a day. It leaves `failed` and `cancelled` alone, and
that is correctness rather than caution: `settledMediaIds` reads exactly those two states to decide
what must never be queued again, so sweeping them would have the five-minute backfill rediscover an
unencodable file for ever. It also leaves a `done` row that stands in front of a failure for the
same `(kind, mediaId)`, because that pair's settledness is decided by whether anything _later_
exists.

**And the sweep had no idea how deep the queue already was.** `backfill.ts` said, in a comment,
that a bounded pass "keeps the queue the size of the work actually in flight" — and nothing looked
at the queue, so 500 rows per stage went in every five minutes whether or not the previous 500 had
been touched. Enqueueing outran draining by a wide margin, which is how 14,181 items became
**25,206 pending rows**: a work list four days long, with every row of it costing four index writes
and a share of the page cache the catalogue wanted. There is now a ceiling of four batches per
stage, checked _before_ the candidate query, because that join is the expensive half and running it
to discard the answer is the whole cost being avoided. Nothing is lost by refusing — the stage
table is the durable record of what is owed, and the next pass re-derives it.

That diagnosis needed the state breakdown, not the row count: 72,577 `done` and 25 `failed` is a
retention bug plus a flow-control bug, while 25,206 `failed` would have been a loop no index could
help. `db:diagnose` prints the breakdown for that reason.

**One more thing fell out of those stalls, in a place nobody was looking.** Preview rendering
worked in `.preview-parts`, a directory named from the item alone — fine for one attempt, and the
queue can produce two: a claim goes stale after 60 s of silence, the heartbeat behind it is a timer
on the event loop this section is about, and a VP9 encode of six segments on a throttled NAS runs
for minutes. So a job still running was handed to a second attempt and both wrote `part-0.webm` in
the same place. ffmpeg described it exactly as two writers in one file look — `Duplicate element`,
then an element "exceeding containing master element" — and then `Impossible to open` that part,
because the attempt that finished first had already deleted the directory the other was reading.

The fix is a directory per attempt (`mkdtemp`), which makes an overlap wasteful instead of
corrupting, plus an `ffprobe` of each part before it joins the list — the code always claimed one
bad region cost only itself, and that was only true of segments whose _encode_ failed. **A pipeline
writing to a fixed path should not depend on the answer to "can a job run twice?"**, which is the
general lesson; the stale-claim window is a separate question about the queue and is still open.

Worth keeping in view: with the box idle, `countVisible` measures **6.4 ms** and `queueSummary`
**13.4 ms** against this library. Every multi-second number in this section was contention, not
computation. The only fix here that changed an algorithm was the claim index; everything else
either stopped asking so often, stopped answering at such cost, or gave the disk less to do.

The second is a standing constraint rather than a fixed bug: `bcryptjs` is pure JavaScript with
no native half, so every login occupies the only thread for one to five seconds on this hardware.
Cost stays at 12 — this app is meant to be reachable from the internet. Moving to a hash that runs
on the libuv pool (`crypto.scrypt`, or argon2 as a native addon) is the open question, and it
carries a rehash-on-next-login migration.

**The art route did a detail page's work sixty times a page.** Each cover checked visibility
with `findDetail` — nine index probes across the viewer's overlay, three artifacts, a variant and
the root — and then `statSync`'d the file, all on the one thread. On a disk ffmpeg was reading, a
primary-key lookup measured 276 ms, and a grid's covers arrived in a 250–790 ms ladder with the
`[loop]` max matching the slowest. The check became `isVisible`, the three probes that decide it,
and the stat is async. It is now one statement, `findVisibleArtifact`: visibility and the
artifact row together, so a cover costs a single probe sequence rather than two.

**Authentication is cached, and that reverses a decision recorded here.** The per-request user
and root reads in `withAuth` were first left alone, on the argument that re-reading the user row
every time makes a disabled account stop at once, and that the reads were cheap once the page
cache was warm. The second half turned out false on the NAS (below), and cookie authentication
was four statements per request — `<img>` can authenticate no other way, so a grid was 240 of
them on the one thread. The owner's call: **instant effect for changes made outside the app is
not worth that.** `authCache` keeps the refresh-token → user and user → context answers for a
minute, never keeps a refusal, and is emptied by every service that changes what it holds —
sign-out, password changes, an admin editing, disabling or deleting a user, a library added,
removed, enabled or disabled. So everything done _through_ the app still takes effect at once;
only a hand-edited database or a rotated-out token is seen up to a minute late.

What was deliberately _not_ done: sprite-sheeting the covers, inlining them, or sharding across
subdomains to buy more connections. All three are ways to be less bad at HTTP/1.1, and all
three would still be in the code long after the proxy made them pointless.

### What the container's own counters said

With all of the above in place the app still stalled, and the logs had a shape none of the
earlier fixes explained: primary-key lookups — a visibility probe, an artifact by its unique
key, a refresh token by hash — at 0.3–1.5 s in the web process, and grids of covers finishing
together at ~2 s under a `[loop]` max of the same length. A statement with no algorithmic cost
taking a second is time spent off the CPU or off the disk, so the cgroup was asked directly:

| counter                       | value                       | reading                                               |
| ----------------------------- | --------------------------- | ----------------------------------------------------- |
| `nr_throttled` / `nr_periods` | 26,110 / 54,359             | **48%** of 100 ms periods hit the `cpus: 2.0` quota   |
| page cache + RSS / limit      | 1.21 GB + 0.26 GB / 1.5 GiB | at the cap                                            |
| `pgpgin` ≈ `pgpgout`          | ~51 M pages each            | ~195 GiB of file data streamed through a 1.2 GB cache |
| `swap`                        | 53 MB                       | Node heaps swapped out to keep media file pages       |

Three causes, each fixed where it starts:

- **Quota throttling freezes every process in the cgroup, the web server included.** `nice`
  cannot help: it orders who runs inside the quota, not whether the quota runs out. And it ran
  out because one ffmpeg used every core it could see (§7c). The fix is the per-job thread cap,
  `threadsPerJob`, and not a larger quota — more quota is simply spent by the same threads.
- **The kernel swapped heap to keep file cache.** A swapped page of the web process is a stall
  on its only thread when next touched, whereas media pages are only passing through.
  `mem_swappiness: 0` in the compose file. Raising `mem_limit` was rejected: at 195 GiB of
  throughput any cache size is flushed.
- **Every worker commit emptied the web process's SQLite cache.** In WAL mode a reader discards
  its entire page cache when it sees that another connection has committed, so the 48 MB
  `cache_size` bought the web process almost nothing while the worker was busy, and the worker
  was committing constantly. The worst offender was a scan that found nothing: `upsertSeen`
  rewrote every row to stamp `lastSeenAt`, and `MediaFile_list_au`, which fired on _any_ update,
  rewrote each item's `Media` row after it — the whole catalogue, the web process's hottest
  table, through the WAL in two commits per 200 files. Now an unchanged file is not written:
  the scan records it in a TEMP table (`beginScanSeen`), which lives outside the main file and
  its WAL, and reconciliation treats "stamped by this scan or confirmed into it" as seen. The
  trigger has a `WHEN` naming exactly the columns it reads, so a file-hash pass no longer rewrites
  `Media` either, and the scan's progress row is written every five seconds rather than every
  batch. An unchanged rescan of the library now writes nothing but that row.

**The async `stat` moved the queue rather than removing it.** Making the art route's file work
async took it off the one thread and put it on libuv's pool, which is **four threads by
default**. A grid is sixty covers and then sixty previews, each a `stat`, an open and a few
reads, and with ffmpeg reading the same spinning volume each of those waited on the order of
100 ms. Four at a time, that is ~5 s, and the log said exactly that: a page of covers all
finishing together at 4.9–5.7 s, the same previews at ~550 ms once cached, while the
visibility query behind them ran sixty times in 2 ms on a quiet disk. The web process now
starts with `UV_THREADPOOL_SIZE=16` (`entrypoint.sh`, web only, overridable from compose). It
does not make the disk faster; it puts enough reads in flight at once that the disk's queue can
order them, and it keeps sixty tiles from waiting four at a time. The structural answer — `/data`
on a volume ffmpeg is not reading — is a deployment choice the compose file already recommends.

The general lesson is the one this section keeps arriving at from different directions: on a
NAS, **a slow statement is usually a symptom of something else holding the machine**, and the
counters that say what — `cpu.stat`, `memory.stat` — are one `docker exec` away.

### The disk, not the CPU

With quota throttling fixed (0.5% of periods) the site still froze, and the host said why: **40–50%
iowait with half the CPU idle**, and reads on two of the drives averaging 95–125 ms each. `/data`
and the media are one volume, four single HDDs concatenated (no striping), readahead 32 MB, with
~720 MB of page cache for the whole NAS. Media streams and ffmpeg filled that cache faster than the
database could stay in it: 10.7 MB of the 127 MB file was resident in the web process, and every
page it needed was a ~100 ms disk read on the one thread. A statement's cost on this box is the
**pages it touches**, not the work it does — the same query measured 3 ms warm and 17 s cold.
Per-process `/proc/<pid>/io` and the refault counters in `/proc/vmstat` are what show this;
`docker stats` does not.

`pnpm db:diagnose --cost` (docker/README.md, "Pages, not milliseconds") measures that quantity:
each hot read path run through the real repo functions as a real user, on a `query_only`
connection with mmap off and an emptied 1 MiB cache, pages taken from `/proc/self/io`. Pages ×
~100 ms is a statement's worst case here. Fixed from its numbers, in order of payoff:

- **SQLite's mmap is off on the NAS** (`PRIVATE_STOCK_SQLITE_MMAP_MB=0` in the compose file). A
  fault on a mapped page is served by readaround sized from the volume's 32 MB readahead; pread of
  a 4 KB page on a random pattern reads ahead nothing.
- **Tag counts are index-only.** Every tag count joins `Media` only to test `listable`, which read
  each assigned item's whole row — 1,167 pages for the performer list, 4–17 s.
  `idx_Media_listable_id` is `UNIQUE ("id") WHERE "listable" = 1`, and the UNIQUE is load-bearing:
  a plain partial index on `id` never beats the primary key, which is also a unique lookup, while
  a unique one ties with it and wins as the covering choice. Facet and vocabulary counts fell by
  the same factor (~1,100 → ~200 pages on a production-sized replica). The per-kind counts
  (`browseTags`, `countByKind`) read `Media.kind` too, so they fetched rows anyway (~990 pages
  per page of the Tags page). `idx_Media_listable_id_kind` is `UNIQUE ("id","kind") WHERE
"listable" = 1` and those queries add `kind IN (…mediaKinds)` — always true, but pinning both
  columns is the only way the planner prefers a partial unique index over the primary key (217
  pages). It sits beside the one-column index rather than replacing it: replacing it would need the
  term on every listable join, and where MediaTag is pinned by a literal the term turned facet
  counts into a walk of Media by kind (~2,100 pages). The same reasoning, one column further, gives
  `idx_Media_listable_id_kind_root` for counts narrowed to the viewer's libraries.
- **Standing failures start from the failures.** The count scanned the queue for its few dozen
  failed rows and then read every job of the same kind for each. `idx_Job_failed` (partial on
  `failed`) plus `idx_Job_kind_mediaId` make it a walk of the failures and one range probe each
  (599 → 77 pages); `listFailed` orders by `+rowid` so the planner sorts the tens it found rather
  than walking the table backwards hoping to meet fifty. `(kind, mediaId)` never changes after
  insert, so claims, heartbeats and completions — the worker's constant writes — never touch it.
- **The nav stopped polling counts.** `/api/library/stats` bundled four things at one rate, and
  the two expensive ones needed no polling: nothing had read the queue depth since the shell's
  "queued" badge went, and the item count was already computed per library by
  `/api/library/roots`, which the sidebar fetches anyway. Stats is now the scanning flag and root
  counts — two statements on tiny tables (the running-scan probe on `idx_Scan_running`, since scan
  history is never pruned), one global 3 s cache — and the nav's total reads the roots response.
  That is cached per viewer for a minute, cleared by every in-process change to a count, and
  invalidated by the change feed only on inserts, removals and resyncs, **never on updates**: every
  probe records an update, and the cellar had been re-running the expensive count on each one
  without a debounce, faster than any poll.
- **Progress is saved when playback stops, not on a clock.** It was a write every 10 s per viewer,
  then on pause, leaving, hiding and once a minute — a twenty-minute watch went from ~124 writes to
  ~21. Then the position went altogether (§14b, "Nothing is resumed across visits"): the server now
  hears the watched threshold and the end, two writes at most per item, whatever its length.

Two failures that looked like the database and were not entirely:

- **Saving a tag answered busy** because it was a deferred transaction that read first — the
  §4 bullet on `IMMEDIATE` transactions. The slow disk widened the read-to-write window from
  microseconds to most of a second, against a worker that commits several times a second.
- **Saving a tag answered 502** with an empty body from Caddy: `connection reset by peer`. Caddy
  keeps idle upstream connections for 2 minutes and Node closed them after 5 s; after an 11.7 s
  stall Node's overdue idle timer ran before the request already waiting on the socket was read,
  and Caddy does not retry a PUT. The app's keep-alive is now 5 minutes (`KEEP_ALIVE_TIMEOUT` in
  `entrypoint.sh`), so the proxy is always the side that closes. **Any stall long enough becomes
  a connection error somewhere**, which is one more reason the stalls themselves are the target.

**The web process's cache only lasted one statement.** In WAL mode a connection discards its
whole page cache at the start of any read transaction that finds the file changed since its last
one, and outside a transaction every statement is its own. With the worker committing several
times a second, the 48 MB `cache_size` bought almost nothing: each statement of a request started
cold. A request made of several statements should read under one **deferred** transaction — not
the web default of `IMMEDIATE`, since it must not take the write lock. `getHome` does, and two
shelves sharing an index walk now cost one page for the second instead of ~300.

**The home page paid for the planner's guesses.** After a restart `/api/home` took 43 s, 32 s of it
continue-watching: written as the grid's `Media LEFT JOIN UserMedia`, the planner (no statistics)
walked every listable item and sorted, 2,036 pages for 12 rows. It now drives from the viewer's
overlay index (`idx_UserMedia_viewed`, since the shelf became "Recently viewed") through a
`CROSS JOIN`, which SQLite never reorders (120). `listByIds` had
the same shape and fix (one probe per id instead of a 315-page walk); the hidden-ids lookup on every
grid page names its partial index with `INDEXED BY` (43 pages → 1), so a renamed index is an error
rather than a quiet slowdown. A fair shuffle must read its whole matching set, so shuffled shelves
draw a fresh dozen per visit from a sample of twenty shelves' worth, refreshed every ten minutes —
up to ten minutes of filter staleness, never of visibility, since every draw is re-checked.
"Per visit" is literal: the Room sends a seed it keeps while its cached page is showing, and the
hand dealt for it is held for an hour, so a refetch (returning to the page, a live update) re-reads
the same items instead of swapping the row for another under somebody reading it. Replica totals: ~4,000 pages → ~1,150 just after a restart, ~500 on later visits.

**The worker's first minutes belong to the site.** Every deploy restarts both processes, and the
worker did all of its heavy reading at boot — a scan, the watchers' walk, the stage sweep, an
orphan sweep that read `Artifact` three times and `stat`ed 71k files, a prune backlog — at exactly
the moment someone opens the site. `startup.ts` now holds one grace period (5 min in production):
at boot only stale-claim recovery, the checkpoint timer, requested work and the bin's moves run;
then background claiming, then watchers _followed by_ the startup scan (in that order, so nothing
slips between them), the stage sweep (+2 min), housekeeping (+4 min) and the orphan sweep (+15
min), each timer counted from its own first run so the passes stay apart. Nothing was dropped, only
delayed. The stage sweep's candidate query fell from ~5,000 to ~390 pages per stage by finding the
owed items from index-only sets before reading any row (`idx_MediaStage_stage_mediaId`, replacing
an index no plan used), and a stage with nothing owed is skipped until the newest stage row or the
policy changes, or an hour passes. The dupe seed query took the same shape (3,683 → 465). The
orphan sweep reads each table once in paused rowid batches and answers "row without a file" from
its own directory walk. The costs: work arriving in the first five minutes after a deploy waits for
the grace, and a few changes the cheap change mark cannot see (a restore, a failure turned
retryable) reach the stage sweep up to an hour late.

**A purge scanned the library once per artifact.** `DELETE FROM "Media"` measured 7 s on the NAS,
nearly all of it foreign-key checks: `Media.coverArtifactId` references `Artifact` `ON DELETE SET
NULL`, so each of an item's ~5 cascading artifacts scanned all of `Media` for a cover pointing at
it, and `Job`, `TrashEntry` and `UserMedia` were scanned once per parent row. An index serves a
foreign-key check only if it leads with the child column and is not partial on something else —
partial `IS NOT NULL` is fine, since a lookup by value implies it. `idx_Job_kind_mediaId` became
`(mediaId, kind)`, which serves every query that used it and the check, for no extra write.
`MediaTag.mediaId` is still scanned: tiny here (1,242 rows), and an index on it makes the
statistics-free planner drive the tag browse queries from `Media` — pin their join order first.

**One stage's backlog woke every idle stage.** The sweep's idle-skip compared a single mark, the
newest `MediaStage` rowid, and every job of a draining backlog moves it — so each idle stage re-ran
its candidate query every five minutes (41 s of reads in twenty minutes on the NAS). The mark is
per stage now, built only from what can make _that_ stage owe work: a new item, a new successful
probe (for probe-gated stages), a new failure of its own, its own policy switch — each one index
descent. Already-queued items are left out, so a stage whose remaining work is all queued counts
as idle. A pass during a drain went from ~8,800 pages to ~3,800, and ~12 between hourly rechecks.

**Text matches were resolved by reading documents.** `mediaId` is an UNINDEXED column of an
external-content FTS table, so `SELECT "mediaId" FROM "MediaSearch" WHERE … MATCH …` fetched each
match's whole `MediaSearchDoc` row, OCR text and all — a one-letter search read the entire document
table. `idx_MediaSearchDoc_rowid_mediaId` maps matched rowids to items (`searchRepo.matchedIdsSql`,
pinned with `INDEXED BY`): search "e" 1,494 → 554 pages for the count, 1,188 → 248 for the page.
A mentions filter ("Find untagged") also walked every listable item of a kind for a name found in a
few dozen files; when the match count (FTS-only, ~30 pages) is under `max(100, max(rowid)/60)` the
count and page now start from the matches through a `CROSS JOIN`, and above that keep the walk,
which is cheaper there. A grid page and its count read under one deferred transaction, like home.

**Typing paid for the tab nobody was reading.** The search box is debounced at 300 ms and someone
typing a word slowly pauses that long after each letter; each pause asked for the grid, its count,
the facets and the other kind's count. `KindTabs` asks for the inactive kind only once the filter
has held still for a second.

**A read-only transaction in the web process held the write lock.** The `IMMEDIATE` default (§4)
is right for writes and wrong for a read: `stageRepo.summary()` read for 10 s inside one and held
the worker's job claim for 8 s. Every web transaction that only reads now says `.deferred()` —
home, a grid page and its count, the tag profile, the Processing summary — and that is the rule.

**The Processing page counted the library on every open** — ~6,300 pages, a 9–15 s freeze. The
totals are kept now, not counted: `MediaStageTally` (one row per stage, state and version, listable
items only) is maintained by triggers on `MediaStage` and on `Media`'s listability, with `BEFORE
DELETE` on `Media` because a cascade hides the parent from the child's trigger; a test compares
it to a from-scratch count after every path that can change it. The denominator reads
`idx_Media_listable_probed_kind`, the queue counts live jobs from `idx_Job_pending_unique`, all
under one snapshot: ~165 pages cold. The answer is cached once for every admin — 1.5 s while
busy (under the 2 s poll), 60 s idle, with a two-page check that nothing has started before an
idle answer is reused — and cleared by every in-process action that changes it. The "80 ms in
between" opens had never been an app cache; they were the kernel's page cache, until media
traffic evicted it.

**The viewer walks a set by ids, not tiles.** Stepping remounts the viewer, so every step more
than 30 s after the last refetched the grid's fully hydrated 200-item page — ~716 cold pages per
step for someone tagging through "untagged performer". `GET /api/media/ids` runs the same
`pageIds` walk without hydration (101 pages; 8 for an unfiltered first page) and is fetched on
every arrival, because tagging moves offsets and a held window would skip items; tiles are
fetched by id only for the up-next strip, and only those not already cached.

**"Appears with" is a second request.** A tag's page is one request for what it is and what
carries it; the companions and their strips come from `GET /api/tags/:id/companions`, asked only
once the profile has drawn and the section — now below the shelves — is near the viewport. The
profile reads under one snapshot, and its hero and shuffled shelf are one sample of the tag's
assignments in the shuffled grid's own permutation rather than a grid shuffle that reads the
whole matching set: ~1,000–1,160 pages cold → ~570–670, companions ~100–195 deferred. The cost:
a viewer who can see under half a tag's items may get a short shuffled shelf.

**A feature's derived counts were refreshed under the write lock.** The OCR review queue froze
the site for an hour of real use: every coined name started a full rematch that rewrote every
string's pairs in 500-string transactions and recounted them under the lock (~3,570 pages a run,
76 runs), and each accept recounted inside its own `IMMEDIATE` transaction — a sign-in refresh
answered busy behind it. Now a decision commits with its ChangeLog record and the counts it can
move are recounted afterwards: read with no transaction open, then only the pairs whose count
changed recomputed under a short lock (recomputed, not copied, so a commit in between cannot be
overwritten); a busy recount is skipped and heals at the next one or at the end of every rematch.
`idx_MediaText_textNorm` carries `(mediaId, reviewState)` so a count never reads a row. The
rematch is enqueued 15 s out so a burst of names is one run, writes only strings whose pairs
change, and re-checks the vocabulary before finishing: ~360 pages, none under the lock. **The
general rule: a derived count is never refreshed inside the transaction that made it stale.**

**The embed child held a core and ~300–400 MB for as long as a backlog lasted.** One thread
already (intra-op 1), but batch-16 runs and onnxruntime's arena grew it to 411 MB, adding to a
host already swapping (3.8 GB RAM, 2.3 GB swap in use) — and a child started under the throttle
kept that priority after the window was switched off. The child now runs one square per model
run with no arena (~285 MB steady, 4% slower), a 64 MB heap cap, replacement between items above
288 MB and a hard stop above 384 MB that fails one job attempt rather than the worker, and is
always at lowered priority. Outside the processing window embed has no slots at all — only
requested embeds run — the one kind stopped rather than slowed, because what it holds is memory.
With quiet hours switched off (as on 2026-10-04) it still runs around the clock.

**The worker's own memory.** After a deploy the worker grew from 144 MB to 259 MB resident plus
62 MB swapped in six and a half hours, on a host whose page cache is what the web process reads
the database through. `smaps` split it into 202 MB of glibc main heap and ~97 MB of V8 heap; four
causes, each measured in the production image on the production database:

- **The file watcher watched every file** — chokidar opened 13,023 `fs.watch` handles for a
  13k-file library, ~30 MB of live heap and twice that committed. It now holds one watch per
  directory, which is all the scanner ever used.
- **Every repo call compiled its statement again.** better-sqlite3 has no statement cache, and
  each statement's 4–20 KB of native memory waits for V8 to collect a small wrapper — 199 MB of it
  beside the heap the watcher held. `reuseStatements` keeps up to 400 compiled per connection; each
  `prepare` returns its own handle that applies its own `pluck`/`raw`/`expand` just before running,
  so a statement held in a variable keeps its mode when another caller plucks the same SQL.
  Never `.bind()` one.
- **The worker's SQLite cache was 43 of its 50 MB of live native heap.** The worker now keeps
  16 MB and the web 48 MB (`PRIVATE_STOCK_SQLITE_CACHE_MB` still overrides both).
- **Native memory still waited on garbage collection** on a heap too small for V8 to hurry; the
  worker runs a full collection every five minutes (`--expose-gc`), and glibc's mmap and trim
  thresholds are pinned for it (not for the embed child, where the defaults are faster).

No V8 heap cap: the limit is not a trigger, only a place to die, and the orphan sweep at 200k
items would find it. Measured locally under the same work: flat at ~105 MB against ~160 MB.

**A shuffle is sorted once, and a "find untagged" list is not shuffled at all.** No index serves
a shuffle, and the viewer re-asks for its page on every arrival, so every step sorted the whole
matching set. For the filter actually being walked — no performer, rated four stars or more — the
filter, not the order, was the cost: 934 pages under every sort, for the ids page and again for
the count. Two changes. A list whose filter implies a missing tag (`findsUntagged`: an `all` group
with an untagged rule, or an `any` group of only untagged rules) is run newest first whatever it
is sorted by (`withSortOverride`, applied by the server; the sort control shows it disabled with
the reason, and the saved filter keeps its stored sort): 538 pages a shuffled page against 144.
And the whole order of a shuffle, or of an untagged list being walked, is kept as rowids
(`keptOrders`: 10 bytes a slot and 4 more once a kind is paged, at most 32 orders and 1M slots —
~14 MB worst case — for 5 min).
Each page re-checks its slice against the full filter, so items that left are dropped in place
and the walk never shifts; the count is slots minus departures (4 pages); arrivals are seen
through the newest rowid; joiners wait for the TTL; `clearLibraryCaches` empties it. A viewer step
went from 934 + 934 pages to ~200.

**Opening a shuffled saved filter walked the library three times (2026-10-14).** The first load of
a shuffled saved filter took 9–10 s for `/api/media` on the NAS, with each kind tab's
`/api/media/count` at 4.7–7.7 s, all at once. Measured on a production snapshot (12,996 listable
items: 8,184 videos, 4,812 images; `Media` is 1,355 pages), with two filters: **A**, "any of: my
favourite performers, four stars and up, my favourites", and **B**, portrait only. The grid, its
count and the other tab's count each took their own order — the grid and its count the same one
twice, the other tab a second key — and each walk was dear for its own reason. Five changes:

- **Orientation is an indexed generated column** (§14e). `idx_Media_list_orientation` is
  `("listRootId", "orientation", "kind", "id") WHERE "listable" = 1`; orientation leads kind so one
  range serves both tabs. A virtual column referenced in a query marks every column of the row
  as used, so `EXPLAIN QUERY PLAN` says `INDEX` rather than `COVERING INDEX` — but the table cursor
  is a deferred seek that no column ever triggers, and the row is never read. B's videos 1,429 →
  74 pages, its images 1,110 → 93, both kinds at once 164; the Videos tab's count sorted by date
  1,429 → 74. Sorted pages keep their own indexes (the planner still prefers
  `idx_Media_list_kind_addedAt` for date, which stops at the page).
- **The measure indexes carry `kind`.** The same check for the other "The file" filters found the
  same cost: duration, resolution, bit rate, frame rate and size have an index each, without
  `kind`, so a shuffle, a kind's count or a kind's sorted page read every candidate's row — over
  ten minutes 1,177 pages, over 1080p 1,584, over 5 Mbps 1,593, over 500 MB 1,106, over 50 fps 595,
  against 275 for the videos unfiltered. `kind` now follows `id` in each (after it, because `id` is
  unique, so the order and every sort's plan are unchanged): 97, 221, 236, 71 and 24. The Videos tab
  sorted by resolution went 813 → 62 for its first page, by bit rate 1,022 → 101.
- **An "any of" made of indexed sources starts from them** (`mediaRepo.groupSourceSql`). A's group
  was tested on every item: a walk of the kind's index with, per item, an overlay probe and a
  correlated `EXISTS` over all 51 favourite tags — 688 pages and 357 ms of CPU for the videos, 452
  pages for the images. Each of its rules — a tag, favourite tags, a rating range, favourites —
  names its items from an index of its own, so a statement that reads the whole matching set (a
  kept order, a count, a shuffled page) takes their `UNION` as its rows (`CROSS JOIN`, which SQLite
  never reorders), probes `idx_Media_listable_id_kind_root` once per item, and leaves the group out
  of the WHERE, where every other condition stays. Each branch is its rule's condition turned
  round with the same scoping — assignments the viewer can see, a favourite tag that is not
  somebody else's private one, the rater being the viewer or a shared filter's owner — so the
  union is the group exactly; `listCompleteness.test.ts` holds it to the brute-force model under
  both raters, and checks every slot of the kept order against the filter asked row by row. Two
  details carry the numbers: `INDEXED BY` plus an always-true `kind IN ('image', 'video')` term,
  without which the planner probes the primary key and reads rows (1,391 pages); and the favourites
  branch naming `idx_UserMedia_favorite` (3 pages, against 198 through the rating index). A, both
  kinds: 508 pages, 5–10 ms warm. Not for a page in an indexed order, which stops walking when it
  is full; starting from the group would gather and sort all of it first.
- **One walk serves both kind tabs.** A shuffle or an untagged list is taken without its kind,
  each slot keeping its item's kind (read from the same index entry, so free); a kind's pages are
  the windows of its own slots and its count is its slots less its departures. A kind's order
  within the order of both is exactly the walk of that kind alone, item for item
  (`mediaIdsPage.test.ts`), so "A filter never depends on the sort" holds per tab: pages are full
  but for departures, slots never move, `hasMore` comes from the kind's slots. A look is still
  taken per kind, because it ranks and caps each kind separately (§5e).
- **One take, however many ask.** The three requests arrive together and each found no order kept,
  so even one shared key would have been walked three times. A take in progress is recorded by key
  with the newest rowid it began under; a request for the same order joins it instead of walking
  — a read plan yields `join(promise)`, which `runOffThread` awaits holding no reader (it leases one
  at a plan's first statement now, not at its start) and `runNow`, being synchronous, answers with
  nothing, so the plan takes its own as before. A take that fails settles its joiners with nothing
  and they take their own; one begun before an arrival is not joined; `forgetKeptOrders` forgets the
  takes in progress too, and an order taken across a forget is served to everyone who was already
  waiting for it and kept by nobody, as the generation guard already did for the taker.

And `tagsForMediaIds` reads the library's assignments and the viewer's own as two halves
(`UNION ALL`), each through the unique index that holds exactly its rows: as one `"userId" IS NULL
OR "userId" = ?` it ran a multi-index OR whose library half read every assignment's row, 157 pages
per sixty tiles; split, 100.

A first load, cold, counting pages per statement as each runs on its own connection: A 2,620 →
1,243 (walks 1,828 → 508), B 4,653 → 806 (walks 3,968 → 164); timed end to end on the NAS under
load, with the counts' walks run beside the grid's on two readers as the browser asks, A 6.3–6.6 s →
4.6–4.9 s and B 6.4–6.9 s → 3.5–3.6 s. What is left is the page itself: re-checking the sixty
slots against the filter (A 234 pages, B 137) and hydrating sixty tiles (~400 pages, the four
artifact joins and the overlay at about seven pages a tile) — the next thing to measure.

**The web process's own memory.** After a deploy it grew from 155 MB to 235 MB (resident plus
swap) in 19 h: ~87 MB of V8 pages, a 71 MB glibc main heap, ~45 MB of other native memory.
Measured in the production image on the production database under representative traffic:

- **Next 15's router remembered every request path that was not a file** — a null in an LRU
  sized for a million entries, never read back, each keeping a slice of the whole request URL:
  ~230 B per distinct cover, preview, stream or page path for the life of the process. Fixed by a
  pnpm patch (`patches/`, fixed upstream in Next 16 — drop it with the upgrade), guarded by
  `nextFsCachePatch.test.ts`.
- **glibc moved the stream's 1 MB read buffers into the main heap** once the first was freed,
  where they waited on V8 and fragmented it. The worker's MALLOC pins now apply to the web too.
- **The art route read covers in 64 KB buffers**; `openSized` reads a file in one buffer of its
  own size.

Idle after load: 243 → 202 MB, main heap 64 → 40 MB. A 16 MB SQLite cache did not shrink the web's
main heap, and a forced GC after idling freed ~4 MB for a 22–40 ms pause on the only thread, so
the web keeps 48 MB and has neither a periodic GC nor a V8 cap. Its V8 heap is flat: compiled
routes and one vm context per route manifest.

The structural answer is still `/data` on a disk the media is not on.

### Pages, not an endless scroll

Numbered pages, chosen for robustness over polish. A page is a URL: shareable, reloadable,
bookmarkable, and the back button lands where it should. Nothing accumulates in the browser,
there is no scroll position to restore, and at 60 tiles there is no virtualizer — which
deleted the width measurement, the re-measure effect, and the overlapping-row bug that came
with caching row pitch.

That holds for the indexes as well as the library. `/captures`, `/reels`, `/clips`,
`/duplicates` and the tag pages keep their sort, search, filters and page in the address,
declared through `lib/urlView.ts` (§14b).

Keyset cursors were faster in principle and could not express "jump to page 40", because
there is no cursor for page 40 without walking to it. Against a partial index an offset is a
walk of index entries rather than a sort, which buys direct addressing cheaply.

**The page is fetched in two steps: page the index, then join.** SQLite applies OFFSET by
counting _output_ rows, so the four artifact joins and the variant join were evaluated for
every row that was then discarded -- at page 3000, 180,000 rows joined five ways to produce
sixty, which cost 1.2 seconds. The inner query touches only the partial index, and the joins
run for the sixty survivors: 32 ms.

The other half of that was `um."hidden" IS NULL`, which cost an indexed probe for every row
the offset walked past and stopped the index being covering. Hidden items are rare by nature,
so they are fetched as a list and excluded by id instead, keeping the paging query inside the
index. Measured at offset 180,000: 185 ms became 29 ms. A viewer who has hidden more than a
few hundred items falls back to the join rather than building a vast parameter list.

**Sorting by rating is the exception**, at 205 ms rather than under a millisecond. `rating`
lives on `UserMedia` because it is per-viewer, so it cannot be denormalised onto the shared
row and no partial index can cover it -- the sort has to join and order across two tables,
which is exactly the shape everything else was moved away from. It stays within budget, and it
is the one sort whose cost grows with the library.

**The count is a separate request.** An exact count is a scan of the matching set — 188 ms
against 0.4 ms for the page — and its answer cannot change by turning a page. It is fetched
once per _filter_ and cached there, which is what makes an exact total affordable at all. The
grid degrades to previous/next if it is missing, so the count is optional by construction.

### A filter never depends on the sort

Every sort, shuffle included, is one WHERE clause, then an ORDER BY, then LIMIT and OFFSET.
Walking every page of any filter under any sort yields each matching item exactly once, the
union is what `countMedia` counts, and every page but the last is full.
`listCompleteness.test.ts` enforces that across every filter, sort and direction, against the
viewer's ratings and a shared filter's owner's, by walking whole result sets and comparing
them with a brute-force model of the fixture.

It is written down because shuffle broke it, and nothing looked wrong while it did.

### The library shuffles by sorting; playlists by computing

A shuffled library orders the matching rows by `(a * rowid + b) mod p`, with `p` a fixed prime
above any rowid and `a`, `b` drawn from the seed (`rowidShuffleParams`). Because `p` is prime
the map is a bijection on rowids, so this is a permutation of whatever the filter matched,
stable for a seed, with `id` as the tiebreak like every other sort. It pages, counts and jumps
exactly like "date added".

**A shuffle you leave is the shuffle you come back to.** The remembered Library link
(`rememberedPages.ts`) keeps the seed, and a new order is only ever something you ask for —
Reshuffle, or choosing Shuffle. A seedless query falls back to a fixed seed, so every seedless
way in — Shuffle from the sort menu, the room's "see all", a saved filter stored without one —
used to show the same order on every visit; the library page now replaces a seedless shuffle
address with a seeded one before rendering, so the seedless address never becomes a history
entry.

**A saved filter keeps no seed.** It used to save the one on screen, and since the library deals a
seed before anything can be saved, every shuffled filter was pinned to one order: Reshuffle only
changed the address, so the next time the filter was opened it showed the old set again. A saved
shuffle now means "a shuffle" — `queryParams` drops the seed, so neither saving nor comparing sees
it, and a seed stored by an older save is ignored on opening. Each visit to the filter is dealt a
new order; the remembered Library link is what returns you to the one you left.

**The prime is fixed, not sized to the library.** It was the smallest prime above `max(rowid)`,
and primes are a few apart at this size, so nearly every scan that added items moved it — the
same seed then gave a completely different order, and a shuffle you came back to was not the
one you left even with the address unchanged. `rowidShuffleParams` takes every rowid shuffle
over 2^31 − 1 instead: a seed is one order forever, and a new item takes its slot without
moving anyone else. Sorting by the expression costs the same whatever the prime, and both
factors stay below 2^31, so `a * rowid` cannot overflow SQLite's 64-bit integers. The tag strips
use the same range. Playlists do not: they walk the permutation slot by slot, so their prime has
to stay close to the playlist's length.

It was computed instead, and the reasons are worth keeping. The first shuffle ordered by a
per-row hash through the full FROM — six seconds a page and rows repeated across boundaries —
so it was replaced by the music-player technique: `i -> (a*i + b) mod p` gives the slot of the
k-th item in O(1), each page owns a fixed window of slots, and a page cost 0.9 ms at any depth.

**That walked the permutation and filtered afterwards, which made the answer depend on the
sort.** The slots were rowids of the whole `Media` table, so a narrow filter drew mostly misses:
with a few favourites in a large library, page one held two or three of them — or none, which
the grid reported as "nothing matches your filters" above a Next button — and the rest were
scattered over thousands of blank pages. The viewer took a short page for the end of the set;
the showcase stalled at the first empty one; a random home shelf came back short. Each looked
like a plausible result. It was found in production, as "I only see some of my favourites,
depending on the sort".

The sort costs a sort of the matching set per page, index-only inside the paging subquery:
33 ms for page one of 200k and 255 ms for the last, against the same < 1 s line that
sort-by-rating holds. A narrow filter costs what its matches cost. In return a shuffled library
has a count and numbered pages like every other view.

**Playlists keep the computed shuffle, because its flaw cannot reach them.** A playlist
permutes `PlaylistItem.position` (§14b), whose key space _is_ its membership: there is no
filter to reject a slot, so pages are full apart from the prime's overshoot at the end. That is
a case where "pick, then filter" has nothing to filter, and it is the only case where it is
allowed. A shuffled playlist can still return a short page before the last, which is why the
viewer decides whether there is a next page from the server's `hasMore` and never from how
long the page is.

### Facets without counts

Decided on 2026-10-14. The panel's chips used to carry the **filter's** count — what picking the
chip would leave, with a facet's own "any of" group and exclusions taken out so an "any of" chip
said what it would add ("Disjunctive counts", retired with it). It was exact and it was the
costliest thing the library asked for: recounted against the whole filter on every filter, sort
and search change, 6 s on the NAS for one rule-group filter, beside a 2.7 s read of which chips
to show at all — and running in parallel with the grid's own reads on the same disks, so the
counts slowed the list down too. The chips above the grid also paid for it, because they took
their tag _names_ from the same response, panel open or not.

Now:

- **The chip's number is library-wide use** (`uses`), the figure the chips were already ordered
  by. It does not move with the filter, so one answer serves every filter: the facets are keyed
  by the filter's tag ids alone (`selected`, drawn first and past the cap so they can be undone),
  and the vocabulary read behind them is held for a minute in the web process
  (`FACET_VALUES_TTL_MS`). A tag applied in that minute reaches the panel when it lapses.
- **The ♥ chip says no number**; its name still says how many favourites it means.
- **Names are their own request** (`/api/tags/names`, `useTagNames`), a lookup by id, so the
  chips above the grid, the panel's sections and the Advanced editor no longer cost a count.

What was given up: a chip no longer warns that it would empty the grid. For a library whose main
job is organising, that warning did not earn seconds of disk on every click; a chip that leaves
nothing is one click to undo.

### Facet values come from the vocabulary; only the counts touch the library

This was the other way round, and the reversal is worth recording because the first version
was defensible and still wrong.

Counting is a scan of the set being counted, so facets looked like the one read path that
could not be made proportional to a page — unfiltered at 200k the exact version cost 4.3
seconds before the grid rendered anything. The answer was to discover a facet's values by
scanning the filtered media and grouping the tags found there, capped at 5,000 candidates
(78 ms), with the response marking itself approximate so the panel could say `~` rather than
imply a precision it did not have.

The counts were honest about being a sample. **The list was not, and could not be.** On a
14,191-item library a keyword applied to a single video fell outside the cap about two times
in three, and when it did the panel had no chip for it at all — no `~`, no "20 of 340", just
a filter that did not exist. Worse, the candidate set was `LIMIT 5000` with no `ORDER BY`, so
which values the library appeared to contain depended on the query plan: two facet passes
differing only in joins neither of them read disagreed about which of two keywords existed.
A value you cannot reach is a worse failure than a number that is off by a few, because
nothing on screen admits it.

So the panel asks two questions instead of one:

- **Which values exist** — `tagRepo.listFacetValues`, over `Tag` joined to its assignments.
  Proportional to the vocabulary and to how much has been tagged, neither of which grows with
  the library; most items in a large library are never tagged at all. Complete by
  construction, ordered by library-wide use, capped per facet for the panel's sake rather
  than the query's.
- **What each one holds under the current filter** — `mediaRepo.facetCountsForTags`, asked
  only about the values on their way to the screen. Exact. It counts per tag, driven from
  `idx_MediaTag_tagId` with one primary-key probe per assignment, so its cost is the tagging
  rather than the library. That index is `("tagId", "userId", "mediaId")` so the walk never
  reads a `MediaTag` row; see the costing note below. That is why it needs no cap where the old grouping did: asked in
  this direction the library is never the unit of work.

`EXISTS` rather than `mediaId IN (SELECT ...)` for the same reason. The `IN` form materialises
the whole filtered set once before any tag is counted, which is precisely the scan being
avoided; correlating on `m."id"` lets the planner start from the assignments.

A chip may now read `(0)`: the value exists, the current filter reaches none of it. That is
information the old panel could not express — it dropped the row instead, which looks exactly
like the value not existing.

**What this still approximates:** the ordering key and the "show all 340" total are
library-wide rather than restricted to the viewer's accessible roots, because they are read
from the vocabulary and not through the media filter. That is exact today, when every user
can reach every root, and has to be revisited with per-library access (§6) — at which point
both would describe items the viewer cannot open.

**What a facet request costs, and why it is two passes over the tagging, not three
(2026-10-13).** On the NAS a filter-panel request took 5–6.5 s, and because `better-sqlite3`
is synchronous the web process answered nothing else meanwhile — the grid's covers and video
ranges sat Pending behind it, and `[loop]` reported 7.9 s and 10.7 s stalls. Its statements
were each a walk over every assignment of the values on screen, and each step of that walk
was a random read:

- `idx_MediaTag_tagId` held only `tagId`, so every assignment cost a read of its `MediaTag`
  row for `userId` (the scope) and `mediaId` (the join). The index now carries both and the
  walk stays inside it. Replaced rather than added beside: the wider index answers every
  `tagId` lookup the narrow one did, and two would be two B-tree writes per tag applied.
- `countFacetValues` was `listFacetValues` again — the same join over every assignment,
  grouped the same way — run only to learn how many values each facet had before the cap. The
  total is now a `count(*) OVER (PARTITION BY kind)` on the listing's own grouped rows.

On a synthetic 80k-item library with a warm cache, the covering index alone took the listing
from 265 to 150 ms and the filtered counts from 202 to 128 ms. Cold, on the NAS, the saving is
the larger share, since each row no longer read was a disk seek. The tile joins in the counts'
`EXISTS` were suspected too and are not a cost: every one of them is on a unique key, and
SQLite drops an unreferenced left join to a unique key from the plan.

### Relevance does not page indefinitely

BM25 has no index: scores are computed for every match and sorted, so page fifty of a search
costs what page one does and nothing can change that. Every search engine caps this and asks
you to refine instead.

Broad searches are the one measurement outside budget: a term matching 18% of the library
takes 215 ms against a 200 ms target, because the FTS match set has to be built before
anything can be filtered. It shrinks as you type -- 102 ms at 7% of the library, 19 ms at
0.7% -- so the miss is confined to queries that are really browsing.

### Reads off the thread

**The problem every other fix in this section only shortened.** `better-sqlite3` is synchronous
and Node serves on one thread, so a statement that takes six seconds is six seconds in which the
web process answers nothing: covers, video ranges and the next API call all sit Pending behind
it. On 2026-10-13 the filter panel's counts took 6.5 s and a 200-row showcase page 10.7 s while
the face job competed for the disks, and `[loop]` logged stalls of the same lengths. Making each
statement cheaper helps; on four HDDs at ~100 ms a seek there will always be one that is not
cheap enough.

**So the slow statements run on reader threads.** `packages/db/src/readPool.ts` keeps two worker
threads (`PRIVATE_STOCK_READ_THREADS`, 0 for none), each with its own connection, and the main
thread waits on them the way it waits on a file read. WAL is what makes this free of new locking:
readers never block each other or the worker's writer, so a reader thread is one more reader of
a kind there already are.

**What moves is statements, not services.** The services keep state the threads must not split:
kept shuffle orders (`keptOrders.ts`), prepared looks, the caches `clearLibraryCaches` empties
after a write, and the signing key behind every tile's URL. Moving a whole service into a thread
would have given each thread its own copy of all of it, and a write on the main thread would
have had to reach every copy. Instead a service's reads are written once as a **read plan** — a
generator that yields each statement it needs by name (`read("listMedia", ...)`, `reads.ts`) and
is handed the rows — and one of two drivers runs it:

- `runNow` calls each statement here, synchronously. For the callers that must stay synchronous:
  inside a snapshot of their own (a home shelf, a tag's page), inside a cache's compute (a saved
  view's covers), and every test.
- `runOffThread` leases one reader for the plan's whole run, opens a deferred read transaction
  on it, and sends each statement there. One reader per plan keeps what `inOneSnapshot` gave on
  the main thread: one snapshot and one warm cache across the plan's statements. The lease is
  taken at the plan's first statement rather than its start, so a plan that begins by waiting
  on another's work holds no reader meanwhile (below).

**A plan can wait on another's work instead of repeating it** (2026-10-14). Besides a statement it
may yield `join(promise)` — the kept order another request is already taking is the case (§20 "One
take, however many ask"). `runOffThread` awaits the promise; `runNow` cannot wait inside a
synchronous call, so it hands back nothing and the plan does the work itself. The promise must
not reject: a failure settles it with nothing, which reads the same way. `readPoolCheck.js`
checks the waiting from compiled output, since vitest only ever runs plans inline.

Everything between two reads — authorization, the kept-order cache, URL signing — runs on the
main thread under either driver. A plan is the same code under both; only the transport differs.

**Which reads.** The ones `[slow]` named: the grid's page, ids and count (`/api/media`, `/ids`,
`/count`, and a saved filter's items), the kept-order walks behind them, the tiles' tags, and
the filter panel's counts (`/api/media/facets`). `reads.ts` lists them. A look's ranking is still
taken on the main thread (`takeLookOrder`); the home page and a playlist still read inline. Each
moves by becoming a plan, when it shows up in `[slow]`.

**A kept order taken across an `await` can be overtaken.** A library disabled while a shuffle's
walk is on a reader empties the kept orders; the walk then returns an order of the library as it
was. `forgetKeptOrders` bumps a generation, and an order whose walk began before the bump is
served to the request that took it and not kept.

**Measured** on the synthetic 80k library, six heavy plans (a shuffle's whole order, the facet
vocabulary, its counts) at once: inline, the main thread stalled for the whole 3.3 s; on two
readers its longest stall was 17 ms, and the work finished in half the time. Reader threads get
the worker's 16 MB SQLite cache rather than the web's 48 MB (`PRIVATE_STOCK_DB_ROLE=reader`):
each is one more heap inside the container's memory cap, and what they read is shared below them
in the kernel's page cache.

**What it does not do** is make a statement faster. The disk is still the floor; a plan still
takes as long as its reads. What changes is that one slow plan costs the request that asked for
it, and not every request that arrives while it runs. Under vitest plans run inline, so
`docker/smoke.sh` is the check that a thread loads from compiled output (`readPoolCheck.js`).

**The thread entry is found on disk, not beside the module.** The first version started it from
`new URL("./readThread.js", import.meta.url)`, which passed every test and the smoke check and
then answered 500 on every grid page under `next start`: Next bundles `packages/db` into the
server despite `serverExternalPackages` (it does not externalise a workspace package), and
webpack took that expression for an asset — copying the file alone into `.next/server/chunks/
static/media/`, where its imports resolve to nothing. The pool now walks up from the working
directory to `packages/db/dist/readThread.js`, as `findModelsDir` does for the models, and the
thread loads the package's own compiled output rather than the bundle. Only an end-to-end run
against `next start` shows this class of failure.
