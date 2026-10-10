import { AuthorizationError, NotFoundError, type MentionRefusal } from "@private-stock/core";
import { faceDecisionRepo, mentionRepo, tagRepo } from "@private-stock/db";

import type { AuthContext } from "../auth/withAuth";
import { lookupMedia } from "./mediaService";

/**
 * "Not them", said from "Find untagged" (§5d): items whose own text names a tag, but somebody
 * else. They stop being offered for it — in the grid's filter, and on a performer's "Likely".
 *
 * Whoever may file things under the tag may say this: an administrator for the library's tags,
 * the owner for a private one. Only items this viewer can see.
 */
export const refuseMentions = (
    tagId: string,
    input: MentionRefusal,
    auth: AuthContext
): { refused: number } => {
    const tag = tagRepo.findById(tagId);

    if (!tag || (tag.ownerId !== null && tag.ownerId !== auth.userId)) {
        throw new NotFoundError("Tag not found");
    }

    if (tag.ownerId === null && !auth.scopes.includes("admin")) {
        throw new AuthorizationError("Only an administrator can decide the library's names");
    }

    const visible = lookupMedia(input.mediaIds, auth).items.map((item) => item.id);

    // One decision, listed in History and undoable there (§5f "Decisions you can take back").
    return {
        refused: faceDecisionRepo.record(
            {
                actor: "user",
                userId: auth.userId,
                verdict: "isNot",
                tagId: tag.id,
                surface: "findUntagged",
            },
            () => mentionRepo.refuse(tag.id, visible, auth.userId)
        ).result,
    };
};
