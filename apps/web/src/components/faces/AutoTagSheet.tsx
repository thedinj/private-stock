"use client";

import { useState } from "react";
import {
    Alert,
    Box,
    Button,
    Center,
    Group,
    Loader,
    Paper,
    Stack,
    Switch,
    Text,
} from "@mantine/core";

import type { AutoTagEntry, AutoTagPage, FaceReviewFace } from "@private-stock/core";

import { MediaTile } from "@/components/MediaTile";
import { useAutoTags, useDecideAutoTag, useSwitchAutoTag } from "@/lib/api/faces";
import { GRID_GAP, GRID_TRACKS } from "@/lib/gridGeometry";

import { FaceCropView } from "./FaceCropView";
import { FaceViewDrawer } from "./FaceViewDrawer";
import { LookButton } from "./LookButton";

const errorText = (error: unknown): string =>
    error instanceof Error ? error.message : "That change could not be saved.";

const percent = (part: number, whole: number): string =>
    `${Math.round((part / whole) * 1000) / 10}%`;

const why = (entry: AutoTagEntry): string =>
    [
        `${entry.strongFaces} moments of one person look like them`,
        entry.named ? "named on the item" : null,
    ]
        .filter(Boolean)
        .join(" · ");

const AutoTagCard: React.FC<{
    entry: AutoTagEntry;
    onFailed: (error: unknown) => void;
    onPlay: (face: FaceReviewFace) => void;
}> = ({ entry, onFailed, onPlay }) => {
    const decide = useDecideAutoTag();
    const pending = (verdict: "right" | "wrong"): boolean =>
        decide.isPending && decide.variables?.verdict === verdict;
    const send = (verdict: "right" | "wrong"): void =>
        decide.mutate(
            { mediaId: entry.item.id, tagId: entry.tagId, verdict },
            { onError: onFailed }
        );

    return (
        <Stack gap={6}>
            <MediaTile item={entry.item} />
            <Group gap="xs" wrap="nowrap" align="center">
                {entry.face && <FaceCropView crop={entry.face.crop} size={56} />}
                <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
                    <Text size="sm" fw={600}>
                        {entry.name}?
                    </Text>
                    <Text size="xs" c="dimmed">
                        {why(entry)}
                    </Text>
                </Stack>
                {entry.face && (
                    <LookButton face={entry.face} others={entry.others} onPlay={onPlay} />
                )}
            </Group>
            <Group gap="xs" grow>
                <Button
                    color="brass"
                    variant="light"
                    h={44}
                    disabled={decide.isPending}
                    loading={pending("right")}
                    onClick={() => send("right")}
                >
                    Right
                </Button>
                <Button
                    variant="default"
                    h={44}
                    disabled={decide.isPending}
                    loading={pending("wrong")}
                    onClick={() => send("wrong")}
                >
                    Wrong
                </Button>
            </Group>
        </Stack>
    );
};

/** The switch, with what checking has shown so far: the case for turning it on, or off. */
const AutoTagSwitchCard: React.FC<{ page: AutoTagPage }> = ({ page }) => {
    const switchTo = useSwitchAutoTag();
    const checked = page.counts.right + page.counts.wrong;
    const made = page.counts.applied + page.counts.removed;

    return (
        <Paper withBorder radius="md" p="sm">
            <Stack gap={6}>
                <Switch
                    color="brass"
                    checked={page.enabled}
                    disabled={switchTo.isPending}
                    onChange={(event) => switchTo.mutate({ enabled: event.currentTarget.checked })}
                    label="Tag automatically"
                    description={
                        page.enabled
                            ? "Faces tag what the rule proposes after each pass, once its trial below is passed. Everything they tag is listed in History, where Wrong takes it back."
                            : "Off. Nothing is tagged until it is on — check a sample below first."
                    }
                />
                <Text size="sm">
                    {checked > 0
                        ? `Checked ${checked.toLocaleString()}: ${page.counts.right.toLocaleString()} right, ` +
                          `${page.counts.wrong.toLocaleString()} wrong — ${percent(page.counts.right, checked)} right.`
                        : "None checked yet."}
                    {made > 0 &&
                        ` Tagged by faces: ${made.toLocaleString()}, of which ${page.counts.removed.toLocaleString()} taken back.`}
                </Text>
                <Text size="sm">
                    {page.trial.right >= page.trial.needed && page.trial.wrong === 0
                        ? "The rule passed its trial: it tags by itself while the switch is on."
                        : page.trial.wrong > 0
                          ? `The rule's trial found ${page.trial.wrong.toLocaleString()} wrong: it proposes, and does not tag by itself.`
                          : `The rule's trial: ${page.trial.right.toLocaleString()} of ${page.trial.needed} checked right. It tags by itself once ${page.trial.needed} are checked with none wrong.`}
                </Text>
                {page.braked && (
                    <Alert color="oxblood" variant="light">
                        Stopped: more than one in a hundred of the tags faces made were taken back.
                        Nothing more is tagged until that share falls — or check what was taken back
                        in History.
                    </Alert>
                )}
            </Stack>
        </Paper>
    );
};

