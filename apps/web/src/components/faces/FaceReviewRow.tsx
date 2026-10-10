"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import {
    Anchor,
    Badge,
    Box,
    Button,
    Group,
    Paper,
    Popover,
    Stack,
    Text,
    UnstyledButton,
} from "@mantine/core";
import { useDebouncedValue, useMediaQuery } from "@mantine/hooks";

import {
    normalizeName,
    type FaceLikeness,
    type FaceMatchState,
    type FaceReviewDecision,
    type FaceReviewFace,
    type FaceReviewRow,
} from "@private-stock/core";

import { TagNameInput } from "@/components/tags/TagNameInput";
import { useTagSearch } from "@/lib/api/tags";
import { itemHref } from "@/lib/lookMoment";
import { useCloseOnBack } from "@/lib/useCloseOnBack";

import { FaceCropView } from "./FaceCropView";
import { FacePeek } from "./FacePeek";

const items = (n: number): string => `${n.toLocaleString()} ${n === 1 ? "item" : "items"}`;

const WHY: Record<FaceMatchState, string> = {
    confirmed: "Face confirmed before",
    proposed: "Suggested by their tags",
    resembles: "Looks like them",
};

/** How many existing names a coining box offers instead. */
const NEAR_NAMES = 4;

/**
 * A performer's name, typed or picked, and the button that tags with it.
 *
 * A typed name nobody has used coins a performer, which is cheap here and dear later — two
 * performers for one person are a merge somebody has to notice. So when what is typed is not
 * already a name but is close to some (the vocabulary's own search, typos included), those are
 * offered beside it, and the button says it is adding someone new.
 */
export const NameBox: React.FC<{
    action: (name: string) => string;
    busy: boolean;
    disabled: boolean;
    onName: (name: string) => void;
    autoFocus?: boolean;
}> = ({ action, busy, disabled, onName, autoFocus }) => {
    const [names, setNames] = useState<string[]>([]);
    const [typed, setTyped] = useState("");
    // What is typed counts as much as a picked chip: nobody should have to press Enter first.
    const name = (names[0] ?? typed).trim();
    const [debounced] = useDebouncedValue(names.length === 0 ? typed.trim() : "", 200);
    const search = useTagSearch("performer", "public", debounced, debounced !== "");
    const typedNorm = normalizeName(name);
    const near =
        names.length === 0 && debounced !== "" && debounced === typed.trim()
            ? (search.data?.tags ?? [])
            : [];
    const exists = near.some((tag) => tag.nameNorm === typedNorm);
    const coining = name !== "" && names.length === 0 && !exists && search.isSuccess;
    const offered = exists ? [] : near.slice(0, NEAR_NAMES);

    return (
        <Stack gap={6}>
            <Group gap="xs" wrap="wrap" align="flex-start">
                <TagNameInput
                    kind="performer"
                    scope="public"
                    value={names}
                    onChange={(next) => setNames(next.slice(-1))}
                    searchValue={typed}
                    onSearchChange={setTyped}
                    maxTags={1}
                    placeholder="Who is this?"
                    aria-label="Performer name"
                    autoFocus={autoFocus}
                    style={{ flex: "1 1 220px", minWidth: 0 }}
                />
                <Button
                    color="brass"
                    h={36}
                    disabled={!name || disabled}
                    loading={busy}
                    onClick={() => onName(name)}
                >
                    {name ? (coining ? `New performer: ${action(name)}` : action(name)) : "Tag"}
                </Button>
            </Group>
            {coining && offered.length > 0 && (
                <Group gap={6} wrap="wrap">
                    <Text size="xs" c="dimmed">
                        Already in the library:
                    </Text>
                    {offered.map((tag) => (
                        <Button
                            key={tag.id}
                            size="compact-xs"
                            variant="light"
                            color="gray"
                            onClick={() => {
                                setNames([tag.name]);
                                setTyped("");
                            }}
                        >
                            {tag.name}
                        </Button>
                    ))}
                </Group>
            )}
        </Stack>
    );
};

