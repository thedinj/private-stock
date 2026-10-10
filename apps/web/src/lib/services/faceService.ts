import { randomUUID } from "node:crypto";

import {
    AuthorizationError,
    NotFoundError,
    ValidationError,
    FACE_DOUBT,
    AUTO_TAG_LINE,
    LOOKS_LIKE,
    LOOSE_GROUP,
    LOOKS_LIKE_MARGIN,
    groupStateFor,
    normaliseVector,
    vectorSimilarity,
    normalizeName,
    type ConfirmedFacesPage,
    type ConfirmedFacesQuery,
    type OwnFacePick,
    type OwnFacesPage,
    type OwnFacesQuery,
    type FaceCrop,
    type FaceLikeness,
    type FaceLikenessQuery,
    type FacePeek,
    type FacePeekQuery,
    type FaceGroupDecision,
    type FaceGroupState,
    type FaceMatchState,
    type FaceReviewDecision,
    type FaceReviewFace,
    type ItemSuspect,
    type ItemSuspectDecision,
    type ItemSuspects,
    type NoSingleFace,
    type FaceReviewPage,
    type FaceReviewQuery,
    type FaceReviewResult,
    type FaceReviewRow,
    type LikelyDecision,
    type LikelyItem,
    type LikelyPage,
    type LikelyQuery,
    type MediaKind,
    type MediaKindCounts,
    type MentionField,
    type PerformerFacesResponse,
} from "@private-stock/core";
import {
    artifactRepo,
    db,
    faceRepo,
    jobRepo,
    mentionRepo,
    searchRepo,
    tagBatchRepo,
    tagRepo,
    type faceRepo as FaceRepoTypes,
} from "@private-stock/db";

import type { AuthContext } from "../auth/withAuth";
import { artifactUrl } from "./artService";
import { lookupMedia } from "./mediaService";
import { notThem } from "./notThem";
import { faceAnchors } from "./faceAnchors";
import { faceVectorReader } from "./faceVectors";
import { spriteThumbFor } from "./spriteThumb";
import { picturesFor } from "./tagPictureService";

/**
 * A performer's faces, and the items that are probably them (§5f "Starting from the performer").
 *
 * Administrators only, as the OCR review is: what is decided here becomes the library's tags,
 * which everyone sees. Performers in the library's own vocabulary only — a private tag is one
 * person's, and faces are read for everyone.
 */

type ShownFace = FaceRepoTypes.ShownFace;

/** How many of a group's faces "Their face" shows. */
const SAMPLE = 6;

/** How many groups "Their face" lists: past this, the ones with fewest items are not worth it. */
const GROUPS = 12;

const requireAdmin = (auth: AuthContext): void => {
    if (!auth.scopes.includes("admin")) {
        throw new AuthorizationError("Only an administrator can confirm faces");
    }
};

const libraryPerformer = (tagId: string) => {
    const tag = tagRepo.findById(tagId);

    if (!tag || tag.kind !== "performer" || tag.ownerId !== null) {
        throw new NotFoundError("Performer not found");
    }

    return tag;
};

/** How much wider than the face the crop is: enough of the head to recognise it by. */
const MARGIN = 1.6;

/**
 * A square around a face, inside the picture it was found in: a sprite tile for a video, the
 * cover for a photograph. The same crop the browser draws from a sheet it has very likely
 * fetched already for the scrubber (§14d). Null where the picture has gone.
 */
export const faceCrop = (face: ShownFace): FaceCrop | null => {
    let picture: {
        url: string;
        x: number;
        y: number;
        width: number;
        height: number;
        sheetWidth: number;
        sheetHeight: number;
    };

    if (face.kind === "video") {
        const thumb = spriteThumbFor(face.mediaId, face.atMs ?? 0);

        if (!thumb) return null;

        picture = { url: thumb.url, ...thumb.rect };
    } else {
        const cover = artifactRepo.findOne(face.mediaId, "cover", 0);

        if (!cover?.width || !cover.height) return null;

        picture = {
            url: artifactUrl(face.mediaId, "cover", cover.relPath, cover.generatedAt),
            x: 0,
            y: 0,
            width: cover.width,
            height: cover.height,
            sheetWidth: cover.width,
            sheetHeight: cover.height,
        };
    }

    const side = Math.min(
        Math.max(face.w * picture.width, face.h * picture.height) * MARGIN,
        picture.width,
        picture.height
    );
    const cx = picture.x + (face.x + face.w / 2) * picture.width;
    const cy = picture.y + (face.y + face.h / 2) * picture.height;
    const clamp = (value: number, low: number, high: number): number =>
        Math.min(Math.max(value, low), high);

    return {
        url: picture.url,
        rect: {
            x: clamp(cx - side / 2, picture.x, picture.x + picture.width - side),
            y: clamp(cy - side / 2, picture.y, picture.y + picture.height - side),
            width: side,
            height: side,
            sheetWidth: picture.sheetWidth,
            sheetHeight: picture.sheetHeight,
        },
        frame: {
            x: picture.x,
            y: picture.y,
            width: picture.width,
            height: picture.height,
            sheetWidth: picture.sheetWidth,
            sheetHeight: picture.sheetHeight,
        },
    };
};

/** The performer's groups worth showing, with why: confirmed, or proposed by their tags. */
const performerGroups = (tagId: string, auth: AuthContext) =>
    faceRepo
        .groupsForPerformer(tagId, auth.accessibleRootIds)
        .map((row) => ({ ...row, state: groupStateFor(row) }))
        .filter((row): row is typeof row & { state: FaceGroupState } => row.state !== null);

