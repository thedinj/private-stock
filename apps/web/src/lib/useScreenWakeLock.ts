"use client";

import { useEffect } from "react";

/**
 * Keeping the screen on while something is being watched (§14b).
 *
 * A browser keeps the screen awake by itself for a video playing with sound, and for nothing
 * else: a muted film, or a slideshow of photographs, let a phone dim and lock part way through.
 * This asks for a screen wake lock while `active`, and lets it go when it is not.
 *
 * Three things about the API shape this:
 *
 * - **It needs a secure page.** Over plain `http://` (a LAN address) `navigator.wakeLock` does
 *   not exist, and this does nothing rather than fail; the screen then behaves as it always did.
 * - **The browser drops the lock whenever the tab is hidden**, so it is asked for again when the
 *   tab comes back, for as long as it is still wanted.
 * - **It is let go a moment late.** One item hands the screen to the next -- a photograph to a
 *   film, the film to the next film -- and each holds its own lock. Releasing at once would leave
 *   an instant with none, and a phone whose timeout had already run out would dim in it.
 */

const RELEASE_GRACE_MS = 3_000;

export const useScreenWakeLock = (active: boolean): void => {
    useEffect(() => {
        if (!active || typeof navigator === "undefined" || !("wakeLock" in navigator)) {
            return;
        }

        let sentinel: WakeLockSentinel | null = null;
        let requesting = false;
        let done = false;

        const acquire = () => {
            if (done || requesting || document.hidden || (sentinel && !sentinel.released)) {
                return;
            }

            requesting = true;
            navigator.wakeLock
                .request("screen")
                .then((lock) => {
                    if (done) {
                        void lock.release().catch(() => undefined);

                        return;
                    }

                    sentinel = lock;
                })
                // Refused -- a page the browser does not trust, low battery, a policy. The screen
                // keeps its own timeout, which is the worst this can come to.
                .catch(() => undefined)
                .finally(() => {
                    requesting = false;
                });
        };

        const onVisibility = () => {
            if (!document.hidden) acquire();
        };

        acquire();
        document.addEventListener("visibilitychange", onVisibility);

        return () => {
            done = true;
            document.removeEventListener("visibilitychange", onVisibility);

            const held = sentinel;

            if (held && !held.released) {
                setTimeout(() => void held.release().catch(() => undefined), RELEASE_GRACE_MS);
            }
        };
    }, [active]);
};