/** How long a press is held before it is a closer look rather than a tick. */
const HOLD_MS = 450;

/**
 * What somebody has said of one face in a row: them, not them, or unsure — left undecided, to be
 * asked about again later (§5f "Unsure"). "Someone else…" asks only the first two.
 */
export type TickState = "in" | "out" | "unsure";

/** The next state a press gives: them, then not them, then unsure, then them again. */
export const nextTick = (state: TickState, threeWay: boolean): TickState =>
    state === "in" ? "out" : state === "out" && threeWay ? "unsure" : "in";

const TICK_WORDS: Record<TickState, string> = {
    in: "them",
    out: "not them",
    unsure: "unsure",
};

/**
 * One face being asked about: pressed to go round them, not them and unsure; held, or "Look"
 * under it, for a closer look in place. Numbered for the keys; a dot where it is less like the
 * rest — the app's hint, kept apart from the "?" that is the reviewer's own "unsure".
 */
/** What inside a closer look does something of its own; a tap anywhere else closes it. */
const PEEK_CONTROLS = "button, a, input, label, [role='radiogroup']";

const FaceTick: React.FC<{
    groupId: string;
    face: FaceReviewFace;
    size: number;
    state: TickState;
    threeWay: boolean;
    doubtful: boolean;
    number: number;
    peeking: boolean;
    onSet: (state: TickState) => void;
    onPeek: (open: boolean) => void;
    onPlay: () => void;
}> = ({
    groupId,
    face,
    size,
    state,
    threeWay,
    doubtful,
    number,
    peeking,
    onSet,
    onPeek,
    onPlay,
}) => {
    const included = state === "in";
    const unsure = state === "unsure";
    const hold = useRef<number | null>(null);
    const held = useRef(false);

    const release = (): void => {
        if (hold.current !== null) window.clearTimeout(hold.current);
        hold.current = null;
    };

    // Back closes the closer look, not the review under it.
    useCloseOnBack(peeking, () => onPeek(false));

    return (
        <Popover
            opened={peeking}
            onChange={onPeek}
            position="bottom"
            withArrow
            shadow="md"
            withinPortal
        >
            <Popover.Target>
                <Stack gap={0} align="center">
                    <UnstyledButton
                        onPointerDown={() => {
                            held.current = false;
                            release();
                            hold.current = window.setTimeout(() => {
                                held.current = true;
                                onPeek(true);
                            }, HOLD_MS);
                        }}
                        onPointerUp={release}
                        onPointerLeave={release}
                        onContextMenu={(event) => event.preventDefault()}
                        onClick={(event) => {
                            event.stopPropagation();
                            // A hold was a look, not a tick.
                            if (held.current) {
                                held.current = false;
                                return;
                            }
                            onSet(nextTick(state, threeWay));
                        }}
                        aria-label={`Face ${number}: ${TICK_WORDS[state]}${doubtful ? ", less like the rest" : ""}`}
                        style={{
                            position: "relative",
                            borderRadius: 8,
                            padding: 2,
                            outline: included
                                ? "2px solid var(--mantine-color-brass-6)"
                                : unsure
                                  ? "2px dashed var(--mantine-color-yellow-6)"
                                  : "2px solid transparent",
                            touchAction: "manipulation",
                            userSelect: "none",
                        }}
                    >
                        <Box
                            style={{
                                opacity: included ? 1 : unsure ? 0.65 : 0.3,
                                filter: state === "out" ? "grayscale(1)" : undefined,
                            }}
                        >
                            <FaceCropView crop={face.crop} size={size} />
                        </Box>
                        <Box
                            aria-hidden
                            style={{
                                position: "absolute",
                                right: 4,
                                top: 4,
                                width: 20,
                                height: 20,
                                borderRadius: 10,
                                display: "grid",
                                placeItems: "center",
                                fontSize: 12,
                                fontWeight: 700,
                                color: unsure
                                    ? "var(--mantine-color-black)"
                                    : "var(--mantine-color-white)",
                                background: included
                                    ? "var(--mantine-color-brass-6)"
                                    : unsure
                                      ? "var(--mantine-color-yellow-5)"
                                      : "var(--mantine-color-dark-4)",
                            }}
                        >
                            {included ? "✓" : unsure ? "?" : "✕"}
                        </Box>
                        {doubtful && (
                            <Box
                                aria-hidden
                                style={{
                                    position: "absolute",
                                    left: 6,
                                    top: 6,
                                    width: 10,
                                    height: 10,
                                    borderRadius: 5,
                                    background: "var(--mantine-color-yellow-5)",
                                    boxShadow: "0 0 0 2px var(--mantine-color-dark-7)",
                                }}
                            />
                        )}
                        {number <= 10 && (
                            <Box
                                aria-hidden
                                visibleFrom="sm"
                                style={{
                                    position: "absolute",
                                    left: 6,
                                    bottom: 4,
                                    fontSize: 11,
                                    fontWeight: 600,
                                    color: "var(--mantine-color-white)",
                                    textShadow: "0 0 3px var(--mantine-color-black)",
                                }}
                            >
                                {number % 10}
                            </Box>
                        )}
                    </UnstyledButton>
                    <Anchor
                        component="button"
                        type="button"
                        size="xs"
                        c="dimmed"
                        py={6}
                        onClick={(event: React.MouseEvent) => {
                            event.stopPropagation();
                            onPeek(!peeking);
                        }}
                    >
                        Look
                    </Anchor>
                </Stack>
            </Popover.Target>
            <Popover.Dropdown
                onClick={(event) => {
                    event.stopPropagation();
                    // A tap on the picture, or anywhere but a control, closes it.
                    if (!(event.target as Element).closest(PEEK_CONTROLS)) onPeek(false);
                }}
                style={{ cursor: "pointer" }}
            >
                <FacePeek
                    groupId={groupId}
                    face={face}
                    state={state}
                    threeWay={threeWay}
                    onSet={onSet}
                    onPlay={onPlay}
                />
            </Popover.Dropdown>
        </Popover>
    );
};