/** A face group that might be a performer, and why. */
interface ReviewPair {
    tagId: string;
    groupId: string;
    state: FaceMatchState;
    faceCount: number;
    itemCount: number;
    /** Items not carrying the performer yet, as far as the counts know: Matches' order. */
    untaggedCount: number;
    /** The same, of videos and of photos: what Matches holds under the kind control. */
    untaggedBy: MediaKindCounts;
}

/**
 * Every face group that might be a performer, across the library, with why (§5f): confirmed or
 * proposed by `groupStateFor`, or — for a group with neither, for anybody — looking like somebody:
 * half or more of its items with a face whose best match is them (`LOOKS_LIKE`), so one person
 * split across groups, or never confirmed at all, is asked about as that person rather than named
 * again from scratch. Not where the group has faces refused for them.
 *
 * Also what Unnamed needs: the groups some pair names, and every group's size.
 *
 * Given `groupIds`, the same answer for only those groups: each group's pairs depend on nothing
 * but the group, so a performer's page asks about the few that concern them (`performerPairs`)
 * rather than every group in the library.
 */
const reviewPairs = (roots: readonly string[], groupIds?: readonly string[]) => {
    const evidence = faceRepo
        .groupEvidence(roots, groupIds)
        .map((row) => ({ ...row, state: groupStateFor(row) }))
        .filter((row): row is typeof row & { state: FaceGroupState } => row.state !== null);
    const named = new Set(evidence.map((row) => row.groupId));

    const refused = new Set(
        faceRepo.groupRefusals(groupIds).map((row) => `${row.groupId}:${row.tagId}`)
    );
    const sizes = new Map(
        faceRepo.groupSizes(roots, 1, groupIds).map((size) => [size.groupId, size])
    );
    const settled = new Set<string>();

    // Per group, the performer most of its items look like — by each face's best match against
    // the references, the one score the review and the worker share. A tie goes to the first by
    // id, so a group's answer does not depend on which other groups were asked about with it.
    const likeness = new Map<string, { tagId: string; items: number }>();

    for (const row of faceRepo.groupLikenesses(roots, LOOKS_LIKE, LOOKS_LIKE_MARGIN, groupIds)) {
        const best = likeness.get(row.groupId);

        if (
            !best ||
            best.items < row.items ||
            (best.items === row.items && row.tagId < best.tagId)
        ) {
            likeness.set(row.groupId, { tagId: row.tagId, items: row.items });
        }
    }

    const looking = [...likeness].flatMap(([groupId, { tagId, items }]) => {
        const size = sizes.get(groupId);

        return !size ||
            named.has(groupId) ||
            refused.has(`${groupId}:${tagId}`) ||
            items < Math.max(2, Math.ceil(size.itemCount / 2))
            ? []
            : [{ groupId, tagId, size }];
    });

    // Counted for real: a group like theirs whose items were tagged by way of another group has
    // nothing to ask, and would otherwise be a row with no faces in it. One read for them all.
    const untagged = new Map(
        faceRepo.untaggedCounts(looking, roots).map((count) => [count.groupId, count])
    );
    const resembling = new Map<string, ReviewPair>();

    for (const { groupId, tagId, size } of looking) {
        const count = untagged.get(groupId);

        if (!count || count.items === 0) {
            // Theirs already, by its tags and its likeness: nobody to ask about in Unnamed either.
            settled.add(groupId);
            continue;
        }

        resembling.set(groupId, {
            tagId,
            groupId,
            state: "resembles",
            faceCount: size.faceCount,
            itemCount: size.itemCount,
            untaggedCount: count.items,
            untaggedBy: { video: count.videos, image: count.photos },
        });
    }

    const pairs: ReviewPair[] = [
        ...evidence.map((row): ReviewPair => ({
            tagId: row.tagId,
            groupId: row.groupId,
            state: row.state,
            faceCount: row.faceCount,
            itemCount: row.itemCount,
            untaggedCount: row.untaggedCount,
            untaggedBy: { video: row.untaggedVideos, image: row.untaggedPhotos },
        })),
        ...resembling.values(),
    ];

    return {
        pairs,
        named: new Set([...named, ...resembling.keys(), ...settled]),
        sizes: [...sizes.values()],
    };
};

/**
 * The groups that might be this performer, and why: `reviewPairs`' answer for them alone, asked
 * of only the groups their evidence or their likeness reaches.
 */
const performerPairs = (tagId: string, roots: readonly string[]): ReviewPair[] => {
    const groupIds = [
        ...new Set([
            ...faceRepo.performerGroupIds(tagId),
            ...faceRepo.likenessGroupIds(tagId, LOOKS_LIKE, LOOKS_LIKE_MARGIN),
        ]),
    ];

    return reviewPairs(roots, groupIds).pairs.filter((pair) => pair.tagId === tagId);
};

/** How many confirmed faces "Their face" shows. */
const CONFIRMED = 12;

/**
 * "Their face": the faces confirmed as this performer, as one strip; how many groups are still to
 * check in Review › Faces; and the groups themselves — confirmed first, then the ones that would
 * settle most items — for taking a confirmation back.
 */
