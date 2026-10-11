"use client";

import { useState } from "react";
import {
    Anchor,
    Box,
    Button,
    Group,
    Menu,
    Paper,
    Stack,
    Text,
    UnstyledButton,
} from "@mantine/core";

import type { FaceReviewFace, ItemPeople, MediaTag, MentionField } from "@private-stock/core";

import { SectionLabel } from "@/components/media/SectionLabel";
import { FacetBox } from "@/components/TagEditor";
import type { ItemMoment } from "@/components/tags/ItemTagChip";
import { useDecideItemPeople, useItemPeople } from "@/lib/api/faces";
import { formatTimecode } from "@/lib/timecode";

import { FaceCropView } from "./FaceCropView";
import { NameBox } from "./faceControls";
import { LookButton } from "./LookButton";
import { MARKS, PersonCardView } from "./PersonCardView";
import { PerformerPicture } from "./PerformerPicture";

/**
 * Performers, on the item's page (§5f "People in this item"): who it is tagged with and who the
 * faces found in it, as one list — they are the same question. Each tagged performer is one card,
 * with their face in the item where one was found, and its menu says whether that face is them.
 * After the cards, for administrators, who else may be in it: a face that looks clearly like
 * somebody not tagged ("Jane?" — Yes / No), a performer the item's text names, and the faces
 * nobody matched, folded away until asked for. Every answer is one decision in History.
 */

const FIELD_WORDS: Record<MentionField, string> = {
    filename: "filename",
    title: "title",
    screen: "on screen",
};

type Person = ItemPeople["people"][number];

const facesOf = (person: Person) => ({
    faceIds: person.card.faceIds,
    shownFaceId: person.card.face.id,
});

const momentOf = (face: FaceReviewFace): string =>
    face.kind === "video" && face.atMs !== null ? formatTimecode(face.atMs) : "photo";

/** Their face on a tagged performer's card: where they were seen, and whether it is them. */
const FaceOnCard: React.FC<{
    mediaId: string;
    tagId: string;
    person: Person;
    onSeek: (atMs: number) => void;
}> = ({ mediaId, tagId, person, onSeek }) => {
    const decide = useDecideItemPeople(mediaId);
    const { face } = person.card;
    const confirmed = person.state === "confirmed";
    const send = (action: "is" | "isNot"): void =>
        decide.mutate({ action, tagId, person: facesOf(person) });

    return (
        <Menu position="bottom-start" shadow="md" withinPortal>
            <Menu.Target>
                <UnstyledButton
                    aria-label="Their face in this item"
                    style={{ padding: "0 0.5rem 0.375rem", textAlign: "left" }}
                >
                    <Group gap={6} wrap="nowrap">
                        <Box
                            style={{
                                borderRadius: 8,
                                outline: confirmed
                                    ? "2px solid var(--mantine-color-brass-6)"
                                    : "2px dashed var(--mantine-color-yellow-6)",
                            }}
                        >
                            <FaceCropView crop={face.crop} size={36} />
                        </Box>
                        <Text size="xs" c={decide.error ? "oxblood.4" : "dimmed"} lh={1.2}>
                            {decide.error
                                ? "Not saved"
                                : confirmed
                                  ? person.byApp
                                      ? `Tagged from their face, ${momentOf(face)}`
                                      : `Seen ${face.kind === "video" ? "at " : "in the "}${momentOf(face)}`
                                  : `Their face? ${momentOf(face)}`}
                        </Text>
                    </Group>
                </UnstyledButton>
            </Menu.Target>
            <Menu.Dropdown>
                {face.kind === "video" && face.atMs !== null && (
                    <Menu.Item onClick={() => onSeek(face.atMs!)}>Go to this moment</Menu.Item>
                )}
                {!confirmed && (
                    <Menu.Item disabled={decide.isPending} onClick={() => send("is")}>
                        Yes, that&apos;s their face
                    </Menu.Item>
                )}
                <Menu.Item disabled={decide.isPending} onClick={() => send("isNot")}>
                    Not their face
                    <Text size="xs" c="dimmed">
                        The tag stays; take it off with × if they are not in it at all.
                    </Text>
                </Menu.Item>
            </Menu.Dropdown>
        </Menu>
    );
};

