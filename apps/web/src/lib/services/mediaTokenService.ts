import { type MediaToken } from "@private-stock/core";

import { MEDIA_TOKEN_TTL_SECONDS, signMediaToken } from "../auth/tokens";
import type { AuthContext } from "../auth/withAuth";
import { resolveMediaFile } from "./mediaService";

/**
 * Minting a signed media URL (§12d).
 *
 * The authorization happens here, exactly once, against the same `findDetail` gate every
 * other read of this item uses — so a token can only ever be minted for something the caller
 * could already have fetched through the ordinary path. Signing is the last step, not the
 * check.
 *
 * `NotFoundError` rather than a refusal for an inaccessible item, matching `resolveArtifact`
 * and `resolveMediaFile`: the shape of the error must not tell a user that something exists
 * in a library they cannot reach.
 *
 * The playability check is made here as well as when the bytes are served, so a UI finds out
 * that nothing is castable yet *before* it starts a cast session rather than after the TV has
 * gone black. The check at serve time is still the one that decides — a rendition can be
 * deleted to reclaim space between minting and playing.
 */
export const issueMediaToken = (mediaId: string, auth: AuthContext): MediaToken => {
    resolveMediaFile(mediaId, auth, { requireCastReady: true });

    const token = signMediaToken(auth.userId, mediaId, auth.tokenEpoch);

    return {
        token,
        path: `/api/media/${encodeURIComponent(mediaId)}/stream?t=${encodeURIComponent(token)}`,
        expiresAt: new Date(Date.now() + MEDIA_TOKEN_TTL_SECONDS * 1000).toISOString(),
    };
};
