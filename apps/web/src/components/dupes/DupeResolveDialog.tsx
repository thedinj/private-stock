"use client";

import { useState } from "react";
import { Alert, Button, Collapse, Group, List, Modal, Stack, Text } from "@mantine/core";

import type { DupeGroup } from "@private-stock/core";

import { ApiError } from "@/lib/api/client";
import {
    againstAdvice,
    clipsAtRisk,
    formatBytes,
    removable,
    rowCautions,
    stranded,
} from "@/lib/dupeTriage";

/**
 * The confirmation for a page of the triage sheet (§10c).
 *
 * **A summary first, and every path one press away.** The single-group dialogue listed each
 * file, which is right for three copies and useless for seventy: a list nobody reads is not a
 * confirmation. What a reviewer can actually check at this size is the totals and the
 * exceptions, so those lead — how much goes, how much it frees, and the rows where they
 * overrode the recommendation or ticked past a caution. The full list is still here.
 *
 * It says both directions on the recommendation, as the old one did: the overrides are called
 * out in oxblood, and when there are none nothing alarming is said, because a dialogue that
 * always warns reads as a discouragement from tidying up.
 */

/** A ticked row with the reviewer's choice attached — everything the confirmation needs. */
export interface Decision {
    group: DupeGroup;
    keepId: string;
}

interface DupeResolveDialogProps {
    decisions: Decision[] | null;
    onCancel: () => void;
    onConfirm: () => void;
    busy: boolean;
    error: unknown;
}

const plural = (count: number, one: string, many: string): string =>
    `${count.toLocaleString()} ${count === 1 ? one : many}`;

export const DupeResolveDialog: React.FC<DupeResolveDialogProps> = ({
    decisions,
    onCancel,
    onConfirm,
    busy,
    error,
}) => {
    const [showFiles, setShowFiles] = useState(false);
    const rows = decisions ?? [];

    const going = rows.flatMap(({ group, keepId }) => removable(group, keepId));

    /**
     * Copies from identical groups go outright rather than to the trash (§10e): the copy kept
     * has the same bytes, so there is nothing a restore would add. Counted apart, because the
     * sentence about the trash is only true of the rest.
     */
    const outright = rows
        .filter(({ group }) => group.kind === "exact")
        .reduce((total, { group, keepId }) => total + removable(group, keepId).length, 0);
    const binned = going.length - outright;
    const freed = going.reduce((total, member) => total + (member.sizeBytes ?? 0), 0);
    const leftAlone = rows.reduce(
        (total, { group, keepId }) => total + stranded(group, keepId).length,
        0
    );
    const clips = rows.reduce((total, { group, keepId }) => total + clipsAtRisk(group, keepId), 0);
    const overridden = rows.filter(({ group, keepId }) => againstAdvice(group, keepId));
    const cautioned = rows.filter(({ group, keepId }) => rowCautions(group, keepId).length > 0);

    return (
        <Modal
            opened={decisions !== null}
            onClose={onCancel}
            title={`Remove ${plural(going.length, "copy", "copies")}?`}
            centered
            size="lg"
        >
            <Stack gap="md">
                {/* Says where they go and whether they can come back. "Are you sure" alone
                    makes a recoverable action feel permanent, and people then avoid the feature
                    -- and an identical copy that cannot come back must not be called recoverable. */}
                <Text size="sm">
                    From {plural(rows.length, "group", "groups")}.
                    {binned > 0 &&
                        ` ${plural(binned, "copy leaves", "copies leave")} the library and ${binned === 1 ? "is" : "are"} kept in the trash, where an administrator can restore ${binned === 1 ? "it" : "them"} until the retention window closes.`}
                    {outright > 0 &&
                        ` ${plural(outright, "identical copy is", "identical copies are")} deleted outright — the copy kept has the same bytes, so nothing is held in the trash.`}
                    {freed > 0 && ` Frees ${formatBytes(freed)} in all.`}
                </Text>

                {overridden.length > 0 && (
                    <Alert
                        variant="light"
                        color="oxblood"
                        title={`${plural(overridden.length, "group keeps", "groups keep")} a copy the app would not`}
                    >
                        <List size="sm" spacing={4}>
                            {overridden.map(({ group, keepId }) => {
                                const keeper = group.members.find((member) => member.id === keepId);

                                return (
                                    <List.Item key={group.id}>
                                        {keeper?.title ?? keepId}
                                        {/* The cost in the server's words — the same sentence
                                            its card carries, so the two cannot disagree. */}
                                        {keeper?.costOfKeeping && (
                                            <Text size="xs" c="dimmed">
                                                {keeper.costOfKeeping}
                                            </Text>
                                        )}
                                    </List.Item>
                                );
                            })}
                        </List>
                    </Alert>
                )}

                {cautioned.length > 0 && (
                    <Alert
                        variant="light"
                        color="oxblood"
                        title={`${plural(cautioned.length, "group was", "groups were")} ticked past a caution`}
                    >
                        <List size="sm" spacing={4}>
                            {cautioned.map(({ group, keepId }) => (
                                <List.Item key={group.id}>
                                    {group.members.find((member) => member.id === keepId)?.title}
                                    <Text size="xs" c="dimmed">
                                        {rowCautions(group, keepId).join(" · ")}
                                    </Text>
                                </List.Item>
                            ))}
                        </List>
                    </Alert>
                )}

                {/* What moves and what does not (§10c, §14d). */}
                <Text size="xs" c="dimmed">
                    Ratings, tags, notes and playlist places move to the copy that stays in each
                    group. Clips do not — a different encode has a different timeline
                    {clips > 0
                        ? ` — and ${plural(clips, "clip", "clips")} on these copies ${clips === 1 ? "is" : "are"} destroyed when the trash is purged.`
                        : "."}
                </Text>

                {leftAlone > 0 && (
                    <Text size="xs" c="dimmed">
                        {plural(leftAlone, "further copy is", "further copies are")} on a read-only
                        library and {leftAlone === 1 ? "is" : "are"} left alone.
                    </Text>
                )}

                <div>
                    <Button
                        variant="subtle"
                        color="brass"
                        size="compact-sm"
                        onClick={() => setShowFiles((open) => !open)}
                    >
                        {showFiles
                            ? "Hide the files"
                            : `Show all ${plural(going.length, "file", "files")}`}
                    </Button>
                    <Collapse in={showFiles}>
                        <List
                            size="sm"
                            spacing={4}
                            mt="xs"
                            style={{ maxHeight: 320, overflowY: "auto" }}
                        >
                            {going.map((member) => (
                                <List.Item key={member.id}>
                                    <Text size="sm" span>
                                        {member.title}
                                    </Text>
                                    <Text size="xs" c="dimmed" style={{ wordBreak: "break-all" }}>
                                        {member.width && member.height
                                            ? `${member.width}×${member.height} · `
                                            : ""}
                                        {formatBytes(member.sizeBytes)} · {member.rootLabel} ·{" "}
                                        {member.relPath}
                                    </Text>
                                </List.Item>
                            ))}
                        </List>
                    </Collapse>
                </div>

                {error != null && (
                    <Text size="sm" c="oxblood">
                        {error instanceof ApiError
                            ? error.message
                            : "Could not delete these copies"}
                    </Text>
                )}

                <Group justify="flex-end">
                    <Button variant="default" onClick={onCancel}>
                        Cancel
                    </Button>
                    <Button color="oxblood" loading={busy} onClick={onConfirm}>
                        Remove {plural(going.length, "copy", "copies")}
                    </Button>
                </Group>
            </Stack>
        </Modal>
    );
};
