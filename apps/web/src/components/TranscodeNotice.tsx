"use client";

import { Alert, Button, Group, Progress, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";

import type { MediaDetail } from "@private-stock/core";

import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/queryKeys";

/**
 * Explaining why a file will not play yet (§8).
 *
 * The alternative is a black rectangle, which is indistinguishable from a broken app. A file
 * that needs a rendition is a normal situation with a known cause and a finite wait, and
 * saying so is the difference between "this is working on it" and "this does not work".
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
    /**
     * Whether the original is being tried anyway, and how that went (§8). `assessPlayback`
     * answers once for every device, and the one in somebody's hand may do better than it says.
     */
    trial: "idle" | "trying" | "refused";
    onTryOriginal: () => void;
}

export const TranscodeNotice: React.FC<TranscodeNoticeProps> = ({
    mediaId,
    source,
    blockers,
    trial,
    onTryOriginal,
}) => {
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
        return null;
    }

    const reason = blockers.length > 0 ? blockers.join(", and ") : "this file is not web-playable";

    if (trial === "trying") {
        return (
            <Alert color="brass" variant="light" title="Trying the original">
                <Text size="sm">
                    Expected not to play because {reason}. If you get both picture and sound, this
                    device can play it as it is.
                </Text>
            </Alert>
        );
    }

    if (trial === "refused") {
        return (
            <Alert color="oxblood" variant="light" title="This browser refused the original">
                <Text size="sm">As expected: {reason}.</Text>
            </Alert>
        );
    }

    // Offered whatever the conversion is doing: the original is right here, and finding out
    // costs a click rather than a wait.
    const tryButton = (
        <Group>
            <Button size="xs" variant="light" color="brass" onClick={onTryOriginal}>
                Try the original
            </Button>
        </Group>
    );

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
                    {tryButton}
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
                {tryButton}
            </Stack>
        </Alert>
    );
};
