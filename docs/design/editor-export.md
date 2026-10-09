# Reels → editor timelines (Resolve first), and where it goes next

> **Status: parked design, 2026-10-02.** Nothing is implemented. To resume, re-check:
>
> - the §14d text in `ARCHITECTURE.md`
> - the probe fields in `apps/worker/src/media/probe.ts`
> - how `/api/media/:id/stream` authenticates downloads
>
> Then start at Phase 1, step 1.
>
> Research sources:
>
> - Kyno metadata mapping
> - Resolve 18.5 and 21.1 notes (OTIO import, Python scripting now Studio-only, MCP server)
> - The FCPXML version rules
> - auto-editor's FCPXML and MLT writers (reference implementation)

## Context

Reels are virtual today: an ordered list of clips (`Clip.mediaId, startMs, endMs, speed, label`) that
the browser plays by seeking. Nothing is rendered or exported — `reelRender` is a reserved, unhandled
job kind (`packages/core/src/domain.ts:113`), and §14d lists rendering under "designed and not built".
The new direction: let a reel leave the app as a **timeline a real editor opens**, so the app becomes
the place you find and select footage and Resolve becomes the place you finish it.

Decisions from the user: target **DaVinci Resolve (free and Studio)**; desktops reach originals over
the **NAS SMB share** (link in place, no copying); **editor export ships first**, rendering after.

What others do (research summary):

- **Kyno** is the closest model: it sends selects with tags, ratings, notes and markers to Resolve,
  Premiere and FCP. Descript, Gling and Cutback export transcript-driven rough cuts as
  FCPXML/XML/EDL with coloured markers and bins.
- **No self-hosted library exports to editors** (Jellyfin, Plex, Immich, PhotoPrism), so this is open
  ground.
- **Resolve imports** (File → Import → Timeline) EDL, FCP7 XML, FCPXML, AAF, DRT and OTIO.
    - FCPXML is its most mature path for retime, markers, keywords and clip names.
    - OTIO import is basic: cuts and dissolves only, and track names get reset.
- **Resolve 21.1 (Sept 2026) moved Python scripting to Studio only** and added a native MCP server in
  Studio. Any automated "build the timeline for me" path is therefore Studio-only. For free users the
  file import is the only route.
- **Editors want frames, not milliseconds.** They also need rational rates (30000/1001), start
  timecode and constant frame rate. Our probe stores only a rounded `fps` (avg_frame_rate). It has no
  timecode, `start_time` or VFR flag (`apps/worker/src/media/probe.ts:162`), so phone footage would
  drift.

## Phase 1: export a reel as an FCPXML timeline for Resolve (the build)

### 1. Capture the timing facts editors need (schema change: migration + `init.ts` + zod)

- Add to `Media`:
    - `fpsNum INTEGER`, `fpsDen INTEGER`, from `r_frame_rate` as a rational.
    - `timecodeStart TEXT`, from the `timecode` tag or the tmcd stream.
    - `startTimeMs INTEGER`, from `format.start_time`.
    - `isVfr INTEGER`, set to 1 or left NULL (1 when `r_frame_rate` ≠ `avg_frame_rate` by more than a
      tolerance).
- Implementation path:
    - Extend `ProbeResult`/`applyProbe` in `packages/db/src/repos/mediaRepo.ts:171` and the parser in
      `probe.ts`.
    - Add a new timestamped migration under `packages/db/src/migrations/`, then run `pnpm test -u` for
      the schema snapshot.
- Backfill: rows that predate the change get NULL, and the exporter falls back to snapping `fps` to
  the nearest standard rational (23.976 → 24000/1001, 29.97 → 30000/1001, and so on). Re-probe
  existing media through the existing probe job path. I'll check how a re-probe is enqueued before
  adding anything.

### 2. A pure timeline model in core: `packages/core/src/timeline/`

- **`model.ts`:** zod `reelTimelineSchema`, built by `buildReelTimeline(entries, mediaFacts, pathFor)`.
    - Picks the sequence rate, using the most common source rate.
    - Converts each clip's `startMs/endMs` to source frames at its own rate, offset by `timecodeStart`.
    - Lays out record positions, carrying `speed`, `label` and source path. Reuses `spanRunMs` and
      `effectiveRate` from `packages/core/src/clips.ts`.
- **`fcpxml.ts`:** an FCPXML 1.10 writer.
    - `<resources>` holds one `<format>` per rate and one `<asset>` per media with `<media-rep src>`.
    - The `<spine>` holds `<asset-clip>`s.
    - Speed becomes a `<timeMap>`. A clip label becomes the clip name plus a marker. Media tags become
      `<keyword>`s, so Resolve shows them as keywords.
    - Times are rational strings (`1001/30000s`). The XML is hand-built with an escaping helper, with no
      dependency (the TS libraries found are immature). auto-editor's FCPXML writer is the reference for
      the structure.
- **`otio.ts`:** an OTIO JSON writer. It is cheap (plain JSON) and covers Kdenlive and Premiere later.
  Speed becomes a `LinearTimeWarp`.
- These are pure functions with unit tests, placed beside them and following the existing unit-test
  conventions. Snapshot the XML and JSON for a fixture reel with mixed rates, a speed clip, timecode
  and an odd label (`&<>"`).

