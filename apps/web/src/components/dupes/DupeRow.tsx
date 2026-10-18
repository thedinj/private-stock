"use client";

import { forwardRef, useEffect, useRef } from "react";
import Link from "next/link";
import { Badge, Button, Checkbox, Group, Text, Tooltip } from "@mantine/core";

import type { DupeGroup, DupeMember } from "@private-stock/core";

import {
    againstAdvice,
    formatBytes,
    formatDuration,
    removable,
    rowCautions,
    setKeeper,
    setOf,
    setsOf,
    sortedDecisions,
    stranded,
    type Sorting,
} from "@/lib/dupeTriage";
import { animate, DURATION, EASE } from "@/lib/motion";
import { rememberReturn } from "@/lib/returnTo";

import { DupeLook } from "./DupeLook";
import classes from "./DupeRow.module.scss";

/**
 * One duplicate group on the triage sheet (§10c).
 *
 * The picture decides, so the picture is the control: pressing a copy makes it the keeper, and
 * the tick on the left says whether this row goes when the bar's button is pressed. Every copy
 * says on its picture what will happen to it, so the row can be read without reading anything.
 */

type Fate = "keep" | "trash" | "stays" | "idle" | "alone";

/**
 * What a copy is shown as.
 *
 * Only a ticked row shows anything as going: an unticked one is a comparison, and fading its
 * copies would claim a deletion nothing is going to do.
 */
const fateOf = (member: DupeMember, keepId: string, ticked: boolean): Fate => {
    if (member.id === keepId) return "keep";
    if (!member.deletable) return "stays";

    return ticked ? "trash" : "idle";
};

/**
 * What a copy is shown as while its group is sorted (§10i): what "Record and trash" would do to
 * it within its own set. A copy alone in its set is kept apart, and nothing happens to it.
 */
const sortedFateOf = (member: DupeMember, set: DupeMember[], sorting: Sorting): Fate => {
    if (set.length < 2) return "alone";
    if (setKeeper(set, sorting).id === member.id) return "keep";

    return member.deletable ? "trash" : "stays";
};

const FATE_LABEL: Record<Fate, string | null> = {
    keep: "Keep",
    trash: "Trash",
    stays: "Read-only",
    idle: null,
    alone: "On its own",
};

/** A set's name: a letter, which stays with the set while copies move in and out of it. */
const setName = (number: number): string => String.fromCharCode(65 + (number % 26));

const plural = (count: number, one: string, many: string): string =>
    `${count} ${count === 1 ? one : many}`;

/** The sorting so far, in a sentence: how many things, and what is on its own. */
const sortSummary = (sets: DupeMember[][]): string => {
    const together = sets.filter((set) => set.length > 1).length;
    const alone = sets.length - together;

    if (sets.length === 1) return "All one thing.";
    if (together === 0) return "None of these match.";

    return `${plural(together, "set", "sets")} of the same thing${
        alone === 0 ? "" : alone === 1 ? ", one copy on its own" : `, ${alone} copies on their own`
    }.`;
};

interface DupeRowProps {
    group: DupeGroup;
    keepId: string;
    ticked: boolean;
    /** Whether the keyboard is on this row, which shows the keys that choose a copy. */
    focused: boolean;
    /** Null without the `delete` scope: the row is then a comparison with no choice in it. */
    onKeep: ((memberId: string) => void) | null;
    onTick: ((ticked: boolean) => void) | null;
    onReview: (reviewed: boolean) => void;
    reviewing: boolean;
    onFocus: () => void;
    /** A copy to play beside the sheet (§10i). */
    onPlay: (member: DupeMember) => void;
    /**
     * Sorting the group into sets of the same thing (§10i), or null when the row is not being
     * sorted. Only look-alike groups are sorted; the handlers are null on an identical one.
     */
    sorting: Sorting | null;
    onSortStart: (() => void) | null;
    onSortCycle: (memberId: string) => void;
    onSortCancel: () => void;
    /** Records the sorting; with `resolve`, trashes what each set shows going, once confirmed. */
    onSortSubmit: (resolve: boolean) => void;
    /** "None match" (null), or one copy "not the same as the others", recorded at once. */
    onApart: ((memberId: string | null) => void) | null;
    /** A sorting is being recorded. */
    sortBusy: boolean;
    /**
     * Resolved, and playing the merge before it leaves (§14, "Motion"): the copies going slide
     * into the keeper and the keeper takes them in. `onMerged` when it is over.
     */
    merging?: boolean;
    onMerged?: () => void;
}

