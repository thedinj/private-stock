"use client";

import { useEffect, useState } from "react";
import { Anchor, Button, Group, Loader, ScrollArea, Stack, Text, TextInput } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/queryKeys";

/**
 * Choosing a directory for a library (§12b).
 *
 * Typed or browsed, and checked either way as you go. The check calls the same code the write
 * performs, because a form that approves a path the server then rejects is worse than no
 * check at all — it teaches people to trust it.
 */

interface BrowseEntry {
    name: string;
    path: string;
}

interface BrowseResult {
    path: string | null;
    parent: string | null;
    entries: BrowseEntry[];
}

interface InspectResult {
    ok: boolean;
    reason?: string | null;
    path?: string;
    /** Whether files there could be deleted — a `:rw` mount, not just a readable one. */
    mountWritable?: boolean;
}

interface PathPickerProps {
    value: string;
    onChange: (value: string) => void;
    /** The library being moved, so it does not collide with where it already is. */
    excludeId?: string;
    /** Lifted so the dialog's confirm button can refuse a path this component knows is bad. */
    onValidityChange: (valid: boolean) => void;
    /** Whether a valid path is mounted writable; false until one is. */
    onMountWritableChange?: (writable: boolean) => void;
}

export const PathPicker: React.FC<PathPickerProps> = ({
    value,
    onChange,
    excludeId,
    onValidityChange,
    onMountWritableChange,
}) => {
    const [browsing, setBrowsing] = useState<string | undefined>(undefined);
    const [browserOpen, setBrowserOpen] = useState(false);

    /**
     * Debounced, because this hits the filesystem.
     *
     * A stat per keystroke on a sleeping network share would make the field stutter, and the
     * answer is only interesting once someone stops typing.
     */
    const [debounced, setDebounced] = useState(value);

    useEffect(() => {
        const timer = setTimeout(() => setDebounced(value), 350);

        return () => clearTimeout(timer);
    }, [value]);

    const check = useQuery({
        queryKey: queryKeys.paths.inspect(debounced, excludeId),
        queryFn: () =>
            api<InspectResult>("/api/admin/libraries/inspect", {
                method: "POST",
                body: JSON.stringify({ path: debounced, excludeId }),
            }),
        enabled: debounced.trim().length > 0,
    });

    const listing = useQuery({
        queryKey: queryKeys.paths.browse(browsing),
        queryFn: () =>
            api<BrowseResult>(
                `/api/admin/libraries/browse${browsing ? `?path=${encodeURIComponent(browsing)}` : ""}`
            ),
        enabled: browserOpen,
    });

    const settled = debounced === value && !check.isFetching;
    const valid = settled && check.data?.ok === true;

    const mountWritable = valid && check.data?.mountWritable === true;

    useEffect(() => {
        onValidityChange(valid);
    }, [valid, onValidityChange]);

    useEffect(() => {
        onMountWritableChange?.(mountWritable);
    }, [mountWritable, onMountWritableChange]);

    return (
        <Stack gap="xs">
            <TextInput
                label="Directory"
                description="An absolute path. Checked as you type."
                placeholder="/media/videos"
                value={value}
                onChange={(event) => onChange(event.currentTarget.value)}
                rightSection={check.isFetching ? <Loader size="xs" /> : null}
                error={settled && check.data?.ok === false ? check.data.reason : null}
                data-autofocus
            />

            {valid && (
                <Text size="xs" c="teal">
                    Ready to use.
                </Text>
            )}

            <Anchor
                component="button"
                type="button"
                size="xs"
                onClick={() => {
                    // Opening at the current value saves retyping a path that is nearly right,
                    // which is the usual reason someone reaches for the browser at all.
                    setBrowsing(valid ? value : undefined);
                    setBrowserOpen((open) => !open);
                }}
            >
                {browserOpen ? "Hide browser" : "Browse for a directory"}
            </Anchor>

            {browserOpen && (
                <Stack gap={4}>
                    <Group gap="xs" wrap="nowrap">
                        <Button
                            size="compact-xs"
                            variant="default"
                            disabled={!listing.data?.path}
                            onClick={() => setBrowsing(listing.data?.parent ?? undefined)}
                        >
                            Up
                        </Button>
                        <Text size="xs" c="dimmed" style={{ wordBreak: "break-all" }}>
                            {listing.data?.path ?? "Starting points"}
                        </Text>
                    </Group>

                    <ScrollArea.Autosize mah={200} type="auto">
                        <Stack gap={2} p={4}>
                            {listing.isPending && <Loader size="xs" />}

                            {listing.data?.entries.length === 0 && (
                                <Text size="xs" c="dimmed">
                                    No subdirectories here.
                                </Text>
                            )}

                            {listing.data?.entries.map((entry) => (
                                <Group key={entry.path} gap={4} wrap="nowrap">
                                    <Anchor
                                        component="button"
                                        type="button"
                                        size="xs"
                                        onClick={() => setBrowsing(entry.path)}
                                        style={{ flex: 1, textAlign: "left" }}
                                    >
                                        {entry.name}
                                    </Anchor>
                                    {/* Descending and choosing are different acts: a
                                        directory someone wants to open is usually not the one
                                        they want to use, and conflating them makes the
                                        browser impossible to navigate. */}
                                    <Button
                                        size="compact-xs"
                                        variant="light"
                                        onClick={() => onChange(entry.path)}
                                    >
                                        Use
                                    </Button>
                                </Group>
                            ))}
                        </Stack>
                    </ScrollArea.Autosize>
                </Stack>
            )}
        </Stack>
    );
};