/** A face settled by a decision on another row: still where it was, dimmed, nothing to press. */
const SettledFace: React.FC<{ face: FaceReviewFace; size: number }> = ({ face, size }) => (
    <Stack gap={0} align="center" aria-label="Already decided" style={{ opacity: 0.35 }}>
        <Box pos="relative">
            <FaceCropView crop={face.crop} size={size} />
            <Text size="xs" fw={700} pos="absolute" top={2} right={6} c="brass.3" aria-hidden>
                ✓
            </Text>
        </Box>
        {/* The tick's own label row, so a settled face takes the space a live one does. */}
        <Text size="xs" c="dimmed" py={6}>
            Done
        </Text>
    </Stack>
);

/**
 * Which faces start unsure, before anybody has touched the row (§5f "Unsure"): those below the
 * doubt line, where the row is scored against the performer's reference — of the faces people
 * refused, nearly nine in ten score below it, and of those they confirmed fewer than one in ten.
 * Unsure rather than "not them": the app's doubt is not a person's refusal, so left alone they are
 * left undecided, and asked about again later, until somebody says. Against a row's own faces (Unnamed)
 * none: there the score says only which faces are unlike the others, not who anybody is.
 */
export const defaultUnsure = (
    faces: readonly FaceReviewFace[],
    likeness: FaceLikeness | undefined
): Set<string> =>
    likeness?.anchored
        ? new Set(
              faces
                  .filter((face) => (likeness.scores[face.id] ?? 1) < likeness.doubt)
                  .map((face) => face.mediaId)
          )
        : new Set();

/**
 * A row's faces in the order to check them: the least like the rest first, so the few that
 * might be wrong are the first looked at — and which of them fall below the line. In the order
 * given until the likeness arrives.
 */
