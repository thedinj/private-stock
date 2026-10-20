"use client";

import { useState } from "react";
import Link from "next/link";
import { Alert, Anchor, Button, Group, Modal, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";

import { locateInReel, type Clip } from "@private-stock/core";

import { VideoPlayer } from "@/components/VideoPlayer";
import { rememberReturn } from "@/lib/returnTo";

/**
 * Watch one clip without leaving the clip browser (§14d).
 *
 * Over the page rather than on the item's, because the browser is where a selection is being
 * built: going to the video to see what a thumbnail was would drop the ticks and the place in a
 * long, filtered wall. The way to the whole video is still here, as the source's name.
 *
 * **A reel of one.** The player is given the clip as a span with a timeline of its own run, the
 * same as `ReelPlayer` does — so the bar is the clip's rather than the file's, a drag stays inside
 * it, and reaching the out point offers replay instead of resuming the file past it. Nothing is
 * reported as watched: seeing twelve seconds of a film to decide whether to use them is not
 * having watched the film.
 */

const formatTime = (ms: number): string => {
    const total = Math.max(0, Math.round(ms / 1000));
    const minutes = Math.floor(total / 60);

    return `${minutes}:${String(total % 60).padStart(2, "0")}`;
};

interface ClipViewerProps {
    clip: Clip;
    onClose: () => void;
    /** Absent at either end of the page, which is how the button disappears there. */
    onPrevious?: () => void;
    onNext?: () => void;
}

export const ClipViewer: React.FC<ClipViewerProps> = ({ clip, onClose, onPrevious, onNext }) => {
    const phone = useMediaQuery("(max-width: 48em)");

    return (
        <Modal
            opened
            onClose={onClose}
            title={clip.label ?? "Clip"}
            size="xl"
            fullScreen={phone}
            centered
        >
            {/* Keyed by clip, so stepping to the next one arrives fresh rather than inheriting
                the last one's ended state or a refusal that was about another file. */}
            <ClipPlayback key={clip.id} clip={clip} />

            <Group justify="space-between" wrap="wrap" gap="xs" mt="sm">
                <Text size="xs" c="dimmed" style={{ minWidth: 0 }} lineClamp={1}>
                    {formatTime(clip.startMs)}–{formatTime(clip.endMs)} of{" "}
                    <Anchor
                        component={Link}
                        href={`/media/${clip.mediaId}?at=${clip.startMs}`}
                        size="xs"
                        onClick={rememberReturn}
                    >
                        {clip.mediaTitle}
                    </Anchor>
                </Text>

                <Group gap="xs" wrap="nowrap">
                    <Button size="sm" variant="default" disabled={!onPrevious} onClick={onPrevious}>
                        Previous
                    </Button>
                    <Button size="sm" variant="default" disabled={!onNext} onClick={onNext}>
                        Next
                    </Button>
                </Group>
            </Group>
        </Modal>
    );
};

const ClipPlayback: React.FC<{ clip: Clip }> = ({ clip }) => {
    const [cue, setCue] = useState<{ atMs: number | null; nonce: number }>({
        atMs: null,
        nonce: 0,
    });
    const [ended, setEnded] = useState(false);
    const [unplayable, setUnplayable] = useState(false);

    const goTo = (atMs: number | null) => {
        setEnded(false);
        setCue((previous) => ({ atMs, nonce: previous.nonce + 1 }));
    };

    if (unplayable) {
        return (
            <Alert color="gray" variant="light">
                This clip&apos;s file cannot be played here yet — it is waiting on a web-safe
                rendition. Its video page says more.
            </Alert>
        );
    }

    return (
        <VideoPlayer
            mediaId={clip.mediaId}
            durationMs={null}
            spriteVttUrl={null}
            autoPlay
            span={{
                startMs: clip.startMs,
                endMs: clip.endMs,
                speed: clip.speed,
                startAtMs: cue.atMs ?? undefined,
                token: cue.nonce,
            }}
            onSpanEnded={() => setEnded(true)}
            reportProgress={false}
            timeline={{
                offsetMs: 0,
                totalMs: clip.runMs,
                onSeek: (clipMs) => goTo(locateInReel([clip], clipMs)?.atMs ?? null),
            }}
            atEnd={ended}
            onReplay={() => goTo(null)}
            onUnplayable={() => setUnplayable(true)}
        />
    );
};
