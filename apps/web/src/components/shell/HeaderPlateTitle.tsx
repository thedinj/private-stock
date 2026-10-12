"use client";

import { useEffect, useState } from "react";
import { Box } from "@mantine/core";

import { useFoldedTitle } from "./foldedTitle";
import classes from "./HeaderPlateTitle.module.scss";

/**
 * Where you are, kept in the header once the plate has scrolled out of sight (§14, "Motion").
 *
 * The plate is the screen's letterhead and it takes room; scrolling a long grid gives that room
 * back to the grid, and the name rises into the header beside the wordmark so it is not lost
 * with it. From `sm` up only: a phone's header has the burger and the search in the space.
 *
 * The last title is held while the slot fades out, so it does not go blank before it goes.
 * Decorative to assistive technology, which still has the page's own `h1`.
 */
export const HeaderPlateTitle: React.FC = () => {
    const title = useFoldedTitle();
    const [shown, setShown] = useState<string | null>(null);

    useEffect(() => {
        if (title !== null) setShown(title);
    }, [title]);

    return (
        <Box
            className={classes.slot}
            data-shown={title !== null ? true : undefined}
            visibleFrom="sm"
            aria-hidden
        >
            {shown && <span className={classes.title}>{shown}</span>}
        </Box>
    );
};