export const performerFaces = (tagId: string, auth: AuthContext): PerformerFacesResponse => {
    requireAdmin(auth);
    libraryPerformer(tagId);

    // Left out of face matching: nothing to show but that.
    const noFace = faceRepo.noSingleFace(tagId);

    if (noFace) {
        return {
            noSingleFace: { since: noFace.decidedAt },
            confirmed: [],
            fromTags: [],
            confirmedItems: 0,
            groups: [],
        };
    }

    const roots = auth.accessibleRootIds;
    const confirmed = faceRepo.confirmedFaces(tagId, roots, CONFIRMED).flatMap(reviewFace);
    const groups = performerGroups(tagId, auth)
        .sort(
            (a, b) =>
                (a.state === "confirmed" ? 0 : 1) - (b.state === "confirmed" ? 0 : 1) ||
                b.untaggedCount - a.untaggedCount ||
                b.itemCount - a.itemCount
        )
        .slice(0, GROUPS);

    return {
        noSingleFace: null,
        confirmed,
        fromTags:
            confirmed.length > 0
                ? []
                : faceRepo.faceFromTags(tagId, roots, CONFIRMED).flatMap(reviewFace),
        confirmedItems: faceRepo.confirmedItemCount(tagId, roots),
        groups: groups.map((group) => ({
            groupId: group.groupId,
            state: group.state,
            faces: faceRepo.sampleFaces(group.groupId, roots, SAMPLE).flatMap(reviewFace),
            faceCount: group.faceCount,
            itemCount: group.itemCount,
            untaggedCount: group.untaggedCount,
        })),
    };
};

/**
 * Confirmations changed, so a performer's best face, and with it their picture, may have (§6 "A
 * tag's picture"). The job waits two minutes, so a review session's decisions are one pass.
 */
const confirmationsChanged = (): void => {
    jobRepo.enqueueKind("tagPictures", 200, 120);
    // And every reference and best match with it (§5f "One face, one score").
    jobRepo.enqueueKind("faceAnchors", 200, 120);
};

/**
 * "No single face" (§5f "Performers with no single face"): a performer whose face never shows, or a
 * name that is not one person, left out of face matching — no reference, no evidence from their
 * tags, nothing proposed or tagged by a face; suggested by name only. Taken back, everything they
 * had returns: what was confirmed for them was kept, and their reference is built again at once.
 */
export const setNoSingleFace = (
    tagId: string,
    input: NoSingleFace,
    auth: AuthContext
): { noSingleFace: boolean } => {
    requireAdmin(auth);
    libraryPerformer(tagId);

    faceRepo.setNoSingleFace(tagId, input.noSingleFace, auth.userId);
    jobRepo.enqueueKind("faceAnchors", 200, 0);

    return { noSingleFace: input.noSingleFace };
};

/** Every face confirmed as them, a page at a time: what their picture is chosen from. */
export const confirmedFacesPage = (
    tagId: string,
    query: ConfirmedFacesQuery,
    auth: AuthContext
): ConfirmedFacesPage => {
    requireAdmin(auth);
    libraryPerformer(tagId);

    const start = query.page * query.limit;
    const { faces, total } = faceRepo.everyConfirmedFace(
        tagId,
        auth.accessibleRootIds,
        query.limit,
        start
    );

    return {
        faces: faces.flatMap(reviewFace),
        hasMore: start + query.limit < total,
        total,
    };
};

/** How many faces "Pick their face" shows an item: one a person, the people most on screen. */
const OWN_FACES_PER_ITEM = 6;

/**
 * "Pick their face" (§5f "Picking their face"): their own items, each with its faces, one a
 * person, for the performer neither their tags nor the groups could find a face for.
 */
export const ownFacesPage = (
    tagId: string,
    query: OwnFacesQuery,
    auth: AuthContext
): OwnFacesPage => {
    requireAdmin(auth);
    libraryPerformer(tagId);

    const start = query.page * query.limit;
    const { mediaIds, total } = faceRepo.ownFaceItems(
        tagId,
        auth.accessibleRootIds,
        query.limit,
        start
    );
    const byItem = new Map<string, OwnFacesPage["items"][number]>(
        mediaIds.map((mediaId) => [mediaId, { mediaId, faces: [], theirs: null }])
    );

    for (const face of faceRepo.ownFaces(tagId, mediaIds, OWN_FACES_PER_ITEM)) {
        const item = byItem.get(face.mediaId);

        if (!item) continue;
        item.faces.push(...reviewFace(face));
        if (face.theirs) item.theirs = face.id;
    }

    return {
        items: [...byItem.values()].filter((item) => item.faces.length > 0),
        hasMore: start + query.limit < total,
        total,
    };
};

/**
 * "That's them" of one face on one of their own items, or taken back. One face an item: picking
 * another there takes the first back, so an item never says two people are them.
 */
export const pickOwnFace = (
    tagId: string,
    pick: OwnFacePick,
    auth: AuthContext
): { changed: number } => {
    requireAdmin(auth);
    libraryPerformer(tagId);

    const mediaId = faceRepo.ownFaceMedia(pick.faceId, tagId);

    if (!mediaId || lookupMedia([mediaId], auth).items.length === 0) {
        throw new NotFoundError("Face not found");
    }

    const changed = db.transaction(() => {
        if (!pick.theirs) return faceRepo.unconfirmFace(pick.faceId, tagId);

        let taken = 0;

        for (const face of faceRepo.ownFaces(tagId, [mediaId], Number.MAX_SAFE_INTEGER)) {
            if (face.theirs && face.id !== pick.faceId) {
                taken += faceRepo.unconfirmFace(face.id, tagId);
            }
        }

        return taken + faceRepo.confirmFace(pick.faceId, tagId, auth.userId);
    })();

    if (changed > 0) confirmationsChanged();

    return { changed };
};

/** "That's them" or "Not them", of a whole group. */
export const decideFaceGroup = (
    tagId: string,
    decision: FaceGroupDecision,
    auth: AuthContext
): { changed: number } => {
    requireAdmin(auth);
    libraryPerformer(tagId);

    const changed = faceRepo.decideGroup(
        decision.groupId,
        tagId,
        decision.verdict,
        auth.userId,
        decision.faceIds
    );

    confirmationsChanged();

    return { changed };
};