/** A dashed card for somebody who may be in it: a question, not a tag. */
const Maybe: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <Paper
        radius="sm"
        p={6}
        style={{
            border: "1px dashed var(--mantine-color-brass-8)",
            background: "transparent",
            maxWidth: "min(100%, 340px)",
        }}
    >
        {children}
    </Paper>
);

/** A face that looks clearly like a performer the item does not carry: "Jane?" — Yes / No. */
const SuggestedCard: React.FC<{
    mediaId: string;
    person: Person;
    onSeek: (atMs: number) => void;
}> = ({ mediaId, person, onSeek }) => {
    const decide = useDecideItemPeople(mediaId);
    const { card, performer } = person;
    const busy = (action: string): boolean =>
        decide.isPending && decide.variables?.action === action;
    const seek = (face: FaceReviewFace): void => {
        if (face.kind === "video" && face.atMs !== null) onSeek(face.atMs);
    };

    if (!performer) return null;

    return (
        <Maybe>
            <Group gap="sm" wrap="nowrap" align="flex-start">
                {/* The face, and beside it who it may be: compared at a glance. */}
                <UnstyledButton aria-label="Go to this face" onClick={() => seek(card.face)}>
                    <FaceCropView crop={card.face.crop} size={72} />
                </UnstyledButton>
                <PerformerPicture url={performer.pictureUrl} width={58} />
                <Stack gap={4} style={{ minWidth: 0 }}>
                    <Group gap={4} wrap="nowrap" justify="space-between">
                        <Text size="sm" fw={600} truncate>
                            {performer.name}?
                        </Text>
                        <LookButton
                            face={card.face}
                            others={card.others}
                            onPlay={seek}
                            compare={{ tagId: performer.id, name: performer.name }}
                        />
                    </Group>
                    <Text size="xs" c={decide.error ? "oxblood.4" : "dimmed"}>
                        {decide.error
                            ? decide.error.message
                            : person.state === "confirmed"
                              ? "Their face, but not tagged"
                              : "Looks clearly like them"}
                    </Text>
                    <Group gap="xs" wrap="nowrap">
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
                                    person: facesOf(person),
                                })
                            }
                        >
                            Yes
                        </Button>
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
                                    person: facesOf(person),
                                })
                            }
                        >
                            No
                        </Button>
                    </Group>
                </Stack>
            </Group>
        </Maybe>
    );
};

/** A performer the item's own text names, not on it: Add / Not them. */
const NamedCard: React.FC<{ mediaId: string; named: ItemPeople["named"][number] }> = ({
    mediaId,
    named,
}) => {
    const decide = useDecideItemPeople(mediaId);
    const busy = (action: string): boolean =>
        decide.isPending && decide.variables?.action === action;

    return (
        <Maybe>
            <Stack gap={4}>
                <Text size="sm" fw={600} truncate>
                    {named.name}?
                </Text>
                <Text size="xs" c={decide.error ? "oxblood.4" : "dimmed"}>
                    {decide.error
                        ? decide.error.message
                        : `Named in the ${named.fields.map((field) => FIELD_WORDS[field]).join(", ")}`}
                </Text>
                <Group gap="xs" wrap="nowrap">
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
            </Stack>
        </Maybe>
    );
};

/** A face nobody matched: "Who is this?", and a name for them. */
const UnknownRow: React.FC<{
    mediaId: string;
    person: Person;
    onSeek: (atMs: number) => void;
}> = ({ mediaId, person, onSeek }) => {
    const decide = useDecideItemPeople(mediaId);
    const [naming, setNaming] = useState(false);
    const { card } = person;
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
                        mark={MARKS.open}
                        look="plain"
                        caption={card.kind === "image" ? "Photo" : `${card.moments} moments`}
                        label="Go to this face"
                        onPress={() => seek(card.face)}
                        onPlay={seek}
                    />
                </Box>
                <Stack gap={6} style={{ flex: 1, minWidth: 0 }}>
                    <Text size="sm" fw={600}>
                        Who is this?
                    </Text>
                    <Text size="xs" c={decide.error ? "oxblood.4" : "dimmed"}>
                        {decide.error ? decide.error.message : "Nobody matched yet"}
                    </Text>
                    {!naming && (
                        <Button
                            size="compact-md"
                            variant="subtle"
                            color="gray"
                            h={44}
                            style={{ alignSelf: "flex-start" }}
                            onClick={() => setNaming(true)}
                        >
                            Name…
                        </Button>
                    )}
                </Stack>
            </Group>
            {/* The row's full width, not the column beside the face: a name needs the room. */}
            {naming && (
                <Box mt="xs">
                    <NameBox
                        autoFocus
                        busy={decide.isPending}
                        disabled={false}
                        action={(name) => `That's ${name}`}
                        onName={(name) =>
                            decide.mutate(
                                { action: "name", name, person: facesOf(person) },
                                { onSuccess: () => setNaming(false) }
                            )
                        }
                    />
                </Box>
            )}
        </Paper>
    );
};

