"use client";

import { useState } from "react";
import Link from "next/link";
import {
    Badge,
    Button,
    Collapse,
    Group,
    Paper,
    Popover,
    Skeleton,
    Stack,
    Text,
} from "@mantine/core";

import { ANCHOR_MIN_ITEMS, type PerformerFaceGroup } from "@private-stock/core";

import { LoadFailed } from "@/components/LoadFailed";
import { useDecideFaceGroup, usePerformerFaces, useSetNoSingleFace } from "@/lib/api/faces";
import { itemHref } from "@/lib/lookMoment";

import { FaceCropView } from "./FaceCropView";
import { PickTheirFace } from "./PickTheirFace";

/**
 * "Their face", on a performer's Organise page (§5f "Starting from the performer").
 *
 * The faces confirmed as them, as one strip: the faces stage splits a person into several groups
 * — angles, light, years — and once confirmed they are all simply them, so the groups are not
 * the way in. The groups themselves are behind "Show face groups", for taking back a confirmation
 * that was wrong — and for confirming a group their tags suggest whose items all carry them
 * already, which "To check" has nothing to ask about. Before anything is confirmed, those
 * suggestions are the whole story, so the list starts open.
 *
 * Until their face is confirmed on a few items, "Pick their face" goes through their own items for
 * it — open from the start when nothing else found one.
 *
 * What is still to check is the other tab; their picture is chosen from these faces in the tag's
 * one picture dialogue (§6 "A tag's picture").
 */

const items = (n: number): string => `${n.toLocaleString()} ${n === 1 ? "item" : "items"}`;

const GroupRow: React.FC<{ tagId: string; name: string; group: PerformerFaceGroup }> = ({
    tagId,
    name,
    group,
}) => {
    const decide = useDecideFaceGroup(tagId);
    const confirmed = group.state === "confirmed";
    const deciding = (verdict: "confirm" | "refuse"): boolean =>
        decide.isPending && decide.variables?.verdict === verdict;

    return (
        <Paper withBorder radius="md" p="sm">
            <Group justify="space-between" align="center" gap="md" wrap="wrap">
                <Group gap={6} wrap="nowrap" style={{ overflowX: "auto", minWidth: 0 }}>
                    {group.faces.map((face) => (
                        <FaceCropView key={face.id} crop={face.crop} size={56} />
                    ))}
                </Group>

                <Stack gap={4} style={{ flex: "1 1 180px", minWidth: 0 }}>
                    <Group gap="xs">
                        <Badge
                            variant="light"
                            color={confirmed ? "brass" : "gray"}
                            size="sm"
                            style={{ textTransform: "none" }}
                        >
                            {confirmed ? "Confirmed" : "Suggested by their tags"}
                        </Badge>
                    </Group>
                    <Text size="sm" c="dimmed">
                        On {items(group.itemCount)}
                        {group.untaggedCount > 0 &&
                            `, ${group.untaggedCount.toLocaleString()} not tagged with ${name} yet`}
                    </Text>
                </Stack>

                <Group gap="xs" wrap="nowrap">
                    {!confirmed && (
                        <Button
                            color="brass"
                            variant="light"
                            h={44}
                            disabled={decide.isPending}
                            loading={deciding("confirm")}
                            onClick={() =>
                                decide.mutate({
                                    groupId: group.groupId,
                                    verdict: "confirm",
                                    // These faces, the ones on screen, and no others.
                                    faceIds: group.faces.map((face) => face.id),
                                })
                            }
                        >
                            That&apos;s {name}
                        </Button>
                    )}
                    <Button
                        variant="default"
                        h={44}
                        disabled={decide.isPending}
                        loading={deciding("refuse")}
                        onClick={() =>
                            decide.mutate({
                                groupId: group.groupId,
                                verdict: "refuse",
                                faceIds: group.faces.map((face) => face.id),
                            })
                        }
                    >
                        Not {name}
                    </Button>
                </Group>
            </Group>
        </Paper>
    );
};

/**
 * "No single face" (§5f): for a performer whose face never shows, or a name that is not one person.
 * Asked once, with what it does said before it is done, because it changes what the faces do
 * across the library; undone in one press.
 */
const NoSingleFaceControl: React.FC<{ tagId: string; name: string }> = ({ tagId, name }) => {
    const set = useSetNoSingleFace(tagId);
    const [opened, setOpened] = useState(false);

    return (
        <Popover opened={opened} onChange={setOpened} position="bottom-start" withArrow>
            <Popover.Target>
                <Button
                    variant="subtle"
                    color="gray"
                    size="compact-sm"
                    onClick={() => setOpened((open) => !open)}
                >
                    No single face…
                </Button>
            </Popover.Target>
            <Popover.Dropdown>
                <Stack gap="xs" maw={320}>
                    <Text size="sm">
                        For a performer whose face never shows, or a name that is not one person.
                        Face matching then leaves {name} out: no face is learned for them, their
                        tags stop counting as evidence about anybody&apos;s face, and nothing is
                        suggested or tagged for them by a face — by name only. Anything confirmed is
                        kept, so undoing it puts everything back.
                    </Text>
                    <Group gap="xs">
                        <Button
                            size="compact-sm"
                            color="brass"
                            loading={set.isPending}
                            onClick={() =>
                                set.mutate(
                                    { noSingleFace: true },
                                    { onSuccess: () => setOpened(false) }
                                )
                            }
                        >
                            {name} has no single face
                        </Button>
                        <Button
                            size="compact-sm"
                            variant="default"
                            onClick={() => setOpened(false)}
                        >
                            Cancel
                        </Button>
                    </Group>
                </Stack>
            </Popover.Dropdown>
        </Popover>
    );
};

