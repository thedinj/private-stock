import { execFile } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

import {
    AuthorizationError,
    COVER_CLEARED_CHANGE,
    NotFoundError,
    ValidationError,
    artifactRelPath,
    assertSafeRelativePath,
    captureNaturalDirection,
    type Capture,
    type CaptureListResponse,
    type CaptureQuery,
    type DiscardCapturesResult,
    type MediaFrame,
} from "@private-stock/core";
import {
    FRAME_TIMEOUT_MS,
    dataPaths,
    frameArgs,
    libraryFilePath,
    loadConfig,
    resolveFfmpeg,
} from "@private-stock/core/server";
import { artifactRepo, mediaRepo, mediaRootRepo } from "@private-stock/db";

import type { AuthContext } from "../auth/withAuth";
import { artifactUrl } from "./artService";
import { mayAlterOwnWork } from "./collectionAccess";
import { inFrameSlot } from "./frameSlot";

/**
 * Capturing a frame, and choosing which frame represents an item (§13).
 *
 * Two operations that look like one feature and are deliberately separate. Capturing writes
 * a file and an `Artifact` row; choosing a cover updates one pointer and writes nothing. That
 * is what makes reverting free — the generated cover stays exactly where it was, so a choice
 * can be undone and a regeneration cannot destroy one.
 *
 * **This is the only ffmpeg call in the web process, and the exception is deliberate (§2).**
 * The rule exists because transcodes saturate CPU for minutes and must not share a process
 * with request handling. One frame is not that: `-ss` before `-i` seeks by container index,
 * so the work is a seek and a single decode regardless of how long the video is. The value of
 * the button is that the picture has changed by the time you get back to the grid, and a
 * queued job cannot promise that — the worker's idle poll alone is two seconds, and longer
 * while it is busy. The exception is bounded to exactly this: one frame, one hard timeout,
 * a cap on how many run at once (`frameSlot.ts`), and nothing else.
 */

const execFileAsync = promisify(execFile);

/**
 * How wide a capture is kept.
 *
 * The source's own width, capped. A still that can be opened full screen wants the pixels the
 * video actually has — 640 is a grid tile, and upscaled to a monitor it is a blur of the thing
 * somebody deliberately paused on. The cap is there because a 4K source would otherwise write
 * a still several megabytes wide for a detail nobody can see at that size anyway.
 *
 * `frameArgs` scales by `min(width, iw)`, so a smaller source is never enlarged and this is a
 * ceiling rather than a target.
 */
const CAPTURE_WIDTH = 2560;

/**
 * How wide its cover-sized rendering is.
 *
 * The same 640 the cover job produces, and the reason the rendering exists at all: pointing
 * the library's cover straight at a 2560px still would put one on every tile of the grid, and
 * sixty of those is tens of megabytes to draw a page of thumbnails.
 */
const COVER_WIDTH = 640;

/**
 * The frame comes out of the original, never out of what the player is showing.
 *
 * Someone watching an unplayable 4K original is being served a 720p web-safe rendition (§8).
 * A still taken from that would be a downscale of a re-encode — visibly worse than the file
 * sitting on disk, and permanently so, since a capture is never regenerated.
 *
 * The detail row already names the original: its file join is the `original` link, which is
 * the same file the probe read and the same one the cover job sampled.
 */
const originalPath = (row: { rootId: string; relPath: string }): string => {
    const root = mediaRootRepo.findById(row.rootId);

    if (!root) {
        throw new NotFoundError("That library is no longer configured");
    }

    return libraryFilePath(root.path, row.relPath);
};

/**
 * The item, if this viewer may see it.
 *
 * Reported as missing rather than forbidden, so the error cannot confirm that an item exists
 * in a library this account has no access to.
 */
const readable = (mediaId: string, auth: AuthContext) => {
    const row = mediaRepo.findDetail(mediaId, auth.userId, auth.accessibleRootIds);

    if (!row) {
        throw new NotFoundError("Media not found");
    }

    return row;
};

