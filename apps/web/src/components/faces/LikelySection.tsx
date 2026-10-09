"use client";

import Link from "next/link";
import { Box, Button, Center, Group, Skeleton, Stack, Text } from "@mantine/core";

import type { FaceMatchState, LikelyItem, MentionField } from "@private-stock/core";

import { LoadFailed } from "@/components/LoadFailed";
import { MediaTile } from "@/components/MediaTile";
import { SectionHead } from "@/components/library/LibraryRoom";
import { useDecideLikely, useLikely } from "@/lib/api/faces";
import { GRID_GAP, GRID_TRACKS } from "@/lib/gridGeometry";
import { untaggedMentionsHref } from "@/lib/libraryQuery";
import { useNearViewport } from "@/lib/useNearViewport";

import { FaceCropView } from "./FaceCropView";

/**
 * "Likely" on a performer's page (§5f): untagged items where a face of theirs and their name
 * agree — the strongest evidence there is, and the one thing no other place shows. "Add" tags as
 * a batch the undo list can withdraw; "Not them" refuses both what put it here, the face and the
 * name, so it is asked about nowhere again.
 *
 * Each other kind of evidence has one place: a face alone is asked about in Review › Faces,
 * beside the rest of its group, counted under "Their face"; a name alone is "Find untagged", in
 * the grid, where a long list is ticked fastest — counted and linked here.
 */

const FIELD_WORDS: Record<MentionField, string> = {
    filename: "filename",
    title: "title",
    screen: "on screen",
};

const FACE_WORDS: Record<FaceMatchState, string> = {
    confirmed: "their confirmed face",
    proposed: "a face their tags suggest",
    resembles: "a face like their confirmed one",
};

const why = (entry: LikelyItem): string =>
    [
        entry.face ? FACE_WORDS[entry.face] : null,
        entry.mentions.length > 0
            ? `named in the ${entry.mentions.map((field) => FIELD_WORDS[field]).join(", ")}`
            : null,
    ]
        .filter(Boolean)
        .join(" · ");

const items = (n: number): string => `${n.toLocaleString()} ${n === 1 ? "item" : "items"}`;

const LikelyCard: React.FC<{ tagId: string; name: string; entry: LikelyItem }> = ({
    tagId,
    name,
    entry,
}) => {
    const decide = useDecideLikely(tagId);

    return (
        <Stack gap={6}>
            <MediaTile item={entry.item} />
            <Group gap="xs" wrap="nowrap" align="center">
                {entry.crop && <FaceCropView crop={entry.crop} size={44} />}
                <Text size="xs" c="dimmed" style={{ minWidth: 0 }}>
                    {why(entry)}
                </Text>
            </Group>
            <Group gap="xs" grow>
                <Button
                    color="brass"
                    variant="light"
                    h={44}
                    loading={decide.isPending && decide.variables?.verdict === "add"}
                    onClick={() => decide.mutate({ verdict: "add", mediaIds: [entry.item.id] })}
                >
                    Add {name}
                </Button>
                <Button
                    variant="default"
                    h={44}
                    loading={decide.isPending && decide.variables?.verdict === "refuse"}
                    onClick={() => decide.mutate({ verdict: "refuse", mediaId: entry.item.id })}
                >
                    Not {name}
                </Button>
            </Group>
        </Stack>
    );
};

export const LikelySection: React.FC<{ tagId: string; name: string }> = ({ tagId, name }) => {
    const { ref, near } = useNearViewport<HTMLDivElement>();
    const { data, error, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } = useLikely(
        tagId,
        near
    );
    const decide = useDecideLikely(tagId);
    const entries = data?.pages.flatMap((page) => page.items) ?? [];
    const first = data?.pages[0];
    const total = first?.total ?? 0;

    return (
        <Box ref={ref}>
            <SectionHead title={total > 0 ? `Likely · ${total.toLocaleString()}` : "Likely"} />

            {error ? (
                <LoadFailed error={error} what="the likely items" onRetry={() => void refetch()} />
            ) : !data || !first ? (
                <Skeleton height={160} radius="md" />
            ) : (
                <Stack gap="md">
                    <Text size="sm" c="dimmed">
                        {total > 0
                            ? `Untagged items with both a face of ${name}'s and their name.`
                            : `No untagged item has both a face of ${name}'s and their name.`}
                    </Text>

                    {first.nameOnly > 0 && (
                        <Group gap="xs" wrap="wrap">
                            <Button
                                component={Link}
                                href={untaggedMentionsHref(tagId)}
                                prefetch={false}
                                variant="subtle"
                                color="brass"
                                h={44}
                            >
                                {items(first.nameOnly)} with only their name → Find untagged
                            </Button>
                        </Group>
                    )}

                    {total > 0 && (
                        <>
                            <Group>
                                <Button
                                    variant="light"
                                    color="brass"
                                    h={44}
                                    loading={
                                        decide.isPending && decide.variables?.verdict === "addAll"
                                    }
                                    onClick={() => decide.mutate({ verdict: "addAll" })}
                                >
                                    Add {name} to all {total.toLocaleString()}
                                </Button>
                            </Group>

                            <Box
                                style={{
                                    display: "grid",
                                    gridTemplateColumns: GRID_TRACKS,
                                    gap: GRID_GAP,
                                }}
                            >
                                {entries.map((entry) => (
                                    <LikelyCard
                                        key={entry.item.id}
                                        tagId={tagId}
                                        name={name}
                                        entry={entry}
                                    />
                                ))}
                            </Box>

                            {hasNextPage && (
                                <Center>
                                    <Button
                                        variant="default"
                                        h={44}
                                        loading={isFetchingNextPage}
                                        onClick={() => void fetchNextPage()}
                                    >
                                        Show more
                                    </Button>
                                </Center>
                            )}
                        </>
                    )}
                </Stack>
            )}
        </Box>
    );
};
