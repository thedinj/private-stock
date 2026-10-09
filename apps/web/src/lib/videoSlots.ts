/**
 * Which of the player's two video elements holds what (§8b).
 *
 * The player renders **two** `<video>` elements and shows one. The hidden one is buffering the
 * item you are about to open, so that pressing next swaps which element is on screen rather
 * than starting a download: a warmed element already knows the file's duration, has parsed its
 * index — the part that costs two or three round trips to the NAS on an MKV whose cues sit at
 * the end — and holds a few seconds of decoded picture.
 *
 * That only works if the element **survives** the change of item, which is why the slots are
 * positional and this arithmetic exists. Two rules matter:
 *
 *  - **A slot's index never changes.** Reordering the two would make React move a node in the
 *    DOM, and a moved `<video>` is entitled to drop what it had buffered. So the item that was
 *    warming does not slide into first place when it starts playing; the *active index* moves
 *    to it instead.
 *  - **A slot is keyed by the id it holds.** React then reuses the element for an id that stays
 *    put and builds a new one only for an id that arrives, which is precisely the distinction
 *    between "the item I preloaded" and "an item nobody saw coming".
 *
 * Pure and separate from the component because it is the part that is easy to get subtly wrong
 * and impossible to see going wrong: a version that clobbered the warmed slot would still
 * work, just always at full price.
 */

export type SlotIndex = 0 | 1;

export interface SlotState {
    /** What each element is holding. `null` for a slot with nothing in it. */
    ids: readonly [string | null, string | null];
    /** Which one is on screen, playing. */
    active: SlotIndex;
}

export const initialSlots = (playing: string): SlotState => ({ ids: [playing, null], active: 0 });

const other = (index: SlotIndex): SlotIndex => (index === 0 ? 1 : 0);

/**
 * Where the two elements should be, given what is playing and what is worth warming.
 *
 * `warming` is the next item, or null for a device that should not spend the bandwidth, an end
 * of set, or an item that cannot be played directly.
 *
 * **Returns the state it was given when nothing moves.** This is called during render, so a
 * fresh object every time would be a fresh pair of elements every time.
 */
export const assignSlots = (
    state: SlotState,
    playing: string,
    warming: string | null
): SlotState => {
    const held = state.ids.indexOf(playing);

    /**
     * Playing something already in a slot is the whole point: the warmed element becomes the
     * active one where it stands. Playing something in neither slot — a jump from the grid, a
     * shared link, the end of a set — overwrites whichever element is on screen, which is the
     * old behaviour and the old cost.
     */
    const active: SlotIndex = held === -1 ? state.active : (held as SlotIndex);
    const ids: [string | null, string | null] = [state.ids[0], state.ids[1]];

    if (held === -1) {
        ids[active] = playing;
    }

    /**
     * Never warm what is already playing, which would put one file in both elements and ask
     * the NAS for it twice.
     */
    ids[other(active)] = warming === null || warming === playing ? null : warming;

    const unchanged = ids[0] === state.ids[0] && ids[1] === state.ids[1] && active === state.active;

    return unchanged ? state : { ids, active };
};

/**
 * Which of three transitions the player is about to make.
 *
 * Implicit until reels arrived, because stepping through the library is always the same move:
 * the next item is a different file, so it is always a swap or always a cold start. A reel makes
 * the third case ordinary — several spans of one afternoon's video, one after another — and
 * those must **seek the element already showing** rather than open the same file twice.
 *
 * This is also why slots stay keyed by media id and not by reel position. Keyed by position, a
 * reel of A, B, A would find slot 0 holding "position 0" while wanting "position 2", and React
 * would rebuild the element and throw away file A for a file that never changed. Keyed by media
 * id, slot 0 already holds A: nothing moves, the buffer survives, and the advance is a seek. The
 * reel's position lives in the player, which is the only place that needs to know it.
 */
export type Advance =
    | { kind: "seek"; index: SlotIndex }
    | { kind: "swap"; index: SlotIndex }
    | { kind: "cold"; index: SlotIndex };

export const advanceTo = (state: SlotState, nextMediaId: string): Advance => {
    const held = state.ids.indexOf(nextMediaId) as SlotIndex | -1;

    if (held === -1) {
        // Nobody saw this coming: overwrite what is on screen and pay the old price.
        return { kind: "cold", index: state.active };
    }

    return held === state.active ? { kind: "seek", index: held } : { kind: "swap", index: held };
};