interface Candidate {
    mediaId: string;
    face: FaceMatchState | null;
    shown: ShownFace | null;
    mentions: MentionField[];
}

const FACE_STRENGTH: Record<FaceMatchState, number> = { confirmed: 20, proposed: 10, resembles: 5 };

/** The order "Likely" is read in: a confirmed face, then a proposed one; more names first. */
const strength = (candidate: Candidate): number =>
    (candidate.face ? FACE_STRENGTH[candidate.face] : 0) + candidate.mentions.length;

/** The groups that might be this performer, each with why. */
const performerMatchGroups = (tagId: string, roots: readonly string[]) =>
    new Map(performerPairs(tagId, roots).map((pair) => [pair.groupId, pair.state]));

/**
 * Every untagged item with evidence it is this performer, by kind (§5f "Starting from the
 * performer"): a face of theirs and their name together — the strongest evidence, and what no
 * other place shows — listed best first; a face alone, which Review › Faces asks about with the
 * group beside it; and the name alone, which "Find untagged" opens in the grid. One place for
 * each, so nothing is asked twice.
 */
const likelyEvidence = (tagId: string, auth: AuthContext) => {
    const roots = auth.accessibleRootIds;
    const stateOf = performerMatchGroups(tagId, roots);
    const byItem = new Map<string, Candidate>();
    const entry = (mediaId: string): Candidate => {
        let found = byItem.get(mediaId);

        if (!found) {
            found = { mediaId, face: null, shown: null, mentions: [] };
            byItem.set(mediaId, found);
        }

        return found;
    };

    // A face that looks like them by its best match, grouped or not.
    for (const face of faceRepo.untaggedLookingLike(tagId, roots, LOOKS_LIKE, LOOKS_LIKE_MARGIN)) {
        const candidate = entry(face.mediaId);

        if (!candidate.face) {
            candidate.face = "resembles";
            candidate.shown = face;
        }
    }

    for (const face of faceRepo.untaggedInGroups([...stateOf.keys()], tagId, roots)) {
        const candidate = entry(face.mediaId);
        const state = stateOf.get(face.groupId)!;

        if (!candidate.face || FACE_STRENGTH[state] > FACE_STRENGTH[candidate.face]) {
            candidate.face = state;
            candidate.shown = face;
        }
    }

    for (const { mediaId, field } of mentionRepo.untaggedMentions(tagId, roots)) {
        const candidate = entry(mediaId);

        if (!candidate.mentions.includes(field)) candidate.mentions.push(field);
    }

    const all = [...byItem.values()];

    return {
        groups: [...stateOf.keys()],
        agreed: all
            .filter((candidate) => candidate.face && candidate.mentions.length > 0)
            .sort((a, b) => strength(b) - strength(a) || (a.mediaId < b.mediaId ? -1 : 1)),
        nameOnly: all.filter((candidate) => !candidate.face).length,
    };
};

/** "Likely": a page of the items where a face of theirs and their name agree, and the rest counted. */
export const likely = (tagId: string, query: LikelyQuery, auth: AuthContext): LikelyPage => {
    requireAdmin(auth);
    libraryPerformer(tagId);

    const { agreed, nameOnly } = likelyEvidence(tagId, auth);
    const start = query.page * query.limit;
    const page = agreed.slice(start, start + query.limit);
    const tiles = new Map(
        lookupMedia(
            page.map((candidate) => candidate.mediaId),
            auth
        ).items.map((item) => [item.id, item])
    );

    return {
        items: page.flatMap((candidate): LikelyItem[] => {
            const item = tiles.get(candidate.mediaId);

            return item
                ? [
                      {
                          item,
                          face: candidate.face,
                          crop: candidate.shown ? faceCrop(candidate.shown) : null,
                          mentions: candidate.mentions,
                      },
                  ]
                : [];
        }),
        hasMore: start + query.limit < agreed.length,
        total: agreed.length,
        nameOnly,
    };
};

/**
 * Answer "Likely": tag items with the performer as one batch that can be undone, as the OCR
 * review's accept does — some, or every item the list holds; or say an item is not them, which
 * refuses both what put it there: its faces in their groups, and its name match.
 */
export const decideLikely = (
    tagId: string,
    decision: LikelyDecision,
    auth: AuthContext
): { changed: number } => {
    requireAdmin(auth);

    const tag = libraryPerformer(tagId);

    if (decision.verdict === "refuse") {
        const groups = performerMatchGroups(tagId, auth.accessibleRootIds);

        return {
            changed: db.transaction(
                () =>
                    // Said of the item, not of a face on screen.
                    faceRepo.refuseOnItem(
                        decision.mediaId,
                        tagId,
                        [...groups.keys()],
                        auth.userId,
                        [],
                        "item"
                    ) + mentionRepo.refuse(tagId, [decision.mediaId], auth.userId)
            )(),
        };
    }

    const wanted =
        decision.verdict === "addAll"
            ? likelyEvidence(tagId, auth).agreed.map((candidate) => candidate.mediaId)
            : decision.mediaIds;
    // Only items this viewer can see, as everything here is.
    const visible = lookupMedia(wanted, auth).items.map((item) => item.id);

    if (visible.length === 0) {
        throw new ValidationError("None of those items can be tagged from here");
    }

    const { assigned } = db.transaction(() => {
        const result = tagBatchRepo.applyAssignments({
            userId: auth.userId,
            scope: null,
            summary: `${tag.name} on ${visible.length} ${visible.length === 1 ? "item" : "items"}, from their page's Likely list`,
            assignments: visible.map((mediaId) => ({ mediaId, tagId })),
        });

        searchRepo.requestReindex(visible);

        return result;
    })();

    return { changed: assigned };
};

