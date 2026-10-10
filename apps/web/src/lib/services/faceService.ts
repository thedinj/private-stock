import {
    AuthorizationError,
    NotFoundError,
    type ConfirmedFacesPage,
    type ConfirmedFacesQuery,
    type FaceCrop,
    type FaceReviewFace,
    type NoSingleFace,
} from "@private-stock/core";
import {
    artifactRepo,
    faceRepo,
    jobRepo,
    tagRepo,
    type faceRepo as FaceRepoTypes,
} from "@private-stock/db";

import type { AuthContext } from "../auth/withAuth";
import { artifactUrl } from "./artService";
import { spriteThumbFor } from "./spriteThumb";

/**
 * What every face surface shares (§5f): how a face is cropped out of the picture it was found in,
 * what a change of confirmations sets going, and a performer's own face settings — "no single
 * face", and the confirmed faces their picture is chosen from. The surfaces themselves are their
 * own services: Suggestions, New people, a performer's Faces tab, People in this item, History.
 *
 * Administrators only, as every face decision is.
 */

type ShownFace = FaceRepoTypes.ShownFace;

const requireAdmin = (auth: AuthContext): void => {
    if (!auth.scopes.includes("admin")) {
        throw new AuthorizationError("Only an administrator can confirm faces");
    }
};

const libraryPerformer = (tagId: string) => {
    const tag = tagRepo.findById(tagId);

    if (!tag || tag.kind !== "performer" || tag.ownerId !== null) {
        throw new NotFoundError("Performer not found");
    }

    return tag;
};

/** How much wider than the face the crop is: enough of the head to recognise it by. */
const MARGIN = 1.6;

/**
 * A square around a face, inside the picture it was found in: a sprite tile for a video, the
 * cover for a photograph. The same crop the browser draws from a sheet it has very likely
 * fetched already for the scrubber (§14d). Null where the picture has gone.
 */
export const faceCrop = (face: ShownFace): FaceCrop | null => {
    let picture: {
        url: string;
        x: number;
        y: number;
        width: number;
        height: number;
        sheetWidth: number;
        sheetHeight: number;
    };

    if (face.kind === "video") {
        const thumb = spriteThumbFor(face.mediaId, face.atMs ?? 0);

        if (!thumb) return null;

        picture = { url: thumb.url, ...thumb.rect };
    } else {
        const cover = artifactRepo.findOne(face.mediaId, "cover", 0);

        if (!cover?.width || !cover.height) return null;

        picture = {
            url: artifactUrl(face.mediaId, "cover", cover.relPath, cover.generatedAt),
            x: 0,
            y: 0,
            width: cover.width,
            height: cover.height,
            sheetWidth: cover.width,
            sheetHeight: cover.height,
        };
    }

    const side = Math.min(
        Math.max(face.w * picture.width, face.h * picture.height) * MARGIN,
        picture.width,
        picture.height
    );
    const cx = picture.x + (face.x + face.w / 2) * picture.width;
    const cy = picture.y + (face.y + face.h / 2) * picture.height;
    const clamp = (value: number, low: number, high: number): number =>
        Math.min(Math.max(value, low), high);

    return {
        url: picture.url,
        rect: {
            x: clamp(cx - side / 2, picture.x, picture.x + picture.width - side),
            y: clamp(cy - side / 2, picture.y, picture.y + picture.height - side),
            width: side,
            height: side,
            sheetWidth: picture.sheetWidth,
            sheetHeight: picture.sheetHeight,
        },
        frame: {
            x: picture.x,
            y: picture.y,
            width: picture.width,
            height: picture.height,
            sheetWidth: picture.sheetWidth,
            sheetHeight: picture.sheetHeight,
        },
    };
};

/**
 * Confirmations changed, so a performer's best face, and with it their picture, may have (§6 "A
 * tag's picture"). The job waits two minutes, so a review session's decisions are one pass.
 */
export const confirmationsChanged = (): void => {
    jobRepo.enqueueKind("tagPictures", 200, 120);
    // And every reference and best match with it (§5f "One face, one score").
    jobRepo.enqueueKind("faceAnchors", 200, 120);
};

/**
 * "No single face" (§5f "Performers with no single face"): a performer whose face never shows, or a
 * name that is not one person, left out of face matching — no reference, no evidence from their
 * tags, nothing proposed or tagged by a face; suggested by name only. Taken back, everything they
 * had returns: what was confirmed for them was kept, and their reference is built again at once.
 */
export const setNoSingleFace = (
    tagId: string,
    input: NoSingleFace,
    auth: AuthContext
): { noSingleFace: boolean } => {
    requireAdmin(auth);
    libraryPerformer(tagId);

    faceRepo.setNoSingleFace(tagId, input.noSingleFace, auth.userId);
    jobRepo.enqueueKind("faceAnchors", 200, 0);

    return { noSingleFace: input.noSingleFace };
};

/** Every face confirmed as them, a page at a time: what their picture is chosen from. */
export const confirmedFacesPage = (
    tagId: string,
    query: ConfirmedFacesQuery,
    auth: AuthContext
): ConfirmedFacesPage => {
    requireAdmin(auth);
    libraryPerformer(tagId);

    const start = query.page * query.limit;
    const { faces, total } = faceRepo.everyConfirmedFace(
        tagId,
        auth.accessibleRootIds,
        query.limit,
        start
    );

    return {
        faces: faces.flatMap(reviewFace),
        hasMore: start + query.limit < total,
        total,
    };
};

/** A face as every list shows it: its crop, or nothing where it has none. */
export const reviewFace = (face: ShownFace): FaceReviewFace[] => {
    const crop = faceCrop(face);

    return crop
        ? [
              {
                  id: face.id,
                  crop,
                  mediaId: face.mediaId,
                  kind: face.kind,
                  atMs: face.atMs,
                  box: { x: face.x, y: face.y, w: face.w, h: face.h },
              },
          ]
        : [];
};
