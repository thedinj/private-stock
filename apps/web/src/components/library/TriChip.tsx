"use client";

import { Chip } from "@mantine/core";

import type { ChipState } from "@/lib/tagLogic";

import classes from "./TriChip.module.scss";

/**
 * A tag chip with three states: off, with, without (§14e "Any, all and without").
 *
 * One click moves it along -- off, then with, then without, then off -- the cycle
 * Eagle use, because it is the one gesture that works the same with a mouse and a thumb.
 *
 * **"Without" is said three ways, never by colour alone:** an oxblood outline, a minus sign
 * where the tick goes, and the name struck through. The accessible name says the state and
 * what the next click does, because a cycle whose next step is a guess is the known trap of
 * this pattern -- the third click quietly drops a filter somebody meant to keep.
 *
 * **None is the exception** (`opposite`): its without is "no performer -- not", which said as a
 * negation was a struck-through face of nobody. It has a positive of its own, "has some
 * performer", so that state is drawn as that, filled like any other "with". It also comes first:
 * off, some performer, nobody yet, off (`cycleNone`), and the tooltips follow that order.
 */

interface TriChipProps {
    /** What it is, for the accessible name; also what it shows unless `display` says otherwise. */
    name: string;
    /**
     * How many items it is on. Nought dims the chip while it is off.
     *
     * Absent on None and the ♥, which would each be a scan of the whole filtered set -- the
     * cost the panel's numbers are built to avoid (§20 "Facets without counts").
     */
    count?: number;
    state: ChipState;
    onCycle: () => void;
    /** What it shows, when the name would not say it -- the ♥ and None chips. */
    display?: React.ReactNode;
    /** The "with" colour: brass for a tag, oxblood for the heart, as everywhere else. */
    accent?: "brass" | "oxblood";
    /**
     * "or" where the tick goes, for a pick that is one more alternative to the ones before it
     * -- every "with" in an "any of" facet but the first, so the row reads "♥, or 🫥".
     */
    or?: boolean;
    /** A third state that is a positive in its own right, drawn as one rather than as "not". */
    opposite?: { name: string; display: React.ReactNode };
}

const NEXT: Record<ChipState, string> = {
    off: "click to show only items with it",
    with: "click to hide items with it instead",
    without: "click to clear",
};

const STATE_WORDS: Record<ChipState, string> = {
    off: "not filtering",
    with: "with",
    without: "without",
};

export const TriChip: React.FC<TriChipProps> = ({
    name,
    count,
    state,
    onCycle,
    display,
    accent = "brass",
    or = false,
    opposite,
}) => {
    if (state === "without" && opposite) {
        return (
            <Chip
                size="xs"
                checked
                onChange={onCycle}
                color={accent}
                variant="filled"
                aria-label={`${opposite.name}: click for ${name.toLowerCase()} instead`}
                title={`${opposite.name} — click for ${name.toLowerCase()} instead`}
                classNames={{ label: classes.label }}
            >
                {opposite.display}
            </Chip>
        );
    }

    const next = !opposite
        ? NEXT[state]
        : state === "off"
          ? `click for ${opposite.name.toLowerCase()}`
          : "click to clear";
    const marker =
        state === "without" ? (
            <span className={classes.minus}>−</span>
        ) : state === "with" && or ? (
            <span className={classes.or}>or</span>
        ) : undefined;

    return (
        <Chip
            size="xs"
            checked={state !== "off"}
            onChange={onCycle}
            // A deeper shade for "without": the outline variant draws the base shade, which on this
            // ground read as cream rather than oxblood.
            color={state === "without" ? "oxblood.5" : accent}
            variant={state === "without" ? "outline" : "filled"}
            // Mantine's tick is right for "with"; "without" puts a minus where the tick goes, and an
            // alternative under "any of" says "or".
            icon={marker}
            aria-label={`${name}: ${or && state === "with" ? "or" : STATE_WORDS[state]}, ${next}`}
            title={`${name} — ${next}`}
            /* Dimmed rather than hidden when it would match nothing here: the numbers are the
           filter, and a tag that vanished whenever another choice excluded it would make the
           list reshuffle under the pointer. Never dimmed once it is doing something. */
            opacity={count === 0 && state === "off" ? 0.45 : undefined}
            classNames={{
                label: state === "without" ? `${classes.label} ${classes.without}` : classes.label,
                iconWrapper: or && state === "with" ? classes.orWrapper : undefined,
            }}
        >
            {display ?? name}
            {count !== undefined && ` (${count.toLocaleString()})`}
        </Chip>
    );
};
