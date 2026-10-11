"use client";

import { useState } from "react";
import {
    Affix,
    Alert,
    Badge,
    Box,
    Button,
    Group,
    Loader,
    Paper,
    Stack,
    Text,
    UnstyledButton,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";

import type { FaceReviewFace, ReviewMedia, Suggestion } from "@private-stock/core";

import { ReviewKindFilter } from "@/components/review/ReviewKindFilter";
import { useDecideSuggestions, useSuggestionPeople, useSuggestions } from "@/lib/api/faces";

import { nextTick, type TickState } from "./faceControls";
import { FaceViewDrawer } from "./FaceViewDrawer";
import { MARKS, PersonCardView } from "./PersonCardView";
import { PerformerPicture } from "./PerformerPicture";

/**
 * Suggestions (§5f "Suggestions"): people in items whose faces together look clearly like a
 * performer, a performer at a time — the surest first, every card ticked as them. Press a card for
 * not them, again for unsure; "Look" for a closer look. One save is one decision, listed in History
 * and undoable there. Decided cards stay where they are, saying so; nothing moves under you.
 */

const items = (n: number): string => `${n.toLocaleString()} ${n === 1 ? "item" : "items"}`;

const SuggestionCard: React.FC<{
    suggestion: Suggestion;
    size: number;
    state: TickState;
    /** What was saved for it, once it has been. */
    saved: "is" | "isNot" | null;
    onSet: (state: TickState) => void;
    onPlay: (face: FaceReviewFace) => void;
    /** Who they may be, for "Look" to compare with. */
    compare?: { tagId: string; name: string };
}> = ({ suggestion, size, state, saved, onSet, onPlay, compare }) => {
    const said = saved ? (saved === "is" ? "in" : "out") : state;

    return (
        <PersonCardView
            face={suggestion.face}
            others={suggestion.others}
            size={size}
            mark={said === "in" ? MARKS.them : said === "out" ? MARKS.notThem : MARKS.unsure}
            look={
                saved
                    ? "plain"
                    : state === "in"
                      ? "chosen"
                      : state === "unsure"
                        ? "unsure"
                        : "faded"
            }
            caption={
                (saved
                    ? saved === "is"
                        ? "Tagged"
                        : "Not them"
                    : suggestion.kind === "image"
                      ? "Photo"
                      : `${suggestion.moments} moments`) +
                (suggestion.named && !saved ? " · name on file" : "")
            }
            label={`${suggestion.title}: ${state === "in" ? "them" : state === "out" ? "not them" : "unsure"}`}
            onPress={saved ? undefined : () => onSet(nextTick(state, true))}
            peekState={saved ? undefined : { state, threeWay: true, onSet }}
            onPlay={onPlay}
            compare={compare}
        />
    );
};

/**
 * One performer's suggestions: the grid, and the bar that saves them. In Review › Faces, and on
 * the performer's own Organise page.
 */
export const PerformerSuggestions: React.FC<{
    tagId: string;
    media: ReviewMedia;
    /** Back to everybody, where there is a list of everybody to go back to. */
    onBack?: () => void;
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
                {onBack && (
                    <Button variant="subtle" color="gray" h={44} onClick={onBack}>
                        ← Everyone
                    </Button>
                )}
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

            {/* Who every card below may be, to compare the faces with. */}
            {performer && (
                <Group gap="sm" wrap="nowrap">
                    <PerformerPicture url={performer.pictureUrl} width={56} />
                    <Text fw={600} size="lg" style={{ minWidth: 0 }} truncate>
                        {performer.name}
                    </Text>
                </Group>
            )}

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
                            compare={performer && { tagId: performer.id, name: performer.name }}
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
}> = ({ performer, onPerformer, media, onMedia }) => (
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
                    each item. Only clear matches are asked about.
                </Text>
                <SuggestionPeople media={media} onPerformer={(tagId) => onPerformer(tagId)} />
            </>
        )}
    </Stack>
);
