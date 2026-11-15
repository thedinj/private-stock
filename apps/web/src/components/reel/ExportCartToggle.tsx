"use client";

import { ActionIcon, Tooltip } from "@mantine/core";

import type { Reel } from "@private-stock/core";

import { CheckGlyph, PlusGlyph } from "@/components/media/Glyph";
import { useExportCart } from "@/lib/exportCart";

/**
 * Puts a reel in the export cart, or takes it out (§14d "Editor export").
 *
 * Laid over the card's mosaic beside the link rather than inside it, so the card stays one link
 * and this stays one button: a control nested in an anchor is two targets that both answer a
 * tap. Always visible rather than on hover, because a phone has no hover.
 */
export const ExportCartToggle: React.FC<{ reel: Reel }> = ({ reel }) => {
    const cart = useExportCart();
    const held = cart.has(reel.id);
    const label = held
        ? "Take out of the export cart"
        : cart.full
          ? "The export cart is full"
          : "Add to the export cart";

    return (
        <Tooltip label={label} withinPortal openDelay={400}>
            <ActionIcon
                size={44}
                radius="xl"
                variant={held ? "filled" : "default"}
                color={held ? "brass" : undefined}
                aria-label={label}
                aria-pressed={held}
                disabled={!held && cart.full}
                onClick={() => cart.toggle({ id: reel.id, name: reel.name })}
                style={{ position: "absolute", top: 12, right: 12 }}
            >
                {held ? <CheckGlyph size={18} /> : <PlusGlyph size={18} />}
            </ActionIcon>
        </Tooltip>
    );
};
