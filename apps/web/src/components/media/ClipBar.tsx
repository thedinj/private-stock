"use client";

import { useEffect, useRef, useState } from "react";
import { Autocomplete, Box, Button, Group, Paper, Select, Stack, Text } from "@mantine/core";

import {
    MIN_CLIP_MS,
    allowsPrivate,
    clipTagKinds,
    spanRunMs,
    type CreateClipInput,
} from "@private-stock/core";

import { KeyTip, ViewerKeyTip } from "@/components/KeyTip";
import { roomKey } from "@/lib/activeDomain";
import { useClipLabels, useOwnReels } from "@/lib/api/reels";
import { destinationsFor, type TagDestination } from "@/lib/tagDestinations";
import { DestinationControl } from "@/components/tags/DestinationControl";
import { ItemTagChip } from "@/components/tags/ItemTagChip";
import { TagNameInput } from "@/components/tags/TagNameInput";

/**
 * The bar that appears while a span is being marked (§14d).
 *
 * The player owns the *selection*, which is a fact about playback; this owns the *save*, which
 * is a row about the item. That is the same split `onCapture` already uses, and it is what keeps
 * the player from knowing what a clip is.
 *
 * Present only while there is a selection. A permanent bar with nothing in it would take a row
 * of vertical space from the one screen that has least to spare, to say nothing.
 *
 * Tags go on as the clip is saved (§14d "Tagging clips"), so marking "Mia jumping" is one gesture
 * rather than a save and then an edit. They are held here until then, and start empty for every
 * new span: carried over from the last one, they would be wrong as often as right and silently so.
 */

const DESTINATIONS = destinationsFor(clipTagKinds);

type PendingTag = NonNullable<CreateClipInput["tags"]>[number];

const sameTag = (a: PendingTag, b: PendingTag): boolean =>
    a.kind === b.kind && a.scope === b.scope && a.name.toLowerCase() === b.name.toLowerCase();

const SPEEDS = [
    { value: "", label: "Normal speed" },
    { value: "0.25", label: "0.25× — very slow" },
    { value: "0.5", label: "0.5× — slow" },
    { value: "2", label: "2× — fast" },
    { value: "4", label: "4× — very fast" },
];

const REEL_TARGET_KEY = "ps:clipReelTarget";

/**
 * The reel new clips go into, remembered in this browser per room. A convenience rather than a
 * record -- losing it costs one pick -- so it is storage and not a setting, and it reads as
 * nothing when storage is unavailable.
 */
const useReelTarget = (): [string | null, (next: string | null) => void] => {
    const [value, setValue] = useState<string | null>(() => {
        try {
            return window.localStorage.getItem(roomKey(REEL_TARGET_KEY));
        } catch {
            return null;
        }
    });

    const set = (next: string | null) => {
        setValue(next);
        try {
            if (next) window.localStorage.setItem(roomKey(REEL_TARGET_KEY), next);
            else window.localStorage.removeItem(roomKey(REEL_TARGET_KEY));
        } catch {
            // Storage refused: the pick lasts as long as the bar does.
        }
    };

    return [value, set];
};

const formatTime = (ms: number): string => {
    const total = Math.max(0, Math.round(ms / 1000));
    const minutes = Math.floor(total / 60);

    return `${minutes}:${String(total % 60).padStart(2, "0")}`;
};

interface ClipBarProps {
    selection: { startMs: number; endMs: number | null };
    onSave: (input: {
        startMs: number;
        endMs: number;
        label: string | null;
        speed: number | null;
        tags: PendingTag[];
        reelId: string | null;
    }) => void;
    onClear: () => void;
    onPlay: (span: { startMs: number; endMs: number; speed: number | null }) => void;
    saving?: boolean;
}

