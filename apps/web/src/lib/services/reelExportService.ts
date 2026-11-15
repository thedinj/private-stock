import { posix } from "node:path";

import {
    assertSafeRelativePath,
    buildReelTimeline,
    formatFrameRate,
    joinNetworkPath,
    NotFoundError,
    rateShares,
    recommendedFrameRate,
    sameRate,
    snapFrameRate,
    STANDARD_FRAME_RATES,
    ValidationError,
    writeFcpxml,
    type FrameRate,
    type ReelExportPreview,
    type ReelExportWarning,
    type TimelineEntry,
    type TimelineSource,
} from "@private-stock/core";
import { clipTagRepo, mediaRepo, mediaRootRepo, reelRepo, tagRepo } from "@private-stock/db";

import type { AuthContext } from "../auth/withAuth";
import { listReelEntries } from "./reelService";

/**
 * A reel as a timeline Resolve opens (§14d "Editor export").
 *
 * **Readable is exportable.** The export reveals nothing the reel does not already grant: the
 * spans, and where the files are -- which, on a household server with one editing PC, is the
 * point. It goes through `listReelEntries`, so the reel's read rule and the viewer's libraries
 * are decided exactly once, there, and an item the viewer cannot reach is not in the timeline.
 *
 * Clip tags travel only to the clip's owner, as everywhere else: a shared reel grants the span,
 * not its owner's filing of it. Media tags are the viewer's view of the library, so they go.
 */

/** How many file names a warning carries: enough to find them, not a list to read. */
const WARNING_FILES = 5;

type Gathered = {
    reel: reelRepo.ReelRow;
    entries: TimelineEntry[];
    /** Per source, and whether its rate was read from the rounded `fps`. */
    sources: (TimelineSource & {
        rootId: string;
        inferred: boolean;
        mpegts: boolean;
        vfr: boolean;
    })[];
    unreachableCount: number;
    libraries: ReelExportPreview["libraries"];
};

const gather = (reelId: string, auth: AuthContext): Gathered => {
    const { items, total } = listReelEntries(reelId, auth);
    const reel = reelRepo.findById(reelId);

    if (!reel) throw new NotFoundError("Reel not found");

    const mediaIds = [...new Set(items.map((item) => item.clip.mediaId))];
    const facts = mediaRepo.listEditorExportFacts(mediaIds);
    const roots = new Map(
        [...new Set(facts.map((row) => row.rootId))].flatMap((rootId) => {
            const root = mediaRootRepo.findById(rootId);

            return root ? [[rootId, root] as const] : [];
        })
    );

    const mediaTags = new Map<string, string[]>();

    for (const row of tagRepo.listForMediaIds(mediaIds, auth.userId)) {
        mediaTags.set(row.mediaId, [...(mediaTags.get(row.mediaId) ?? []), row.name]);
    }

    const owned = clipTagRepo.ownedClipIds(
        items.map((item) => item.clip.id),
        auth.userId
    );
    const clipTags = clipTagRepo.listForClipIds(owned);

    const sources = facts.flatMap((row) => {
        const root = roots.get(row.rootId);

        if (!root) return [];

        const relPath = assertSafeRelativePath(row.relPath);
        const exact: FrameRate | null =
            row.fpsNum && row.fpsDen ? { num: row.fpsNum, den: row.fpsDen } : null;

        return [
            {
                mediaId: row.id,
                fileName: posix.basename(relPath),
                // Empty until the library has a network path; the export refuses then, and the
                // preview says which library.
                path: root.networkPath ? joinNetworkPath(root.networkPath, relPath) : "",
                durationMs: row.durationMs,
                width: row.width,
                height: row.height,
                rate: exact ?? (row.fps ? snapFrameRate(row.fps) : null),
                timecode: row.timecodeStart,
                hasAudio: row.audioCodec !== null,
                audioChannels: row.audioChannels,
                rootId: row.rootId,
                inferred: exact === null && row.fps !== null,
                mpegts: row.container === "mpegts",
                vfr: row.isVfr === 1,
            },
        ];
    });
    const byMedia = new Map(sources.map((source) => [source.mediaId, source]));

    const entries = items
        .filter((item) => byMedia.has(item.clip.mediaId))
        .map((item): TimelineEntry => ({
            mediaId: item.clip.mediaId,
            startMs: item.clip.startMs,
            endMs: item.clip.endMs,
            speed: item.clip.speed,
            label: item.clip.label,
            keywords: [
                ...new Set([
                    ...(mediaTags.get(item.clip.mediaId) ?? []),
                    ...(clipTags.get(item.clip.id) ?? []).map((tag) => tag.name),
                ]),
            ],
        }));

    const libraries = [...roots.values()].map((root) => ({
        id: root.id,
        label: root.label,
        networkPath: root.networkPath,
        clipCount: entries.filter((entry) => byMedia.get(entry.mediaId)?.rootId === root.id).length,
    }));

    return {
        reel,
        entries,
        sources,
        unreachableCount: total - entries.length,
        libraries,
    };
};

/**
 * Each reel asked for, in order, that this viewer can still open.
 *
 * A reel deleted or unshared since it was put in the export cart is left out rather than
 * failing the rest: the preview lists what remains and the cart drops the others. Only when
 * none is left is it an error.
 */