/** The faces nobody matched, folded: often extras, and not what the section is for. */
const Unknown: React.FC<{
    mediaId: string;
    people: Person[];
    onSeek: (atMs: number) => void;
}> = ({ mediaId, people, onSeek }) => {
    const [open, setOpen] = useState(false);

    return (
        <Stack gap="xs">
            <Anchor
                component="button"
                type="button"
                size="sm"
                c="dimmed"
                onClick={() => setOpen((shown) => !shown)}
                style={{ alignSelf: "flex-start", minHeight: 44 }}
            >
                {open
                    ? "Hide the other faces"
                    : `${people.length} other ${people.length === 1 ? "face" : "faces"} — who is this? ›`}
            </Anchor>
            {open && (
                <div
                    style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 300px), 1fr))",
                        gap: "var(--mantine-spacing-sm)",
                    }}
                >
                    {people.map((person) => (
                        <UnknownRow
                            key={person.card.id}
                            mediaId={mediaId}
                            person={person}
                            onSeek={onSeek}
                        />
                    ))}
                </div>
            )}
        </Stack>
    );
};

export const ItemPerformers: React.FC<{
    mediaId: string;
    /** The item's performer tags, the library's. */
    values: MediaTag[];
    /** Whether the faces' answers are shown: an administrator's, whose answers tag the library. */
    faces: boolean;
    moment?: ItemMoment;
    onSeek: (atMs: number) => void;
}> = ({ mediaId, values, faces, moment, onSeek }) => {
    const { data } = useItemPeople(mediaId, faces);
    const people = data?.people ?? [];
    // On a tagged performer's card: their face, confirmed or awaiting a yes — the most seen.
    const onCard = (tagId: string) =>
        people.find(
            (person) =>
                person.performer?.id === tagId &&
                person.tagged &&
                (person.state === "confirmed" || person.state === "suggested")
        );
    const suggested = people.filter(
        (person) =>
            person.performer &&
            !person.tagged &&
            (person.state === "suggested" || person.state === "confirmed")
    );
    const unknown = people.filter((person) => person.state === "unknown");
    const named = data?.named ?? [];

    return (
        <Stack gap="xs">
            <SectionLabel>Performers</SectionLabel>
            <FacetBox
                mediaId={mediaId}
                kind="performer"
                scope="public"
                values={values}
                moment={moment}
                removeChoice
                faceFor={(tagId) => {
                    const person = onCard(tagId);

                    return person ? (
                        <FaceOnCard
                            mediaId={mediaId}
                            tagId={tagId}
                            person={person}
                            onSeek={onSeek}
                        />
                    ) : null;
                }}
            >
                {suggested.length + named.length > 0 && (
                    <Group gap={8} wrap="wrap" mt={4} align="flex-start">
                        {suggested.map((person) => (
                            <SuggestedCard
                                key={person.card.id}
                                mediaId={mediaId}
                                person={person}
                                onSeek={onSeek}
                            />
                        ))}
                        {named.map((row) => (
                            <NamedCard key={row.tagId} mediaId={mediaId} named={row} />
                        ))}
                    </Group>
                )}
                {unknown.length > 0 && (
                    <Unknown mediaId={mediaId} people={unknown} onSeek={onSeek} />
                )}
            </FacetBox>
        </Stack>
    );
};