/** What the section says instead of faces, once a performer has no single face. */
const NoSingleFaceNote: React.FC<{ tagId: string; name: string; since: string }> = ({
    tagId,
    name,
    since,
}) => {
    const set = useSetNoSingleFace(tagId);

    return (
        <Group gap="sm" wrap="wrap" align="center">
            <Text size="sm" c="dimmed" style={{ flex: "1 1 260px" }}>
                {name} has no single face (since{" "}
                {new Date(`${since.replace(" ", "T")}Z`).toLocaleDateString(undefined, {
                    day: "numeric",
                    month: "short",
                })}
                ). Face matching leaves them out; they are suggested by name only.
            </Text>
            <Button
                variant="default"
                size="compact-sm"
                loading={set.isPending}
                onClick={() => set.mutate({ noSingleFace: false })}
            >
                Undo
            </Button>
        </Group>
    );
};

export const TheirFaceSection: React.FC<{ tagId: string; name: string }> = ({ tagId, name }) => {
    const { data, error, refetch } = usePerformerFaces(tagId, true);
    // Unset until somebody opens or closes it: open by default while nothing is confirmed.
    const [showGroups, setShowGroups] = useState<boolean | null>(null);
    const [showPick, setShowPick] = useState(false);
    const suggested = data?.groups.filter((group) => group.state === "proposed").length ?? 0;
    const groupsOpen =
        showGroups ??
        (data !== undefined && data.confirmed.length === 0 && data.fromTags.length === 0);

    if (error) {
        return <LoadFailed error={error} what="their faces" onRetry={() => void refetch()} />;
    }

    if (!data) {
        return <Skeleton height={96} radius="md" />;
    }

    if (data.noSingleFace) {
        return <NoSingleFaceNote tagId={tagId} name={name} since={data.noSingleFace.since} />;
    }

    // Nothing confirmed, no group, and no face their tags share: nothing to show yet.
    if (data.groups.length === 0 && data.confirmed.length === 0 && data.fromTags.length === 0) {
        return (
            <Stack gap="xs" align="flex-start">
                <Text size="sm" c="dimmed">
                    No face found for {name} yet: either their tagged items have not been read, or
                    no one face recurs across them. Pick it below.
                </Text>
                <PickTheirFace tagId={tagId} name={name} confirmedItems={data.confirmedItems} />
                <NoSingleFaceControl tagId={tagId} name={name} />
            </Stack>
        );
    }

    const strip = data.confirmed.length > 0 ? data.confirmed : data.fromTags;

    return (
        <Stack gap="sm">
            {strip.length > 0 ? (
                <Stack gap={4}>
                    <Group gap={6} wrap="wrap">
                        {strip.map((face) => (
                            <Link
                                key={face.id}
                                href={itemHref(face.mediaId, face.atMs)}
                                prefetch={false}
                                aria-label={`Open an item with ${name}'s face`}
                            >
                                <FaceCropView crop={face.crop} size={72} />
                            </Link>
                        ))}
                    </Group>
                    <Text size="sm" c="dimmed">
                        {data.confirmed.length > 0
                            ? `Confirmed on ${items(data.confirmedItems)}`
                            : `The face ${name}'s tagged items share — nobody has confirmed it yet, but it is what their other items are matched against.`}
                    </Text>
                </Stack>
            ) : (
                <Text size="sm" c="dimmed">
                    No face confirmed as {name} yet.
                    {suggested > 0 &&
                        ` Their tags suggest ${suggested === 1 ? "the face group" : `the ${suggested} face groups`} below: confirm the ones that are them.`}
                </Text>
            )}

            <Group gap="xs" wrap="wrap">
                {data.groups.length > 0 && (
                    <Button
                        variant="subtle"
                        color="gray"
                        h={44}
                        onClick={() => setShowGroups(!groupsOpen)}
                        aria-expanded={groupsOpen}
                    >
                        {groupsOpen ? "Hide face groups" : "Show face groups"}
                    </Button>
                )}
                {data.confirmedItems < ANCHOR_MIN_ITEMS && (
                    <Button
                        variant="subtle"
                        color="gray"
                        h={44}
                        onClick={() => setShowPick(!showPick)}
                        aria-expanded={showPick}
                    >
                        {showPick ? "Hide their items" : "Pick their face"}
                    </Button>
                )}
                <NoSingleFaceControl tagId={tagId} name={name} />
            </Group>

            {showPick && (
                <PickTheirFace tagId={tagId} name={name} confirmedItems={data.confirmedItems} />
            )}

            <Collapse in={groupsOpen}>
                <Stack gap="sm">
                    <Text size="xs" c="dimmed">
                        How the faces stage grouped {name}&apos;s faces. One person is often several
                        groups. Confirm the ones their tags suggest, or take one back if it was
                        confirmed by mistake.
                    </Text>
                    {data.groups.map((group) => (
                        <GroupRow key={group.groupId} tagId={tagId} name={name} group={group} />
                    ))}
                </Stack>
            </Collapse>
        </Stack>
    );
};
