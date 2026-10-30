import {
    AuthorizationError,
    NEW_PERSON_MIN_ITEMS,
    NotFoundError,
    ValidationError,
    normalizeName,
    type NewPeopleDecision,
    type NewPeoplePage,
    type NewPeopleQuery,
    type PersonCard,
} from "@private-stock/core";
import {
    appearanceRepo,
    db,
    faceDecisionRepo,
    jobRepo,
    searchRepo,
    tagBatchRepo,
    tagRepo,
} from "@private-stock/db";

import type { AuthContext } from "../auth/withAuth";
import { confirmationsChanged, reviewFace } from "./faceService";
import { lookupMedia } from "./mediaService";
import { vocabularyChanged } from "./ocrMatchHooks";

/**
 * New people (§5f "New people"): people in items who match nobody known, gathered across the
 * library — only gatherings on `NEW_PERSON_MIN_ITEMS` items or more, the most items first, a few
 * cards each, one an item. Name them — a performer, coined if new — and their items are tagged and
 * their faces confirmed, which is a reference for every other item of theirs; or say they are not
 * one person, or put them off. What replaces Unnamed.
 *
 * Administrators only, as every face decision is.
 */

/** How many of a new person's items are shown to name them by. */
const CARDS = 8;

/** How many more of a person's faces a card offers for a closer look. */
const OTHERS = 3;

const requireAdmin = (auth: AuthContext): void => {
    if (!auth.scopes.includes("admin")) {
        throw new AuthorizationError("Only an administrator can name people");
    }
};

export const newPeople = (query: NewPeopleQuery, auth: AuthContext): NewPeoplePage => {
    requireAdmin(auth);

    const roots = auth.accessibleRootIds;
    const offset = query.page * query.limit;
    const { rows, total } = appearanceRepo.newPeople(
        roots,
        NEW_PERSON_MIN_ITEMS,
        offset,
        query.limit
    );
    const people = appearanceRepo.newPersonPeople(
        rows.map((row) => row.newPersonId),
        roots,
        CARDS
    );
    const faces = appearanceRepo.appearanceFaces(people.map((person) => person.id));
    const crops = new Map(faces.flatMap(reviewFace).map((face) => [face.id, face]));
    const facesOf = new Map<string, string[]>();

    for (const face of faces) {
        facesOf.set(face.appearanceId, [...(facesOf.get(face.appearanceId) ?? []), face.id]);
    }

    return {
        people: rows.map((row) => ({
            id: row.newPersonId,
            items: row.items,
            cards: people
                .filter((person) => person.newPersonId === row.newPersonId)
                .flatMap((person): PersonCard[] => {
                    const best = crops.get(person.bestFaceId);
                    const own = facesOf.get(person.id) ?? [];

                    return best
                        ? [
                              {
                                  id: person.id,
                                  mediaId: person.mediaId,
                                  kind: person.kind,
                                  title: person.title,
                                  moments: person.moments,
                                  face: best,
                                  others: own
                                      .filter((id) => id !== person.bestFaceId)
                                      .slice(0, OTHERS)
                                      .flatMap((id) => crops.get(id) ?? []),
                                  faceIds: own,
                              },
                          ]
                        : [];
                }),
        })),
        hasMore: offset + query.limit < total,
        total,
    };
};

/**
 * Say who a new person is, or that they are not one person, or later: one decision, listed in
 * History and undoable there. Only faces on the items named, on items this viewer can see.
 */
export const decideNewPeople = (
    decision: NewPeopleDecision,
    auth: AuthContext
): { changed: number; name: string | null } => {
    requireAdmin(auth);

    const visible = new Set(
        lookupMedia(
            decision.people.map((person) => person.mediaId),
            auth
        ).items.map((item) => item.id)
    );
    const people = decision.people.flatMap((person) => {
        if (!visible.has(person.mediaId)) return [];

        const faceIds = appearanceRepo.facesOnItem(person.mediaId, person.faceIds);

        return faceIds.length > 0 ? [{ ...person, faceIds }] : [];
    });

    if (people.length === 0) {
        throw new ValidationError("None of those are there to decide about any more");
    }

    if (decision.action === "name" && !normalizeName(decision.name)) {
        throw new ValidationError("A name needs at least one letter or digit");
    }

    const coins =
        decision.action === "name" && !tagRepo.resolveName("performer", decision.name, null);

    const faceIds = people.flatMap((person) => person.faceIds);
    const verdict =
        decision.action === "name" ? "is" : decision.action === "later" ? "later" : "notOnePerson";

    const { result } = faceDecisionRepo.record(
        { actor: "user", userId: auth.userId, verdict, tagId: null, surface: "review" },
        () =>
            db.transaction((): { changed: number; name: string | null } => {
                if (decision.action === "notOnePerson") {
                    return {
                        changed: appearanceRepo.scatterPeople(faceIds, auth.userId),
                        name: null,
                    };
                }

                if (decision.action === "later") {
                    return {
                        changed: appearanceRepo.setAsidePeople(faceIds, auth.userId),
                        name: null,
                    };
                }

                const tagId = tagRepo.ensureTag("performer", decision.name, null, auth.userId);
                const tag = tagRepo.findById(tagId);

                if (!tag || tag.kind !== "performer" || tag.ownerId !== null) {
                    throw new NotFoundError("Performer not found");
                }

                faceDecisionRepo.nameActive(tag.id);

                for (const person of people) {
                    appearanceRepo.confirmPerson(
                        person.faceIds,
                        person.shownFaceId,
                        tag.id,
                        auth.userId
                    );
                }

                const mediaIds = [...new Set(people.map((person) => person.mediaId))];
                const { assigned } = tagBatchRepo.applyAssignments({
                    userId: auth.userId,
                    scope: null,
                    summary: `${tag.name} on ${mediaIds.length} ${mediaIds.length === 1 ? "item" : "items"}, from New people`,
                    assignments: mediaIds.map((mediaId) => ({ mediaId, tagId: tag.id })),
                });

                searchRepo.requestReindex(mediaIds);

                return { changed: assigned, name: tag.name };
            })()
    );

    // Their reference is built from what was confirmed; what was scattered leaves the gatherings.
    confirmationsChanged();
    if (decision.action !== "name") jobRepo.enqueueKind("faceAnchors", 200, 60);
    // A new name: until the rematch, nothing names them, so their Find untagged is empty (§5b).
    if (coins) vocabularyChanged("performer", null);

    return result;
};
