import {
    AuthorizationError,
    NotFoundError,
    SUGGEST_LINE,
    SUGGEST_MARGIN,
    SUGGEST_NAMED_LINE,
    ValidationError,
    type FaceReviewFace,
    type Suggestion,
    type SuggestionDecision,
    type SuggestionPerformers,
    type SuggestionPerformersQuery,
    type SuggestionsPage,
    type SuggestionsQuery,
} from "@private-stock/core";
import {
    appearanceRepo,
    db,
    faceDecisionRepo,
    searchRepo,
    tagBatchRepo,
    tagRepo,
} from "@private-stock/db";

import type { AuthContext } from "../auth/withAuth";
import { confirmationsChanged, reviewFace } from "./faceService";
import { lookupMedia } from "./mediaService";
import { picturesFor } from "./tagPictureService";

/**
 * Suggestions (§5f "Suggestions"): people in items — one person in one item — whose faces together
 * look clearly like a performer, asked about a performer at a time. Only what the data backs:
 * legible, at `SUGGEST_LINE` with `SUGGEST_MARGIN` over anybody else (or `SUGGEST_NAMED_LINE` where
 * the item's text names them), never what anybody already decided. The rest is not asked about.
 *
 * Administrators only, as every face decision is.
 */

const LINES = { line: SUGGEST_LINE, margin: SUGGEST_MARGIN, namedLine: SUGGEST_NAMED_LINE };

/** How many more of a person's faces a card offers for a closer look. */
const OTHERS = 3;

const requireAdmin = (auth: AuthContext): void => {
    if (!auth.scopes.includes("admin")) {
        throw new AuthorizationError("Only an administrator can say who is in an item");
    }
};

const libraryPerformer = (tagId: string) => {
    const tag = tagRepo.findById(tagId);

    if (!tag || tag.kind !== "performer" || tag.ownerId !== null) {
        throw new NotFoundError("Performer not found");
    }

    return tag;
};

export const suggestionPerformers = (
    query: SuggestionPerformersQuery,
    auth: AuthContext
): SuggestionPerformers => {
    requireAdmin(auth);

    const rows = appearanceRepo.suggestedPerformers(
        auth.accessibleRootIds,
        LINES,
        query.media ?? null
    );
    const pictures = picturesFor(
        rows.map((row) => row.tagId),
        auth
    );

    return {
        performers: rows.flatMap((row) => {
            const tag = tagRepo.findById(row.tagId);

            return tag
                ? [
                      {
                          tagId: tag.id,
                          name: tag.name,
                          pictureUrl: pictures.get(tag.id)?.smallUrl ?? null,
                          count: row.count,
                      },
                  ]
                : [];
        }),
    };
};

const cursor = (row: { score: number; id: string }): string => `${row.score}|${row.id}`;

const parseCursor = (raw: string | undefined): { score: number; id: string } | null => {
    if (!raw) return null;

    const at = raw.indexOf("|");
    const score = Number(raw.slice(0, at));

    return at > 0 && Number.isFinite(score) ? { score, id: raw.slice(at + 1) } : null;
};

export const suggestions = (query: SuggestionsQuery, auth: AuthContext): SuggestionsPage => {
    requireAdmin(auth);

    const tag = libraryPerformer(query.tagId);
    const rows = appearanceRepo.suggestions({
        tagId: tag.id,
        rootIds: auth.accessibleRootIds,
        lines: LINES,
        kind: query.media ?? null,
        after: parseCursor(query.after),
        limit: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    const faces = new Map<string, FaceReviewFace[]>();
    const ids = new Map<string, string[]>();

    for (const face of appearanceRepo.appearanceFaces(page.map((row) => row.id))) {
        faces.set(face.appearanceId, [
            ...(faces.get(face.appearanceId) ?? []),
            ...reviewFace(face),
        ]);
        ids.set(face.appearanceId, [...(ids.get(face.appearanceId) ?? []), face.id]);
    }

    return {
        performer: {
            id: tag.id,
            name: tag.name,
            pictureUrl: picturesFor([tag.id], auth).get(tag.id)?.smallUrl ?? null,
        },
        suggestions: page.flatMap((row): Suggestion[] => {
            const own = faces.get(row.id) ?? [];
            const best = own.find((face) => face.id === row.bestFaceId) ?? own[0];

            return best
                ? [
                      {
                          id: row.id,
                          mediaId: row.mediaId,
                          kind: row.kind,
                          title: row.title,
                          moments: row.faceCount,
                          face: best,
                          others: own.filter((face) => face.id !== best.id).slice(0, OTHERS),
                          faceIds: ids.get(row.id) ?? [],
                          score: row.score,
                          named: row.named === 1,
                      },
                  ]
                : [];
        }),
        next: rows.length > query.limit ? cursor(page[page.length - 1]) : null,
    };
};

/**
 * Say who people in items are, a page of cards at once: one decision, listed in History and
 * undoable there. Those that are them tag their items, as one batch, and confirm their faces; those
 * that are not are refused for the performer — the person, not the item. Only faces on the item
 * named, on items this viewer can see.
 */
export const decideSuggestions = (
    decision: SuggestionDecision,
    auth: AuthContext
): { tagged: number; refused: number } => {
    requireAdmin(auth);

    const tag = libraryPerformer(decision.tagId);
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

    const them = people.filter((person) => person.verdict === "is");
    const notThem = people.filter((person) => person.verdict === "isNot");

    const { result } = faceDecisionRepo.record(
        {
            actor: "user",
            userId: auth.userId,
            verdict: them.length > 0 ? "is" : "isNot",
            tagId: tag.id,
            surface: "review",
        },
        () =>
            db.transaction(() => {
                for (const person of them) {
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

                const mediaIds = [...new Set(them.map((person) => person.mediaId))];
                const tagged =
                    mediaIds.length > 0
                        ? tagBatchRepo.applyAssignments({
                              userId: auth.userId,
                              scope: null,
                              summary: `${tag.name} on ${mediaIds.length} ${mediaIds.length === 1 ? "item" : "items"}, from Suggestions`,
                              assignments: mediaIds.map((mediaId) => ({ mediaId, tagId: tag.id })),
                          }).assigned
                        : 0;

                searchRepo.requestReindex(mediaIds);

                return { tagged, refused: notThem.length };
            })()
    );

    confirmationsChanged();

    return result;
};
