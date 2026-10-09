"use client";

import { useState } from "react";
import { Alert, Button, Group, Modal, Stack, Switch, Text, TextInput } from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { ScanStatus } from "@private-stock/core";

import { PathPicker } from "@/components/PathPicker";
import { api, ApiError } from "@/lib/api/client";
import { invalidateLibraries } from "@/lib/api/libraries";

/**
 * Adding, renaming, moving and forgetting a library (§12b).
 *
 * Dialogs rather than inline editing, because each is a decision with a consequence worth
 * reading first: a path that cannot be read is rejected here rather than becoming a library
 * that silently never finds anything, and forgetting one discards tags and ratings.
 *
 * Renaming is the exception that proves the rule and is here anyway, in the smallest dialog
 * of the four. It has no consequence at all -- the name is a label and nothing keys on it --
 * but it sits beside Move in the same row, and Move hides a library's items until a rescan.
 * Two controls that differ that much in cost should not differ only in which word you
 * clicked.
 */

type Library = ScanStatus["roots"][number];

/**
 * The last segment of a path, whichever way its separators lean.
 *
 * Both, because development is on Windows and the NAS is Linux, and a path typed on one is
 * routinely pasted into the other. Trailing separators are dropped first so `/media/films/`
 * suggests "films" rather than nothing, which is what somebody who tab-completed a directory
 * will have in the box.
 */
const basename = (value: string): string => {
    const trimmed = value.trim().replace(/[\\/]+$/, "");

    return trimmed.split(/[\\/]/).pop() ?? "";
};

interface LibraryDialogsProps {
    adding: boolean;
    editing: string | null;
    /** The library being renamed, or null. Separate from `editing`, which is a move. */
    renaming: string | null;
    removing: string | null;
    pathDraft: string;
    candidates: string[];
    roots: Library[];
    onPathDraft: (value: string) => void;
    onClose: () => void;
}

