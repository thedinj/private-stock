"use client";

import { useState } from "react";
import Link from "next/link";
import {
    ActionIcon,
    Alert,
    Button,
    Checkbox,
    Group,
    Menu,
    Modal,
    Select,
    Stack,
    TagsInput,
    Text,
    TextInput,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";

import { tagKinds, type Tag, type TagScope } from "@private-stock/core";

import { ApiError } from "@/lib/api/client";
import { facetLabel } from "@/lib/facetLabels";
import {
    useDeleteTag,
    useMergeTags,
    useSetTagScope,
    useUpdateTag,
    useVocabulary,
} from "@/lib/api/tags";

/**
 * The retroactive half of tag management (§6).
 *
 * Every action here changes what items already say, and the house style is to state the
 * consequence rather than ask "are you sure" (`TrashConfirm`, `LibraryDialogs`). So each
 * dialogue names the number it will affect before the button is pressed — the count is already
 * in the row, and quoting it is the difference between a warning and a shrug.
 *
 * **Unpublish is absent rather than disabled** when somebody else has used the tag. A control
 * that cannot work is not shown (§14), and the alternative here is worse than usual: a greyed
 * button invites the question "why not", which can only be answered by naming what other
 * people have been doing with their own account.
 */

interface TagRowActionsProps {
    tag: Tag;
    scope: TagScope;
    /** Whether this viewer may change the vocabulary this tag is in. */
    curator: boolean;
    onDone: (message: string) => void;
    /**
     * Buttons in a table row, or one ⋯ menu where the row is a picture rather than a line of
     * text (the browse pages). The dialogues are the same either way.
     */
    variant?: "buttons" | "menu";
    /** After a delete or a merge, when the tag this was opened on no longer exists. */
    onGone?: () => void;
    /**
     * Where the menu can offer "Choose a picture…" (§6 "A tag's picture"): the tag's own page,
     * which has items to choose from. Anybody may, so it is not behind `curator`.
     */
    onChoosePicture?: () => void;
    /**
     * Where a tile is showing a stand-in -- one of its items' covers, because the tag has no
     * picture of its own -- the menu can keep that one (§6 "A tag's picture").
     */
    onKeepPicture?: () => void;
}

const FACETS = tagKinds.map((kind) => ({ value: kind, label: facetLabel(kind) }));

const items = (count: number): string => `${count} item${count === 1 ? "" : "s"}`;

export const TagRowActions: React.FC<TagRowActionsProps> = ({
    tag,
    scope,
    curator,
    onDone,
    variant = "buttons",
    onGone,
    onChoosePicture,
    onKeepPicture,
}) => {
    const [dialog, setDialog] = useState<"rename" | "merge" | "delete" | "publish" | null>(null);
    const [name, setName] = useState(tag.name);
    const [kind, setKind] = useState(tag.kind);
    const [aliases, setAliases] = useState<string[]>(tag.aliases ?? []);
    /**
     * Off to begin with: most renames correct a spelling, and keeping the misspelling as a name
     * that still resolves is the opposite of what was wanted (§5b "Aliases").
     */
    const [keepOldName, setKeepOldName] = useState(false);
    const [target, setTarget] = useState<string | null>(null);
    /**
     * On to begin with: a merge that forgets the folded name invites the duplicate straight
     * back, the next time somebody types it.
     */
    const [keepAlias, setKeepAlias] = useState(true);
    /**
     * What to fold this tag into, searched on the server.
     *
     * It used to be the rows of the vocabulary table that happened to be on screen, so a
     * duplicate could only be merged into a tag on the same page — and the commonest merge is
     * a stray spelling into the canonical name, which sort order puts nowhere near it. The
     * table's own endpoint already searches, pages and counts, so this is that hook with a
     * facet fixed rather than anything new.
     */
    const [search, setSearch] = useState("");
    const [debouncedSearch] = useDebouncedValue(search, 300);

    const targets = useVocabulary(
        {
            scope,
            kind: tag.kind,
            search: debouncedSearch || undefined,
            page: 0,
            pageSize: 50,
        },
        dialog === "merge"
    );

    const close = () => setDialog(null);

    /**
     * Starts the edit from the tag as it is now, not as the form was last left.
     *
     * The server rewrites the alias set on a swap -- the new name leaves it, the old one joins
     * -- so a form that kept its own state would reopen showing the list from before the save.
     */
    const openEdit = () => {
        setName(tag.name);
        setKind(tag.kind);
        setAliases(tag.aliases ?? []);
        setKeepOldName(false);
        setDialog("rename");
    };
    const count = tag.mediaCount ?? 0;

    const renamed = name.trim() !== tag.name;

    const rename = useUpdateTag((saved) => {
        close();
        // The facet is named when it changed, because the row leaves this table's filter the
        // moment it moves and the message is the only trace of where it went.
        const where = saved.kind !== tag.kind ? ` in ${facetLabel(saved.kind)}` : "";

        onDone(renamed ? `Renamed to ${saved.name}${where}` : `Saved ${saved.name}${where}`);
    });
    const remove = useDeleteTag((result) => {
        close();
        onDone(`Deleted — removed from ${items(result.affected)}`);
        onGone?.();
    });
    const merge = useMergeTags((result) => {
        close();
        onDone(`Merged — ${items(result.affected)} moved`);
        onGone?.();
    });
    const setScope = useSetTagScope((result) => {
        close();

        // Said rather than done quietly: an alias the destination already gives to another tag
        // cannot come along, and somebody who relied on it should hear that it is gone.
        const dropped = result.aliasesDropped
            ? ` — ${result.aliasesDropped} alias${result.aliasesDropped === 1 ? " was" : "es were"} already in use there and stayed behind`
            : "";

        onDone(
            scope === "private"
                ? `Published — ${items(result.affected)} are now public${dropped}`
                : `Made private — ${items(result.affected)}${dropped}`
        );
    });

    /** The server's own words: it knows why an action was refused, and the reason is the point. */
    const reason = (error: unknown): string | null =>
        error instanceof ApiError ? error.message : error ? "Something went wrong" : null;

    const busy = rename.isPending || remove.isPending || merge.isPending || setScope.isPending;

    return (
        <>
            {variant === "menu" ? (
                <Menu position="bottom-end" withinPortal>
                    <Menu.Target>
                        <ActionIcon
                            variant="subtle"
                            color="gray"
                            size="lg"
                            aria-label={`Actions for ${tag.name}`}
                        >
                            <Text span fw={700} lh={1}>
                                ⋯
                            </Text>
                        </ActionIcon>
                    </Menu.Target>
                    <Menu.Dropdown>
                        <Menu.Item component={Link} href={`/?view=grid&tags=${tag.id}`}>
                            Open in library
                        </Menu.Item>
                        {onChoosePicture && (
                            <Menu.Item onClick={onChoosePicture}>Choose a picture…</Menu.Item>
                        )}
                        {onKeepPicture && (
                            <Menu.Item onClick={onKeepPicture}>Keep this picture…</Menu.Item>
                        )}
                        {curator && <Menu.Item onClick={openEdit}>Edit…</Menu.Item>}
                        {curator && (
                            <Menu.Item onClick={() => setDialog("merge")}>Merge…</Menu.Item>
                        )}
                        {scope === "private" && (
                            <Menu.Item onClick={() => setDialog("publish")}>Publish…</Menu.Item>
                        )}
                        {curator && (
                            <Menu.Item color="oxblood" onClick={() => setDialog("delete")}>
                                Delete…
                            </Menu.Item>
                        )}
                    </Menu.Dropdown>
                </Menu>
            ) : (
                <Group gap={4} wrap="nowrap" justify="flex-end">
                    {curator && (
                        <>
                            <Button size="xs" variant="subtle" onClick={openEdit}>
                                Edit
                            </Button>
                            {/* Offered on every row now the targets are searched rather than
                            taken from the page: whether this facet holds anything else to
                            merge into is the dialogue's question to answer, and one query per
                            row of the table to find out in advance is not worth it. */}
                            <Button size="xs" variant="subtle" onClick={() => setDialog("merge")}>
                                Merge
                            </Button>
                        </>
                    )}

                    {/* Publishing is the owner's, never an administrator's: moving somebody's
                    private tag into the library is a decision about their collection (§6). */}
                    {scope === "private" && (
                        <Button size="xs" variant="subtle" onClick={() => setDialog("publish")}>
                            Publish
                        </Button>
                    )}

                    {curator && (
                        <Button
                            size="xs"
                            variant="subtle"
                            color="oxblood"
                            onClick={() => setDialog("delete")}
                        >
                            Delete
                        </Button>
                    )}
                </Group>
            )}

            <Modal opened={dialog === "rename"} onClose={close} title="Edit tag" centered>
                <Stack gap="md">
                    <Text size="sm">
                        A new name shows on every item carrying it — {items(count)}. Nothing is
                        added or removed.
                    </Text>

                    <TextInput
                        label="Name"
                        value={name}
                        maxLength={200}
                        data-autofocus
                        onChange={(event) => setName(event.currentTarget.value)}
                    />

                    {/* Only when there is an old name to keep. Renaming onto one of the aliases
                        below with this ticked swaps the two -- the married name becomes the
                        name, and the maiden name still finds the tag. */}
                    {renamed && (
                        <Checkbox
                            label={`Keep "${tag.name}" as an alias`}
                            checked={keepOldName}
                            onChange={(event) => setKeepOldName(event.currentTarget.checked)}
                        />
                    )}

                    <TagsInput
                        label="Also known as"
                        description={`Typing any of these, anywhere, uses ${name.trim() || tag.name}. Searches find it by them too.`}
                        placeholder="Add a name and press Enter"
                        value={aliases}
                        onChange={setAliases}
                        maxTags={50}
                        clearable
                    />

                    {/* Moving a facet is a rename of a different kind: a performer filed as a
                        plain tag is a mistake people make constantly and could not fix.
                        Public only -- a private tag has nowhere to move to (§6). */}
                    {scope === "public" && (
                        <Select
                            label="Facet"
                            data={FACETS}
                            value={kind}
                            onChange={(value) => setKind(value ?? tag.kind)}
                            allowDeselect={false}
                        />
                    )}

                    {reason(rename.error) && (
                        <Alert color="oxblood" variant="light">
                            {reason(rename.error)}
                        </Alert>
                    )}

                    <Group justify="flex-end">
                        <Button variant="default" onClick={close}>
                            Cancel
                        </Button>
                        <Button
                            loading={rename.isPending}
                            disabled={!name.trim()}
                            onClick={() =>
                                rename.mutate({
                                    id: tag.id,
                                    name: name.trim(),
                                    kind,
                                    aliases,
                                    keepOldNameAsAlias: renamed && keepOldName,
                                })
                            }
                        >
                            Save
                        </Button>
                    </Group>
                </Stack>
            </Modal>

            <Modal opened={dialog === "merge"} onClose={close} title="Merge tag" centered>
                <Stack gap="md">
                    <Text size="sm">
                        The {items(count)} tagged <strong>{tag.name}</strong> will be tagged with
                        the tag you choose instead, and <strong>{tag.name}</strong> is deleted.
                    </Text>

                    <Alert variant="light" color="brass">
                        This cannot be undone.
                    </Alert>

                    <Select
                        label="Merge into"
                        placeholder="Choose a tag"
                        searchable
                        searchValue={search}
                        onSearchChange={setSearch}
                        /**
                         * The server already matched, on `nameNorm`. Filtering again in the
                         * browser would do it on `name` instead and quietly drop a hit that
                         * differed only by case or punctuation — which is precisely the kind
                         * of near-duplicate somebody opens this dialogue to fold away.
                         */
                        filter={({ options }) => options}
                        nothingFoundMessage={
                            targets.isLoading ? "Looking…" : "No other tag in this facet"
                        }
                        data={(targets.data?.tags ?? [])
                            // Same facet and same system, never itself: a merge across any of
                            // those is refused by the server, so offering it offers a failure.
                            .filter((other) => other.id !== tag.id)
                            .map((other) => ({
                                value: other.id,
                                label: `${other.name} (${other.mediaCount ?? 0})`,
                            }))}
                        value={target}
                        onChange={setTarget}
                        data-autofocus
                    />

                    {/* The folded tag's own aliases come along regardless; this is only about
                        its name. Untick it for a stray typo nobody should be able to type
                        their way back to. */}
                    <Checkbox
                        label={`Keep "${tag.name}" as an alias`}
                        description={`Typing "${tag.name}" will then use the tag you chose, instead of creating it again.`}
                        checked={keepAlias}
                        onChange={(event) => setKeepAlias(event.currentTarget.checked)}
                    />

                    {reason(merge.error) && (
                        <Alert color="oxblood" variant="light">
                            {reason(merge.error)}
                        </Alert>
                    )}

                    <Group justify="flex-end">
                        <Button variant="default" onClick={close}>
                            Cancel
                        </Button>
                        <Button
                            color="oxblood"
                            loading={merge.isPending}
                            disabled={!target}
                            onClick={() =>
                                target && merge.mutate({ id: tag.id, intoTagId: target, keepAlias })
                            }
                        >
                            Merge
                        </Button>
                    </Group>
                </Stack>
            </Modal>

            <Modal opened={dialog === "delete"} onClose={close} title="Delete tag?" centered>
                <Stack gap="md">
                    <Text size="sm">
                        <strong>{tag.name}</strong> is removed from {items(count)}.
                    </Text>

                    {/* Said plainly, because "delete" next to a count of items reads as though
                        it removes the items -- the same worry the Forget library dialog has. */}
                    <Alert variant="light" color="brass">
                        The items themselves are untouched. Only the tag goes.
                    </Alert>

                    {reason(remove.error) && (
                        <Alert color="oxblood" variant="light">
                            {reason(remove.error)}
                        </Alert>
                    )}

                    <Group justify="flex-end">
                        <Button variant="default" onClick={close}>
                            Keep it
                        </Button>
                        <Button
                            color="oxblood"
                            loading={remove.isPending}
                            onClick={() => remove.mutate(tag.id)}
                        >
                            Delete
                        </Button>
                    </Group>
                </Stack>
            </Modal>

            <Modal
                opened={dialog === "publish"}
                onClose={close}
                title={scope === "private" ? "Publish tag?" : "Make private?"}
                centered
            >
                <Stack gap="md">
                    {scope === "private" ? (
                        <>
                            <Text size="sm">
                                Everyone will see <strong>{tag.name}</strong> and the {items(count)}{" "}
                                you have put it on.
                            </Text>
                            <Alert variant="light" color="brass">
                                Public tags are searchable by everybody, so those items become
                                findable by this name.
                            </Alert>
                        </>
                    ) : (
                        <Text size="sm">
                            <strong>{tag.name}</strong> becomes yours alone, along with the{" "}
                            {items(count)} carrying it. Only possible while nobody else has used it.
                        </Text>
                    )}

                    {reason(setScope.error) && (
                        <Alert color="oxblood" variant="light">
                            {reason(setScope.error)}
                        </Alert>
                    )}

                    <Group justify="flex-end">
                        <Button variant="default" onClick={close}>
                            Cancel
                        </Button>
                        <Button
                            loading={setScope.isPending}
                            disabled={busy && !setScope.isPending}
                            onClick={() =>
                                setScope.mutate({
                                    id: tag.id,
                                    scope: scope === "private" ? "public" : "private",
                                })
                            }
                        >
                            {scope === "private" ? "Publish" : "Make private"}
                        </Button>
                    </Group>
                </Stack>
            </Modal>
        </>
    );
};