export const DupeRow = forwardRef<HTMLDivElement, DupeRowProps>(
    (
        {
            group,
            keepId,
            ticked,
            focused,
            onKeep,
            onTick,
            onReview,
            reviewing,
            onFocus,
            onPlay,
            sorting,
            onSortStart,
            onSortCycle,
            onSortCancel,
            onSortSubmit,
            onApart,
            sortBusy,
            merging = false,
            onMerged,
        },
        ref
    ) => {
        const going = removable(group, keepId);
        const sets = sorting ? setsOf(group, sorting) : [];
        const setFor = (member: DupeMember): DupeMember[] =>
            sets.find((set) => set.some((other) => other.id === member.id)) ?? [member];
        const sortedGoing = sorting
            ? sortedDecisions(group, sorting).flatMap((decision) =>
                  removable(decision.group, decision.keepId)
              )
            : [];
        const strip = useRef<HTMLDivElement>(null);
        const merged = useRef(onMerged);
        merged.current = onMerged;

        /**
         * The merge: each copy that is going slides along the strip into the keeper and fades
         * as it reaches it, then the keeper's frame glows once in gilt as their tags, ratings and
         * places arrive in it (§10c). Only then does the row leave, and the rows below close
         * ranks. The copies move as whole cards; their pictures are never treated on their own.
         */
        useEffect(() => {
            if (!merging) return;

            const host = strip.current;
            const keeper = host?.querySelector<HTMLElement>(`[data-member-id="${keepId}"]`);
            const frame = keeper?.querySelector<HTMLElement>(`.${classes.cover}`);
            const goingIds = new Set(removable(group, keepId).map((member) => member.id));

            if (!host || !keeper || !frame) {
                merged.current?.();
                return;
            }

            const target = keeper.getBoundingClientRect();
            const moves = [...host.querySelectorAll<HTMLElement>("[data-member-id]")]
                .filter((element) => goingIds.has(element.dataset.memberId ?? ""))
                .map((element) => {
                    const from = element.getBoundingClientRect();
                    const to = `translate(${target.left - from.left}px, ${target.top - from.top}px)`;

                    return animate(
                        element,
                        [
                            { transform: "none", opacity: 1 },
                            { transform: `${to} scale(0.96)`, opacity: 0.85, offset: 0.7 },
                            { transform: `${to} scale(0.9)`, opacity: 0 },
                        ],
                        { duration: DURATION.move, easing: EASE.inOut, fill: "forwards" }
                    );
                });

            const glow = animate(
                frame,
                [
                    { boxShadow: "0 0 0 0 rgba(228, 185, 85, 0)" },
                    {
                        boxShadow:
                            "0 0 0 2px rgba(228, 185, 85, 0.95), 0 0 36px 4px rgba(228, 185, 85, 0.35)",
                        offset: 0.4,
                    },
                    { boxShadow: "0 0 0 0 rgba(228, 185, 85, 0)" },
                ],
                { duration: DURATION.arrive, delay: DURATION.move * 0.75 }
            );

            // Nothing started (reduced motion): the row goes at once, as it always did.
            const running = [...moves, glow].filter((a): a is Animation => a !== null);
            let cancelled = false;

            void Promise.allSettled(running.map((a) => a.finished)).then(() => {
                if (!cancelled) merged.current?.();
            });

            return () => {
                cancelled = true;
            };
            // Once per merge; the group and its keeper are fixed for its length.
            // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [merging]);
        const staying = stranded(group, keepId);
        const cautions = rowCautions(group, keepId);
        const disagreed = againstAdvice(group, keepId);
        const freed = going.reduce((total, member) => total + (member.sizeBytes ?? 0), 0);

        return (
            <div
                ref={ref}
                data-flip-key={group.id}
                className={classes.row}
                data-focused={focused}
                onClick={onFocus}
                // Focusing inside the row — tabbing to a copy — moves the keyboard's row too.
                onFocus={onFocus}
            >
                <div className={classes.tick}>
                    {/* Absent rather than disabled when nothing here could be removed: a
                        control that cannot apply is gone rather than greyed (§14e). */}
                    {onTick && !sorting && going.length > 0 && (
                        <Checkbox
                            size="md"
                            color="brass"
                            checked={ticked}
                            onChange={(event) => onTick(event.currentTarget.checked)}
                            aria-label={ticked ? "Leave this group out" : "Include this group"}
                        />
                    )}
                </div>

                <div>
                    <div className={classes.head}>
                        <Badge
                            size="sm"
                            variant="light"
                            color={group.kind === "exact" ? "oxblood" : "brass"}
                        >
                            {group.kind === "exact" ? "Identical" : "Looks the same"}
                        </Badge>

                        {group.confirmed && (
                            <Text size="xs" c="verdigris.4" fw={500}>
                                You said these are the same
                            </Text>
                        )}

                        {group.kind === "near" && (
                            // Clustering treats similarity as transitive, so a group is a chain
                            // of pairwise links. A high number means "connected, but not
                            // necessarily all alike" — exactly when to look closely.
                            <Tooltip label="Bits of difference between the furthest linked pair. Higher means the group is looser.">
                                <Text size="xs" c="dimmed">
                                    spread {group.maxDistance}
                                </Text>
                            </Tooltip>
                        )}

                        {/* The argument, on the row: why the recommendation won, or — once the
                            reviewer has overridden it — that they have. */}
                        {disagreed ? (
                            <Text size="xs" c="oxblood.3" fw={500}>
                                Not the app&apos;s pick
                            </Text>
                        ) : (
                            group.keepReason && (
                                <Text size="xs" c="brass.4" fw={500}>
                                    {group.keepReason}
                                </Text>
                            )
                        )}

                        <div className={classes.headEnd}>
                            {onTick && ticked && !sorting && freed > 0 && (
                                <Text size="xs" c="dimmed">
                                    frees {formatBytes(freed)}
                                </Text>
                            )}
                            {/* Sorting is for three or more: two copies that are not the same
                                thing are "None match". Lit when the app sees more than one. */}
                            {onSortStart && !sorting && group.members.length > 2 && (
                                <Button
                                    size="compact-xs"
                                    variant={group.suggestedSets.length > 1 ? "light" : "subtle"}
                                    color="brass"
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        onSortStart();
                                    }}
                                >
                                    Sort into sets…
                                </Button>
                            )}
                            {onApart && !sorting && (
                                <Button
                                    size="compact-xs"
                                    variant="subtle"
                                    color="oxblood"
                                    loading={sortBusy}
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        onApart(null);
                                    }}
                                >
                                    None match
                                </Button>
                            )}
                            <Button
                                size="compact-xs"
                                variant="subtle"
                                color="brass"
                                loading={reviewing}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    onReview(!group.reviewed);
                                }}
                            >
                                {group.reviewed ? "Reopen" : "Mark reviewed"}
                            </Button>
                        </div>
                    </div>

                    <div className={classes.strip} ref={strip}>
                        {group.members.map((member, index) => {
                            const fate = sorting
                                ? sortedFateOf(member, setFor(member), sorting)
                                : fateOf(member, keepId, ticked);
                            const label = FATE_LABEL[fate];
                            const number = sorting ? setOf(sorting, member.id) : null;

                            return (
                                <div
                                    key={member.id}
                                    data-member-id={member.id}
                                    data-set={number === null ? undefined : number % 5}
                                    className={classes.member}
                                >
                                    <Tooltip
                                        label={`${member.rootLabel} · ${member.relPath}`}
                                        openDelay={500}
                                        multiline
                                        maw={420}
                                    >
                                        <button
                                            type="button"
                                            className={classes.copy}
                                            data-fate={fate}
                                            aria-pressed={member.id === keepId}
                                            aria-label={`Keep ${member.title}`}
                                            // Not `disabled`: a disabled button swallows the
                                            // hover the path tooltip needs.
                                            aria-disabled={!onKeep}
                                            onClick={() => onKeep?.(member.id)}
                                        >
                                            <div className={classes.cover}>
                                                {member.coverUrl ? (
                                                    // eslint-disable-next-line @next/next/no-img-element
                                                    <img
                                                        src={member.coverUrl}
                                                        alt=""
                                                        loading="lazy"
                                                    />
                                                ) : (
                                                    <div className={classes.empty}>
                                                        No picture yet
                                                    </div>
                                                )}
                                                {label && (
                                                    <span className={classes.fate}>{label}</span>
                                                )}
                                                {focused && onKeep && index < 9 && (
                                                    <kbd className={classes.key}>{index + 1}</kbd>
                                                )}
                                            </div>

                                            {/* Resolution first: it decides most of these, and
                                                no bitrate can recover it. */}
                                            <div className={classes.stats}>
                                                {member.width && member.height
                                                    ? `${member.width}×${member.height}`
                                                    : "—"}
                                                {member.kind === "video" &&
                                                    ` · ${formatDuration(member.durationMs)}`}
                                                {` · ${formatBytes(member.sizeBytes)}`}
                                                {member.bitrate
                                                    ? ` · ${Math.round(member.bitrate / 1000)} kbps`
                                                    : ""}
                                            </div>

                                            {!sorting && member.costOfKeeping && (
                                                <div
                                                    className={classes.note}
                                                    title={member.costOfKeeping}
                                                >
                                                    {member.costOfKeeping}
                                                </div>
                                            )}
                                        </button>
                                    </Tooltip>

                                    {sorting && number !== null && (
                                        // The copy's set. Pressing moves it to the next set, then
                                        // to a new one; its digit does the same from the keys.
                                        <button
                                            type="button"
                                            className={classes.setChip}
                                            onClick={(event) => {
                                                event.stopPropagation();
                                                onSortCycle(member.id);
                                            }}
                                            aria-label={`In set ${setName(number)}. Move ${member.title} to another set`}
                                        >
                                            Set {setName(number)}
                                            <span aria-hidden>→</span>
                                        </button>
                                    )}

                                    <div className={classes.titleLine}>
                                        {/* Recorded like every other way into an item, so
                                            "back" returns here (§14b). */}
                                        <Link
                                            href={`/media/${member.id}`}
                                            onClick={rememberReturn}
                                            className={classes.title}
                                            title={member.title}
                                        >
                                            {member.title}
                                        </Link>
                                        <DupeLook
                                            member={member}
                                            onPlay={onPlay}
                                            onNotThis={
                                                onApart && !sorting
                                                    ? (chosen) => onApart(chosen.id)
                                                    : null
                                            }
                                        />
                                    </div>
                                </div>
                            );
                        })}
                    </div>

                    {sorting && (
                        <div className={classes.sortBar}>
                            <Text size="xs" c="dimmed">
                                {sortSummary(sets)} Press a copy&apos;s set to move it; press a
                                picture to keep that copy of its set.
                            </Text>
                            <Group gap="xs">
                                {onTick && sortedGoing.length > 0 && (
                                    <Button
                                        size="compact-sm"
                                        color="oxblood"
                                        loading={sortBusy}
                                        onClick={() => onSortSubmit(true)}
                                    >
                                        Record and trash{" "}
                                        {plural(sortedGoing.length, "copy", "copies")}…
                                    </Button>
                                )}
                                <Button
                                    size="compact-sm"
                                    variant="light"
                                    color="brass"
                                    loading={sortBusy}
                                    onClick={() => onSortSubmit(false)}
                                >
                                    Just record
                                </Button>
                                <Button
                                    size="compact-sm"
                                    variant="subtle"
                                    color="gray"
                                    onClick={onSortCancel}
                                >
                                    Cancel
                                </Button>
                            </Group>
                        </div>
                    )}

                    {!sorting && (cautions.length > 0 || (onTick && staying.length > 0)) && (
                        <div className={classes.cautions}>
                            {cautions.map((caution) => (
                                <div key={caution}>{caution}</div>
                            ))}
                            {onTick && staying.length > 0 && (
                                <Text size="xs" c="dimmed">
                                    {staying.length} of these{" "}
                                    {staying.length === 1 ? "sits" : "sit"} on a read-only library
                                    and will be left alone.
                                </Text>
                            )}
                        </div>
                    )}
                </div>
            </div>
        );
    }
);

DupeRow.displayName = "DupeRow";