export const LibraryDialogs: React.FC<LibraryDialogsProps> = ({
    adding,
    editing,
    renaming,
    removing,
    pathDraft,
    candidates,
    roots,
    onPathDraft,
    onClose,
}) => {
    const queryClient = useQueryClient();

    const done = () => {
        invalidateLibraries(queryClient);
        onClose();
    };

    const [pathValid, setPathValid] = useState(false);
    const [mountWritable, setMountWritable] = useState(false);
    const [deletable, setDeletable] = useState(false);

    /**
     * The name to give a new library, and whether it was typed.
     *
     * Prefilled from the directory as the path changes, so the field shows what the library
     * will be called rather than making somebody guess -- but it stops following the path the
     * moment anybody edits it. A name that silently reverted because the path was corrected
     * afterwards would be the more annoying of the two failures.
     */
    const [labelDraft, setLabelDraft] = useState("");
    const [labelTouched, setLabelTouched] = useState(false);

    const suggestedLabel = basename(pathDraft);
    const newLabel = labelTouched ? labelDraft : suggestedLabel;

    /** Forget the draft between openings, so one library's name is never offered for another. */
    const closeAndReset = () => {
        setLabelDraft("");
        setLabelTouched(false);
        setDeletable(false);
        onClose();
    };

    const doneAndReset = () => {
        setLabelDraft("");
        setLabelTouched(false);
        setDeletable(false);
        done();
    };

    const add = useMutation({
        mutationFn: ({
            path,
            label,
            writable,
        }: {
            path: string;
            label: string;
            writable: boolean;
        }) =>
            api("/api/admin/libraries", {
                method: "POST",
                // Absent rather than empty when it matches what the server would have chosen
                // anyway: the service falls back to the directory name, and storing the same
                // string explicitly would make a later change of mind look like a decision
                // somebody had already made.
                body: JSON.stringify({
                    path,
                    ...(label && label !== basename(path) ? { label } : {}),
                    ...(writable ? { writable } : {}),
                }),
            }),
        onSuccess: doneAndReset,
    });

    const rename = useMutation({
        mutationFn: ({ id, label }: { id: string; label: string }) =>
            api(`/api/admin/roots/${id}`, { method: "PATCH", body: JSON.stringify({ label }) }),
        onSuccess: doneAndReset,
    });

    const move = useMutation({
        mutationFn: ({ id, path }: { id: string; path: string }) =>
            api(`/api/admin/roots/${id}`, { method: "PATCH", body: JSON.stringify({ path }) }),
        onSuccess: done,
    });

    const forget = useMutation({
        mutationFn: (id: string) => api(`/api/admin/roots/${id}`, { method: "DELETE" }),
        onSuccess: done,
    });

    const target = roots.find((root) => root.id === (editing ?? renaming ?? removing));

    /** The rename box: the stored name until somebody edits it, the edit afterwards. */
    const renameValue = labelTouched ? labelDraft : (target?.label ?? "");

    /** The server's own words: it knows why a path was refused, and the reason is the point. */
    const reason = (error: unknown): string =>
        error instanceof ApiError ? error.message : "Something went wrong";

    return (
        <>
            <Modal opened={adding} onClose={closeAndReset} title="Add library" centered>
                <Stack gap="md">
                    <PathPicker
                        value={pathDraft}
                        onChange={onPathDraft}
                        onValidityChange={setPathValid}
                        onMountWritableChange={setMountWritable}
                    />

                    {/* After the path, because the path is what decides whether this can be
                        added at all and the name is a preference. Prefilled from the
                        directory so the common case is reading it rather than typing. */}
                    <TextInput
                        label="Name"
                        description="What this library is called in the sidebar. The directory name by default."
                        placeholder={suggestedLabel || "Films"}
                        value={newLabel}
                        maxLength={100}
                        onChange={(event) => {
                            setLabelTouched(true);
                            setLabelDraft(event.currentTarget.value);
                        }}
                    />

                    {/* Offered only where the mount allows it: the app cannot make a
                        read-only mount writable, and a switch that fails on save would only
                        say so later. The description says what to change instead. */}
                    <Switch
                        color="oxblood"
                        label="Deletable"
                        description={
                            !pathValid || mountWritable
                                ? "Lets accounts with the delete permission move files here to the trash."
                                : "This directory is mounted read-only. Add a :rw mount for it in docker-compose to allow deletion."
                        }
                        checked={deletable && mountWritable}
                        disabled={!mountWritable}
                        onChange={(event) => setDeletable(event.currentTarget.checked)}
                    />

                    {candidates.length > 0 && (
                        <Stack gap={4}>
                            {/* On a NAS every library arrives through a bind mount into the
                                media folder, so the common case is one click rather than a
                                typed path or a walk through the browser. */}
                            <Text size="xs" c="dimmed">
                                Found in the media folder:
                            </Text>
                            <Group gap="xs">
                                {candidates.map((candidate) => (
                                    <Button
                                        key={candidate}
                                        size="xs"
                                        variant="light"
                                        onClick={() => onPathDraft(candidate)}
                                    >
                                        {candidate}
                                    </Button>
                                ))}
                            </Group>
                        </Stack>
                    )}

                    {add.error && (
                        <Alert color="oxblood" variant="light">
                            {reason(add.error)}
                        </Alert>
                    )}

                    <Text size="xs" c="dimmed">
                        New libraries start disabled, so nothing is indexed until you switch it on.
                    </Text>

                    <Group justify="flex-end">
                        <Button variant="default" onClick={closeAndReset}>
                            Cancel
                        </Button>
                        <Button
                            loading={add.isPending}
                            disabled={!pathValid}
                            onClick={() =>
                                add.mutate({
                                    path: pathDraft.trim(),
                                    label: newLabel.trim(),
                                    writable: deletable && mountWritable,
                                })
                            }
                        >
                            Add
                        </Button>
                    </Group>
                </Stack>
            </Modal>

            <Modal
                opened={renaming !== null}
                onClose={closeAndReset}
                title="Rename library"
                centered
            >
                <Stack gap="md">
                    {/* Said explicitly, because renaming a thing that holds files invites the
                        question of whether the files move. Nothing keys on the name. */}
                    <Text size="sm">
                        Only what it is called here. The directory, its files and everything
                        catalogued from it are untouched.
                    </Text>

                    <TextInput
                        label="Name"
                        value={renameValue}
                        maxLength={100}
                        data-autofocus
                        onChange={(event) => {
                            setLabelTouched(true);
                            setLabelDraft(event.currentTarget.value);
                        }}
                        onKeyDown={(event) => {
                            if (event.key === "Enter" && renameValue.trim() && renaming) {
                                rename.mutate({ id: renaming, label: renameValue.trim() });
                            }
                        }}
                    />

                    <Text size="xs" c="dimmed" style={{ wordBreak: "break-all" }}>
                        {target?.path}
                    </Text>

                    {rename.error && (
                        <Alert color="oxblood" variant="light">
                            {reason(rename.error)}
                        </Alert>
                    )}

                    <Group justify="flex-end">
                        <Button variant="default" onClick={closeAndReset}>
                            Cancel
                        </Button>
                        <Button
                            loading={rename.isPending}
                            // A library with no name would show as a blank row in the
                            // sidebar, so the only invalid name is an empty one.
                            disabled={!renameValue.trim()}
                            onClick={() =>
                                renaming &&
                                rename.mutate({ id: renaming, label: renameValue.trim() })
                            }
                        >
                            Rename
                        </Button>
                    </Group>
                </Stack>
            </Modal>

            <Modal opened={editing !== null} onClose={onClose} title="Move library" centered>
                <Stack gap="md">
                    {/*
                     * The reason the path is editable at all. Files are stored relative to
                     * their library, so pointing it somewhere else keeps every tag, rating
                     * and duplicate group — this is a repoint, not a re-import.
                     */}
                    <Text size="sm">
                        Point <strong>{target?.label}</strong> at a different directory. Tags,
                        ratings and history stay with the library; nothing is re-catalogued.
                    </Text>

                    {/* Set the expectation before it happens: a library that empties itself
                        looks like data loss unless you were told to expect it. */}
                    <Alert variant="light" color="brass">
                        Its items are hidden until a scan confirms they are at the new location. The
                        scan starts immediately.
                    </Alert>

                    <PathPicker
                        value={pathDraft}
                        onChange={onPathDraft}
                        excludeId={editing ?? undefined}
                        onValidityChange={setPathValid}
                    />

                    {move.error && (
                        <Alert color="oxblood" variant="light">
                            {reason(move.error)}
                        </Alert>
                    )}

                    <Group justify="flex-end">
                        <Button variant="default" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button
                            loading={move.isPending}
                            disabled={!pathValid}
                            onClick={() =>
                                editing && move.mutate({ id: editing, path: pathDraft.trim() })
                            }
                        >
                            Move
                        </Button>
                    </Group>
                </Stack>
            </Modal>

            <Modal opened={removing !== null} onClose={onClose} title="Forget library?" centered>
                <Stack gap="md">
                    <Text size="sm">
                        private-stock will forget <strong>{target?.label}</strong> and everything it
                        catalogued from it — including tags and ratings for those items.
                    </Text>

                    {/* Said plainly, because "forget" next to a delete-coloured button reads
                        as though it removes the content. */}
                    <Alert variant="light" color="brass">
                        The files on disk are not touched.
                    </Alert>

                    {forget.error && (
                        <Alert color="oxblood" variant="light">
                            {reason(forget.error)}
                        </Alert>
                    )}

                    <Group justify="flex-end">
                        <Button variant="default" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button
                            color="oxblood"
                            loading={forget.isPending}
                            onClick={() => removing && forget.mutate(removing)}
                        >
                            Forget
                        </Button>
                    </Group>
                </Stack>
            </Modal>
        </>
    );
};
