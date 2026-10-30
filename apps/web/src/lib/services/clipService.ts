import {
    AuthorizationError,
    ConflictError,
    NotFoundError,
    ValidationError,
    clampSpan,
    clipNaturalDirection,
    spanRunMs,
    type BulkClipTagInput,
    type BulkTagResult,
    type Clip,
    type ClipDetail,
    type ClipListResponse,
    type ClipQuery,
    type ClipTag,
    type ClipTagFacets,
    type CreateClipInput,
    type EditClipTagsInput,
    type UpdateClipInput,
} from "@private-stock/core";
import {
    clipRepo,
    clipTagRepo,
    db,
    mediaRepo,
    reelRepo,
    tagBatchRepo,
    tagRepo,
} from "@private-stock/db";

import type { AuthContext } from "../auth/withAuth";
import { toTagBatch } from "./bulkTagService";
import { mayAlterOwnWork } from "./collectionAccess";
import { vocabularyChanged } from "./ocrMatchHooks";
import { spriteThumbFor } from "./spriteThumb";
import { writesTo } from "./tagService";

/**
 * Clips: marking a span of an item, and finding one again (§14d).
 *
 * **A clip is private raw material.** That is the rule everything here enforces, and it is not
 * §9's rule for captures: a capture is library-wide to read because a good still of an item is
 * good for whoever looks at it, while a clip is a working note about where something happens
 * and most are never used. Listing everybody's working notes over every item would make the
 * item page and the browser worse for everyone.
 *
 * So the read has two doors and only one of them is shared:
 *
 *  - Here, always your own — `listForMedia` and `search` both take `userId` as a query
 *    parameter, so a caller cannot read somebody else's spans and then forget to compare.
 *  - In `reelService`, whoever marked them. There the reel has already granted the read, and a
 *    reel's spans are the reel.
 *
 * Editing and discarding go through `mayAlterOwnWork`, which after the owner invariant has one
 * case left to answer: an unattributed clip — its author's account is gone — sitting inside a
 * shared reel that still plays. That one is an administrator's.
 */

/** Narrows to an item this viewer can actually open. Missing and forbidden read alike. */
const readableMedia = (mediaId: string, auth: AuthContext) => {
    const row = mediaRepo.findDetail(mediaId, auth.userId, auth.accessibleRootIds);

    if (!row) {
        throw new NotFoundError("Media not found");
    }

    return row;
};

const toClipTag = (row: clipTagRepo.ClipTagRow): ClipTag => ({
    tagId: row.tagId,
    kind: row.kind,
    name: row.name,
    colorKey: row.colorKey,
    position: row.position,
    private: row.ownerId !== null,
});

/**
 * Tags for the clips a viewer is about to be shown, which are always their own.
 *
 * Read in one statement for the whole page. Never called on the reel path: a shared reel grants
 * the span, not its owner's filing of it (§14d "Tagging clips").
 */
const ownTagsFor = (rows: clipRepo.ClipSummaryRow[]): Map<string, ClipTag[]> =>
    new Map(
        [...clipTagRepo.listForClipIds(rows.map((row) => row.id))].map(([clipId, tags]) => [
            clipId,
            tags.map(toClipTag),
        ])
    );

