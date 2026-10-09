"use client";

import { useMemo } from "react";
import Link from "next/link";
import { Box, Button, Center, Loader, Stack, Tabs, Text } from "@mantine/core";

import { reviewMedia } from "@private-stock/core";

import { LoadFailed } from "@/components/LoadFailed";
import { FaceReviewSheet } from "@/components/faces/FaceReviewSheet";
import { LikelySection } from "@/components/faces/LikelySection";
import { TheirFaceSection } from "@/components/faces/TheirFaceSection";
import { SectionHead } from "@/components/library/LibraryRoom";
import { PagePlate } from "@/components/shell/PagePlate";
import { useAuth } from "@/lib/api/AuthProvider";
import { useTagProfile } from "@/lib/api/tags";
import { facetLabel } from "@/lib/facetLabels";
import { untaggedMentionsHref } from "@/lib/libraryQuery";
import { defineView, enumField, useUrlView } from "@/lib/urlView";
import { useTagSeed } from "@/lib/useTagSeed";

/**
 * One tag's organising, apart from its page (§6 "Tags", §5f "Starting from the performer").
 *
 * The tag's page is for browsing it; finding more of it is here. For a library performer, to an
 * administrator, two tabs:
 *
 * - **To check**: everything that says an untagged item is them, strongest first. Where a face
 *   of theirs and their name agree ("Likely"), item by item, with "Add to all"; then their face
 *   groups, as Review › Faces asks about them, a group's items at a time; and what only their
 *   name points to, handed to the grid, where a long list is ticked fastest.
 * - **Their face**: what is confirmed, and the groups behind it, to take one back.
 *
 * Everything else -- a source, a keyword, a private tag, or anybody but an administrator -- has
 * only the grid hand-off, "Find untagged".
 */

const FindUntagged: React.FC<{ tagId: string; name: string }> = ({ tagId, name }) => (
    <Box>
        <SectionHead title="Find untagged" />
        <Stack gap="sm" align="flex-start">
            <Text size="sm" c="dimmed">
                Files that name {name} but are not tagged with it, in the library grid, where they
                can be ticked and tagged.
            </Text>
            <Button
                component={Link}
                href={untaggedMentionsHref(tagId)}
                prefetch={false}
                variant="light"
                color="brass"
                h={44}
            >
                Find untagged
            </Button>
        </Stack>
    </Box>
);

const PerformerOrganise: React.FC<{ tagId: string; name: string }> = ({ tagId, name }) => {
    const view = useMemo(
        () =>
            defineView(`/tags/${tagId}/organise`, {
                tab: enumField("tab", ["check", "face"], "check"),
                media: enumField("media", reviewMedia, "video"),
            }),
        [tagId]
    );
    const [state, apply] = useUrlView(view);

    return (
        <Tabs
            value={state.tab}
            onChange={(value) => value && apply({ tab: value === "face" ? "face" : "check" })}
            color="brass"
            keepMounted={false}
        >
            <Tabs.List mb="lg">
                <Tabs.Tab value="check">To check</Tabs.Tab>
                <Tabs.Tab value="face">Their face</Tabs.Tab>
            </Tabs.List>

            <Tabs.Panel value="check">
                <Stack gap={40}>
                    {/* Links to "Find untagged" itself, counted, for what only the name points to. */}
                    <LikelySection tagId={tagId} name={name} />

                    {/* Last: it is a long list that loads as it is read. */}
                    <Box>
                        <SectionHead title="Face groups" />
                        <FaceReviewSheet
                            tab="matches"
                            performer={tagId}
                            media={state.media}
                            onMedia={(media) => apply({ media })}
                        />
                    </Box>
                </Stack>
            </Tabs.Panel>

            <Tabs.Panel value="face">
                <TheirFaceSection tagId={tagId} name={name} />
            </Tabs.Panel>
        </Tabs>
    );
};

export const TagOrganise: React.FC<{ tagId: string }> = ({ tagId }) => {
    const { hasScope } = useAuth();
    // The tag's own page has usually just asked for this, under today's seed.
    const { seed } = useTagSeed();
    const { data, error, isLoading, refetch } = useTagProfile(tagId, seed);

    if (error) {
        return <LoadFailed error={error} what="this tag" onRetry={() => void refetch()} />;
    }

    if (isLoading || !data) {
        return (
            <Center h={320}>
                <Loader size="sm" color="brass" />
            </Center>
        );
    }

    const { tag } = data;
    const reviewsFaces = tag.kind === "performer" && !tag.private && hasScope("admin");

    return (
        <Stack gap="lg">
            <PagePlate
                eyebrow={`Organise · ${facetLabel(tag.kind)}`}
                title={tag.name}
                back={{ href: `/tags/${tag.id}`, label: tag.name }}
            />

            {reviewsFaces ? (
                <PerformerOrganise tagId={tag.id} name={tag.name} />
            ) : (
                <FindUntagged tagId={tag.id} name={tag.name} />
            )}
        </Stack>
    );
};