/**
 * A capture and the grid-sized rendering of it, paired by ordinal.
 *
 * Two files and two rows for one thing the viewer made. The capture is the still, at the
 * source's resolution; the rendering is what the grid draws and what `Media.coverArtifactId`
 * points at when this capture is the cover. They share an ordinal so the pairing needs no
 * column: capture *n* is rendered by `cover-n`, and `cover-0` stays the generator's alone.
 */
interface Pairing {
    capture: artifactRepo.ArtifactRow;
    rendering: artifactRepo.ArtifactRow | null;
}

/**
 * The cover-sized rendering of a capture, or null when it has none.
 *
 * The pairing is by ordinal and **ordinal 0 is not part of it**. `cover-0` is the
 * generator's own cover, permanently; a capture at ordinal 0 therefore has no rendering,
 * however much `findOne(mediaId, "cover", 0)` looks like one. Reading that row as a
 * capture's rendering is an aliasing bug with two faces, and both were live:
 *
 * - choosing such a capture pointed `Media.coverArtifactId` at the generated cover, which
 *   `findChosenCover` correctly reads back as *no choice* — so the button did nothing at
 *   all, with no error and nothing on screen to explain it; and
 * - deleting one would have deleted the generated cover's row and its file, destroying
 *   `auto` output from a `user` action, which is the one thing the source split exists to
 *   prevent (§13).
 *
 * `captureFrame` numbers new captures from 1, so nothing should reach ordinal 0 — but that
 * is a guard on one writer, and this is the invariant itself. Rows at ordinal 0 exist from
 * before that guard, and they are what surfaced this.
 */
const renderingFor = (mediaId: string, capture: artifactRepo.ArtifactRow) =>
    capture.ordinal > 0 ? (artifactRepo.findOne(mediaId, "cover", capture.ordinal) ?? null) : null;

/** Where the write may land. Asserted per call, because these are two different trees now. */
const safeWritePath = (config: { dataDir: string }, relPath: string, root: string): string => {
    const absolutePath = path.resolve(config.dataDir, assertSafeRelativePath(relPath));

    // Belt and braces on a path about to be written to: a bug in the naming above must not be
    // able to put a file anywhere but the one directory intended for it (§4).
    if (!absolutePath.startsWith(root + path.sep)) {
        throw new ValidationError("Refusing to write outside the expected directory");
    }

    return absolutePath;
};

const effectiveCoverId = (mediaId: string): string | null =>
    artifactRepo.findEffectiveCover(mediaId)?.id ?? null;

/**
 * The URL of one particular frame, always named with its ordinal.
 *
 * Including it even at zero is what keeps the strip off the `cover` alias, which resolves to
 * whichever frame currently represents the item. Asking for that here would draw the current
 * cover in the slot reserved for the generated one, and show it twice the moment somebody
 * chose a capture.
 */
const frameUrl = (
    mediaId: string,
    artifact: Pick<artifactRepo.ArtifactRow, "kind" | "ordinal" | "relPath" | "generatedAt">
): string =>
    artifactUrl(
        mediaId,
        `${artifact.kind}-${artifact.ordinal}`,
        artifact.relPath,
        artifact.generatedAt
    );

/**
 * Whether this viewer may discard this capture.
 *
 * The person who took it, or an administrator. Captures are the one piece of user work that
 * is **library-wide**: everybody sharing a library sees everybody's frames, which is right --
 * a good still of an item is good for whoever looks at it -- but it means the strip offers a
 * destructive control over somebody else's work to every account that can open the page.
 *
 * Nothing else in the app permits that. Sharing a playlist or a filter grants reading and
 * never writing, administrators included (§6), and a capture is stronger than either: it
 * cannot be regenerated, so there is no version of this mistake that the pipeline repairs.
 *
 * An unattributed capture -- `createdByUserId` is `ON DELETE SET NULL`, so one outlives the
 * account that made it -- is admin-only. Nobody can claim it, and the alternative is that
 * deleting an account quietly hands that person's frames to everyone.
 */
