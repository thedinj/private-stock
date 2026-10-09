import { isBusyError } from "@private-stock/db";

/** How many times a write that found the database busy is tried again, and how long apart. */
const BUSY_RETRIES = 5;
const BUSY_BACKOFF_MS = 200;

/**
 * Runs one synchronous write, and if the database is busy, waits and runs it again.
 *
 * The web process gives up on the lock after three seconds (`busyTimeoutMs`), and SQLite has
 * no writer queue: a worker working through hundreds of trash and purge jobs -- which is what
 * a bulk deletion hands it -- can hold the web side off for longer than that, and so can a
 * single worker statement reading cold pages off a disk ffmpeg is using (§20). One in thirty
 * copies failed a bulk run that way, and saving a tag failed the same way. The wait here is
 * `await`ed, so unlike a longer busy timeout it does not freeze every other request while it
 * lasts.
 *
 * Only for a step that is safe to repeat: one transaction that either landed or did not, or a
 * step idempotent by design.
 */
export const whenNotBusy = async <T>(write: () => T): Promise<T> => {
    for (let attempt = 0; ; attempt += 1) {
        try {
            return write();
        } catch (error) {
            if (!isBusyError(error) || attempt >= BUSY_RETRIES) {
                throw error;
            }

            await new Promise((resolve) => setTimeout(resolve, BUSY_BACKOFF_MS * 2 ** attempt));
        }
    }
};
