"use client";

import { useCallback, useState } from "react";

/**
 * The names in a `TagsInput`, including the one still being typed.
 *
 * Mantine commits the text in the box on Enter or on blur, and blur is too late for Tab: the
 * browser picks the next focusable element while `names` is still empty, so an Apply button
 * disabled on `names.length === 0` is skipped and focus lands on the modal's close button —
 * somebody who typed a tag and pressed Tab is one Enter away from dismissing the dialogue
 * instead of applying it.
 *
 * Tracking the search value fixes both halves: `ready` is true the moment there is something
 * worth applying, so the button is already enabled when Tab looks for it, and `collect()`
 * folds the uncommitted text in so pressing it applies what is on screen rather than what
 * Mantine happens to have committed.
 */
/** `initial` is what the box opens holding, such as the tag a "Find untagged" came from. */
export const useTagNames = (initial: string[] = []) => {
    const [names, setNames] = useState<string[]>(initial);
    const [pending, setPending] = useState("");

    /** Every name to write: the committed chips plus whatever is still in the box. */
    const collect = useCallback(() => {
        const typed = pending.trim();

        return typed && !names.includes(typed) ? [...names, typed] : names;
    }, [names, pending]);

    const reset = useCallback(() => {
        setNames([]);
        setPending("");
    }, []);

    return {
        names,
        /** Spread onto the `TagsInput`. */
        inputProps: {
            value: names,
            onChange: setNames,
            searchValue: pending,
            onSearchChange: setPending,
        },
        collect,
        reset,
        ready: names.length > 0 || pending.trim().length > 0,
    };
};