const mayDiscard = (artifact: artifactRepo.ArtifactRow, auth: AuthContext): boolean =>
    mayAlterOwnWork(artifact.createdByUserId, auth);

const toFrame = (
    mediaId: string,
    artifact: artifactRepo.ArtifactRow,
    coverId: string | null,
    auth: AuthContext,
    rendering: artifactRepo.ArtifactRow | null = null
): MediaFrame => ({
    artifactId: artifact.id,
    kind: artifact.kind as MediaFrame["kind"],
    /**
     * What a strip should draw, which for a capture is its rendering rather than itself.
     *
     * A row of 2560px stills scaled down to thumbnails by the browser would download the
     * full library of captures to show a filmstrip. The generated frames are already grid
     * sized, so for them the two URLs are the same picture.
     */
    url: frameUrl(mediaId, rendering ?? artifact),
    /** What the enlarged view opens: the capture at the resolution it was taken. */
    fullUrl: frameUrl(mediaId, artifact),
    atMs: artifact.atMs,
    /**
     * Compared against the *effective* cover, not against `Media.coverArtifactId`.
     *
     * With nothing chosen, the library shows the generated cover — so a strip that marked
     * only an explicit choice would show the current frame as none of them, on every item
     * nobody has ever curated, which is almost all of them.
     *
     * A capture is the cover when its *rendering* is, because that is the row the pointer
     * can name: the grid must not be handed the full-resolution still.
     */
    isCover: (rendering ?? artifact).id === coverId,
    /**
     * A generated frame is always its own rendering, so it is always choosable. A capture is
     * choosable only when the rendering the column would name actually exists.
     */
    coverable: artifact.kind !== "capture" || rendering !== null,
    /** Your own capture, or anybody's if you administer the library. See `mayDiscard`. */
    discardable: artifact.kind === "capture" && mayDiscard(artifact, auth),
    label: artifact.kind === "capture" ? artifact.label : null,
    source: artifact.source,
    createdAt: artifact.generatedAt,
});

/**
 * Every frame that could represent this item, and the renderings that pair with them.
 *
 * `cover` at ordinal 0 is the generated one and is a frame in its own right; `cover` above
 * zero is the rendering of the capture with the same ordinal and is never shown as a choice
 * of its own — offering somebody the same picture twice, once large and once small, is a
 * menu with a duplicate in it.
 */
const pairings = (
    mediaId: string
): { frames: Pairing[]; renderings: Map<number, artifactRepo.ArtifactRow> } => {
    const artifacts = artifactRepo.listForMedia(mediaId, ["cover", "poster", "capture"]);

    const renderings = new Map(
        artifacts
            .filter((artifact) => artifact.kind === "cover" && artifact.ordinal > 0)
            .map((artifact) => [artifact.ordinal, artifact])
    );

    const rank: Record<string, number> = { cover: 0, poster: 1, capture: 2 };

    /**
     * Where a frame sits in the video, for anything with a position.
     *
     * Frames without one sort to the end: a still image's downscaled copy has no moment to
     * be in, and there is no ordering among things that are all nowhere.
     */
    const at = (artifact: artifactRepo.ArtifactRow) => artifact.atMs ?? Number.POSITIVE_INFINITY;

    const frames = artifacts
        .filter((artifact) => !(artifact.kind === "cover" && artifact.ordinal > 0))
        .sort(
            (left, right) =>
                at(left) - at(right) ||
                (rank[left.kind] ?? 3) - (rank[right.kind] ?? 3) ||
                left.ordinal - right.ordinal
        )
        .map((artifact) => ({
            capture: artifact,
            // `renderings` is keyed on ordinals above zero only, which is the same rule
            // `renderingFor` applies — a capture at ordinal 0 simply misses.
            rendering:
                artifact.kind === "capture" ? (renderings.get(artifact.ordinal) ?? null) : null,
        }));

    return { frames, renderings };
};

