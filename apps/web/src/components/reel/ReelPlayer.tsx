"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Badge, Box, Button, Group, Paper, Stack, Switch, Text } from "@mantine/core";

import { locateInReel, type ReelEntry } from "@private-stock/core";

import { VideoPlayer } from "@/components/VideoPlayer";
import { ClipThumb } from "@/components/media/ClipThumb";

/**
 * Playing a reel through (§14d).
 *
 * The seam is §8b's, unchanged: two `<video>` elements, one showing and one warming, and moving on
 * changes which is on screen. What a reel adds is that a span has a **position inside a file**, so
 * four things follow.
 *
 *  - **The warmed element is seeked to its in point.** `preload="auto"` buffers from zero, so
 *    warming a file for a span that begins at 01:40 would buffer its opening titles and the join
 *    would stall exactly as if nothing had been warmed.
 *  - **Two spans of one file cost one element.** Slots are keyed by media id, so a reel of A, B, A
 *    finds A still open when it comes back: nothing is rebuilt, the buffer survives, and the join
 *    is a seek.
 *  - **The bar measures the reel**, not whichever file the current span came from, and dragging it
 *    moves about the reel rather than about that file.
 *  - **Nothing is recorded.** Watching twelve seconds of a film inside somebody's highlight reel is
 *    not a statement about that film.
 *
 * A span whose item cannot be played as it stands is **skipped with a notice** rather than left on
 * a black rectangle. On-demand HLS is the one outstanding phase-3 item, so until it lands a reel
 * assembled from unconverted files has nothing to play.
 */

const formatRun = (ms: number): string => {
    const total = Math.round(ms / 1000);
    const minutes = Math.floor(total / 60);

    return `${minutes}:${String(total % 60).padStart(2, "0")}`;
};

/**
 * Where playback is, and which arrival it is.
 *
 * `atMs` is a position **in the source file**, set only when a seek lands part way into a span;
 * null means "from its in point". `nonce` is what makes asking twice work: jumping to the span you
 * are already on, or seeking inside it, changes neither the index nor the timecodes, so without a
 * counter the player would see the same arrival and do nothing.
 */
interface Cue {
    index: number;
    atMs: number | null;
    nonce: number;
}

interface ReelPlayerProps {
    entries: ReelEntry[];
    runningMs: number;
}

