import { faceAutoTagRepo, faceRepo, jobRepo, mentionRepo, tagRepo } from "@private-stock/db";

/**
 * A library performer taken off items on purpose means "not them" (§5f "Corrections stick"):
 * every face on those items is refused for them, and so is the name match where there is one, so
 * nothing that tags by itself — a face that looks like them, a rule — puts them back.
 *
 * Only for a deliberate removal. An undo is not a refusal: it puts things back as they were, and
 * the trigger on `MediaTag` has already taken the confirmation away. Other kinds of tag, and
 * private ones, have no faces or are one person's business.
 */
export const notThem = (mediaIds: readonly string[], tagId: string, userId: string): void => {
    const tag = tagRepo.findById(tagId);

    if (!tag || tag.kind !== "performer" || tag.ownerId !== null || mediaIds.length === 0) {
        return;
    }

    faceRepo.refuseOnItems(mediaIds, tagId, userId);
    mentionRepo.refuse(tagId, mediaIds, userId);
    // Where faces had tagged it by themselves, this is how they are measured once they act.
    faceAutoTagRepo.markRemoved(mediaIds, tagId, userId);
    // Their reference may have leaned on these faces, and their picture been cut from one.
    jobRepo.enqueueKind("faceAnchors", 200, 120);
    jobRepo.enqueueKind("tagPictures", 200, 120);
};
