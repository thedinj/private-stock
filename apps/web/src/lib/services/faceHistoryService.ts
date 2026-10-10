import {
    AuthorizationError,
    ConflictError,
    NotFoundError,
    type FaceHistoryEntry,
    type FaceHistoryPage,
    type FaceHistoryQuery,
    type FaceReviewFace,
    type FaceUndo,
} from "@private-stock/core";
import {
    db,
    faceAutoTagRepo,
    faceDecisionRepo,
    faceRepo,
    jobRepo,
    searchRepo,
    tagBatchRepo,
    type DecisionRow,
} from "@private-stock/db";

import type { AuthContext } from "../auth/withAuth";
import { reviewFace } from "./faceService";
import { notThem } from "./notThem";
import { batchUndone } from "./ocrMatchHooks";

/**
 * History (§5f "Decisions you can take back"): every face decision, newest first, by a person or by
 * the app tagging by itself — and undo, which takes back exactly what one wrote.
 *
 * Administrators only, as every face decision is.
 */

const requireAdmin = (auth: AuthContext): void => {
    if (!auth.scopes.includes("admin")) {
        throw new AuthorizationError("Only an administrator can see or undo face decisions");
    }
};

/** How many faces an entry shows of what it decided. */
const SHOWN = 4;

/** These faces as a list shows them, in the order given. */
const shown = (faceIds: readonly string[]): FaceReviewFace[] => {
    const byId = new Map(faceRepo.shownFaces(faceIds).map((face) => [face.id, face]));

    return faceIds.flatMap((id) => {
        const face = byId.get(id);

        return face ? reviewFace(face) : [];
    });
};

/** The faces to show for a decision: its own, or — for the app's tags — the faces that matched. */
const facesOf = (row: DecisionRow): FaceReviewFace[] => {
    const own = faceDecisionRepo.sampleFaceIds(row.id, SHOWN);

    if (own.length > 0 || !row.tagBatchId || !row.tagId) return shown(own);

    const matched = faceDecisionRepo
        .batchItems(row.tagBatchId, SHOWN)
        .flatMap((mediaId) => faceAutoTagRepo.find(mediaId, row.tagId!)?.faceId ?? []);

    return shown(matched);
};

const cursor = (row: { createdAt: string; id: string }): string => `${row.createdAt}|${row.id}`;

const parseCursor = (raw: string | undefined): { createdAt: string; id: string } | null => {
    if (!raw) return null;

    const at = raw.lastIndexOf("|");

    return at > 0 ? { createdAt: raw.slice(0, at), id: raw.slice(at + 1) } : null;
};

export const faceHistory = (query: FaceHistoryQuery, auth: AuthContext): FaceHistoryPage => {
    requireAdmin(auth);

    const rows = faceDecisionRepo.page({
        actor: query.actor === "all" ? null : query.actor,
        tagId: query.tagId ?? null,
        before: parseCursor(query.before),
        limit: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);

    return {
        entries: page.map((row): FaceHistoryEntry => ({
            id: row.id,
            actor: row.actor,
            verdict: row.verdict,
            surface: row.surface,
            performer:
                row.tagId && row.tagName !== null ? { id: row.tagId, name: row.tagName } : null,
            faceCount: row.faceCount,
            itemCount: row.itemCount,
            faces: facesOf(row),
            tagged: row.tagBatchId !== null,
            createdAt: row.createdAt,
            undoneAt: row.undoneAt,
        })),
        next: rows.length > query.limit ? cursor(page[page.length - 1]) : null,
    };
};

/**
 * Undo one decision: its tag batch withdrawn, if it made one and it still stands; every
 * confirmation, refusal, can't-tell and not-one-person it wrote that still stands taken back. A
 * later decision's rows are that decision's and stay.
 *
 * `wrong`, for the app's own tags: also "not them" on those items, as an untag by hand is — so the
 * app never tags them again, and it counts against tagging by itself (§5f "Tagging by itself").
 */
export const undoFaceDecision = (
    id: string,
    input: FaceUndo,
    auth: AuthContext
): { undone: true } => {
    requireAdmin(auth);

    const decision = faceDecisionRepo.find(id);

    if (!decision) {
        throw new NotFoundError("That decision is not there any more");
    }

    if (decision.undoneAt) {
        throw new ConflictError("That decision has already been undone");
    }

    const batch = decision.tagBatchId
        ? tagBatchRepo.findById(decision.tagBatchId, auth.userId, true)
        : undefined;
    const live = batch && !batch.undoneAt ? batch.id : null;
    // Read before the batch goes: afterwards nothing says which items it held.
    const items = live ? tagBatchRepo.affectedMediaIds(live) : [];
    const tagIds = live ? tagBatchRepo.affectedTagIds(live) : [];

    const { scattered } = db.transaction(() => {
        if (live) tagBatchRepo.undo(live);

        const result = faceDecisionRepo.undo(id, auth.userId);

        if (input.wrong && decision.actor === "app" && decision.tagId && items.length > 0) {
            notThem(items, decision.tagId, auth.userId, "history");
        }

        return result;
    })();

    if (live) {
        searchRepo.requestReindex(items);
        batchUndone(live, items, tagIds);
    }

    // References, matches and pictures rest on what was confirmed.
    jobRepo.enqueueKind("faceAnchors", 200, 120);
    jobRepo.enqueueKind("tagPictures", 200, 120);
    // People and new people are made again without what was taken out, or with it back.
    if (scattered > 0) jobRepo.enqueueKind("faceAnchors", 200, 60);

    return { undone: true };
};
