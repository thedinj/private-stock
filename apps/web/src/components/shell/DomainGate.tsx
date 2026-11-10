"use client";

import { useEffect, useState } from "react";
import { Box, Button, Stack } from "@mantine/core";

import { DEFAULT_DOMAIN, domainProfiles, roomToOpen } from "@private-stock/core";

import { CANDLE_HELD_MS, CandleDark } from "@/components/shell/CandleArrival";
import { WineRack } from "@/components/shell/WineRack";
import { usePinStatus } from "@/lib/api/account";
import { useAuth } from "@/lib/api/AuthProvider";
import { useEnabledRooms } from "@/lib/api/rooms";
import { getActiveDomain, hasPassedGate, markGatePassed, switchDomain } from "@/lib/activeDomain";
import { SNUFF_BLACK } from "@/lib/candleSnuff";
import { DURATION, prefersReducedMotion } from "@/lib/motion";
import { usePinEntry } from "@/lib/usePinEntry";

type Phase = "rack" | "leaving" | "arriving" | "in";

/** How long the opened seal is left to split before the lights go: long enough to see it go. */
const SPLIT_MS = 600;

/**
 * The way down into a guarded room (§21 "Getting into the cellar").
 *
 * A tab that opens in the cellar, by taking the stair from the room switcher or by reopening a
 * browser that was last there, finds a wine rack first: the account's PIN is pulled from it,
 * bottle by bottle, and pressing the seal under it tries it. A right PIN splits the seal, puts
 * the lights out to one candle, and the room comes up out of the dark. A wrong one pushes the bottles back and says
 * nothing -- a rack that announced "wrong" would be a lock -- until the last try before this
 * device is signed out, which is worth one quiet line.
 *
 * Once the tab has passed, a reload does not ask again; a new tab or a restarted browser does.
 * Nothing underneath is mounted until then, so no query for the guarded room leaves the tab
 * before the PIN is entered. An account with no PIN has nothing to ask for, and the room opens.
 */
export const DomainGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { user, signOut } = useAuth();
    const domain = getActiveDomain();
    const guarded = domainProfiles[domain].guarded;
    const [phase, setPhase] = useState<Phase>(() =>
        !guarded || hasPassedGate(domain) ? "in" : "rack"
    );
    // Upstairs is the room a tab falls back to (§21 "Turning a room off"). With every room that
    // is not guarded turned off there is no upstairs, and the way back is not offered.
    const upstairs = roomToOpen(DEFAULT_DOMAIN, useEnabledRooms());

    const { data: pinStatus, isPending } = usePinStatus(user !== null && phase === "rack");

    const entry = usePinEntry(() => {
        markGatePassed(domain);
        setPhase(prefersReducedMotion() ? "in" : "leaving");
    });

    // Lights out, then up out of the dark: the rack fades to black, the room mounts under the
    // candle, and the candle's dark lifts off it.
    useEffect(() => {
        if (phase === "leaving") {
            const timer = window.setTimeout(() => setPhase("arriving"), SPLIT_MS + DURATION.leave);
            return () => window.clearTimeout(timer);
        }

        if (phase === "arriving") {
            const timer = window.setTimeout(() => setPhase("in"), CANDLE_HELD_MS);
            return () => window.clearTimeout(timer);
        }
    }, [phase]);

    if (user === null || phase === "in") {
        return <>{children}</>;
    }

    if (phase === "arriving") {
        return (
            <>
                {children}
                <CandleDark />
            </>
        );
    }

    // Asking whether the account has a PIN; nothing is shown in the meantime.
    if (phase === "rack" && isPending) {
        return null;
    }

    // Only a definite "no PIN" opens it. A failed read keeps the rack up: failing open would
    // show the cellar whenever the network blinked.
    if (phase === "rack" && pinStatus?.set === false) {
        return <>{children}</>;
    }

    const leaving = phase === "leaving";
    const note = entry.unreachable
        ? "Could not reach the library. Try again."
        : entry.remaining === 1
          ? "One more and this device signs out."
          : null;

    return (
        <Box
            role="dialog"
            aria-modal
            aria-label={domainProfiles[domain].entrance ?? undefined}
            pos="fixed"
            inset={0}
            style={{
                zIndex: 10_000,
                background: leaving ? SNUFF_BLACK : "var(--ps-ground)",
                transition: `background-color ${DURATION.leave}ms ${SPLIT_MS}ms`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "calc(16px + var(--ps-safe-top)) 16px calc(16px + var(--ps-safe-bottom))",
            }}
        >
            <Stack
                align="center"
                gap="lg"
                w="100%"
                maw={340}
                style={{
                    opacity: leaving ? 0 : 1,
                    transition: `opacity ${DURATION.leave}ms ${SPLIT_MS}ms`,
                }}
            >
                <WineRack
                    label="Wine rack"
                    count={entry.digits.length}
                    onDigit={entry.press}
                    onBack={entry.back}
                    onClear={entry.clear}
                    onTry={() => void entry.submit()}
                    opened={leaving}
                    disabled={entry.busy || leaving}
                    note={note}
                    captureKeys
                    autoFocus
                />

                <Stack gap={4} align="center">
                    {!domainProfiles[upstairs].guarded && (
                        <Button
                            variant="subtle"
                            color="gray"
                            size="md"
                            onClick={() => switchDomain(upstairs)}
                        >
                            Back upstairs
                        </Button>
                    )}
                    <Button variant="subtle" color="gray" size="xs" onClick={() => void signOut()}>
                        Forgot it? Sign out
                    </Button>
                </Stack>
            </Stack>
        </Box>
    );
};
