"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Box, Button, Group, Loader, Modal, Paper, SimpleGrid, Stack, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";

import {
    matchStrength,
    type FaceCrop,
    type FaceReviewFace,
    type FaceSearch,
    type FaceSearchName,
    type MatchStrength,
} from "@private-stock/core";

import { FaceCropView } from "@/components/faces/FaceCropView";
import { FaceViewDrawer } from "@/components/faces/FaceViewDrawer";
import { MARKS, PersonCardView } from "@/components/faces/PersonCardView";
import { NameBox, type TickState } from "@/components/faces/faceControls";
import { SomebodyGlyph } from "@/components/media/Glyph";
import {
    useFaceSearch,
    useFaceSearchMatches,
    useNameFromSearch,
    useStartFaceSearch,
} from "@/lib/api/faces";
import { faceSquare } from "@/lib/faceSquare";
import { parseAtParam } from "@/lib/resumePoint";
import { formatTimecode } from "@/lib/timecode";

/**
 * Who is this? (§5f "Who is this?"): the frame on screen, its faces, and for the one chosen the
 * items across the library whose faces are most like it — "I know I've seen this person before;
 * where?" The video stops on the frame; the worker reads that frame from the original, which takes
 * some seconds, while the picture already shows what is being asked about.
 *
 * **Candidates are examined in place.** A tap opens the closer look over the card — the frame the
 * face was seen in and the same person's other moments there — and "Play it here" plays the item
 * beside the results. Leaving for an item is still one step away, and does not lose the search:
 * it is in the page's address (`who`, `whoFace`), so Back from that item reopens it as it was.
 */

const STRENGTH_LABEL: Record<MatchStrength, string> = {
    strong: "Very alike",
    likely: "Alike",
    possible: "Somewhat alike",
    weak: "Faintly alike",
};

const BOX = "var(--mantine-color-brass-4)";

/** How wide the frame is kept to show while it is read: a picture to point at, not to study. */
const PICTURE_WIDTH = 1280;

/** The frame on screen, as the browser drew it. */
interface Picture {
    url: string;
    width: number;
    height: number;
}

/**
 * The frame the element is showing, or null when it cannot be had: nothing decoded yet, or a
 * picture the browser will not let a page read back.
 */
const pictureOf = (video: HTMLVideoElement | null): Picture | null => {
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) return null;

    const scale = Math.min(1, PICTURE_WIDTH / video.videoWidth);
    const canvas = document.createElement("canvas");

    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);

    try {
        canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);

        return {
            url: canvas.toDataURL("image/jpeg", 0.85),
            width: canvas.width,
            height: canvas.height,
        };
    } catch {
        return null;
    }
};

/**
 * The frame, kept for the visit so that Back from an item a search found shows it again. Session
 * storage, a convenience: without it the search comes back with its faces as numbers only.
 */
const pictureKey = (searchId: string) => `ps:whoIsThis:${searchId}`;

const keepPicture = (searchId: string, picture: Picture | null): void => {
    if (!picture) return;

    try {
        sessionStorage.setItem(pictureKey(searchId), JSON.stringify(picture));
    } catch {
        // Full, or refused: the search still works without it.
    }
};

const keptPicture = (searchId: string): Picture | null => {
    try {
        const kept = sessionStorage.getItem(pictureKey(searchId));

        return kept ? (JSON.parse(kept) as Picture) : null;
    } catch {
        return null;
    }
};

