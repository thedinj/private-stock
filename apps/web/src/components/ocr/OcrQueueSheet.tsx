import { useCallback, useEffect, useRef, useState } from "react";
import { ActionIcon, Alert, Group, Loader, Popover, Stack, Text } from "@mantine/core";
import { useQueryClient, type InfiniteData } from "@tanstack/react-query";
import type { Virtualizer } from "@tanstack/react-virtual";

import type { OcrMatchTagKind, OcrQueueItem, OcrQueuePage, ReviewMedia } from "@private-stock/core";

import {
    useAcceptOnItem,
    useManualOcrMatch,
    useOcrQueue,
    useRejectOcrMatch,
    useSkipOnItem,
} from "@/lib/api/ocr";
import { queryKeys } from "@/lib/api/queryKeys";
import { applyQueueDecision, type QueueDecision } from "@/lib/ocrReview";
import { isTypingTarget } from "@/lib/typingTarget";

import { plural } from "./OcrMatchParts";
import { OcrQueueRow, candidatesOf } from "./OcrQueueRow";
import { VirtualFeed } from "./VirtualFeed";

const errorText = (error: unknown): string =>
    error instanceof Error ? error.message : "That change could not be saved.";

const EMPTY = new Set<string>();

/** A set held per item, with one value turned on or off. */
const toggleIn = (
    map: Map<string, Set<string>>,
    mediaId: string,
    value: string,
    on: boolean
): Map<string, Set<string>> => {
    const next = new Map(map);
    const set = new Set(next.get(mediaId) ?? []);

    if (on) set.add(value);
    else set.delete(value);

    next.set(mediaId, set);

    return next;
};

/**
 * Review › OCR's queue (§5d "The queue is items"): items whose text names a performer or source
 * that no decision covers yet, most recently matched first.
 *
 * Tagging accepts the ticked names as rules: every item showing the same text is tagged now, and
 * every item it is read on later is tagged by itself (see "Tagged for you"). So the queue only
 * ever holds what is new — a newly read item, or older ones a newly added name matches.
 *
 * Each decision takes its rows off at once and then fetches the list behind them: an accept
 * reaches every item showing the text, which only the server can say exactly.
 *
 * Keys: `j`/`k` move, `a` tags, `s` leaves this item out, `d` never for this text, `o` lists the
 * other items showing the first string.
 */
