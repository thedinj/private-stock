import { statSync, type Stats } from "node:fs";
import * as path from "node:path";

import {
    ConflictError,
    NotFoundError,
    PROGRESS_STAGE_NAMES,
    findStage,
    stageApplies,
    prerequisiteOf,
    prerequisiteSettled,
    sweepIncludes,
    WEBSAFE_PROFILE,
    assertSafeRelativePath,
    assessPlayback,
    describeBlocker,
    titleFromPath,
    withSortOverride,
    type MediaDetail,
    type MediaIdsResponse,
    type LookMoment,
    type MediaListItem,
    type MediaListResponse,
    type MediaLookupResponse,
    type MediaQuery,
    type ProvenanceEntry,
} from "@private-stock/core";
import { dataPaths, loadConfig } from "@private-stock/core/server";
import {
    db,
    dupeRepo,
    jobRepo,
    mediaAttributeRepo,
    mediaRepo,
    mediaRootRepo,
    mediaTextRepo,
    read,
    reelRepo,
    runNow,
    runOffThread,
    stageRepo,
    tagRepo,
    type mediaRepo as MediaRepoTypes,
    type ReadPlan,
    variantRepo,
} from "@private-stock/db";

import type { AuthContext } from "../auth/withAuth";
import { artifactUrl, coverUrl } from "./artService";
import { loadAdminSettings } from "./settingsService";
import { listFrames } from "./frameService";
import { listClipsFor } from "./clipService";
import { duplicateStanding } from "./keepAdvice";
import { toMediaTags } from "./tagService";
import { countOfOrder, keepsOrder, keptOrder, pageOfOrder } from "./keptOrders";
import { spriteThumbFor } from "./spriteThumb";

/**
 * Library reads. Authorization lives here; the routes only speak HTTP.
 */

type ListRow = MediaRepoTypes.MediaListRow;

/** What the playback verdict reads -- on every list row, so a tile can carry it (§8b). */
type PlaybackRow = Pick<
    ListRow,
    | "kind"
    | "relPath"
    | "container"
    | "codec"
    | "videoProfile"
    | "pixFmt"
    | "audioCodec"
    | "probedAt"
    | "websafePath"
>;

/**
 * The grid's view of a row.
 *
 * Exported because a list is not always a query: playlists and shelves decide membership
 * elsewhere and still have to render the same tile, and a second mapping would be a second
 * place for the cover URL's version token to be got wrong.
 */
/**
 * How many tag names a tile carries before it gives up and counts.
 *
 * Two, then `+3`. A fixed number rather than "as many as fit": a tile whose height depends
 * on its content makes a five-column grid ragged, and the grid's regularity is most of what
 * makes it readable at a glance (§14b).
 */
export const TILE_TAGS = 2;

export const toListItem = (row: ListRow, allTags: TileTag[] = []): MediaListItem => {
    const performers = allTags.filter((tag) => tag.kind === "performer").map((tag) => tag.name);
    const tags = allTags.filter((tag) => tag.kind !== "performer");

    return {
        id: row.id,
        kind: row.kind,
        // Fall back to the filename so an unprobed item is still identifiable in the grid
        // rather than appearing as a blank tile.
        title: row.title ?? (row.relPath ? titleFromPath(row.relPath) : "Untitled"),
        durationMs: row.durationMs,
        width: row.width,
        height: row.height,
        addedAt: row.addedAt,
        capturedAt: row.capturedAt,
        sizeBytes: row.sizeBytes,
        coverUrl: coverUrl(row.id, row.coverPath, row.coverGeneratedAt),
        previewUrl: row.previewPath
            ? artifactUrl(row.id, "preview", row.previewPath, row.previewGeneratedAt)
            : null,
        rating: row.rating,
        favorite: row.favorite === 1,
        watchedAt: row.watchedAt,
        // Sliced here rather than by the client: shipping forty names to draw two of them is
        // forty names of payload per tile, sixty times a page.
        tags: tags.slice(0, TILE_TAGS),
        tagCount: tags.length,
        // The byline (§14b): split out so a tile with five keywords still names its people.
        performers: performers.slice(0, TILE_TAGS),
        performerCount: performers.length,
        probed: row.probedAt !== null,
        directPlay: resolvePlaybackPlan(row).directPlay,
    };
};

type TileTag = { name: string; kind: string };

/**
 * A page of rows with their tags attached, which is what every grid caller wants.
 *
 * The tags are one query for the page rather than one per tile, which is the difference between
 * an indexed lookup and sixty round trips on the hottest screen in the app (§20).
 */
