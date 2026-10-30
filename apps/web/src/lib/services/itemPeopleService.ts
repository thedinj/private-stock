import {
    AuthorizationError,
    NotFoundError,
    SUGGEST_LINE,
    SUGGEST_MARGIN,
    SUGGEST_NAMED_LINE,
    ValidationError,
    normalizeName,
    type ItemPeople,
    type ItemPeopleDecision,
} from "@private-stock/core";
import {
    appearanceRepo,
    db,
    faceDecisionRepo,
    mentionRepo,
    searchRepo,
    tagBatchRepo,
    tagRepo,
} from "@private-stock/db";

import type { AuthContext } from "../auth/withAuth";
import { confirmationsChanged, reviewFace } from "./faceService";
import { lookupMedia } from "./mediaService";
import { notThem } from "./notThem";
import { vocabularyChanged } from "./ocrMatchHooks";
import { picturesFor } from "./tagPictureService";

/**
 * People in this item (§5f "People in this item"): every person in it, with what is known of them
 * — confirmed by you or tagged by the app, suggested at the same lines Suggestions uses, or nobody
 * yet — and the performers the item's own text names who are not on it. Every decision here is one
 * decision in History. What replaces "Maybe in this item".
 *
 * Administrators only, as every face decision is.
 */

/** How many more of a person's faces a card offers for a closer look. */
const OTHERS = 3;

const requireAdmin = (auth: AuthContext): void => {
    if (!auth.scopes.includes("admin")) {
        throw new AuthorizationError("Only an administrator can say who is in an item");
    }
};

const visibleItem = (mediaId: string, auth: AuthContext) => {
    const [item] = lookupMedia([mediaId], auth).items;

    if (!item) {
        throw new NotFoundError("Item not found");
    }

    return item;
};

const libraryPerformer = (tagId: string) => {
    const tag = tagRepo.findById(tagId);

    if (!tag || tag.kind !== "performer" || tag.ownerId !== null) {
        throw new NotFoundError("Performer not found");
    }

    return tag;
};

export const itemPeople = (mediaId: string, auth: AuthContext): ItemPeople => {
    requireAdmin(auth);

    const item = visibleItem(mediaId, auth);
    const rows = appearanceRepo.itemPeople(mediaId);
    const faces = appearanceRepo.appearanceFaces(rows.map((row) => row.id));
    const crops = new Map(faces.flatMap(reviewFace).map((face) => [face.id, face]));
    const named = mentionRepo.untaggedPerformersNamedOn(mediaId);
    const namedTags = new Set(named.map((row) => row.tagId));
    // The library's tags on it: who it carries, and whether the app put them there.
    const carried = new Map(
        tagRepo
            .listForMedia(mediaId, null)
            .filter((tag) => tag.private === null)
            .map((tag) => [tag.tagId, tag])
    );
    // Everybody the people are confirmed as or matched to: their pictures, to compare with.
    const pictures = picturesFor(
        rows.flatMap((row) => [row.confirmedTagId, row.matchTagId]).filter((id) => id !== null),
        auth
    );
    const nameOf = (tagId: string) => {
        const tag = tagRepo.findById(tagId);

        return tag && tag.kind === "performer" && tag.ownerId === null
            ? { id: tag.id, name: tag.name, pictureUrl: pictures.get(tag.id)?.smallUrl ?? null }
            : null;
    };

    const people = rows.flatMap((row): ItemPeople["people"] => {
        const own = faces.filter((face) => face.appearanceId === row.id);
        const best = crops.get(row.bestFaceId);

        if (!best) return [];

        const card = {
            id: row.id,
            mediaId,
            kind: item.kind,
            title: item.title,
            moments: row.moments,
            face: best,
            others: own
                .filter((face) => face.id !== row.bestFaceId)
                .slice(0, OTHERS)
                .flatMap((face) => crops.get(face.id) ?? []),
            faceIds: own.map((face) => face.id),
        };

        if (row.confirmedTagId) {
            const performer = nameOf(row.confirmedTagId);
            const tag = carried.get(row.confirmedTagId);

            return [
                {
                    card,
                    state: "confirmed" as const,
                    performer,
                    byApp: tag?.source === "ai",
                    tagged: tag !== undefined,
                },
            ];
        }

        const suggested =
            row.matchTagId !== null &&
            row.legible === 1 &&
            row.refusedMatch === 0 &&
            row.score !== null &&
            row.second !== null &&
            row.score - row.second >= SUGGEST_MARGIN &&
            (row.score >= SUGGEST_LINE ||
                (row.score >= SUGGEST_NAMED_LINE && namedTags.has(row.matchTagId)));
        const performer = suggested && row.matchTagId ? nameOf(row.matchTagId) : null;

        return [
            {
                card,
                state: performer ? ("suggested" as const) : ("unknown" as const),
                performer,
                byApp: false,
                tagged: performer ? carried.has(performer.id) : false,
            },
        ];
    });
    const suggestedIds = new Set(people.flatMap((person) => person.performer?.id ?? []));
    const fields = new Map<string, Set<(typeof named)[number]["field"]>>();

    for (const row of named) {
        if (!suggestedIds.has(row.tagId)) {
            fields.set(row.tagId, (fields.get(row.tagId) ?? new Set()).add(row.field));
        }
    }

    return {
        people,
        named: [...fields].flatMap(([tagId, set]) => {
            const performer = nameOf(tagId);

            return performer ? [{ tagId, name: performer.name, fields: [...set] }] : [];
        }),
    };
};

