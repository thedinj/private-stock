"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
    ActionIcon,
    Alert,
    Badge,
    Button,
    Group,
    Loader,
    Popover,
    Stack,
    Text,
} from "@mantine/core";
import { useQueryClient, type InfiniteData } from "@tanstack/react-query";
import type { Virtualizer } from "@tanstack/react-virtual";

import type {
    FaceLikeness,
    FaceReviewDecision,
    FaceReviewFace,
    FaceReviewPage,
    FaceReviewResult,
    FaceReviewRow,
    FaceReviewTab,
    ReviewMedia,
} from "@private-stock/core";

import { VirtualFeed } from "@/components/ocr/VirtualFeed";
import { ReviewKindFilter } from "@/components/review/ReviewKindFilter";
import { useDecideFaceReview, useFaceReview } from "@/lib/api/faces";
import { queryKeys } from "@/lib/api/queryKeys";
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
 * One tab of Review › Faces (§5f "One review, two sources"), a page at a time and drawn only near
 * the screen, as OCR's queue is, with the same keys.
 *
 * What each row has ticked is held here rather than in the row, so the keys can reach it. A
 * decided row leaves at once and the list is fetched behind it: tagging one group's items moves
 * the counts of others. After a decision on Matches, that performer's other rows come first — the
 * face just compared is the one in mind.
 */
export const FaceReviewSheet: React.FC<{
    tab: FaceReviewTab;
    /** Matches for one performer only: theirs, from Review's link or their Organise page. */
    performer: string | null;
    /** Widens a narrowed list to everyone; without it, the list stays theirs and says nothing. */
    onClearPerformer?: () => void;
    /** Faces on videos, photos or both: the page's kind control, which opens on videos. */
    media: ReviewMedia;
    onMedia: (media: ReviewMedia) => void;
}> = ({ tab, performer, onClearPerformer, media, onMedia }) => {
    const queryClient = useQueryClient();
    const [prefer, setPrefer] = useState<string | null>(null);
    const review = useFaceReview(tab, performer, prefer, media);
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
    const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null);
    const virtualizerRef = useRef<Virtualizer<Window, Element> | null>(null);
    // Rows decided with faces left unsure: those faces are asked about again, but on a later
    // visit — not straight back in the list while it is being worked through.
    const [deferred, setDeferred] = useState<ReadonlySet<string>>(() => loadDeferred(tab));

    useEffect(() => saveDeferred(tab, deferred), [tab, deferred]);

    const rows = (review.data?.pages.flatMap((page) => page.rows) ?? []).filter(
        (row) => !deferred.has(keyOf(row))
    );

    const remove = (key: string): void => {
        queryClient.setQueryData<InfiniteData<FaceReviewPage>>(
            queryKeys.tags.faceReview(tab, performer, prefer, media),
            (data) =>
                data && {
                    ...data,
                    pages: data.pages.map((page) => ({
                        ...page,
                        rows: page.rows.filter((row) => keyOf(row) !== key),
                    })),
                }
        );
    };

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

    const send = (row: FaceReviewRow, decision: FaceReviewDecision): void => {
        const key = keyOf(row);

        setPending((current) => new Map(current).set(key, decision.verdict));
        decide.mutate(decision, {
            onSuccess: (result) => {
                remove(key);
                forget(key);
                setOutcome({ ok: true, message: said(decision, result) });

                if ("unsureMediaIds" in decision && decision.unsureMediaIds.length > 0) {
                    setDeferred((current) => new Set(current).add(key));
                }

                // Their other rows next, while their face is in mind.
                if (tab === "matches" && row.candidate && decision.verdict !== "skip") {
                    setPrefer(row.candidate.tagId);
                }
            },
            onError: (error) => setOutcome({ ok: false, message: errorText(error) }),
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

        return {
            groupId: row.groupId,
            mediaIds: row.faces
                .filter((face) => !out.has(face.mediaId) && !notSure.has(face.mediaId))
                .map((face) => face.mediaId),
            excludedMediaIds: row.faces
                .filter((face) => out.has(face.mediaId) && !notSure.has(face.mediaId))
                .map((face) => face.mediaId),
            unsureMediaIds: row.faces
                .filter((face) => notSure.has(face.mediaId))
                .map((face) => face.mediaId),
            // Everything on screen, ticked or not: decided as seen, not inferred.
            shownFaceIds: row.faces.map((face) => face.id),
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
                shownFaceIds: row.faces.map((face) => face.id),
            });
        }
    };

    const name = (row: FaceReviewRow, typed: string): void => {
        const picked = chosen.get(keyOf(row));

        if (picked && row.candidate) {
            // Someone else: the faces ticked for them, and nothing said of the rest.
            const mediaIds = row.faces
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
                    shownFaceIds: row.faces.map((face) => face.id),
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
            mediaIds: row.faces.map((face) => face.mediaId),
        });

    /** The row's likeness, as its own query fetched it. */
    const likenessOf = (row: FaceReviewRow): FaceLikeness | undefined =>
        queryClient.getQueryData<FaceLikeness>(
            queryKeys.tags.faceLikeness(
                row.groupId,
                row.candidate?.tagId ?? null,
                row.faces.map((face) => face.id).join(",")
            )
        );

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
        const all = row.faces.map((face) => face.mediaId);

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
        // The order the row shows: least like the rest first, once that is known.
        const faces = orderFaces(row.faces, likenessOf(row)).faces;

        if (event.key === "j") {
            moveFocus(focused + 1);
        } else if (event.key === "k") {
            moveFocus(focused - 1);
        } else if (digit >= 0 && faces[digit] && event.shiftKey) {
            const faceId = faces[digit].id;

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

            {outcome && (
                <Alert
                    color={outcome.ok ? "brass" : "oxblood"}
                    variant="light"
                    withCloseButton
                    onClose={() => setOutcome(null)}
                >
                    {outcome.message}
                </Alert>
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
                    estimate={260}
                    hasMore={review.hasNextPage}
                    loadingMore={review.isFetchingNextPage}
                    onLoadMore={loadMore}
                    virtualizerRef={virtualizerRef}
                    render={(row, index) => (
                        <div data-face-row={keyOf(row)}>
                            <FaceReviewRowView
                                row={row}
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
                    )}
                />
            )}

            <FaceViewDrawer face={viewing} onClose={() => setViewing(null)} />
        </Stack>
    );
};
