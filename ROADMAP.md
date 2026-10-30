# Roadmap to v1

What is left, and why it is left. `ARCHITECTURE.md` says what the system **is**; this says
what has not been built of it yet. When something here is finished, delete the entry — this
file is a queue, not a changelog, and git holds the history.

Status of a line is one of:

- **Next** — the queue, in order.
- **Later** — real work, no argument about the order yet.
- **Deferred** — considered and consciously postponed; `ARCHITECTURE.md` says why.

Phase numbers refer to §16 (Build order). A section reference is the decision record.

---

## Next

**The queue is empty.** §14b is finished — `UserMedia.note` was the last per-user field and
now has a writer — and OCR, the one item promoted out of a later phase, is complete and can
be turned on for the whole library from the admin screen. What remains is §16's outstanding
phases, all of them under **Later**, in no forced order.

---

## Later

### The OCR sampling levers as settings — §5d

Recognition is complete and shipped; these are the cost controls it runs on, and §5d says
they belong to an administrator rather than to a constant. `OCR_PROBE_FRAMES`,
`OCR_BURST_EVERY_MS`, `OCR_SWEEP_EVERY_MS`, `OCR_MAX_FRAMES` and the storage floors are in
`packages/core/src/ocr.ts`. An admin-UI task rather than an OCR one, which is why it outlived
the queue entry it came from.

### On-demand HLS — phase 3

The only phase-3 item outstanding. Nothing under `apps/*/hls` yet; §8 describes the session
model and the segment cache.

### Home shelves, prefs and saved-filter UI — phase 5

API complete (`HomeLayout.rowsJson`, `UserPref`, `SavedFilter`). §16 calls the UI "pending a
rewrite".

### Backup and sidecar export — phase 8

No CLI, no job. `dataDir/backups` is classified `irreplaceable` (§13d) and written only by
the migration runner.

### Reverse-proxy documentation — phase 8

`trustedProxyHops` is configurable and documented in §12; the deployment guide is not
written.

### The wine-cellar theme pass — phase 4

§16 lists it as outstanding. Player hotkeys, the other half of that line, are largely done.

### Multiple users — §6, phase 8

**Late, deliberately.** The install is a single household, so the rules have nobody to
exercise them; they are still built into each feature as it lands, because retrofitting
per-user correctness means touching every write path.

Accounts exist: invitations, `/register`, Admin › People (scopes, disable, remove, name,
address, password reset), and `/account` for your own name and password (§12c). What is
missing is **per-library access** — `LibraryAccess` has no write path, only the read in
`mediaRootRepo`, so an invitation is an invitation to the whole library. It needs a per-account
root filter on every media query, the home page, search, facet counts and the change feed,
where one missed query is a content leak.

Sharing a playlist or saved filter belongs here too. `visibility`, `resolveAs` and the whole
`overlayUserId` mechanism are complete and tested and nothing calls any of it — §14b: _"it
is the hard half, it costs nothing to leave sitting there."_ The UI is the only piece.

---

## Loose ends

- **CI does not build the image or run `docker/smoke.sh`.** It runs the unit and integration
  suites only. Smoke is the one check that loads `dist` the way the container does — the
  thing nothing else would notice (`CLAUDE.md`).
- **`apps/web/public/` is empty** — no favicon. It holds a `.gitkeep`, and that file is not
  tidiness: the Dockerfile copies the directory, git does not track empty ones, and without it
  a fresh clone could not build the image at all.
- **Fonts are not vendored**, so the wine-cellar look depends on what the browser has.
- ~~**`HAS_RELEASED` is still `false`**~~ — flipped at the first NAS deployment. The baseline
  is frozen and every schema change is now a timestamped migration plus `init.ts` plus the zod
  schema (`packages/db/src/released.ts`).

---

## Deferred

Recorded so they are not rediscovered as gaps. Each has its reasoning in `ARCHITECTURE.md`.

| Thing                     | Where                               | Short reason                                                                                                                                                                             |
| ------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Casting (DLNA)            | §14b                                | The Cast sender is built (§11); DLNA push and the TV-safe profile are not. Phase 9                                                                                                       |
| Reel rendering and export | §14d                                | Virtual reels play through the existing two-element player. A rendered file needs an ffmpeg concat job, a state lifecycle and a place in `dataDir` — none of which watching one requires |
| AI tagging (CLIP)         | §5d                                 | Phase 10, optional, local                                                                                                                                                                |
| Editor export (Resolve)   | `docs/design/editor-export.md`      | Parked design: FCPXML/OTIO timelines from reels                                                                                                                                          |
| Facial recognition        | `docs/design/facial-recognition.md` | Parked research: calibrate on the NAS before building                                                                                                                                    |
| Tags from OCR             | §5d                                 | Recognition noise in a curated vocabulary is hard to undo                                                                                                                                |
| Per-predicate `resolveAs` | §6                                  | Filter-wide choice first; the reverse is not available                                                                                                                                   |
| Collaborative editing     | §6                                  | Not worth the conflict handling                                                                                                                                                          |
| Error-log viewer          | §12c                                | `ErrorLog` is written and never read. A new screen, not a gap: size the table first, then a section on Processing                                                                        |
| Trigram search index      | §5c                                 | Doubles index size for a case prefix search handles                                                                                                                                      |
| Elasticsearch             | §5c                                 | §5c argues it at length                                                                                                                                                                  |
