"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Alert, Button, SegmentedControl, Stack, Switch } from "@mantine/core";

import { tagBrowseSortSchema, type TagBrowseSort, type TagScope } from "@private-stock/core";

import { useAuth } from "@/lib/api/AuthProvider";
import { favoriteTagsHref } from "@/lib/libraryQuery";
import { useTagSeed } from "@/lib/useTagSeed";
import {
    defineView,
    enumField,
    flagField,
    textField,
    useUrlSearch,
    useUrlView,
} from "@/lib/urlView";
import {
    BROWSE_TOUCH_HEIGHT,
    BrowseToolbar,
    useBrowseWide,
} from "@/components/browse/BrowseToolbar";
import { BROWSE_LAYOUTS, RowsTilesSwitch } from "@/components/browse/RowsTilesSwitch";
import { PagePlate } from "@/components/shell/PagePlate";
import { SearchInput } from "@/components/SearchInput";

import { TagBrowseList } from "./TagBrowseList";

/**
 * A facet to look through: Performers, Sources or Keywords (§6 "Tags").
 *
 * One component for the three pages because they differ only in the facet and in how many
 * systems they show. Keywords is the one facet that can be private, so it lists yours first --
 * the ones you made for yourself are the ones you came for -- and then the library's.
 *
 * Search and sort are shared across both lists on that page: two search boxes one above the
 * other would each look like the one that searches everything.
 */

export interface TagBrowseSection {
    scope: TagScope;
    heading?: string;
    /** Said when the list is empty; null leaves the section out entirely. */
    empty: string | null;
}

interface TagBrowsePageProps {
    kind: string;
    title: string;
    eyebrow: string;
    lede?: string;
    sections: TagBrowseSection[];
}

const SORTS: { value: TagBrowseSort; label: string }[] = [
    { value: "count", label: "Most items" },
    { value: "name", label: "A–Z" },
    { value: "recent", label: "Recently tagged" },
];

/**
 * The search and sort, in the address (§14b), beside the `seed` that `useTagSeed` already keeps
 * there. Held in component state, opening a performer and coming back lost both, and the list
 * behind them; the address also lets the profile's back link and the sidebar return here.
 */
const browseFields = {
    search: textField("q"),
    sort: enumField("sort", tagBrowseSortSchema.options, "count"),
    /**
     * Only the viewer's favourites (§6 "Favourite tags"). A filter rather than pinning them to
     * the top: somebody with three hundred favourite performers would otherwise scroll past
     * all of them to reach anybody else.
     */
    favorite: flagField("favorite"),
    /**
     * Rows show a tag's range, tiles its face. Rows by default: a facet of hundreds scans
     * down a list faster than across a wall of cards (§6 "Tags").
     */
    layout: enumField("layout", BROWSE_LAYOUTS, "rows"),
};

export const TagBrowsePage: React.FC<TagBrowsePageProps> = ({
    kind,
    title,
    eyebrow,
    lede,
    sections,
}) => {
    const { hasScope } = useAuth();
    const { seed, reshuffle } = useTagSeed();
    // Three pages share this component, so the view is bound to whichever one this is.
    const pathname = usePathname();
    const browseView = useMemo(() => defineView(pathname, browseFields), [pathname]);
    const [view, apply] = useUrlView(browseView);
    const { sort } = view;
    // The same 300ms the library search and the vocabulary table use.
    const [search, setSearch] = useUrlSearch(
        view.search,
        (settled) => apply({ search: settled }),
        300
    );
    const [done, setDone] = useState<string | null>(null);
    const wide = useBrowseWide();

    return (
        <Stack gap="lg">
            <PagePlate eyebrow={eyebrow} title={title} lede={lede} />

            <BrowseToolbar>
                <SearchInput
                    placeholder={`Find ${title.toLowerCase()}`}
                    value={search}
                    onChange={setSearch}
                    w={wide ? 240 : "100%"}
                    styles={wide ? undefined : { input: { height: BROWSE_TOUCH_HEIGHT } }}
                    aria-label={`Find ${title.toLowerCase()}`}
                />
                <SegmentedControl
                    value={sort}
                    onChange={(value) => apply({ sort: tagBrowseSortSchema.parse(value) })}
                    data={SORTS}
                    color="brass"
                    size="sm"
                    fullWidth={!wide}
                    styles={wide ? undefined : { label: { lineHeight: BROWSE_TOUCH_HEIGHT } }}
                />
                <RowsTilesSwitch
                    value={view.layout}
                    onChange={(layout) => apply({ layout })}
                    touch={!wide}
                />
                {/* Oxblood, the heart's colour, as the library's "Favourites only" is. */}
                <Switch
                    label="Favourites only"
                    color="oxblood"
                    checked={view.favorite}
                    onChange={(event) => apply({ favorite: event.currentTarget.checked })}
                />
                {/* Everything any of them is in, as one grid: the library's Favourites chip
                    for this facet, already on (§14e). Offered once the list is narrowed to
                    favourites, which is when "all of these, together" is the next question. */}
                {view.favorite && (
                    <Button
                        component={Link}
                        href={favoriteTagsHref(kind)}
                        variant="subtle"
                        color="oxblood"
                        size="sm"
                    >
                        See their items
                    </Button>
                )}
                {/* New pictures, not a new order: the rows stay where they are and only the
                    strips and tiles change, which is the difference between refreshing a view and
                    losing your place in it. Not offered for performers' tiles: a tile shows the
                    tag's own picture where it has one, and most performers have a portrait, so the
                    button would change the odd card at best. */}
                {!(kind === "performer" && view.layout === "tiles") && (
                    <Button variant="subtle" color="brass" size="sm" onClick={reshuffle}>
                        Reshuffle pictures
                    </Button>
                )}
            </BrowseToolbar>

            {/* One line, cleared by the next action -- the management page's reason: every
                change from a row's menu is retroactive, and the count is the evidence. */}
            {done && (
                <Alert variant="light" color="brass" onClose={() => setDone(null)} withCloseButton>
                    {done}
                </Alert>
            )}

            <Stack gap="xl">
                {sections.map((section) => (
                    <TagBrowseList
                        key={section.scope}
                        kind={kind}
                        scope={section.scope}
                        search={view.search.trim()}
                        sort={sort}
                        favorite={view.favorite}
                        layout={view.layout}
                        seed={seed}
                        // Your own vocabulary is always yours to curate; the library's is the
                        // administrator's (§6).
                        curator={section.scope === "private" || hasScope("admin")}
                        onDone={setDone}
                        heading={section.heading}
                        empty={section.empty}
                    />
                ))}
            </Stack>
        </Stack>
    );
};
