import { useState } from "react";
import {
    Alert,
    Badge,
    Button,
    Group,
    Paper,
    Progress,
    SegmentedControl,
    SimpleGrid,
    Stack,
    Text,
} from "@mantine/core";

import type {
    OcrBenchItem,
    OcrSettings,
    TuneCandidate,
    TuneCostWeight,
    TuneMode,
} from "@private-stock/core";

import { useOcrTune, useOcrTuneEstimate, useStartOcrTune, useStopOcrTune } from "@/lib/api/ocr";

import classes from "./OcrReview.module.scss";

const errorText = (error: unknown): string =>
    error instanceof Error ? error.message : "That did not work.";

const percent = (value: number): string => `${Math.round(value * 100)}%`;

/** How a setting is named where the difference from the current ones is listed. */
const SETTING_LABELS: Record<keyof OcrSettings, string> = {
    confidenceMin: "Minimum confidence",
    occurrencesMin: "Minimum frames",
    minLength: "Minimum length",
    probeFrames: "First-pass frames",
    burstSeconds: "Opening read closely",
    burstEverySeconds: "Opening interval",
    sweepEverySeconds: "Rest of item, every",
    maxFrames: "Most frames per item",
    confirmedOccurrences: "Stop once seen in",
    psm: "Layout mode",
    frameWidth: "Frame width",
    contrast: "Boost faint text",
};

const showValue = (key: keyof OcrSettings, value: OcrSettings[keyof OcrSettings]): string =>
    key === "contrast"
        ? value
            ? "on"
            : "off"
        : key.endsWith("Seconds")
          ? `${value}s`
          : key === "frameWidth"
            ? `${value}px`
            : String(value);

const PICK_TITLES = {
    quality: "Reads the most",
    balance: "Best balance",
    cheapest: "Same quality, cheaper",
} as const;

const CandidateCard: React.FC<{
    title: string;
    candidate: TuneCandidate;
    baseline: TuneCandidate;
    names: Map<string, string>;
    onCompare: (settings: OcrSettings) => void;
    onLoad: (settings: OcrSettings) => void;
}> = ({ title, candidate, baseline, names, onCompare, onLoad }) => {
    const changes = (Object.keys(SETTING_LABELS) as (keyof OcrSettings)[]).filter(
        (key) => candidate.settings[key] !== baseline.settings[key]
    );

    return (
        <Paper withBorder radius="md" p="sm">
            <Stack gap={6}>
                <Text fw={600} size="sm">
                    {title}
                </Text>
                <Text className={classes.stats}>
                    reads {percent(candidate.recall)} of expected · {percent(candidate.junkRate)}{" "}
                    noise · {candidate.frameRatio.toFixed(2)}× the frames
                </Text>

                {changes.length === 0 ? (
                    <Text size="xs" c="dimmed">
                        The current settings.
                    </Text>
                ) : (
                    <Stack gap={0}>
                        {changes.map((key) => (
                            <Text key={key} size="xs">
                                {SETTING_LABELS[key]}: {showValue(key, baseline.settings[key])} →{" "}
                                <strong>{showValue(key, candidate.settings[key])}</strong>
                            </Text>
                        ))}
                    </Stack>
                )}

                <Stack gap={2}>
                    {candidate.videos.map((video) => (
                        <Text key={video.mediaId} size="xs" c="dimmed">
                            {names.get(video.mediaId) ?? video.mediaId}:{" "}
                            {video.misses.length === 0
                                ? "everything expected"
                                : `missed ${video.misses.join(", ")}`}
                            {video.junk.length > 0
                                ? ` · junk: ${video.junk.join(", ")}`
                                : video.unexpected.length > 0 &&
                                  ` · ${video.unexpected.length} other ${
                                      video.unexpected.length === 1 ? "string" : "strings"
                                  }: ${video.unexpected.slice(0, 6).join(", ")}${
                                      video.unexpected.length > 6 ? "…" : ""
                                  }`}
                        </Text>
                    ))}
                </Stack>

                {changes.length > 0 && (
                    <Group gap="xs">
                        <Button
                            size="compact-xs"
                            variant="default"
                            onClick={() => onCompare(candidate.settings)}
                        >
                            Compare on bench
                        </Button>
                        {/* Into the form rather than straight into use: Save stays the one
                            thing that changes what the library is read with. */}
                        <Button
                            size="compact-xs"
                            variant="light"
                            color="brass"
                            onClick={() => onLoad(candidate.settings)}
                        >
                            Load into form
                        </Button>
                    </Group>
                )}
            </Stack>
        </Paper>
    );
};

