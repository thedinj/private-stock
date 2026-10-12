import { Box } from "@mantine/core";

import { useFlipGrid } from "@/lib/useFlipGrid";

/**
 * A wall of cards that shows its changes (§14, "Motion"), for the pages that build their wall
 * in a helper called once per group -- Captures, Clips -- where a hook cannot be called inline.
 *
 * Each child must already be a slot carrying `data-flip-key`, in the same order as `keys`; the
 * slot is what moves, never the card's picture on its own.
 */
export const FlipWall: React.FC<{
    keys: string[];
    style: React.CSSProperties;
    children: React.ReactNode;
}> = ({ keys, style, children }) => {
    const { ref } = useFlipGrid(keys);

    return (
        <Box ref={ref} style={style}>
            {children}
        </Box>
    );
};
