import {
    AuthorizationError,
    FACE_SEARCH_RESULTS,
    NotFoundError,
    ValidationError,
    storedFaceSearchSchema,
    type FaceSearch,
    type FaceSearchMatches,
    type FaceSearchStart,
    type StoredFaceSearch,
} from "@private-stock/core";
import { appearanceRepo, faceRepo, faceSearchRepo, tagRepo } from "@private-stock/db";

import type { AuthContext } from "../auth/withAuth";
import { reviewFace } from "./faceService";
import { lookupMedia } from "./mediaService";

/**
 * Who is this? (§5f "Who is this?"): the faces on the frame somebody had on screen, and for the one
 * they choose, the items across the library whose faces are most like it — however weak the best
 * of them, since the question is where somebody was seen before.
 *
 * Administrators only, as every face surface is.
 */

/** How many of the same person's other moments a match offers for a closer look. */
const OTHERS = 3;

const requireAdmin = (auth: AuthContext): void => {
    if (!auth.scopes.includes("admin")) {
        throw new AuthorizationError("Only an administrator can search the library's faces");
    }
};

const visibleItem = (mediaId: string, auth: AuthContext) => {
    const [item] = lookupMedia([mediaId], auth).items;

    if (!item) {
        throw new NotFoundError("Item not found");
    }

    return item;
};

/** The search, if it is one the asker may see: its item must be visible to them. */
const visibleSearch = (id: string, auth: AuthContext) => {
    requireAdmin(auth);

    const row = faceSearchRepo.find(id);

    if (!row) {
        throw new NotFoundError("That search has gone. Ask again from the video.");
    }

    visibleItem(row.mediaId, auth);

    return row;
};

const storedOf = (resultJson: string | null): StoredFaceSearch =>
    resultJson ? storedFaceSearchSchema.parse(JSON.parse(resultJson)) : [];

export const startFaceSearch = (input: FaceSearchStart, auth: AuthContext): FaceSearch => {
    requireAdmin(auth);

    const item = visibleItem(input.mediaId, auth);

    if (item.kind !== "video") {
        throw new ValidationError("Only a video's frame can be asked about");
    }

    return faceSearch(faceSearchRepo.start(item.id, input.atMs, auth.userId), auth);
};

export const faceSearch = (id: string, auth: AuthContext): FaceSearch => {
    const row = visibleSearch(id, auth);

    faceSearchRepo.requeueIfStranded(row, auth.userId);

    return {
        id: row.id,
        state: row.state,
        error: row.error,
        faces: storedOf(row.resultJson).map(({ x, y, w, h }) => ({ x, y, w, h })),
    };
};

/** The items most like face `index` of the frame, best first, those the asker can see. */
export const faceSearchMatches = (
    id: string,
    index: number,
    auth: AuthContext
): FaceSearchMatches => {
    const row = visibleSearch(id, auth);
    const face = storedOf(row.resultJson)[index];

    if (!face) {
        throw new NotFoundError("That face is not on the frame");
    }

    const scoreOf = new Map(face.matches.map((match) => [match.mediaId, match.score]));
    const items = new Map(
        lookupMedia(
            face.matches.map((match) => match.mediaId),
            auth
        ).items.map((item) => [item.id, item])
    );
    const found = faceRepo
        .shownFacesAt(face.matches.filter((match) => items.has(match.mediaId)))
        .sort((a, b) => scoreOf.get(b.mediaId)! - scoreOf.get(a.mediaId)!)
        .slice(0, FACE_SEARCH_RESULTS);

    const confirmedTags = new Map(
        [...new Set(found.flatMap((shown) => (shown.tagId ? [shown.tagId] : [])))].flatMap(
            (tagId) => {
                const tag = tagRepo.findById(tagId);

                return tag ? [[tagId, tag.name] as const] : [];
            }
        )
    );
    const performers = new Map<string, string[]>();
    // The person each matched face is in its item, and their clearest few faces there: one query
    // for the page rather than one as each closer look opens.
    const others = new Map<string, FaceSearchMatches["matches"][number]["others"]>();

    for (const theirs of appearanceRepo.appearanceFaces(
        found.flatMap((shown) => (shown.appearanceId ? [shown.appearanceId] : []))
    )) {
        const kept = others.get(theirs.appearanceId) ?? [];

        // One more than shown: the face matched may be among them, and is left out below.
        if (kept.length <= OTHERS) {
            others.set(theirs.appearanceId, [...kept, ...reviewFace(theirs)]);
        }
    }

    for (const tag of tagRepo.listForMediaIds(
        found.map((shown) => shown.mediaId),
        auth.userId
    )) {
        if (tag.kind === "performer") {
            performers.set(tag.mediaId, [...(performers.get(tag.mediaId) ?? []), tag.name]);
        }
    }

    return {
        matches: found.flatMap((shown) =>
            reviewFace(shown).map((reviewed) => {
                const name = shown.tagId ? confirmedTags.get(shown.tagId) : undefined;

                return {
                    face: reviewed,
                    title: items.get(shown.mediaId)!.title,
                    score: scoreOf.get(shown.mediaId)!,
                    confirmed: shown.tagId && name ? { tagId: shown.tagId, name } : null,
                    performers: performers.get(shown.mediaId) ?? [],
                    others: ((shown.appearanceId ? others.get(shown.appearanceId) : null) ?? [])
                        .filter((other) => other.id !== shown.id)
                        .slice(0, OTHERS),
                };
            })
        ),
    };
};
