"use client";

import { Anchor, Badge, Group } from "@mantine/core";

import { activeFilters } from "@/lib/activeFilters";
import { useFilterNames } from "@/lib/api/facets";
import { useLookSource } from "@/lib/api/lookSource";
import { clearFilters, type LibraryView } from "@/lib/libraryQuery";

import classes from "./ActiveFilterBar.module.scss";
import { CloseGlyph } from "@/components/media/Glyph";
import { MiddleEllipsis } from "@/components/MiddleEllipsis";

/**
 * What is currently hiding things, above the grid (§14e).
 *
 * **The one place a filter and a sort are told apart.** Both change what the grid shows;
 * only one of them removes items, and the panel cannot carry that difference on its own — it
 * is a column of mostly-off controls, several of them below the fold, and behind a button
 * entirely on a phone. A set filter there looks like an unset one until you go and look.
 *
 * So this sits next to the item count, which is the number the filters are responsible for,
 * and it is deliberately absent when nothing is filtered rather than showing an empty rail:
 * a row that is always there stops being read.
 *
 * Nothing about the sort appears here, and that is not an omission. The sort control states
 * its own value at all times because it has exactly one, reordering hides nothing, and a
 * removable "Newest first" chip would imply there is a way to have no order at all.
 *
 * Each chip removes just itself. "Clear all" is the only escape a panel offers, and it is too
 * blunt for a view built up one decision at a time — the common repair is undoing the last
 * thing tried, not starting again.
 */

interface ActiveFilterBarProps {
    view: LibraryView;
    onChange: (next: LibraryView) => void;
}

export const ActiveFilterBar: React.FC<ActiveFilterBarProps> = ({ view, onChange }) => {
    const lookSource = useLookSource(view.like);
    const filters = activeFilters(view, useFilterNames(view), lookSource.item?.title);

    if (filters.length === 0) {
        return null;
    }

    return (
        <Group gap={6} wrap="wrap">
            {filters.map((filter) => (
                <Badge
                    key={filter.id}
                    size="sm"
                    variant="light"
                    color="brass"
                    className={classes.chip}
                    style={{ cursor: "pointer", textTransform: "none" }}
                    rightSection={<CloseGlyph size={10} />}
                    onClick={() => onChange(filter.clear(view))}
                    // The label already says what it is; the title says what clicking does,
                    // because a × on a badge is not universally read as "remove this one".
                    title={`Remove ${filter.label}`}
                >
                    {filter.named ? (
                        // A name of any length in a chip of a sensible one: cut in the middle,
                        // as titles are everywhere else, with the words around it kept whole.
                        <span className={classes.named}>
                            <span className={classes.fixed}>{filter.named.before}</span>
                            <MiddleEllipsis
                                span
                                text={filter.named.name}
                                inherit
                                className={classes.name}
                            />
                            <span className={classes.fixed}>{filter.named.after}</span>
                        </span>
                    ) : (
                        filter.label
                    )}
                </Badge>
            ))}

            {/* Offered only once there are several. With one chip on screen the × beside it
                is already the shortest way to clear everything, and a second control saying
                so would be noise. */}
            {filters.length > 1 && (
                <Anchor
                    component="button"
                    type="button"
                    size="xs"
                    c="dimmed"
                    underline="never"
                    onClick={() => onChange(clearFilters(view))}
                >
                    clear all
                </Anchor>
            )}
        </Group>
    );
};