### 3. Paths: the user's share prefix plus `relPath`, never the server path

- Each export takes a **per-root prefix** that the user types, e.g. `\\nas\Videos` or
  `/Volumes/Videos`. The source becomes a `file://` URL of `prefix + relPath`. Windows UNC paths and
  drive letters are encoded correctly.
- `MediaRoot.path` (the container's `/media/...`) is never sent to non-admins. This matters for an
  internet-facing deployment.
- The prefix is a device fact (Windows and Mac differ), so the UI remembers it in `localStorage` per
  root, wrapped in try/catch. No new `Setting` or config key.
- Validation (zod, in core): length cap, no control characters, scheme-free. `relPath` still goes
  through `assertSafeRelativePath()`.

### 4. Service and route

- `apps/web/src/lib/services/reelExportService.ts`:
    - Authorizes exactly like reading the reel: reuse the visibility and owner check in `reelService`.
    - Loads entries, which already include media, and media facts.
    - Builds the timeline and serializes it.
- `apps/web/src/app/api/reels/[id]/export/route.ts`:
    - Handles `GET ?format=fcpxml|otio&prefixes=<json rootId→prefix>`.
    - Pastes the literal route-config block, validates with zod, uses `withAuth()` and
      `toErrorResponse`.
    - Sets `Content-Disposition: attachment; filename="<reel name>.fcpxml"`, sanitizing the name.
- Errors are typed: `ValidationError` for a missing prefix on a root the reel uses, and
  `NotFoundError` for a reel that is not visible to the user.

### 5. UI: an "Export to editor…" item in the reel page menu (`app/(app)/reels/[id]/page.tsx`)

- A Mantine `Modal` with these parts:
    - A format choice: Resolve (FCPXML), selected by default, or OTIO.
    - One prefix input per library the reel touches, labelled with the root label and showing a resolved
      example path.
    - A warning listing clips whose source is VFR.
    - A short "In Resolve: File → Import → Timeline" note.
- Download through a plain anchor to the route with a bearer token? Not possible, because downloads
  can't set headers. **I'll check how `/api/media/:id/stream` authenticates media requests and use the
  same mechanism.** If streams use a cookie or signed-URL scheme, export uses it as well. Otherwise:
  fetch → blob → object URL.
- Phone layout: a full-screen modal with touch targets of at least 44px.

### 6. Docs

- `ARCHITECTURE.md` §14d: a new subsection "Editor export". Record the decisions and why:
    - FCPXML over OTIO for Resolve.
    - The prefix lives client-side.
    - Frames come from rational rate plus timecode.
    - VFR is warned about, not conformed.
- §13d needs nothing (the export writes no files). Move the item in `ROADMAP.md`.
- No query cache is involved (it's a GET download), so `docs/CACHE_KEYS.md` stays the same.

### Verification

- `pnpm typecheck && pnpm lint && pnpm test`. These cover the timeline unit tests, the schema drift
  check and the snapshot (run `pnpm test -u` once).
- Add a probe integration test (`*.integration.test.ts`) on a generated fixture with a timecode tag,
  and a VFR fixture made with ffmpeg `setpts` jitter.
- Manual check:
    - Build a reel spanning two libraries with a 2× clip and a 29.97 source, then export it.
    - Import it into Resolve free with File → Import → Timeline.
    - Confirm the clips link online through the SMB path, in/out land on the same frames the app
      shows, the speed clip runs at 2×, and labels show as clip names and markers.
- Run `./docker/smoke.sh` after `pnpm build`.

## Where it goes next (roadmap, not part of this build)

1. **Resolve Studio "Send to Resolve".**
    - A small companion Python script (or Resolve 21.1's MCP server) pulls `/api/reels/:id/timeline.json`.
    - It then calls `ImportMedia` → `CreateEmptyTimeline` → `AppendToTimeline`, sets clip colours from
      favourites or ratings, and adds markers.
    - It needs a long-lived personal API token scope, which is a new auth decision for §12.
2. **Selects bins, not just timelines.** Export the clip list, a saved filter or a tag as a Resolve bin
   with keywords, ratings and notes. This is Kyno's best feature, and our tags and favourites already
   hold the data.
3. **Round-trip import.** Upload an FCPXML or OTIO exported from Resolve, and the app creates or
   updates clips and a reel from it. Editors trim in Resolve and the library remembers.
4. **Render (§14d's `reelRender`) on the same timeline model.**
    - An MP4 with chapters at clip boundaries and an SRT of labels.
    - The design question "does the export shuffle" is answered once for both render and export.
5. **"Collect" bundle for remote editing**, which suits the internet exposure.
    - A zip or `.otioz` with trimmed media plus 1–2 s handles, a ProRes Proxy or DNxHR LB transcode, a
      CFR conform, preserved timecode and relative paths.
    - Runs as a worker job with output under `/data`.
6. **Assisted assembly.**
    - Use `scdet` scene detection to propose sub-clips.
    - Beat-synced reels: aubio beat times snap cut points and are exported as timeline markers.
    - An auto rough cut from a filter ("every 5-star clip tagged X, ≤4 s each").
    - 9:16 reframing hints for vertical cuts.
