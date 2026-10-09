import Link from "next/link";
import {
    Accordion,
    ActionIcon,
    Alert,
    Anchor,
    Badge,
    Group,
    Loader,
    SimpleGrid,
    Stack,
    Text,
    Tooltip,
} from "@mantine/core";

import {
    scoreVideo,
    type ExpectedText,
    type OcrBenchItem,
    type OcrTrialSide,
} from "@private-stock/core";

import { CloseGlyph } from "@/components/media/Glyph";
import { useOcrBench, useSetOcrTestSet } from "@/lib/api/ocr";
import { rememberReturn } from "@/lib/returnTo";

import { ExpectedTextEditor } from "./ExpectedTextEditor";
import { OcrThumb } from "./OcrThumb";
import classes from "./OcrReview.module.scss";

const errorText = (error: unknown): string =>
    error instanceof Error ? error.message : "That did not work.";

const percent = (value: number): string => `${Math.round(value * 100)}%`;

const seconds = (ms: number): string =>
    ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;

const STATE_LABEL: Record<OcrTrialSide["state"], string> = {
    pending: "Waiting",
    running: "Reading…",
    done: "Done",
    failed: "Failed",
};

/** One column of a comparison: what one set of settings read from one video. */
const SideColumn: React.FC<{
    title: string;
    mediaId: string;
    side: OcrTrialSide | null;
    /** Strings the other side also read; the rest are what makes the sides differ. */
    other: Set<string>;
    /** What the video should read, when somebody has said; hits and misses are marked by it. */
    truth: ExpectedText | null;
}> = ({ title, mediaId, side, other, truth }) => {
    const score =
        side?.state === "done" && truth && truth.expected.length > 0
            ? scoreVideo(
                  side.findings.map((finding) => finding.text),
                  truth
              )
            : null;
    const junk = new Set(score?.junk ?? []);

    return (
        <Stack gap={4}>
            <Group gap="xs">
                <Text size="sm" fw={600}>
                    {title}
                </Text>
                {side && (
                    <Badge
                        size="xs"
                        variant="light"
                        color={
                            side.state === "failed"
                                ? "oxblood"
                                : side.state === "done"
                                  ? "gray"
                                  : "brass"
                        }
                    >
                        {STATE_LABEL[side.state]}
                    </Badge>
                )}
            </Group>

            {!side ? (
                <Text size="xs" c="dimmed">
                    Not compared yet.
                </Text>
            ) : side.state === "failed" ? (
                <Text size="xs" c="oxblood.4">
                    {side.error ?? "The read failed."}
                </Text>
            ) : side.state !== "done" ? (
                <Loader size="xs" />
            ) : (
                <>
                    <Text className={classes.stats}>
                        {side.findings.length} {side.findings.length === 1 ? "string" : "strings"}
                        {side.framesRead !== null && ` · ${side.framesRead} frames`}
                        {side.elapsedMs !== null && ` · ${seconds(side.elapsedMs)}`}
                    </Text>
                    {score && truth && (
                        <Text size="xs" c={score.misses.length === 0 ? "brass.3" : undefined}>
                            Read {score.hits.length} of {truth.expected.length} expected
                            {score.misses.length > 0 && ` · missed ${score.misses.join(", ")}`}
                        </Text>
                    )}
                    {side.findings.length === 0 ? (
                        <Text size="xs" c="dimmed">
                            Nothing cleared the floors.
                        </Text>
                    ) : (
                        side.findings.map((finding, index) => {
                            const onlyHere = !other.has(finding.textNorm);

                            return (
                                <Group key={`${finding.textNorm}-${index}`} gap={6} wrap="nowrap">
                                    {finding.firstAtMs !== null ? (
                                        <Anchor
                                            component={Link}
                                            href={`/media/${mediaId}?at=${finding.firstAtMs}`}
                                            prefetch={false}
                                            onClick={rememberReturn}
                                            className={classes.string}
                                            c={onlyHere ? "brass.3" : undefined}
                                            fz={12}
                                        >
                                            {finding.text}
                                        </Anchor>
                                    ) : (
                                        <Text
                                            className={classes.string}
                                            c={onlyHere ? "brass.3" : undefined}
                                            fz={12}
                                        >
                                            {finding.text}
                                        </Text>
                                    )}
                                    <Text className={classes.stats}>
                                        {percent(finding.confidence)} · {finding.occurrences}×
                                    </Text>
                                    {onlyHere && (
                                        <Badge
                                            size="xs"
                                            variant="light"
                                            color="brass"
                                            className={classes.badge}
                                        >
                                            only here
                                        </Badge>
                                    )}
                                    {junk.has(finding.text) && (
                                        <Badge
                                            size="xs"
                                            variant="light"
                                            color="oxblood"
                                            className={classes.badge}
                                        >
                                            not expected
                                        </Badge>
                                    )}
                                </Group>
                            );
                        })
                    )}
                </>
            )}
        </Stack>
    );
};

