import {
    faceAutoTagRepo,
    faceDecisionRepo,
    faceRepo,
    jobRepo,
    mentionRepo,
    tagRepo,
    type DecisionSurface,
} from "@private-stock/db";

/**
 * A library performer taken off items on purpose means "not them" (§5f "Corrections stick"):
 * the items are refused for them — so nothing that tags by itself, a face that looks like them or
 * a rule, puts them back — and so is every face on them. One decision, listed in History and
 * undoable there (§5f "Decisions you can take back"); adding the tag again withdraws the refusal.
 *
 * Only for a deliberate removal. An undo is not a refusal: it puts things back as they were, and
 * the trigger on `MediaTag` has already taken the confirmation away. Other kinds of tag, and
 * private ones, have no faces or are one person's business.
 */
export const notThem = (
    mediaIds: readonly string[],
    tagId: string,
    userId: string,
    surface: DecisionSurface = "untag"
): void => {
    const tag = tagRepo.findById(tagId);

    if (!tag || tag.kind !== "performer" || tag.ownerId !== null || mediaIds.length === 0) {
        return;
    }

    faceDecisionRepo.record({ actor: "user", userId, verdict: "isNot", tagId, surface }, () => {
        faceRepo.refuseOnItems(mediaIds, tagId, userId);
        mentionRepo.refuseItems(tagId, mediaIds, userId);
    });
    // Where faces had tagged it by themselves, this is how they are measured once they act.
    faceAutoTagRepo.markRemoved(mediaIds, tagId, userId);
    // Their reference may have leaned on these faces, and their picture been cut from one.
    jobRepo.enqueueKind("faceAnchors", 200, 120);
    jobRepo.enqueueKind("tagPictures", 200, 120);
};