function* listPage(rows: ListRow[], userId: string): ReadPlan<MediaListItem[]> {
    const byMedia = new Map<string, TileTag[]>();
    const tagRows = yield* read(
        "tagsForMediaIds",
        rows.map((row) => row.id),
        userId
    );

    for (const row of tagRows) {
        const existing = byMedia.get(row.mediaId);

        if (existing) existing.push({ name: row.name, kind: row.kind });
        else byMedia.set(row.mediaId, [{ name: row.name, kind: row.kind }]);
    }

    return rows.map((row) => toListItem(row, byMedia.get(row.id) ?? []));
}

/** `listPage`, here and now, for the callers that hydrate inside a snapshot of their own. */
export const toListPage = (rows: ListRow[], userId: string): MediaListItem[] =>
    runNow(listPage(rows, userId));

/**
 * One page of the library.
 *
 * `overlayUserId` names whose ratings the query's rating predicates ask about, and is only
 * ever supplied by `savedFilterService` for a shared filter whose owner chose that (§6).
 * Access and hidden items are always the viewer's regardless, and so are the ratings shown on
 * each tile — the overlay decides what is *asked*, never what is displayed.
 */
/**
 * The items on screen, as they stand now (§13b).
 *
 * `listByIds` applies every rule the grid does -- listable, accessible, not hidden -- so an
 * id missing from the answer is exactly an item the grid should no longer show.
 */
export const lookupMedia = (ids: string[], auth: AuthContext): MediaLookupResponse => ({
    items: toListPage(mediaRepo.listByIds(ids, auth.userId, auth.accessibleRootIds), auth.userId),
});

/**
 * A look's moments with a picture of each: the sprite tile nearest it (§5e).
 *
 * Arithmetic over the item's sprite rows, as a clip's face is (`spriteThumbFor`), so a page of
 * them costs sixty indexed lookups and no ffmpeg.
 */
const withMomentThumbs = (moments: Record<string, number>): Record<string, LookMoment> =>
    Object.fromEntries(
        Object.entries(moments).map(([mediaId, atMs]) => {
            const thumb = spriteThumbFor(mediaId, atMs);

            return [
                mediaId,
                { atMs, thumbUrl: thumb?.url ?? null, thumbRect: thumb?.rect ?? null },
            ];
        })
    );

/**
 * A page or a count, read under one deferred transaction (§20), as `getHome` reads its shelves.
 *
 * Each is several statements -- the hidden ids, a tag's names, how many documents a mentions
 * filter matches, the walk, the hydration -- and outside a transaction each starts from a cache
 * the worker's last commit emptied, so the search index pages the match count read were read
 * again by the walk straight after. Deferred, never the web default `IMMEDIATE`: a read must
 * not take the write lock. Nested in a caller's transaction it is a savepoint and changes nothing.
 */
const inOneSnapshot = <T>(read: () => T): T => db.transaction(read).deferred();

/**
 * One page of the grid, as tiles.
 *
 * Run as the server runs every list (`withSortOverride`): a "find untagged" filter by date added
 * whatever sort it carries. `walking` says the caller pages or steps through the list -- the
 * grid, its count, the viewer -- which is what makes keeping an untagged list's order worth its
 * walk (`keepsOrder`); a shuffle's order is kept for every caller.
 */
function* listMediaReads(
    asked: MediaQuery,
    auth: AuthContext,
    overlayUserId?: string,
    walking = false
): ReadPlan<MediaListResponse> {
    const query = withSortOverride(asked);
    const order = keepsOrder(query, walking) ? yield* keptOrder(query, auth, overlayUserId) : null;
    let result: MediaRepoTypes.ListResult & { moments?: Record<string, number> };

    if (order === null) {
        result = yield* read(
            "listMedia",
            query,
            auth.userId,
            auth.accessibleRootIds,
            overlayUserId
        );
    } else {
        // Hydrated by id, which re-applies listable, access and hidden on its own; the filter
        // itself was checked for the slice by `pageOfOrder`.
        const { ids, hasMore, moments } = yield* pageOfOrder(order, query, auth, overlayUserId);

        result = {
            rows: yield* read("listByIds", ids, auth.userId, auth.accessibleRootIds),
            page: query.page,
            pageSize: query.limit,
            hasMore,
            moments,
        };
    }

    return {
        items: yield* listPage(result.rows, auth.userId),
        page: result.page,
        pageSize: result.pageSize,
        hasMore: result.hasMore,
        ...(result.moments && { moments: withMomentThumbs(result.moments) }),
        // Never counted here (§20). The count is a scan of the whole matching set and the
        // page is an indexed walk; folding one into the other would make every page turn
        // pay for a number that only changes when the filter does.
        total: null,
    };
}