/**
 * Every frame that could represent this item, in the order a strip should show them.
 *
 * **Along the video, not along the history of the strip.** These are pictures of one thing
 * that happened in a fixed order, and that order is the only one a viewer can reason about:
 * scanning left to right is scanning forward through the clip, and a frame stays where it
 * was however many more get taken around it. Sorting by when each was *made* instead puts a
 * still from the closing shot next to one from the opening titles because somebody happened
 * to grab them in that order, and moves everything along by one on the next capture.
 *
 * The strip draws captures and generated frames as separate rows, so each row is in video
 * order and the sort here is what both of them inherit.
 */
export const listFrames = (mediaId: string, auth: AuthContext): MediaFrame[] => {
    const coverId = effectiveCoverId(mediaId);

    return pairings(mediaId).frames.map((pair) =>
        toFrame(mediaId, pair.capture, coverId, auth, pair.rendering)
    );
};

/**
 * Pull one frame out of the original and keep it.
 *
 * The row is written only after ffmpeg has produced bytes, so an artifact row never names a
 * file that is not there. A failed extraction leaves at worst a file nothing points at, which
 * is invisible and is swept up with the other orphans.
 *
 * **The first capture becomes the cover; later ones do not.** Capturing a frame for an item
 * that has never had one is almost always someone fixing a bad thumbnail, and making them
 * open a panel and click the picture they just made is a second step with no decision in it.
 * Once there is more than one candidate there *is* a decision, and it stays manual — nothing
 * after the first silently changes what the library shows.
 *
 * Two conditions, not one. "No cover has been chosen" alone would re-promote a capture after
 * someone had deliberately gone back to the generated cover, which is the one case where the
 * automatic behaviour would be overriding an explicit choice rather than standing in for a
 * missing one.
 */
export const captureFrame = async (
    mediaId: string,
    atMs: number,
    auth: AuthContext
): Promise<MediaFrame> => {
    return inFrameSlot(() => extractCapture(mediaId, atMs, auth));
};

