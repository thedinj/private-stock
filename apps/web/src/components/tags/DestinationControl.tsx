"use client";

import { SegmentedControl, Stack, Text } from "@mantine/core";

import { allowsPrivate } from "@private-stock/core";

import { facetLabel } from "@/lib/facetLabels";
import { destinationKey, type TagDestination } from "@/lib/tagDestinations";

/**
 * The facet-and-audience switch over a bulk or quick tagging box (§6).
 *
 * The two keyword segments sit together, each saying which it is under the facet. Performer and
 * Source say nothing more: they are always the library's, and a "shared" under them would be the
 * same word on every segment where there is no other choice to tell it from.
 */
interface DestinationControlProps {
    options: TagDestination[];
    value: TagDestination;
    onChange: (next: TagDestination) => void;
    size?: "xs" | "sm";
}

export const DestinationControl: React.FC<DestinationControlProps> = ({
    options,
    value,
    onChange,
    size = "sm",
}) => (
    <SegmentedControl
        fullWidth
        color="brass"
        size={size}
        value={destinationKey(value)}
        onChange={(key) =>
            onChange(options.find((option) => destinationKey(option) === key) ?? options[0])
        }
        // Two lines each, so not the theme's toolbar height, which clipped the second; and four
        // across a phone leaves little room, so less inline padding than the default, which
        // truncated "Performer".
        styles={{
            root: { height: "auto" },
            label: { paddingInline: 4, justifyContent: "center" },
        }}
        data={options.map((option) => ({
            value: destinationKey(option),
            label: (
                <Stack gap={0} align="center">
                    <Text size={size} inherit>
                        {facetLabel(option.kind)}
                    </Text>
                    {/* Opacity rather than `dimmed`, so it stays legible on the filled segment
                        as well as the bare ones. */}
                    {allowsPrivate(option.kind) && (
                        <Text size="xs" opacity={0.7}>
                            {option.scope === "public" ? "shared" : "private"}
                        </Text>
                    )}
                </Stack>
            ),
        }))}
    />
);
