/**
 * Library grid geometry.
 *
 * Only the dimensions remain. The arithmetic that used to live here — columns, tile width,
 * row height, row pitch — existed to feed a row virtualizer, and was genuinely difficult:
 * the container measures 0 on the first render after every mount, and the virtualizer caches
 * the row pitch it is first given, so an unmeasured width produced permanently overlapping
 * rows.
 *
 * Paging removed the virtualizer (§20), and with it the need to compute any of that in
 * TypeScript. Sixty tiles are laid out by `repeat(auto-fill, minmax(...))`, which the browser
 * resolves after layout and therefore cannot get wrong on a first paint.
 */

/** Gap between tiles, horizontally and vertically. */
export const GRID_GAP = 12;

/** Narrowest tile worth showing before dropping a column. */
export const MIN_TILE_WIDTH = 190;

/**
 * Gallery mode wants fewer, larger tiles.
 *
 * The point of gallery mode is watching the previews, and a 190px tile is too small to tell
 * one clip from another — the mode would cost decoder slots and show nothing for them.
 */
export const GALLERY_MIN_TILE_WIDTH = 320;

/**
 * The grid, as a `grid-template-columns` value.
 *
 * **The minimum is capped at half the container, and that is the whole point.** A bare
 * `minmax(190px, 1fr)` resolves to a single column on a phone: a Pixel 10 is 412px wide, the
 * content box inside the shell's padding is 388, and two 190px tracks plus the gap need 392.
 * Four pixels decided that every phone in the world saw one enormous tile per row — and it
 * failed silently, because `auto-fill` has no way to report that it wanted two.
 *
 * `min(190px, 50% - halfGap)` says "190 unless that would cost the second column", so the
 * grid is never narrower than two across at any width, and is unchanged from 404px up. It is
 * resolved against the grid's own box rather than the viewport, so it stays correct inside
 * the filter sidebar's remaining width without anything having to measure.
 */
export const GRID_TRACKS = `repeat(auto-fill, minmax(min(${MIN_TILE_WIDTH}px, calc(50% - ${
    GRID_GAP / 2
}px)), 1fr))`;

/**
 * Gallery mode's tracks.
 *
 * Capped at the full container rather than half of it: one large preview per row is the
 * correct answer on a phone, where two 188px videos would defeat the point of the mode and
 * cost two decoder slots to do it (§14).
 */
export const GALLERY_TRACKS = `repeat(auto-fill, minmax(min(${GALLERY_MIN_TILE_WIDTH}px, 100%), 1fr))`;

/**
 * How many leading tiles fetch their cover at high priority.
 *
 * A page is sixty covers on one slow volume, and without a hint they arrive together (§20).
 * This lets the ones on screen finish first. It is a guess at the first screenful — two
 * phone rows, about one desktop row — and a wrong guess only reorders requests.
 */
export const PRIORITY_TILES = 8;
