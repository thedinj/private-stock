"use client";

import { useState } from "react";
import { Button, Group, Menu, Modal, Stack, Switch, Text, TextInput } from "@mantine/core";

import type { SavedFilter } from "@private-stock/core";

import {
    useCreateSavedFilter,
    useDeleteSavedFilter,
    useSavedFilters,
    useUpdateSavedFilter,
} from "@/lib/api/savedFilters";
import { useAuth } from "@/lib/api/AuthProvider";
import {
    closeSavedFilter,
    hasClearableFilters,
    hasLook,
    matchesSavedQuery,
    openSavedFilter,
    viewToSavedQuery,
    type LibraryView,
} from "@/lib/libraryQuery";
import { CloseGlyph, MoreGlyph } from "@/components/media/Glyph";

/**
 * Saving the current view, and managing the filter it came from (§14b).
 *
 * Three states, and which one is showing is the whole design:
 *
 *  - **Not on a saved filter.** Offer to save, but only once something is actually narrowed.
 *    "Save this view" over the unfiltered library would save the library.
 *  - **On one, unchanged.** Say so quietly and offer the housekeeping — pin, rename, delete.
 *    Nothing to save, so no save button; a button that does nothing is worse than no button.
 *  - **On one, edited.** Offer to save over it or to save a copy, and to put it back. This is
 *    the state that needs the most room, because it is the only one where the name in the
 *    sidebar and the grid on screen disagree.
 *
 * Divergence is computed from the query, not tracked as a flag. Turning a page or switching
 * to the gallery is not an edit to the filter, and a flag set by "something changed" would
 * say it was.
 *
 * **And a fourth state, which this control used to get wrong: on somebody else's.** A shared
 * view is readable by everyone and writable by nobody but its owner -- the same rule playlists
 * follow, and for the same reason: `admin` manages the library, not other people's ways of
 * looking at it. The menu offered pin, delete and "save changes" on any open view, so opening
 * one somebody else had shared put three controls on screen that the server answers with a
 * 403. They are absent now rather than disabled, as everywhere else in the app.
 *
 * What stays offered on somebody else's view is the pair that makes it useful: **discard
 * changes**, which is local, and **save as a new filter**, which is how you take a copy of a
 * way of looking that somebody else worked out.
 */

interface SavedViewControlProps {
    view: LibraryView;
    onApply: (next: LibraryView) => void;
}

