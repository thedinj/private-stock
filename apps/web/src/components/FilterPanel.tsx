"use client";

import { useState } from "react";
import {
    Anchor,
    Badge,
    Button,
    Group,
    Rating,
    SegmentedControl,
    Stack,
    Switch,
    Text,
} from "@mantine/core";

import {
    BITRATE_BANDS,
    DURATION_BANDS,
    FPS_BANDS,
    RESOLUTION_BANDS,
    SIZE_BANDS,
    allowsPrivate,
    tagKinds,
    type TagScope,
} from "@private-stock/core";

import { facetParams, useFilterNames, useLibraryFacets, useTagNames } from "@/lib/api/facets";
import { describeGroup } from "@/lib/filterWords";
import {
    MEASURES,
    clearFilters,
    fileFilterGroups,
    hasClearableFilters,
    hasLook,
    withMeasure,
    type FileFilterRow,
    type LibraryView,
    type Measure,
    type Orientation,
} from "@/lib/libraryQuery";
import { facetLabel, facetLabelPlural } from "@/lib/facetLabels";
import {
    advancedGroups,
    chipState,
    cycleChip,
    facetMode,
    cycleFavorites,
    cycleNone,
    favoritesState,
    noneState,
    setFacetMode,
    withPicks,
    type ChipState,
    type FacetMode,
} from "@/lib/tagLogic";
import { NobodyGlyph, SomebodyGlyph } from "@/components/media/Glyph";
import { SectionLabel } from "@/components/media/SectionLabel";
import { LookSection } from "@/components/library/LookSection";
import { FacetModal } from "@/components/library/FacetModal";
import { ScopeLabel } from "@/components/tags/ScopeLabel";
import { ChoiceFilter } from "@/components/library/ChoiceFilter";
import { RangeFilter } from "@/components/library/RangeFilter";
import { TriChip } from "@/components/library/TriChip";
import { AdvancedFilterModal } from "@/components/library/AdvancedFilterModal";

import classes from "./FilterPanel.module.scss";

/**
 * Faceted filtering (§5c, §14, §20).
 *
 * **The values are the vocabulary; the numbers are the filter.** Which chips exist does not
 * depend on the size of the library, so a keyword applied to one video appears the moment it
 * is applied. What each chip holds is counted against the *current* filter and is exact, so a
 * value that would dead-end says `(0)` rather than being found out by clicking.
 *
 * The two were one question until they could not be: values were discovered by scanning the
 * filtered library, which is proportional to the library, so the scan stopped at a sample and
 * the list quietly became a guess.
 *
 * **The sections are the point (§14e).** What you decided about an item, what the file
 * measurably is, and what it has been called are different kinds of question, and a single
 * column of switches makes them look like one. They also behave differently in ways somebody
 * has to be able to predict: your marks resolve against whoever is looking, the file is a fact
 * that reads the same for everybody, and each facet after them is a vocabulary that grows.
 *
 * Measurements that cannot apply are absent rather than disabled -- there is no duration to
 * ask about in a library of photographs -- and setting one that only videos can answer moves
 * the Kind control rather than silently emptying the grid.
 *
 * The cost is one extra request per filter change, and it is proportional to how much has
 * been tagged rather than to how much there is: the counts are asked of the chips about to be
 * drawn, one indexed lookup per assignment. That is the difference between a filter people
 * trust and one they stop using after it lies to them twice.
 */

interface FilterPanelProps {
    view: LibraryView;
    onChange: (next: LibraryView) => void;
    /**
     * Whether to draw its own "Filters" heading.
     *
     * False inside the phone drawer, which already has a title bar two hundred pixels above
     * saying the same word.
     */
    heading?: boolean;
    /**
     * Whether to offer its own "Clear all".
     *
     * False in the desktop rail, where the chips beside the count are on screen at the same
     * time and carry their own -- two "clear all"s a few hundred pixels apart was one control
     * too many. True in the phone drawer, which covers the chips.
     */
    clearAll?: boolean;
}

