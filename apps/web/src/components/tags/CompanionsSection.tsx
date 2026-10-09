"use client";

import Link from "next/link";
import { Box, Button, Group, Skeleton, Text } from "@mantine/core";

import { COMPANION_STRIPS } from "@private-stock/core";

import { LoadFailed } from "@/components/LoadFailed";
import { SectionHead } from "@/components/library/LibraryRoom";
import { useTagCompanions } from "@/lib/api/tags";
import { useNearViewport } from "@/lib/useNearViewport";

import { CompanionRow } from "./CompanionRow";
import rowClasses from "@/components/browse/FilmstripRow.module.scss";

/**
 * "Appears with" on a performer's page, fetched on its own and only when it is nearly in view
 * (§6 "Tags", §20).
 *
 * It was part of the profile, so every visit waited on it and the web process -- synchronous,
 * one thread -- was stopped for everyone while it was read. Now the page draws its own content
 * first and this asks once the section is within a screen of the viewport, which on a phone is
 * usually after a scroll and on a desktop usually at once. The answer is cached for minutes
 * (`useTagCompanions`), so coming back to the performer does not ask again.
 *
 * Under the shelves rather than above them: the tag's own items are what the page is for, and
 * the people they appear with are the next question, not the first.
 */

/** Placeholder rows while the answer is on its way, so the section does not grow from nothing. */
const PLACEHOLDER_ROWS = 3;

interface CompanionsSectionProps {
    /** The performer whose page this is. */
    tagId: string;
    /** The profile's seed, so the strips stay put for the visit. */
    seed: number;
}

/** A row's shape with nothing in it yet: the name, the strip, the link, at their real sizes. */
const PlaceholderRow: React.FC = () => (
    <Box className={rowClasses.row} aria-hidden>
        <Box className={rowClasses.label}>
            <Skeleton height={20} width="70%" radius="xs" />
            <Skeleton height={12} width="40%" radius="xs" mt={6} />
        </Box>
        <Box className={rowClasses.strip}>
            {Array.from({ length: COMPANION_STRIPS }, (_, index) => (
                <Box key={index} style={{ aspectRatio: "16 / 9" }}>
                    <Skeleton height="100%" radius="xs" />
                </Box>
            ))}
        </Box>
        <Box className={rowClasses.actions}>
            {/* The height of "See all →" with its thumb-sized padding. */}
            <Skeleton height={20} width={56} radius="xs" my={12} />
        </Box>
    </Box>
);

export const CompanionsSection: React.FC<CompanionsSectionProps> = ({ tagId, seed }) => {
    const { ref, near } = useNearViewport<HTMLDivElement>();
    const { data, error, refetch } = useTagCompanions(tagId, seed, near);

    if (error) {
        return (
            <Box>
                <SectionHead title="Appears with" />
                <LoadFailed
                    error={error}
                    what="who appears with them"
                    onRetry={() => void refetch()}
                />
            </Box>
        );
    }

    if (!data) {
        return (
            <Box ref={ref} aria-busy>
                <SectionHead title="Appears with" />
                {Array.from({ length: PLACEHOLDER_ROWS }, (_, index) => (
                    <PlaceholderRow key={index} />
                ))}
            </Box>
        );
    }

    const { companions } = data;

    if (companions.length === 0) {
        return null;
    }

    return (
        <Box>
            {/* The people seen most with this one get a strip of what they share; the rest
                stay names, so the section is not a hundred thumbnails long. */}
            <SectionHead title="Appears with" />
            {companions.slice(0, COMPANION_STRIPS).map((companion) => (
                <CompanionRow
                    key={companion.tagId}
                    tagId={tagId}
                    companion={companion}
                    seed={seed}
                    // Names in line, once any of these has a portrait (§6 "A tag's picture").
                    pictureSlot={companions
                        .slice(0, COMPANION_STRIPS)
                        .some((other) => other.picture !== null)}
                />
            ))}
            {companions.length > COMPANION_STRIPS && (
                <Group gap="xs" wrap="wrap" mt="md">
                    {companions.slice(COMPANION_STRIPS).map((companion) => (
                        <Button
                            key={companion.tagId}
                            component={Link}
                            href={`/tags/${companion.tagId}?seed=${seed}`}
                            variant="default"
                            radius="xl"
                            size="sm"
                            rightSection={
                                <Text span size="xs" c="dimmed">
                                    {companion.shared.toLocaleString()}
                                </Text>
                            }
                        >
                            {companion.name}
                        </Button>
                    ))}
                </Group>
            )}
        </Box>
    );
};
