import type { MediaKind } from "@private-stock/core";

import { snapChoice } from "./snapChoice";

/**
 * How long the stage holds something that does not end by itself (§14b).
 *
 * The item page is a position in a set, and the set is mixed. Rolling onward used to walk the
 * videos and stop dead at the first photograph, because the queue advances on an `ended` event
 * and a photograph never fires one. The rule that fixes it is deliberately not about
 * photographs:
 *
 * **The show advances when the thing on screen ends, and anything with no end ends after N
 * seconds.**
 *
 * A photograph has no end. Neither does a video awaiting a rendition — and that case was worse
 * than a stall, because the player mounted, asked for an original this browser cannot decode,
 * got an error and removed itself, leaving an empty stage for autoplay to sit in front of.
 *
 * So the stage has two *modes* rather than two *kinds*, and the dwell belongs to the mode.
 *
 * Pure and here rather than in the component, for the reason `videoSlots.ts` and
 * `viewerSequence.ts` are: it is arithmetic about a queue, and arithmetic folded into a
 * component is arithmetic nothing tests.
 */

/** What is filling the stage: something that ends by itself, or something that does not. */
export type StageMode = "player" | "still";

/**
 * Which mode an item is shown in.
 *
 * Written as "a video **and** direct-play is a player" rather than "an image or a pending
 * transcode is a still". Read that way round, a third `MediaKind` added later lands on the
 * still path, which advances, instead of on the player path, which would stall. The safe side
 * of an unknown is the side that keeps moving.
 */
export const stageMode = (subject: { kind: MediaKind; directPlay: boolean }): StageMode =>
    subject.kind === "video" && subject.directPlay ? "player" : "still";

/**
 * The picture a still stage shows, or null when there is nothing to show at all.
 *
 * An image is its own bytes; a video that cannot play is its cover. The cover can be missing —
 * an item whose cover stage has not run yet — and that is a real state rather than an error,
 * which is why this returns null instead of throwing. A stage with no picture must still
 * advance.
 */
export const stillSource = (subject: {
    id: string;
    kind: MediaKind;
    coverUrl: string | null;
}): string | null =>
    subject.kind === "image" ? `/api/media/${subject.id}/stream` : subject.coverUrl;

/**
 * The dwells on offer, as a closed set.
 *
 * Four values rather than a free number, which removes a whole class of bug rather than
 * guarding against it: there is no representable value — zero, negative, a hand-edited
 * `"NaN"` — that could turn the show into a stroboscope or stop it forever. It also lets the
 * control that sets it be one tap on a phone, and guarantees any stored value can be rendered
 * by that control.
 */
export const DWELL_CHOICES = [3, 5, 8, 15] as const;
export type DwellSeconds = (typeof DWELL_CHOICES)[number];

/**
 * Five seconds.
 *
 * The beat every photo slideshow people have already used runs at, and with a 420 ms crossfade
 * at each end the picture is *still* for about four and a quarter seconds — roughly the dwell
 * somebody gives a photograph they are not studying. Three is for skimming a burst of
 * near-identical frames; eight and fifteen are for actually looking. Nothing longer is
 * offered, because past fifteen seconds you are not running a show, you are looking at one
 * picture, and Next is right there.
 */
export const DEFAULT_DWELL: DwellSeconds = 5;

/**
 * Anything at all into one of the four -- the rules are `snapChoice`'s, a tie going to the
 * shorter dwell.
 */
export const snapDwellSeconds = (value: number | string | null | undefined): DwellSeconds =>
    snapChoice(value, DWELL_CHOICES, DEFAULT_DWELL);

/**
 * How long to hold this arrival, or null when no show is running.
 *
 * One gate rather than four scattered conditions, so "is a show running" has a single answer.
 * `hasNext` is the end of the set: `useViewerSequence` has no wrap-around, so the last
 * photograph stays up exactly as the last video does rather than looping back to the first.
 */
export const dwellMs = (input: {
    mode: StageMode;
    autoplayNext: boolean;
    hasNext: boolean;
    seconds: DwellSeconds;
}): number | null =>
    input.mode === "still" && input.autoplayNext && input.hasNext ? input.seconds * 1_000 : null;

/**
 * What is left on a clock that was armed for `remainingMs` and has been running since.
 *
 * Floored at zero: a tab hidden for an hour must re-arm at nothing and fire, not go negative
 * and schedule a timeout an hour long.
 */
export const remainingAfterPause = (
    remainingMs: number,
    runningSinceMs: number,
    nowMs: number
): number => Math.max(0, remainingMs - (nowMs - runningSinceMs));