const gatherAll = (reelIds: string[], auth: AuthContext): Gathered[] => {
    const gathered = reelIds.flatMap((reelId) => {
        try {
            return [gather(reelId, auth)];
        } catch (error) {
            if (error instanceof NotFoundError) return [];

            throw error;
        }
    });

    if (gathered.length === 0) throw new NotFoundError("Reel not found");

    return gathered;
};

type Source = Gathered["sources"][number];

export const previewReelsExport = (reelIds: string[], auth: AuthContext): ReelExportPreview => {
    const gathered = gatherAll(reelIds, auth);
    const entries = gathered.flatMap((reel) => reel.entries);
    const sources = [
        ...new Map(
            gathered.flatMap((reel) => reel.sources).map((source) => [source.mediaId, source])
        ).values(),
    ];
    const rates = rateShares(entries, sources);

    const warning = (
        kind: ReelExportWarning["kind"],
        applies: (source: Source) => boolean
    ): ReelExportWarning[] => {
        const hits = gathered.map((reel) => {
            const byMedia = new Map(reel.sources.map((source) => [source.mediaId, source]));

            return {
                name: reel.reel.name,
                sources: reel.entries
                    .map((entry) => byMedia.get(entry.mediaId))
                    .filter((source): source is Source => source !== undefined && applies(source)),
            };
        });
        const hit = hits.flatMap((reel) => reel.sources);
        const files = [...new Set(hit.map((source) => source.fileName))];

        return hit.length === 0
            ? []
            : [
                  {
                      kind,
                      clipCount: hit.length,
                      files: files.slice(0, WARNING_FILES),
                      reels: hits
                          .filter((reel) => reel.sources.length > 0)
                          .map((reel) => reel.name),
                  },
              ];
    };

    const libraries = new Map<string, ReelExportPreview["libraries"][number]>();

    for (const library of gathered.flatMap((reel) => reel.libraries)) {
        const known = libraries.get(library.id);

        libraries.set(
            library.id,
            known ? { ...known, clipCount: known.clipCount + library.clipCount } : { ...library }
        );
    }

    const firstReady = sources.find((source) => source.path !== "");

    return {
        reels: gathered.map((reel) => ({
            id: reel.reel.id,
            name: reel.reel.name,
            clipCount: reel.entries.length,
        })),
        clipCount: entries.length,
        unreachableCount: gathered.reduce((sum, reel) => sum + reel.unreachableCount, 0),
        rates,
        recommended: recommendedFrameRate(rates),
        options: [...STANDARD_FRAME_RATES],
        libraries: [...libraries.values()],
        warnings: [
            ...warning("mpegts", (source) => source.mpegts),
            ...warning("vfr", (source) => source.vfr),
            ...warning("inferredRate", (source) => source.inferred),
        ],
        samplePath: firstReady?.path ?? null,
    };
};

/** A reel name as a Windows file name: the characters Explorer refuses become `_`. */
const fileNameFor = (reelName: string): string =>
    reelName
        .replace(/[\/:*?"<>|\u0000-\u001f]/g, "_")
        .replace(/[. ]+$/, "")
        .trim() || "Reel";

/**
 * The reels as one FCPXML file, a timeline each, all at `rate` (§14d "Editor export").
 *
 * One rate for every timeline, chosen once: the reels of one export are going into one
 * project, and an editor conforms a project to one rate anyway. A reel with nothing this
 * viewer can reach is left out; the preview has already said so.
 */
export const exportReels = (
    reelIds: string[],
    rate: FrameRate,
    auth: AuthContext
): { fileName: string; body: string } => {
    if (!STANDARD_FRAME_RATES.some((option) => sameRate(option, rate))) {
        throw new ValidationError(`A timeline cannot be cut at ${formatFrameRate(rate)} fps`);
    }

    const gathered = gatherAll(reelIds, auth).filter((reel) => reel.entries.length > 0);

    if (gathered.length === 0) throw new ValidationError("There are no clips to export");

    const missing = [
        ...new Map(
            gathered
                .flatMap((reel) => reel.libraries)
                .filter((library) => !library.networkPath)
                .map((library) => [library.id, library.label])
        ).values(),
    ];

    if (missing.length > 0) {
        throw new ValidationError(
            `No network path is set for ${missing.map((label) => `"${label}"`).join(", ")}`
        );
    }

    const timelines = gathered.map(({ reel, entries, sources }) =>
        buildReelTimeline({
            name: reel.name,
            description: reel.description,
            rate,
            entries,
            sources,
        })
    );

    if (timelines.length === 1) {
        const [only] = timelines;

        return {
            fileName: `${fileNameFor(only.name)}.fcpxml`,
            body: writeFcpxml(timelines, only.name),
        };
    }

    // The server's own calendar day, which on a household server is the household's.
    const now = new Date();
    const day = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
        .map((part) => String(part).padStart(2, "0"))
        .join("-");
    const name = `${timelines.length} reels ${day}`;

    return { fileName: `${name}.fcpxml`, body: writeFcpxml(timelines, name) };
};
