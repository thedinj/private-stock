"use client";

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { Box } from "@mantine/core";

import { domainProfiles } from "@private-stock/core";

import { getActiveDomain } from "@/lib/activeDomain";
import { usePinStatus } from "@/lib/api/account";
import { useAuth } from "@/lib/api/AuthProvider";
import {
    activeAtKey,
    lockedKey,
    markActive,
    readActiveAt,
    readLockAfter,
    readLocked,
    writeLockAfter,
    writeLocked,
} from "@/lib/screenLock";

/**
 * The screen lock (§12c "The screen lock").
 *
 * After a stretch of downtime on a device that has asked for it, the cellar closes again: the
 * gate's wine rack (`DomainGate`) goes back up over the page until the account's PIN is pulled
 * from it. This provider decides *when*; it draws nothing but a blank cover while the page is
 * hidden. There is one PIN screen, and it opens only the cellar (decided 2026-11-13). Downtime is either of two things, measured from the
 * last touch, key or scroll: the app in the background or the screen off, or the app in front
 * and untouched with nothing playing. A video playing on screen counts as use, so a long film
 * watched hands-off does not lock halfway through.
 *
 * The lock is drawn by the browser and is no security boundary — the page underneath is still
 * in the document. What it does make sure of is that nothing is *shown*: the cover goes up the
 * moment the page is hidden (so the app switcher's thumbnail is the cover, as far as the
 * browser gets a say), playback pauses, and fullscreen is left, because a fullscreen element
 * sits above anything the page can draw.
 *
 * **Only in a guarded room** -- the Cellar (decided 2026-11-11). Elsewhere it never covers, never
 * pauses and never leaves fullscreen, and "Lock now" is not offered.
 *
 * **Locking by hand needs only a PIN** (decided 2026-11-13): in the Cellar, "Lock now" -- the key
 * in the header -- works on every device whose account has a PIN, whether or not the device has
 * the idle lock on. The idle lock is the opt-in; a lock asked for by hand holds across a reload
 * and every tab the same way. Time spent in another room
 * is time away from the guarded one: nothing there marks use, so going back down after the delay
 * asks for the PIN. A room change is a reload (`switchDomain`), so the room is read once.
 */

interface ScreenLockState {
    /** Minutes until this device locks, or null when it does not lock. */
    lockAfter: number | null;
    /** Turn the lock on for this device (minutes) or off (null). */
    setLockAfter: (minutes: number | null) => void;
    /** Whether "Lock now" means anything here: a guarded room, and an account with a PIN. */
    lockable: boolean;
    /** Lock now; does nothing where `lockable` is false. */
    lockNow: () => void;
    /** Whether the lock is down here, which is when the gate puts its rack back up. */
    locked: boolean;
    /** Open the lock, on every tab; the gate calls it when the right PIN is entered. */
    unlock: () => void;
}

const ScreenLockContext = createContext<ScreenLockState | null>(null);

export const useScreenLock = (): ScreenLockState => {
    const context = useContext(ScreenLockContext);

    if (!context) {
        throw new Error("useScreenLock must be used inside ScreenLockProvider");
    }

    return context;
};

/** How often an idle, visible page checks whether it has been idle long enough. */
const CHECK_INTERVAL_MS = 30_000;

/** Activity is written to storage at most this often; it is compared against minutes. */
const MARK_THROTTLE_MS = 10_000;

const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart", "scroll"] as const;

const isPlaying = (): boolean =>
    Array.from(document.querySelectorAll<HTMLMediaElement>("video, audio")).some(
        (media) => !media.paused && !media.ended
    );

/** Hide everything the page was showing, beyond what covering it does. */
const putAway = (): void => {
    document.querySelectorAll<HTMLMediaElement>("video, audio").forEach((media) => media.pause());

    if (document.fullscreenElement) {
        void document.exitFullscreen().catch(() => undefined);
    }

    if (document.pictureInPictureElement) {
        void document.exitPictureInPicture().catch(() => undefined);
    }
};

