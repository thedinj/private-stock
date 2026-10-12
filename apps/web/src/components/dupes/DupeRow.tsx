"use client";

import { forwardRef, useEffect, useRef } from "react";
import Link from "next/link";
import { Badge, Button, Checkbox, Text, Tooltip } from "@mantine/core";

import type { DupeGroup, DupeMember } from "@private-stock/core";

import {
    againstAdvice,
    formatBytes,
    formatDuration,
    removable,
    rowCautions,
    stranded,
} from "@/lib/dupeTriage";
import { animate, DURATION, EASE } from "@/lib/motion";
import { rememberReturn } from "@/lib/returnTo";

import classes from "./DupeRow.module.scss";

/**
 * One duplicate group on the triage sheet (§10c).
 *
 * The picture decides, so the picture is the control: pressing a copy makes it the keeper, and
 * the tick on the left says whether this row goes when the bar's button is pressed. Every copy
 * says on its picture what will happen to it, so the row can be read without reading anything.
 */

type Fate = "keep" | "trash" | "stays" | "idle";

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

const FATE_LABEL: Record<Fate, string | null> = {
    keep: "Keep",
    trash: "Trash",
    stays: "Read-only",
    idle: null,
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
            merging = false,
            onMerged,
        },
        ref
    ) => {
        const going = removable(group, keepId);
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
                    {onTick && going.length > 0 && (
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
                            {onTick && ticked && freed > 0 && (
                                <Text size="xs" c="dimmed">
                                    frees {formatBytes(freed)}
                                </Text>
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
                            const fate = fateOf(member, keepId, ticked);
                            const label = FATE_LABEL[fate];

                            return (
                                <div key={member.id} data-member-id={member.id}>
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

                                            {member.costOfKeeping && (
                                                <div
                                                    className={classes.note}
                                                    title={member.costOfKeeping}
                                                >
                                                    {member.costOfKeeping}
                                                </div>
                                            )}
                                        </button>
                                    </Tooltip>

                                    {/* Recorded like every other way into an item, so "back"
                                        returns here (§14b). */}
                                    <Link
                                        href={`/media/${member.id}`}
                                        onClick={rememberReturn}
                                        className={classes.title}
                                        title={member.title}
                                    >
                                        {member.title}
                                    </Link>
                                </div>
                            );
                        })}
                    </div>

                    {(cautions.length > 0 || (onTick && staying.length > 0)) && (
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