export const ReelPlayer: React.FC<ReelPlayerProps> = ({ entries, runningMs }) => {
    const [cue, setCue] = useState<Cue>({ index: 0, atMs: null, nonce: 0 });
    const [ended, setEnded] = useState(false);
    const [loop, setLoop] = useState(false);
    const freezeRef = useRef<(() => void) | null>(null);

    /**
     * Only the spans that can actually be played.
     *
     * Filtered once rather than skipped at each join, so "3 of 12" counts what the viewer will see
     * rather than what the reel nominally holds — a counter that jumps by two is worse than a total
     * that is honest about being short.
     */
    const playable = useMemo(() => entries.filter((entry) => entry.media.directPlay), [entries]);
    const skipped = entries.length - playable.length;

    // A reel that shrinks under the cue — an entry removed while it was playing — must not be left
    // pointing past its own end.
    useEffect(() => {
        if (cue.index >= playable.length) {
            setCue({ index: 0, atMs: null, nonce: 0 });
            setEnded(false);
        }
    }, [cue.index, playable.length]);

    const current = playable[cue.index];
    const next = playable[cue.index + 1] ?? (loop ? playable[0] : undefined);

    /** Run time before the current span, and of the whole thing: what the bar is measured against. */
    const offsetMs = playable.slice(0, cue.index).reduce((sum, entry) => sum + entry.clip.runMs, 0);
    const playableMs = playable.reduce((sum, entry) => sum + entry.clip.runMs, 0);

    /**
     * Move to a span, holding the picture until the new one can be seen.
     *
     * The freeze happens **before** the cue changes, while the outgoing element still exists and
     * still has a frame: a moment later the slot it lives in may have been emptied. Every way of
     * moving about a reel comes through here — the automatic advance, the strip, a seek, replay —
     * so this is the only place that needs to remember.
     */
    const goTo = (index: number, atMs: number | null = null) => {
        freezeRef.current?.();
        setEnded(false);
        setCue((previous) => ({ index, atMs, nonce: previous.nonce + 1 }));
    };

    /**
     * Land on whatever span covers a position in reel time.
     *
     * The arithmetic is `locateInReel`, in core beside `spanRunMs`, because it is the same
     * conversion read the other way round and getting it wrong is invisible — a seek that lands
     * a second out still plays something.
     */
    const seekReel = (reelMs: number) => {
        const found = locateInReel(
            playable.map((entry) => entry.clip),
            reelMs
        );

        if (found) {
            goTo(found.index, found.atMs);
        }
    };

    if (!current) {
        return (
            <Alert color="gray" variant="light">
                {entries.length === 0
                    ? "This reel has no clips yet."
                    : "None of this reel's clips can be played yet — their files are waiting on a web-safe rendition (§8)."}
            </Alert>
        );
    }

    /**
     * The end of a span.
     *
     * On the last one, with loop off, the reel is **over** rather than merely paused. Saying so is
     * what lets the transport offer to play it again: without it the element sat on the out point
     * and pressing play resumed the underlying file straight past it, into the rest of whatever
     * the last clip was cut from.
     */
    const advance = () => {
        if (cue.index + 1 < playable.length) {
            goTo(cue.index + 1);
        } else if (loop) {
            goTo(0);
        } else {
            setEnded(true);
        }
    };

    return (
        <Stack gap="sm">
            <VideoPlayer
                warmSource="reel"
                mediaId={current.media.id}
                durationMs={current.media.durationMs}
                spriteVttUrl={null}
                poster={current.media.coverUrl}
                autoPlay
                span={{
                    startMs: current.clip.startMs,
                    endMs: current.clip.endMs,
                    speed: current.clip.speed,
                    startAtMs: cue.atMs ?? undefined,
                    // The entry *and* the nonce: a reel may hold one span twice in a row, and
                    // seeking inside the span you are on is an arrival at the same entry.
                    token: `${current.id}:${cue.nonce}`,
                }}
                onSpanEnded={advance}
                /* One ahead, never two — §8b's bound, and the in point is what makes it useful. */
                preloadMediaId={next?.media.id ?? null}
                preloadStartMs={next?.clip.startMs ?? null}
                /* See the note above: a reel writes no history. */
                reportProgress={false}
                timeline={{ offsetMs, totalMs: playableMs, onSeek: seekReel }}
                atEnd={ended}
                onReplay={() => goTo(0)}
                freezeRef={freezeRef}
            />

            <Group justify="space-between" wrap="wrap" gap="xs">
                <Group gap="sm">
                    <Text size="sm" c="dimmed">
                        {ended
                            ? `Finished · ${playable.length} clip${playable.length === 1 ? "" : "s"} · ${formatRun(playableMs)}`
                            : `${cue.index + 1} of ${playable.length} · ${formatRun(playableMs)}`}
                        {skipped > 0 &&
                            ` · ${skipped} cannot be played yet (${formatRun(runningMs)} in full)`}
                    </Text>

                    {/* Also on the transport, where the play button is; here as well because this
                        is where the eye is when a reel stops. */}
                    {ended && (
                        <Button size="compact-xs" variant="default" onClick={() => goTo(0)}>
                            Play again
                        </Button>
                    )}
                </Group>

                {/*
                 * Loop rather than shuffle. A reel's order is the cut, so a permutation of it is a
                 * different artefact; what people want from a highlight reel is for it to run
                 * again. Device-local, writing nothing.
                 */}
                <Switch
                    size="xs"
                    label="Loop"
                    checked={loop}
                    onChange={(event) => setLoop(event.currentTarget.checked)}
                />
            </Group>

            {/*
             * The span strip: what is coming, and the way to jump into it.
             *
             * A reel's answer to §14b's up-next strip, and the **one place another person's spans
             * appear** — they all belong to the person named on the reel, so no row carries an
             * author of its own.
             */}
            <Box style={{ overflowX: "auto" }}>
                <Group gap="xs" wrap="nowrap" pb={4}>
                    {playable.map((entry, position) => (
                        <Paper
                            key={entry.id}
                            withBorder
                            p={4}
                            radius="sm"
                            onClick={() => goTo(position)}
                            style={{
                                cursor: "pointer",
                                flex: "0 0 auto",
                                borderColor:
                                    position === cue.index && !ended
                                        ? "var(--mantine-color-brass-5)"
                                        : undefined,
                            }}
                        >
                            <Stack gap={2} w={120}>
                                <ClipThumb
                                    clip={entry.clip}
                                    width={112}
                                    fallbackUrl={entry.media.coverUrl}
                                />
                                <Text size="xs" lineClamp={1}>
                                    {entry.clip.label ?? entry.media.title}
                                </Text>
                                <Group gap={4} wrap="nowrap">
                                    <Text size="xs" c="dimmed">
                                        {formatRun(entry.clip.runMs)}
                                    </Text>
                                    {entry.clip.speed !== null && (
                                        <Badge size="xs" variant="light" color="brass">
                                            {entry.clip.speed}×
                                        </Badge>
                                    )}
                                </Group>
                            </Stack>
                        </Paper>
                    ))}
                </Group>
            </Box>
        </Stack>
    );
};
