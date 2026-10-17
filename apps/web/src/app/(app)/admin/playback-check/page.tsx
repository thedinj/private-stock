"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
    Alert,
    Anchor,
    Badge,
    Button,
    Card,
    CopyButton,
    Group,
    Loader,
    Stack,
    Text,
    Textarea,
    Title,
} from "@mantine/core";

import type { PlaybackCheck } from "@private-stock/core";

import { PagePlate } from "@/components/shell/PagePlate";
import { usePlaybackCheck } from "@/lib/api/playbackCheck";
import {
    describeDevice,
    describeTrial,
    trialPlays,
    tryPlayback,
    type TrialResult,
} from "@/lib/playbackTrial";

/**
 * The playback check, run on whichever device opens it (§8).
 *
 * `assessPlayback` says a browser will refuse these files; this asks the browser in the
 * viewer's hand. It starts by itself and tries the samples one at a time in one small, muted
 * player -- one at a time because phones have few decoders -- so checking a device means
 * opening this page on it and waiting a minute. The summary at the foot is for comparing
 * devices.
 */

type Results = Record<string, TrialResult | "running">;

const colorFor = (result: TrialResult): string =>
    trialPlays(result) ? "verdigris" : result.outcome === "played" ? "brass" : "oxblood";

const summarise = (device: string, check: PlaybackCheck, results: Results): string =>
    [
        `${device} — ${navigator.userAgent}`,
        ...check.groups.map((group) => {
            const answers = group.samples.map((sample) => {
                const result = results[sample.id];

                return result && result !== "running" ? describeTrial(result) : "not tried";
            });

            return `${group.kind} (${group.count}): ${answers.join(" / ")}`;
        }),
    ].join("\n");

const PlaybackCheckPage: React.FC = () => {
    const { data, isLoading, isError, error } = usePlaybackCheck();
    const videoRef = useRef<HTMLVideoElement>(null);
    const [results, setResults] = useState<Results>({});
    const [running, setRunning] = useState(false);
    const [device, setDevice] = useState("");

    useEffect(() => setDevice(describeDevice(navigator.userAgent)), []);

    const run = useCallback(async () => {
        const video = videoRef.current;

        if (!data || !video) {
            return;
        }

        setRunning(true);
        setResults({});

        for (const group of data.groups) {
            for (const sample of group.samples) {
                setResults((current) => ({ ...current, [sample.id]: "running" }));

                const result = await tryPlayback(
                    video,
                    `/api/media/${sample.id}/stream`,
                    sample.hasAudio
                );

                setResults((current) => ({ ...current, [sample.id]: result }));
            }
        }

        setRunning(false);
    }, [data]);

    // Starts by itself: opening the page on a device is the whole of what checking it asks.
    const started = useRef(false);

    useEffect(() => {
        if (data && !started.current) {
            started.current = true;
            void run();
        }
    }, [data, run]);

    const finished = data !== undefined && !running && Object.keys(results).length > 0;

    return (
        <Stack gap="lg">
            <PagePlate
                eyebrow="Admin"
                title="Playback check"
                back={{ href: "/admin/processing?tab=transcoding", label: "Processing" }}
                lede={
                    device
                        ? `Trying in ${device}. Open this page on each device you watch on.`
                        : undefined
                }
            />

            <Stack gap="md" maw={860}>
                {isLoading && <Loader size="sm" />}
                {isError && (
                    <Alert color="oxblood" variant="light">
                        {error instanceof Error ? error.message : "That did not load."}
                    </Alert>
                )}

                {data && data.total === 0 && (
                    <Text size="sm" c="dimmed">
                        Every probed video is expected to play in a browser. Nothing to check.
                    </Text>
                )}

                {data && data.total > 0 && (
                    <>
                        <Text size="sm" c="dimmed">
                            {data.total.toLocaleString()} videos are expected not to play. Two of
                            each kind are tried here, the same two on every device, muted and one at
                            a time.
                        </Text>

                        <Group gap="sm" align="center">
                            <Button
                                variant="light"
                                color="brass"
                                loading={running}
                                onClick={() => void run()}
                            >
                                Run again
                            </Button>
                            {running && (
                                <Text size="sm" c="dimmed">
                                    Trying…
                                </Text>
                            )}
                        </Group>
                    </>
                )}

                {/* Always mounted, so the run has an element to play in; shown only while it
                    plays, small, so a person can see that a "plays" means a picture. */}
                <video
                    ref={videoRef}
                    playsInline
                    muted
                    style={{
                        display: running ? "block" : "none",
                        width: 240,
                        maxWidth: "100%",
                        aspectRatio: "16 / 9",
                        background: "black",
                        borderRadius: 4,
                    }}
                />

                {data?.groups.map((group) => (
                    <Card key={group.kind} p="md">
                        <Stack gap="xs">
                            <Group justify="space-between" wrap="nowrap" gap="sm">
                                <Title order={5}>{group.kind}</Title>
                                <Text size="sm" c="dimmed" style={{ flexShrink: 0 }}>
                                    {group.count.toLocaleString()}{" "}
                                    {group.count === 1 ? "file" : "files"}
                                </Text>
                            </Group>

                            {group.samples.map((sample) => {
                                const result = results[sample.id];

                                return (
                                    <Group
                                        key={sample.id}
                                        justify="space-between"
                                        wrap="nowrap"
                                        gap="sm"
                                        mih={44}
                                    >
                                        <Anchor
                                            component={Link}
                                            href={`/media/${sample.id}`}
                                            size="sm"
                                            lineClamp={1}
                                        >
                                            {sample.title}
                                        </Anchor>
                                        {result === "running" ? (
                                            <Loader size="xs" />
                                        ) : result ? (
                                            <Badge
                                                variant="light"
                                                color={colorFor(result)}
                                                title={
                                                    result.outcome === "refused"
                                                        ? result.detail
                                                        : undefined
                                                }
                                                style={{ flexShrink: 0 }}
                                            >
                                                {describeTrial(result)}
                                            </Badge>
                                        ) : null}
                                    </Group>
                                );
                            })}
                        </Stack>
                    </Card>
                ))}

                {finished && data && (
                    <Card p="md">
                        <Stack gap="xs">
                            <Group justify="space-between">
                                <Title order={5}>Summary</Title>
                                <CopyButton value={summarise(device, data, results)}>
                                    {({ copied, copy }) => (
                                        <Button size="xs" variant="light" onClick={copy}>
                                            {copied ? "Copied" : "Copy"}
                                        </Button>
                                    )}
                                </CopyButton>
                            </Group>
                            {/* Selectable as well as copyable: the clipboard needs a secure
                                origin, and the LAN address is not one. */}
                            <Textarea
                                readOnly
                                autosize
                                minRows={3}
                                value={summarise(device, data, results)}
                                styles={{
                                    input: {
                                        fontFamily: "var(--mantine-font-family-monospace)",
                                        fontSize: 12,
                                    },
                                }}
                            />
                        </Stack>
                    </Card>
                )}
            </Stack>
        </Stack>
    );
};

export default PlaybackCheckPage;
