"use client";

import { useState } from "react";
import Link from "next/link";
import {
    Alert,
    Badge,
    Button,
    Group,
    Loader,
    Paper,
    Popover,
    SegmentedControl,
    Stack,
    Text,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";

import type { FaceHistoryEntry } from "@private-stock/core";

import { useFaceHistory, useUndoFaceDecision } from "@/lib/api/faces";
import { itemHref } from "@/lib/lookMoment";

import { FaceCropView } from "./FaceCropView";

/**
 * History (§5f "Decisions you can take back"): every face decision, newest first — yours, and the
 * app's own tags — with what each did, and Undo. Undo takes back exactly what one decision wrote
 * and still stands, its tags with it; for the app's tags, "Wrong" also says "not them" on those
 * items, so it never tags them again, and counts against it tagging by itself.
 */

const items = (n: number): string => `${n.toLocaleString()} ${n === 1 ? "item" : "items"}`;
const faces = (n: number): string => `${n.toLocaleString()} ${n === 1 ? "face" : "faces"}`;

const WHERE: Record<string, string> = {
    review: "Review",
    performer: "Their page",
    item: "Item page",
    wouldTag: "Would tag",
    untag: "Tag taken off",
    findUntagged: "Find untagged",
    auto: "By their face",
    history: "History",
    earlier: "Before history was kept",
};

const describe = (entry: FaceHistoryEntry): string => {
    const who = entry.performer?.name ?? "a performer since deleted";

    if (entry.verdict === "later") return `Can't tell — ${faces(entry.faceCount)}`;
    if (entry.verdict === "notOnePerson") return `Not one person — ${faces(entry.faceCount)}`;
    if (entry.verdict === "isNot") return `Not ${who} — ${items(entry.itemCount)}`;
    if (entry.actor === "app") return `Tagged ${who} on ${items(entry.itemCount)}`;

    return `${who} — ${items(entry.itemCount)}${entry.tagged ? ", tagged" : ""}`;
};

const when = (at: string): string =>
    new Date(`${at.replace(" ", "T")}Z`).toLocaleString(undefined, {
        day: "numeric",
        month: "short",
        hour: "numeric",
        minute: "2-digit",
    });

const UndoControl: React.FC<{ entry: FaceHistoryEntry }> = ({ entry }) => {
    const undo = useUndoFaceDecision();
    const [opened, setOpened] = useState(false);
    const app = entry.actor === "app";

    return (
        <Popover opened={opened} onChange={setOpened} position="bottom-end" withArrow>
            <Popover.Target>
                <Button
                    variant="default"
                    h={44}
                    onClick={() => setOpened((open) => !open)}
                    loading={undo.isPending}
                >
                    {app ? "Wrong" : "Undo"}
                </Button>
            </Popover.Target>
            <Popover.Dropdown>
                <Stack gap="xs" maw={300}>
                    <Text size="sm">
                        {app
                            ? `Take the tag off ${items(entry.itemCount)} and say it is not ${entry.performer?.name ?? "them"} there, so it is not tagged again.`
                            : entry.tagged
                              ? "Take back what this decided, and the tags it added."
                              : "Take back what this decided: those faces are asked about again."}
                    </Text>
                    {undo.error && (
                        <Text size="xs" c="oxblood.4">
                            {undo.error.message}
                        </Text>
                    )}
                    <Group gap="xs">
                        <Button
                            size="compact-sm"
                            color="brass"
                            loading={undo.isPending}
                            onClick={() =>
                                undo.mutate(
                                    { id: entry.id, wrong: app },
                                    { onSuccess: () => setOpened(false) }
                                )
                            }
                        >
                            {app ? "It's wrong" : "Undo it"}
                        </Button>
                        <Button
                            size="compact-sm"
                            variant="default"
                            onClick={() => setOpened(false)}
                        >
                            Cancel
                        </Button>
                    </Group>
                </Stack>
            </Popover.Dropdown>
        </Popover>
    );
};

const EntryRow: React.FC<{ entry: FaceHistoryEntry }> = ({ entry }) => {
    // Two faces on a phone, so what was decided keeps room to be read.
    const isPhone = useMediaQuery("(max-width: 48em)");

    return (
        <Paper withBorder radius="md" p="sm" style={{ opacity: entry.undoneAt ? 0.55 : 1 }}>
            <Group gap="sm" wrap="nowrap" align="center">
                <Group gap={4} wrap="nowrap" style={{ flex: "0 0 auto" }}>
                    {entry.faces.slice(0, isPhone ? 2 : 4).map((face) => (
                        <Link
                            key={face.id}
                            href={itemHref(face.mediaId, face.atMs)}
                            prefetch={false}
                            aria-label="Open the item"
                        >
                            <FaceCropView crop={face.crop} size={48} />
                        </Link>
                    ))}
                </Group>
                <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
                    <Text size="sm" fw={500} lineClamp={2}>
                        {describe(entry)}
                    </Text>
                    <Text size="xs" c="dimmed">
                        {entry.actor === "app" ? "The app" : "You"} ·{" "}
                        {WHERE[entry.surface] ?? entry.surface} · {when(entry.createdAt)}
                    </Text>
                </Stack>
                {entry.undoneAt ? (
                    <Badge variant="light" color="gray" style={{ textTransform: "none" }}>
                        Undone
                    </Badge>
                ) : (
                    <UndoControl entry={entry} />
                )}
            </Group>
        </Paper>
    );
};

export const FaceHistorySheet: React.FC = () => {
    const [actor, setActor] = useState<"all" | "user" | "app">("all");
    const history = useFaceHistory(actor, null);
    const entries = history.data?.pages.flatMap((page) => page.entries) ?? [];

    return (
        <Stack gap="md">
            <Group gap="sm" justify="space-between" wrap="wrap">
                <Text size="sm" c="dimmed" style={{ flex: "1 1 260px" }}>
                    Every face decision, newest first. Undo takes back exactly what one decided, and
                    the tags it added.
                </Text>
                <SegmentedControl
                    size="sm"
                    color="brass"
                    value={actor}
                    onChange={(value) => setActor(value as typeof actor)}
                    data={[
                        { value: "all", label: "All" },
                        { value: "user", label: "Yours" },
                        { value: "app", label: "The app's" },
                    ]}
                />
            </Group>

            {history.isPending ? (
                <Loader size="sm" />
            ) : history.isError ? (
                <Alert color="oxblood" variant="light">
                    {history.error.message}
                </Alert>
            ) : entries.length === 0 ? (
                <Text size="sm" c="dimmed">
                    Nothing decided yet.
                </Text>
            ) : (
                <Stack gap="xs">
                    {entries.map((entry) => (
                        <EntryRow key={entry.id} entry={entry} />
                    ))}
                    {history.hasNextPage && (
                        <Button
                            variant="subtle"
                            h={44}
                            loading={history.isFetchingNextPage}
                            onClick={() => void history.fetchNextPage()}
                            style={{ alignSelf: "center" }}
                        >
                            Load more
                        </Button>
                    )}
                </Stack>
            )}
        </Stack>
    );
};