/** The faces found, boxed and numbered on the frame; each box chooses its face. */
const FramePicture: React.FC<{
    picture: Picture;
    faces: FaceSearch["faces"];
    selected: number | null;
    onSelect: (index: number) => void;
}> = ({ picture, faces, selected, onSelect }) => (
    <Box pos="relative" style={{ display: "inline-block", maxWidth: "100%", lineHeight: 0 }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- a picture drawn in the browser */}
        <img
            src={picture.url}
            alt="The frame asked about"
            style={{
                display: "block",
                maxWidth: "100%",
                maxHeight: "45dvh",
                width: "auto",
                height: "auto",
                borderRadius: 6,
            }}
        />
        {faces.map((face, index) => (
            <Box
                key={index}
                component="button"
                type="button"
                aria-label={`Face ${index + 1}`}
                aria-pressed={selected === index}
                onClick={() => onSelect(index)}
                style={{
                    position: "absolute",
                    left: `${face.x * 100}%`,
                    top: `${face.y * 100}%`,
                    width: `${face.w * 100}%`,
                    height: `${face.h * 100}%`,
                    padding: 0,
                    cursor: "pointer",
                    background: "transparent",
                    border: `${selected === index ? 3 : 2}px solid ${BOX}`,
                    borderRadius: 4,
                    opacity: selected === null || selected === index ? 1 : 0.5,
                    boxShadow: "0 0 0 1px rgba(0, 0, 0, 0.6)",
                }}
            >
                <Text
                    component="span"
                    size="xs"
                    fw={700}
                    style={{
                        position: "absolute",
                        left: -2,
                        top: -2,
                        transform: "translateY(-100%)",
                        padding: "0 6px",
                        lineHeight: "18px",
                        borderRadius: 4,
                        background: BOX,
                        color: "#0d0a08",
                    }}
                >
                    {index + 1}
                </Text>
            </Box>
        ))}
    </Box>
);

/**
 * The face being compared with, held at the top while the results scroll under it, and the others
 * on the frame to switch to.
 */
const Comparing: React.FC<{
    picture: Picture | null;
    faces: FaceSearch["faces"];
    selected: number | null;
    onSelect: (index: number) => void;
}> = ({ picture, faces, selected, onSelect }) => {
    const face = selected === null ? null : faces[selected];

    return (
        <Group
            gap="sm"
            justify="center"
            py="xs"
            style={{
                position: "sticky",
                top: 0,
                zIndex: 2,
                background: "var(--ps-surface)",
            }}
        >
            {face && picture && (
                <FaceCropView
                    crop={{
                        url: picture.url,
                        rect: faceSquare(face, picture.width, picture.height),
                        frame: faceSquare(face, picture.width, picture.height),
                    }}
                    size={56}
                />
            )}
            {faces.length > 1 && (
                <>
                    <Text size="sm" c="dimmed">
                        {selected === null ? "Which face?" : "Face"}
                    </Text>
                    {faces.map((_, index) => (
                        <Button
                            key={index}
                            h={44}
                            miw={44}
                            px="sm"
                            variant={selected === index ? "filled" : "default"}
                            color={selected === index ? "brass" : undefined}
                            onClick={() => onSelect(index)}
                        >
                            {index + 1}
                        </Button>
                    ))}
                </>
            )}
        </Group>
    );
};

/** What is said of a candidate: nothing yet, that they are the person, or that they are not. */
type Said = "open" | "them" | "notThem";

/** A press moves on: nothing said, them, not them, and back to nothing said. */
const NEXT_SAID: Record<Said, Said> = { open: "them", them: "notThem", notThem: "open" };

/** The closer look's switch says the same three things in its own words. */
const TICK_OF: Record<Said, TickState> = { open: "unsure", them: "in", notThem: "out" };
const SAID_OF: Record<TickState, Said> = { unsure: "open", in: "them", out: "notThem" };

/** Who face `index` of a search was named as, kept for the visit: one search names one person. */
const namedKey = (searchId: string, index: number) => `ps:whoIsThis:${searchId}:${index}:named`;

const keptNamed = (searchId: string, index: number): { tagId: string; name: string } | null => {
    try {
        const kept = sessionStorage.getItem(namedKey(searchId, index));

        return kept ? (JSON.parse(kept) as { tagId: string; name: string }) : null;
    } catch {
        return null;
    }
};

const items = (n: number): string => `${n} ${n === 1 ? "item" : "items"}`;

const CARD = 96;

