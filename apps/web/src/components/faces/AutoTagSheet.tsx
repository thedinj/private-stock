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

import type { AutoTagEntry, AutoTagPage } from "@private-stock/core";

import { MediaTile } from "@/components/MediaTile";
import { useAutoTags, useDecideAutoTag, useSwitchAutoTag } from "@/lib/api/faces";
import { GRID_GAP, GRID_TRACKS } from "@/lib/gridGeometry";

import { FaceCropView } from "./FaceCropView";

const errorText = (error: unknown): string =>
    error instanceof Error ? error.message : "That change could not be saved.";

const percent = (part: number, whole: number): string =>
    `${Math.round((part / whole) * 1000) / 10}%`;

const why = (entry: AutoTagEntry): string =>
    [
        entry.strongFaces >= 2
            ? `${entry.strongFaces} moments look like them`
            : "a face looks like them",
        entry.named ? "named on the item" : null,
    ]
        .filter(Boolean)
        .join(" · ");

type Mode = "proposed" | "applied";

const AutoTagCard: React.FC<{
    entry: AutoTagEntry;
    mode: Mode;
    onFailed: (error: unknown) => void;
}> = ({ entry, mode, onFailed }) => {
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
                <Stack gap={0} style={{ minWidth: 0 }}>
                    <Text size="sm" fw={600}>
                        {mode === "proposed" ? `${entry.name}?` : entry.name}
                    </Text>
                    <Text size="xs" c="dimmed">
                        {why(entry)}
                    </Text>
                </Stack>
            </Group>
            {mode === "proposed" ? (
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
            ) : (
                <Button
                    variant="default"
                    h={44}
                    loading={pending("wrong")}
                    onClick={() => send("wrong")}
                >
                    Not {entry.name}
                </Button>
            )}
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
                            ? "Faces tag what the rule proposes after each pass. Everything they tag is listed under Tagged for you, and can be undone."
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
                {page.braked && (
                    <Alert color="oxblood" variant="light">
                        Stopped: more than one in a hundred of the tags faces made were taken back.
                        Nothing more is tagged until that share falls — or check what was taken back
                        under Tagged for you.
                    </Alert>
                )}
            </Stack>
        </Paper>
    );
};

const INTRO: Record<Mode, string> = {
    proposed:
        "What faces would tag by themselves. Check them from the top — the order is random, so " +
        "whatever you check is a fair sample — and the tally says how often the rule is right.",
    applied:
        "What faces tagged by themselves, newest first. Taking one back says it is not them, so " +
        "it is never tagged again — and counts against tagging by itself.",
};

/**
 * "Would tag" and "Tagged for you" (§5f "Tagging by itself").
 *
 * **Would tag**: what the rule would tag, in a random order the visit keeps, so whatever is checked
 * from the top is a fair sample; "Right" tags the item, "Wrong" refuses it for good; and the switch
 * that lets faces tag by themselves, with the tally that is the case for it.
 *
 * **Tagged for you**: what they tagged, newest first, each with "Not ‹name›" — taken off, refused,
 * and counted: more than one in a hundred taken back stops them.
 */
export const AutoTagSheet: React.FC<{ mode: Mode }> = ({ mode }) => {
    // A fresh order each visit; pages of one visit keep it.
    const [seed] = useState(() => Math.floor(Math.random() * 2 ** 31));
    const list = useAutoTags(mode, seed);
    const [outcome, setOutcome] = useState<string | null>(null);
    const entries = list.data?.pages.flatMap((page) => page.rows) ?? [];
    const first = list.data?.pages[0];

    return (
        <Stack gap="md">
            <Text size="sm" c="dimmed">
                {INTRO[mode]}
            </Text>

            {first && mode === "proposed" && <AutoTagSwitchCard page={first} />}

            {first && mode === "proposed" && (
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
                    {mode === "proposed"
                        ? "Nothing the rule would tag yet. It needs a performer's face from five or more items, and faces that match it closely."
                        : "Faces have not tagged anything by themselves."}
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
                                mode={mode}
                                onFailed={(error) => setOutcome(errorText(error))}
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
        </Stack>
    );
};
