"use client";

import { ActionIcon, Tooltip } from "@mantine/core";

import { KeyGlyph } from "@/components/media/Glyph";
import { useScreenLock } from "@/components/shell/ScreenLock";

/**
 * Locking the cellar from the header (§12c, decided 2026-11-13): the key beside the projector,
 * one press and the wine rack is back over the page. Only in a guarded room, and only for an
 * account with a PIN -- elsewhere there is nothing for it to lock, so it is not drawn.
 */
export const LockCellar: React.FC = () => {
    const { lockable, lockNow } = useScreenLock();

    if (!lockable) return null;

    return (
        <Tooltip label="Lock the cellar">
            <ActionIcon
                variant="subtle"
                color="gray"
                size={44}
                aria-label="Lock the cellar"
                onClick={lockNow}
            >
                <KeyGlyph size={20} />
            </ActionIcon>
        </Tooltip>
    );
};