/** How many faces a review row asks about: one an item, so as many items. */
const REVIEW_FACES = 24;

/** How many faces from items already tagged a Matches row shows to compare with. */
const REFERENCE_FACES = 4;

/** A group on one item is a face seen in one place: not a person worth naming yet. */
const UNNAMED_MIN_ITEMS = 2;

/**
 * A group somebody said "can't tell" of comes back once this many new items' faces have joined
 * it: enough new pictures that it might be told now.
 */
const UNNAMED_RETURN_AFTER = 3;

const reviewFace = (face: ShownFace): FaceReviewFace[] => {
    const crop = faceCrop(face);

    return crop
        ? [
              {
                  id: face.id,
                  crop,
                  mediaId: face.mediaId,
                  kind: face.kind,
                  atMs: face.atMs,
                  box: { x: face.x, y: face.y, w: face.w, h: face.h },
              },
          ]
        : [];
};

const STATE_ORDER: Record<FaceMatchState, number> = { confirmed: 0, proposed: 1, resembles: 2 };

/** One row of a review list, as it was when the list was made. */
interface ReviewEntry {
    groupId: string;
    faceCount: number;
    itemCount: number;
    candidate: { tagId: string; name: string; state: FaceMatchState } | null;
    /** Unnamed only: which of the group's faces to ask about. */
    only: "open" | "left";
    loose: boolean;
    openItems: number;
}

/**
 * A visit's review list (§5f "A list that holds still"): the rows in their order, made once when
 * the tab opens and paged from after. Deciding a row never re-sorts or re-reads it.
 */
interface ReviewList {
    id: string;
    userId: string;
    /** What it is a list of: the query's tab, performer and kind. */
    of: string;
    entries: ReviewEntry[];
    byMedia: MediaKindCounts;
    performer: { id: string; name: string } | null;
    madeAt: number;
}

/** How long a visit's list is kept: well past a sitting, and gone by the next. */
const LIST_TTL_MS = 60 * 60 * 1000;
/** How many lists are kept at once, the oldest dropped first: a handful of people and tabs. */
const LIST_CAP = 32;
const lists = new Map<string, ReviewList>();

const keepList = (list: ReviewList): void => {
    const now = Date.now();

    for (const [id, kept] of lists) {
        if (now - kept.madeAt > LIST_TTL_MS) lists.delete(id);
    }

    while (lists.size >= LIST_CAP) {
        const oldest = lists.keys().next().value;

        if (oldest === undefined) break;
        lists.delete(oldest);
    }

    lists.set(list.id, list);
};

/**
 * Review › Faces (§5f "One review, two sources"): every face group with something to decide,
 * across the library.
 *
 * - **Matches**: a group that is, or might be, a performer (`reviewPairs`) and is on items not
 *   tagged with them yet. The ones that would settle most items first.
 * - **Unnamed**: the groups no performer is confirmed, proposed or resembled for, most open items
 *   first: "Who is this?". Only ever the undecided faces — nobody's, not set aside — so naming part
 *   of a group never brings the named part back. A group with a "can't tell" in it waits until
 *   `UNNAMED_RETURN_AFTER` items' undecided faces are in it. And a group that held two people,
 *   once one is named and the group is theirs: the faces left over — unticked, so refused for
 *   them, and nobody's yet — come back here on their own, to name the other.
 *
 * The list is the expensive part — every group in the library, counted — so it is made once a
 * visit (`makeList`) and kept; every later page is a slice of it, its rows read as they are now.
 */
const makeList = (query: FaceReviewQuery, auth: AuthContext, of: string): ReviewList => {
    const roots = auth.accessibleRootIds;
    // From a performer's page: their matches only, asked of their own groups -- which is all
    // Matches needs of them. Unnamed is everybody's by definition.
    const performer =
        query.tab === "matches" && query.performer ? libraryPerformer(query.performer) : null;
    const { pairs, named, sizes } = performer
        ? { pairs: performerPairs(performer.id, roots), named: new Set<string>(), sizes: [] }
        : reviewPairs(roots);

    const tags = new Map<string, ReturnType<typeof tagRepo.findById>>();
    const tagOf = (tagId: string) => {
        if (!tags.has(tagId)) tags.set(tagId, tagRepo.findById(tagId));

        return tags.get(tagId);
    };

    /**
     * The rows under one choice of the kind control: what is asked about is counted on items of
     * that kind only, so a group whose open faces are all on photos is not a row under Videos.
     * Which groups are whose is still decided from every item -- photos keep naming people.
     */
    const entriesFor = (media: MediaKind | undefined): ReviewEntry[] => {
        const of = (counts: MediaKindCounts): number =>
            media ? counts[media] : counts.video + counts.image;

        return query.tab === "matches"
            ? pairs
                  .filter(
                      (pair) =>
                          of(pair.untaggedBy) > 0 && (!performer || pair.tagId === performer.id)
                  )
                  .sort(
                      (a, b) =>
                          of(b.untaggedBy) - of(a.untaggedBy) ||
                          STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
                          b.itemCount - a.itemCount ||
                          (a.groupId < b.groupId ? -1 : 1)
                  )
                  .flatMap((pair): ReviewEntry[] => {
                      const tag = tagOf(pair.tagId);

                      return tag
                          ? [
                                {
                                    groupId: pair.groupId,
                                    faceCount: pair.faceCount,
                                    itemCount: pair.itemCount,
                                    candidate: { tagId: tag.id, name: tag.name, state: pair.state },
                                    only: "open",
                                    openItems: pair.itemCount,
                                    loose: false,
                                },
                            ]
                          : [];
                  })
            : sizes
                  .flatMap((size): ReviewEntry[] => {
                      const base = {
                          groupId: size.groupId,
                          faceCount: size.faceCount,
                          itemCount: size.itemCount,
                          candidate: null,
                          loose: size.cohesion !== null && size.cohesion < LOOSE_GROUP,
                      };

                      if (named.has(size.groupId)) {
                          const left = of({ video: size.leftVideos, image: size.leftPhotos });

                          return left >= UNNAMED_MIN_ITEMS
                              ? [{ ...base, only: "left", openItems: left }]
                              : [];
                      }

                      // Only what is undecided: a group named in part is asked about the rest.
                      const enough =
                          size.skippedItems === 0 ? UNNAMED_MIN_ITEMS : UNNAMED_RETURN_AFTER;
                      const open = of({ video: size.openVideos, image: size.openPhotos });

                      return open >= enough ? [{ ...base, only: "open", openItems: open }] : [];
                  })
                  .sort(
                      (a, b) =>
                          // The loose ones last: likely several people, and the least to gain.
                          Number(a.loose) - Number(b.loose) ||
                          b.openItems - a.openItems ||
                          b.faceCount - a.faceCount ||
                          (a.groupId < b.groupId ? -1 : 1)
                  );
    };

    const entries = entriesFor(query.media);

    return {
        id: randomUUID(),
        userId: auth.userId,
        of,
        entries,
        byMedia: {
            video: query.media === "video" ? entries.length : entriesFor("video").length,
            image: query.media === "image" ? entries.length : entriesFor("image").length,
        },
        performer: performer && { id: performer.id, name: performer.name },
        madeAt: Date.now(),
    };
};

