"use client";

import { useState } from "react";
import { Box, Button, Group, Paper, Stack, Text } from "@mantine/core";

import type { FaceReviewFace, ItemPeople, MentionField } from "@private-stock/core";

import { SectionLabel } from "@/components/media/SectionLabel";
import { useDecideItemPeople, useItemPeople } from "@/lib/api/faces";

import { NameBox } from "./faceControls";
import { MARKS, PersonCardView } from "./PersonCardView";

/**
 * People in this item (§5f "People in this item"): every person in it, each with what is known —
 * confirmed by you or tagged by the app, suggested at the lines Suggestions uses, or nobody yet —
 * and the one control for each: "That's ‹name›", "Not ‹name›", or a name for somebody new. Below,
 * the performers the item's own text names who are not on it. Every decision is one in History.
 * Pressing a face goes to its moment.
 */

const FIELD_WORDS: Record<MentionField, string> = {
    filename: "filename",
    title: "title",
    screen: "on screen",
};

type Person = ItemPeople["people"][number];

const PersonRow: React.FC<{
    mediaId: string;
    person: Person;
    onSeek: (atMs: number) => void;
}> = ({ mediaId, person, onSeek }) => {
    const decide = useDecideItemPeople(mediaId);
    const [naming, setNaming] = useState(false);
    const { card, performer, state } = person;
    const who = performer?.name ?? "them";
    const facesOf = { faceIds: card.faceIds, shownFaceId: card.face.id };
    const busy = (action: string): boolean =>
        decide.isPending && decide.variables?.action === action;
    const seek = (face: FaceReviewFace): void => {
        if (face.kind === "video" && face.atMs !== null) onSeek(face.atMs);
    };

    return (
        <Paper withBorder radius="md" p="xs">
            <Group gap="sm" wrap="nowrap" align="flex-start">
                <Box w={108} style={{ flex: "0 0 auto" }}>
                    <PersonCardView
                        face={card.face}
                        others={card.others}
                        size={96}
                        mark={state === "confirmed" ? MARKS.them : MARKS.open}
                        look={state === "confirmed" ? "chosen" : "plain"}
                        caption={card.kind === "image" ? "Photo" : `${card.moments} moments`}
                        label="Go to this face"
                        onPress={() => seek(card.face)}
                        onPlay={seek}
                    />
                </Box>
                <Stack gap={6} style={{ flex: 1, minWidth: 0 }}>
                    <Text size="sm" fw={600} truncate>
                        {state === "confirmed"
                            ? who
                            : state === "suggested"
                              ? `${who}?`
                              : "Who is this?"}
                    </Text>
                    <Text size="xs" c="dimmed">
                        {state === "confirmed"
                            ? person.byApp
                                ? "Tagged by the app from their face"
                                : "Confirmed"
                            : state === "suggested"
                              ? person.tagged
                                  ? "Looks like them; the item is tagged with them"
                                  : "Looks clearly like them"
                              : "Nobody matched yet"}
                    </Text>
                    {decide.error && (
                        <Text size="xs" c="oxblood.4">
                            {decide.error.message}
                        </Text>
                    )}
                    <Group gap="xs" wrap="wrap">
                        {state === "suggested" && performer && (
                            <Button
                                size="compact-md"
                                color="brass"
                                variant="light"
                                h={44}
                                disabled={decide.isPending}
                                loading={busy("is")}
                                onClick={() =>
                                    decide.mutate({
                                        action: "is",
                                        tagId: performer.id,
                                        person: facesOf,
                                    })
                                }
                            >
                                That&apos;s {who}
                            </Button>
                        )}
                        {state !== "unknown" && performer && (
                            <Button
                                size="compact-md"
                                variant="default"
                                h={44}
                                disabled={decide.isPending}
                                loading={busy("isNot")}
                                onClick={() =>
                                    decide.mutate({
                                        action: "isNot",
                                        tagId: performer.id,
                                        person: facesOf,
                                    })
                                }
                            >
                                Not {who}
                            </Button>
                        )}
                        {state !== "confirmed" && !naming && (
                            <Button
                                size="compact-md"
                                variant="subtle"
                                color="gray"
                                h={44}
                                onClick={() => setNaming(true)}
                            >
                                {state === "suggested" ? "Someone else…" : "Name…"}
                            </Button>
                        )}
                    </Group>
                    {naming && (
                        <NameBox
                            autoFocus
                            busy={busy("name")}
                            disabled={false}
                            action={(name) => `That's ${name}`}
                            onName={(name) =>
                                decide.mutate(
                                    { action: "name", name, person: facesOf },
                                    { onSuccess: () => setNaming(false) }
                                )
                            }
                        />
                    )}
                </Stack>
            </Group>
        </Paper>
    );
};

const NamedRow: React.FC<{ mediaId: string; named: ItemPeople["named"][number] }> = ({
    mediaId,
    named,
}) => {
    const decide = useDecideItemPeople(mediaId);
    const busy = (action: string): boolean =>
        decide.isPending && decide.variables?.action === action;

    return (
        <Group gap="sm" wrap="wrap" align="center">
            <Text size="sm" style={{ flex: "1 1 200px", minWidth: 0 }} truncate>
                {named.name}{" "}
                <Text span size="xs" c="dimmed">
                    — named in the {named.fields.map((field) => FIELD_WORDS[field]).join(", ")}
                </Text>
            </Text>
            <Button
                size="compact-md"
                color="brass"
                variant="light"
                h={44}
                disabled={decide.isPending}
                loading={busy("addNamed")}
                onClick={() => decide.mutate({ action: "addNamed", tagId: named.tagId })}
            >
                Add
            </Button>
            <Button
                size="compact-md"
                variant="default"
                h={44}
                disabled={decide.isPending}
                loading={busy("refuseNamed")}
                onClick={() => decide.mutate({ action: "refuseNamed", tagId: named.tagId })}
            >
                Not them
            </Button>
        </Group>
    );
};

export const PeopleInItemPanel: React.FC<{ mediaId: string; onSeek: (atMs: number) => void }> = ({
    mediaId,
    onSeek,
}) => {
    const { data } = useItemPeople(mediaId, true);

    if (!data || (data.people.length === 0 && data.named.length === 0)) return null;

    return (
        <Stack gap="xs">
            <SectionLabel>People in this item</SectionLabel>
            <div
                style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
                    gap: "var(--mantine-spacing-sm)",
                }}
            >
                {data.people.map((person) => (
                    <PersonRow
                        key={person.card.id}
                        mediaId={mediaId}
                        person={person}
                        onSeek={onSeek}
                    />
                ))}
            </div>
            {data.named.length > 0 && (
                <Stack gap={4}>
                    {data.named.map((named) => (
                        <NamedRow key={named.tagId} mediaId={mediaId} named={named} />
                    ))}
                </Stack>
            )}
        </Stack>
    );
};
