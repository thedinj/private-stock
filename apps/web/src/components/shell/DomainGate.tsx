"use client";

import { useEffect, useState } from "react";
import { Box, Button, Stack } from "@mantine/core";

import { DEFAULT_DOMAIN, type DomainKind, domainProfiles, roomToOpen } from "@private-stock/core";

import { CANDLE_HELD_MS, CandleDark } from "@/components/shell/CandleArrival";
import { useScreenLock } from "@/components/shell/ScreenLock";
import { WineRack } from "@/components/shell/WineRack";
import { usePinStatus } from "@/lib/api/account";
import { useAuth } from "@/lib/api/AuthProvider";
import { useEnabledRooms } from "@/lib/api/rooms";
import { getActiveDomain, hasPassedGate, markGatePassed, switchDomain } from "@/lib/activeDomain";
import { SNUFF_BLACK } from "@/lib/candleSnuff";
import { DURATION, prefersReducedMotion } from "@/lib/motion";
import { type PinEntry, usePinEntry } from "@/lib/usePinEntry";

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
 *
 * The rack is also the screen lock's face (§12c, decided 2026-11-13): there is one PIN screen,
 * and the PIN opens only the cellar. When the lock comes down the rack goes back up over the
 * room, which stays mounted and inert underneath, so the right PIN returns to the page as it was
 * left -- and "Back upstairs" leaves without it.
 */
export const DomainGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { user, signOut } = useAuth();
    const { locked, unlock } = useScreenLock();
    const domain = getActiveDomain();
    const guarded = domainProfiles[domain].guarded;
    const [phase, setPhase] = useState<Phase>(() =>
        !guarded || hasPassedGate(domain) ? "in" : "rack"
    );
    // Whether the room has been up in this tab. Once it has, the rack the screen lock brings
    // back goes over it rather than in place of it, so the page is where it was left.
    const [underneath, setUnderneath] = useState(false);

    if (!underneath && user !== null && (phase === "in" || phase === "arriving")) {
        setUnderneath(true);
    }

    // Upstairs is the room a tab falls back to (§21 "Turning a room off"). With every room that
    // is not guarded turned off there is no upstairs, and the way back is not offered.
    const upstairs = roomToOpen(DEFAULT_DOMAIN, useEnabledRooms());

    // The rack is asked for on the way in, and again whenever the screen lock comes down.
    const asking =
        user !== null && (phase === "rack" || phase === "leaving" || (phase === "in" && locked));

    const { data: pinStatus, isPending } = usePinStatus(asking);

    const entry = usePinEntry(() => {
        markGatePassed(domain);
        unlock();
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

    // Only a definite "no PIN" opens it. A failed read keeps the rack up: failing open would
    // show the cellar whenever the network blinked.
    const open = asking && phase !== "leaving" && pinStatus?.set === false;
    const covered = asking && !open;
    // Asking whether the account has a PIN: a blank cover in the meantime.
    const rackUp = covered && (phase === "leaving" || !isPending);

    // In the capture phase, and nothing else hears the key: a page underneath has shortcuts of
    // its own on `window` (the viewer's Space plays), and `inert` stops focus, not listeners.
    // The rack's own listener was added first (a child's effect runs before its parent's).
    useEffect(() => {
        if (!covered) return;

        const stop = (event: KeyboardEvent) => event.stopImmediatePropagation();
        window.addEventListener("keydown", stop, { capture: true });

        return () => window.removeEventListener("keydown", stop, { capture: true });
    }, [covered]);

    // One shape on every path, so the page is never remounted by the rack coming or going.
    // Nothing is mounted under the rack on the way in, so no query for the guarded room leaves
    // the tab before the PIN is entered.
    return (
        <>
            {(!covered || underneath) && (
                <div style={{ display: "contents" }} inert={covered}>
                    {children}
                </div>
            )}
            {phase === "arriving" && <CandleDark />}
            {covered &&
                (rackUp ? (
                    <Rack
                        domain={domain}
                        entry={entry}
                        leaving={phase === "leaving"}
                        upstairs={domainProfiles[upstairs].guarded ? null : upstairs}
                        onSignOut={() => void signOut()}
                    />
                ) : (
                    <Box pos="fixed" inset={0} bg="var(--ps-ground)" style={{ zIndex: 10_000 }} />
                ))}
        </>
    );
};

const Rack: React.FC<{
    domain: DomainKind;
    entry: PinEntry;
    leaving: boolean;
    upstairs: DomainKind | null;
    onSignOut: () => void;
}> = ({ domain, entry, leaving, upstairs, onSignOut }) => {
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
                    {upstairs !== null && (
                        <Button
                            variant="subtle"
                            color="gray"
                            size="md"
                            onClick={() => switchDomain(upstairs)}
                        >
                            Back upstairs
                        </Button>
                    )}
                    <Button variant="subtle" color="gray" size="xs" onClick={onSignOut}>
                        Forgot it? Sign out
                    </Button>
                </Stack>
            </Stack>
        </Box>
    );
};
