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
import { Box, Button, Group, SimpleGrid, Stack, Text, Title, UnstyledButton } from "@mantine/core";

import { checkPin, usePinStatus } from "@/lib/api/account";
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
 * After a stretch of downtime on a device that has asked for it, the whole app is covered by a
 * keypad until the account's PIN is entered. Downtime is either of two things, measured from the
 * last touch, key or scroll: the app in the background or the screen off, or the app in front
 * and untouched with nothing playing. A video playing on screen counts as use, so a long film
 * watched hands-off does not lock halfway through.
 *
 * The lock is drawn by the browser and is no security boundary — the page underneath is still
 * in the document. What it does make sure of is that nothing is *shown*: the cover goes up the
 * moment the page is hidden (so the app switcher's thumbnail is the cover, as far as the
 * browser gets a say), playback pauses, and fullscreen is left, because a fullscreen element
 * sits above anything the page can draw.
 */

interface ScreenLockState {
    /** Minutes until this device locks, or null when it does not lock. */
    lockAfter: number | null;
    /** Turn the lock on for this device (minutes) or off (null). */
    setLockAfter: (minutes: number | null) => void;
    /** Lock now; does nothing on a device that does not lock. */
    lockNow: () => void;
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

    // A device can have the lock on while the account has since removed its PIN. Then there is
    // nothing to ask for, and the lock stands down rather than show a keypad nothing opens.
    const { data: pinStatus } = usePinStatus(userId !== null && lockAfter !== null);
    const active = userId !== null && lockAfter !== null && pinStatus?.set !== false;

    const lastMark = useRef(0);

    // Read the device's setting for whoever is signed in, and whether it is already due — before
    // the first paint of their pages, which a plain effect would come after. `RequireAuth` holds
    // the pages back until `user` is set, so this runs in the commit that first shows them.
    useLayoutEffect(() => {
        if (userId === null) {
            setLockAfterState(null);
            setLocked(false);
            return;
        }

        const minutes = readLockAfter(userId);
        setLockAfterState(minutes);

        if (minutes === null) {
            setLocked(false);
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
                    putAway();
                } else {
                    setLocked(false);
                }
            } else if (event.key === activeAtKey(userId)) {
                lastMark.current = Number(event.newValue) || lastMark.current;
            }
        };

        window.addEventListener("storage", onStorage);

        return () => window.removeEventListener("storage", onStorage);
    }, [userId]);

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
        if (active) lock();
    }, [active, lock]);

    const value = useMemo<ScreenLockState>(
        () => ({ lockAfter, setLockAfter, lockNow }),
        [lockAfter, setLockAfter, lockNow]
    );

    const covered = active && (locked || veiled);

    return (
        <ScreenLockContext.Provider value={value}>
            {/* `inert` keeps keyboard and screen reader out of what is underneath; the cover
                keeps the pointer out. `display: contents` so the wrapper adds no box. */}
            <div style={{ display: "contents" }} inert={covered}>
                {children}
            </div>
            {covered && (
                <LockScreen
                    // Hidden but not yet due: a blank cover, with no keypad to answer.
                    showKeypad={locked}
                    displayName={user?.displayName ?? ""}
                    onUnlock={unlock}
                />
            )}
        </ScreenLockContext.Provider>
    );
};

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "back"] as const;

const MAX_DIGITS = 8;

/**
 * The cover and its keypad.
 *
 * A keypad of its own rather than a text field: a tablet's soft keyboard would cover half the
 * screen to type four digits, and a field invites the browser to offer to save the PIN. Keys are
 * 64px, past the 44px floor, because this is the screen most often reached for half-awake.
 * A physical keyboard's digits, Backspace and Enter work too.
 */
