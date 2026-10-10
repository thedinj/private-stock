"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
    ActionIcon,
    Affix,
    Alert,
    Badge,
    Button,
    Group,
    Loader,
    Paper,
    Popover,
    Skeleton,
    Stack,
    Text,
} from "@mantine/core";
import { useQueries } from "@tanstack/react-query";
import type { Virtualizer } from "@tanstack/react-virtual";

import {
    normalizeName,
    type FaceLikeness,
    type FaceReviewDecision,
    type FaceReviewFace,
    type FaceReviewResult,
    type FaceReviewRow,
    type FaceReviewTab,
    type ReviewMedia,
} from "@private-stock/core";

import { VirtualFeed } from "@/components/ocr/VirtualFeed";
import { ReviewKindFilter } from "@/components/review/ReviewKindFilter";
import { faceLikenessQuery, useDecideFaceReview, useFaceReview } from "@/lib/api/faces";
import { isTypingTarget } from "@/lib/typingTarget";

import {
    FaceReviewRowView,
    defaultUnsure,
    nextTick,
    orderFaces,
    type TickState,
} from "./FaceReviewRow";
import { FaceViewDrawer } from "./FaceViewDrawer";

const errorText = (error: unknown): string =>
    error instanceof Error ? error.message : "That change could not be saved.";

const items = (n: number): string => `${n.toLocaleString()} ${n === 1 ? "item" : "items"}`;

const INTRO: Record<FaceReviewTab, string> = {
    matches:
        "Face groups that are, or might be, a performer, on items not tagged with them yet. " +
        "The ones that tag the most items come first.",
    unnamed:
        "The largest face groups nobody's tags or decisions point to anyone, and what is left " +
        "of a group once somebody in it was named. Naming one tags its items; a name not in the " +
        "library adds the performer.",
};

const EMPTY: Record<FaceReviewTab, string> = {
    matches:
        "Nothing to match. Groups appear here as the faces stage reads items whose performers " +
        "are tagged, and as groups come to look like a confirmed face.",
    unnamed: "No unnamed groups on two or more items yet.",
};

const KEYS: Record<FaceReviewTab, string> = {
    matches:
        "j / k move · 1–9, 0 them / not them / unsure · shift + digit look closer · x tick all or none · " +
        "a tag · d none of these · n someone else · s skip",
    unnamed:
        "j / k move · 1–9, 0 them / not them / unsure · shift + digit look closer · x tick all or none · " +
        "n name · s can't tell",
};

/**
 * The ticks, kept in the browser for the visit (§5f "Checking faces quickly"): leaving to open an
 * item and coming back used to lose them. Per tab; a row decided or gone is simply never asked
 * for. Storage can be missing or refuse — then the ticks last only as long as the page.
 */
const ticksKey = (tab: FaceReviewTab, which: string): string => `ps:faceReview:${tab}:${which}`;

const loadTicks = (tab: FaceReviewTab, which: string): Map<string, Set<string>> => {
    try {
        const raw = window.sessionStorage.getItem(ticksKey(tab, which));
        const parsed = raw ? (JSON.parse(raw) as Record<string, string[]>) : {};

        return new Map(Object.entries(parsed).map(([key, ids]) => [key, new Set(ids)]));
    } catch {
        return new Map();
    }
};

const saveTicks = (tab: FaceReviewTab, which: string, ticks: Map<string, Set<string>>): void => {
    try {
        window.sessionStorage.setItem(
            ticksKey(tab, which),
            JSON.stringify(Object.fromEntries([...ticks].map(([key, ids]) => [key, [...ids]])))
        );
    } catch {
        // Kept for the page only.
    }
};

/** Rows put off for this visit, by key: kept for the tab's session, as the ticks are. */
const loadDeferred = (tab: FaceReviewTab): ReadonlySet<string> => {
    try {
        const raw = window.sessionStorage.getItem(ticksKey(tab, "deferred"));

        return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
        return new Set();
    }
};