export const ClipBar: React.FC<ClipBarProps> = ({
    selection,
    onSave,
    onClear,
    onPlay,
    saving = false,
}) => {
    const [label, setLabel] = useState("");
    const [speed, setSpeed] = useState<string | null>("");
    const [destination, setDestination] = useState<TagDestination>(DESTINATIONS[0]);
    const [tags, setTags] = useState<PendingTag[]>([]);
    const labels = useClipLabels();
    const reels = useOwnReels();
    const [reelTarget, setReelTarget] = useReelTarget();
    // A remembered reel that has since been deleted, or belongs to another room, is no target.
    const target = reels.data?.items.some((reel) => reel.id === reelTarget) ? reelTarget : null;

    const addTag = (name: string) => {
        const tag = { ...destination, kind: destination.kind as PendingTag["kind"], name };

        setTags((current) =>
            current.some((other) => sameTag(other, tag)) ? current : [...current, tag]
        );
    };

    const { startMs, endMs } = selection;
    const complete = endMs !== null && endMs - startMs >= MIN_CLIP_MS;
    const chosenSpeed = speed ? Number(speed) : null;

    const save = () => {
        if (!complete || saving) return;

        onSave({
            startMs: Math.round(startMs),
            endMs: Math.round(endMs),
            label: label.trim() === "" ? null : label.trim(),
            speed: chosenSpeed,
            tags,
            reelId: target,
        });
    };

    /**
     * Marking without the mouse (§14d "Reviewing recordings for a reel").
     *
     * When `]` closes a span the tag box takes the keys: type a tag, Enter to add it, and Enter
     * again on the empty box saves the clip. Escape on a half-typed tag clears it (leaving
     * would add it -- the box accepts what was typed when it loses focus); Escape on the empty
     * box hands the keys back to the player without losing the span, so the out point can still
     * be nudged with `]`, and one more Escape drops the span (the page's, = Clear). Shift+Tab
     * reaches the facet switch beside the box, whose arrows choose Players or Keywords, and Tab
     * comes back.
     *
     * An effect on the out point, because that is the moment: a new `]` after the first moves
     * focus back here too. Nothing else in the bar takes focus on its own.
     */
    const tagsBox = useRef<HTMLDivElement>(null);
    const [typed, setTyped] = useState("");
    const ready = complete ? endMs : null;

    useEffect(() => {
        if (ready === null) return;
        tagsBox.current?.querySelector<HTMLInputElement>("input")?.focus();
    }, [ready]);

    const onTagKeys = (event: React.KeyboardEvent<HTMLDivElement>) => {
        const input = event.target;

        if (!(input instanceof HTMLInputElement)) return;

        if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            if (typed !== "") setTyped("");
            else input.blur();
            return;
        }

        if (event.key === "Enter" && input.value.trim() === "") {
            event.preventDefault();
            event.stopPropagation();
            save();
        }
    };

    return (
        <Paper withBorder p="xs" radius="sm">
            <Stack gap="xs">
                <Group gap="sm" wrap="wrap" align="flex-end">
                    <div>
                        <Text size="xs" c="dimmed">
                            In
                        </Text>
                        <Text size="sm" fw={600}>
                            {formatTime(startMs)}
                        </Text>
                    </div>
                    <div>
                        <Text size="xs" c="dimmed">
                            Out
                        </Text>
                        <Text size="sm" fw={600}>
                            {endMs === null ? "press ]" : formatTime(endMs)}
                        </Text>
                    </div>

                    {/*
                     * Both numbers, whenever they differ.
                     *
                     * A span's length and the time it takes to watch are the same until somebody
                     * chooses a speed, and then they are not — twelve seconds at half speed is
                     * twenty-four seconds of a reel. Showing only one of them would make the reel's
                     * running time look wrong later.
                     */}
                    {complete && (
                        <div>
                            <Text size="xs" c="dimmed">
                                Length
                            </Text>
                            <Text size="sm" fw={600}>
                                {formatTime(endMs - startMs)}
                                {chosenSpeed !== null &&
                                    ` · ${formatTime(spanRunMs({ startMs, endMs, speed: chosenSpeed }))} to watch`}
                            </Text>
                        </div>
                    )}

                    {/*
                     * Suggestions from this person's own past labels, so a clip's name is offered
                     * rather than retyped. The name is a title; what the browser filters on is tags.
                     */}
                    <Autocomplete
                        label="Name"
                        placeholder="optional"
                        value={label}
                        onChange={setLabel}
                        data={labels.data?.labels ?? []}
                        w={200}
                    />

                    {/* Where a pass is filling (§14d "Reviewing recordings for a reel"): kept
                        between clips and visits, per room, so it is chosen once per pass. */}
                    <Select
                        label="Into reel"
                        placeholder="None"
                        data={(reels.data?.items ?? []).map((reel) => ({
                            value: reel.id,
                            label: reel.name,
                        }))}
                        value={target}
                        onChange={setReelTarget}
                        clearable
                        searchable
                        w={200}
                    />

                    {/* Defaults to "Normal speed", which stores NULL rather than a 1.0 nobody chose. */}
                    <Select
                        label="Speed"
                        data={SPEEDS}
                        value={speed}
                        onChange={setSpeed}
                        allowDeselect={false}
                        w={190}
                    />

                    <Button
                        variant="default"
                        disabled={!complete}
                        // With the speed that is currently chosen, not at 1x: the control is right
                        // there, and a preview that ignored it would be a preview of a different clip.
                        onClick={() => complete && onPlay({ startMs, endMs, speed: chosenSpeed })}
                    >
                        Preview
                    </Button>
                    <ViewerKeyTip action="saveClip" label="Save, from the empty tag box">
                        <Button disabled={!complete || saving} loading={saving} onClick={save}>
                            Save clip
                        </Button>
                    </ViewerKeyTip>
                    <KeyTip label="Drop this clip, with no field focused" keys={["Esc"]}>
                        <Button variant="subtle" color="gray" onClick={onClear}>
                            Clear
                        </Button>
                    </KeyTip>
                </Group>

                {/* Tags, under the controls rather than among them: a box and a switch in the row
                above pushed Save off the end of a phone's width. */}
                <Group gap="sm" wrap="wrap" align="flex-start">
                    <Box w={260} maw="100%">
                        <DestinationControl
                            size="xs"
                            options={DESTINATIONS}
                            value={destination}
                            onChange={setDestination}
                        />
                    </Box>
                    <Box ref={tagsBox} onKeyDownCapture={onTagKeys}>
                        <TagNameInput
                            kind={destination.kind}
                            scope={destination.scope}
                            value={[]}
                            exclude={tags
                                .filter(
                                    (tag) =>
                                        tag.kind === destination.kind &&
                                        tag.scope === destination.scope
                                )
                                .map((tag) => tag.name)}
                            placeholder={
                                complete
                                    ? "Tags, Enter — then Enter again to save"
                                    : "Tags — type and press Enter"
                            }
                            searchValue={typed}
                            onSearchChange={setTyped}
                            onChange={(next) => next.forEach(addTag)}
                            w={260}
                            maw="100%"
                        />
                    </Box>
                    {tags.length > 0 && (
                        <Group gap={6} wrap="wrap">
                            {tags.map((tag) => (
                                <ItemTagChip
                                    key={`${tag.scope}:${tag.kind}:${tag.name}`}
                                    chip={{
                                        name:
                                            allowsPrivate(tag.kind) && tag.scope === "private"
                                                ? `${tag.name} (private)`
                                                : tag.name,
                                        pending: false,
                                    }}
                                    onRemove={() =>
                                        setTags((current) =>
                                            current.filter((other) => !sameTag(other, tag))
                                        )
                                    }
                                />
                            ))}
                        </Group>
                    )}
                </Group>
                {allowsPrivate(destination.kind) && (
                    <Text size="xs" c="dimmed">
                        Clip tags are only visible to you. Shared means the library&rsquo;s word;
                        private means your own.
                    </Text>
                )}
            </Stack>
        </Paper>
    );
};