const extractCapture = async (
    mediaId: string,
    atMs: number,
    auth: AuthContext
): Promise<MediaFrame> => {
    const row = readable(mediaId, auth);

    if (row.kind !== "video") {
        throw new ValidationError("Only a video has frames to capture");
    }

    // Both read before anything is written, so the answer describes the item as it was when
    // the button was pressed rather than as this call is about to leave it.
    const firstCapture = artifactRepo.listForMedia(mediaId, ["capture"]).length === 0;
    const alreadyChosen = artifactRepo.findChosenCover(mediaId) !== null;

    const input = originalPath(row);
    const config = loadConfig();

    /**
     * Capture ordinals start at 1, so that a capture and its rendering can share one.
     *
     * `cover-0` is the generator's, permanently. Numbering captures from 1 means capture *n*
     * is rendered by `cover-n` with nothing to translate between them and no chance of the
     * first capture's rendering landing on top of the generated cover.
     */
    const ordinal = Math.max(1, artifactRepo.nextOrdinal(mediaId, "capture"));
    const relPath = artifactRelPath(mediaId, "capture", ordinal);
    const absolutePath = safeWritePath(config, relPath, dataPaths(config).captures);
    const coverRelPath = artifactRelPath(mediaId, "cover", ordinal);
    const coverPath = safeWritePath(config, coverRelPath, dataPaths(config).art);

    await mkdir(path.dirname(absolutePath), { recursive: true });

    const ffmpeg = await resolveFfmpeg();

    try {
        await execFileAsync(
            ffmpeg,
            frameArgs(input, absolutePath, {
                atMs,
                width: CAPTURE_WIDTH,
                // Someone who paused on a frame means *that* frame. The `thumbnail` filter
                // is what makes an automatic cover step over fades and title cards, and here
                // it would quietly save a different moment from the one on screen.
                representative: false,
            }),
            { timeout: FRAME_TIMEOUT_MS, maxBuffer: 1024 * 1024 }
        );
    } catch {
        throw new ValidationError("Could not read a frame at that position");
    }

    const written = await stat(absolutePath).catch(() => null);

    if (!written || written.size === 0) {
        // Seeking past the end produces no frame and no error. Removing the empty file keeps
        // the artifacts directory free of things no row will ever name.
        await rm(absolutePath, { force: true });

        throw new ValidationError("There is no frame at that position");
    }

    /**
     * The grid-sized rendering, downscaled from the capture rather than seeked for again.
     *
     * The still is already on disk and is the exact frame wanted, so a second seek into the
     * original would cost the decode again and could — on a variable frame rate source —
     * land somewhere marginally different, leaving a cover that is not the picture the strip
     * shows.
     */
    await mkdir(path.dirname(coverPath), { recursive: true });

    const rendering = await execFileAsync(
        ffmpeg,
        frameArgs(absolutePath, coverPath, { width: COVER_WIDTH }),
        { timeout: FRAME_TIMEOUT_MS, maxBuffer: 1024 * 1024 }
    )
        .then(() => stat(coverPath))
        .catch(() => null);

    const artifact = artifactRepo.upsert({
        mediaId,
        kind: "capture",
        ordinal,
        relPath,
        bytes: written.size,
        width: row.width,
        atMs: Math.floor(atMs),
        // Never touched by a regeneration or a cleanup sweep. This is the flag that whole
        // distinction rests on (§13).
        source: "user",
        createdByUserId: auth.userId,
    });

    /**
     * The rendering is a row of its own, so the cover can point at it.
     *
     * Written after the capture and allowed to be missing: a still whose rendering failed is
     * still the viewer's still, and the only thing it cannot then be is the cover — which is
     * a far better outcome than refusing the capture.
     */
    const cover = rendering
        ? artifactRepo.upsert({
              mediaId,
              kind: "cover",
              ordinal,
              relPath: coverRelPath,
              bytes: rendering.size,
              width: COVER_WIDTH,
              atMs: Math.floor(atMs),
              source: "user",
              createdByUserId: auth.userId,
          })
        : null;

    if (firstCapture && !alreadyChosen && cover) {
        artifactRepo.setCoverArtifact(mediaId, cover.id);
    }

    return toFrame(mediaId, artifact, effectiveCoverId(mediaId), auth, cover);
};

/**
 * Point the item at one of its frames, or back at the generated one.
 *
 * The artifact must belong to this item and must be image-like. Without the first check a
 * cover could be pointed at another item's file, which is a small but genuine way to serve
 * bytes from a library the viewer cannot otherwise reach.
 */
export const setCover = (
    mediaId: string,
    artifactId: string | null,
    auth: AuthContext
): MediaFrame[] => {
    readable(mediaId, auth);

    let pointer = artifactId;

    if (artifactId !== null) {
        const artifact = artifactRepo.findById(artifactId);

        if (!artifact || artifact.mediaId !== mediaId) {
            throw new NotFoundError("That frame does not belong to this item");
        }

        if (!["cover", "poster", "capture"].includes(artifact.kind)) {
            throw new ValidationError("That artifact is not a frame");
        }

        /**
         * Choosing the generated cover means *not* choosing, and is stored as such.
         *
         * Pointing the column at the ordinal-0 cover looks harmless — it resolves to the same
         * picture — and is not. "A cover was chosen" is a real question elsewhere: it is what
         * stops a first capture being promoted over somebody's curation (§13). Stored as an
         * explicit choice, clicking the generated frame in the strip would silently disable
         * that promotion for the life of the item, with nothing on screen to show why.
         */
        if (artifact.kind === "cover" && artifact.ordinal === 0) {
            pointer = null;
        }

        /**
         * A capture is chosen by name and stored by its rendering.
         *
         * The strip offers the still, because that is the picture somebody is looking at.
         * The column has to name the grid-sized copy instead, or every tile in the library
         * would be handed a 2560px image. A capture whose rendering never got written cannot
         * be the cover at all, and says so rather than silently doing nothing.
         */
        if (artifact.kind === "capture") {
            const rendering = renderingFor(mediaId, artifact);

            if (!rendering) {
                throw new ValidationError(
                    "That frame has no cover-sized copy, so it cannot be the cover"
                );
            }

            pointer = rendering.id;
        }
    }

    artifactRepo.setCoverArtifact(mediaId, pointer);

    return listFrames(mediaId, auth);
};

