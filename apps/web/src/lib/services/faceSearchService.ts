import {
    AuthorizationError,
    FACE_SEARCH_RESULTS,
    NotFoundError,
    ValidationError,
    normalizeName,
    storedFaceSearchSchema,
    type FaceSearch,
    type FaceSearchMatches,
    type FaceSearchName,
    type FaceSearchStart,
    type StoredFaceSearch,
} from "@private-stock/core";
import {
    appearanceRepo,
    db,
    faceDecisionRepo,
    faceRepo,
    faceSearchRepo,
    searchRepo,
    tagBatchRepo,
    tagRepo,
} from "@private-stock/db";

import type { AuthContext } from "../auth/withAuth";
import { confirmationsChanged, reviewFace } from "./faceService";
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

/** How many names a search offers as who the face most likely is. */
const LIKELY = 4;

/**
 * Who face `face` most likely is, best first: whom its person is already confirmed as in the video
 * asked from, then the performers whose references are most like it. A search made before the
 * references were asked falls back on the names the matches are confirmed as, most often first.
 */
const likelyPerformers = (
    mediaId: string,
    face: StoredFaceSearch[number],
    found: readonly { tagId: string | null }[],
    auth: AuthContext
): FaceSearchMatches["likely"] => {
    const [here] = face.self
        ? faceRepo.shownFacesAt([{ mediaId, vectorIndex: face.self.vectorIndex }])
        : [];
    const tally = new Map<string, number>();

    for (const shown of found) {
        if (shown.tagId) tally.set(shown.tagId, (tally.get(shown.tagId) ?? 0) + 1);
    }

    const byReference: Pick<FaceSearchMatches["likely"][number], "tagId" | "score">[] =
        face.performers ??
        [...tally].sort((a, b) => b[1] - a[1]).map(([tagId]) => ({ tagId, score: null }));
    const candidates = [
        ...(here?.tagId
            ? [
                  {
                      tagId: here.tagId,
                      score: byReference.find((match) => match.tagId === here.tagId)?.score ?? null,
                      here: true,
                  },
              ]
            : []),
        ...byReference
            .filter((match) => match.tagId !== here?.tagId)
            .map((match) => ({ ...match, here: false })),
    ];

    return candidates
        .flatMap((candidate) => {
            const tag = tagRepo.findById(candidate.tagId);

            return tag?.kind === "performer" &&
                (tag.ownerId === null || tag.ownerId === auth.userId)
                ? [{ ...candidate, name: tag.name }]
                : [];
        })
        .slice(0, LIKELY);
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
    // And every face of theirs there, which is what saying who they are is about.
    const everyFace = new Map<string, string[]>();

    for (const theirs of appearanceRepo.appearanceFaces(
        found.flatMap((shown) => (shown.appearanceId ? [shown.appearanceId] : []))
    )) {
        const kept = others.get(theirs.appearanceId) ?? [];

        everyFace.set(theirs.appearanceId, [
            ...(everyFace.get(theirs.appearanceId) ?? []),
            theirs.id,
        ]);

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
        likely: likelyPerformers(row.mediaId, face, found, auth),
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
                    // A face seen once is nobody's person, and is itself all there is to say.
                    faceIds: (shown.appearanceId ? everyFace.get(shown.appearanceId) : null) ?? [
                        shown.id,
                    ],
                };
            })
        ),
    };
};

/**
 * The person on the frame, in the item asked from: the stored face the search found to be them,
 * and every face of their person there. Null when none was near enough, or the faces have been read
 * again since — the item is then tagged and nothing in it confirmed.
 */
const sourcePerson = (
    mediaId: string,
    self: StoredFaceSearch[number]["self"]
): { faceIds: string[]; shownFaceId: string } | null => {
    if (!self) return null;

    const [shown] = faceRepo.shownFacesAt([{ mediaId, vectorIndex: self.vectorIndex }]);

    if (!shown) return null;

    const faceIds = shown.appearanceId
        ? appearanceRepo.appearanceFaces([shown.appearanceId]).map((face) => face.id)
        : [];

    return { faceIds: faceIds.length > 0 ? faceIds : [shown.id], shownFaceId: shown.id };
};

/**
 * Say who face `index` of the frame is (§5f "Who is this?"): one decision, in History and undone
 * there. The video asked from is always tagged, and the person on its frame confirmed when the
 * search found which of its stored people that is; the candidates said to be them are tagged and
 * their faces confirmed; those said not to be are refused for the performer — the person, not the
 * item. Only candidates this viewer can see, and only faces on their items.
 */
export const nameFromSearch = (
    id: string,
    index: number,
    decision: FaceSearchName,
    auth: AuthContext
): { tagId: string; name: string; tagged: number; refused: number } => {
    const row = visibleSearch(id, auth);
    const face = storedOf(row.resultJson)[index];

    if (!face) {
        throw new NotFoundError("That face is not on the frame");
    }

    if (decision.performer.by === "name" && !normalizeName(decision.performer.name)) {
        throw new ValidationError("A name needs at least one letter or digit");
    }

    const visible = new Set(
        lookupMedia(
            decision.people.map((person) => person.mediaId),
            auth
        ).items.map((item) => item.id)
    );
    const people = decision.people.flatMap((person) => {
        if (!visible.has(person.mediaId) || person.mediaId === row.mediaId) return [];

        const faceIds = appearanceRepo.facesOnItem(person.mediaId, person.faceIds);

        return faceIds.length > 0 ? [{ ...person, faceIds }] : [];
    });
    const source = sourcePerson(row.mediaId, face.self);
    const them = people.filter((person) => person.verdict === "is");
    const notThem = people.filter((person) => person.verdict === "isNot");

    const { result } = faceDecisionRepo.record(
        {
            actor: "user",
            userId: auth.userId,
            verdict: "is",
            tagId: decision.performer.by === "id" ? decision.performer.tagId : null,
            surface: "search",
        },
        () =>
            db.transaction(() => {
                const tagId =
                    decision.performer.by === "id"
                        ? decision.performer.tagId
                        : tagRepo.ensureTag(
                              "performer",
                              decision.performer.name,
                              null,
                              auth.userId
                          );
                const tag = tagRepo.findById(tagId);

                if (!tag || tag.kind !== "performer" || tag.ownerId !== null) {
                    throw new NotFoundError("Performer not found");
                }

                faceDecisionRepo.nameActive(tag.id);

                for (const person of [...(source ? [source] : []), ...them]) {
                    appearanceRepo.confirmPerson(
                        person.faceIds,
                        person.shownFaceId,
                        tag.id,
                        auth.userId
                    );
                }

                for (const person of notThem) {
                    appearanceRepo.refusePerson(
                        person.faceIds,
                        person.shownFaceId,
                        tag.id,
                        auth.userId
                    );
                }

                const mediaIds = [row.mediaId, ...new Set(them.map((person) => person.mediaId))];
                const { assigned } = tagBatchRepo.applyAssignments({
                    userId: auth.userId,
                    scope: null,
                    summary: `${tag.name} on ${mediaIds.length} ${
                        mediaIds.length === 1 ? "item" : "items"
                    }, from Who is this?`,
                    assignments: mediaIds.map((mediaId) => ({ mediaId, tagId: tag.id })),
                });

                searchRepo.requestReindex(mediaIds);

                return { tagId: tag.id, name: tag.name, tagged: assigned, refused: notThem.length };
            })()
    );

    confirmationsChanged();

    return result;
};
