"use client";

import { useEffect, useRef } from "react";
import { ActionIcon } from "@mantine/core";

import { ViewerKeyTip } from "@/components/KeyTip";
import { ProjectorGlyph } from "@/components/media/Glyph";
import { DEFAULT_VIEW, newShuffleSeed } from "@/lib/libraryQuery";
import { usePlayFromTop } from "@/lib/playFromTop";
import { isTypingTarget } from "@/lib/typingTarget";
import { enterPlayerFullscreen } from "@/lib/usePlayerFullscreen";
import { keyPress } from "@/lib/viewerKeys";

/**
 * Private screening (§14h): the room's videos, freshly shuffled, opened at the first one in the
 * viewer, full screen. Exactly the Videos tab, Shuffle and Play › From the top, from anywhere in
 * one press.
 *
 * In the header, beside search, and on `Shift+S` from any page of the shell -- the viewer
 * included, where it deals a new shuffle without leaving.
 */
export const PrivateScreening: React.FC = () => {
    const playFromTop = usePlayFromTop();
    /** A press while the first page is still on its way is the same screening, not another. */
    const busy = useRef(false);

    const screen = () => {
        if (busy.current) return;
        busy.current = true;

        // Asked for first, inside the press: by the time the page arrives the gesture is gone.
        const undo = enterPlayerFullscreen();

        playFromTop(
            {
                ...DEFAULT_VIEW,
                kind: "video",
                mode: "grid",
                sort: "random",
                seed: newShuffleSeed(),
            },
            false,
            true
        )
            .then((opened) => {
                if (!opened) undo();
            })
            .catch(() => undo())
            .finally(() => {
                busy.current = false;
            });
    };

    // The latest `screen` for the listener, which is added once.
    const screenRef = useRef(screen);
    screenRef.current = screen;

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
            if (keyPress(event) !== "S") return;
            if (isTypingTarget(event.target)) return;
            // A dialogue has the page, as with `/` (HeaderSearch).
            if (document.querySelector('[aria-modal="true"]')) return;

            event.preventDefault();
            screenRef.current();
        };

        window.addEventListener("keydown", onKey);

        return () => window.removeEventListener("keydown", onKey);
    }, []);

    return (
        <ViewerKeyTip action="screening" label="Private screening: shuffled videos, full screen">
            <ActionIcon
                variant="subtle"
                color="gray"
                size={44}
                aria-label="Private screening"
                onClick={screen}
            >
                <ProjectorGlyph size={20} />
            </ActionIcon>
        </ViewerKeyTip>
    );
};