export const OcrQueueSheet: React.FC<{
    /** Videos, photos or both, from the page's kind control. */
    media: ReviewMedia;
}> = ({ media }) => {
    const queryClient = useQueryClient();
    const queue = useOcrQueue(media);
    const acceptOnItem = useAcceptOnItem();
    const skipOnItem = useSkipOnItem();
    const never = useRejectOcrMatch();
    const manualMatch = useManualOcrMatch();
    const items = queue.data?.pages.flatMap((page) => page.items) ?? [];

    // Per item, because the same pair is on every item showing its text.
    const [unticked, setUnticked] = useState<Map<string, Set<string>>>(new Map());
    const [excluded, setExcluded] = useState<Map<string, Set<string>>>(new Map());
    const [open, setOpen] = useState<Map<string, string>>(new Map());
    const [busy, setBusy] = useState<Set<string>>(new Set());
    const [focused, setFocused] = useState(0);
    const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null);
    const virtualizerRef = useRef<Virtualizer<Window, Element> | null>(null);

    /** Take the decided rows off now, then fetch the list behind them. */
    const settle = (decision: QueueDecision): void => {
        queryClient.setQueryData<InfiniteData<OcrQueuePage>>(
            queryKeys.ocr.queueOf(media),
            (data) =>
                data
                    ? {
                          ...data,
                          pages: data.pages.map((page) => ({
                              ...page,
                              items: applyQueueDecision(page.items, decision),
                          })),
                      }
                    : data
        );
        void queryClient.invalidateQueries({ queryKey: queryKeys.ocr.queue() });
    };

    const markBusy = (mediaId: string, on: boolean): void =>
        setBusy((current) => {
            const next = new Set(current);
            if (on) next.add(mediaId);
            else next.delete(mediaId);
            return next;
        });

    const tickedOf = (item: OcrQueueItem) =>
        candidatesOf(item).filter(
            (candidate) => !unticked.get(item.mediaId)?.has(candidate.matchId)
        );

    const accept = (item: OcrQueueItem): void => {
        const ticked = tickedOf(item);

        if (ticked.length === 0) return;

        const left = [...(excluded.get(item.mediaId) ?? [])];
        const matchIds = ticked.map((candidate) => candidate.matchId);

        markBusy(item.mediaId, true);
        acceptOnItem.mutate(
            {
                mediaId: item.mediaId,
                matchIds,
                expectedCount: ticked.reduce((sum, candidate) => sum + candidate.untagged, 0),
                excludeMediaIds: left,
            },
            {
                onSuccess: (result) => {
                    settle({ kind: "accept", mediaId: item.mediaId, matchIds, excluded: left });
                    setOutcome({
                        ok: true,
                        message:
                            `Tagged ${plural(result.mediaIds.length, "item", "items")} as ` +
                            `${[...new Set(ticked.map((candidate) => candidate.tagName))].join(" and ")}. ` +
                            "New items showing the same text will be tagged by themselves.",
                    });
                },
                onError: (error) => setOutcome({ ok: false, message: errorText(error) }),
                onSettled: () => markBusy(item.mediaId, false),
            }
        );
    };

    const skip = (item: OcrQueueItem): void => {
        const matchIds = tickedOf(item).map((candidate) => candidate.matchId);

        if (matchIds.length === 0) return;

        markBusy(item.mediaId, true);
        skipOnItem.mutate(
            { mediaId: item.mediaId, matchIds },
            {
                onSuccess: () => settle({ kind: "skip", mediaId: item.mediaId, matchIds }),
                onError: (error) => setOutcome({ ok: false, message: errorText(error) }),
                onSettled: () => markBusy(item.mediaId, false),
            }
        );
    };

    const reject = (item: OcrQueueItem): void => {
        const ticked = tickedOf(item);

        if (ticked.length === 0) return;

        const matchIds = ticked.map((candidate) => candidate.matchId);

        markBusy(item.mediaId, true);
        never.mutate(
            { matchIds },
            {
                // Everywhere: the pairs are decided, and no item shows them as open any more.
                onSuccess: () => {
                    settle({ kind: "reject", mediaId: item.mediaId, matchIds });
                    setOutcome({
                        ok: true,
                        message: `${ticked.map((candidate) => candidate.tagName).join(" and ")} will not be suggested for this text again.`,
                    });
                },
                onError: (error) => setOutcome({ ok: false, message: errorText(error) }),
                onSettled: () => markBusy(item.mediaId, false),
            }
        );
    };

    const manual = (
        item: OcrQueueItem,
        textNorm: string,
        kind: OcrMatchTagKind,
        name: string,
        replace?: string
    ): void => {
        markBusy(item.mediaId, true);
        manualMatch.mutate(
            { textNorm, kind, name, replaceMatchId: replace },
            {
                onSuccess: () =>
                    void queryClient.invalidateQueries({ queryKey: queryKeys.ocr.queue() }),
                onError: (error) => setOutcome({ ok: false, message: errorText(error) }),
                onSettled: () => markBusy(item.mediaId, false),
            }
        );
    };

    const toggleOpen = (mediaId: string, textNorm: string): void =>
        setOpen((current) => {
            const next = new Map(current);
            if (next.get(mediaId) === textNorm) next.delete(mediaId);
            else next.set(mediaId, textNorm);
            return next;
        });

    const moveFocus = (index: number): void => {
        const next = Math.max(0, Math.min(items.length - 1, index));

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
            items.length === 0
        ) {
            return;
        }

        const item = items[Math.min(focused, items.length - 1)];
        const idle = !busy.has(item.mediaId);

        if (event.key === "j") {
            moveFocus(focused + 1);
        } else if (event.key === "k") {
            moveFocus(focused - 1);
        } else if (event.key === "a" && idle) {
            accept(item);
        } else if (event.key === "s" && idle) {
            skip(item);
        } else if (event.key === "d" && idle) {
            reject(item);
        } else if (event.key === "o" && item.strings[0]) {
            toggleOpen(item.mediaId, item.strings[0].textNorm);
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

    const loadMore = useCallback(() => void queue.fetchNextPage(), [queue]);

    return (
        <Stack gap="md">
            <Group gap="sm" wrap="nowrap" align="flex-start">
                <Text size="sm" c="dimmed" style={{ flex: 1 }}>
                    Items whose text names a performer or source you have not decided about. Tagging
                    also tags everything else showing the same text, now and as it is read.
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
                        <Text size="xs">
                            j / k move · a tag · s not on this one · d never · o the others
                        </Text>
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

            {queue.isPending ? (
                <Loader size="sm" />
            ) : queue.isError ? (
                <Alert color="oxblood" variant="light">
                    {errorText(queue.error)}
                </Alert>
            ) : items.length === 0 ? (
                <Text c="dimmed" size="sm">
                    Nothing to tag. Items appear here when OCR reads a name no rule covers yet, or
                    when a performer or source is added that older text matches.
                </Text>
            ) : (
                <VirtualFeed
                    items={items}
                    keyOf={(item) => item.mediaId}
                    estimate={220}
                    hasMore={queue.hasNextPage}
                    loadingMore={queue.isFetchingNextPage}
                    onLoadMore={loadMore}
                    virtualizerRef={virtualizerRef}
                    render={(item, index) => (
                        <OcrQueueRow
                            item={item}
                            focused={index === focused}
                            onFocus={() => setFocused(index)}
                            unticked={unticked.get(item.mediaId) ?? EMPTY}
                            onTick={(matchId, on) =>
                                setUnticked((current) =>
                                    toggleIn(current, item.mediaId, matchId, !on)
                                )
                            }
                            excluded={excluded.get(item.mediaId) ?? EMPTY}
                            onExclude={(mediaId, on) =>
                                setExcluded((current) =>
                                    toggleIn(current, item.mediaId, mediaId, on)
                                )
                            }
                            onAccept={() => accept(item)}
                            onSkip={() => skip(item)}
                            onNever={() => reject(item)}
                            onManual={(textNorm, kind, name, replace) =>
                                manual(item, textNorm, kind, name, replace)
                            }
                            busy={busy.has(item.mediaId)}
                            openString={open.get(item.mediaId) ?? null}
                            onToggleOpen={(textNorm) => toggleOpen(item.mediaId, textNorm)}
                        />
                    )}
                />
            )}
        </Stack>
    );
};