/** One side's result in a few words, for a video's collapsed header. */
const sideSummary = (side: OcrTrialSide | null, truth: ExpectedText): string => {
    if (!side) return "not compared";
    if (side.state === "failed") return "failed";
    if (side.state !== "done") return "reading…";

    const strings = `${side.findings.length} ${side.findings.length === 1 ? "string" : "strings"}`;

    if (truth.expected.length === 0) return strings;

    const score = scoreVideo(
        side.findings.map((finding) => finding.text),
        truth
    );

    return `${strings}, ${score.hits.length} of ${truth.expected.length} expected`;
};

/**
 * One video on the bench, collapsed to what the comparison found.
 *
 * Opened, it is the two sides read fresh -- strings only one side read marked, which is usually
 * the whole answer -- and what the video should read, which is what the tuner scores against.
 */
const BenchVideo: React.FC<{ item: OcrBenchItem; onRemove: () => void }> = ({ item, onRemove }) => {
    const currentSet = new Set(item.current?.findings.map((finding) => finding.textNorm) ?? []);
    const candidateSet = new Set(item.candidate?.findings.map((finding) => finding.textNorm) ?? []);
    const truth: ExpectedText = { expected: item.expected, complete: item.complete };

    return (
        <Accordion.Item value={item.mediaId}>
            <Group gap={0} wrap="nowrap">
                <Accordion.Control>
                    <Group gap="sm" wrap="nowrap">
                        <OcrThumb
                            mediaId={item.mediaId}
                            frame={null}
                            coverUrl={item.coverUrl}
                            box={null}
                            atMs={null}
                            width={64}
                            label={item.fileName}
                        />
                        <div style={{ minWidth: 0 }}>
                            <Text size="sm" truncate>
                                {item.fileName}
                            </Text>
                            <Text size="xs" c="dimmed" truncate>
                                now {sideSummary(item.current, truth)} · draft{" "}
                                {sideSummary(item.candidate, truth)}
                            </Text>
                        </div>
                    </Group>
                </Accordion.Control>
                <Tooltip label="Take off the bench" withArrow>
                    <ActionIcon
                        variant="subtle"
                        color="gray"
                        mr="xs"
                        aria-label={`Take ${item.fileName} off the bench`}
                        onClick={onRemove}
                    >
                        <CloseGlyph size={16} />
                    </ActionIcon>
                </Tooltip>
            </Group>

            <Accordion.Panel>
                <Stack gap="sm">
                    <ExpectedTextEditor item={item} />
                    <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
                        <SideColumn
                            title="Current settings"
                            mediaId={item.mediaId}
                            side={item.current}
                            other={candidateSet}
                            truth={truth}
                        />
                        <SideColumn
                            title="Draft"
                            mediaId={item.mediaId}
                            side={item.candidate}
                            other={currentSet}
                            truth={truth}
                        />
                    </SimpleGrid>
                </Stack>
            </Accordion.Panel>
        </Accordion.Item>
    );
};

/**
 * The OCR test bench (§5d "Settings and the test bench"): a few nominated videos, each read
 * fresh with the current settings and with the form's draft. Nothing here touches stored text.
 *
 * Its form is the settings form above it -- "Compare on bench" sends the draft -- so there is no
 * second copy of the twelve fields here.
 */
export const OcrBench: React.FC = () => {
    const bench = useOcrBench();
    const setTestSet = useSetOcrTestSet();

    if (bench.isPending) {
        return <Loader size="sm" />;
    }

    if (bench.isError || !bench.data) {
        return (
            <Alert color="oxblood" variant="light">
                {errorText(bench.error)}
            </Alert>
        );
    }

    const items = bench.data.items;

    if (items.length === 0) {
        return (
            <Text size="sm" c="dimmed">
                Add a few videos with the kind of text you care about, with “Add to test bench” in a
                video’s details.
            </Text>
        );
    }

    return (
        <Accordion multiple variant="contained" chevronPosition="left">
            {items.map((item) => (
                <BenchVideo
                    key={item.mediaId}
                    item={item}
                    onRemove={() =>
                        setTestSet.mutate({
                            mediaIds: items
                                .map((other) => other.mediaId)
                                .filter((id) => id !== item.mediaId),
                        })
                    }
                />
            ))}
        </Accordion>
    );
};