/**
 * Tuning against expected text (§5d "Tuning against expected text").
 *
 * A search, not a guess: every candidate is scored by replaying what Tesseract already read
 * from the bench's videos, so hundreds are tried for the price of reading each frame once.
 * Three results rather than one, because the trade between reading more and reading less is
 * the administrator's: the most text, the best balance at the cost weight chosen, and the
 * same quality as now for fewer frames.
 *
 * A result loads into the settings form above, where it can be compared on the bench and saved
 * like any other edit.
 */
export const OcrTunePanel: React.FC<{
    items: OcrBenchItem[];
    onCompare: (settings: OcrSettings) => void;
    onLoad: (settings: OcrSettings) => void;
}> = ({ items, onCompare, onLoad }) => {
    const tune = useOcrTune();
    const latest = tune.data?.latest ?? null;
    const estimate = useOcrTuneEstimate(latest ? `${latest.id}:${latest.state}` : "none");
    const start = useStartOcrTune();
    const stop = useStopOcrTune();
    const [mode, setMode] = useState<TuneMode>("quick");
    const [costWeight, setCostWeight] = useState<TuneCostWeight>("medium");

    const labelled = items.filter((item) => item.expected.length > 0);
    const active = latest?.state === "pending" || latest?.state === "running";
    const result = latest?.state === "done" ? latest.result : null;
    const names = new Map(items.map((item) => [item.mediaId, item.fileName]));
    const cost = estimate.data?.[mode];

    return (
        <Stack gap="md">
            {labelled.length === 0 ? (
                <Text size="sm" c="dimmed">
                    Open a video on the test bench and say what it should read, to tune against it.
                </Text>
            ) : (
                <>
                    <SimpleGrid cols={{ base: 1, sm: 2 }}>
                        <Stack gap={4}>
                            <Text size="sm" fw={500}>
                                How hard to look
                            </Text>
                            <SegmentedControl
                                value={mode}
                                onChange={(value) => setMode(value as TuneMode)}
                                data={[
                                    { value: "quick", label: "Quick" },
                                    { value: "thorough", label: "Thorough" },
                                ]}
                                color="brass"
                                disabled={active}
                            />
                            <Text size="xs" c="dimmed">
                                Quick tries one change at a time; Thorough tries every way of
                                reading frames.
                            </Text>
                        </Stack>
                        <Stack gap={4}>
                            <Text size="sm" fw={500}>
                                How much reading more frames matters
                            </Text>
                            <SegmentedControl
                                value={costWeight}
                                onChange={(value) => setCostWeight(value as TuneCostWeight)}
                                data={[
                                    { value: "low", label: "Little" },
                                    { value: "medium", label: "Some" },
                                    { value: "high", label: "A lot" },
                                ]}
                                color="brass"
                                disabled={active}
                            />
                            <Text size="xs" c="dimmed">
                                Only affects the “Best balance” result.
                            </Text>
                        </Stack>
                    </SimpleGrid>

                    {!active && cost && (
                        <Text size="sm">
                            {cost.framesToRead === 0
                                ? `Everything this needs is already read — it will take seconds (${cost.videos} ${cost.videos === 1 ? "video" : "videos"}).`
                                : `Reads about ${cost.framesToRead.toLocaleString()} frames across ${cost.videos} ${cost.videos === 1 ? "video" : "videos"}, roughly ${cost.minutes} ${cost.minutes === 1 ? "minute" : "minutes"}. A second run reads only what is new.`}
                        </Text>
                    )}

                    {(start.isError || stop.isError) && (
                        <Alert color="oxblood" variant="light">
                            {errorText(start.error ?? stop.error)}
                        </Alert>
                    )}

                    <Group gap="sm">
                        {active ? (
                            <Button
                                variant="default"
                                loading={stop.isPending}
                                onClick={() => stop.mutate({})}
                            >
                                Stop
                            </Button>
                        ) : (
                            <Button
                                color="brass"
                                loading={start.isPending}
                                onClick={() => start.mutate({ mode, costWeight })}
                            >
                                Tune on {labelled.length}{" "}
                                {labelled.length === 1 ? "video" : "videos"}
                            </Button>
                        )}
                    </Group>
                </>
            )}

            {active && latest && (
                <Stack gap={4}>
                    <Progress value={latest.progress * 100} color="brass" animated />
                    <Text size="xs" c="dimmed">
                        {latest.state === "pending"
                            ? "Waiting to start…"
                            : (latest.stage ?? "Working…")}
                    </Text>
                </Stack>
            )}

            {latest?.state === "failed" && (
                <Alert color="oxblood" variant="light" title="The last run failed">
                    {latest.error ?? "No reason was recorded."} What it read is kept, so another run
                    resumes rather than starting over.
                </Alert>
            )}
            {latest?.state === "cancelled" && (
                <Text size="sm" c="dimmed">
                    The last run was stopped. What it read is kept for the next.
                </Text>
            )}

            {result && (
                <Stack gap="sm">
                    <Group gap="xs">
                        <Text size="sm" fw={600}>
                            Results
                        </Text>
                        <Badge size="xs" variant="light" color="gray">
                            {result.evaluated.toLocaleString()} settings tried
                        </Badge>
                        <Badge size="xs" variant="light" color="gray">
                            {result.framesExtracted.toLocaleString()} frames read,{" "}
                            {Math.round(result.elapsedMs / 1000)}s
                        </Badge>
                    </Group>
                    <Text size="xs" c="dimmed">
                        Now: reads {percent(result.baseline.recall)} of expected with{" "}
                        {percent(result.baseline.junkRate)} noise.
                    </Text>
                    <SimpleGrid cols={{ base: 1, md: 3 }}>
                        {(["quality", "balance", "cheapest"] as const).map((pick) => {
                            const candidate = result.picks[pick];
                            // The same settings under two names is one answer, said once.
                            const repeats =
                                pick === "balance" &&
                                candidate &&
                                JSON.stringify(candidate.settings) ===
                                    JSON.stringify(result.picks.quality.settings);

                            if (repeats) {
                                return (
                                    <Paper key={pick} withBorder radius="md" p="sm">
                                        <Text fw={600} size="sm">
                                            {PICK_TITLES[pick]}
                                        </Text>
                                        <Text size="xs" c="dimmed">
                                            The same settings as “{PICK_TITLES.quality}”: reading
                                            the most also costs the least here.
                                        </Text>
                                    </Paper>
                                );
                            }

                            return candidate ? (
                                <CandidateCard
                                    key={pick}
                                    title={PICK_TITLES[pick]}
                                    candidate={candidate}
                                    baseline={result.baseline}
                                    names={names}
                                    onCompare={onCompare}
                                    onLoad={onLoad}
                                />
                            ) : (
                                <Paper key={pick} withBorder radius="md" p="sm">
                                    <Text fw={600} size="sm">
                                        {PICK_TITLES[pick]}
                                    </Text>
                                    <Text size="xs" c="dimmed">
                                        Nothing tried read as much for fewer frames.
                                    </Text>
                                </Paper>
                            );
                        })}
                    </SimpleGrid>
                </Stack>
            )}
        </Stack>
    );
};