/**
 * A page of the review. Without `list`, or with one no longer kept, the visit's list is made;
 * with it, the page is the next slice of that list, in the order it had.
 *
 * A row shows exactly the faces it asks about — one for each item a decision would tag, up to
 * `REVIEW_FACES` — and, on Matches, a few from items already tagged, kept apart, to compare with.
 * What is ticked is what is tagged; the rest of a large group comes back as the row afterwards.
 *
 * Rows are read as they are now, not as the list remembers them: from a kept list, a row whose
 * faces were all settled since — by a decision on another row of it — is left out of its page.
 */
export const reviewFaces = (query: FaceReviewQuery, auth: AuthContext): FaceReviewPage => {
    requireAdmin(auth);

    const roots = auth.accessibleRootIds;
    const of = `${query.tab}|${query.performer ?? ""}|${query.media ?? ""}`;
    const kept = query.list ? lists.get(query.list) : undefined;
    const reused = kept !== undefined && kept.userId === auth.userId && kept.of === of;
    const list = reused ? kept : makeList(query, auth, of);

    if (!reused) keepList(list);

    const start = query.page * query.limit;
    const page = list.entries.slice(start, start + query.limit);
    const pictures = picturesFor(
        page.flatMap((entry) => (entry.candidate ? [entry.candidate.tagId] : [])),
        auth
    );

    return {
        list: list.id,
        rows: page.flatMap((entry): FaceReviewRow[] => {
            const { candidate } = entry;
            const shape = {
                groupId: entry.groupId,
                faceCount: entry.faceCount,
                itemCount: entry.itemCount,
                loose: entry.loose,
            };

            if (!candidate) {
                const faces = faceRepo
                    .sampleFaces(entry.groupId, roots, REVIEW_FACES, entry.only, query.media)
                    .flatMap(reviewFace);

                if (reused && faces.length === 0) return [];

                return [
                    {
                        ...shape,
                        // What is asked about: the leftovers are not the whole group.
                        itemCount: entry.openItems,
                        candidate: null,
                        faces,
                        more: Math.max(0, entry.openItems - faces.length),
                        reference: [],
                    },
                ];
            }

            const untagged = faceRepo
                .untaggedInGroups([entry.groupId], candidate.tagId, roots)
                .filter((face) => !query.media || face.kind === query.media);
            const faces = untagged.slice(0, REVIEW_FACES).flatMap(reviewFace);

            if (reused && faces.length === 0) return [];

            return [
                {
                    ...shape,
                    candidate: {
                        ...candidate,
                        untagged: untagged.length,
                        pictureUrl: pictures.get(candidate.tagId)?.smallUrl ?? null,
                    },
                    faces,
                    more: untagged.length - faces.length,
                    reference:
                        candidate.state === "resembles"
                            ? (() => {
                                  // Their reference's faces: confirmed ones, or else their tags'.
                                  const confirmed = faceRepo.confirmedFaces(
                                      candidate.tagId,
                                      roots,
                                      REFERENCE_FACES
                                  );

                                  return (
                                      confirmed.length > 0
                                          ? confirmed
                                          : faceRepo.faceFromTags(
                                                candidate.tagId,
                                                roots,
                                                REFERENCE_FACES
                                            )
                                  ).flatMap(reviewFace);
                              })()
                            : faceRepo
                                  .taggedInGroup(
                                      entry.groupId,
                                      candidate.tagId,
                                      roots,
                                      REFERENCE_FACES
                                  )
                                  .flatMap(reviewFace),
                },
            ];
        }),
        hasMore: start + query.limit < list.entries.length,
        total: list.entries.length,
        byMedia: list.byMedia,
        performer: list.performer,
    };
};

