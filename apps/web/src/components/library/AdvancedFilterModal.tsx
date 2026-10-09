"use client";

import { useMemo, useState } from "react";
import {
    Badge,
    Box,
    Button,
    CloseButton,
    Divider,
    Group,
    Modal,
    MultiSelect,
    NumberInput,
    Paper,
    Rating,
    SegmentedControl,
    Select,
    Stack,
    Text,
} from "@mantine/core";
import { useDebouncedValue, useMediaQuery } from "@mantine/hooks";
import { useQuery } from "@tanstack/react-query";

import {
    FILTER_GROUP_LIMIT,
    FILTER_RULE_LIMIT,
    allowsPrivate,
    bandFor,
    type FilterMatch,
    type FilterRule,
    type MediaCountResponse,
    type Tag,
} from "@private-stock/core";

import { activeFilters } from "@/lib/activeFilters";
import {
    blankGroup,
    blankRow,
    draftToGroups,
    exampleGroups,
    groupsToDraft,
    rowFor,
    rowRules,
    subjectFromKey,
    subjectKey,
    subjectOptions,
    type DraftGroup,
    type DraftRow,
    type FacetValue,
} from "@/lib/advancedDraft";
import { api } from "@/lib/api/client";
import { useLibraryFacets } from "@/lib/api/facets";
import { useLibraries } from "@/lib/api/libraries";
import { queryKeys } from "@/lib/api/queryKeys";
import { useTagSuggestions } from "@/lib/api/tags";
import { facetLabelPlural } from "@/lib/facetLabels";
import { MEASURE_LABELS, describeGroup, type FilterNames } from "@/lib/filterWords";
import { viewToRequestParams, type LibraryView } from "@/lib/libraryQuery";
import { advancedGroups, withAdvancedGroups } from "@/lib/tagLogic";

import classes from "./AdvancedFilterModal.module.scss";

/**
 * The Advanced filter editor (§14e "Advanced groups").
 *
 * For what the panel's sections cannot say: "or" across facets, "none of", and your marks and
 * the file mixed in one condition. A list of groups, each matching any, all or none of its
 * rows, every group ANDed with each other and with the panel. One level, so the whole thing
 * still reads back as a sentence.
 *
 * **Each row says what it is about.** `[Subject ▾] [value] [×]` -- "Performer is chris, ♥ my
 * favourites", "Length 20–60 min", "Rating at least ★★★★". It used to be a bare value per
 * rule, so "chris" and "Unrated" sat side by side with nothing saying one was a person and the
 * other a mark, added from a 25-item menu that ran off the screen. The subject is chosen from
 * a searchable list in the panel's own words and order; a facet's favourites and "has none"
 * are options of its row rather than nine more menu entries.
 *
 * **It shows what it will do before it does it.** What else is already filtering, the
 * sentence the groups make, and how many items that leaves -- counted live, so Apply is
 * "Show 37 items" and not a commitment made blind.
 */

interface AdvancedFilterModalProps {
    opened: boolean;
    view: LibraryView;
    onApply: (next: LibraryView) => void;
    onClose: () => void;
}

export const AdvancedFilterModal: React.FC<AdvancedFilterModalProps> = ({
    opened,
    view,
    onApply,
    onClose,
}) => {
    const phone = useMediaQuery("(max-width: 48em)");

    return (
        <Modal
            opened={opened}
            onClose={onClose}
            title="Advanced filters"
            size="xl"
            fullScreen={phone}
            // Pinned near the top rather than centred: centred, every row added moved the
            // header and the buttons, so the thing just clicked slid out from under the pointer.
            yOffset="6dvh"
            // A draft is minutes of work, and Escape is also how a person closes a dropdown
            // inside it: with these on, dismissing the tag list threw the whole editor away.
            // Cancel and the × are the ways out.
            closeOnEscape={false}
            closeOnClickOutside={false}
        >
            {/* Mounted only while open, so each opening starts from the view as it is now
                rather than from a draft somebody abandoned last time. */}
            {opened && <AdvancedEditor view={view} onApply={onApply} onClose={onClose} />}
        </Modal>
    );
};

const MATCHES: { value: FilterMatch; label: string }[] = [
    { value: "any", label: "any of" },
    { value: "all", label: "all of" },
    { value: "none", label: "none of" },
];

