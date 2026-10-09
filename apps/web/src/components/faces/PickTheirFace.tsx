"use client";

import Link from "next/link";
import { Anchor, Button, Group, Loader, Paper, Stack, Text, UnstyledButton } from "@mantine/core";

import { ANCHOR_MIN_ITEMS, type OwnFacesItem } from "@private-stock/core";

import { LoadFailed } from "@/components/LoadFailed";
import { useOwnFaces, usePickOwnFace } from "@/lib/api/faces";
import { itemHref } from "@/lib/lookMoment";

import { FaceCropView } from "./FaceCropView";

/**
 * "Pick their face" (§5f "Picking their face"): for the performer neither their tags nor the face
 * groups could find a face for. Their own items, each with its faces, one a person; a press says
 * "that's them" of one face on one item, and a second press takes it back. Picked on a few items,
 * it is their reference, and matching and the auto-tagger take it from there.
 */

const ItemRow: React.FC<{ tagId: string; name: string; item: OwnFacesItem }> = ({
    tagId,
    name,
    item,
}) => {
    const pick = usePickOwnFace(tagId);

    return (
        <Paper withBorder radius="md" p="xs">
            <Group gap={6} wrap="wrap" align="center">
                {item.faces.map((face) => {
                    const theirs = item.theirs === face.id;

                    return (
                        <UnstyledButton
                            key={face.id}
                            disabled={pick.isPending}
                            onClick={() => pick.mutate({ faceId: face.id, theirs: !theirs })}
                            aria-pressed={theirs}
                            aria-label={theirs ? `${name}: press to take back` : `That's ${name}`}
                            style={{
                                borderRadius: 8,
                                padding: 2,
                                outline: theirs
                                    ? "3px solid var(--mantine-color-brass-5)"
                                    : "1px solid transparent",
                                opacity: item.theirs && !theirs ? 0.55 : 1,
                            }}
                        >
                            <FaceCropView crop={face.crop} size={72} />
                        </UnstyledButton>
                    );
                })}
                <Anchor
                    component={Link}
                    href={itemHref(item.mediaId, null)}
                    prefetch={false}
                    size="sm"
                    ml="auto"
                >
                    Open
                </Anchor>
            </Group>
        </Paper>
    );
};

export const PickTheirFace: React.FC<{ tagId: string; name: string; confirmedItems: number }> = ({
    tagId,
    name,
    confirmedItems,
}) => {
    const own = useOwnFaces(tagId, true);
    const rows = own.data?.pages.flatMap((page) => page.items) ?? [];
    const left = ANCHOR_MIN_ITEMS - confirmedItems;

    if (own.error) {
        return (
            <LoadFailed error={own.error} what="their items" onRetry={() => void own.refetch()} />
        );
    }

    if (own.isPending) {
        return <Loader size="sm" />;
    }

    if (rows.length === 0) {
        return (
            <Text size="sm" c="dimmed">
                None of {name}&apos;s tagged items has a face on it yet.
            </Text>
        );
    }

    return (
        <Stack gap="xs">
            <Text size="xs" c="dimmed">
                Their items, with the faces on each. Press the one that is {name}
                {left > 0
                    ? ` — on ${left} more ${left === 1 ? "item" : "items"} and their face is learned, and their other items are matched against it.`
                    : "; their face is learned from what is picked."}
            </Text>
            {rows.map((item) => (
                <ItemRow key={item.mediaId} tagId={tagId} name={name} item={item} />
            ))}
            {own.hasNextPage && (
                <Button
                    variant="default"
                    h={44}
                    loading={own.isFetchingNextPage}
                    onClick={() => void own.fetchNextPage()}
                    style={{ alignSelf: "flex-start" }}
                >
                    More of their items
                </Button>
            )}
        </Stack>
    );
};