/**
 * Say which of the items shown are the performer: the ticked ones are tagged, as one batch the
 * undo list can withdraw, and their faces in the group confirmed; the unticked ones' faces there
 * are refused. Only items in the group, visible, and not yet carrying them are tagged; an item
 * somebody refused before stays refused.
 */
const decideShown = (
    groupId: string,
    tagId: string,
    tagName: string,
    shown: {
        mediaIds: string[];
        excludedMediaIds: string[];
        unsureMediaIds: string[];
        shownFaceIds: string[];
    },
    auth: AuthContext
): number => {
    // Unsure: left undecided — neither tagged, refused nor set aside — so asked about again later.
    const unsure = new Set(shown.unsureMediaIds);

    const excluded = new Set(shown.excludedMediaIds.filter((mediaId) => !unsure.has(mediaId)));

    for (const mediaId of excluded) {
        faceRepo.refuseOnItem(mediaId, tagId, [groupId], auth.userId, shown.shownFaceIds);
    }

    // Ticked as them, after all: a leftover of a mixed group was unticked for this performer
    // once, and naming it them now is the later word.
    faceRepo.withdrawRefusals(
        groupId,
        tagId,
        shown.mediaIds.filter((mediaId) => !excluded.has(mediaId))
    );

    const open = new Set(
        faceRepo
            .untaggedInGroups([groupId], tagId, auth.accessibleRootIds)
            .map((face) => face.mediaId)
    );
    const mediaIds = [...new Set(shown.mediaIds)].filter(
        (mediaId) => open.has(mediaId) && !excluded.has(mediaId) && !unsure.has(mediaId)
    );

    if (mediaIds.length === 0) {
        return 0;
    }

    faceRepo.confirmOnItems(groupId, tagId, mediaIds, auth.userId, shown.shownFaceIds);

    const { assigned } = tagBatchRepo.applyAssignments({
        userId: auth.userId,
        scope: null,
        summary: `${tagName} on ${mediaIds.length} ${mediaIds.length === 1 ? "item" : "items"}, from a face group in Review › Faces`,
        assignments: mediaIds.map((mediaId) => ({ mediaId, tagId })),
    });

    searchRepo.requestReindex(mediaIds);

    return assigned;
};

/** Answer a Review › Faces row. */
export const decideFaceReview = (
    decision: FaceReviewDecision,
    auth: AuthContext
): FaceReviewResult => {
    requireAdmin(auth);

    if (decision.verdict === "scatter") {
        faceRepo.scatterGroup(decision.groupId, auth.userId);
        // The grouping job drops the group's sums; its faces leave every reference.
        jobRepo.enqueueKind("faceGroups", 200, 60);
        jobRepo.enqueueKind("faceAnchors", 200, 120);

        return { name: null, tagged: 0, coined: false };
    }

    if (decision.verdict === "skip") {
        faceRepo.skipFaces(decision.groupId, decision.mediaIds, auth.userId);

        return { name: null, tagged: 0, coined: false };
    }

    if (decision.verdict === "refuse") {
        const tag = libraryPerformer(decision.tagId);

        faceRepo.decideGroup(
            decision.groupId,
            tag.id,
            "refuse",
            auth.userId,
            decision.shownFaceIds
        );
        confirmationsChanged();

        return { name: tag.name, tagged: 0, coined: false };
    }

    if (decision.verdict === "accept") {
        const tag = libraryPerformer(decision.tagId);
        const tagged = db.transaction(() =>
            decideShown(decision.groupId, tag.id, tag.name, decision, auth)
        )();

        confirmationsChanged();

        return { name: tag.name, tagged, coined: false };
    }

    if (!normalizeName(decision.name)) {
        throw new ValidationError("A name needs at least one letter or digit");
    }

    const instead = decision.instead ? libraryPerformer(decision.instead) : null;
    const coined = !tagRepo.resolveName("performer", decision.name, null);

    const named = db.transaction((): FaceReviewResult => {
        const tagId = tagRepo.ensureTag("performer", decision.name, null, auth.userId);
        const tag = libraryPerformer(tagId);

        // The ticked faces are someone else; the rest of the group may still be who it was.
        if (instead && instead.id !== tag.id) {
            for (const mediaId of decision.mediaIds) {
                faceRepo.refuseOnItem(
                    mediaId,
                    instead.id,
                    [decision.groupId],
                    auth.userId,
                    decision.shownFaceIds
                );
            }
        }

        return {
            name: tag.name,
            tagged: decideShown(decision.groupId, tag.id, tag.name, decision, auth),
            coined,
        };
    })();

    confirmationsChanged();

    return named;
};

const unit = (vectors: readonly Float32Array[]): Float32Array | null => {
    if (vectors.length === 0) return null;

    const sum = new Float32Array(vectors[0].length);

    for (const vector of vectors) for (let i = 0; i < sum.length; i += 1) sum[i] += vector[i];

    return normaliseVector(sum);
};

/**
 * How alike each of a row's faces is to the person it is asked about (§5f "Checking faces
 * quickly"), so the row can put the doubtful ones first.
 *
 * Against the performer's reference (`faceAnchors`) — their confirmed faces and the face their
 * tagged items share, each item once — the same score the worker matches every face by. Where
 * there is none (Unnamed, or a performer too new), against the row's own faces: their mean, then
 * the mean again without the least alike quarter, so a few strangers cannot drag the centre toward
 * themselves.
 *
 * Reads one small vectors file per item, asked for only as a row nears the screen.
 */