/**
 * A section's name, and how many of its filters are on.
 *
 * The count is what a collapsed-by-default panel owes the reader. Every measurement row says
 * its own value, but they are eight rows in a scrolling column -- the badge answers "is
 * anything on down there" without a scroll, which is the question the panel got worse at the
 * moment it grew (§14e).
 */
const SectionHeading: React.FC<{ label: string; count: number }> = ({ label, count }) => (
    <Group gap={6} align="center">
        {/* The house label for a group inside a panel, as the viewer's strips use (§14). */}
        <SectionLabel>{label}</SectionLabel>
        {count > 0 && (
            <Badge size="xs" circle variant="light" color="brass">
                {count}
            </Badge>
        )}
    </Group>
);

/**
 * "Videos" rather than "Videos only", which reads as a filter that shows only videos —
 * confusing beside the Kind control, and doubly so because setting a row underneath does
 * exactly that. The headings themselves come from `fileFilterGroups`.
 */
const MOVEMENTS: { value: "yes" | "no"; label: string }[] = [
    { value: "yes", label: "Animated" },
    { value: "no", label: "Stills" },
];

/**
 * "Your 2 favourite performers": the ♥ chip's name, for its tooltip and accessible name.
 *
 * The chip itself says only "♥". It once spelled this out with both numbers -- "♥ 2 favourite
 * performers · 3 items" -- which was the widest thing in the section, and then "♥ (3)", the
 * items under the filter; that number went with the rest of the filter counts (§20 "Facets
 * without counts").
 */
const favoritesName = (kind: string, tags: number): string => {
    const noun = tags === 1 ? facetLabel(kind) : facetLabelPlural(kind);

    return `Your ${tags} favourite ${noun.toLowerCase()}`;
};

/**
 * The None chip's face, beside the ♥ (§14e), while it is off or set to "nobody yet".
 *
 * On performers: off it is a face drawn whole, because the first click asks for "any
 * performer"; set, a face drawn in dashes, nobody being there. Every facet whose "none" is not a
 * person has a dash -- the table's mark for no value.
 */
const noneGlyph = (kind: string, state: ChipState): React.ReactNode =>
    kind !== "performer" ? (
        "—"
    ) : state === "off" ? (
        <SomebodyGlyph size={14} />
    ) : (
        <NobodyGlyph size={14} />
    );

/**
 * None's third state, said the positive way round: "has some performer", drawn as a face
 * rather than as nobody struck through -- which read as the double negative it was.
 */
const someoneOf = (kind: string): { name: string; display: React.ReactNode } => ({
    name: `Some ${facetLabel(kind).toLowerCase()} tagged`,
    display:
        kind === "performer" ? (
            <>
                <SomebodyGlyph size={14} /> any
            </>
        ) : (
            "any"
        ),
});

/** `leadPick` keys for the two chips that have no tag id. */
const LEAD_FAVORITES = "♥";
const LEAD_NONE = "none";

/**
 * The first "with" chip of an "any of" facet, in the order they are drawn -- ♥, None, then the
 * tags box by box -- or null when the facet is in "all of".
 *
 * Every pick after it says "or" where its tick would be, so the row reads as the sentence it
 * is: "♥, or nobody tagged yet". The mode control under the chips says the same thing, but it
 * is under every tag in the section and easy never to see.
 */
const leadPick = (
    view: LibraryView,
    kind: string,
    boxes: { facet?: { values: { tagId: string }[] } }[]
): string | null => {
    if (facetMode(view, kind) !== "any") return null;
    if (favoritesState(view, kind) === "with") return LEAD_FAVORITES;
    if (noneState(view, kind) === "with") return LEAD_NONE;

    for (const { facet } of boxes) {
        const first = facet?.values.find(({ tagId }) => chipState(view, tagId) === "with");

        if (first) return first.tagId;
    }

    return null;
};

