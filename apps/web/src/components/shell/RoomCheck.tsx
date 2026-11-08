"use client";

import { useEffect, useState } from "react";

import { roomToOpen } from "@private-stock/core";

import { useAuth } from "@/lib/api/AuthProvider";
import { useRooms } from "@/lib/api/rooms";
import { getActiveDomain, switchDomain } from "@/lib/activeDomain";

/**
 * Moves a tab out of a room that has been turned off (§21 "Turning a room off").
 *
 * Asked once per page load, before anything in the room is mounted, and around the gate rather
 * than inside it: the move is a `switchDomain`, a reload that forgets this tab passed any gate,
 * so a fallback that lands in a guarded room meets its rack like any other way in.
 *
 * Decided once. A room turned off while a tab is in it -- the admin's own, from the Libraries
 * page -- is left on the next load, not pulled out from under whoever is there.
 *
 * A failed read opens the room it was in. A room that is off is hidden, not locked: what keeps
 * a guarded room closed is its gate, which is still underneath.
 */
export const RoomCheck: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { user } = useAuth();
    const { data, isError } = useRooms();
    const [settled, setSettled] = useState(false);

    useEffect(() => {
        if (settled || !data) {
            return;
        }

        const active = getActiveDomain();
        const target = roomToOpen(active, data.enabled);

        if (target === active) {
            setSettled(true);
        } else {
            switchDomain(target);
        }
    }, [data, settled]);

    if (user === null || isError || settled) {
        return <>{children}</>;
    }

    return null;
};
