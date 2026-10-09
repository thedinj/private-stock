"use client";

import { Box, Stack } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";

import classes from "./BrowseToolbar.module.scss";

/**
 * The controls above a browse page's list: Performers, Sources, Keywords, Views & playlists
 * (§6 "Tags", §14c).
 *
 * The same controls in the same order on every page that has them, so each is where somebody
 * expects it: which shelf, if the page has a choice of one (All / Views / Playlists), then the
 * search, the order, rows or tiles, and the filters last.
 *
 * Pinned under the header on a wide screen, as the library's working row is: changing the order
 * from the fortieth row should not mean scrolling back up first. On a phone the controls stack
 * and scroll away with the page -- the screen is too short to give them up for good.
 */
export const BrowseToolbar: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const wide = useBrowseWide();

    return wide ? (
        <Box className={classes.toolbar}>{children}</Box>
    ) : (
        <Stack gap="sm">{children}</Stack>
    );
};

/** Whether the toolbar is one pinned line, which is when its controls take their natural size. */
export const useBrowseWide = (): boolean => useMediaQuery("(min-width: 62em)") ?? true;

/** A phone's tap target, the height the library's controls use there. */
export const BROWSE_TOUCH_HEIGHT = "2.75rem";