const INTRO =
    "What faces would tag by themselves: a person in a video, seen at least three times, clearly " +
    "them. Check them from the top — the order is random, so whatever you check is a fair sample " +
    "— and the tally says how often the rule is right.";

/**
 * "Would tag" (§5f "Tagging by itself"): what the rule would tag, in a random order the visit
 * keeps, so whatever is checked from the top is a fair sample; "Right" tags the item and confirms
 * the person, "Wrong" refuses the person for good; and the switch that lets faces tag by
 * themselves, with the trial that must be passed first. "Look" on a card is the frame and the
 * person's other moments, and "Play it here", for a closer look than the tile gives. What the app tagged is in History, where
 * "Wrong" takes it back.
 */
export const AutoTagSheet: React.FC = () => {
    // A fresh order each visit; pages of one visit keep it.
    const [seed] = useState(() => Math.floor(Math.random() * 2 ** 31));
    const list = useAutoTags("proposed", seed);
    const [outcome, setOutcome] = useState<string | null>(null);
    const [viewing, setViewing] = useState<FaceReviewFace | null>(null);
    const entries = list.data?.pages.flatMap((page) => page.rows) ?? [];
    const first = list.data?.pages[0];

    return (
        <Stack gap="md">
            <Text size="sm" c="dimmed">
                {INTRO}
            </Text>

            {first && <AutoTagSwitchCard page={first} />}

            {first && (
                <Text size="sm">{first.counts.proposed.toLocaleString()} would be tagged.</Text>
            )}

            {outcome && (
                <Alert
                    color="oxblood"
                    variant="light"
                    withCloseButton
                    onClose={() => setOutcome(null)}
                >
                    {outcome}
                </Alert>
            )}

            {list.isPending ? (
                <Loader size="sm" />
            ) : list.isError ? (
                <Alert color="oxblood" variant="light">
                    {errorText(list.error)}
                </Alert>
            ) : entries.length === 0 ? (
                <Text size="sm" c="dimmed">
                    Nothing the rule would tag yet. It needs a performer&apos;s face from five or
                    more items, and a person in a video who matches it closely.
                </Text>
            ) : (
                <>
                    <Box
                        style={{
                            display: "grid",
                            gridTemplateColumns: GRID_TRACKS,
                            gap: GRID_GAP,
                        }}
                    >
                        {entries.map((entry) => (
                            <AutoTagCard
                                key={`${entry.item.id}:${entry.tagId}`}
                                entry={entry}
                                onFailed={(error) => setOutcome(errorText(error))}
                                onPlay={setViewing}
                            />
                        ))}
                    </Box>
                    {list.hasNextPage && (
                        <Center>
                            <Button
                                variant="default"
                                h={44}
                                loading={list.isFetchingNextPage}
                                onClick={() => void list.fetchNextPage()}
                            >
                                Show more
                            </Button>
                        </Center>
                    )}
                </>
            )}

            <FaceViewDrawer face={viewing} onClose={() => setViewing(null)} />
        </Stack>
    );
};