const AdvancedEditor: React.FC<Omit<AdvancedFilterModalProps, "opened">> = ({
    view,
    onApply,
    onClose,
}) => {
    const { data: facets } = useLibraryFacets(view);
    const { data: libraries } = useLibraries();
    // Names of tags picked here, which the facet response has not heard of yet.
    const [picked, setPicked] = useState<Record<string, string>>({});

    const names: FilterNames = {
        tag: (tagId) => picked[tagId] ?? facets?.referencedTags[tagId]?.name,
        root: (rootId) => libraries?.libraries.find((library) => library.id === rootId)?.label,
    };

    const original = advancedGroups(view);
    const [draft, setDraft] = useState<DraftGroup[]>(() => {
        const loaded = groupsToDraft(original, (tagId) => facets?.referencedTags[tagId]?.kind);

        // An empty editor opens on one group with one blank row, so the first click is
        // choosing what to filter by rather than finding the button that makes a place for it.
        return loaded.length > 0 ? loaded : [blankGroup()];
    });

    const finished = useMemo(() => draftToGroups(draft), [draft]);
    const changed = JSON.stringify(finished) !== JSON.stringify(original);
    const pristine =
        original.length === 0 &&
        draft.length === 1 &&
        draft[0]?.rows.length === 1 &&
        draft[0].rows[0]?.subject === null;

    /** Everything already narrowing the grid that this editor does not own, in the chips' words. */
    const alreadyFiltering = activeFilters(withAdvancedGroups(view, []), names);

    // Counted live, debounced so a run of clicks is one request.
    const draftParams = viewToRequestParams(withAdvancedGroups(view, finished)).toString();
    const [countParams] = useDebouncedValue(draftParams, 300);
    const count = useQuery({
        queryKey: queryKeys.media.count(countParams),
        queryFn: () => api<MediaCountResponse>(`/api/media/count?${countParams}`),
        staleTime: 60_000,
    });
    const total = countParams === draftParams ? count.data?.total : undefined;

    const updateGroup = (key: number, change: (group: DraftGroup) => DraftGroup) =>
        setDraft((groups) => groups.map((group) => (group.key === key ? change(group) : group)));

    const applyLabel =
        finished.length === 0 && original.length > 0
            ? "Clear advanced filters"
            : total === undefined
              ? "Show items"
              : `Show ${total.toLocaleString()} ${total === 1 ? "item" : "items"}`;

    return (
        <Stack gap="md" className={classes.editor}>
            {alreadyFiltering.length > 0 && (
                <Paper bg="dark.7" p="sm" radius="sm">
                    <Stack gap={6}>
                        <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                            Already filtering
                        </Text>
                        <Group gap={6}>
                            {alreadyFiltering.map((filter) => (
                                <Badge
                                    key={filter.id}
                                    variant="outline"
                                    color="brass"
                                    tt="none"
                                    fw={500}
                                >
                                    {filter.label}
                                </Badge>
                            ))}
                        </Group>
                        <Text size="xs" c="dimmed">
                            The rules below narrow this further. Change these in the filter panel.
                        </Text>
                    </Stack>
                </Paper>
            )}

            {draft.map((group, index) => (
                <Stack key={group.key} gap="md">
                    {index > 0 && (
                        <Divider
                            label="and also"
                            labelPosition="center"
                            color="dark.4"
                            styles={{ label: { fontSize: "var(--mantine-font-size-sm)" } }}
                        />
                    )}
                    <GroupCard
                        group={group}
                        view={view}
                        names={names}
                        onChange={(next) => updateGroup(group.key, () => next)}
                        onRemove={() =>
                            setDraft((groups) =>
                                groups.filter((candidate) => candidate.key !== group.key)
                            )
                        }
                        onPicked={(tag) =>
                            setPicked((current) => ({ ...current, [tag.id]: tag.name }))
                        }
                    />
                </Stack>
            ))}

            {draft.length < FILTER_GROUP_LIMIT && (
                <Button
                    variant="light"
                    color="brass"
                    w="fit-content"
                    onClick={() => setDraft((groups) => [...groups, blankGroup()])}
                >
                    + Add group
                </Button>
            )}

            {pristine && (
                <Stack gap={6}>
                    <Text size="sm" c="dimmed">
                        Or start from one of these:
                    </Text>
                    <Group gap="xs">
                        {exampleGroups().map((example) => (
                            <Button
                                key={example.label}
                                variant="default"
                                size="xs"
                                onClick={() => setDraft([example.group])}
                            >
                                {example.label}
                            </Button>
                        ))}
                    </Group>
                </Stack>
            )}

            <Divider color="dark.5" />

            {/* The whole thing read back as a sentence, beside the number it leaves: the check on
                a filter built from pieces is whether it still says what was meant. */}
            <Group justify="space-between" align="flex-end" gap="md" wrap="wrap">
                <Box style={{ flex: 1, minWidth: 220 }}>
                    {finished.length > 0 ? (
                        <Text size="sm">
                            Items matching{" "}
                            {finished.map((group, index) => (
                                <Text span key={index} fw={600}>
                                    {index > 0 && (
                                        <Text span fw={400}>
                                            {" "}
                                            and also{" "}
                                        </Text>
                                    )}
                                    {describeGroup(group, names)}
                                </Text>
                            ))}
                        </Text>
                    ) : (
                        <Text size="sm" c="dimmed">
                            No rules yet. Choose what to filter by above.
                        </Text>
                    )}
                </Box>
                <Group gap="sm" wrap="nowrap">
                    <Button variant="default" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button
                        color="brass"
                        disabled={!changed}
                        onClick={() => onApply(withAdvancedGroups(view, finished))}
                    >
                        {applyLabel}
                    </Button>
                </Group>
            </Group>
        </Stack>
    );
};