export const listMedia = (
    asked: MediaQuery,
    auth: AuthContext,
    overlayUserId?: string,
    walking = false
): MediaListResponse =>
    inOneSnapshot(() => runNow(listMediaReads(asked, auth, overlayUserId, walking)));

/** `listMedia` with its statements on a reader thread, for a route (§20 "Reads off the thread"). */
export const listMediaOffThread = (
    asked: MediaQuery,
    auth: AuthContext,
    overlayUserId?: string,
    walking = false
): Promise<MediaListResponse> => runOffThread(listMediaReads(asked, auth, overlayUserId, walking));

/**
 * One page of the library as ids alone, for the viewer walking the set (§14b, §20).
 *
 * The same query, paging and `overlayUserId` as `listMedia`, so the ids are that page's ids in
 * that page's order; only the hydration is left out. One snapshot for the same reason, and the
 * same kept order for a shuffle or an untagged list, so the grid and the viewer walking out of
 * it agree slot for slot.
 */
function* listMediaIdsPageReads(
    asked: MediaQuery,
    auth: AuthContext,
    overlayUserId?: string,
    walking = false
): ReadPlan<MediaIdsResponse> {
    const query = withSortOverride(asked);
    const order = keepsOrder(query, walking) ? yield* keptOrder(query, auth, overlayUserId) : null;

    if (order === null) {
        return yield* read(
            "listMediaIdsPage",
            query,
            auth.userId,
            auth.accessibleRootIds,
            overlayUserId
        );
    }

    return {
        ...(yield* pageOfOrder(order, query, auth, overlayUserId)),
        page: query.page,
        pageSize: query.limit,
    };
}

export const listMediaIdsPage = (
    asked: MediaQuery,
    auth: AuthContext,
    overlayUserId?: string,
    walking = false
): MediaIdsResponse =>
    inOneSnapshot(() => runNow(listMediaIdsPageReads(asked, auth, overlayUserId, walking)));

/** `listMediaIdsPage` with its statements on a reader thread, for a route. */
export const listMediaIdsPageOffThread = (
    asked: MediaQuery,
    auth: AuthContext,
    overlayUserId?: string,
    walking = false
): Promise<MediaIdsResponse> =>
    runOffThread(listMediaIdsPageReads(asked, auth, overlayUserId, walking));

/**
 * How many items match, and how many pages that is.
 *
 * Its own call, so the client can cache it against the filter and leave it alone while
 * paging. Shuffled or not, the same number: a shuffle is an ordering of the matching set
 * like any other sort (§20). A list served from a kept order is counted from it -- the walk
 * that took the order is the walk a count would have been.
 *
 * `overlayUserId` must be whatever the page was listed with, or the count describes a
 * different set from the one on screen.
 */
function* countMediaReads(
    asked: MediaQuery,
    auth: AuthContext,
    overlayUserId?: string,
    walking = false
): ReadPlan<{ total: number; pageCount: number }> {
    const query = withSortOverride(asked);
    const order = keepsOrder(query, walking) ? yield* keptOrder(query, auth, overlayUserId) : null;

    if (order !== null) {
        return countOfOrder(order, query);
    }

    const total = yield* read(
        "countMedia",
        query,
        auth.userId,
        auth.accessibleRootIds,
        overlayUserId
    );

    return { total, pageCount: Math.max(1, Math.ceil(total / query.limit)) };
}

export const countMedia = (
    asked: MediaQuery,
    auth: AuthContext,
    overlayUserId?: string,
    walking = false
): { total: number; pageCount: number } =>
    inOneSnapshot(() => runNow(countMediaReads(asked, auth, overlayUserId, walking)));

/** `countMedia` with its statements on a reader thread, for a route. */
export const countMediaOffThread = (
    asked: MediaQuery,
    auth: AuthContext,
    overlayUserId?: string,
    walking = false
): Promise<{ total: number; pageCount: number }> =>
    runOffThread(countMediaReads(asked, auth, overlayUserId, walking));

