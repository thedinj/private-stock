import type { MediaListItem } from "@private-stock/core";

/**
 * What each of the tasting's two layers holds (§14g).
 *
 * The stage has a film layer and a picture layer, one over the other, and shows whichever the
 * current item needs. Each layer can also get the *next* item ready so that arriving at it
 * starts warm:
 *
 * - **Same kind next:** the layer that is showing warms it in its own second slot, exactly as
 *   the viewer does (§8b) -- the player's hidden element, or the picture's hidden `<img>`.
 * - **Other kind next:** the layer that is *not* showing is **cued** with it. A cued film is a
 *   live player, held, already sought to its segment's start; a cued picture is decoded while
 *   out of sight. When its turn comes the layers change places and nothing is fetched.
 *
 * Cueing is refused where warming is (`mayWarmNextItem`): on a phone, or a connection that asks
 * to save data, the other layer stays empty and the next item arrives cold. A phone has one
 * decoder to spare at best, and it belongs to what is on screen.
 *
 * Only ever one item ahead. Two would double what every join costs the NAS for a show that
 * spends most of its time sitting on one item.
 */

export interface LayerTargets {
    /** The film layer's item, or null for an empty layer. */
    video: MediaListItem | null;
    /** Whether `video` is the item on show rather than one being cued. */
    videoLive: boolean;
    /** The next film, warmed in the film layer's second element. */
    videoPreload: MediaListItem | null;
    photo: MediaListItem | null;
    photoLive: boolean;
    photoPreload: MediaListItem | null;
}

export const stageTargets = (
    current: MediaListItem,
    upcoming: MediaListItem | null,
    mayCue: boolean
): LayerTargets => {
    // A set of one comes round to itself; there is nothing further ahead to prepare.
    const next = upcoming && upcoming.id !== current.id ? upcoming : null;

    if (current.kind === "video") {
        return {
            video: current,
            videoLive: true,
            videoPreload: next?.kind === "video" ? next : null,
            photo: mayCue && next?.kind === "image" ? next : null,
            photoLive: false,
            photoPreload: null,
        };
    }

    return {
        video: mayCue && next?.kind === "video" ? next : null,
        videoLive: false,
        videoPreload: null,
        photo: current,
        photoLive: true,
        photoPreload: next?.kind === "image" ? next : null,
    };
};
