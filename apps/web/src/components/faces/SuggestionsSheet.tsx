"use client";

import { useState } from "react";
import {
    Affix,
    Alert,
    Anchor,
    Badge,
    Box,
    Button,
    Group,
    Loader,
    Paper,
    Popover,
    Stack,
    Text,
    UnstyledButton,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";

import type { FaceReviewFace, ReviewMedia, Suggestion } from "@private-stock/core";

import { ReviewKindFilter } from "@/components/review/ReviewKindFilter";
import { useDecideSuggestions, useSuggestionPeople, useSuggestions } from "@/lib/api/faces";
import { useCloseOnBack } from "@/lib/useCloseOnBack";

import { FaceCropView } from "./FaceCropView";
import { FacePeek } from "./FacePeek";
import { nextTick, type TickState } from "./FaceReviewRow";
import { FaceViewDrawer } from "./FaceViewDrawer";

/**
 * Suggestions (§5f "Suggestions"): people in items whose faces together look clearly like a
 * performer, a performer at a time — the surest first, every card ticked as them. Press a card for
 * not them, again for unsure; "Look" for a closer look. One save is one decision, listed in History
 * and undoable there. Decided cards stay where they are, saying so; nothing moves under you.
 */

const items = (n: number): string => `${n.toLocaleString()} ${n === 1 ? "item" : "items"}`;

const BADGE: Record<TickState, { mark: string; color: string; ink: string }> = {
    in: { mark: "✓", color: "var(--mantine-color-brass-6)", ink: "var(--mantine-color-white)" },
    out: { mark: "✕", color: "var(--mantine-color-dark-4)", ink: "var(--mantine-color-white)" },
    unsure: {
        mark: "?",
        color: "var(--mantine-color-yellow-5)",
        ink: "var(--mantine-color-black)",
    },
};

const SuggestionCard: React.FC<{
    suggestion: Suggestion;
    size: number;
    state: TickState;
    /** What was saved for it, once it has been. */
    saved: "is" | "isNot" | null;
    onSet: (state: TickState) => void;
    onPlay: (face: FaceReviewFace) => void;
}> = ({ suggestion, size, state, saved, onSet, onPlay }) => {
    const [peeking, setPeeking] = useState(false);
    const badge = BADGE[state];

    useCloseOnBack(peeking, () => setPeeking(false));

    return (
        <Paper withBorder radius="md" p={4} style={{ opacity: saved ? 0.45 : 1 }}>
            <Stack gap={0} align="center">
                <UnstyledButton
                    disabled={saved !== null}
                    onClick={() => onSet(nextTick(state, true))}
                    aria-label={`${suggestion.title}: ${state === "in" ? "them" : state === "out" ? "not them" : "unsure"}`}
                    style={{
                        position: "relative",
                        borderRadius: 8,
                        padding: 2,
                        outline:
                            saved === null && state === "in"
                                ? "2px solid var(--mantine-color-brass-6)"
                                : saved === null && state === "unsure"
                                  ? "2px dashed var(--mantine-color-yellow-6)"
                                  : "2px solid transparent",
                        touchAction: "manipulation",
                    }}
                >
                    <Box
                        style={{
                            opacity:
                                saved !== null || state === "in"
                                    ? 1
                                    : state === "unsure"
                                      ? 0.65
                                      : 0.3,
                            filter: state === "out" ? "grayscale(1)" : undefined,
                        }}
                    >
                        <FaceCropView crop={suggestion.face.crop} size={size} />
                    </Box>
                    <Box
                        aria-hidden
                        style={{
                            position: "absolute",
                            right: 6,
                            top: 6,
                            width: 24,
                            height: 24,
                            borderRadius: 12,
                            display: "grid",
                            placeItems: "center",
                            fontSize: 13,
                            fontWeight: 700,
                            color: badge.ink,
                            background: badge.color,
                        }}
                    >
                        {saved === "is" ? "✓" : saved === "isNot" ? "✕" : badge.mark}
                    </Box>
                </UnstyledButton>
                <Group gap={4} justify="space-between" w="100%" px={4} h={44} wrap="nowrap">
                    <Text size="xs" c="dimmed" truncate>
                        {saved
                            ? saved === "is"
                                ? "Tagged"
                                : "Not them"
                            : suggestion.kind === "image"
                              ? "Photo"
                              : `${suggestion.moments} moments`}
                        {suggestion.named && !saved ? " · name on file" : ""}
                    </Text>
                    <Popover
                        opened={peeking}
                        onChange={setPeeking}
                        position="bottom"
                        withArrow
                        shadow="md"
                        withinPortal
                    >
                        <Popover.Target>
                            <Anchor
                                component="button"
                                type="button"
                                size="xs"
                                c="dimmed"
                                onClick={() => setPeeking((open) => !open)}
                                style={{ minHeight: 44, minWidth: 44 }}
                            >
                                Look
                            </Anchor>
                        </Popover.Target>
                        <Popover.Dropdown
                            onClick={(event) => {
                                // A tap on the picture, or anywhere but a control, closes it.
                                if (
                                    !(event.target as Element).closest(
                                        "button, a, input, label, [role='radiogroup']"
                                    )
                                ) {
                                    setPeeking(false);
                                }
                            }}
                        >
                            <FacePeek
                                others={suggestion.others}
                                face={suggestion.face}
                                state={state}
                                threeWay
                                onSet={onSet}
                                onPlay={() => {
                                    setPeeking(false);
                                    onPlay(suggestion.face);
                                }}
                            />
                        </Popover.Dropdown>
                    </Popover>
                </Group>
            </Stack>
        </Paper>
    );
};

/** One performer's suggestions: the grid, and the bar that saves them. */
const PerformerSuggestions: React.FC<{
    tagId: string;
    media: ReviewMedia;
    onBack: () => void;
}> = ({ tagId, media, onBack }) => {
    const isPhone = useMediaQuery("(max-width: 48em)");
    const size = isPhone ? 140 : 156;
    // When the list was opened: a new one is the only way it changes.
    const [visit, setVisit] = useState(() => Date.now());
    const list = useSuggestions(tagId, media, visit);
    const decide = useDecideSuggestions();
    const [states, setStates] = useState<ReadonlyMap<string, TickState>>(new Map());
    const [saved, setSaved] = useState<ReadonlyMap<string, "is" | "isNot">>(new Map());
    const [viewing, setViewing] = useState<FaceReviewFace | null>(null);
    const [failure, setFailure] = useState<string | null>(null);
    const cards = list.data?.pages.flatMap((page) => page.suggestions) ?? [];
    const performer = list.data?.pages[0]?.performer;
    const stateOf = (id: string): TickState => states.get(id) ?? "in";
    const open = cards.filter((card) => !saved.has(card.id));
    const them = open.filter((card) => stateOf(card.id) === "in");
    const notThem = open.filter((card) => stateOf(card.id) === "out");
    const name = performer?.name ?? "them";

    const save = (): void => {
        const people = [...them, ...notThem].map((card) => ({
            mediaId: card.mediaId,
            faceIds: card.faceIds,
            shownFaceId: card.face.id,
            verdict: stateOf(card.id) === "in" ? ("is" as const) : ("isNot" as const),
        }));

        decide.mutate(
            { tagId, people },
            {
                onSuccess: () => {
                    setFailure(null);
                    setSaved((current) => {
                        const next = new Map(current);
                        for (const person of [...them, ...notThem]) {
                            next.set(person.id, stateOf(person.id) === "in" ? "is" : "isNot");
                        }
                        return next;
                    });
                },
                onError: (error) => setFailure(error.message),
            }
        );
    };

    return (
        <Stack gap="md" pb={96}>
            <Group gap="sm" justify="space-between" wrap="wrap">
                <Button variant="subtle" color="gray" h={44} onClick={onBack}>
                    ← Everyone
                </Button>
                {saved.size > 0 && (
                    <Button
                        variant="subtle"
                        color="gray"
                        size="compact-sm"
                        onClick={() => {
                            setSaved(new Map());
                            setStates(new Map());
                            setVisit(Date.now());
                        }}
                    >
                        Refresh
                    </Button>
                )}
            </Group>

            <Text size="sm" c="dimmed">
                People in {performer ? `items that may be ${performer.name}` : "items"}, the surest
                first. Every card starts as them: press one for not them, again for unsure — unsure
                is left for later.
            </Text>

            {list.isPending ? (
                <Loader size="sm" />
            ) : list.isError ? (
                <Alert color="oxblood" variant="light">
                    {list.error.message}
                </Alert>
            ) : cards.length === 0 ? (
                <Text size="sm" c="dimmed">
                    Nothing left to suggest for {name}.
                </Text>
            ) : (
                <Box
                    style={{
                        display: "grid",
                        gridTemplateColumns: `repeat(auto-fill, minmax(${size + 12}px, 1fr))`,
                        gap: 8,
                    }}
                >
                    {cards.map((card) => (
                        <SuggestionCard
                            key={card.id}
                            suggestion={card}
                            size={size}
                            state={stateOf(card.id)}
                            saved={saved.get(card.id) ?? null}
                            onSet={(state) =>
                                setStates((current) => new Map(current).set(card.id, state))
                            }
                            onPlay={setViewing}
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

            {open.length > 0 && (
                <Affix position={{ bottom: 16, left: 16, right: 16 }} zIndex={200}>
                    <Paper withBorder shadow="md" radius="md" p="sm" maw={640} mx="auto">
                        <Stack gap={6}>
                            {failure && (
                                <Text size="xs" c="oxblood.4">
                                    {failure}
                                </Text>
                            )}
                            <Group gap="sm" justify="space-between" wrap="nowrap">
                                <Text size="sm" c="dimmed">
                                    {them.length} them · {notThem.length} not ·{" "}
                                    {open.length - them.length - notThem.length} unsure
                                </Text>
                                <Button
                                    color="brass"
                                    h={44}
                                    loading={decide.isPending}
                                    disabled={them.length + notThem.length === 0}
                                    onClick={save}
                                >
                                    {them.length > 0
                                        ? `Tag ${items(them.length)} as ${name}`
                                        : `Not ${name} on ${items(notThem.length)}`}
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

/** Everyone with suggestions, most first. */
const SuggestionPeople: React.FC<{
    media: ReviewMedia;
    onPerformer: (tagId: string) => void;
}> = ({ media, onPerformer }) => {
    const people = useSuggestionPeople(media);
    const rows = people.data?.performers ?? [];

    if (people.isPending) return <Loader size="sm" />;

    if (people.isError) {
        return (
            <Alert color="oxblood" variant="light">
                {people.error.message}
            </Alert>
        );
    }

    if (rows.length === 0) {
        return (
            <Text size="sm" c="dimmed">
                Nothing to suggest. Suggestions appear as faces are read and performers&apos; faces
                are learned from what is tagged and confirmed.
            </Text>
        );
    }

    return (
        <Stack gap="xs">
            {rows.map((row) => (
                <UnstyledButton key={row.tagId} onClick={() => onPerformer(row.tagId)}>
                    <Paper withBorder radius="md" p="xs">
                        <Group gap="sm" wrap="nowrap">
                            {row.pictureUrl ? (
                                // eslint-disable-next-line @next/next/no-img-element -- a small tag picture
                                <img
                                    src={row.pictureUrl}
                                    alt=""
                                    width={44}
                                    height={55}
                                    style={{
                                        objectFit: "cover",
                                        borderRadius: 4,
                                        flex: "0 0 auto",
                                    }}
                                />
                            ) : (
                                <Box
                                    w={44}
                                    h={55}
                                    style={{ background: "var(--ps-well)", borderRadius: 4 }}
                                />
                            )}
                            <Text fw={500} style={{ flex: 1, minWidth: 0 }} truncate>
                                {row.name}
                            </Text>
                            <Badge variant="light" color="brass" size="lg">
                                {row.count.toLocaleString()}
                            </Badge>
                        </Group>
                    </Paper>
                </UnstyledButton>
            ))}
        </Stack>
    );
};

export const SuggestionsSheet: React.FC<{
    performer: string | null;
    onPerformer: (tagId: string | null) => void;
    media: ReviewMedia;
    onMedia: (media: ReviewMedia) => void;
    /** The old face-group review, kept behind a link for now. */
    onGroups: () => void;
}> = ({ performer, onPerformer, media, onMedia, onGroups }) => (
    <Stack gap="md">
        <ReviewKindFilter value={media} onChange={onMedia} />

        {performer ? (
            <PerformerSuggestions
                key={`${performer}:${media}`}
                tagId={performer}
                media={media}
                onBack={() => onPerformer(null)}
            />
        ) : (
            <>
                <Text size="sm" c="dimmed">
                    People in items who look clearly like a performer, one card for each person in
                    each item. Only clear matches are asked about.{" "}
                    <Anchor component="button" type="button" size="sm" onClick={onGroups}>
                        The old face groups
                    </Anchor>{" "}
                    are still there for now.
                </Text>
                <SuggestionPeople media={media} onPerformer={(tagId) => onPerformer(tagId)} />
            </>
        )}
    </Stack>
);
