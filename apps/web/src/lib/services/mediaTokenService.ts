import {
    ConflictError,
    NotFoundError,
    type MediaToken,
    type MediaTokenRequest,
    type MediaTokens,
} from "@private-stock/core";
import { loadConfig } from "@private-stock/core/server";

import { MEDIA_TOKEN_TTL_SECONDS, signMediaToken } from "../auth/tokens";
import type { AuthContext } from "../auth/withAuth";
import { contentTypeFor, PLAYLIST_TYPE } from "../contentTypes";
import { resolveMediaFile, type ResolvedFile } from "./mediaService";
import { segmentPlaylist } from "./segmentService";

/**
 * What the stream route will answer with for this file: a playlist when it plays as segments
 * and its index is ready, otherwise its own bytes. Asked the same way the route asks it.
 */
const servedTypeFor = (mediaId: string, file: ResolvedFile): string =>
    file.segments && segmentPlaylist(mediaId, file, "stream?raw=1") !== null
        ? PLAYLIST_TYPE
        : contentTypeFor(file.relPath);

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
export const issueMediaToken = (
    mediaId: string,
    auth: AuthContext,
    request: MediaTokenRequest = { original: false }
): MediaToken => issue(mediaId, auth, request).link;

const issue = (
    mediaId: string,
    auth: AuthContext,
    request: MediaTokenRequest
): { link: MediaToken; kind: ResolvedFile["kind"] } => {
    const file = resolveMediaFile(
        mediaId,
        auth,
        request.original ? { original: true } : { requireCastReady: true }
    );

    const token = signMediaToken(auth.userId, mediaId, auth.tokenEpoch);
    const base = `/api/media/${encodeURIComponent(mediaId)}/stream?t=${encodeURIComponent(token)}`;
    // The stored file's bytes, not a playlist or a rendition: what an outside player wants.
    const path = request.original ? `${base}&raw=1` : base;
    // Only the cast link goes to the token-only port. An outside player runs on this device,
    // which trusts the page's certificate and can reach the page's origin.
    const castOrigin = request.original ? null : loadConfig().castOrigin;

    return {
        link: {
            token,
            path,
            url: castOrigin ? `${castOrigin}${path}` : null,
            contentType: servedTypeFor(mediaId, file),
            expiresAt: new Date(Date.now() + MEDIA_TOKEN_TTL_SECONDS * 1000).toISOString(),
        },
        kind: file.kind,
    };
};

/**
 * Cast links for the items a TV will play next (§11, continuous play).
 *
 * Each id passes the same gate `issueMediaToken` applies; the ones that do not are left out
 * rather than failing the whole batch, because a queue skips what it cannot play. Not-found and
 * not-playable are dropped alike, so the answer reveals nothing about items the caller cannot
 * see. Anything else is a real failure and is thrown.
 *
 * Videos only. A picture in a TV's queue has no end, so the queue would stop on it for good;
 * casting stills is not part of this.
 */
export const issueCastTokens = (ids: string[], auth: AuthContext): MediaTokens => ({
    links: ids.flatMap((mediaId) => {
        try {
            const { link, kind } = issue(mediaId, auth, { original: false });

            return kind === "video" ? [{ mediaId, ...link }] : [];
        } catch (error) {
            if (error instanceof NotFoundError || error instanceof ConflictError) {
                return [];
            }

            throw error;
        }
    }),
});
