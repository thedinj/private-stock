import {
    AuthorizationError,
    NotFoundError,
    SETTING_KEYS,
    autoTagBraked,
    faceAutoTagSettingSchema,
    type AutoTagDecision,
    type AutoTagSwitch,
    type AutoTagEntry,
    type AutoTagPage,
    type AutoTagQuery,
} from "@private-stock/core";
import {
    db,
    faceAutoTagRepo,
    faceDecisionRepo,
    faceRepo,
    jobRepo,
    searchRepo,
    settingRepo,
    tagBatchRepo,
    tagRepo,
} from "@private-stock/db";

import type { AuthContext } from "../auth/withAuth";
import { faceCrop } from "./faceService";
import { lookupMedia } from "./mediaService";
import { notThem } from "./notThem";

/**
 * Tagging by itself, checked first (§5f "Tagging by itself"): the "Would tag" list.
 *
 * Every item the rule would tag as a performer, in a random order a visit keeps — so the first
 * fifty checked are a fair sample of all of them, not the surest fifty — each with the face that
 * matched best. "Right" tags it, as one batch the undo list can withdraw, and confirms that face;
 * "Wrong" refuses it, so the rule never proposes it again. The counts say how often the rule is
 * right, which is the one number that decides whether it may tag by itself.
 *
 * Administrators only, as every face decision is.
 */

const requireAdmin = (auth: AuthContext): void => {
    if (!auth.scopes.includes("admin")) {
        throw new AuthorizationError("Only an administrator can check what faces would tag");
    }
};

/** A stable shuffle: the same seed gives the same order, a new visit a new one. */
const rank = (seed: number, key: string): number => {
    let hash = seed ^ 0x9e3779b9;

    for (let i = 0; i < key.length; i += 1) {
        hash = Math.imul(hash ^ key.charCodeAt(i), 0x01000193);
    }

    return hash >>> 0;
};

export const autoTagList = (query: AutoTagQuery, auth: AuthContext): AutoTagPage => {
    requireAdmin(auth);

    const rows = faceAutoTagRepo.inState(query.state, auth.accessibleRootIds);
    const counts = faceAutoTagRepo.counts();
    const setting = autoTagSetting();
    const ordered =
        query.state === "proposed"
            ? [...rows].sort(
                  (a, b) =>
                      rank(query.seed, a.mediaId + a.tagId) - rank(query.seed, b.mediaId + b.tagId)
              )
            : rows;
    const start = query.page * query.limit;
    const page = ordered.slice(start, start + query.limit);
    const tiles = new Map(
        lookupMedia(
            page.map((row) => row.mediaId),
            auth
        ).items.map((item) => [item.id, item])
    );
    const faces = new Map(
        faceRepo
            .shownFaces(page.flatMap((row) => (row.faceId ? [row.faceId] : [])))
            .map((face) => [face.id, face])
    );

    return {
        rows: page.flatMap((row): AutoTagEntry[] => {
            const item = tiles.get(row.mediaId);
            const tag = tagRepo.findById(row.tagId);
            const face = row.faceId ? faces.get(row.faceId) : undefined;
            const crop = face ? faceCrop(face) : null;

            return item && tag
                ? [
                      {
                          item,
                          tagId: tag.id,
                          name: tag.name,
                          face:
                              face && crop
                                  ? {
                                        id: face.id,
                                        crop,
                                        mediaId: face.mediaId,
                                        kind: face.kind,
                                        atMs: face.atMs,
                                        box: { x: face.x, y: face.y, w: face.w, h: face.h },
                                    }
                                  : null,
                          score: row.score,
                          strongFaces: row.strongFaces,
                          named: row.named === 1,
                          state: row.state,
                      },
                  ]
                : [];
        }),
        hasMore: start + query.limit < ordered.length,
        total: ordered.length,
        counts,
        enabled: setting.enabled,
        since: setting.since,
        braked: setting.enabled && autoTagBraked(counts),
    };
};

const autoTagSetting = () =>
    faceAutoTagSettingSchema.parse(settingRepo.get(SETTING_KEYS.faceAutoTag, {}));

/**
 * Let faces tag by themselves, or stop them (§5f "Tagging by itself"). Who turned it on is kept:
 * their undo list holds what it tags. Turned on, the next pass runs now rather than after the
 * next grouping run.
 */
export const switchAutoTag = (input: AutoTagSwitch, auth: AuthContext): { enabled: boolean } => {
    requireAdmin(auth);

    settingRepo.set(SETTING_KEYS.faceAutoTag, {
        enabled: input.enabled,
        byUserId: input.enabled ? auth.userId : null,
        since: input.enabled ? new Date().toISOString() : null,
    });

    if (input.enabled) jobRepo.enqueueKind("faceAnchors", 200, 0);

    return { enabled: input.enabled };
};

/** "Right" or "Wrong", of one item the rule would tag. */
export const decideAutoTag = (decision: AutoTagDecision, auth: AuthContext): { tagged: number } => {
    requireAdmin(auth);

    const row = faceAutoTagRepo.find(decision.mediaId, decision.tagId);
    const tag = tagRepo.findById(decision.tagId);

    if (!row || !tag || lookupMedia([decision.mediaId], auth).items.length === 0) {
        throw new NotFoundError("That suggestion is no longer there. Reload the list.");
    }

    // Tagged by itself and wrong: taken off, and "not them" as any untag by hand is — which also
    // marks it taken back, the number that brakes tagging by itself.
    if (row.state === "applied") {
        if (decision.verdict === "wrong") {
            db.transaction(() => {
                tagRepo.unassign(decision.mediaId, tag.id, null);
                notThem([decision.mediaId], tag.id, auth.userId, "wouldTag");
                searchRepo.requestReindex([decision.mediaId]);
            })();
        }

        return { tagged: 0 };
    }

    const press = {
        actor: "user" as const,
        userId: auth.userId,
        verdict: decision.verdict === "right" ? ("is" as const) : ("isNot" as const),
        tagId: tag.id,
        surface: "wouldTag" as const,
    };
    const { result: tagged } = faceDecisionRepo.record(press, (): number => {
        faceAutoTagRepo.decide(decision.mediaId, decision.tagId, decision.verdict, auth.userId);

        if (decision.verdict === "wrong") {
            faceRepo.refuseMatchedOnItem(decision.mediaId, tag.id, row.faceId, auth.userId);

            return 0;
        }

        if (row.faceId) faceRepo.confirmFace(row.faceId, tag.id, auth.userId);

        const { assigned } = tagBatchRepo.applyAssignments({
            userId: auth.userId,
            scope: null,
            summary: `${tag.name} on 1 item, checked in "Would tag"`,
            assignments: [{ mediaId: decision.mediaId, tagId: tag.id }],
        });

        searchRepo.requestReindex([decision.mediaId]);

        return assigned;
    });

    // A confirmation or a refusal moves their reference.
    jobRepo.enqueueKind("faceAnchors", 200, 120);

    return { tagged };
};