/**
 * What the player will actually receive for this item (§8).
 *
 * The verdict itself lives in `@private-stock/core` so the worker and the web app cannot
 * disagree about it - the worker uses it to decide what to enqueue, and this uses it to
 * decide what to serve. All that happens here is choosing between the original, a playlist of
 * byte ranges of it (`segments`, for MPEG-TS), and a finished rendition.
 */
export const resolvePlaybackPlan = (
    row: PlaybackRow
): { source: MediaDetail["playbackSource"]; blockers: string[]; directPlay: boolean } => {
    const assessment = assessPlayback({
        kind: row.kind,
        // ffprobe cannot tell MKV from WebM; the filename can.
        relPath: row.relPath,
        container: row.container,
        codec: row.codec,
        videoProfile: row.videoProfile,
        pixFmt: row.pixFmt,
        audioCodec: row.audioCodec,
        probedAt: row.probedAt,
    });

    if (assessment.directPlay) {
        return {
            source: assessment.via === "segments" ? "segments" : "original",
            blockers: [],
            directPlay: true,
        };
    }

    const blockers = assessment.blockers.map(describeBlocker);

    // A ready variant makes this direct play again, which is the entire point of producing
    // one in the background rather than transcoding on demand.
    if (row.websafePath) {
        return { source: "variant", blockers, directPlay: true };
    }

    return { source: "pending", blockers, directPlay: false };
};

export const getMediaDetail = (mediaId: string, auth: AuthContext): MediaDetail => {
    const row = mediaRepo.findDetail(mediaId, auth.userId, auth.accessibleRootIds);

    if (!row) {
        // Deliberately identical to "does not exist": a user without access to a root must
        // not be able to discover that an item is there.
        throw new NotFoundError("Media not found");
    }

    const plan = resolvePlaybackPlan(row);

    /**
     * An item whose rendition was reclaimed asks for it back when somebody opens it (§8).
     *
     * This is the other half of retention. The hourly sweep deletes renditions nobody has
     * watched, and the five-minute backfill is told to leave those alone — so opening the
     * item is the only thing left that can bring one back, and this is where opening it
     * happens.
     *
     * A write on a read path, which is unusual here and is the point: the request *is* the
     * demand. It is narrow on purpose — only for an item that has a variant row carrying
     * `evictedAt`, meaning this file encoded successfully at least once before. A file that
     * has never managed it has no row, so a permanently unencodable item cannot be made to
     * retry on every page open.
     */
    if (plan.source === "pending" && variantRepo.wasEvicted(mediaId, WEBSAFE_PROFILE)) {
        jobRepo.enqueueTranscode(mediaId);
    }

    return {
        ...toListItem(row),
        codec: row.codec,
        container: row.container,
        bitrate: row.bitrate,
        fps: row.fps,
        relPath: row.relPath,
        rootLabel: row.rootLabel,
        deletable: row.rootWritable === 1,
        playbackSource: plan.source,
        playbackBlockers: plan.blockers,
        spriteVttUrl: row.spriteVttPath
            ? artifactUrl(row.id, "spriteVtt", row.spriteVttPath, row.spriteVttGeneratedAt)
            : null,
        tags: toMediaTags(tagRepo.listForMedia(mediaId, auth.userId), auth),
        // Every frame that could represent this item, the current one marked (§13). Carried
        // on the detail rather than fetched separately, so the strip is there when the panel
        // holding it opens.
        frames: listFrames(mediaId, auth),
        clips: listClipsFor(mediaId, auth),
        hidden: row.hidden === 1,
        // This viewer's own, straight off the overlay join -- never the shared filter
        // owner's, even when the list that led here was resolved as somebody else (§6).
        note: row.note,
        provenance: provenanceFor(mediaId, row.probedAt, row.kind),
        // One indexed lookup that returns nothing for the overwhelming majority of items,
        // and the only thing standing between somebody and deleting the better copy (§10c).
        duplicate: duplicateStanding(
            mediaId,
            dupeRepo.activeCopies(mediaId),
            reelRepo.clipsAtRiskFor(mediaId, auth.userId)
        ),
        // Findings are stored strongest-first and are shown that way: the reader is judging
        // whether recognition worked, and the strongest finding is the one that answers it.
        //
        // Dismissed findings reach administrators only: they are the ones who can restore one
        // dismissed by mistake, and everybody else should see what review left behind (§5d).
        text: mediaTextRepo
            .listForMedia(mediaId, { includeDismissed: auth.scopes.includes("admin") })
            .map((finding) => ({
                id: finding.id,
                text: finding.text,
                confidence: finding.confidence,
                occurrences: finding.occurrences,
                stability: finding.stability,
                // Null for a still, which has no moment to jump to -- carried as null all the
                // way from the column rather than reconstructed from the item's kind here.
                firstAtMs: finding.firstAtMs,
                reviewState: finding.reviewState,
                originalText: finding.originalText,
            })),
        attributes: mediaAttributeRepo.listForMedia(mediaId),
    };
};