interface GroupCardProps {
    group: DraftGroup;
    view: LibraryView;
    names: FilterNames;
    onChange: (group: DraftGroup) => void;
    onRemove: () => void;
    onPicked: (tag: Tag) => void;
}

/** One group: "Match [any of ▾] these", its rows, and a way to add another. */
const GroupCard: React.FC<GroupCardProps> = ({
    group,
    view,
    names,
    onChange,
    onRemove,
    onPicked,
}) => {
    const ruleCount = group.rows.reduce((sum, row) => sum + rowRules(row).length, 0);

    const setRow = (key: number, row: DraftRow) =>
        onChange({ ...group, rows: group.rows.map((entry) => (entry.key === key ? row : entry)) });

    return (
        <Paper
            withBorder
            radius="md"
            p="md"
            // A "none of" group takes away rather than narrows, so its whole hairline turns
            // oxblood -- the colour the chips use for without. The words say it too; this is the
            // glance. No coloured side-stripe: one thick edge on a card is decoration, not a cue.
            style={
                group.match === "none"
                    ? { borderColor: "var(--mantine-color-oxblood-8)" }
                    : undefined
            }
        >
            <Stack gap="sm">
                <Group justify="space-between" wrap="nowrap">
                    <Group gap="xs" wrap="nowrap">
                        <Text size="sm">Match</Text>
                        <Select
                            size="sm"
                            w={120}
                            data={MATCHES}
                            value={group.match}
                            onChange={(value) =>
                                value && onChange({ ...group, match: value as FilterMatch })
                            }
                            allowDeselect={false}
                            aria-label="How this group's rules combine"
                        />
                        <Text size="sm">these</Text>
                    </Group>
                    <CloseButton size="lg" aria-label="Remove this group" onClick={onRemove} />
                </Group>

                {group.rows.map((row) => (
                    <RuleRow
                        key={row.key}
                        row={row}
                        view={view}
                        names={names}
                        onChange={(next) => setRow(row.key, next)}
                        onRemove={() =>
                            onChange({
                                ...group,
                                rows: group.rows.filter((entry) => entry.key !== row.key),
                            })
                        }
                        onPicked={onPicked}
                    />
                ))}

                {ruleCount < FILTER_RULE_LIMIT && (
                    <Button
                        variant="subtle"
                        color="brass"
                        size="compact-sm"
                        w="fit-content"
                        onClick={() => onChange({ ...group, rows: [...group.rows, blankRow()] })}
                    >
                        + Add rule
                    </Button>
                )}
            </Stack>
        </Paper>
    );
};

interface RuleRowProps {
    row: DraftRow;
    view: LibraryView;
    names: FilterNames;
    onChange: (row: DraftRow) => void;
    onRemove: () => void;
    onPicked: (tag: Tag) => void;
}