const LockScreen: React.FC<{
    showKeypad: boolean;
    displayName: string;
    onUnlock: () => void;
}> = ({ showKeypad, displayName, onUnlock }) => {
    const { signOut } = useAuth();
    const [digits, setDigits] = useState("");
    const [message, setMessage] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const submit = useCallback(async () => {
        if (busy || digits.length < 4) return;

        setBusy(true);
        setMessage(null);

        try {
            const result = await checkPin(digits);

            if (result.ok) {
                setDigits("");
                onUnlock();
            } else if (result.signedOut) {
                await signOut();
            } else {
                setDigits("");
                setMessage(
                    result.remaining === 1
                        ? "Wrong PIN. One more wrong try signs this device out."
                        : `Wrong PIN. ${result.remaining} tries left.`
                );
            }
        } catch {
            setMessage("Could not reach the library. Try again.");
        } finally {
            setBusy(false);
        }
    }, [busy, digits, onUnlock, signOut]);

    const press = useCallback((key: (typeof KEYS)[number]) => {
        setMessage(null);

        if (key === "back") {
            setDigits((current) => current.slice(0, -1));
        } else if (key === "clear") {
            setDigits("");
        } else {
            setDigits((current) => (current.length < MAX_DIGITS ? current + key : current));
        }
    }, []);

    // In the capture phase, and nothing else hears the key: the page underneath has shortcuts of
    // its own on `window` (the viewer's Space plays), and `inert` stops focus, not listeners.
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            event.stopImmediatePropagation();

            if (!showKeypad) {
                return;
            }

            if (/^\d$/.test(event.key)) {
                press(event.key as (typeof KEYS)[number]);
            } else if (event.key === "Backspace") {
                press("back");
            } else if (event.key === "Escape") {
                press("clear");
            } else if (event.key === "Enter") {
                void submit();
            } else {
                return;
            }

            event.preventDefault();
        };

        window.addEventListener("keydown", onKey, { capture: true });

        return () => window.removeEventListener("keydown", onKey, { capture: true });
    }, [showKeypad, press, submit]);

    return (
        <Box
            role="dialog"
            aria-modal
            aria-label="Locked"
            pos="fixed"
            inset={0}
            style={{
                zIndex: 10_000,
                background: "var(--ps-ground)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "calc(16px + var(--ps-safe-top)) 16px calc(16px + var(--ps-safe-bottom))",
            }}
        >
            {showKeypad && (
                <Stack align="center" gap="lg" w="100%" maw={320}>
                    <Stack align="center" gap={4}>
                        <Title order={3} c="var(--ps-title)">
                            Locked
                        </Title>
                        <Text size="sm" c="dimmed">
                            Enter {displayName ? `${displayName}’s` : "your"} PIN
                        </Text>
                    </Stack>

                    <Group
                        gap={12}
                        h={16}
                        aria-live="polite"
                        aria-label={`${digits.length} digits`}
                    >
                        {Array.from({ length: Math.max(4, digits.length) }, (_, index) => (
                            <Box
                                key={index}
                                w={14}
                                h={14}
                                style={{
                                    borderRadius: "50%",
                                    border: "1px solid var(--mantine-color-brass-5)",
                                    background:
                                        index < digits.length
                                            ? "var(--mantine-color-brass-5)"
                                            : "transparent",
                                }}
                            />
                        ))}
                    </Group>

                    <Text size="sm" c="oxblood.4" mih={20} ta="center" role="alert">
                        {message}
                    </Text>

                    <SimpleGrid cols={3} spacing="md" w="100%">
                        {KEYS.map((key) => (
                            <UnstyledButton
                                key={key}
                                onClick={() => press(key)}
                                disabled={busy}
                                aria-label={
                                    key === "back" ? "Delete" : key === "clear" ? "Clear" : key
                                }
                                h={64}
                                style={{
                                    borderRadius: 32,
                                    border: "1px solid var(--ps-hairline-strong)",
                                    background: "var(--ps-surface)",
                                    fontSize: key.length === 1 ? 24 : 14,
                                    textAlign: "center",
                                }}
                            >
                                {key === "back" ? "⌫" : key === "clear" ? "Clear" : key}
                            </UnstyledButton>
                        ))}
                    </SimpleGrid>

                    <Button
                        fullWidth
                        size="md"
                        loading={busy}
                        disabled={digits.length < 4}
                        onClick={() => void submit()}
                    >
                        Unlock
                    </Button>

                    <Button variant="subtle" color="gray" size="sm" onClick={() => void signOut()}>
                        Forgot it? Sign out
                    </Button>
                </Stack>
            )}
        </Box>
    );
};