/** The video asked from: always tagged, so a card that says so and takes no press. */
const SourceCard: React.FC<{ crop: FaceCrop | null; atMs: number }> = ({ crop, atMs }) => (
    <Paper withBorder radius="md" p={4}>
        <Stack gap={0} align="center">
            <Box
                pos="relative"
                style={{
                    borderRadius: 8,
                    padding: 2,
                    outline: "2px solid var(--mantine-color-brass-6)",
                }}
            >
                {crop ? (
                    <FaceCropView crop={crop} size={CARD} />
                ) : (
                    <Box
                        w={CARD}
                        h={CARD}
                        style={{ borderRadius: 6, background: "var(--ps-well)" }}
                    />
                )}
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
                        color: MARKS.them.ink,
                        background: MARKS.them.color,
                    }}
                >
                    {MARKS.them.symbol}
                </Box>
            </Box>
            <Group h={44} px={4} w="100%" justify="center">
                <Text size="xs" c="dimmed" truncate>
                    This video, at {formatTimecode(atMs)}
                </Text>
            </Group>
        </Stack>
    </Paper>
);

/**
 * The items whose faces are most like the one chosen, best first, each looked at in place — and
 * saying who the person is: the video asked from always, and each candidate pressed as them. One
 * search names one person: after the first save the name is fixed, and later saves add to it.
 */