const toClip = (row: clipRepo.ClipSummaryRow, auth: AuthContext, tags: ClipTag[] = []): Clip => {
    const thumb = spriteThumbFor(row.mediaId, row.startMs);

    return {
        id: row.id,
        mediaId: row.mediaId,
        mediaTitle: row.mediaTitle ?? "Untitled",
        startMs: row.startMs,
        endMs: row.endMs,
        speed: row.speed,
        // One definition of duration, shared with the SQL that sorts on it.
        runMs: spanRunMs(row),
        label: row.label,
        tags,
        thumbUrl: thumb?.url ?? null,
        thumbRect: thumb?.rect ?? null,
        mine: row.userId !== null && row.userId === auth.userId,
        editable: mayAlterOwnWork(row.userId, auth),
        reelCount: row.reelCount,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
};

/**
 * Every clip the reel machinery needs, without the per-viewer ownership filter.
 *
 * Without tags, deliberately -- see `ownTagsFor`.
 */
export const clipsByIds = (ids: string[], auth: AuthContext): Map<string, Clip> =>
    new Map(clipRepo.listByIds(ids).map((row) => [row.id, toClip(row, auth)]));

/** One item's clips for the strip under the player — this viewer's own, in timeline order. */
export const listClipsFor = (mediaId: string, auth: AuthContext): Clip[] => {
    readableMedia(mediaId, auth);

    const rows = clipRepo.listForMedia(mediaId, auth.userId);
    const tags = ownTagsFor(rows);

    return rows.map((row) => toClip(row, auth, tags.get(row.id)));
};

export const listClips = (query: ClipQuery, auth: AuthContext): ClipListResponse => {
    const direction = query.direction ?? clipNaturalDirection(query.sort);
    const scope = { userId: auth.userId, accessibleRootIds: auth.accessibleRootIds };
    const rows = clipRepo.search(query, scope, direction);
    const tags = ownTagsFor(rows);
    const items = rows.map((row) => toClip(row, auth, tags.get(row.id)));

    return {
        items,
        page: query.page,
        pageSize: query.limit,
        hasMore: rows.length === query.limit,
        total: clipRepo.countSearch(query, scope),
    };
};

export const listLabels = (auth: AuthContext): string[] => clipRepo.distinctLabels(auth.userId);

/** One clip, with the reels it is in named — what a retime or a discard has to say out loud. */
export const getClipDetail = (clipId: string, auth: AuthContext): ClipDetail => {
    const row = clipRepo.findSummary(clipId);

    if (!row || row.userId !== auth.userId) {
        throw new NotFoundError("Clip not found");
    }

    readableMedia(row.mediaId, auth);

    return {
        ...toClip(row, auth, ownTagsFor([row]).get(row.id)),
        reels: clipRepo.reelsUsing(clipId),
    };
};

export const createClip = (mediaId: string, input: CreateClipInput, auth: AuthContext): Clip => {
    const media = readableMedia(mediaId, auth);

    if (media.kind !== "video") {
        throw new ValidationError("Only a video has spans to clip");
    }

    /**
     * Clamped to the probed duration rather than refused against it.
     *
     * The probe's duration is not authoritative — `VideoPlayer` reads its own back off the
     * element for exactly that reason — so refusing on it would throw away legitimate clips at
     * the tail of any file the probe measured short, which is the end of a video people most
     * often want a moment from. Null is returned only when nothing usable survives, which is a
     * fact about the span rather than an error the person can act on.
     */
    const span = clampSpan(
        { startMs: input.startMs, endMs: input.endMs, speed: input.speed ?? null },
        media.durationMs
    );

    if (!span) {
        throw new ValidationError("That span falls outside the video");
    }

    const coined = (input.tags ?? []).filter(
        (tag) => !tagRepo.resolveName(tag.kind, tag.name, writesTo(tag.scope, auth))
    );

    // One transaction, so a name the tag rules refuse does not leave an untagged clip behind.
    const id = db.transaction((): string => {
        const clipId = clipRepo.create({
            mediaId,
            userId: auth.userId,
            startMs: span.startMs,
            endMs: span.endMs,
            label: input.label ?? null,
            speed: span.speed,
        });

        for (const tag of input.tags ?? []) {
            clipTagRepo.assign({
                clipId,
                tagId: tagRepo.ensureTag(
                    tag.kind,
                    tag.name,
                    writesTo(tag.scope, auth),
                    auth.userId
                ),
                position: clipTagRepo.nextPosition(clipId, tag.kind),
            });
        }

        return clipId;
    })();

    for (const tag of coined) {
        vocabularyChanged(tag.kind, writesTo(tag.scope, auth));
    }

    const row = clipRepo.findSummary(id)!;

    return toClip(row, auth, ownTagsFor([row]).get(id));
};

/**
 * A clip only its owner may tag, or not-found.
 *
 * Stricter than `mayAlterOwnWork`, which lets an administrator retime an unattributed clip: tags
 * on a clip are seen by its owner alone, so one written by anybody else is written for nobody.
 */
const ownClip = (clipId: string, auth: AuthContext): clipRepo.ClipRow => {
    const row = clipRepo.findById(clipId);

    if (!row || row.userId !== auth.userId) {
        throw new NotFoundError("Clip not found");
    }

    readableMedia(row.mediaId, auth);

    return row;
};

/**
 * Adds names to one clip's facet, or takes them off (§14d "Tagging clips").
 *
 * A name resolves in the system it was typed into, exactly as on an item (`tagService.applyTags`),
 * and a remove resolves without coining -- taking off a name nobody has used is a no-op.
 */
export const editClipTags = (
    clipId: string,
    input: EditClipTagsInput,
    auth: AuthContext
): ClipTag[] => {
    ownClip(clipId, auth);

    const scope = writesTo(input.scope, auth);
    const coins =
        input.mode !== "remove" &&
        input.names.some((name) => !tagRepo.resolveName(input.kind, name, scope));

    db.transaction((): void => {
        if (input.mode === "remove") {
            for (const name of input.names) {
                const resolved = tagRepo.resolveName(input.kind, name, scope);

                if (resolved) {
                    clipTagRepo.unassign(clipId, resolved.tag.id);
                }
            }

            return;
        }

        const first = clipTagRepo.nextPosition(clipId, input.kind);

        input.names.forEach((name, index) => {
            clipTagRepo.assign({
                clipId,
                tagId: tagRepo.ensureTag(input.kind, name, scope, auth.userId),
                position: first + index,
            });
        });
    })();

    if (coins) {
        vocabularyChanged(input.kind, scope);
    }

    return (clipTagRepo.listForClipIds([clipId]).get(clipId) ?? []).map(toClipTag);
};

/**
 * Tags a selection of clips in one undoable batch (§5d, §14d).
 *
 * Every id must be the caller's own; one that is not refuses the whole apply rather than tagging
 * the rest, because a selection that quietly shrank is not the one somebody confirmed.
 */
export const bulkTagClips = (input: BulkClipTagInput, auth: AuthContext): BulkTagResult => {
    const clipIds = [...new Set(input.clipIds)];

    if (clipTagRepo.ownedClipIds(clipIds, auth.userId).length !== clipIds.length) {
        throw new NotFoundError("Clip not found");
    }

    const scope = writesTo(input.scope, auth);
    const coins = input.names.some((name) => !tagRepo.resolveName(input.kind, name, scope));
    const count = clipIds.length;
    const summary =
        `Tagged ${count} clip${count === 1 ? "" : "s"} ${input.kind}: ` + input.names.join(", ");

    const { batchId, assigned } = db.transaction(() =>
        tagBatchRepo.applyToClips({
            userId: auth.userId,
            summary,
            clipIds,
            tagIds: input.names.map((name) =>
                tagRepo.ensureTag(input.kind, name, scope, auth.userId)
            ),
        })
    )();

    if (coins) {
        vocabularyChanged(input.kind, scope);
    }

    const batch = tagBatchRepo.findById(batchId, auth.userId);

    if (!batch) {
        throw new NotFoundError("Batch not found");
    }

    return { batch: toTagBatch(batch), assigned };
};

/** The chips for /clips' two tag fields, counted over all of the viewer's clips. */
export const listClipTagFacets = (auth: AuthContext): ClipTagFacets => {
    const facets = clipTagRepo.facetsFor(auth.userId, auth.accessibleRootIds);
    const toValue = (row: clipTagRepo.ClipTagFacetRow) => ({
        tagId: row.tagId,
        kind: row.kind,
        name: row.name,
        private: row.ownerId !== null,
        count: row.count,
    });

    return { clip: facets.clip.map(toValue), video: facets.video.map(toValue) };
};

/**
 * Narrows to a clip this viewer may change.
 *
 * `NotFoundError` when they cannot see the item at all, so the error does not confirm the id;
 * `AuthorizationError` once they can, because the clip is on screen in front of them and
 * "it is not yours" is the useful answer. `frameService.deleteCapture` draws the same line.
 */
const alterable = (clipId: string, auth: AuthContext): clipRepo.ClipRow => {
    const row = clipRepo.findById(clipId);

    if (!row) {
        throw new NotFoundError("Clip not found");
    }

    readableMedia(row.mediaId, auth);

    if (!mayAlterOwnWork(row.userId, auth)) {
        throw new AuthorizationError("That clip was marked by somebody else");
    }

    return row;
};

export const updateClip = (clipId: string, input: UpdateClipInput, auth: AuthContext): Clip => {
    const existing = alterable(clipId, auth);
    const media = mediaRepo.findBasic(existing.mediaId);

    const span = clampSpan(
        {
            startMs: input.startMs ?? existing.startMs,
            endMs: input.endMs ?? existing.endMs,
            speed: input.speed === undefined ? existing.speed : input.speed,
        },
        media?.durationMs ?? null
    );

    if (!span) {
        throw new ValidationError("That span falls outside the video");
    }

    clipRepo.update(clipId, {
        ...input,
        startMs: span.startMs,
        endMs: span.endMs,
    });

    const row = clipRepo.findSummary(clipId)!;

    return toClip(row, auth, row.userId === auth.userId ? ownTagsFor([row]).get(clipId) : []);
};

/**
 * Discards a clip, and takes it out of the reels holding it.
 *
 * **Cascade, with a sentence — never a refusal.** This was the hardest question in the design
 * until the owner invariant removed it. A reel holds nothing but its owner's clips (§14d), so
 * every reel a delete reaches belongs to the person doing the deleting: there is no stranger's
 * arrangement to protect, and the caller has already been shown their names. Refusing instead
 * would have handed a veto to objects the deleter might not be able to see, and a refusal you
 * cannot act on is worse than either outcome.
 *
 * The renumbering is the part that has to happen here. `ReelItem` rows leave through the
 * foreign key rather than through `reelRepo.removeItem`, so nothing else closes the holes, and
 * a reel with holes reports "3 of 12" against a twelve that can be exceeded.
 */
export const deleteClip = (clipId: string, auth: AuthContext): { reelsChanged: number } => {
    const row = alterable(clipId, auth);

    return db.transaction((): { reelsChanged: number } => {
        const affected = clipRepo.reelsUsing(row.id);

        clipRepo.remove(row.id);
        affected.forEach((reel) => reelRepo.renumber(reel.id));

        return { reelsChanged: affected.length };
    })();
};

/** Thrown where a name is reused, matching how the other collections report it. */
export const assertReelNameFree = (name: string, ownerId: string, exceptId?: string): void => {
    const clash = reelRepo.findByName(ownerId, name);

    if (clash && clash.id !== exceptId) {
        throw new ConflictError(`A reel named "${name}" already exists`);
    }
};