/** `[Subject ▾] [value] [×]`: every row says what it is about first. */
const RuleRow: React.FC<RuleRowProps> = ({ row, view, names, onChange, onRemove, onPicked }) => {
    /**
     * A finger, not a pointer. Focusing a searchable field on a phone raises the keyboard over
     * half the screen before anybody has decided to type; there the list opens and waits to be
     * tapped instead.
     */
    const touch = useMediaQuery("(pointer: coarse)");

    return (
        <Paper bg="dark.6" radius="sm" p="xs">
            <Group gap="xs" wrap="nowrap" align="flex-start">
                <Group gap="xs" wrap="wrap" align="flex-start" style={{ flex: 1, minWidth: 0 }}>
                    <Select
                        size="sm"
                        w={160}
                        placeholder="Filter by…"
                        searchable
                        data={subjectOptions(view.kind)}
                        value={row.subject ? subjectKey(row.subject) : null}
                        onChange={(key) => key && onChange(rowFor(subjectFromKey(key), row.key))}
                        allowDeselect={false}
                        // Open and focused on arrival for a blank row: choosing the subject is the next
                        // thing to do, and typing "len" should find Length without a click first.
                        defaultDropdownOpened={row.subject === null}
                        // `data-autofocus` rather than `autoFocus`: the modal's focus trap moves focus
                        // to its first control -- the close button -- unless something carries this, and
                        // then Enter after typing a subject pressed ×.
                        data-autofocus={row.subject === null && !touch ? true : undefined}
                        // Typing replaces the current subject rather than appending to its label --
                        // "Favouriteperf" matched nothing -- and Enter takes the first match.
                        onFocus={(event) => event.currentTarget.select()}
                        selectFirstOptionOnChange
                        maxDropdownHeight={320}
                        comboboxProps={{ withinPortal: true }}
                        aria-label="What this rule filters by"
                    />
                    <RowValue row={row} names={names} onChange={onChange} onPicked={onPicked} />
                </Group>
                <CloseButton size="lg" aria-label="Remove this rule" onClick={onRemove} />
            </Group>
        </Paper>
    );
};

interface RowValueProps {
    row: DraftRow;
    names: FilterNames;
    onChange: (row: DraftRow) => void;
    onPicked: (tag: Tag) => void;
}

const withRule = (row: DraftRow, rule: FilterRule | null): DraftRow => ({ ...row, rule });

/** The part of a row after its subject. */
const RowValue: React.FC<RowValueProps> = ({ row, names, onChange, onPicked }) => {
    const { subject, rule } = row;

    if (!subject) return null;

    switch (subject.type) {
        case "facet":
            return (
                <FacetValueInput
                    kind={subject.kind}
                    value={row.facet}
                    names={names}
                    onChange={(facet) => onChange({ ...row, facet })}
                    onPicked={onPicked}
                />
            );
        case "favorite":
            return (
                <Text size="sm" c="dimmed">
                    is marked ♥ favourite
                </Text>
            );
        case "unrated":
            return (
                <Text size="sm" c="dimmed">
                    has no rating yet
                </Text>
            );
        case "rating":
            return rule?.t === "rating" ? (
                <RatingValue rule={rule} onChange={(next) => onChange(withRule(row, next))} />
            ) : null;
        case "watched":
            return (
                <SegmentedControl
                    size="sm"
                    color="brass"
                    value={rule?.t === "watched" ? rule.value : "no"}
                    data={[
                        { value: "no", label: "Not yet" },
                        { value: "yes", label: "Already" },
                    ]}
                    onChange={(value) =>
                        onChange(withRule(row, { t: "watched", value: value as "yes" | "no" }))
                    }
                />
            );
        case "measure":
            return (
                <MeasureValue
                    measure={subject.measure}
                    rule={rule?.t === "measure" ? rule : null}
                    onChange={(next) => onChange(withRule(row, next))}
                />
            );
        case "orientation":
            return (
                <SegmentedControl
                    size="sm"
                    color="brass"
                    value={rule?.t === "orientation" ? rule.value : "landscape"}
                    data={[
                        { value: "landscape", label: "Landscape" },
                        { value: "portrait", label: "Portrait" },
                        { value: "square", label: "Square" },
                    ]}
                    onChange={(value) =>
                        onChange(
                            withRule(row, {
                                t: "orientation",
                                value: value as "landscape" | "portrait" | "square",
                            })
                        )
                    }
                />
            );
        case "animated":
            return (
                <SegmentedControl
                    size="sm"
                    color="brass"
                    value={rule?.t === "animated" ? rule.value : "no"}
                    data={[
                        { value: "no", label: "Stills" },
                        { value: "yes", label: "Animated" },
                    ]}
                    onChange={(value) =>
                        onChange(withRule(row, { t: "animated", value: value as "yes" | "no" }))
                    }
                />
            );
        case "kind":
            return (
                <SegmentedControl
                    size="sm"
                    color="brass"
                    value={rule?.t === "kind" ? rule.value : "video"}
                    data={[
                        { value: "video", label: "Videos" },
                        { value: "image", label: "Photos" },
                    ]}
                    onChange={(value) =>
                        onChange(withRule(row, { t: "kind", value: value as "video" | "image" }))
                    }
                />
            );
        case "root":
            return (
                <LibraryValue
                    rootId={rule?.t === "root" ? rule.id : null}
                    onChange={(id) => onChange(withRule(row, { t: "root", id }))}
                />
            );
    }
};