const Matches: React.FC<{
    searchId: string;
    index: number;
    sourceCrop: FaceCrop | null;
    atMs: number;
}> = ({ searchId, index, sourceCrop, atMs }) => {
    const { data, isPending, isError, error } = useFaceSearchMatches(searchId, index);
    const name = useNameFromSearch(searchId, index);
    const [viewing, setViewing] = useState<FaceReviewFace | null>(null);
    /** What is said and not yet saved, by face. */
    const [said, setSaid] = useState<ReadonlyMap<string, Said>>(new Map());
    /** What was saved this visit, by face: "not them" is not on the cards when they are read again. */
    const [saved, setSaved] = useState<ReadonlyMap<string, Said>>(new Map());
    const [named, setNamed] = useState(() => keptNamed(searchId, index));

    if (isPending) {
        return (
            <Group gap="sm" justify="center" p="md">
                <Loader size="sm" />
            </Group>
        );
    }

    if (isError) {
        return (
            <Text size="sm" c="oxblood">
                {error.message}
            </Text>
        );
    }

    const pending = data.matches.filter((match) => (said.get(match.face.id) ?? "open") !== "open");
    const them = pending.filter((match) => said.get(match.face.id) === "them").length;
    const notThem = pending.length - them;
    // Names the candidates are already confirmed as: who this may well be, one press away.
    const seenAs = [
        ...data.matches
            .flatMap((match) => (match.confirmed ? [match.confirmed] : []))
            .reduce(
                (counts, tag) =>
                    counts.set(tag.tagId, {
                        ...tag,
                        count: (counts.get(tag.tagId)?.count ?? 0) + 1,
                    }),
                new Map<string, { tagId: string; name: string; count: number }>()
            )
            .values(),
    ]
        .sort((a, b) => b.count - a.count)
        .slice(0, 3);

    const save = (performer: FaceSearchName["performer"]) =>
        name.mutate(
            {
                performer,
                people: pending.map((match) => ({
                    mediaId: match.face.mediaId,
                    faceIds: match.faceIds,
                    shownFaceId: match.face.id,
                    verdict: said.get(match.face.id) === "them" ? "is" : "isNot",
                })),
            },
            {
                onSuccess: (result) => {
                    const fixed = { tagId: result.tagId, name: result.name };

                    setSaved((current) => new Map([...current, ...said]));
                    setSaid(new Map());
                    setNamed(fixed);

                    try {
                        sessionStorage.setItem(namedKey(searchId, index), JSON.stringify(fixed));
                    } catch {
                        // Without it, coming back asks for the name again; nothing else is lost.
                    }
                },
            }
        );

    const press = (faceId: string, next: Said) =>
        setSaid((current) => new Map(current).set(faceId, next));

    return (
        <Stack gap="xs">
            <Text size="xs" c="dimmed">
                The {data.matches.length} most alike, best first. Press a face that is them; press
                again for not them. &ldquo;Look&rdquo; shows where it was seen.
            </Text>
            <SimpleGrid cols={{ base: 2, xs: 3, sm: 4, md: 6 }} spacing="sm" verticalSpacing="sm">
                <SourceCard crop={sourceCrop} atMs={atMs} />
                {data.matches.map((match) => {
                    const id = match.face.id;
                    const strength = STRENGTH_LABEL[matchStrength(match.score)];
                    const known = match.performers.join(", ");
                    const done =
                        saved.get(id) ??
                        (named && match.confirmed?.tagId === named.tagId ? "them" : undefined);

                    if (done && done !== "open") {
                        return (
                            <PersonCardView
                                key={id}
                                face={match.face}
                                others={match.others}
                                size={CARD}
                                mark={done === "them" ? MARKS.them : MARKS.notThem}
                                look={done === "them" ? "chosen" : "faded"}
                                caption={`${done === "them" ? "Tagged" : "Not"} ${named?.name ?? ""}`}
                                label={`${match.title}: saved`}
                                onPlay={setViewing}
                            />
                        );
                    }

                    // Somebody else's already: said elsewhere, and corrected there.
                    if (match.confirmed) {
                        return (
                            <PersonCardView
                                key={id}
                                face={match.face}
                                others={match.others}
                                size={CARD}
                                mark={MARKS.open}
                                look="plain"
                                caption={match.confirmed.name}
                                label={`${match.title}: confirmed as ${match.confirmed.name}`}
                                onPlay={setViewing}
                            />
                        );
                    }

                    const state = said.get(id) ?? "open";

                    return (
                        <PersonCardView
                            key={id}
                            face={match.face}
                            others={match.others}
                            size={CARD}
                            mark={
                                state === "them"
                                    ? MARKS.them
                                    : state === "notThem"
                                      ? MARKS.notThem
                                      : MARKS.open
                            }
                            look={
                                state === "them"
                                    ? "chosen"
                                    : state === "notThem"
                                      ? "faded"
                                      : "plain"
                            }
                            caption={known ? `${strength} · ${known}` : strength}
                            label={`${match.title}: ${
                                state === "them"
                                    ? "them"
                                    : state === "notThem"
                                      ? "not them"
                                      : "nothing said"
                            }`}
                            onPress={() => press(id, NEXT_SAID[state])}
                            peekState={{
                                state: TICK_OF[state],
                                threeWay: true,
                                onSet: (tick) => press(id, SAID_OF[tick]),
                            }}
                            onPlay={setViewing}
                        />
                    );
                })}
            </SimpleGrid>

            <Stack
                gap={6}
                py="xs"
                style={{
                    position: "sticky",
                    bottom: 0,
                    zIndex: 2,
                    background: "var(--ps-surface)",
                }}
            >
                <Text size="sm">
                    {named && saved.size > 0 && pending.length === 0
                        ? `Saved as ${named.name}.`
                        : `This video${them > 0 ? ` and ${items(them)} more` : ""}${
                              notThem > 0 ? `; ${notThem} not them` : ""
                          }`}
                </Text>
                {named ? (
                    <Button
                        color="brass"
                        h={44}
                        style={{ alignSelf: "flex-start" }}
                        loading={name.isPending}
                        disabled={pending.length === 0}
                        onClick={() => save({ by: "id", tagId: named.tagId })}
                    >
                        Save as {named.name}
                    </Button>
                ) : (
                    <>
                        {seenAs.length > 0 && (
                            <Group gap={6} wrap="wrap">
                                <Text size="xs" c="dimmed">
                                    Seen here as:
                                </Text>
                                {seenAs.map((tag) => (
                                    <Button
                                        key={tag.tagId}
                                        size="compact-sm"
                                        variant="light"
                                        color="brass"
                                        disabled={name.isPending}
                                        onClick={() => save({ by: "id", tagId: tag.tagId })}
                                    >
                                        {tag.name}
                                    </Button>
                                ))}
                            </Group>
                        )}
                        <NameBox
                            busy={name.isPending}
                            disabled={false}
                            action={(typed) => `Tag ${items(them + 1)} as ${typed}`}
                            onName={(typed) => save({ by: "name", name: typed })}
                        />
                    </>
                )}
                {name.isError && (
                    <Text size="xs" c="oxblood">
                        {name.error.message}
                    </Text>
                )}
            </Stack>

            <FaceViewDrawer
                face={viewing}
                onClose={() => setViewing(null)}
                note="The search stays as it is while you look."
            />
        </Stack>
    );
};