export const orderFaces = (
    faces: readonly FaceReviewFace[],
    likeness: FaceLikeness | undefined
): { faces: FaceReviewFace[]; doubtful: Set<string> } => {
    if (!likeness) {
        return { faces: [...faces], doubtful: new Set() };
    }

    const score = (face: FaceReviewFace): number => likeness.scores[face.id] ?? 1;

    return {
        faces: faces
            .map((face, index) => ({ face, index }))
            .sort((a, b) => score(a.face) - score(b.face) || a.index - b.index)
            .map(({ face }) => face),
        doubtful: new Set(
            faces.filter((face) => score(face) < likeness.doubt).map((face) => face.id)
        ),
    };
};

export interface FaceReviewRowProps {
    row: FaceReviewRow;
    /** How alike its faces are to who it asks about: the row is drawn once this has arrived. */
    likeness: FaceLikeness | undefined;
    /**
     * Its items settled by a decision on another row since the list was made: shown, dimmed,
     * and left out of this row's decision (§5f "A list that holds still").
     */
    settled: ReadonlySet<string>;
    /** Where the keys act; the sheet moves it. */
    focused: boolean;
    onFocus: () => void;
    /**
     * Faces left out of tagging as the candidate, or as the name typed on Unnamed.
     */
    excluded: Set<string>;
    /**
     * Faces somebody is unsure of: left undecided, to be asked about again later. Null until the
     * row is touched: then the doubtful faces (`defaultUnsure`).
     */
    unsure: Set<string> | null;
    /**
     * "Someone else…" is open: the faces chosen as somebody else, which start empty. Null when
     * it is not.
     */
    chosen: Set<string> | null;
    onSet: (mediaId: string, state: TickState) => void;
    onElsewhere: (open: boolean) => void;
    /** The decision being saved for this row, if one is. */
    pending: FaceReviewDecision["verdict"] | null;
    onAccept: () => void;
    onRefuse: () => void;
    onName: (name: string) => void;
    onSkip: () => void;
    /** "Not one person": the group's undecided faces out of grouping for good. */
    onScatter: () => void;
    /** The face looked at closely, by id, if any. */
    peeking: string | null;
    onPeek: (faceId: string | null) => void;
    /** Play the face's item beside the review. */
    onPlay: (face: FaceReviewFace) => void;
}

/**
 * One face group in Review › Faces (§5f "One review, two sources").
 *
 * The faces being decided about are the only ones that can be ticked: one for each item the
 * decision would tag, each ticked to start with. On Matches, a few faces of the performer sit
 * apart above them to compare with — from this group's tagged items, or, for a group that only
 * looks like theirs, their confirmed face — what proposed the match, not part of it.
 *
 * Tagging tags exactly the ticked items and remembers the unticked ones as not the performer, so
 * they are not asked about again. "Someone else…" asks a different question, so it starts with
 * nothing ticked: tick the faces that are the person named.
 */