export const SavedViewControl: React.FC<SavedViewControlProps> = ({ view, onApply }) => {
    const { data } = useSavedFilters();
    const { hasScope } = useAuth();
    /**
     * Sharing is curation, and curation is an administrator's (§14b). The control is absent
     * for everybody else rather than disabled — "why is this greyed" is answered by a
     * paragraph about what "shared" has to be able to mean.
     */
    const canShare = hasScope("admin");
    const create = useCreateSavedFilter((filter) => {
        // Land on the filter that was just created, so the sidebar entry and the page agree
        // and "save changes" is immediately the right verb.
        onApply(openSavedFilter(view, filter.id, viewToSavedQuery(view)));
        closeNaming();
    });
    const [renaming, setRenaming] = useState<string | null>(null);
    const update = useUpdateSavedFilter(() => setRenaming(null));
    const remove = useDeleteSavedFilter();

    const [naming, setNaming] = useState<null | { name: string; pinned: boolean }>(null);

    const closeNaming = () => setNaming(null);

    const current: SavedFilter | undefined = view.filterId
        ? data?.filters.find((filter) => filter.id === view.filterId)
        : undefined;

    /**
     * Whether the grid still shows what the filter says.
     *
     * A filter whose stored query no longer parses counts as matching: there is nothing to
     * compare against, and offering "save changes" against a query we cannot read would
     * overwrite something the viewer never got to see.
     */
    const edited = current?.query ? !matchesSavedQuery(view, current.query) : false;

    /**
     * Whether this view is this account's to change.
     *
     * False for one somebody else shared. Every write below hangs on it, because the server
     * refuses all of them and a control that cannot work is absent rather than disabled.
     */
    const mine = current?.editable ?? false;

    /**
     * Whether a look is in force (§5e). A saved filter cannot keep one yet, so while there is
     * one nothing here offers to save: it would store the filters without the look, and the
     * view it named would not be the one on screen. Clearing the look brings them back.
     */
    const looking = hasLook(view);

    const busy = create.isPending || update.isPending || remove.isPending;

    const saveOver = () => {
        if (!current) return;

        update.mutate({ id: current.id, patch: { query: viewToSavedQuery(view) } });
    };

    const revert = () => {
        if (!current?.query) return;

        onApply(openSavedFilter(view, current.id, current.query));
    };

    const submitRename = () => {
        if (!current || !renaming?.trim()) return;

        update.mutate({ id: current.id, patch: { name: renaming.trim() } });
    };

    const submitName = () => {
        if (!naming?.name.trim()) return;

        create.mutate({
            name: naming.name.trim(),
            query: viewToSavedQuery(view),
            pinned: naming.pinned,
            visibility: "private",
            resolveAs: "viewer",
        });
    };

    return (
        <>
            <Group gap="xs" wrap="nowrap">
                {/* The state, and the way out of it.

                    There was no way out. Opening a view put its name in the title and its id
                    in the address, and the only exits were deleting it, picking another one,
                    or clearing the filters -- which left the name in place and reported
                    "Edited": the app insisting you had changed a view when what you had done
                    was leave it.

                    The × is here rather than in the menu because leaving is as ordinary as
                    arriving, and because this is the one control on the page that is *about*
                    the view -- the name it closes is right beside it. It closes rather than
                    clears: what you get back is the whole library. */}
                {current && (
                    <Group gap={2} wrap="nowrap">
                        <Text
                            size="xs"
                            c={edited ? "brass.4" : "dimmed"}
                            style={{ whiteSpace: "nowrap" }}
                        >
                            {edited ? "Edited" : "Saved"}
                        </Text>

                        <Button
                            size="compact-xs"
                            variant="subtle"
                            color="gray"
                            onClick={() => onApply(closeSavedFilter(view))}
                            aria-label={`Close ${current.name}`}
                            title={`Close ${current.name} — back to the whole library`}
                        >
                            <CloseGlyph size={14} />
                        </Button>
                    </Group>
                )}

                {edited && mine && !looking && (
                    <Button
                        size="xs"
                        variant="light"
                        color="brass"
                        onClick={saveOver}
                        loading={update.isPending}
                    >
                        Save changes
                    </Button>
                )}

                {/* Offered only when something is narrowed -- and the kind alone is not
                    that: it is which shelf you are on, and a view named "Videos" would say
                    what the tab above the grid already says. Saving the whole library under
                    a name produces an entry that means "everything", which the Library tab
                    already says too. */}
                {!current && hasClearableFilters(view) && !looking && (
                    <Button
                        size="xs"
                        variant="light"
                        color="brass"
                        onClick={() => setNaming({ name: "", pinned: true })}
                    >
                        Save view
                    </Button>
                )}

                {/* Housekeeping for the view you are on, and only then (§14c). Choosing a
                    view is the sidebar's job and the Views & playlists page's: a list of every
                    view in this menu grew with each one saved, until the actions for the view
                    you were on sat below eighty names. */}
                {current && (
                    <Menu position="bottom-end" withinPortal>
                        <Menu.Target>
                            <Button
                                size="xs"
                                variant="subtle"
                                color="gray"
                                disabled={busy}
                                aria-label="Saved views"
                            >
                                <MoreGlyph size={16} />
                            </Button>
                        </Menu.Target>

                        <Menu.Dropdown>
                            {edited && (
                                <>
                                    {!looking && (
                                        <Menu.Item
                                            onClick={() => setNaming({ name: "", pinned: true })}
                                        >
                                            Save as a new filter
                                        </Menu.Item>
                                    )}
                                    <Menu.Item onClick={revert}>Discard changes</Menu.Item>
                                    <Menu.Divider />
                                </>
                            )}

                            {current && (
                                <>
                                    <Menu.Item onClick={() => onApply(closeSavedFilter(view))}>
                                        Close this view
                                    </Menu.Item>
                                    <Menu.Divider />
                                </>
                            )}

                            {/* Changing the view itself, and only if it is yours -- the
                            server refuses the rest, so they are absent rather than disabled. */}
                            {current && mine && (
                                <>
                                    <Menu.Item onClick={() => setRenaming(current.name)}>
                                        Rename
                                    </Menu.Item>

                                    <Menu.Item
                                        onClick={() =>
                                            update.mutate({
                                                id: current.id,
                                                patch: { pinned: !current.pinned },
                                            })
                                        }
                                    >
                                        {current.pinned ? "Unpin from sidebar" : "Pin to sidebar"}
                                    </Menu.Item>

                                    {/* Sharing a view is not quite sharing a playlist, and the
                                    difference is worth a line: a playlist names the same
                                    items for everyone, while a view is a question -- and a
                                    question about your own ratings or your own unwatched
                                    items asks itself again of whoever opens it (§6). Said
                                    on the control because it changes what sharing means,
                                    not whether it is safe: nothing of yours is disclosed
                                    either way. */}
                                    {canShare && (
                                        <Menu.Item
                                            onClick={() =>
                                                update.mutate({
                                                    id: current.id,
                                                    patch: {
                                                        visibility:
                                                            current.visibility === "shared"
                                                                ? "private"
                                                                : "shared",
                                                    },
                                                })
                                            }
                                        >
                                            {current.visibility === "shared"
                                                ? "Make private"
                                                : "Share with everyone"}
                                            {current.visibility === "private" &&
                                                current.viewerRelative && (
                                                    <Text size="xs" c="dimmed">
                                                        Everyone sees it with their own ratings and
                                                        favourites
                                                    </Text>
                                                )}
                                        </Menu.Item>
                                    )}

                                    <Menu.Divider />

                                    <Menu.Item
                                        color="oxblood"
                                        onClick={() => {
                                            remove.mutate(current.id);
                                            // Leaving the filter behind rather than sitting on
                                            // the address of something that no longer exists.
                                            onApply({ ...view, filterId: null });
                                        }}
                                    >
                                        Delete view
                                    </Menu.Item>
                                </>
                            )}
                        </Menu.Dropdown>
                    </Menu>
                )}
            </Group>

            <Modal
                opened={renaming !== null}
                onClose={() => setRenaming(null)}
                title="Rename this view"
                centered
            >
                <Stack gap="md">
                    <TextInput
                        label="Name"
                        data-autofocus
                        value={renaming ?? ""}
                        onChange={(event) => setRenaming(event.currentTarget.value)}
                        onKeyDown={(event) => event.key === "Enter" && submitRename()}
                        error={update.isError ? (update.error as Error).message : null}
                    />

                    <Text size="xs" c="dimmed">
                        The sidebar and anyone you have shared it with see the new name. Nothing
                        about what it shows changes.
                    </Text>

                    <Group justify="flex-end" gap="sm">
                        <Button variant="subtle" color="gray" onClick={() => setRenaming(null)}>
                            Cancel
                        </Button>
                        <Button
                            color="brass"
                            onClick={submitRename}
                            loading={update.isPending}
                            disabled={!renaming?.trim()}
                        >
                            Rename
                        </Button>
                    </Group>
                </Stack>
            </Modal>

            <Modal opened={naming !== null} onClose={closeNaming} title="Save this view" centered>
                <Stack gap="md">
                    <TextInput
                        label="Name"
                        placeholder="Unrated 4K"
                        data-autofocus
                        value={naming?.name ?? ""}
                        // The value is read here, not inside the updater. React clears
                        // `currentTarget` once the handler returns, and a functional update
                        // runs later — reading it in there throws on null.
                        onChange={(event) => {
                            const name = event.currentTarget.value;

                            setNaming((prev) => (prev ? { ...prev, name } : prev));
                        }}
                        onKeyDown={(event) => event.key === "Enter" && submitName()}
                        error={
                            create.isError
                                ? // The server refuses a duplicate name rather than resolving
                                  // it, so this is the one error worth showing in place.
                                  (create.error as Error).message
                                : null
                        }
                    />

                    <Switch
                        label="Pin to the sidebar"
                        checked={naming?.pinned ?? false}
                        color="brass"
                        onChange={(event) => {
                            const pinned = event.currentTarget.checked;

                            setNaming((prev) => (prev ? { ...prev, pinned } : prev));
                        }}
                    />

                    <Group justify="flex-end" gap="sm">
                        <Button variant="default" onClick={closeNaming}>
                            Cancel
                        </Button>
                        <Button
                            color="brass"
                            onClick={submitName}
                            loading={create.isPending}
                            disabled={!naming?.name.trim()}
                        >
                            Save
                        </Button>
                    </Group>
                </Stack>
            </Modal>
        </>
    );
};