const FAVORITES = "__favorites";

/**
 * A facet row: "is" some tags -- your favourites among the choices -- or "has none".
 *
 * Several tags in one row rather than a row each: "Performer is chris, brian" is one thought,
 * and the group's any/all/none already says how they combine. Keywords offer both systems,
 * the viewer's own marked, because a private keyword is as good to filter by as a shared one.
 */
const FacetValueInput: React.FC<{
    kind: string;
    value: FacetValue;
    names: FilterNames;
    onChange: (value: FacetValue) => void;
    onPicked: (tag: Tag) => void;
}> = ({ kind, value, names, onChange, onPicked }) => {
    const shared = useTagSuggestions(kind, "public", true);
    const mine = useTagSuggestions(kind, "private", allowsPrivate(kind));
    const tags = [...(mine.data?.tags ?? []), ...(shared.data?.tags ?? [])];
    const plural = facetLabelPlural(kind).toLowerCase();

    const options = [
        { value: FAVORITES, label: `♥ My favourite ${plural}` },
        ...tags.map((tag) => ({
            value: tag.id,
            label: tag.private ? `${tag.name} (private)` : tag.name,
        })),
        // Selections the suggestion list did not include still need a label to be drawn with.
        ...value.tagIds
            .filter((id) => !tags.some((tag) => tag.id === id))
            .map((id) => ({ value: id, label: names.tag(id) ?? "An unavailable tag" })),
    ];
    const selected = [...(value.favorites ? [FAVORITES] : []), ...value.tagIds];

    return (
        <Group gap="xs" wrap="nowrap" align="flex-start" style={{ flex: 1, minWidth: 220 }}>
            <Select
                size="sm"
                w={100}
                data={[
                    { value: "is", label: "is" },
                    { value: "none", label: "has none" },
                ]}
                value={value.none ? "none" : "is"}
                onChange={(op) => onChange({ ...value, none: op === "none" })}
                allowDeselect={false}
                aria-label="Has these, or has none at all"
            />
            {!value.none && (
                <MultiSelect
                    size="sm"
                    style={{ flex: 1, minWidth: 140 }}
                    placeholder={selected.length > 0 ? undefined : "Choose…"}
                    searchable
                    data={options}
                    value={selected}
                    onChange={(next) => {
                        for (const id of next) {
                            const tag = tags.find((candidate) => candidate.id === id);

                            if (tag) onPicked(tag);
                        }

                        onChange({
                            none: false,
                            favorites: next.includes(FAVORITES),
                            tagIds: next.filter((id) => id !== FAVORITES),
                        });
                    }}
                    defaultDropdownOpened={selected.length === 0}
                    maxDropdownHeight={280}
                    comboboxProps={{ withinPortal: true }}
                    aria-label={`Which ${plural}`}
                />
            )}
        </Group>
    );
};

type RatingRule = Extract<FilterRule, { t: "rating" }>;