/**
 * What has been done to this item, in the order the pipeline does it.
 *
 * Driven by the registry rather than by the rows, so a stage that has never run still appears
 * -- as `pending`, which is the difference between "we have not got to the sprite sheet yet"
 * and "there is no such thing as a sprite sheet". Reading only the stored rows would silently
 * shorten the list as it got further from finished, which is precisely backwards.
 *
 * Probing is a registry stage like the rest, so a probe that failed shows its reason here and
 * can be asked for again. `PROGRESS_STAGE_NAMES` is the order for both this and the admin
 * page, so the two views cannot disagree about it.
 */
/**
 * What has been done to this item, and what can be asked for (§7b).
 *
 * Every registered stage appears, so a capability that has never run on this item is visible
 * as pending rather than absent — which is what makes a stage nobody sweeps requestable at
 * all. A stage that cannot apply to this kind of media reads as `skipped` rather than
 * pending, because that is what it is: a sprite sheet of a photograph is not outstanding
 * work, and showing it as pending leaves a photo permanently looking half-processed.
 */
const provenanceFor = (
    mediaId: string,
    probedAt: string | null,
    kind: "image" | "video"
): ProvenanceEntry[] => {
    const rows = new Map(stageRepo.listForMedia(mediaId).map((row) => [row.stage, row]));

    /**
     * Read here rather than in the panel, which is the point of shipping an answer instead
     * of a mode (§7b): whether an `optIn` stage is coming depends on a setting, and the
     * drawer has no business holding a second copy of that rule.
     */
    const policy = loadAdminSettings().stagePolicy;

    // Every stage's name is also its job kind, `probe` included, so the queue can be asked
    // about the whole ledger at once.
    const live = new Map(
        jobRepo
            .liveForMedia(mediaId, PROGRESS_STAGE_NAMES)
            .map((job) => [job.kind, job.state === "claimed" ? "running" : "queued"] as const)
    );

    return PROGRESS_STAGE_NAMES.map((stage): ProvenanceEntry => {
        const inFlight = live.get(stage) ?? null;
        const definition = findStage(stage);
        const applies = definition ? stageApplies(definition, kind) : false;
        const row = rows.get(stage);

        return {
            stage,
            state: applies ? (row?.state ?? "pending") : "skipped",
            at: row?.at ?? null,
            detail: row?.detail ?? null,
            // A stage that waits on the probe is refused until it has run (`needsProbe`), so
            // it is not offered: the probe is the thing to ask for.
            runnable:
                applies &&
                (!definition?.needsProbe || probedAt !== null) &&
                // Likewise a stage whose prerequisite has not settled (`requires`).
                (!definition ||
                    prerequisiteSettled(
                        definition,
                        kind,
                        rows.get(prerequisiteOf(definition, kind)?.name ?? "") ?? null
                    )),
            sweeps: definition ? sweepIncludes(definition, policy) : false,
            inFlight,
        };
    });
};

export interface ResolvedFile {
    absolutePath: string;
    sizeBytes: number;
    /** For the stream route's validators — the same `(size, mtime)` identity the scanner uses. */
    mtimeMs: number;
    relPath: string;
    kind: "image" | "video";
    container: string | null;
    /** Whether these bytes are the web-safe rendition rather than the original. */
    isVariant: boolean;
    /**
     * Whether a browser should be given a playlist of byte ranges of this file instead of the
     * file (§8, MPEG-TS). The stream route answers with one when the keyframe index is ready.
     */
    segments: boolean;
}

/**
 * Resolve a media id to a file on disk, safely.
 *
 * Three checks, in order: the user can see the root, the stored path is still a safe
 * relative path, and the resolved absolute path is genuinely inside the root. The third is
 * the one that matters — it is the backstop if a path ever reaches the database in a form
 * the second check would pass but the filesystem would resolve elsewhere (a symlink, a
 * Windows short name, a Unicode normalisation difference).
 */