const saveDeferred = (tab: FaceReviewTab, rows: ReadonlySet<string>): void => {
    try {
        window.sessionStorage.setItem(ticksKey(tab, "deferred"), JSON.stringify([...rows]));
    } catch {
        // Kept for the page only.
    }
};

const keyOf = (row: FaceReviewRow): string => `${row.groupId}:${row.candidate?.tagId ?? ""}`;

const NONE: ReadonlySet<string> = new Set();

/**
 * What a decision settled beyond its own row (§5f "A list that holds still"): items now tagged
 * in a group, or as somebody, or set aside or scattered there. Another row showing them shows
 * them done, in place, rather than the list being fetched again under the person working it.
 */
interface Settled {
    groupId?: string;
    /** By name: a name typed may have coined the performer, whose id the row never had. */
    name?: string;
    mediaIds: ReadonlySet<string> | "all";
}

/** A decided row, as it stays in the list: one line where it was. */
interface Decided {
    message: string;
    /** Tagged as a performer: their other rows are one press away. */
    performer: { tagId: string; name: string } | null;
}

/** About the height of a row before its faces are scored: a placeholder holds its place. */
const PLACEHOLDER = 220;

const DecidedRow: React.FC<{
    decided: Decided;
    onPerformer: ((tagId: string) => void) | undefined;
}> = ({ decided, onPerformer }) => (
    <Paper withBorder radius="md" px="sm" py={8} mb="sm" style={{ opacity: 0.8 }}>
        <Group gap="xs" justify="space-between" wrap="nowrap">
            <Text size="sm" c="dimmed" lineClamp={1}>
                ✓ {decided.message}
            </Text>
            {decided.performer && onPerformer && (
                <Button
                    variant="subtle"
                    color="brass"
                    size="compact-sm"
                    onClick={() => onPerformer(decided.performer!.tagId)}
                >
                    More for {decided.performer.name}
                </Button>
            )}
        </Group>
    </Paper>
);

/**
 * One tab of Review › Faces (§5f "One review, two sources"), a page at a time and drawn only near
 * the screen, as OCR's queue is, with the same keys.
 *
 * What each row has ticked is held here rather than in the row, so the keys can reach it.
 *
 * **The list holds still** (§5f "A list that holds still"): it is made once a visit, on the server,
 * and paged from. A decided row stays where it was as one line saying what was done; faces another
 * decision settled stay in their rows, done; each row is drawn once, finished, after its faces are
 * scored. Nothing is fetched again or re-sorted until somebody asks with "Refresh list".
 */