/**
 * Delete a capture.
 *
 * Only a capture: the generated cover and its alternates are the generator's output and
 * removing one would simply invite it back on the next sweep. If the deleted frame was the
 * cover, the item falls back to the generated one — `Media.coverArtifactId` is declared
 * `ON DELETE SET NULL` precisely so that this needs no code here.
 *
 * And only your own, unless you administer the library. See `mayDiscard`.
 */
export const deleteCapture = async (
    mediaId: string,
    artifactId: string,
    auth: AuthContext
): Promise<MediaFrame[]> => {
    const row = readable(mediaId, auth);

    const artifact = artifactRepo.findById(artifactId);

    if (!artifact || artifact.mediaId !== mediaId) {
        throw new NotFoundError("That frame does not belong to this item");
    }

    if (artifact.kind !== "capture") {
        throw new ValidationError("Only a captured frame can be deleted");
    }

    if (!mayDiscard(artifact, auth)) {
        // Forbidden rather than not-found: the frame is on screen in front of them, so
        // there is nothing to conceal and "it is not yours" is the useful answer.
        throw new AuthorizationError("That frame was captured by somebody else");
    }

    await discardOne(artifact, row.rootId);

    return listFrames(mediaId, auth);
};

/**
 * Remove a capture and its rendering: both rows, then both files.
 *
 * **Rows first.** A row without its file renders as a broken image, while a file without its
 * row is invisible and is swept up with the other orphans — so the only safe interruption is
 * one that leaves files behind. This used to delete the files first, above a comment arguing
 * for the opposite order.
 *
 * The rendering goes with the capture. It exists only to draw this capture in a grid, so
 * leaving it behind would keep a file and a row describing a picture that no longer exists —
 * and, if it happened to be the cover, would leave the library showing a still the viewer had
 * just deleted.
 *
 * **If it was the cover, every open library hears about it.** `Media.coverArtifactId` is
 * `ON DELETE SET NULL`, so the item itself falls back to the generated cover with nothing to do
 * here — but every tile already on screen, in this session's shelves and playlists and in
 * everybody else's grid, still names the old picture. The change feed is how those learn,
 * and it has to say which of two things happened: another cover took over, or there is none
 * left to show, because pointing a tile at the cover alias when nothing is behind it draws a
 * broken image.
 */
const discardOne = async (
    capture: artifactRepo.ArtifactRow,
    rootId: string | null
): Promise<void> => {
    const rendering = renderingFor(capture.mediaId, capture);
    const config = loadConfig();
    const roots = dataPaths(config);
    const wasCover =
        rendering !== null && artifactRepo.findChosenCover(capture.mediaId) === rendering.id;

    if (rendering) {
        artifactRepo.remove(rendering.id);
    }

    artifactRepo.remove(capture.id);

    if (wasCover) {
        artifactRepo.recordArtifactChange(
            capture.mediaId,
            rootId,
            artifactRepo.findEffectiveCover(capture.mediaId) ? "cover" : COVER_CLEARED_CHANGE
        );
    }

    for (const [row, root] of [
        [capture, roots.captures],
        ...(rendering ? [[rendering, roots.art] as const] : []),
    ] as const) {
        const absolutePath = path.resolve(config.dataDir, assertSafeRelativePath(row.relPath));

        if (absolutePath.startsWith(root + path.sep)) {
            await rm(absolutePath, { force: true });
        }
    }
};

/**
 * This viewer's own captures, a page at a time (§9 "Your captures, in one place").
 *
 * Only their own, although captures are library-wide to read: the page answers "what have I
 * grabbed", and everybody's remain on each item's strip. The user comes from the session and
 * never from the query, so there is no parameter by which to ask for somebody else's.
 */
