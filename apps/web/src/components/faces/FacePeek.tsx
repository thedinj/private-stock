"use client";

import { Box, Button, Group, SegmentedControl, Stack, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";

import type { FaceReviewFace } from "@private-stock/core";

import { spriteCropStyle } from "@/lib/spriteCrop";
import { formatTimecode } from "@/lib/timecode";

import { FaceCropView } from "./FaceCropView";
import type { TickState } from "./faceControls";

/**
 * A closer look at one person on a card (§5f "A person in a video"), without leaving it:
 * the whole frame it was found in, with the face marked, and the same item's other moments of
 * that person. Most "is that them?" is settled here; "Play it here" is for the rest.
 */
export const FacePeek: React.FC<{
    /** The same person's other moments in the item: an appearance's (§5f). */
    others: FaceReviewFace[];
    face: FaceReviewFace;
    /** What is being said of the face; without it the look only looks. */
    state?: TickState;
    /** Whether "unsure" is offered: not while naming someone else. */
    threeWay: boolean;
    onSet?: (state: TickState) => void;
    onPlay: () => void;
}> = ({ others, face, state, threeWay, onSet, onPlay }) => {
    const isPhone = useMediaQuery("(max-width: 48em)");
    const { frame, rect } = face.crop;
    const width = isPhone ? 260 : 380;
    // The square around the face, as fractions of the frame.
    const mark = {
        left: `${((rect.x - frame.x) / frame.width) * 100}%`,
        top: `${((rect.y - frame.y) / frame.height) * 100}%`,
        width: `${(rect.width / frame.width) * 100}%`,
        height: `${(rect.height / frame.height) * 100}%`,
    };
    const more = others.filter((other) => other.id !== face.id);

    return (
        <Stack gap="xs" w={width}>
            <Box
                style={{
                    position: "relative",
                    width,
                    aspectRatio: `${frame.width} / ${frame.height}`,
                    borderRadius: 6,
                    background: "var(--ps-well)",
                    ...spriteCropStyle(face.crop.url, frame),
                }}
                role="img"
                aria-label="The frame this face was found in"
            >
                <Box
                    aria-hidden
                    style={{
                        position: "absolute",
                        ...mark,
                        border: "2px solid var(--mantine-color-brass-5)",
                        borderRadius: 4,
                    }}
                />
            </Box>

            {face.kind === "video" && face.atMs !== null && (
                <Text size="xs" c="dimmed">
                    At {formatTimecode(face.atMs)}
                </Text>
            )}

            {more.length > 0 ? (
                <Stack gap={4}>
                    <Text size="xs" c="dimmed">
                        The same person elsewhere in this item
                    </Text>
                    <Group gap={6}>
                        {more.map((other) => (
                            <FaceCropView key={other.id} crop={other.crop} size={64} />
                        ))}
                    </Group>
                </Stack>
            ) : null}

            <Group gap="xs">
                {state && onSet && (
                    <SegmentedControl
                        size="xs"
                        color="brass"
                        value={state}
                        onChange={(value) => onSet(value as TickState)}
                        data={[
                            { value: "in", label: "Them" },
                            { value: "out", label: "Not them" },
                            ...(threeWay ? [{ value: "unsure", label: "Unsure" }] : []),
                        ]}
                    />
                )}
                <Button size="compact-sm" variant="default" onClick={onPlay}>
                    {face.kind === "video" ? "Play it here" : "See it here"}
                </Button>
            </Group>
        </Stack>
    );
};
