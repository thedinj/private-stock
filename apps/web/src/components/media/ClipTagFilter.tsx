"use client";

import { useState } from "react";
import {
    Button,
    Chip,
    Drawer,
    Group,
    Loader,
    Popover,
    ScrollArea,
    SegmentedControl,
    Stack,
    Text,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";

import type { ClipTagFacetValue, TagMatch } from "@private-stock/core";

import { useClipTagFacets } from "@/lib/api/reels";
import type { ChipState } from "@/lib/tagLogic";
import { TriChip } from "@/components/library/TriChip";

/**
 * The clip browser's two tag fields: what the **video** carries, and what the **clip** carries
 * (§14d "Tagging clips").
 *
 * Two fields because they are two facts. "Video has: pool" and "Clip has: jumping" is the pool reel;
 * one box mixing them would find every clip of a pool video where somebody jumped anywhere.
 *
 * Each field behaves like a facet in the library's filter panel -- the same three-state chips, the
 * same "all of / any of" once two are picked -- so nothing here is a new thing to learn. The one
 * addition is per chip, on the clip side: **"or its video"**, for a tag that may be on the span or
 * on the whole video. Strict is the default because a two-hour video tagged "Mia" says nothing
 * about which of its spans she is in.
 *
 * Behind one toolbar button rather than on the page, because the toolbar holds its height (see the
 * page) and two chip lists do not fit in one line.
 */

export interface ClipTagFilterValue {
    videoTags: string[];
    videoNotTags: string[];
    videoMatch: TagMatch;
    clipTags: string[];
    clipNotTags: string[];
    clipMatch: TagMatch;
    orVideo: string[];
}

interface ClipTagFilterProps {
    value: ClipTagFilterValue;
    onChange: (patch: Partial<ClipTagFilterValue>) => void;
}

const NEXT: Record<ChipState, ChipState> = { off: "with", with: "without", without: "off" };

const stateOf = (tagId: string, withIds: string[], withoutIds: string[]): ChipState =>
    withIds.includes(tagId) ? "with" : withoutIds.includes(tagId) ? "without" : "off";

/** Moves one chip along its cycle, returning both lists. */
const cycle = (
    tagId: string,
    withIds: string[],
    withoutIds: string[]
): { with: string[]; without: string[] } => {
    const next = NEXT[stateOf(tagId, withIds, withoutIds)];
    const others = (ids: string[]) => ids.filter((id) => id !== tagId);

    return {
        with: next === "with" ? [...others(withIds), tagId] : others(withIds),
        without: next === "without" ? [...others(withoutIds), tagId] : others(withoutIds),
    };
};

/** How many picks are on, for the button's label. */
const activeTagPicks = (value: ClipTagFilterValue): number =>
    value.videoTags.length +
    value.videoNotTags.length +
    value.clipTags.length +
    value.clipNotTags.length;

interface FieldProps {
    title: string;
    values: ClipTagFacetValue[];
    withIds: string[];
    withoutIds: string[];
    match: TagMatch;
    onPicks: (picks: { with: string[]; without: string[] }) => void;
    onMatch: (match: TagMatch) => void;
    /** The clip side only: the per-chip "or its video". */
    orVideo?: { ids: string[]; onChange: (ids: string[]) => void };
}

const Field: React.FC<FieldProps> = ({
    title,
    values,
    withIds,
    withoutIds,
    match,
    onPicks,
    onMatch,
    orVideo,
}) => {
    // "or" on every "with" but the first, so an any-of row reads "Mia, or Sam".
    const firstWith = values.find((value) => withIds.includes(value.tagId))?.tagId;
    const active = values.filter(
        (value) => withIds.includes(value.tagId) || withoutIds.includes(value.tagId)
    );

    return (
        <Stack gap={6}>
            <Group justify="space-between" gap="xs" wrap="nowrap">
                <Text size="sm" fw={600}>
                    {title}
                </Text>
                {/* Only once there is a choice to make: with one pick, all and any are the same. */}
                {withIds.length >= 2 && (
                    <SegmentedControl
                        size="xs"
                        value={match}
                        onChange={(next) => onMatch(next as TagMatch)}
                        data={[
                            { value: "all", label: "All of" },
                            { value: "any", label: "Any of" },
                        ]}
                    />
                )}
            </Group>

            {values.length === 0 ? (
                <Text size="xs" c="dimmed">
                    Nothing tagged yet.
                </Text>
            ) : (
                <Group gap={6} wrap="wrap">
                    {values.map((value) => {
                        const state = stateOf(value.tagId, withIds, withoutIds);

                        return (
                            <TriChip
                                key={value.tagId}
                                name={value.private ? `${value.name} (private)` : value.name}
                                count={value.count}
                                state={state}
                                or={
                                    match === "any" && state === "with" && value.tagId !== firstWith
                                }
                                onCycle={() => onPicks(cycle(value.tagId, withIds, withoutIds))}
                            />
                        );
                    })}
                </Group>
            )}

            {/* Per chip that is doing something: may this tag be on the video instead? */}
            {orVideo && active.length > 0 && (
                <Stack gap={4}>
                    <Text size="xs" c="dimmed">
                        Also match when the whole video has it:
                    </Text>
                    <Group gap={6} wrap="wrap">
                        {active.map((value) => {
                            const on = orVideo.ids.includes(value.tagId);

                            return (
                                <Chip
                                    key={value.tagId}
                                    size="xs"
                                    variant="outline"
                                    color="brass"
                                    checked={on}
                                    onChange={() =>
                                        orVideo.onChange(
                                            on
                                                ? orVideo.ids.filter((id) => id !== value.tagId)
                                                : [...orVideo.ids, value.tagId]
                                        )
                                    }
                                >
                                    {value.name} or its video
                                </Chip>
                            );
                        })}
                    </Group>
                </Stack>
            )}
        </Stack>
    );
};

export const ClipTagFilter: React.FC<ClipTagFilterProps> = ({ value, onChange }) => {
    const [open, setOpen] = useState(false);
    const narrow = useMediaQuery("(max-width: 48em)") ?? false;
    const facets = useClipTagFacets();
    const picks = activeTagPicks(value);

    const body = facets.isLoading ? (
        <Group justify="center" p="md">
            <Loader size="sm" color="brass" />
        </Group>
    ) : (
        <Stack gap="md">
            <Field
                title="Video has"
                values={facets.data?.video ?? []}
                withIds={value.videoTags}
                withoutIds={value.videoNotTags}
                match={value.videoMatch}
                onPicks={(next) => onChange({ videoTags: next.with, videoNotTags: next.without })}
                onMatch={(videoMatch) => onChange({ videoMatch })}
            />
            <Field
                title="Clip has"
                values={facets.data?.clip ?? []}
                withIds={value.clipTags}
                withoutIds={value.clipNotTags}
                match={value.clipMatch}
                onPicks={(next) =>
                    onChange({
                        clipTags: next.with,
                        clipNotTags: next.without,
                        // A widening only means something on a chip that is on.
                        orVideo: value.orVideo.filter(
                            (id) => next.with.includes(id) || next.without.includes(id)
                        ),
                    })
                }
                onMatch={(clipMatch) => onChange({ clipMatch })}
                orVideo={{ ids: value.orVideo, onChange: (orVideo) => onChange({ orVideo }) }}
            />
            {picks > 0 && (
                <Group justify="flex-end">
                    <Button
                        variant="subtle"
                        color="gray"
                        size="xs"
                        onClick={() =>
                            onChange({
                                videoTags: [],
                                videoNotTags: [],
                                clipTags: [],
                                clipNotTags: [],
                                orVideo: [],
                            })
                        }
                    >
                        Clear tags
                    </Button>
                </Group>
            )}
        </Stack>
    );

    const trigger = (
        <Button
            size="sm"
            variant={picks > 0 ? "light" : "default"}
            color="brass"
            onClick={() => setOpen((current) => !current)}
        >
            {picks > 0 ? `Tags · ${picks}` : "Tags"}
        </Button>
    );

    // A drawer on a phone: a popover over a two-column chip list leaves no room to tap.
    if (narrow) {
        return (
            <>
                {trigger}
                <Drawer
                    opened={open}
                    onClose={() => setOpen(false)}
                    position="bottom"
                    size="80%"
                    title="Filter by tags"
                >
                    {body}
                </Drawer>
            </>
        );
    }

    return (
        <Popover
            opened={open}
            onChange={setOpen}
            position="bottom-start"
            width={440}
            shadow="md"
            withinPortal
        >
            <Popover.Target>{trigger}</Popover.Target>
            <Popover.Dropdown>
                <ScrollArea.Autosize mah="60vh">{body}</ScrollArea.Autosize>
            </Popover.Dropdown>
        </Popover>
    );
};
