"use client";

import { useEffect, useState } from "react";
import {
    Affix,
    Alert,
    Box,
    Button,
    Group,
    Loader,
    Paper,
    Popover,
    SegmentedControl,
    Stack,
    Switch,
    Text,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";

import type { FaceReviewFace, PersonCard } from "@private-stock/core";

import { useDecidePerformerPeople, usePerformerPeople, useSetNoSingleFace } from "@/lib/api/faces";

import { FaceViewDrawer } from "./FaceViewDrawer";
import { MARKS, PersonCardView } from "./PersonCardView";

/**
 * A performer's Faces tab (§5f "Their faces"): everything faces say about them, a card for each
 * person in each item, each correctable where it is seen.
 *
 * - **Confirmed**: the people confirmed as them. Press one that is not, and take it back.
 * - **Their items**: their own items with nobody on them confirmed — press the person who is them.
 * - **Ruled out**: the people refused for them, those somebody saw or every one. Press one that is
 *   them after all, and restore it: undecided, to be suggested again.
 *
 * Every save is one decision in History (a restore is itself an undoing). Saved cards stay where
 * they are, saying so; nothing moves until the section is opened again.
 */

type Section = "confirmed" | "items" | "ruledOut";

const items = (n: number): string => `${n.toLocaleString()} ${n === 1 ? "item" : "items"}`;

const SAY: Record<
    Section,
    { action: "takeBack" | "pick" | "restore"; verb: string; done: string }
> = {
    confirmed: { action: "takeBack", verb: "Take back", done: "Taken back" },
    items: { action: "pick", verb: "Confirm", done: "Confirmed" },
    ruledOut: { action: "restore", verb: "Restore", done: "Restored" },
};

const INTRO: Record<Section, (name: string) => string> = {
    confirmed: (name) =>
        `The people confirmed as ${name}, one an item. Press any that is not them, then take them back.`,
    items: (name) =>
        `${name}'s own items with nobody on them confirmed yet. Press the person who is them — one an item.`,
    ruledOut: (name) =>
        `The people said not to be ${name}. Press any that are them after all, then restore them: they are suggested again.`,
};

const caption = (card: PersonCard): string =>
    card.kind === "image" ? "Photo" : `${card.moments} moments`;

/** "No single face" (§5f): asked once, with what it does said first; undone in one press. */
const NoSingleFace: React.FC<{
    tagId: string;
    name: string;
    since: string | null;
    onChanged: () => void;
}> = ({ tagId, name, since, onChanged }) => {
    const set = useSetNoSingleFace(tagId);
    const [opened, setOpened] = useState(false);

    if (since) {
        return (
            <Group gap="sm" wrap="wrap" align="center">
                <Text size="sm" c="dimmed" style={{ flex: "1 1 260px" }}>
                    {name} has no single face (since{" "}
                    {new Date(`${since.replace(" ", "T")}Z`).toLocaleDateString(undefined, {
                        day: "numeric",
                        month: "short",
                    })}
                    ). Face matching leaves them out; they are suggested by name only.
                </Text>
                <Button
                    variant="default"
                    size="compact-sm"
                    loading={set.isPending}
                    onClick={() => set.mutate({ noSingleFace: false }, { onSuccess: onChanged })}
                >
                    Undo
                </Button>
            </Group>
        );
    }

    return (
        <Popover opened={opened} onChange={setOpened} position="bottom-start" withArrow>
            <Popover.Target>
                <Button
                    variant="subtle"
                    color="gray"
                    size="compact-sm"
                    onClick={() => setOpened((open) => !open)}
                    style={{ alignSelf: "flex-start" }}
                >
                    No single face…
                </Button>
            </Popover.Target>
            <Popover.Dropdown>
                <Stack gap="xs" maw={320}>
                    <Text size="sm">
                        For a performer whose face never shows, or a name that is not one person.
                        Face matching then leaves {name} out: no face is learned for them, their
                        tags stop counting as evidence about anybody&apos;s face, and nothing is
                        suggested or tagged for them by a face — by name only. Anything confirmed is
                        kept, so undoing it puts everything back.
                    </Text>
                    <Group gap="xs">
                        <Button
                            size="compact-sm"
                            color="brass"
                            loading={set.isPending}
                            onClick={() =>
                                set.mutate(
                                    { noSingleFace: true },
                                    {
                                        onSuccess: () => {
                                            setOpened(false);
                                            onChanged();
                                        },
                                    }
                                )
                            }
                        >
                            {name} has no single face
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

const SectionView: React.FC<{
    tagId: string;
    name: string;
    section: Section;
    all: boolean;
    visit: number;
    onNoSingleFace: (since: string | null) => void;
}> = ({ tagId, name, section, all, visit, onNoSingleFace }) => {
    const isPhone = useMediaQuery("(max-width: 48em)");
    const size = isPhone ? 140 : 156;
    const list = usePerformerPeople(tagId, section, all, visit);
    const decide = useDecidePerformerPeople(tagId);
    // Pressed: what the save will say of them. Saved: said, and settled in place.
    const [pressed, setPressed] = useState<ReadonlySet<string>>(new Set());
    const [saved, setSaved] = useState<ReadonlySet<string>>(new Set());
    const [viewing, setViewing] = useState<FaceReviewFace | null>(null);
    const [failure, setFailure] = useState<string | null>(null);
    const groups = list.data?.pages.flatMap((page) => page.groups) ?? [];
    const cards = groups.flatMap((group) => group.people);
    const chosen = cards.filter((card) => pressed.has(card.id) && !saved.has(card.id));
    const say = SAY[section];
    const noSingleFace = list.data?.pages[0]?.noSingleFace ?? null;

    const since = noSingleFace?.since ?? null;
    const loaded = list.data !== undefined;

    // The tab says whether they have a single face; the first page is where that is known.
    useEffect(() => {
        if (loaded) onNoSingleFace(since);
    }, [loaded, since, onNoSingleFace]);

    const press = (card: PersonCard, mediaId: string): void =>
        setPressed((current) => {
            const next = new Set(current);

            if (next.has(card.id)) {
                next.delete(card.id);
            } else {
                // One person an item is them: picking another takes the first back.
                if (section === "items") {
                    for (const other of groups.find((g) => g.mediaId === mediaId)?.people ?? []) {
                        next.delete(other.id);
                    }
                }
                next.add(card.id);
            }

            return next;
        });

    const save = (): void =>
        decide.mutate(
            {
                action: say.action,
                people: chosen.map((card) => ({
                    mediaId: card.mediaId,
                    faceIds: card.faceIds,
                    shownFaceId: card.face.id,
                })),
            },
            {
                onSuccess: () => {
                    setFailure(null);
                    setSaved((current) => new Set([...current, ...chosen.map((card) => card.id)]));
                },
                onError: (error) => setFailure(error.message),
            }
        );

    const markOf = (card: PersonCard) => {
        const on = pressed.has(card.id);

        if (section === "confirmed") return on ? MARKS.notThem : MARKS.them;
        if (section === "ruledOut") return on ? MARKS.unsure : MARKS.notThem;

        return on ? MARKS.them : MARKS.open;
    };

    const lookOf = (card: PersonCard) => {
        const on = pressed.has(card.id);

        if (section === "confirmed") return on ? "faded" : "chosen";
        if (section === "ruledOut") return on ? "unsure" : "plain";

        return on ? "chosen" : "plain";
    };

    if (list.isPending) return <Loader size="sm" />;

    if (list.isError) {
        return (
            <Alert color="oxblood" variant="light">
                {list.error.message}
            </Alert>
        );
    }

    if (noSingleFace && section !== "ruledOut") {
        return null;
    }

    return (
        <Stack gap="md" pb={chosen.length > 0 ? 96 : 0}>
            <Text size="sm" c="dimmed">
                {INTRO[section](name)}
            </Text>

            {cards.length === 0 ? (
                <Text size="sm" c="dimmed">
                    {section === "confirmed"
                        ? `Nobody confirmed as ${name} yet. Their Suggestions are on the other tab, and their own items here under "Their items".`
                        : section === "items"
                          ? `Every one of ${name}'s items with people on it has them confirmed.`
                          : `Nobody ruled out for ${name}.`}
                </Text>
            ) : section === "items" ? (
                <Stack gap="sm">
                    {groups.map((group) => (
                        <Stack key={group.mediaId} gap={4}>
                            <Text size="xs" c="dimmed" truncate>
                                {group.title}
                            </Text>
                            <Group gap={8} wrap="wrap" align="flex-start">
                                {group.people.map((card) => (
                                    <Box key={card.id} w={size + 12}>
                                        <PersonCardView
                                            face={card.face}
                                            others={card.others}
                                            size={size}
                                            mark={saved.has(card.id) ? MARKS.them : markOf(card)}
                                            look={lookOf(card)}
                                            caption={saved.has(card.id) ? say.done : caption(card)}
                                            label={`${group.title}: ${pressed.has(card.id) ? "them" : "not chosen"}`}
                                            onPress={
                                                saved.has(card.id)
                                                    ? undefined
                                                    : () => press(card, group.mediaId)
                                            }
                                            onPlay={setViewing}
                                            compare={{ tagId, name }}
                                        />
                                    </Box>
                                ))}
                            </Group>
                        </Stack>
                    ))}
                </Stack>
            ) : (
                <Box
                    style={{
                        display: "grid",
                        gridTemplateColumns: `repeat(auto-fill, minmax(${size + 12}px, 1fr))`,
                        gap: 8,
                    }}
                >
                    {cards.map((card) => (
                        <PersonCardView
                            key={card.id}
                            face={card.face}
                            others={card.others}
                            size={size}
                            mark={markOf(card)}
                            look={lookOf(card)}
                            caption={saved.has(card.id) ? say.done : caption(card)}
                            label={`${card.title}: ${pressed.has(card.id) ? say.verb.toLowerCase() : "as it is"}`}
                            onPress={
                                saved.has(card.id) ? undefined : () => press(card, card.mediaId)
                            }
                            onPlay={setViewing}
                            compare={{ tagId, name }}
                        />
                    ))}
                </Box>
            )}

            {list.hasNextPage && (
                <Button
                    variant="subtle"
                    h={44}
                    loading={list.isFetchingNextPage}
                    onClick={() => void list.fetchNextPage()}
                    style={{ alignSelf: "center" }}
                >
                    More
                </Button>
            )}

            {chosen.length > 0 && (
                <Affix position={{ bottom: 16, left: 16, right: 16 }} zIndex={200}>
                    <Paper withBorder shadow="md" radius="md" p="sm" maw={640} mx="auto">
                        <Stack gap={6}>
                            {failure && (
                                <Text size="xs" c="oxblood.4">
                                    {failure}
                                </Text>
                            )}
                            <Group gap="sm" justify="space-between" wrap="nowrap">
                                <Button
                                    variant="subtle"
                                    color="gray"
                                    h={44}
                                    onClick={() => setPressed(new Set())}
                                >
                                    Clear
                                </Button>
                                <Button
                                    color="brass"
                                    h={44}
                                    loading={decide.isPending}
                                    onClick={save}
                                >
                                    {say.verb} {items(chosen.length)}
                                </Button>
                            </Group>
                        </Stack>
                    </Paper>
                </Affix>
            )}

            <FaceViewDrawer face={viewing} onClose={() => setViewing(null)} />
        </Stack>
    );
};

export const PerformerFacesTab: React.FC<{ tagId: string; name: string }> = ({ tagId, name }) => {
    const [section, setSection] = useState<Section>("confirmed");
    const [all, setAll] = useState(false);
    // When the sections were opened: a change of "no single face" opens them anew.
    const [visit, setVisit] = useState(() => Date.now());
    const [noSingleFace, setNoSingleFace] = useState<string | null>(null);

    return (
        <Stack gap="md">
            <Group gap="sm" justify="space-between" wrap="wrap">
                <SegmentedControl
                    color="brass"
                    value={section}
                    onChange={(value) => setSection(value as Section)}
                    data={[
                        { value: "confirmed", label: "Confirmed" },
                        { value: "items", label: "Their items" },
                        { value: "ruledOut", label: "Ruled out" },
                    ]}
                />
                {section === "ruledOut" && (
                    <Switch
                        size="sm"
                        color="brass"
                        checked={all}
                        onChange={(event) => setAll(event.currentTarget.checked)}
                        label="Also faces nobody saw"
                    />
                )}
            </Group>

            <NoSingleFace
                tagId={tagId}
                name={name}
                since={noSingleFace}
                onChanged={() => setVisit(Date.now())}
            />

            <SectionView
                key={`${section}:${all}:${visit}`}
                tagId={tagId}
                name={name}
                section={section}
                all={all}
                visit={visit}
                onNoSingleFace={setNoSingleFace}
            />
        </Stack>
    );
};
