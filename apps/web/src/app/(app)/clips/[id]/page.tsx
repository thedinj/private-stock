"use client";

import { use, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ActionIcon, Anchor, Box, Group, Rating, Stack, Switch, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";

import type { LibraryClipRun, ReelEntry } from "@private-stock/core";

import { LoadFailed } from "@/components/LoadFailed";
import { CLIP_TAG_FIELDS, ClipTagFields } from "@/components/media/ClipTagFields";
import { ReelPlayer } from "@/components/reel/ReelPlayer";
import { PageLoader } from "@/components/shell/PageLoader";
import { PagePlate } from "@/components/shell/PagePlate";
import { api } from "@/lib/api/client";
import { useLibraryClipRun } from "@/lib/api/libraryTabs";
import { queryKeys } from "@/lib/api/queryKeys";
import { useMarkClips } from "@/lib/api/reels";
import { parseView } from "@/lib/libraryQuery";
import { usePlaybackPref } from "@/lib/playbackPrefs";
import { readReturn, rememberReturn, returnLabel } from "@/lib/returnTo";
import { formatTimecode } from "@/lib/timecode";
import { isTypingTarget } from "@/lib/typingTarget";
import { fieldForPress, keyPress } from "@/lib/viewerKeys";

/**
 * A clip, on a page of its own (§14e "Playing the small kinds").
 *
 * It was a modal over the grid, which is where its two faults came from: fullscreen fills the
 * window by laying the player over the page (`usePlayerFullscreen`), and inside a dialog that is
 * transformed and clipped it could only fill the dialog; and a dialog on a phone is a cramped
 * page that Back does not leave cleanly.
 *
 * **Not the item page.** `/media/:id` is a page about a file -- its progress, review, casting,
 * captures, the walk through a set by ids -- and nearly all of it would need a "but not for a
 * clip" (a span must not record watching it). This page is what a clip has: the reel player over
 * the run its address describes, starting here, and the clip's own marks and tags under it.
 *
 * **The run is frozen on arrival.** Rating a clip while sorted by rating, or tagging one out of
 * the filter, refetches the run; the order played is the one the page opened with, and only each
 * clip's own fields are taken from the fresh answer.
 */

const ClipPage: React.FC<{ params: Promise<{ id: string }> }> = ({ params }) => {
    const { id } = use(params);
    const search = useSearchParams();
    const [query] = useState(() => search.toString());
    const view = useMemo(() => {
        const parsed = parseView(new URLSearchParams(query));

        return { ...parsed, kind: "clip" as const, page: 0 };
    }, [query]);
    const fromTop = new URLSearchParams(query).get("run") === "1";

    // Read once, as the item page does: where this tab came from must not change under it.
    const [returnTo] = useState<string | null>(() =>
        typeof window === "undefined" ? null : readReturn()
    );
    const back = {
        href: returnTo ?? "/?view=grid&kind=clip",
        label: returnTo ? `Back to ${returnLabel(returnTo)}` : "Clips",
    };

    const run = useLibraryClipRun(view, true);
    const inRun = run.data?.items.some((entry) => entry.id === id) ?? false;
    const alone = useQuery({
        queryKey: queryKeys.clips.play(id),
        queryFn: () => api<LibraryClipRun>(`/api/clips/${encodeURIComponent(id)}/play`),
        enabled: run.isSuccess && !inRun,
    });

    const [frozen, setFrozen] = useState<{ ids: string[]; alone: boolean; more: boolean } | null>(
        null
    );

    useEffect(() => {
        if (frozen) return;

        if (run.data && inRun) {
            setFrozen({
                ids: run.data.items.map((entry) => entry.id),
                alone: false,
                more: run.data.more,
            });
        } else if (alone.data) {
            setFrozen({ ids: alone.data.items.map((entry) => entry.id), alone: true, more: false });
        }
    }, [frozen, run.data, inRun, alone.data]);

    /** Every entry seen, by id, so one filtered out by an edit keeps its place in the run. */
    const known = useRef(new Map<string, ReelEntry>());

    for (const entry of [...(run.data?.items ?? []), ...(alone.data?.items ?? [])]) {
        known.current.set(entry.id, entry);
    }

    const entries = useMemo(
        () =>
            (frozen?.ids ?? []).flatMap((entryId) => {
                const entry = known.current.get(entryId);

                return entry ? [entry] : [];
            }),
        // `known` is refreshed by every answer; the answers are what change.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [frozen, run.data, alone.data]
    );

    const [currentId, setCurrentId] = useState(id);
    const current = entries.find((entry) => entry.id === currentId) ?? entries[0];

    const [autoplayNext, setAutoplayNext] = usePlaybackPref("autoplayNext");
    // Play from the top is asking for the run, whatever the switch says for one clip opened.
    const [rollOn, setRollOn] = useState(fromTop || autoplayNext);
    /**
     * Held while a tag box has the keys: rolling on mid-word would remount the boxes for the
     * next clip, losing the half-typed name or filing it under a clip you were no longer
     * looking at.
     */
    const [typing, setTyping] = useState(false);

    /**
     * The address follows the clip on screen, so a reload or a shared link lands on it. Replaced
     * rather than pushed: Back leaves the page, as it leaves the item viewer (§14b).
     */
    const follow = (entry: ReelEntry) => {
        setCurrentId(entry.id);
        window.history.replaceState(
            window.history.state,
            "",
            `/clips/${encodeURIComponent(entry.id)}?${query}`
        );
    };

    /** w, t and Shift+T into the tag boxes, as on the item page. */
    const mine = current?.clip.mine ?? false;

    useEffect(() => {
        if (!mine) return;

        const onKeyDown = (event: KeyboardEvent) => {
            if (isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) {
                return;
            }

            const field = fieldForPress(keyPress(event));

            if (!field || !CLIP_TAG_FIELDS.includes(field)) return;

            event.preventDefault();
            if (!event.repeat) {
                document.querySelector<HTMLElement>(`[data-clip-field="${field}"]`)?.focus();
            }
        };

        document.addEventListener("keydown", onKeyDown);

        return () => document.removeEventListener("keydown", onKeyDown);
    }, [mine]);

    const marks = useMarkClips();

    const failed = run.isError ? run.error : alone.isError ? alone.error : null;

    if (failed) {
        return (
            <Stack gap="lg">
                <PagePlate eyebrow="Clip" title="This clip" back={back} />
                <LoadFailed
                    error={failed}
                    what="this clip"
                    onRetry={() => {
                        void run.refetch();
                        void alone.refetch();
                    }}
                />
            </Stack>
        );
    }

    if (!frozen || !current) {
        return (
            <Stack gap="lg">
                <PagePlate eyebrow="Clip" title="…" back={back} />
                <PageLoader />
            </Stack>
        );
    }

    const clip = current.clip;

    return (
        <Stack gap="md">
            <PagePlate
                eyebrow={
                    frozen.alone
                        ? "Your clip"
                        : `Your clips${frozen.more ? ` · the first ${frozen.ids.length}` : ""}`
                }
                title={clip.label ?? clip.mediaTitle}
                back={back}
            />

            <ReelPlayer
                entries={entries}
                runningMs={entries.reduce((sum, entry) => sum + entry.clip.runMs, 0)}
                startId={id}
                onCurrent={follow}
                rollOn={rollOn && !typing}
                controls={
                    <Switch
                        size="xs"
                        label="Autoplay next"
                        checked={rollOn}
                        onChange={(event) => {
                            const on = event.currentTarget.checked;

                            setRollOn(on);
                            if (on !== autoplayNext) setAutoplayNext(on);
                        }}
                    />
                }
            />

            <Group justify="space-between" wrap="wrap" gap="xs">
                <Text size="sm" c="dimmed" style={{ minWidth: 0 }}>
                    {formatTimecode(clip.startMs)}–{formatTimecode(clip.endMs)} of{" "}
                    <Anchor
                        component={Link}
                        href={`/media/${clip.mediaId}?at=${clip.startMs}`}
                        size="sm"
                        onClick={rememberReturn}
                    >
                        {clip.mediaTitle}
                    </Anchor>
                </Text>

                {/* Your judgement of the span (§14d "Clips in the library"). The same number
                    again clears it. */}
                {clip.mine && (
                    <Group gap="xs" wrap="nowrap">
                        <Rating
                            color="brass"
                            value={clip.rating ?? 0}
                            onChange={(value) =>
                                marks.mutate({
                                    clipIds: [clip.id],
                                    rating: value === clip.rating ? null : value,
                                })
                            }
                            aria-label="Rate this clip"
                        />
                        <ActionIcon
                            variant="subtle"
                            color={clip.favorite ? "oxblood" : "gray"}
                            onClick={() =>
                                marks.mutate({ clipIds: [clip.id], favorite: !clip.favorite })
                            }
                            aria-label={
                                clip.favorite ? "Remove from favourites" : "Add to favourites"
                            }
                            size="lg"
                        >
                            {clip.favorite ? "♥" : "♡"}
                        </ActionIcon>
                    </Group>
                )}
            </Group>

            {/* Keyed by clip, so a half-typed name does not carry over to the next one. */}
            {clip.mine && (
                <Box onFocus={() => setTyping(true)} onBlur={() => setTyping(false)}>
                    <ClipTagFields key={clip.id} clip={clip} />
                </Box>
            )}
        </Stack>
    );
};

export default ClipPage;
