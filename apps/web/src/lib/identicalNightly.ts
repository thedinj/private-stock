import { DUPE_PAGE_LIMIT, effectiveTimeZone, hourIn, inWindow } from "@private-stock/core";

import { contextFor } from "./auth/withAuth";
import {
    loadIdenticalNightly,
    nightlyWindow,
    recordNightlyRun,
    trashIdentical,
} from "./services/dupeService";

/**
 * Identical copies cleared every night, with nobody pressing the button (§10e "Every night").
 *
 * **In the web process, not the worker**, though the worker owns every other schedule. This is
 * the button's run exactly — `trashIdentical`, a batch at a time, until the cursor comes back
 * null — and the trash path it goes through (the merge, the entry, the move job, the caches it
 * empties) lives here. A worker copy of it would be a second deletion path to keep in step with
 * the first. The bytes are still removed by the worker's trash job, the only code allowed to
 * write inside a media root.
 *
 * It acts as the administrator who turned it on, built afresh each night, so it stops when their
 * account is disabled or loses `admin` or `delete` — and says so on the tab.
 *
 * Loaded only from the Node branch of `instrumentation.ts`.
 */

/** How often the clock is looked at. A restart inside the window still finds it. */
const CHECK_MS = 10 * 60 * 1000;

/**
 * Runs closer together than this are the same night's. Shorter than a day, so a run that began a
 * little late yesterday does not push tonight's past the window.
 */
const MIN_GAP_MS = 20 * 60 * 60 * 1000;

let running = false;

const due = (now: Date): boolean => {
    const setting = loadIdenticalNightly();

    if (!setting.enabled || !setting.byUserId) {
        return false;
    }

    if (setting.lastRun && now.getTime() - Date.parse(setting.lastRun.at) < MIN_GAP_MS) {
        return false;
    }

    const window = nightlyWindow();
    const hour = hourIn(effectiveTimeZone(window.timeZone), now);

    return inWindow(hour, window.startHour, window.endHour);
};

const runOnce = async (now: Date): Promise<void> => {
    const setting = loadIdenticalNightly();
    const at = now.toISOString();

    if (!setting.byUserId) {
        return;
    }

    let deleted = 0;
    let failed = 0;

    try {
        const auth = contextFor(setting.byUserId);
        let after: string | null = null;

        do {
            const batch = await trashIdentical({ after, limit: DUPE_PAGE_LIMIT }, auth);

            after = batch.cursor;
            deleted += batch.trashed;
            failed += batch.failed.length;
        } while (after !== null && loadIdenticalNightly().enabled);

        recordNightlyRun({ at, deleted, failed, error: null });
        console.log(`Nightly identical clear: ${deleted} deleted, ${failed} failed`);
    } catch (error) {
        // A disabled account or a withdrawn scope, mostly. What was deleted before it stopped
        // stays deleted, and the counts say how much that was.
        const message = error instanceof Error ? error.message : String(error);

        recordNightlyRun({ at, deleted, failed, error: message });
        console.error(`Nightly identical clear stopped: ${message}`);
    }
};

/** One look at the clock: runs tonight's clear if it is due and not already going. */
export const runIfDue = async (now: Date): Promise<boolean> => {
    if (running || !due(now)) {
        return false;
    }

    running = true;

    try {
        await runOnce(now);
    } finally {
        running = false;
    }

    return true;
};

const tick = (): void => {
    void runIfDue(new Date());
};

const globalForNightly = globalThis as unknown as {
    privateStockNightly: NodeJS.Timeout | undefined;
};

/**
 * Cached off `globalThis`, as the change feed's poller is: development re-evaluates modules on
 * every save, and two clocks would start two runs over the same queue.
 */
export const startIdenticalNightly = (): void => {
    globalForNightly.privateStockNightly ??= setInterval(tick, CHECK_MS).unref();
};
