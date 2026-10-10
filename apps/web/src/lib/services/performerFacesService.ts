import {
    AuthorizationError,
    NotFoundError,
    ValidationError,
    type FaceReviewFace,
    type PerformerPeopleDecision,
    type PerformerPeoplePage,
    type PerformerPeopleQuery,
    type PersonCard,
} from "@private-stock/core";
import { appearanceRepo, db, faceDecisionRepo, faceRepo, tagRepo } from "@private-stock/db";

import type { AuthContext } from "../auth/withAuth";
import { confirmationsChanged, reviewFace } from "./faceService";
import { lookupMedia } from "./mediaService";

/**
 * A performer's Faces tab (§5f "Their faces"): everything faces say about them, each a card, each
 * correctable where it is seen.
 *
 * - **Confirmed**: one card an item, the faces confirmed as them; ✕ takes it back.
 * - **Their items**: their own items with nobody on them confirmed, each with its people; pick the
 *   one that is them. Always there, not only until a few are confirmed.
 * - **Ruled out**: one card an item, the faces refused for them; restore what was wrong.
 *
 * Administrators only, as every face decision is.
 */

/** How many more of a person's faces a card offers for a closer look. */
const OTHERS = 3;

const requireAdmin = (auth: AuthContext): void => {
    if (!auth.scopes.includes("admin")) {
        throw new AuthorizationError("Only an administrator can decide about faces");
    }
};

const libraryPerformer = (tagId: string) => {
    const tag = tagRepo.findById(tagId);

    if (!tag || tag.kind !== "performer" || tag.ownerId !== null) {
        throw new NotFoundError("Performer not found");
    }

    return tag;
};

/** A card from a person's clearest face and the faces it speaks for. */
const card = (
    id: string,
    row: { mediaId: string; kind: "video" | "image"; title: string; moments: number },
    bestFaceId: string,
    faces: readonly { id: string }[],
    crops: ReadonlyMap<string, FaceReviewFace>
): PersonCard[] => {
    const best = crops.get(bestFaceId);

    return best
        ? [
              {
                  id,
                  mediaId: row.mediaId,
                  kind: row.kind,
                  title: row.title,
                  moments: row.moments,
                  face: best,
                  others: faces
                      .filter((face) => face.id !== bestFaceId)
                      .slice(0, OTHERS)
                      .flatMap((face) => crops.get(face.id) ?? []),
                  faceIds: faces.map((face) => face.id),
              },
          ]
        : [];
};

const byItem = <T extends { mediaId: string }>(rows: readonly T[]): Map<string, T[]> => {
    const out = new Map<string, T[]>();

    for (const row of rows) out.set(row.mediaId, [...(out.get(row.mediaId) ?? []), row]);

    return out;
};

export const performerPeople = (
    tagId: string,
    query: PerformerPeopleQuery,
    auth: AuthContext
): PerformerPeoplePage => {
    requireAdmin(auth);

    const tag = libraryPerformer(tagId);
    const roots = auth.accessibleRootIds;
    const offset = query.page * query.limit;
    const noFace = faceRepo.noSingleFace(tag.id);
    const noSingleFace = noFace ? { since: noFace.decidedAt } : null;

    if (query.section === "items") {
        const { mediaIds, total } = appearanceRepo.unconfirmedItems(
            tag.id,
            roots,
            offset,
            query.limit
        );
        const people = appearanceRepo.peopleOn(mediaIds);
        const faces = appearanceRepo.appearanceFaces(people.map((person) => person.id));
        const crops = new Map(faces.flatMap(reviewFace).map((face) => [face.id, face]));
        const facesOf = new Map<string, { id: string }[]>();

        for (const face of faces) {
            facesOf.set(face.appearanceId, [...(facesOf.get(face.appearanceId) ?? []), face]);
        }

        const onItem = byItem(people);

        return {
            groups: mediaIds.flatMap((mediaId) => {
                const here = onItem.get(mediaId) ?? [];
                const cards = here.flatMap((person) =>
                    card(person.id, person, person.bestFaceId, facesOf.get(person.id) ?? [], crops)
                );

                return cards.length > 0 ? [{ mediaId, title: here[0].title, people: cards }] : [];
            }),
            hasMore: offset + query.limit < total,
            total,
            noSingleFace,
        };
    }

    const which = query.section === "confirmed" ? "confirmed" : "refused";
    const { rows, total } =
        which === "confirmed"
            ? appearanceRepo.confirmedPeople(tag.id, roots, offset, query.limit)
            : appearanceRepo.refusedPeople(tag.id, roots, query.all, offset, query.limit);
    const faces = appearanceRepo.performerFacesOn(
        tag.id,
        rows.map((row) => row.mediaId),
        which,
        query.all
    );
    const crops = new Map(faces.flatMap(reviewFace).map((face) => [face.id, face]));
    const onItem = byItem(faces);

    return {
        groups: rows.flatMap((row) => {
            const cards = card(
                row.mediaId,
                row,
                row.bestFaceId,
                onItem.get(row.mediaId) ?? [],
                crops
            );

            return cards.length > 0
                ? [{ mediaId: row.mediaId, title: row.title, people: cards }]
                : [];
        }),
        hasMore: offset + query.limit < total,
        total,
        noSingleFace,
    };
};

/**
 * Say it, a page of cards at once. Taking back and picking are one decision each, listed in
 * History and undoable there; a restore is itself the undoing of a refusal, and writes nothing
 * else. Only faces on the item named, on items this viewer can see.
 */
export const decidePerformerPeople = (
    tagId: string,
    decision: PerformerPeopleDecision,
    auth: AuthContext
): { changed: number } => {
    requireAdmin(auth);

    const tag = libraryPerformer(tagId);
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

    if (decision.action === "restore") {
        const changed = db.transaction(() =>
            people.reduce(
                (sum, person) => sum + appearanceRepo.restorePerson(person.faceIds, tag.id),
                0
            )
        )();

        confirmationsChanged();

        return { changed };
    }

    const { result: changed } = faceDecisionRepo.record(
        {
            actor: "user",
            userId: auth.userId,
            verdict: decision.action === "pick" ? "is" : "isNot",
            tagId: tag.id,
            surface: "performer",
        },
        () =>
            db.transaction(() =>
                people.reduce(
                    (sum, person) =>
                        sum +
                        (decision.action === "pick"
                            ? appearanceRepo.confirmPerson(
                                  person.faceIds,
                                  person.shownFaceId,
                                  tag.id,
                                  auth.userId
                              )
                            : appearanceRepo.takeBackPerson(
                                  person.faceIds,
                                  person.shownFaceId,
                                  tag.id,
                                  auth.userId
                              )),
                    0
                )
            )()
    );

    confirmationsChanged();

    return { changed };
};