/** "at least / at most / exactly" and the stars: one band, said the way it is meant. */
const RatingValue: React.FC<{ rule: RatingRule; onChange: (rule: FilterRule) => void }> = ({
    rule,
    onChange,
}) => {
    const op =
        rule.min !== undefined && rule.max !== undefined
            ? "exactly"
            : rule.max !== undefined
              ? "atMost"
              : "atLeast";
    const stars = rule.min ?? rule.max ?? 3;

    const make = (nextOp: string, value: number): FilterRule =>
        nextOp === "exactly"
            ? { t: "rating", min: value, max: value }
            : nextOp === "atMost"
              ? { t: "rating", max: value }
              : { t: "rating", min: value };

    return (
        <Group gap="xs" wrap="nowrap">
            <Select
                size="sm"
                w={110}
                data={[
                    { value: "atLeast", label: "at least" },
                    { value: "atMost", label: "at most" },
                    { value: "exactly", label: "exactly" },
                ]}
                value={op}
                onChange={(next) => next && onChange(make(next, stars))}
                allowDeselect={false}
                aria-label="Rating comparison"
            />
            <Rating
                color="brass"
                value={stars}
                onChange={(value) => value > 0 && onChange(make(op, value))}
            />
        </Group>
    );
};

type MeasureRule = Extract<FilterRule, { t: "measure" }>;

const CUSTOM = "__custom";

/**
 * A measure: the panel's bands, with a way out to typed bounds.
 *
 * A band first, because a band is the question people can answer -- "under a minute", "4K" --
 * where two empty boxes are not. A new row has no bound until a band is picked, rather than a
 * made-up one: seeding the first band's missing lower end as 0 produced "0–60 sec", a range
 * matching no band and reading like a typo.
 */
const MeasureValue: React.FC<{
    measure: MeasureRule["measure"];
    rule: MeasureRule | null;
    onChange: (rule: FilterRule | null) => void;
}> = ({ measure, rule, onChange }) => {
    const { bands, unit } = MEASURE_LABELS[measure];
    const band = rule ? bandFor(bands, rule.min ?? null, rule.max ?? null) : null;
    const [custom, setCustom] = useState(rule !== null && band === null);

    const set = (min: number | undefined, max: number | undefined) =>
        onChange(
            min === undefined && max === undefined
                ? null
                : {
                      t: "measure",
                      measure,
                      ...(min !== undefined ? { min } : {}),
                      ...(max !== undefined ? { max } : {}),
                  }
        );

    return (
        <Group gap="xs" wrap="wrap">
            <Select
                size="sm"
                w={200}
                placeholder="Choose…"
                data={[
                    ...bands.map((entry) => ({ value: entry.id, label: entry.label })),
                    { value: CUSTOM, label: "Custom range…" },
                ]}
                value={custom ? CUSTOM : (band?.id ?? null)}
                onChange={(id) => {
                    if (id === CUSTOM) {
                        setCustom(true);
                        return;
                    }

                    const chosen = bands.find((entry) => entry.id === id);

                    setCustom(false);
                    if (chosen) set(chosen.min, chosen.max);
                }}
                allowDeselect={false}
                defaultDropdownOpened={rule === null}
                comboboxProps={{ withinPortal: true }}
                aria-label="Range"
            />
            {custom && (
                <Group gap={6} wrap="nowrap">
                    <NumberInput
                        size="sm"
                        w={100}
                        min={0}
                        placeholder="from"
                        value={rule?.min ?? ""}
                        onChange={(value) =>
                            set(typeof value === "number" ? value : undefined, rule?.max)
                        }
                        aria-label={`From, in ${unit}`}
                    />
                    <Text size="sm" c="dimmed">
                        to
                    </Text>
                    <NumberInput
                        size="sm"
                        w={100}
                        min={0}
                        placeholder="to"
                        value={rule?.max ?? ""}
                        onChange={(value) =>
                            set(rule?.min, typeof value === "number" ? value : undefined)
                        }
                        aria-label={`Up to, in ${unit}`}
                    />
                    <Text size="sm" c="dimmed">
                        {unit}
                    </Text>
                </Group>
            )}
        </Group>
    );
};

const LibraryValue: React.FC<{ rootId: string | null; onChange: (id: string) => void }> = ({
    rootId,
    onChange,
}) => {
    const { data } = useLibraries();

    return (
        <Select
            size="sm"
            w={220}
            placeholder="Choose a library"
            value={rootId}
            data={(data?.libraries ?? []).map((library) => ({
                value: library.id,
                label: library.label,
            }))}
            onChange={(id) => id && onChange(id)}
            allowDeselect={false}
            defaultDropdownOpened={rootId === null}
            comboboxProps={{ withinPortal: true }}
        />
    );
};