export const faceLikeness = (query: FaceLikenessQuery, auth: AuthContext): FaceLikeness => {
    requireAdmin(auth);

    const faceVector = faceVectorReader();
    const shown = faceRepo
        .vectorRefs(query.ids)
        .filter((row) => row.groupId === query.groupId)
        .flatMap((row) => {
            const vector = faceVector(row.mediaId, row.vectorIndex);

            return vector ? [{ ...row, vector }] : [];
        });
    if (query.tagId) libraryPerformer(query.tagId);

    const anchor = query.tagId ? faceAnchors().get(query.tagId) : undefined;
    const scores: Record<string, number> = {};

    if (anchor) {
        for (const face of shown) scores[face.id] = vectorSimilarity(anchor.centre, face.vector);
    } else if (shown.length >= 2) {
        const first = unit(shown.map((face) => face.vector))!;
        const kept = [...shown]
            .sort((a, b) => vectorSimilarity(first, b.vector) - vectorSimilarity(first, a.vector))
            .slice(0, Math.max(2, Math.ceil(shown.length * 0.75)));
        const centre = unit(kept.map((face) => face.vector))!;

        for (const face of shown) scores[face.id] = vectorSimilarity(centre, face.vector);
    }

    for (const id of Object.keys(scores)) scores[id] = Math.round(scores[id] * 1000) / 1000;

    return { scores, anchored: anchor !== undefined, doubt: FACE_DOUBT };
};

/** How many other moments of an item a closer look shows. */
const PEEK_FACES = 4;

/** A closer look at one face: the same item's other faces in the group. */
export const facePeek = (query: FacePeekQuery, auth: AuthContext): FacePeek => {
    requireAdmin(auth);

    return {
        faces: faceRepo
            .itemFacesInGroup(query.groupId, query.mediaId, auth.accessibleRootIds, PEEK_FACES)
            .flatMap(reviewFace),
    };
};

/** Fewest suggestions worth the room, most first. */
const SUSPECTS = 6;

/**
 * "Maybe in this item" (§5f "In the viewer"): library performers the item does not carry whose
 * face looks like one in it — best match them at `LOOKS_LIKE`, `LOOKS_LIKE_MARGIN` clear of anybody
 * else — or whose name it shows, with nothing refused. The surest first: strong faces, then the
 * best likeness, then the name alongside. Administrators only, as every face decision is: adding
 * one tags the library.
 */
export const itemSuspects = (mediaId: string, auth: AuthContext): ItemSuspects => {
    requireAdmin(auth);

    if (lookupMedia([mediaId], auth).items.length === 0) {
        throw new NotFoundError("Item not found");
    }

    const byTag = new Map<
        string,
        {
            face: ShownFace | null;
            score: number | null;
            strongFaces: Set<string>;
            mentions: MentionField[];
        }
    >();
    const entry = (tagId: string) => {
        let found = byTag.get(tagId);

        if (!found) {
            found = { face: null, score: null, strongFaces: new Set(), mentions: [] };
            byTag.set(tagId, found);
        }

        return found;
    };

    for (const face of faceRepo.suspectFaces(mediaId)) {
        if (face.score < LOOKS_LIKE || face.score - face.second < LOOKS_LIKE_MARGIN) continue;

        const suspect = entry(face.tagId);

        // Ordered by score, so the first is the best.
        if (!suspect.face) {
            suspect.face = face;
            suspect.score = face.score;
        }

        if (face.score >= AUTO_TAG_LINE) suspect.strongFaces.add(String(face.atMs ?? face.id));
    }

    for (const { tagId, field } of mentionRepo.untaggedPerformersNamedOn(mediaId)) {
        const suspect = entry(tagId);

        if (!suspect.mentions.includes(field)) suspect.mentions.push(field);
    }

    const suspects = [...byTag.entries()].flatMap(([tagId, suspect]): ItemSuspect[] => {
        const tag = tagRepo.findById(tagId);

        return tag
            ? [
                  {
                      tagId,
                      name: tag.name,
                      face: suspect.face ? (reviewFace(suspect.face)[0] ?? null) : null,
                      score:
                          suspect.score === null ? null : Math.round(suspect.score * 1000) / 1000,
                      strongFaces: suspect.strongFaces.size,
                      mentions: suspect.mentions,
                  },
              ]
            : [];
    });

    return {
        suspects: suspects
            .sort(
                (a, b) =>
                    b.strongFaces - a.strongFaces ||
                    (b.score ?? 0) - (a.score ?? 0) ||
                    b.mentions.length - a.mentions.length
            )
            .slice(0, SUSPECTS),
    };
};

/**
 * "Add" a suggested performer to the item — one batch the undo list can withdraw, the face shown
 * confirmed as theirs — or "Not them", which is an untag by hand's refusal: the item's faces and
 * its name match, so nothing suggests or tags them here again.
 */
export const decideItemSuspect = (
    mediaId: string,
    decision: ItemSuspectDecision,
    auth: AuthContext
): { changed: number } => {
    requireAdmin(auth);

    const tag = libraryPerformer(decision.tagId);

    if (lookupMedia([mediaId], auth).items.length === 0) {
        throw new NotFoundError("Item not found");
    }

    if (decision.verdict === "refuse") {
        db.transaction(() => notThem([mediaId], tag.id, auth.userId))();

        return { changed: 1 };
    }

    const { assigned } = db.transaction(() => {
        if (decision.faceId) faceRepo.confirmFace(decision.faceId, tag.id, auth.userId);

        const result = tagBatchRepo.applyAssignments({
            userId: auth.userId,
            scope: null,
            summary: `${tag.name} on 1 item, from "Maybe in this item"`,
            assignments: [{ mediaId, tagId: tag.id }],
        });

        searchRepo.requestReindex([mediaId]);

        return result;
    })();

    confirmationsChanged();

    return { changed: assigned };
};
