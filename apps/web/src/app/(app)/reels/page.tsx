"use client";

import { useState } from "react";
import {
    Box,
    Button,
    Group,
    Modal,
    Pagination,
    SegmentedControl,
    Select,
    Stack,
    TextInput,
} from "@mantine/core";

import {
    reelNaturalDirection,
    reelOwnerships,
    reelSorts,
    type ReelOwnership,
    type ReelSort,
} from "@private-stock/core";

import { LoadFailed } from "@/components/LoadFailed";
import { FlipWall } from "@/components/FlipWall";
import { ReelCard } from "@/components/reel/ReelCard";
import {
    defineView,
    enumField,
    pageField,
    textField,
    useUrlSearch,
    useUrlView,
} from "@/lib/urlView";
import { EmptyState } from "@/components/shell/EmptyState";
import { PageLoader } from "@/components/shell/PageLoader";
import { PagePlate } from "@/components/shell/PagePlate";
import { useCreateReel, useReels } from "@/lib/api/reels";
import { settling } from "@/lib/settling";
import { SearchInput } from "@/components/SearchInput";

/**
 * The reel index (§14d).
 *
 * **Not on `/collections`, and that is not the mistake §14c undid.** That one deleted a
 * `/playlists` page which listed half of what `/collections` listed, from its own sidebar entry,
 * directly underneath it — a hierarchy nobody could explain. This shares no rows with
 * `/collections` at all. A collection is a *way back into the library*, a query or a list of
 * items, and there are few enough to pin; a reel is a *work*, made of spans, and there will be
 * hundreds. Hundreds is why this is a page with a sort, a filter, a search and paging rather
 * than a wall with two sections on it.
 *
 * Ownership is a **control** here for the same reason. `CollectionSections` stacks "yours" above
 * "the household's", which reads perfectly at a handful each and hides the second section
 * entirely at a screenful.
 */

const SORTS: { value: ReelSort; label: string }[] = [
    { value: "updated", label: "Recently updated" },
    { value: "created", label: "Recently made" },
    { value: "name", label: "Name" },
    { value: "duration", label: "Running time" },
    { value: "clipCount", label: "Clips" },
];

/**
 * The view, in the address (§14b): opening a reel and coming back -- by its back link, Back or
 * the sidebar -- finds the same filter, search and page.
 */
const reelsView = defineView("/reels", {
    ownership: enumField("owner", reelOwnerships, "all"),
    sort: enumField("sort", reelSorts, "updated"),
    search: textField("q"),
    page: pageField(),
});

const ReelsPage: React.FC = () => {
    const [view, apply] = useUrlView(reelsView);
    const { ownership, sort, page } = view;
    // Typing is not a query: the box settles into the address after a pause, so a search over a
    // few hundred names does not fire once per keystroke.
    const [search, setSearch] = useUrlSearch(view.search, (settled) =>
        apply({ search: settled, page: 0 })
    );
    const [naming, setNaming] = useState(false);
    const [name, setName] = useState("");

    const { data, isLoading, isPlaceholderData, error, refetch } = useReels({
        ownership,
        sort,
        direction: reelNaturalDirection(sort),
        search: view.search || undefined,
        page,
    });

    const create = useCreateReel(() => {
        setNaming(false);
        setName("");
    });

    const pages = data ? Math.ceil(data.total / Math.max(1, data.pageSize)) : 0;

    return (
        <Stack gap="lg">
            {/* The letterhead every page wears, at the one size every page uses (§14). */}
            <PagePlate
                eyebrow={
                    data
                        ? `${data.total.toLocaleString()} ${data.total === 1 ? "reel" : "reels"}`
                        : "Made from clips"
                }
                title="Reels"
                lede="Spans of your library, in an order you chose."
                actions={
                    <Button color="brass" onClick={() => setNaming(true)}>
                        New reel
                    </Button>
                }
            />

            <Group gap="sm" wrap="wrap">
                <SegmentedControl
                    value={ownership}
                    onChange={(value) => apply({ ownership: value as ReelOwnership, page: 0 })}
                    data={[
                        { value: "all", label: "All" },
                        { value: "mine", label: "Mine" },
                        { value: "shared", label: "Shared" },
                    ]}
                />
                <Select
                    data={SORTS}
                    value={sort}
                    onChange={(value) => apply({ sort: (value as ReelSort) ?? "updated", page: 0 })}
                    allowDeselect={false}
                    w={{ base: "100%", sm: 190 }}
                    aria-label="Sort"
                />
                <SearchInput
                    placeholder="Search names"
                    value={search}
                    onChange={setSearch}
                    w={{ base: "100%", sm: 240 }}
                />
            </Group>

            {isLoading && <PageLoader />}

            {error && <LoadFailed error={error} what="the reels" onRetry={() => void refetch()} />}

            {data && data.items.length === 0 && (
                <EmptyState title={view.search ? "No reel matches that" : "No reels yet"}>
                    {view.search
                        ? "Try another name, or clear the search."
                        : "Mark a span with [ and ] while watching, then gather what you marked from Clips."}
                </EmptyState>
            )}

            {/* Settles while the next answer loads, rather than being swapped for a spinner. */}
            <Box {...settling(isPlaceholderData)}>
                <FlipWall
                    keys={data?.items.map((reel) => reel.id) ?? []}
                    style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
                        gap: "var(--mantine-spacing-sm)",
                    }}
                >
                    {data?.items.map((reel) => (
                        <div key={reel.id} data-flip-key={reel.id}>
                            <ReelCard reel={reel} />
                        </div>
                    ))}
                </FlipWall>
            </Box>

            {/* Pages, not an endless scroll (§20): a page is an address that can be shared,
                reloaded and returned to with the back button. */}
            {pages > 1 && (
                <Group justify="center">
                    <Pagination
                        value={page + 1}
                        onChange={(value) => apply({ page: value - 1 })}
                        total={pages}
                        color="brass"
                    />
                </Group>
            )}

            <Modal opened={naming} onClose={() => setNaming(false)} title="New reel" centered>
                <Stack gap="md">
                    <TextInput
                        label="Name"
                        value={name}
                        onChange={(event) => setName(event.currentTarget.value)}
                        data-autofocus
                    />
                    <Button
                        disabled={name.trim() === ""}
                        loading={create.isPending}
                        onClick={() => create.mutate({ name: name.trim(), visibility: "private" })}
                    >
                        Create
                    </Button>
                </Stack>
            </Modal>
        </Stack>
    );
};

export default ReelsPage;