export const listCaptures = (query: CaptureQuery, auth: AuthContext): CaptureListResponse => {
    const direction = query.direction ?? captureNaturalDirection(query.sort);
    const scope = { userId: auth.userId, accessibleRootIds: auth.accessibleRootIds };
    const rows = artifactRepo.searchCaptures(query, scope, direction);
    const total = artifactRepo.countCaptures(query, scope);

    const items = rows.map((row): Capture => ({
        artifactId: row.id,
        kind: "capture",
        // The grid-sized rendering when there is one, as the strip draws it.
        url: frameUrl(
            row.mediaId,
            row.renderingRelPath !== null && row.renderingGeneratedAt !== null
                ? {
                      kind: "cover",
                      ordinal: row.ordinal,
                      relPath: row.renderingRelPath,
                      generatedAt: row.renderingGeneratedAt,
                  }
                : row
        ),
        fullUrl: frameUrl(row.mediaId, row),
        atMs: row.atMs,
        isCover: row.isCover === 1,
        coverable: row.renderingId !== null,
        discardable: mayDiscard(row, auth),
        label: row.label,
        source: row.source,
        createdAt: row.generatedAt,
        mediaId: row.mediaId,
        mediaTitle: row.mediaTitle ?? "Untitled",
    }));

    return {
        items,
        page: query.page,
        pageSize: query.limit,
        // From the total rather than from a full page, which is wrong at exact multiples.
        hasMore: (query.page + 1) * query.limit < total,
        total,
    };
};

/**
 * Write or clear a capture's caption.
 *
 * The same rule as discarding it: the person who took it, or an administrator (`mayDiscard`).
 * The caption is shown to everybody who can see the item, as the capture is, so letting
 * anyone else write it would be letting them put words under somebody else's still.
 */
export const renameCapture = (
    mediaId: string,
    artifactId: string,
    label: string | null,
    auth: AuthContext
): MediaFrame => {
    readable(mediaId, auth);

    const artifact = artifactRepo.findById(artifactId);

    if (!artifact || artifact.mediaId !== mediaId) {
        throw new NotFoundError("That frame does not belong to this item");
    }

    if (artifact.kind !== "capture") {
        throw new ValidationError("Only a captured frame has a caption");
    }

    if (!mayDiscard(artifact, auth)) {
        throw new AuthorizationError("That frame was captured by somebody else");
    }

    const next = label === null || label === "" ? null : label;

    artifactRepo.setLabel(artifactId, next);

    return toFrame(
        mediaId,
        { ...artifact, label: next },
        effectiveCoverId(mediaId),
        auth,
        renderingFor(mediaId, artifact)
    );
};

/**
 * Discard several captures at once, from the Captures page.
 *
 * Per capture rather than all-or-nothing: a selection is held across pages and can go stale
 * while it is — a capture discarded from its item's strip, an item moved to the trash — and one
 * stale id must not refuse the rest. Each is checked exactly as a single discard is, and an
 * item this viewer can no longer see reports its captures as not found.
 */
export const discardCaptures = async (
    artifactIds: string[],
    auth: AuthContext
): Promise<DiscardCapturesResult> => {
    const failed: DiscardCapturesResult["failed"] = [];
    let succeeded = 0;

    for (const artifactId of new Set(artifactIds)) {
        const artifact = artifactRepo.findById(artifactId);

        if (!artifact || artifact.kind !== "capture") {
            failed.push({ artifactId, reason: "Not found" });
            continue;
        }

        let rootId: string | null;

        try {
            rootId = readable(artifact.mediaId, auth).rootId;
        } catch {
            failed.push({ artifactId, reason: "Not found" });
            continue;
        }

        if (!mayDiscard(artifact, auth)) {
            failed.push({ artifactId, reason: "Captured by somebody else" });
            continue;
        }

        await discardOne(artifact, rootId);
        succeeded += 1;
    }

    return { succeeded, failed };
};
