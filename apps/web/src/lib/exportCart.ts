import { useCallback, useSyncExternalStore } from "react";
import { z } from "zod";

import { MAX_EXPORT_REELS } from "@private-stock/core";

import { roomKey } from "./activeDomain";

/**
 * The reels set aside to go to Resolve together (§14d "Editor export").
 *
 * A cart rather than a selection, because the reels come from different pages, filters and
 * searches of a paged index -- and sometimes from inside a reel -- and a selection does not
 * survive moving between them. It is kept on the device, not the account: it is a pile on this
 * desk for the editing session in progress, and nobody else needs to see it. Per room (§21), so a
 * reel from one room never asks the API of another.
 *
 * The name rides along so the cart can be read without fetching anything; the preview is what
 * says which reels still exist, and the dialog prunes the rest.
 */

const KEY = "ps:exportCart";

const cartSchema = z.array(z.object({ id: z.string(), name: z.string() }));

export type CartReel = z.infer<typeof cartSchema>[number];

const EMPTY: CartReel[] = [];
const listeners = new Set<() => void>();

/** The parsed cart for the last raw value seen, so a snapshot is stable between changes. */
let cached: { raw: string | null; reels: CartReel[] } = { raw: null, reels: EMPTY };

const readRaw = (): string | null => {
    try {
        return localStorage.getItem(roomKey(KEY));
    } catch {
        return null;
    }
};

const snapshot = (): CartReel[] => {
    const raw = readRaw();

    if (raw === cached.raw) return cached.reels;

    let reels = EMPTY;

    try {
        const parsed = cartSchema.safeParse(raw ? JSON.parse(raw) : []);

        reels = parsed.success ? parsed.data.slice(0, MAX_EXPORT_REELS) : EMPTY;
    } catch {
        // A value this code did not write: an empty cart rather than a broken page.
    }

    cached = { raw, reels };

    return reels;
};

const write = (reels: CartReel[]) => {
    try {
        if (reels.length === 0) localStorage.removeItem(roomKey(KEY));
        else localStorage.setItem(roomKey(KEY), JSON.stringify(reels));
    } catch {
        // Storage off: nothing to remember it in, and nothing else to do about it.
    }

    listeners.forEach((listener) => listener());
};

const subscribe = (listener: () => void) => {
    listeners.add(listener);
    // Another tab of the same browser changing the cart.
    window.addEventListener("storage", listener);

    return () => {
        listeners.delete(listener);
        window.removeEventListener("storage", listener);
    };
};

export const useExportCart = () => {
    const reels = useSyncExternalStore(subscribe, snapshot, () => EMPTY);

    const has = useCallback((id: string) => reels.some((reel) => reel.id === id), [reels]);

    const toggle = useCallback((reel: CartReel) => {
        const current = snapshot();

        if (current.some((held) => held.id === reel.id)) {
            write(current.filter((held) => held.id !== reel.id));
        } else if (current.length < MAX_EXPORT_REELS) {
            write([...current, { id: reel.id, name: reel.name }]);
        }
    }, []);

    const remove = useCallback((id: string) => {
        write(snapshot().filter((held) => held.id !== id));
    }, []);

    const clear = useCallback(() => write([]), []);

    return {
        reels,
        has,
        full: reels.length >= MAX_EXPORT_REELS,
        toggle,
        remove,
        clear,
    };
};