export const FaceReviewSheet: React.FC<{
    tab: FaceReviewTab;
    /** Matches for one performer only: theirs, from Review's link or their Organise page. */
    performer: string | null;
    /** Widens a narrowed list to everyone; without it, the list stays theirs and says nothing. */
    onClearPerformer?: () => void;
    /** Narrows Matches to one performer: "More for ‹name›" once one of theirs is tagged. */
    onPerformer?: (tagId: string) => void;
    /** Faces on videos, photos or both: the page's kind control, which opens on videos. */
    media: ReviewMedia;
    onMedia: (media: ReviewMedia) => void;
}> = ({ tab, performer, onClearPerformer, onPerformer, media, onMedia }) => {
    // When the list was made: a new one is a new list, and the only way the list changes.
    const [visit, setVisit] = useState(() => Date.now());
    const review = useFaceReview(tab, performer, media, visit);
    const decide = useDecideFaceReview();
    // Kept for the visit, so opening an item and coming back finds the ticks as they were.
    const [excluded, setExcluded] = useState<Map<string, Set<string>>>(() =>
        loadTicks(tab, "excluded")
    );
    const [chosen, setChosen] = useState<Map<string, Set<string>>>(() => loadTicks(tab, "chosen"));
    // Faces somebody is unsure of: left undecided, asked about again later (§5f "Unsure").
    const [unsure, setUnsure] = useState<Map<string, Set<string>>>(() => loadTicks(tab, "unsure"));
    const [peek, setPeek] = useState<{ key: string; faceId: string } | null>(null);
    const [viewing, setViewing] = useState<FaceReviewFace | null>(null);

    useEffect(() => saveTicks(tab, "excluded", excluded), [tab, excluded]);
    useEffect(() => saveTicks(tab, "chosen", chosen), [tab, chosen]);
    useEffect(() => saveTicks(tab, "unsure", unsure), [tab, unsure]);
    const [pending, setPending] = useState<Map<string, FaceReviewDecision["verdict"]>>(new Map());
    const [focused, setFocused] = useState(0);
    // Only what went wrong: what went right is said in the row itself.
    const [failure, setFailure] = useState<string | null>(null);
    const [decided, setDecided] = useState<ReadonlyMap<string, Decided>>(new Map());
    const [settledBy, setSettledBy] = useState<readonly Settled[]>([]);
    const virtualizerRef = useRef<Virtualizer<Window, Element> | null>(null);
    // Rows decided with faces left unsure: those faces are asked about again, but on a later
    // visit — not straight back in the list while it is being worked through.
    const [deferred, setDeferred] = useState<ReadonlySet<string>>(() => loadDeferred(tab));

    useEffect(() => saveDeferred(tab, deferred), [tab, deferred]);

    // Put off on an earlier list of this session, not this one: a row decided here stays put.
    const [putOff, setPutOff] = useState(deferred);
    const rows = (review.data?.pages.flatMap((page) => page.rows) ?? []).filter(
        (row) => !putOff.has(keyOf(row))
    );

    // Every row's faces scored as soon as its page arrives, so it is drawn once, finished.
    const likenesses = useQueries({
        queries: rows.map((row) =>
            faceLikenessQuery(
                row.groupId,
                row.candidate?.tagId ?? null,
                row.faces.map((face) => face.id)
            )
        ),
    });
    const likenessAt = new Map(rows.map((row, index) => [keyOf(row), likenesses[index]]));

    /** The row's likeness, once asked for; undefined while it is still being scored. */
    const likenessOf = (row: FaceReviewRow): FaceLikeness | undefined =>
        likenessAt.get(keyOf(row))?.data;

    /** Whether the row can be drawn: scored, or its scoring failed (then drawn unscored). */
    const ready = (row: FaceReviewRow): boolean => {
        const query = likenessAt.get(keyOf(row));

        return !query || query.isSuccess || query.isError;
    };

    /** The row's items another decision settled since the list was made. */
    const settledOf = (row: FaceReviewRow): ReadonlySet<string> => {
        const done = new Set<string>();

        for (const rule of settledBy) {
            if (rule.groupId !== undefined && rule.groupId !== row.groupId) continue;
            if (
                rule.name !== undefined &&
                normalizeName(rule.name) !== normalizeName(row.candidate?.name ?? "")
            ) {
                continue;
            }

            for (const face of row.faces) {
                if (rule.mediaIds === "all" || rule.mediaIds.has(face.mediaId)) {
                    done.add(face.mediaId);
                }
            }
        }

        return done.size > 0 ? done : NONE;
    };

    /** The faces still to decide in a row: what its decision is about. */
    const liveFaces = (row: FaceReviewRow): FaceReviewFace[] => {
        const done = settledOf(row);

        return row.faces.filter((face) => !done.has(face.mediaId));
    };

    /** Whether a row has anything left to ask: not decided, and not settled by another. */
    const askable = (row: FaceReviewRow): boolean =>
        !decided.has(keyOf(row)) && liveFaces(row).length > 0;

    const forget = (key: string): void => {
        setExcluded((current) => {
            const next = new Map(current);
            next.delete(key);
            return next;
        });
        setChosen((current) => {
            const next = new Map(current);
            next.delete(key);
            return next;
        });
        setUnsure((current) => {
            const next = new Map(current);
            next.delete(key);
            return next;
        });
    };

    const said = (decision: FaceReviewDecision, result: FaceReviewResult): string => {
        if (decision.verdict === "skip") {
            return "Set aside. It comes back if new faces join the group.";
        }

        if (decision.verdict === "scatter") {
            return "Taken out of grouping: those faces will not be grouped or asked about again.";
        }

        if (decision.verdict === "refuse") {
            return `Those faces will not be suggested as ${result.name} again.`;
        }

        return (
            `Tagged ${items(result.tagged)} as ${result.name}` +
            (result.coined ? ", a new performer." : ".")
        );
    };

    /** What a decision settles in other rows: the items it tagged, set aside or scattered. */
    const settles = (decision: FaceReviewDecision, result: FaceReviewResult): Settled[] => {
        if (decision.verdict === "scatter") {
            return [{ groupId: decision.groupId, mediaIds: "all" }];
        }

        if (decision.verdict === "skip") {
            return [{ groupId: decision.groupId, mediaIds: new Set(decision.mediaIds) }];
        }

        if (decision.verdict === "refuse" || result.tagged === 0 || !result.name) {
            return [];
        }

        const tagged = new Set(decision.mediaIds);

        // In this group, whoever else it was asked about; and as them, in any group.
        return [
            { groupId: decision.groupId, mediaIds: tagged },
            { name: result.name, mediaIds: tagged },
        ];
    };

    const send = (row: FaceReviewRow, decision: FaceReviewDecision): void => {
        const key = keyOf(row);

        setPending((current) => new Map(current).set(key, decision.verdict));
        decide.mutate(decision, {
            onSuccess: (result) => {
                forget(key);
                setFailure(null);
                setDecided((current) =>
                    new Map(current).set(key, {
                        message: said(decision, result),
                        performer:
                            tab === "matches" &&
                            !performer &&
                            row.candidate &&
                            decision.verdict === "accept"
                                ? { tagId: row.candidate.tagId, name: row.candidate.name }
                                : null,
                    })
                );
                setSettledBy((current) => [...current, ...settles(decision, result)]);

                if ("unsureMediaIds" in decision && decision.unsureMediaIds.length > 0) {
                    setDeferred((current) => new Set(current).add(key));
                }

                // On to the next row with something to ask, if this one had the keys.
                const at = rows.findIndex((other) => keyOf(other) === key);

                if (at === focused) {
                    const next = rows.findIndex(
                        (other, index) => index > at && keyOf(other) !== key && askable(other)
                    );

                    if (next >= 0) setFocused(next);
                }
            },
            onError: (error) => setFailure(errorText(error)),
            onSettled: () =>
                setPending((current) => {
                    const next = new Map(current);
                    next.delete(key);
                    return next;
                }),
        });
    };

    const shown = (row: FaceReviewRow) => {
        const out = excludedOf(row);
        const notSure = unsureOf(row);
        const live = liveFaces(row);

        return {
            groupId: row.groupId,
            mediaIds: live
                .filter((face) => !out.has(face.mediaId) && !notSure.has(face.mediaId))
                .map((face) => face.mediaId),
            excludedMediaIds: live
                .filter((face) => out.has(face.mediaId) && !notSure.has(face.mediaId))
                .map((face) => face.mediaId),
            unsureMediaIds: live
                .filter((face) => notSure.has(face.mediaId))
                .map((face) => face.mediaId),
            // Everything on screen still to decide, ticked or not: decided as seen.
            shownFaceIds: live.map((face) => face.id),
        };
    };

    const accept = (row: FaceReviewRow): void => {
        const ticked = shown(row);

        if (row.candidate && ticked.mediaIds.length > 0) {
            send(row, { verdict: "accept", tagId: row.candidate.tagId, ...ticked });
        }
    };

    const refuse = (row: FaceReviewRow): void => {
        if (row.candidate) {
            send(row, {
                verdict: "refuse",
                groupId: row.groupId,
                tagId: row.candidate.tagId,
                shownFaceIds: liveFaces(row).map((face) => face.id),
            });
        }
    };

    const name = (row: FaceReviewRow, typed: string): void => {
        const picked = chosen.get(keyOf(row));

        if (picked && row.candidate) {
            // Someone else: the faces ticked for them, and nothing said of the rest.
            const mediaIds = liveFaces(row)
                .filter((face) => picked.has(face.mediaId))
                .map((face) => face.mediaId);

            if (mediaIds.length > 0) {
                send(row, {
                    verdict: "name",
                    groupId: row.groupId,
                    name: typed,
                    instead: row.candidate.tagId,
                    mediaIds,
                    excludedMediaIds: [],
                    unsureMediaIds: [],
                    shownFaceIds: liveFaces(row).map((face) => face.id),
                });
            }

            return;
        }

        const ticked = shown(row);

        if (ticked.mediaIds.length > 0) {
            send(row, { verdict: "name", name: typed, ...ticked });
        }
    };

    // "Can't tell", remembered on the faces shown, on either tab: a row skipped only for the visit
    // was asked about again on every one. It comes back when new faces join the group.
    const skip = (row: FaceReviewRow): void =>
        send(row, {
            verdict: "skip",
            groupId: row.groupId,
            mediaIds: liveFaces(row).map((face) => face.mediaId),
        });

    /** What a row leaves out: what somebody said is not them. */
    const excludedOf = (row: FaceReviewRow): ReadonlySet<string> =>
        excluded.get(keyOf(row)) ?? NONE;

    /** What a row sets aside: what somebody is unsure of, or until then the doubtful faces. */
    const unsureOf = (row: FaceReviewRow): ReadonlySet<string> =>
        unsure.get(keyOf(row)) ?? defaultUnsure(row.faces, likenessOf(row));

    /** What somebody has said of one face: them, not them, or unsure. */
    const stateOf = (row: FaceReviewRow, mediaId: string): TickState => {
        const key = keyOf(row);
        const picked = chosen.get(key);

        if (picked) return picked.has(mediaId) ? "in" : "out";
        if (unsureOf(row).has(mediaId)) return "unsure";

        return excludedOf(row).has(mediaId) ? "out" : "in";
    };

    /** Say one face is them, not them, or unsure. */
    const setFace = (row: FaceReviewRow, mediaId: string, state: TickState): void => {
        const key = keyOf(row);
        const put = (set: ReadonlySet<string>, on: boolean): Set<string> => {
            const next = new Set(set);
            if (on) next.add(mediaId);
            else next.delete(mediaId);
            return next;
        };

        if (chosen.has(key)) {
            setChosen((current) =>
                new Map(current).set(key, put(current.get(key) ?? NONE, state === "in"))
            );
            return;
        }

        // From what the row shows, defaults included, so the first touch keeps them.
        const startUnsure = unsureOf(row);

        setExcluded((current) =>
            new Map(current).set(key, put(current.get(key) ?? NONE, state === "out"))
        );
        setUnsure((current) =>
            new Map(current).set(key, put(current.get(key) ?? startUnsure, state === "unsure"))
        );
    };

    /** A press, or its digit: them, then not them, then unsure, then them again. */
    const toggle = (row: FaceReviewRow, mediaId: string): void =>
        setFace(row, mediaId, nextTick(stateOf(row, mediaId), !chosen.has(keyOf(row))));

    const toggleAll = (row: FaceReviewRow): void => {
        const key = keyOf(row);
        const all = liveFaces(row).map((face) => face.mediaId);

        if (chosen.has(key)) {
            setChosen((current) =>
                new Map(current).set(
                    key,
                    (current.get(key)?.size ?? 0) === all.length ? new Set() : new Set(all)
                )
            );
        } else {
            const start = excludedOf(row);

            setExcluded((current) =>
                new Map(current).set(
                    key,
                    (current.get(key) ?? start).size === 0 ? new Set(all) : new Set()
                )
            );
            // All or none is a clean slate.
            setUnsure((current) => new Map(current).set(key, new Set()));
        }
    };

    const elsewhere = (row: FaceReviewRow, open: boolean): void =>
        setChosen((current) => {
            const next = new Map(current);
            if (open) next.set(keyOf(row), new Set());
            else next.delete(keyOf(row));
            return next;
        });

    const moveFocus = (index: number): void => {
        const next = Math.max(0, Math.min(rows.length - 1, index));

        setFocused(next);
        virtualizerRef.current?.scrollToIndex(next, { align: "auto" });
    };

    const onKeyRef = useRef<(event: KeyboardEvent) => void>(() => undefined);

    onKeyRef.current = (event: KeyboardEvent) => {
        if (
            event.ctrlKey ||
            event.metaKey ||
            event.altKey ||
            isTypingTarget(event.target) ||
            rows.length === 0
        ) {
            return;
        }

        const row = rows[Math.min(focused, rows.length - 1)];
        const key = keyOf(row);
        const idle = !pending.has(key);
        // By position, not by character, so Shift with a digit is the same face, looked at.
        const digit = /^Digit\d$/.test(event.code)
            ? "1234567890".indexOf(event.code.slice(5))
            : "1234567890".indexOf(event.key);
        // The order the row shows: least like the rest first. A settled face keeps its number.
        const done = settledOf(row);
        const faces = orderFaces(row.faces, likenessOf(row)).faces.map((face) =>
            done.has(face.mediaId) ? undefined : face
        );

        if (event.key === "j") {
            moveFocus(focused + 1);
        } else if (event.key === "k") {
            moveFocus(focused - 1);
        } else if (!askable(row) || !ready(row)) {
            return;
        } else if (digit >= 0 && faces[digit] && event.shiftKey) {
            const faceId = faces[digit]!.id;

            setPeek((current) =>
                current?.key === key && current.faceId === faceId ? null : { key, faceId }
            );
        } else if (digit >= 0 && faces[digit]) {
            toggle(row, faces[digit].mediaId);
        } else if (event.key === "x") {
            toggleAll(row);
        } else if (event.key === "a" && idle && row.candidate && !chosen.has(key)) {
            accept(row);
        } else if (event.key === "d" && idle && row.candidate && !chosen.has(key)) {
            refuse(row);
        } else if (event.key === "s" && idle) {
            skip(row);
        } else if (event.key === "n" && idle) {
            if (row.candidate) {
                elsewhere(row, true);
            } else {
                document
                    .querySelector<HTMLInputElement>(
                        `[data-face-row="${CSS.escape(key)}"] [data-name-box] input`
                    )
                    ?.focus();
            }
        } else {
            return;
        }

        event.preventDefault();
    };

    useEffect(() => {
        const listener = (event: KeyboardEvent) => onKeyRef.current(event);

        window.addEventListener("keydown", listener);

        return () => window.removeEventListener("keydown", listener);
    }, []);

    const loadMore = useCallback(() => void review.fetchNextPage(), [review]);
    const total = review.data?.pages[0]?.total;
    const narrowed = review.data?.pages[0]?.performer ?? null;

    return (
        <Stack gap="md">
            <ReviewKindFilter
                value={media}
                onChange={onMedia}
                counts={review.data?.pages[0]?.byMedia}
            />

            {performer && onClearPerformer && (
                <Group gap="xs">
                    <Badge
                        size="lg"
                        variant="light"
                        color="brass"
                        style={{ textTransform: "none" }}
                    >
                        Only {narrowed?.name ?? "one performer"}
                    </Badge>
                    <Button
                        variant="subtle"
                        color="gray"
                        size="compact-sm"
                        onClick={onClearPerformer}
                    >
                        Show everyone
                    </Button>
                </Group>
            )}

            <Group gap="sm" wrap="nowrap" align="flex-start">
                <Text size="sm" c="dimmed" style={{ flex: 1 }}>
                    {INTRO[tab]}
                    {total !== undefined && total > 0 && ` ${total.toLocaleString()} in all.`}
                </Text>
                {decided.size > 0 && (
                    <Button
                        variant="subtle"
                        color="gray"
                        size="compact-sm"
                        onClick={() => {
                            setDecided(new Map());
                            setSettledBy([]);
                            setPutOff(deferred);
                            setFocused(0);
                            setVisit(Date.now());
                        }}
                        title="Make the list again: what was decided goes, and what is new comes in"
                    >
                        Refresh list
                    </Button>
                )}
                <Popover position="bottom-end" withArrow>
                    <Popover.Target>
                        <ActionIcon
                            variant="subtle"
                            color="gray"
                            aria-label="Keyboard shortcuts"
                            visibleFrom="sm"
                        >
                            ?
                        </ActionIcon>
                    </Popover.Target>
                    <Popover.Dropdown>
                        <Text size="xs">{KEYS[tab]}</Text>
                    </Popover.Dropdown>
                </Popover>
            </Group>

            {/* Over the page, not in it: a message above the list moved every row under it. */}
            {failure && (
                <Affix position={{ bottom: 16, left: 16, right: 16 }} zIndex={300}>
                    <Alert
                        color="oxblood"
                        variant="filled"
                        withCloseButton
                        onClose={() => setFailure(null)}
                        maw={560}
                        mx="auto"
                    >
                        {failure}
                    </Alert>
                </Affix>
            )}

            {review.isPending ? (
                <Loader size="sm" />
            ) : review.isError ? (
                <Alert color="oxblood" variant="light">
                    {errorText(review.error)}
                </Alert>
            ) : rows.length === 0 ? (
                <Text c="dimmed" size="sm">
                    {EMPTY[tab]}
                </Text>
            ) : (
                <VirtualFeed
                    items={rows}
                    keyOf={keyOf}
                    estimate={PLACEHOLDER + 40}
                    hasMore={review.hasNextPage}
                    loadingMore={review.isFetchingNextPage}
                    onLoadMore={loadMore}
                    virtualizerRef={virtualizerRef}
                    render={(row, index) => {
                        const key = keyOf(row);
                        const done = decided.get(key);

                        if (done) {
                            return <DecidedRow decided={done} onPerformer={onPerformer} />;
                        }

                        if (!ready(row)) {
                            return <Skeleton height={PLACEHOLDER} radius="md" mb="sm" />;
                        }

                        if (!askable(row)) {
                            return (
                                <Paper withBorder radius="md" px="sm" py={8} mb="sm">
                                    <Text size="sm" c="dimmed">
                                        ✓ Settled by an earlier decision.
                                    </Text>
                                </Paper>
                            );
                        }

                        return (
                            <div data-face-row={key}>
                                <FaceReviewRowView
                                    row={row}
                                    likeness={likenessOf(row)}
                                    settled={settledOf(row)}
                                    focused={index === focused}
                                    onFocus={() => setFocused(index)}
                                    excluded={excluded.get(keyOf(row)) ?? new Set()}
                                    unsure={unsure.get(keyOf(row)) ?? null}
                                    chosen={chosen.get(keyOf(row)) ?? null}
                                    onSet={(mediaId, state) => setFace(row, mediaId, state)}
                                    onElsewhere={(open) => elsewhere(row, open)}
                                    pending={pending.get(keyOf(row)) ?? null}
                                    onAccept={() => accept(row)}
                                    onRefuse={() => refuse(row)}
                                    onName={(typed) => name(row, typed)}
                                    onSkip={() => skip(row)}
                                    onScatter={() =>
                                        send(row, { verdict: "scatter", groupId: row.groupId })
                                    }
                                    peeking={peek?.key === keyOf(row) ? peek.faceId : null}
                                    onPeek={(faceId) =>
                                        setPeek(faceId ? { key: keyOf(row), faceId } : null)
                                    }
                                    onPlay={setViewing}
                                />
                            </div>
                        );
                    }}
                />
            )}

            <FaceViewDrawer face={viewing} onClose={() => setViewing(null)} />
        </Stack>
    );
};