export const FaceReviewRowView: React.FC<FaceReviewRowProps> = ({
    row,
    likeness,
    settled,
    focused,
    onFocus,
    excluded,
    unsure,
    chosen,
    onSet,
    onElsewhere,
    pending,
    onAccept,
    onRefuse,
    onName,
    onSkip,
    onScatter,
    peeking,
    onPeek,
    onPlay,
}) => {
    const isPhone = useMediaQuery("(max-width: 48em)");
    const ordered = orderFaces(row.faces, likeness);
    const candidate = row.candidate;
    const size = isPhone ? 72 : 88;
    const busy = pending !== null;
    const elsewhere = chosen !== null;
    const out = excluded;

    // Back cancels "Someone else…", as its own button does.
    useCloseOnBack(elsewhere, () => onElsewhere(false));
    const notSure = unsure ?? defaultUnsure(row.faces, likeness);
    const open = row.faces.filter((face) => !settled.has(face.mediaId));
    const stateOf = (mediaId: string): TickState =>
        chosen
            ? chosen.has(mediaId)
                ? "in"
                : "out"
            : notSure.has(mediaId)
              ? "unsure"
              : out.has(mediaId)
                ? "out"
                : "in";
    const ticked = open.filter((face) => stateOf(face.mediaId) === "in").length;
    const unsureCount = elsewhere
        ? 0
        : open.filter((face) => stateOf(face.mediaId) === "unsure").length;
    const left = open.length - ticked - unsureCount;

    return (
        <Paper
            withBorder
            radius="md"
            p="sm"
            mb="sm"
            onClick={onFocus}
            style={
                focused
                    ? { borderColor: "var(--mantine-color-brass-6)", borderWidth: 2 }
                    : undefined
            }
        >
            <Stack gap="sm">
                <Group gap="xs" wrap="wrap">
                    {candidate ? (
                        <>
                            <Text fw={600}>{candidate.name}?</Text>
                            <Badge
                                variant="light"
                                color={candidate.state === "confirmed" ? "brass" : "gray"}
                                size="sm"
                                style={{ textTransform: "none" }}
                            >
                                {WHY[candidate.state]}
                            </Badge>
                        </>
                    ) : (
                        <Text fw={600}>Who is this?</Text>
                    )}
                    {row.loose && (
                        <Badge
                            variant="light"
                            color="yellow"
                            size="sm"
                            style={{ textTransform: "none" }}
                        >
                            Loosely grouped — may be several people
                        </Badge>
                    )}
                    <Text size="sm" c="dimmed">
                        One face group, on {items(row.itemCount)}
                    </Text>
                </Group>

                {candidate && row.reference.length > 0 && (
                    <Stack gap={4}>
                        <Text size="xs" c="dimmed">
                            {candidate.state === "resembles"
                                ? `${candidate.name}'s face, for comparison`
                                : `Already tagged as ${candidate.name}, for comparison`}
                        </Text>
                        <Group gap={6} wrap="wrap" align="flex-start">
                            {/* Their picture first, at a face's size here and no smaller
                                (§6 "A tag's picture"): who the proposal says this is. */}
                            {candidate.pictureUrl && (
                                <Link
                                    href={`/tags/${encodeURIComponent(candidate.tagId)}`}
                                    prefetch={false}
                                    aria-label={`${candidate.name}'s page`}
                                >
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img
                                        src={candidate.pictureUrl}
                                        alt=""
                                        width={size}
                                        height={Math.round((size * 5) / 4)}
                                        style={{
                                            display: "block",
                                            objectFit: "cover",
                                            borderRadius: 4,
                                            border: "1px solid var(--mantine-color-brass-7)",
                                        }}
                                    />
                                </Link>
                            )}
                            {row.reference.map((face) => (
                                <Link
                                    key={face.mediaId}
                                    href={itemHref(face.mediaId, face.atMs)}
                                    prefetch={false}
                                    aria-label={`Open an item of ${candidate.name}'s`}
                                >
                                    <FaceCropView crop={face.crop} size={isPhone ? 44 : 56} />
                                </Link>
                            ))}
                        </Group>
                    </Stack>
                )}

                <Stack gap={4}>
                    <Text size="sm">
                        {elsewhere
                            ? "Tick the faces that are the person you name"
                            : candidate
                              ? `Not tagged yet — untick any that are not ${candidate.name}`
                              : "Untick any that are not the same person"}
                    </Text>
                    {ordered.doubtful.size > 0 && (
                        <Text size="xs" c="yellow.5">
                            {ordered.doubtful.size === 1
                                ? "The first, marked ●, looks less like the rest — check it first."
                                : `The first ${ordered.doubtful.size}, marked ●, look less like the rest — check them first.`}
                        </Text>
                    )}
                    <Group gap={4} wrap="wrap" align="flex-start">
                        {ordered.faces.map((face, index) =>
                            settled.has(face.mediaId) ? (
                                <SettledFace key={face.mediaId} face={face} size={size} />
                            ) : (
                                <FaceTick
                                    key={face.mediaId}
                                    groupId={row.groupId}
                                    face={face}
                                    size={size}
                                    number={index + 1}
                                    doubtful={ordered.doubtful.has(face.id)}
                                    state={stateOf(face.mediaId)}
                                    threeWay={!elsewhere}
                                    peeking={peeking === face.id}
                                    onSet={(state) => onSet(face.mediaId, state)}
                                    onPeek={(open) => onPeek(open ? face.id : null)}
                                    onPlay={() => {
                                        onPeek(null);
                                        onPlay(face);
                                    }}
                                />
                            )
                        )}
                    </Group>
                    {row.more > 0 && (
                        <Text size="xs" c="dimmed">
                            {items(row.more)} more in this group come back here once these are
                            decided.
                        </Text>
                    )}
                </Stack>

                {candidate ? (
                    <Group gap="xs" wrap="wrap">
                        <Button
                            color="brass"
                            h={44}
                            disabled={busy || elsewhere || ticked === 0}
                            loading={pending === "accept"}
                            onClick={(event) => {
                                event.stopPropagation();
                                onAccept();
                            }}
                        >
                            Tag {items(ticked)} as {candidate.name}
                        </Button>
                        <Button
                            variant="default"
                            h={44}
                            disabled={busy || elsewhere}
                            loading={pending === "refuse"}
                            onClick={(event) => {
                                event.stopPropagation();
                                onRefuse();
                            }}
                        >
                            None of these are {candidate.name}
                        </Button>
                        <Popover
                            opened={elsewhere}
                            onChange={onElsewhere}
                            position="bottom-start"
                            withArrow
                            trapFocus
                            closeOnClickOutside={false}
                        >
                            <Popover.Target>
                                <Button
                                    variant="subtle"
                                    color="gray"
                                    h={44}
                                    disabled={busy}
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        onElsewhere(!elsewhere);
                                    }}
                                >
                                    {elsewhere ? "Cancel" : "Someone else…"}
                                </Button>
                            </Popover.Target>
                            <Popover.Dropdown onKeyDown={(event) => event.stopPropagation()}>
                                <Stack gap="xs" w={isPhone ? 260 : 340}>
                                    <NameBox
                                        autoFocus
                                        busy={pending === "name"}
                                        disabled={ticked === 0}
                                        action={(name) => `Tag ${items(ticked)} as ${name}`}
                                        onName={onName}
                                    />
                                    <Text size="xs" c="dimmed">
                                        Tick the faces above that are the person you name. They stop
                                        being suggested as {candidate.name} and are tagged with the
                                        name given; the rest are left as they were.
                                    </Text>
                                </Stack>
                            </Popover.Dropdown>
                        </Popover>
                    </Group>
                ) : (
                    <Group
                        gap="xs"
                        wrap="wrap"
                        align="flex-start"
                        onClick={(event) => event.stopPropagation()}
                        onKeyDown={(event) => event.stopPropagation()}
                    >
                        <div style={{ flex: "1 1 320px", minWidth: 0 }} data-name-box>
                            <NameBox
                                busy={pending === "name"}
                                disabled={ticked === 0}
                                action={(name) => `Tag ${items(ticked)} as ${name}`}
                                onName={onName}
                            />
                        </div>
                        <Button
                            variant="subtle"
                            color="gray"
                            h={36}
                            disabled={busy}
                            loading={pending === "skip"}
                            onClick={onSkip}
                        >
                            Can&apos;t tell
                        </Button>
                        <Button
                            variant="subtle"
                            color="oxblood"
                            h={36}
                            disabled={busy}
                            loading={pending === "scatter"}
                            onClick={onScatter}
                            title="Several people, or faces turned away: take them out of grouping for good"
                        >
                            Not one person
                        </Button>
                    </Group>
                )}

                {/* Always there, so ticking a face never changes the row's height. */}
                <Text size="xs" c="dimmed" mih={36}>
                    {!elsewhere &&
                        left > 0 &&
                        `The ${items(left)} left out will not be suggested as ${candidate ? candidate.name : "the name given"} again. `}
                    {!elsewhere &&
                        unsureCount > 0 &&
                        `${unsureCount === 1 ? "The one" : `The ${unsureCount}`} marked ? ${unsureCount === 1 ? "is" : "are"} left undecided, to be asked about again later.`}
                </Text>
            </Stack>
        </Paper>
    );
};