/** Asking about one moment: the frame, its faces, and the matches for the face chosen. */
const Asked: React.FC<{
    searchId: string | null;
    picture: Picture | null;
    chosen: number | null;
    onChoose: (index: number) => void;
    failedToStart: string | null;
    onRetry: () => void;
    atMs: number;
}> = ({ searchId, picture, chosen, onChoose, failedToStart, onRetry, atMs }) => {
    const { data: search } = useFaceSearch(searchId);

    const done = search?.state === "done";
    const faces = done ? search.faces : [];
    // One face needs no choosing.
    const selected =
        chosen !== null && chosen < faces.length ? chosen : faces.length === 1 ? 0 : null;
    const failure = failedToStart ?? (search?.state === "failed" ? search.error : null);

    return (
        <Stack gap="md">
            {picture && (
                <Box ta="center">
                    <FramePicture
                        picture={picture}
                        faces={faces}
                        selected={selected}
                        onSelect={onChoose}
                    />
                </Box>
            )}

            {failure !== null ? (
                <Group gap="sm" justify="center">
                    <Text size="sm" c="oxblood">
                        Could not read the frame{failure ? `: ${failure}` : ""}
                    </Text>
                    <Button variant="default" onClick={onRetry}>
                        Try again
                    </Button>
                </Group>
            ) : !done ? (
                <Group gap="sm" justify="center">
                    <Loader size="sm" />
                    <Text size="sm" c="dimmed">
                        Reading the frame… this can take several seconds.
                    </Text>
                </Group>
            ) : faces.length === 0 ? (
                <Text size="sm" c="dimmed" ta="center">
                    No faces found on this frame. A face too small, or turned well away, is not read
                    — try a moment where it is larger.
                </Text>
            ) : (
                <>
                    <Comparing
                        picture={picture}
                        faces={faces}
                        selected={selected}
                        onSelect={onChoose}
                    />
                    {selected !== null && searchId && (
                        <Matches
                            // Each face is its own question, with its own name and marks.
                            key={selected}
                            searchId={searchId}
                            index={selected}
                            sourceCrop={
                                picture
                                    ? {
                                          url: picture.url,
                                          rect: faceSquare(
                                              faces[selected]!,
                                              picture.width,
                                              picture.height
                                          ),
                                          frame: faceSquare(
                                              faces[selected]!,
                                              picture.width,
                                              picture.height
                                          ),
                                      }
                                    : null
                            }
                            atMs={atMs}
                        />
                    )}
                </>
            )}
        </Stack>
    );
};

/**
 * The viewer's "Who is this?" button and what it opens. For administrators, as every face surface
 * is, and for a video: a photograph's faces were read whole by the stage already.
 */
