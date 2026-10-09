"use client";

import { Box } from "@mantine/core";

import classes from "@/components/playlist/PlaylistCard.module.scss";

/**
 * The panel at the top of a collection card: up to four covers, or what stands in for them.
 *
 * Shared by playlists and saved views so the two cards on one page cannot drift apart in
 * geometry. Fewer than four covers get their own arrangement rather than gaps.
 */

const ARRANGEMENT: Record<number, string> = {
    1: classes.one,
    2: classes.two,
    3: classes.three,
};

/** A collection may carry a strip's worth of covers (§14c); the panel shows four. */
const MOSAIC_COUNT = 4;

export const CoverMosaic: React.FC<{
    covers: string[];
    /** Shown when there are no covers. Absent while they are still on their way. */
    empty?: React.ReactNode;
}> = ({ covers, empty }) => (
    <Box
        className={`${classes.mosaic} ${ARRANGEMENT[Math.min(covers.length, MOSAIC_COUNT)] ?? ""}`}
    >
        {covers.slice(0, MOSAIC_COUNT).map((cover) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={cover} src={cover} alt="" className={classes.cell} loading="lazy" />
        ))}

        {covers.length === 0 && empty && <Box className={classes.empty}>{empty}</Box>}
    </Box>
);
