/**
 * A playlist view, as it lives in the URL (§14b).
 *
 * The same rule the library follows: the address *is* the view, so a page and an order are
 * shareable, reloadable and back-button correct. It matters more here than there, because
 * three surfaces have to agree about which of a playlist's two orders they are showing — the
 * grid, the up-next strip, and previous/next in the viewer. They agree by all reading this.
 *
 * Pure, so the awkward part — an address that has not said which order it wants — can be
 * tested without a browser.
 */

export type PlaylistMode = "grid" | "gallery";

/**
 * Which order, and which permutation.
 *
 * `seed` is the whole of the shuffle: two seeds are two different shuffles, and the same seed
 * is the same one tomorrow. Nothing about a shuffle is stored, so losing this parameter loses
 * the order — which is why turning a page must carry it.
 */
export interface PlaylistView {
    page: number;
    /** The permutation, or null for the stored order. Only meaningful once `decided`. */
    seed: number | null;
    /**
     * Whether the address has an opinion about the order at all.
     *
     * A bare `/playlists/x` has not chosen, and the playlist's own default fills it in. Once
     * anyone has touched the toggle the address says so — `order=stored` as loudly as a seed
     * does — because without that, switching *off* shuffle would produce a bare address again
     * and the default would immediately switch it back on.
     */
    decided: boolean;
    mode: PlaylistMode;
}

export const DEFAULT_PLAYLIST_VIEW: PlaylistView = {
    page: 0,
    seed: null,
    decided: false,
    mode: "grid",
};

export const parsePlaylistView = (params: URLSearchParams): PlaylistView => {
    const rawSeed = params.get("seed");
    const seed = rawSeed !== null && Number.isFinite(Number(rawSeed)) ? Number(rawSeed) : null;
    const stored = params.get("order") === "stored";

    return {
        page: Math.max(0, Number(params.get("page")) || 0),
        // A seed and an explicit `order=stored` cannot both be honoured; the explicit word
        // wins, so a stale seed left in a hand-edited address cannot quietly shuffle a list
        // somebody asked to see in order.
        seed: stored ? null : seed,
        decided: stored || seed !== null,
        mode: params.get("view") === "gallery" ? "gallery" : "grid",
    };
};

export const playlistViewToParams = (view: PlaylistView): URLSearchParams => {
    const params = new URLSearchParams();

    if (view.decided) {
        if (view.seed === null) {
            params.set("order", "stored");
        } else {
            params.set("seed", String(view.seed));
        }
    }

    if (view.page > 0) params.set("page", String(view.page));
    if (view.mode !== "grid") params.set("view", view.mode);

    return params;
};

export const playlistHref = (playlistId: string, view: PlaylistView): string => {
    const params = playlistViewToParams(view);

    return params.toString()
        ? `/playlists/${playlistId}?${params.toString()}`
        : `/playlists/${playlistId}`;
};

/** The playlist an address belongs to, or null if it is not a playlist address. */
export const playlistIdFromPath = (href: string): string | null => {
    const path = href.split("?")[0] ?? "";
    const match = /^\/playlists\/([^/]+)$/.exec(path);

    return match?.[1] ?? null;
};

/**
 * A fresh permutation.
 *
 * Consecutive values are fine: `shuffleParams` mixes the seed precisely so that the next one
 * is an unrelated order rather than the last one shifted by a row. Random anyway, so that two
 * people reshuffling the same list at the same moment do not land on the same order.
 */
export const newSeed = (): number => Math.floor(Math.random() * 1_000_000);

/**
 * The view a playlist opens in, given what the address says and what the list prefers.
 *
 * The default is consulted only when the address has not decided. That is the whole of
 * `sortMode`: a statement about how this list likes to be opened, overridden by anything the
 * viewer has actually done, and never written by the toggle.
 */
export const resolvePlaylistView = (
    view: PlaylistView,
    sortMode: "stored" | "shuffle" | null,
    seedForDefault: number
): PlaylistView =>
    view.decided
        ? view
        : {
              ...view,
              seed: sortMode === "shuffle" ? seedForDefault : null,
              decided: true,
          };