export const WhoIsThis: React.FC<{
    mediaId: string;
    positionRef: { current: number };
    elementRef: { current: HTMLVideoElement | null };
    iconOnly: boolean;
    /** Open or closed: while open, this view has the keys rather than the player and the page. */
    onOpenChange: (open: boolean) => void;
}> = ({ mediaId, positionRef, elementRef, iconOnly, onOpenChange }) => {
    const narrow = useMediaQuery("(max-width: 48em)");
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const start = useStartFaceSearch();

    /** Asked, and waiting for the search to exist: the moment and the frame drawn for it. */
    const [starting, setStarting] = useState<{ atMs: number; picture: Picture | null } | null>(
        null
    );
    /** Whether this page put the search into the history, and so may take it back out by Back. */
    const pushed = useRef(false);

    const searchId = searchParams.get("who");
    const chosenParam = Number(searchParams.get("whoFace"));
    const chosen =
        searchParams.has("whoFace") && Number.isInteger(chosenParam) ? chosenParam : null;
    const opened = starting !== null || searchId !== null;
    const atMs = starting?.atMs ?? parseAtParam(searchParams.get("at")) ?? 0;
    // Read once a search, not every render: it is a few hundred kilobytes of text.
    const kept = useMemo(() => (searchId ? keptPicture(searchId) : null), [searchId]);
    const picture = starting ? starting.picture : kept;

    /**
     * Whether it is open is the address's to say as much as this component's — Back from an item
     * reopens it — so the page is told from here whenever it changes, and that it is closed on
     * leaving: while open the page and the player must not act on keys meant for this view, Delete
     * among them.
     */
    useEffect(() => {
        onOpenChange(opened);
    }, [opened, onOpenChange]);

    useEffect(() => () => onOpenChange(false), [onOpenChange]);

    /** This page's address with `change` applied: the search lives in it. */
    const addressWith = (change: Record<string, string | null>): string => {
        const next = new URLSearchParams(searchParams.toString());

        for (const [key, value] of Object.entries(change)) {
            if (value === null) next.delete(key);
            else next.set(key, value);
        }

        const query = next.toString();

        return query ? `${pathname}?${query}` : pathname;
    };

    const ask = (moment: number, drawn: Picture | null) =>
        start.mutate(
            { mediaId, atMs: moment },
            {
                onSuccess: (search) => {
                    keepPicture(search.id, drawn);
                    setStarting(null);
                    // At the moment asked about, so coming back finds the video there too.
                    router.push(
                        addressWith({ who: search.id, whoFace: null, at: String(moment) }),
                        { scroll: false }
                    );
                    pushed.current = true;
                },
            }
        );

    const open = () => {
        const video = elementRef.current;

        // Stopped on the frame being asked about, rather than playing on under the question.
        video?.pause();

        const moment = Math.round(positionRef.current);
        const drawn = pictureOf(video);

        setStarting({ atMs: moment, picture: drawn });
        ask(moment, drawn);
    };

    const close = () => {
        setStarting(null);
        start.reset();

        if (searchId === null) return;

        if (pushed.current) {
            pushed.current = false;
            router.back();
        } else {
            router.replace(addressWith({ who: null, whoFace: null }), { scroll: false });
        }
    };

    return (
        <>
            <Button
                variant="default"
                onClick={open}
                leftSection={iconOnly ? undefined : <SomebodyGlyph size={16} />}
                aria-label="Who is this?"
                title="Who is this? Find this face across the library"
            >
                {iconOnly ? <SomebodyGlyph size={16} /> : "Who is this?"}
            </Button>

            <Modal
                opened={opened}
                onClose={close}
                size="80rem"
                fullScreen={narrow}
                title={
                    <Text fw={600}>
                        Who is this?{" "}
                        <Text component="span" c="dimmed" fw={400}>
                            at {formatTimecode(atMs)}
                        </Text>
                    </Text>
                }
            >
                {opened && (
                    <Asked
                        // A new search starts its choosing afresh.
                        key={searchId ?? "starting"}
                        searchId={searchId}
                        picture={picture}
                        chosen={chosen}
                        onChoose={(index) =>
                            router.replace(addressWith({ whoFace: String(index) }), {
                                scroll: false,
                            })
                        }
                        failedToStart={start.isError ? start.error.message : null}
                        onRetry={() => ask(atMs, picture)}
                        atMs={atMs}
                    />
                )}
            </Modal>
        </>
    );
};
