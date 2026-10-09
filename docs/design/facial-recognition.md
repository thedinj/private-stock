# Facial recognition — suggesting performers from faces

> **Status: parked research, 2026-10-03.** Nothing is implemented. To resume, re-check:
>
> - the OCR sections of `ARCHITECTURE.md` §5d, which this copies the shape of
> - the stage registry in `packages/core/src/stages.ts` (§7b)
> - the `MediaTag.source` CHECK constraint, which must still allow `'ai'`
>
> Then start at Phase 1.
>
> Timings below are rough estimates from memory, not measurements. Phase 1 exists to replace
> them.

## Verdict

Facial recognition is feasible as an opt-in background stage, built the way OCR was. Most of
what it needs already exists:

- **Stage registry (§7b).** `mode: "optIn"`, `state: "empty"` (ran, found no faces) and
  `appliesTo` (stills vs video) cover a `faces` stage with no new conventions.
- **`MediaTag.source = 'ai'`** is already reserved in the CHECK constraint, so face suggestions
  need no table rebuild.
- **`MediaTag.confidence`** already exists, so matches arrive as suggestions to confirm, never as
  assertions.
- **OCR's frame pipeline**: one ffmpeg call per position, timestamped frames, a
  confirm-at-the-frame review UI, `CPU_BOUND` priority and the calibration-script pattern
  (`scripts/ocr-calibrate.mjs`). Faces can reuse all of it, and possibly OCR's frames.
- **Existing performer tags are free training data.** Items tagged with exactly one performer,
  whose faces form one dominant cluster, give reference faces with no manual labelling.

`ROADMAP.md` already defers "AI tagging (CLIP)" to phase 10, optional and local. This would sit
beside it.

## Pipeline

```
1. Sample frames ──► 2. Detect faces ──► 3. Embed
   ffmpeg, one call     SCRFD or            ArcFace, 512 floats a face,
   per position;        RetinaFace          stored as files in dataDir
   may reuse OCR's                                 │
   frames                                          ▼
6. Suggest for review ◄── 5. Match ◄────── 4. Group within video
   MediaTag, source 'ai',   brute force,       40 frames of one person
   confirm at the frame     in memory,         become one cluster
                            calibrated
                            threshold
                               ▲
                               │ reference set
                     Performer references
                     faces from items already
                     tagged with one performer
```

Steps 1–3 run once per item in the worker. Steps 4–6 are cheap and can re-run whenever the
reference set grows.

Runtime: `onnxruntime-node` with InsightFace models (SCRFD for detection, ArcFace `buffalo_l` for
embeddings) — the same stack Immich uses.

## Risks

None is a blocker. Cost and accuracy are the two to measure before committing.

| Risk                                   | Severity     | Detail                                                                                                                                       | Likely answer                                                                                                                           |
| -------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| CPU cost on the NAS                    | Medium       | Estimated 50–150 ms per frame to detect, ~50 ms per face to embed. At ~20 frames a video, 2–5 s per item: days to weeks for a 200k backfill. | Opt-in, `CPU_BOUND`, backfilled through the ordinary queue like OCR. Measure on the QNAP first.                                         |
| Vector storage vs "only BLOB is pHash" | Medium       | 512 float32 = 2 KB a face. ~10 faces an item × 200k ≈ 4 GB as BLOBs.                                                                         | Per-media vector files in `dataDir`; rows hold only clusters, matches and confidences.                                                  |
| Vector search                          | Low          | SQLite has no vector index.                                                                                                                  | Not needed: each video's few clusters are compared against a few thousand reference faces, brute force in memory. sqlite-vec stays out. |
| Accuracy                               | Medium       | ArcFace is strong on frontal, well-lit faces; recall drops with profiles, motion blur, heavy makeup and occlusion.                           | Suggestions only, confirmed in review. Thresholds from a calibration script, not a guess.                                               |
| New native dependency                  | Low          | `onnxruntime-node` ships prebuilt linux x64 and arm64 binaries.                                                                              | Resolve it the way ffmpeg and Tesseract are; cover it in `docker/smoke.sh`.                                                             |
| Model licence                          | Low here     | InsightFace pretrained weights are non-commercial only.                                                                                      | Fine for a personal self-hosted install. Revisit if the app is ever distributed.                                                        |
| Biometric data, internet-facing        | Worth noting | Face embeddings identify real people, and the app is planned to face the public internet.                                                    | Admin-only and opt-in. Vector files never served by any route. Purged with the media item.                                              |

Rejected: a Python sidecar container (Immich's approach). It is a second runtime and a second
service talking over HTTP, where the architecture keeps the worker as the one place jobs run.

## Next steps

Each phase gates the next on a measured result, the way OCR moved into v1.

**Phase 1 — calibrate (decides go / no-go)**

- [ ] Confirm the QNAP CPU model and architecture (x64 or arm64)
- [ ] Write `scripts/faces-calibrate.mjs` on the `ocr-calibrate.mjs` pattern: SCRFD + ArcFace via
      `onnxruntime-node` on ~200 items
- [ ] Record per-frame and per-face timings on the NAS; project the full-library backfill
- [ ] Use single-performer items as ground truth; measure precision and recall at several
      thresholds
- [ ] Check whether OCR's extracted frames can be reused, or faces need their own sampling

**Phase 2 — the `faces` stage and suggestions**

- [ ] `ARCHITECTURE.md` section (§5d, beside OCR) recording these decisions, including vector
      files in `dataDir`
- [ ] Register a `faces` stage: `optIn`, `CPU_BOUND`, `appliesTo` stills and video
- [ ] Migration + `init.ts` + zod for the face cluster and match tables
- [ ] Reference sets from performer tags; matches written as `MediaTag` suggestions with
      `source = 'ai'` and a confidence
- [ ] Review UI: confirm or dismiss at the frame, reusing OCR's review pattern
- [ ] A `faces` Setting row for thresholds and sampling, with calibrated defaults

**Phase 3 — unknown faces**

- [ ] Cluster unmatched faces across the library
- [ ] "Name this person": naming one cluster creates or attaches a performer tag and suggests it
      everywhere else

## Open questions

- Which CPU is in the QNAP? It decides days versus weeks, and whether arm64 binaries are needed.
- Stills and video from the start, or video only first?
- Should suggestions target performer tags only, or other facets too?
- Is the Python-sidecar rejection firm, or acceptable if `onnxruntime-node` is slow on the NAS?
- Phase 10 beside CLIP, or earlier?
