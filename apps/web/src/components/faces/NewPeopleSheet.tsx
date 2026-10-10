"use client";

import { useState } from "react";
import { Alert, Box, Button, Group, Loader, Paper, Stack, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";

import type { FaceReviewFace, NewPeoplePage } from "@private-stock/core";

import { useDecideNewPeople, useNewPeople } from "@/lib/api/faces";

import { NameBox } from "./faceControls";
import { FaceViewDrawer } from "./FaceViewDrawer";
import { MARKS, PersonCardView } from "./PersonCardView";

/**
 * New people (§5f "New people"): people who match nobody known, gathered across the library, a few
 * of their items each — every card ticked to start with; press one that is somebody else to leave
 * it out. Name them, and the ticked items are tagged and their faces confirmed — which is a face to
 * match all their other items against; or "Not one person", or "Later". Each is one decision in
 * History. A decided person stays where it was as one line; nothing moves until Refresh.
 */

type NewPerson = NewPeoplePage["people"][number];

const items = (n: number): string => `${n.toLocaleString()} ${n === 1 ? "item" : "items"}`;

const NewPersonBlock: React.FC<{
    person: NewPerson;
    size: number;
    onPlay: (face: FaceReviewFace) => void;
}> = ({ person, size, onPlay }) => {
    const decide = useDecideNewPeople();
    // Pressed: left out of what is said. Said: the one line it became.
    const [left, setLeft] = useState<ReadonlySet<string>>(new Set());
    const [said, setSaid] = useState<string | null>(null);
    const chosen = person.cards.filter((card) => !left.has(card.id));
    const people = chosen.map((card) => ({
        mediaId: card.mediaId,
        faceIds: card.faceIds,
        shownFaceId: card.face.id,
    }));
    const busy = (action: string): boolean =>
        decide.isPending && decide.variables?.action === action;

    if (said) {
        return (
            <Paper withBorder radius="md" px="sm" py={8} style={{ opacity: 0.8 }}>
                <Text size="sm" c="dimmed">
                    ✓ {said}
                </Text>
            </Paper>
        );
    }

    return (
        <Paper withBorder radius="md" p="sm">
            <Stack gap="sm">
                <Text size="sm" fw={600}>
                    Who is this?{" "}
                    <Text span size="sm" c="dimmed" fw={400}>
                        On {items(person.items)}
                        {person.items > person.cards.length &&
                            ` — ${person.cards.length} shown, the rest follow once named`}
                    </Text>
                </Text>
                <Box
                    style={{
                        display: "grid",
                        gridTemplateColumns: `repeat(auto-fill, minmax(${size + 12}px, 1fr))`,
                        gap: 8,
                    }}
                >
                    {person.cards.map((card) => (
                        <PersonCardView
                            key={card.id}
                            face={card.face}
                            others={card.others}
                            size={size}
                            mark={left.has(card.id) ? MARKS.notThem : MARKS.them}
                            look={left.has(card.id) ? "faded" : "chosen"}
                            caption={card.kind === "image" ? "Photo" : `${card.moments} moments`}
                            label={`${card.title}: ${left.has(card.id) ? "left out" : "this person"}`}
                            onPress={() =>
                                setLeft((current) => {
                                    const next = new Set(current);
                                    if (next.has(card.id)) next.delete(card.id);
                                    else next.add(card.id);
                                    return next;
                                })
                            }
                            onPlay={onPlay}
                        />
                    ))}
                </Box>
                {decide.error && (
                    <Text size="xs" c="oxblood.4">
                        {decide.error.message}
                    </Text>
                )}
                <NameBox
                    busy={busy("name")}
                    disabled={chosen.length === 0}
                    action={(name) => `Name ${items(chosen.length)} ${name}`}
                    onName={(name) =>
                        decide.mutate(
                            { action: "name", name, people },
                            {
                                onSuccess: (result) =>
                                    setSaid(
                                        `${result.name ?? name} on ${items(chosen.length)} — their other items will be suggested`
                                    ),
                            }
                        )
                    }
                />
                <Group gap="xs" wrap="wrap">
                    <Button
                        variant="subtle"
                        color="gray"
                        h={44}
                        disabled={decide.isPending || chosen.length === 0}
                        loading={busy("later")}
                        onClick={() =>
                            decide.mutate(
                                { action: "later", people },
                                { onSuccess: () => setSaid("Put off for later") }
                            )
                        }
                    >
                        Later
                    </Button>
                    <Button
                        variant="subtle"
                        color="oxblood"
                        h={44}
                        disabled={decide.isPending || chosen.length === 0}
                        loading={busy("notOnePerson")}
                        onClick={() =>
                            decide.mutate(
                                { action: "notOnePerson", people },
                                { onSuccess: () => setSaid("Not one person: left out for good") }
                            )
                        }
                        title="Several people, or faces turned away: out of every new person for good"
                    >
                        Not one person
                    </Button>
                </Group>
            </Stack>
        </Paper>
    );
};

export const NewPeopleSheet: React.FC = () => {
    const isPhone = useMediaQuery("(max-width: 48em)");
    const size = isPhone ? 120 : 132;
    // When the list was opened: Refresh is the only way it changes.
    const [visit, setVisit] = useState(() => Date.now());
    const list = useNewPeople(visit);
    const [viewing, setViewing] = useState<FaceReviewFace | null>(null);
    const people = list.data?.pages.flatMap((page) => page.people) ?? [];
    const total = list.data?.pages[0]?.total;

    return (
        <Stack gap="md">
            <Group gap="sm" justify="space-between" wrap="nowrap" align="flex-start">
                <Text size="sm" c="dimmed" style={{ flex: 1 }}>
                    People who match nobody known, seen on three or more items, the most first.
                    Naming one tags those items and learns their face, so the rest of theirs are
                    suggested.
                    {total !== undefined && total > 0 && ` ${total.toLocaleString()} in all.`}
                </Text>
                <Button
                    variant="subtle"
                    color="gray"
                    size="compact-sm"
                    onClick={() => setVisit(Date.now())}
                >
                    Refresh
                </Button>
            </Group>

            {list.isPending ? (
                <Loader size="sm" />
            ) : list.isError ? (
                <Alert color="oxblood" variant="light">
                    {list.error.message}
                </Alert>
            ) : people.length === 0 ? (
                <Text size="sm" c="dimmed">
                    Nobody new to name. New people appear as faces are read, once the same stranger
                    is seen on three items.
                </Text>
            ) : (
                <Stack gap="md">
                    {people.map((person) => (
                        <NewPersonBlock
                            key={person.id}
                            person={person}
                            size={size}
                            onPlay={setViewing}
                        />
                    ))}
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
                </Stack>
            )}

            <FaceViewDrawer face={viewing} onClose={() => setViewing(null)} />
        </Stack>
    );
};