/** Tag the item as them, if it does not carry them yet. Returns the items tagged. */
const tagItem = (mediaId: string, tagId: string, name: string, userId: string): number => {
    const { assigned } = tagBatchRepo.applyAssignments({
        userId,
        scope: null,
        summary: `${name} on 1 item, from "People in this item"`,
        assignments: [{ mediaId, tagId }],
    });

    searchRepo.requestReindex([mediaId]);

    return assigned;
};

export const decideItemPeople = (
    mediaId: string,
    decision: ItemPeopleDecision,
    auth: AuthContext
): { changed: number } => {
    requireAdmin(auth);
    visibleItem(mediaId, auth);

    if (decision.action === "refuseNamed") {
        const tag = libraryPerformer(decision.tagId);

        db.transaction(() => notThem([mediaId], tag.id, auth.userId, "item"))();

        return { changed: 1 };
    }

    const person =
        "person" in decision
            ? {
                  faceIds: appearanceRepo.facesOnItem(mediaId, decision.person.faceIds),
                  shownFaceId: decision.person.shownFaceId,
              }
            : null;

    if (person && person.faceIds.length === 0) {
        throw new ValidationError("That person is not in this item any more. Reload it.");
    }

    if (decision.action === "name" && !normalizeName(decision.name)) {
        throw new ValidationError("A name needs at least one letter or digit");
    }

    const coins =
        decision.action === "name" && !tagRepo.resolveName("performer", decision.name, null);

    const press = (tagId: string | null, verdict: "is" | "isNot") => ({
        actor: "user" as const,
        userId: auth.userId,
        verdict,
        tagId,
        surface: "item" as const,
    });

    const { result: changed } = faceDecisionRepo.record(
        press(
            "tagId" in decision ? decision.tagId : null,
            decision.action === "isNot" ? "isNot" : "is"
        ),
        () =>
            db.transaction((): number => {
                if (decision.action === "addNamed") {
                    const tag = libraryPerformer(decision.tagId);

                    return tagItem(mediaId, tag.id, tag.name, auth.userId);
                }

                const tag =
                    decision.action === "name"
                        ? libraryPerformer(
                              tagRepo.ensureTag("performer", decision.name, null, auth.userId)
                          )
                        : libraryPerformer(decision.tagId);

                faceDecisionRepo.nameActive(tag.id);

                if (decision.action === "isNot") {
                    return appearanceRepo.takeBackPerson(
                        person!.faceIds,
                        person!.shownFaceId,
                        tag.id,
                        auth.userId
                    );
                }

                return (
                    appearanceRepo.confirmPerson(
                        person!.faceIds,
                        person!.shownFaceId,
                        tag.id,
                        auth.userId
                    ) + tagItem(mediaId, tag.id, tag.name, auth.userId)
                );
            })()
    );

    confirmationsChanged();

    // A new name: until the rematch, nothing names them, so their Find untagged is empty (§5b).
    if (coins) vocabularyChanged("performer", null);

    return { changed };
};
