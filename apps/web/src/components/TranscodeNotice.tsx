"use client";

import { Alert, Group, Progress, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";

import type { MediaDetail } from "@private-stock/core";

import { OpenElsewhere } from "@/components/media/OpenElsewhere";
import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/queryKeys";

/**
 * Explaining why a file will not play yet (§8).
 *
 * The alternative is a black rectangle, which is indistinguishable from a broken app. A file
 * that needs a rendition is a normal situation with a known cause and a finite wait, and
 * saying so is the difference between "this is working on it" and "this does not work".
 *
 * Shown once this browser has refused the file (§8): every video is tried first. Whatever the
 * cause, it offers the original to a player outside the browser.
 */

interface TranscodeStatus {
    state: "pending" | "claimed" | "done" | "failed" | "none";
    progress: number | null;
    lastError: string | null;
}

interface TranscodeNoticeProps {
    mediaId: string;
    source: MediaDetail["playbackSource"];
    blockers: string[];
}

export const TranscodeNotice: React.FC<TranscodeNoticeProps> = ({ mediaId, source, blockers }) => {
    const { data } = useQuery({
        queryKey: queryKeys.media.transcode(mediaId),
        queryFn: () => api<TranscodeStatus>(`/api/media/${mediaId}/transcode`),
        // Only while there is something to watch. Polling a finished file forever is the kind
        // of background traffic that makes a NAS feel busy for no reason.
        enabled: source === "pending",
        refetchInterval: (query) =>
            query.state.data?.state === "claimed" || query.state.data?.state === "pending"
                ? 3_000
                : false,
    });

    if (source !== "pending") {
        // Expected to play, and this browser refused it anyway: a device that differs from the
        // ones the verdict was measured on, or an MPEG-TS file whose keyframes are not read yet.
        return (
            <Alert color="oxblood" variant="light" title="This browser could not play this file">
                <Stack gap={8}>
                    <Text size="sm">
                        {source === "segments"
                            ? "It is still being prepared — its keyframes have not been read yet. Try again in a few minutes."
                            : "It plays on the devices this library was checked with, but not here."}
                    </Text>
                    <OpenElsewhere mediaId={mediaId} />
                </Stack>
            </Alert>
        );
    }

    const reason = blockers.length > 0 ? blockers.join(", and ") : "this file is not web-playable";

    if (data?.state === "failed") {
        return (
            <Alert color="oxblood" variant="light" title="This file could not be converted">
                <Stack gap={4}>
                    <Text size="sm">
                        It cannot be played in a browser because {reason}, and converting it failed.
                    </Text>
                    {data.lastError && (
                        <Text size="xs" c="dimmed" style={{ wordBreak: "break-word" }}>
                            {data.lastError}
                        </Text>
                    )}
                    <Text size="xs" c="dimmed">
                        The original file is untouched. An administrator can retry it from
                        Processing › Activity.
                    </Text>
                    <OpenElsewhere mediaId={mediaId} />
                </Stack>
            </Alert>
        );
    }

    const running = data?.state === "claimed";
    const percent = Math.round((data?.progress ?? 0) * 100);

    return (
        <Alert color="brass" variant="light" title="Preparing this for playback">
            <Stack gap={8}>
                <Text size="sm">Your browser cannot play the original because {reason}.</Text>

                {running ? (
                    <Stack gap={4}>
                        <Group justify="space-between">
                            <Text size="xs" c="dimmed">
                                Converting
                            </Text>
                            <Text size="xs" c="dimmed">
                                {percent}%
                            </Text>
                        </Group>
                        {/* Indeterminate until ffmpeg reports a position, which needs a known
                            duration — a striped bar stuck at zero reads as broken. */}
                        <Progress
                            value={percent}
                            animated={percent === 0}
                            color="brass"
                            size="sm"
                        />
                    </Stack>
                ) : (
                    <Text size="xs" c="dimmed">
                        {data?.state === "pending"
                            ? "Queued. It will start when the worker reaches it."
                            : "A converted copy will be made in the background."}
                    </Text>
                )}

                <Text size="xs" c="dimmed">
                    The original is never modified — the converted copy is written alongside it.
                </Text>
                <OpenElsewhere mediaId={mediaId} />
            </Stack>
        </Alert>
    );
};