export const ScreenLockProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { user } = useAuth();
    const userId = user?.id ?? null;

    const [lockAfter, setLockAfterState] = useState<number | null>(null);
    const [locked, setLocked] = useState(false);
    /** Covered while the page is hidden, whether or not the lock has come down yet. */
    const [veiled, setVeiled] = useState(false);
    /** Whether this tab's room is guarded. Read after hydration: the server knows no room. */
    const [guardedRoom, setGuardedRoom] = useState(false);

    // A device can have the lock on while the account has since removed its PIN. Then there is
    // nothing to ask for, and the lock stands down rather than put up a rack nothing opens.
    const { data: pinStatus } = usePinStatus(
        userId !== null && (lockAfter !== null || guardedRoom)
    );
    /** Whether a lock, however it came, holds here. */
    const holds = guardedRoom && userId !== null && pinStatus?.set !== false;
    /** Whether the idle lock is watching: `holds`, on a device that asked for it. */
    const active = holds && lockAfter !== null;
    /** Whether locking by hand is offered: a definite PIN, not just the absence of a "no". */
    const lockable = holds && pinStatus?.set === true;

    const lastMark = useRef(0);

    // Read the device's setting for whoever is signed in, and whether it is already due — before
    // the first paint of their pages, which a plain effect would come after. `RequireAuth` holds
    // the pages back until `user` is set, so this runs in the commit that first shows them.
    useLayoutEffect(() => {
        setGuardedRoom(domainProfiles[getActiveDomain()].guarded);

        if (userId === null) {
            setLockAfterState(null);
            setLocked(false);
            return;
        }

        const minutes = readLockAfter(userId);
        setLockAfterState(minutes);

        if (minutes === null) {
            // No idle lock here, but a lock asked for by hand still holds.
            setLocked(readLocked(userId));
            return;
        }

        const activeAt = readActiveAt(userId);
        const due = activeAt !== null && Date.now() - activeAt >= minutes * 60_000;

        if (due) {
            writeLocked(userId, true);
        } else if (activeAt === null) {
            markActive(userId);
        }

        setLocked(due || readLocked(userId));
    }, [userId]);

    const lock = useCallback(() => {
        if (userId === null) return;

        writeLocked(userId, true);
        setLocked(true);
        putAway();
    }, [userId]);

    const unlock = useCallback(() => {
        if (userId === null) return;

        writeLocked(userId, false);
        markActive(userId);
        lastMark.current = Date.now();
        setLocked(false);
    }, [userId]);

    const isDue = useCallback(() => {
        if (userId === null || lockAfter === null) return false;

        const activeAt = readActiveAt(userId) ?? Date.now();

        return Date.now() - activeAt >= lockAfter * 60_000;
    }, [userId, lockAfter]);

    // Use: any touch, key, wheel or scroll, and whatever is playing on a visible page.
    useEffect(() => {
        if (!active || locked || userId === null) return;

        const onActivity = () => {
            const now = Date.now();

            if (now - lastMark.current >= MARK_THROTTLE_MS) {
                lastMark.current = now;
                markActive(userId, now);
            }
        };

        ACTIVITY_EVENTS.forEach((type) =>
            window.addEventListener(type, onActivity, { passive: true, capture: true })
        );

        const timer = window.setInterval(() => {
            if (document.visibilityState !== "visible") return;

            if (isPlaying()) {
                onActivity();
            } else if (isDue()) {
                lock();
            }
        }, CHECK_INTERVAL_MS);

        return () => {
            ACTIVITY_EVENTS.forEach((type) =>
                window.removeEventListener(type, onActivity, { capture: true })
            );
            window.clearInterval(timer);
        };
    }, [active, locked, userId, isDue, lock]);

    // Hidden: covered at once. Back: locked if it was away long enough, uncovered otherwise.
    useEffect(() => {
        if (!active) {
            setVeiled(false);
            return;
        }

        const onVisibility = () => {
            if (document.visibilityState === "hidden") {
                setVeiled(true);
                return;
            }

            if (isDue()) {
                lock();
            }

            setVeiled(false);
        };

        document.addEventListener("visibilitychange", onVisibility);

        return () => document.removeEventListener("visibilitychange", onVisibility);
    }, [active, isDue, lock]);

    // Every tab on the device locks and unlocks together.
    useEffect(() => {
        if (userId === null) return;

        const onStorage = (event: StorageEvent) => {
            if (event.key === lockedKey(userId)) {
                if (event.newValue === "1") {
                    setLocked(true);
                    // Another tab's lock reaches this one only if this one is in a locking room.
                    if (guardedRoom) putAway();
                } else {
                    setLocked(false);
                }
            } else if (event.key === activeAtKey(userId)) {
                lastMark.current = Number(event.newValue) || lastMark.current;
            }
        };

        window.addEventListener("storage", onStorage);

        return () => window.removeEventListener("storage", onStorage);
    }, [userId, guardedRoom]);

    const setLockAfter = useCallback(
        (minutes: number | null) => {
            if (userId === null) return;

            writeLockAfter(userId, minutes);
            markActive(userId);
            setLockAfterState(minutes);
            setLocked(false);
        },
        [userId]
    );

    const lockNow = useCallback(() => {
        if (lockable) lock();
    }, [lockable, lock]);

    const value = useMemo<ScreenLockState>(
        () => ({
            lockAfter,
            setLockAfter,
            lockable,
            lockNow,
            locked: holds && locked,
            unlock,
        }),
        [lockAfter, setLockAfter, lockable, lockNow, holds, locked, unlock]
    );

    // Hidden: a blank cover, so the app switcher's thumbnail shows nothing. Locked and in front,
    // the gate draws the rack instead.
    const covered = active && veiled;

    return (
        <ScreenLockContext.Provider value={value}>
            {/* `inert` keeps keyboard and screen reader out of what is underneath; the cover
                keeps the pointer out. `display: contents` so the wrapper adds no box. */}
            <div style={{ display: "contents" }} inert={covered}>
                {children}
            </div>
            {covered && (
                <Box
                    aria-hidden
                    pos="fixed"
                    inset={0}
                    bg="var(--ps-ground)"
                    style={{ zIndex: 10_000 }}
                />
            )}
        </ScreenLockContext.Provider>
    );
};
