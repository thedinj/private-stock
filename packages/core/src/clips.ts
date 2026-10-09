/**
 * The arithmetic of playing a span (§14d).
 *
 * Pure and separate from the player for the same reason `videoSlots.ts` is: every mistake
 * available here is invisible. A reel whose out-points overshoot by a quarter of a second still
 * plays, still advances, still looks finished — it is simply wrong at the one frame anybody
 * watching a cut actually looks at. So the parts that can be decided without a `<video>` are
 * decided here, where a test can say what they should be.
 */

/**
 * The shortest span worth storing.
 *
 * Marking in and out inside a fifth of a second is a mis-press, not a decision — the two keys
 * are next to each other and `]` follows `[` by reflex. Refusing it costs nothing, because
 * nobody wants that clip, and accepting it puts a span in the browser that cannot be seen.
 */
export const MIN_CLIP_MS = 200;

/** The lowest and highest rate the player's own control offers, and therefore a clip's range. */
export const MIN_CLIP_SPEED = 0.25;
export const MAX_CLIP_SPEED = 4;

/**
 * How many spans one reel may hold.
 *
 * A reel is read whole rather than a page at a time, because it is played in one pass and the
 * player must never have to ask a second question part way through. That is only honest with a
 * bound on the answer's size, and this is the bound.
 */
export const REEL_ITEM_LIMIT = 200;

/** A span of one item: where it starts, where it ends, and how fast it is meant to be seen. */
export interface ClipSpan {
    startMs: number;
    endMs: number;
    /** `null` means 1.0. See the column comment in `init.ts` for why it is not stored as 1.0. */
    speed: number | null;
}

/** A clip's speed as a number, which is the only place the NULL-means-one rule is spelled. */
export const speedOf = (speed: number | null): number => speed ?? 1;

/**
 * The rate the element should actually run at.
 *
 * **The two multiply**, and the alternatives both lose something real. A clip's speed is part of
 * the cut — "this bit is meant to be slow" — while the viewer's rate control is about how fast
 * they are getting through the reel in front of them. Letting the clip's speed replace the
 * viewer's takes the rate control away inside exactly the spans somebody is most likely to want
 * to slow down further; letting the viewer's replace the clip's silently discards what the
 * author arranged.
 *
 * Clamped at the ends because the product can leave the range either factor was in: half speed
 * watched at a quarter speed is an eighth, which the element will refuse outright, and a
 * refusal is a span that does not play at all.
 */
export const effectiveRate = (clipSpeed: number | null, viewerRate: number): number => {
    const product = speedOf(clipSpeed) * viewerRate;

    return Math.min(MAX_CLIP_SPEED, Math.max(MIN_CLIP_SPEED, product));
};

/**
 * How long a span takes to watch.
 *
 * **Not the length of the span**, once a speed is involved: twenty seconds at 0.5× is forty
 * seconds of somebody's evening. Every duration the app reports is this one — the reel card's
 * subtitle, the `duration` sort, the browser's own column — because the question behind all of
 * them is "how long is this to watch", never "how much of the source does it cover".
 *
 * Summing raw spans instead is the mistake waiting to be made, and it is right in the common
 * case where every clip is 1×, so it would be wrong only on the reels somebody took trouble
 * over. `reelRepo` transcribes this expression into SQL; the two must agree.
 */
export const spanRunMs = ({ startMs, endMs, speed }: ClipSpan): number =>
    Math.round((endMs - startMs) / speedOf(speed));

/**
 * Milliseconds of wall clock until the out-point, at the rate the element is actually running.
 *
 * The rate division is the part that is easy to forget and used to be rare. With a clip
 * carrying its own speed it is the common case: a half-speed span whose timer was armed as if
 * it were 1× fires twice as early as it should, cutting the span in half.
 *
 * Clamped at zero so an out-point already behind the playhead — a seek past the end, a rate
 * change that landed late — arms a timer that fires immediately rather than one that never does.
 */
export const msUntilOut = (positionMs: number, endMs: number, rate: number): number =>
    Math.max(0, (endMs - positionMs) / Math.max(rate, MIN_CLIP_SPEED));

/**
 * Whether the playhead has reached the out-point.
 *
 * The backstop under both precise mechanisms, and the only one that runs in a background tab
 * where no frames are presented and timers are clamped to the second. A tolerance because
 * `currentTime` is a float in seconds and the out-point is an integer in milliseconds, so exact
 * equality is a comparison that never comes true.
 */
export const reachedOut = (positionMs: number, endMs: number, toleranceMs = 40): boolean =>
    positionMs >= endMs - toleranceMs;

/**
 * A span held inside a duration the decoder has agreed to.
 *
 * The probed duration is **not** authoritative — `VideoPlayer` already says so, and reads its
 * own back off the element — so this clamps rather than refuses. Refusing would throw away
 * legitimate clips at the tail of any file the probe measured short, which is the end of the
 * file people most often want a moment from.
 *
 * Returns `null` when nothing usable survives the clamp, which is a fact about the span rather
 * than an error: an in-point past the end of the file is not a clip anybody can be shown.
 */
export const clampSpan = (span: ClipSpan, durationMs: number | null): ClipSpan | null => {
    if (durationMs === null || durationMs <= 0) {
        return span;
    }

    const startMs = Math.max(0, Math.min(span.startMs, durationMs));
    const endMs = Math.min(span.endMs, durationMs);

    return endMs - startMs >= MIN_CLIP_MS ? { ...span, startMs, endMs } : null;
};

/** Whether a position falls inside a span, used to mark the current entry in a reel. */
export const clipContains = (span: ClipSpan, positionMs: number): boolean =>
    positionMs >= span.startMs && positionMs < span.endMs;

/**
 * Where a position in **reel time** falls, across an ordered run of spans.
 *
 * A reel's progress bar measures the reel, so a click at 40% means 40% of the reel and not of
 * whichever file the current span happens to come from. This turns that into the span to play and
 * the position to start it at.
 *
 * The conversion back to source time is the part worth stating: a span's *run* time is its length
 * divided by its speed, so an offset inside the run multiplies by the speed to become an offset
 * inside the source. At 0.5x, two seconds of reel are one second of file.
 *
 * Returns null for an empty reel. A position past the end lands at the end of the last span rather
 * than nowhere, because dragging to the right edge is a thing people do and "no answer" is not one
 * of the outcomes they mean.
 */
export const locateInReel = (
    spans: ClipSpan[],
    reelMs: number
): { index: number; atMs: number } | null => {
    if (spans.length === 0) {
        return null;
    }

    let elapsed = 0;

    for (const [index, span] of spans.entries()) {
        const run = spanRunMs(span);
        const last = index === spans.length - 1;

        if (reelMs < elapsed + run || last) {
            const within = Math.max(0, Math.min(reelMs - elapsed, run));

            return { index, atMs: span.startMs + within * speedOf(span.speed) };
        }

        elapsed += run;
    }

    return null;
};