/** Whether this chip is an alternative to an earlier one: picked, in "any of", and not first. */
const isAlternative = (lead: string | null, key: string): boolean => lead !== null && lead !== key;

const ORIENTATIONS: { value: Orientation; label: string }[] = [
    { value: "landscape", label: "Landscape" },
    { value: "portrait", label: "Portrait" },
    { value: "square", label: "Square" },
];

export const FilterPanel: React.FC<FilterPanelProps> = ({
    view,
    onChange,
    heading = true,
    clearAll = true,
}) => {
    /**
     * Which measurements are worth offering, given what is on screen.
     *
     * A control that cannot work is absent rather than disabled (§14): a library filtered to
     * images has no duration to ask about, and a greyed-out row of bands would be five things
     * to read past on every visit. With no kind chosen, everything is offered — and choosing
     * one of the narrow ones sets the kind, so the question and the set it applies to stay
     * consistent without anybody having to do it in two steps.
     */

    const setMeasure = (measure: Measure) => (min: number | null, max: number | null) =>
        onChange(withMeasure(view, measure, min, max));

    const markFilterCount =
        (view.favorite ? 1 : 0) +
        (view.unrated ? 1 : 0) +
        (view.watched ? 1 : 0) +
        (view.minRating !== null || view.maxRating !== null ? 1 : 0);

    const fileFilterCount =
        MEASURES.filter(
            (measure) => view.measures[measure].min !== null || view.measures[measure].max !== null
        ).length +
        (view.orientation ? 1 : 0) +
        (view.animated ? 1 : 0);

    const { data, isLoading } = useLibraryFacets(view);
    const { data: tagNames } = useTagNames(view);

    const facets = data?.facets ?? [];

    /**
     * Which facet a tag id belongs to, from what the panel has just been sent.
     *
     * The view holds ids alone, and switching a facet between "all of" and "any of" has to know
     * which of the flat `tags` are that facet's. Every id the filter names comes back from
     * `useTagNames`, and every chip drawn in its facet's values.
     */
    const kindOf = (tagId: string): string | undefined =>
        tagNames?.referencedTags[tagId]?.kind ??
        facets.find((facet) => facet.values.some((value) => value.tagId === tagId))?.kind;

    const [advancedOpen, setAdvancedOpen] = useState(false);
    const names = useFilterNames(view);
    const advancedCount = advancedGroups(view).length;

    /**
     * The facets, laid out exactly as the item page's tag editor lays them out (§14b).
     *
     * Keywords, Performers and Sources share a table and nothing else a person cares about: a
     * performer is who is in it, a source is where it came from, a keyword is what somebody
     * called it. So each is a section of its own, and inside it one box per system -- Shared,
     * then Private, on Keywords alone, the only facet that can be private (§6). The same sections, in the same order,
     * with the same line over each box, as where the tags were written: a filter that grouped
     * them differently would be a second vocabulary for one set of things.
     *
     * **Only what has something in it is drawn.** Every facet and box used to be, empty or not,
     * as the editor draws them -- so a library with no sources said "No sources yet" in the
     * middle of a filter, on every visit, about a filter nobody could use. The objection was
     * that a section appearing would move everything below it the first time; but a tag is
     * never made from this panel, so that move happens while nobody is pointing at it. A facet
     * a scraper invented follows, if anything carries it.
     */
    const sections = [
        ...tagKinds,
        ...new Set(
            facets.map((facet) => facet.kind).filter((kind) => !tagKinds.includes(kind as never))
        ),
    ]
        .map((kind) => {
            const scopes: TagScope[] = allowsPrivate(kind) ? ["public", "private"] : ["public"];
            const allBoxes = scopes.map((scope) => ({
                scope,
                facet: facets.find((facet) => facet.kind === kind && facet.scope === scope),
            }));
            const picks = withPicks(view, kind, kindOf);
            const boxes = allBoxes.filter(({ facet }) => (facet?.values.length ?? 0) > 0);

            return {
                kind,
                boxes,
                picks,
                lead: leadPick(view, kind, boxes),
                // The ♥ chip lives on whichever box the server attached it to: one per facet.
                favorites: allBoxes.find((box) => box.facet?.favorites)?.facet?.favorites ?? null,
                // Counted against the section's own picks, or every selection would be reported
                // under every heading -- "without" chips included, since they narrow too.
                selected:
                    picks +
                    view.notTags.filter((tagId) => kindOf(tagId) === kind).length +
                    (favoritesState(view, kind) === "without" ? 1 : 0) +
                    (noneState(view, kind) === "without" ? 1 : 0),
            };
        })
        // A section with a pick in it stays, chips or not: its heading's count is the only
        // place in the panel that says the pick is there.
        .filter(
            (section) =>
                section.boxes.length > 0 || section.favorites !== null || section.selected > 0
        );

    /**
     * The facet opened in full, or null. One at a time: it is a modal.
     *
     * The system as well as the facet, because both have a `tag` facet and the kind alone no
     * longer identifies one (§6).
     */
    const [expanded, setExpanded] = useState<{ kind: string; scope: TagScope } | null>(null);

    /**
     * Which row in "The file" is open, or null for all closed.
     *
     * One at a time, and closed by default. Every row open at once is the state that made the
     * panel unusable -- about 500px of wrapped chips in a 260px column, which put the tag
     * facets below the fold on a 1080p screen. Opening one closes the last, so the panel's
     * height stays roughly constant however long somebody spends in it.
     *
     * Keyed by a plain string rather than by `Measure`, because orientation and movement are
     * not measurements and still belong in the same one-at-a-time group: two rows in one
     * section that opened independently would imply a difference in how they behave, and
     * there is none.
     */
    const [openRow, setOpenRow] = useState<string | null>(null);

    const rowProps = (id: string) => ({
        open: openRow === id,
        onToggle: () => setOpenRow((current) => (current === id ? null : id)),
    });

    const measureProps = (measure: Measure) => ({
        ...rowProps(measure),
        onChange: setMeasure(measure),
        ...view.measures[measure],
    });

    /**
     * One row of "The file", by name.
     *
     * A switch rather than a lookup table built above the component, because every arm closes
     * over `view` and `onChange`. Exhaustive by type, so adding a row to `fileFilterGroups`
     * without giving it a control is a compile error rather than a gap in the panel.
     */
    const renderRow = (row: FileFilterRow) => {
        switch (row) {
            case "resolution":
                return (
                    <RangeFilter
                        key={row}
                        label="Resolution"
                        bands={RESOLUTION_BANDS}
                        unit="px"
                        hint="Measured on the shorter side, so an upright video is judged by its width."
                        {...measureProps("resolution")}
                    />
                );
            case "sizeMb":
                return (
                    <RangeFilter
                        key={row}
                        label="File size"
                        bands={SIZE_BANDS}
                        unit="MB"
                        {...measureProps("sizeMb")}
                    />
                );
            case "durationSec":
                return (
                    <RangeFilter
                        key={row}
                        label="Length"
                        bands={DURATION_BANDS}
                        unit="sec"
                        {...measureProps("durationSec")}
                    />
                );
            case "bitrateKbps":
                return (
                    <RangeFilter
                        key={row}
                        label="Bit rate"
                        bands={BITRATE_BANDS}
                        unit="kbps"
                        {...measureProps("bitrateKbps")}
                    />
                );
            case "fps":
                return (
                    <RangeFilter
                        key={row}
                        label="Frame rate"
                        bands={FPS_BANDS}
                        unit="fps"
                        {...measureProps("fps")}
                    />
                );
            case "orientation":
                return (
                    <ChoiceFilter
                        key={row}
                        label="Orientation"
                        options={ORIENTATIONS}
                        value={view.orientation}
                        onChange={(orientation) => onChange({ ...view, orientation })}
                        {...rowProps("orientation")}
                    />
                );
            case "animated":
                return (
                    <ChoiceFilter
                        key={row}
                        label="Movement"
                        options={MOVEMENTS}
                        value={view.animated}
                        onChange={(animated) =>
                            onChange({
                                ...view,
                                animated,
                                // Asking whether a picture moves is a question only an image
                                // can answer, so the view narrows to say so rather than
                                // emptying itself of every video without comment.
                                kind: animated === null ? view.kind : "image",
                            })
                        }
                        {...rowProps("animated")}
                    />
                );
        }
    };

    return (
        // No left inset: every container this goes into has already paid for one. In the
        // sidebar that put the panel 16px right of the page title directly above it, and in
        // the phone drawer it put these controls 12px right of the ones above them.
        <Stack gap="lg" pt="md" pr="md" pb="md">
            <Group justify="space-between" align="center">
                <Group gap={6} align="baseline">
                    {heading && <Text fw={600}>Filters</Text>}
                </Group>

                {clearAll && hasClearableFilters(view) && (
                    <Button
                        variant="subtle"
                        size="compact-sm"
                        color="brass"
                        onClick={() => onChange(clearFilters(view))}
                    >
                        Clear all
                    </Button>
                )}
            </Group>

            <SectionHeading label="Look" count={hasLook(view) ? 1 : 0} />

            <LookSection view={view} onChange={onChange} />

            <SectionHeading label="Your marks" count={markFilterCount} />

            <Stack gap="xs">
                <Switch
                    label="Favourites only"
                    color="oxblood"
                    checked={view.favorite}
                    onChange={(event) =>
                        onChange({ ...view, favorite: event.currentTarget.checked })
                    }
                />

                <Switch
                    label="Unrated only"
                    color="brass"
                    checked={view.unrated}
                    onChange={(event) =>
                        // Mutually exclusive with a minimum rating: an item cannot be both
                        // unrated and rated at least three, so allowing both would guarantee
                        // an empty grid with no obvious cause.
                        onChange({
                            ...view,
                            unrated: event.currentTarget.checked,
                            minRating: event.currentTarget.checked ? null : view.minRating,
                        })
                    }
                />

                {/* Three states, so a segmented control rather than the switches above.
                    A switch can only offer "watched only", and the companion people
                    actually reach for is the other one: "unrated only" pairs with
                    "unwatched only" (§14b). */}
                <Group gap="xs" align="center">
                    <Text size="sm" c="dimmed">
                        Watched
                    </Text>
                    <SegmentedControl
                        size="xs"
                        color="brass"
                        value={view.watched ?? "any"}
                        onChange={(value) =>
                            onChange({
                                ...view,
                                watched: value === "any" ? null : (value as "yes" | "no"),
                            })
                        }
                        data={[
                            { value: "any", label: "Any" },
                            // Yes and no, because the row already asks the question.
                            // Spelling the answers out again -- "Seen", "Unseen" -- renamed
                            // the control in the middle of itself, and the chip it produced
                            // then made one filter look like two.
                            { value: "yes", label: "Yes" },
                            { value: "no", label: "No" },
                        ]}
                    />
                </Group>

                {/* Two rows rather than one two-ended control, because "at least" is the
                    question nearly everybody asks and it should cost one click. "At most" is
                    the re-review case — three stars and under, to go back through — and it
                    reads as a second thought because it is one. */}
                <Group
                    gap="xs"
                    align="center"
                    className={view.minRating === null ? classes.quiet : undefined}
                >
                    <Text size="sm" c="dimmed" w={58}>
                        At least
                    </Text>
                    <Rating
                        value={view.minRating ?? 0}
                        color="brass"
                        size="sm"
                        onChange={(value) =>
                            onChange({
                                ...view,
                                // Clicking the current minimum clears it — the only way back
                                // to "any rating" without a separate control.
                                minRating: value === view.minRating ? null : value,
                                unrated: false,
                            })
                        }
                    />
                </Group>

                <Group
                    gap="xs"
                    align="center"
                    className={view.maxRating === null ? classes.quiet : undefined}
                >
                    <Text size="sm" c="dimmed" w={58}>
                        At most
                    </Text>
                    <Rating
                        value={view.maxRating ?? 0}
                        color="brass"
                        size="sm"
                        onChange={(value) =>
                            onChange({
                                ...view,
                                maxRating: value === view.maxRating ? null : value,
                                unrated: false,
                            })
                        }
                    />
                </Group>
            </Stack>

            <SectionHeading label="The file" count={fileFilterCount} />

            {/* Tight, because each child is one row rather than a block of chips. Which rows
                appear, in which groups, is decided by `fileFilterGroups` rather than by
                conditionals here -- it is a question with a right answer, and a JSX tree of
                `showVideoMeasures &&` is one nobody can check (§14e). */}
            <Stack gap={2}>
                {fileFilterGroups(view.kind).map((group) => (
                    // Keyed by its first row: filtered to one kind every label is null, and
                    // keying on the label gave each group the same key.
                    <Stack key={group.rows[0] ?? group.label} gap={2}>
                        {group.label && (
                            <Text size="xs" c="dimmed" fs="italic" pt={8}>
                                {group.label}
                            </Text>
                        )}
                        {group.rows.map((row) => renderRow(row))}
                    </Stack>
                ))}
            </Stack>

            {sections.map((section) => (
                <Stack key={section.kind} gap="xs">
                    <SectionHeading
                        label={facetLabelPlural(section.kind)}
                        count={section.selected}
                    />

                    <Group gap={6}>
                        {/* Favourites ♥ (§14e): any of your favourite tags of this facet, live
                            -- so a saved view keeps up as favourites change. Absent until
                            somebody has a favourite here, rather than a chip that can only ever
                            say nought. */}
                        {section.favorites !== null && (
                            <TriChip
                                accent="oxblood"
                                name={favoritesName(section.kind, section.favorites.tags)}
                                state={favoritesState(view, section.kind)}
                                onCycle={() => onChange(cycleFavorites(view, section.kind))}
                                display="♥"
                                or={isAlternative(section.lead, LEAD_FAVORITES)}
                            />
                        )}
                        {/* None (§14e): nothing of this facet tagged yet, or -- without -- at
                            least something. Uncounted: see `TriChip`'s count. */}
                        <TriChip
                            name={`No ${facetLabel(section.kind).toLowerCase()} tagged`}
                            state={noneState(view, section.kind)}
                            onCycle={() => onChange(cycleNone(view, section.kind, kindOf))}
                            display={noneGlyph(section.kind, noneState(view, section.kind))}
                            opposite={someoneOf(section.kind)}
                            or={isAlternative(section.lead, LEAD_NONE)}
                        />
                    </Group>

                    {section.boxes.map(({ scope, facet }) => (
                        <Stack key={scope} gap={4}>
                            {/* The item page's line, where it has anything to say: Shared
                                or Private on Keywords, the only facet that can be either
                                (§6), and "show all" when the facet has more than it shows. A
                                performer or a source is never called shared. */}
                            {/* Shared needs no saying when it is the only box drawn; Private
                                always does, being yours alone. */}
                            {(scope === "private" ||
                                section.boxes.length > 1 ||
                                facet?.truncated) && (
                                <Group gap={6} align="center" wrap="nowrap">
                                    {(scope === "private" || section.boxes.length > 1) && (
                                        <ScopeLabel scope={scope} />
                                    )}
                                    {/* The badge was a label saying values were hidden, with no
                                        way to see them -- which is a fact somebody can do
                                        nothing with. It is the control now, and it says how
                                        many there are, so agreeing to open it is not agreeing
                                        to an unknown amount of scrolling. */}
                                    {facet?.truncated && (
                                        <Anchor
                                            component="button"
                                            type="button"
                                            size="xs"
                                            c="brass.4"
                                            underline="never"
                                            onClick={() =>
                                                setExpanded({ kind: section.kind, scope })
                                            }
                                        >
                                            show all {facet.total.toLocaleString()}
                                        </Anchor>
                                    )}
                                </Group>
                            )}

                            <Group gap={6}>
                                {facet?.values.map((value) => (
                                    <TriChip
                                        key={value.tagId}
                                        name={value.name}
                                        count={value.uses}
                                        state={chipState(view, value.tagId)}
                                        onCycle={() =>
                                            onChange(cycleChip(view, value.tagId, section.kind))
                                        }
                                        or={isAlternative(section.lead, value.tagId)}
                                    />
                                ))}
                            </Group>
                        </Stack>
                    ))}

                    {/* "All of" or "any of", offered once there is a choice to make: with
                        nought or one pick the two are the same filter (§14e). Said in words,
                        never AND and OR, which people reliably read the wrong way round. Under
                        the chips rather than above them, so it arriving on the second pick does
                        not push the chip just clicked out from under the pointer. */}
                    {section.picks >= 2 && (
                        <Group gap={6} align="center" wrap="nowrap">
                            <Text size="xs" c="dimmed">
                                Items with
                            </Text>
                            <SegmentedControl
                                size="xs"
                                color="brass"
                                value={facetMode(view, section.kind)}
                                onChange={(mode) =>
                                    onChange(
                                        setFacetMode(view, section.kind, mode as FacetMode, kindOf)
                                    )
                                }
                                data={[
                                    { value: "all", label: "all of these" },
                                    { value: "any", label: "any of these" },
                                ]}
                                aria-label={`Match all or any of the picked ${facetLabelPlural(section.kind).toLowerCase()}`}
                            />
                        </Group>
                    )}
                </Stack>
            ))}

            <FacetModal
                kind={expanded?.kind ?? null}
                scope={expanded?.scope ?? "public"}
                label={facetLabelPlural(expanded?.kind ?? "")}
                filterParams={facetParams(view)}
                view={view}
                onChange={onChange}
                onClose={() => setExpanded(null)}
            />

            {/* Once, on the first visit only: every later filter change keeps the last answer
                on screen while the next is asked for (`useLibraryFacets`). */}
            {isLoading && (
                <Text size="sm" c="dimmed">
                    Loading tags…
                </Text>
            )}

            {!isLoading && facets.length === 0 && (
                <Text size="sm" c="dimmed">
                    Tags added on an item&apos;s page show up here as filters.
                </Text>
            )}

            {/* The door to everything the sections cannot say: "or" across facets, "none of",
                the file and your marks mixed in one condition (§14e). At the foot because it
                is the last resort, not the first -- most questions are answered above -- but a
                full-width button that says what it is for, and that says what it is doing once
                it is doing something: a subtle link at the bottom of a long column was found
                by nobody, and a group in force there was invisible from the panel. */}
            <Stack gap={6}>
                <SectionHeading label="Advanced" count={advancedCount} />
                {advancedGroups(view).map((group, index) => (
                    <Text key={index} size="xs" c="dimmed">
                        {index > 0 ? "and also " : "Items matching "}
                        <Text span fw={600} c="var(--mantine-color-text)">
                            {describeGroup(group, names)}
                        </Text>
                    </Text>
                ))}
                <Button
                    variant="light"
                    color="brass"
                    fullWidth
                    onClick={() => setAdvancedOpen(true)}
                >
                    {advancedCount > 0 ? "Edit advanced filters…" : "Combine with any / none of…"}
                </Button>
            </Stack>

            <AdvancedFilterModal
                opened={advancedOpen}
                view={view}
                onApply={(next) => {
                    onChange(next);
                    setAdvancedOpen(false);
                }}
                onClose={() => setAdvancedOpen(false)}
            />
        </Stack>
    );
};