export interface ResolveFileOptions {
    /**
     * Refuse to serve bytes nothing outside this browser could play (§11, §12d).
     *
     * Set for a request authenticated by a signed media token, which is how a TV or other
     * out-of-browser device asks. Those have no detail page to explain a failure and no
     * fallback to offer — a Chromecast handed a codec it cannot decode simply stops, with
     * nothing on screen to say why.
     *
     * This does *not* force a rendition over an already-playable original. §11 says to force
     * the web-safe variant, and for a file that failed assessment that is exactly what
     * happens below. But an original that passes assessment is H.264/AAC in MP4 — the profile
     * every receiver handles — and re-encoding it to reach the same place would spend the NAS
     * CPU that §17 names as the binding constraint to produce a copy of what we already had.
     * What this rules out is the third case: serving a *pending* item, where the file is known
     * unplayable and no rendition is ready yet.
     */
    requireCastReady?: boolean;
    /**
     * The original's bytes, whatever else this item could be served as.
     *
     * For two callers that want exactly the stored file: a playlist's segments, which are byte
     * ranges *of* it (§8), and a player outside the browser -- VLC plays what no browser does,
     * so the cast check above does not apply to it.
     */
    original?: boolean;
}

export const resolveMediaFile = (
    mediaId: string,
    auth: AuthContext,
    options: ResolveFileOptions = {}
): ResolvedFile => {
    const row = mediaRepo.findDetail(mediaId, auth.userId, auth.accessibleRootIds);

    if (!row) {
        throw new NotFoundError("Media not found");
    }

    const plan = resolvePlaybackPlan(row);

    if (options.requireCastReady && !options.original && plan.source === "pending") {
        throw new ConflictError("This item has no playable version yet");
    }

    /**
     * Prefer a finished web-safe rendition over an original the browser cannot play.
     *
     * Decided here rather than by the client asking for one. The player has no business
     * knowing a variant exists, and a client that could name its own source would be a way
     * to ask for arbitrary paths under the data directory.
     */
    if (!options.original && plan.source === "variant") {
        const variant = variantRepo.findOne(mediaId, WEBSAFE_PROFILE);

        if (variant?.ready) {
            const config = loadConfig();
            const absolutePath = path.resolve(
                config.dataDir,
                assertSafeRelativePath(variant.relPath)
            );

            if (absolutePath.startsWith(dataPaths(config).variants + path.sep)) {
                try {
                    const stats = statSync(absolutePath);
                    const resolved = {
                        absolutePath,
                        sizeBytes: stats.size,
                        mtimeMs: stats.mtimeMs,
                        relPath: variant.relPath,
                        kind: row.kind,
                        container: "mp4",
                        isVariant: true,
                        segments: false,
                    };

                    /**
                     * Serving it counts as watching it, for retention (§8).
                     *
                     * After the `stat`, so a row is never marked fresh on the strength of a
                     * file that turned out to be missing — that is precisely the variant the
                     * sweep should be allowed to clear up.
                     *
                     * The repo throttles this to one write an hour per variant. A viewer
                     * dragging the scrubber issues range requests by the dozen, and this is
                     * the hot path of the one thing the app must not stutter at.
                     */
                    variantRepo.touchUsed(mediaId, WEBSAFE_PROFILE);

                    return resolved;
                } catch {
                    // The row says ready but the file is gone - deleted to reclaim space, or
                    // a half-restored backup. Fall through to the original, which at least
                    // fails in a way the detail page already explains.
                }
            }
        }
    }

    const root = mediaRootRepo.findById(row.rootId);

    if (!root) {
        throw new NotFoundError("Media not found");
    }

    const rootDir = root.path;
    const safeRelPath = assertSafeRelativePath(row.relPath);
    const absolutePath = path.resolve(rootDir, safeRelPath);

    const withSeparator = rootDir.endsWith(path.sep) ? rootDir : rootDir + path.sep;

    if (!absolutePath.startsWith(withSeparator)) {
        throw new NotFoundError("Media not found");
    }

    let stats: Stats;

    try {
        stats = statSync(absolutePath);
    } catch {
        // The row exists but the file does not — an offline share, or deleted between the
        // scan and now. The scanner reconciles this; the request just fails.
        throw new NotFoundError("File is not available");
    }

    return {
        absolutePath,
        sizeBytes: stats.size,
        mtimeMs: stats.mtimeMs,
        relPath: row.relPath,
        kind: row.kind,
        container: row.container,
        isVariant: false,
        segments: !options.original && plan.source === "segments",
    };
};
