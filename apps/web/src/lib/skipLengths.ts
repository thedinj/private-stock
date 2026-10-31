import { snapChoice } from "./snapChoice";

/**
 * How far the player's two jump buttons go, each chosen on its own (§14b).
 *
 * Two lengths rather than one because they do two jobs: back is "what did I just miss", which
 * wants a second or three, and forward is "get past this", which wants ten or more. One shared
 * length would have to be changed back and forth between them.
 *
 * Closed sets, like the dwell, so any stored value is one the chooser can show as selected and
 * none can be zero. Back starts at one second -- backing up a tad was the whole request -- and
 * forward starts at five, below which a jump is the `→` key's business.
 */
export const SKIP_BACK_CHOICES = [1, 2, 3, 5, 10, 15, 30] as const;
export type SkipBackSeconds = (typeof SKIP_BACK_CHOICES)[number];

export const SKIP_FORWARD_CHOICES = [5, 10, 15, 30, 60, 90] as const;
export type SkipForwardSeconds = (typeof SKIP_FORWARD_CHOICES)[number];

/** Ten each way: what the buttons did before they could be changed, so nothing moves until asked. */
export const DEFAULT_SKIP_BACK: SkipBackSeconds = 10;
export const DEFAULT_SKIP_FORWARD: SkipForwardSeconds = 10;

export const snapSkipBack = (value: number | string | null | undefined): SkipBackSeconds =>
    snapChoice(value, SKIP_BACK_CHOICES, DEFAULT_SKIP_BACK);

export const snapSkipForward = (value: number | string | null | undefined): SkipForwardSeconds =>
    snapChoice(value, SKIP_FORWARD_CHOICES, DEFAULT_SKIP_FORWARD);
