import { beforeEach, describe, expect, it, vi } from "vitest";

import { SETTING_KEYS, transcodeEnabled, transcodeSettingsSchema } from "@private-stock/core";

/**
 * The settings service (§12b).
 *
 * `transcode` and `dupes` were read by the worker and written by nothing, so the library ran
 * on schema defaults an admin could neither see nor change. What is worth testing is that the
 * new write path stores what the readers already expect to find — a settings screen that
 * writes a shape the worker does not read is worse than no screen, because it looks like it
 * worked.
 */

const store = new Map<string, unknown>();

/** What the teardown did, so the disable transition can be asserted rather than described. */
const queue = { cancelled: 0, enqueued: [] as string[] };

vi.mock("@private-stock/db", () => ({
    jobRepo: {
        cancelAllTranscodes: (): number => {
            queue.cancelled += 1;

            return 0;
        },
        enqueueKind: (kind: string): void => {
            queue.enqueued.push(kind);
        },
    },
    settingRepo: {
        get: <T>(key: string, fallback: T): T =>
            store.has(key) ? (store.get(key) as T) : fallback,
        set: (key: string, value: unknown): void => {
            store.set(key, value);
        },
    },
}));

const { loadAdminSettings, saveAdminSettings } = await import("./settingsService");

beforeEach(() => {
    store.clear();
    queue.cancelled = 0;
    queue.enqueued = [];
});

describe("reading", () => {
    it("falls back to the schemas' own defaults when nothing was ever written", () => {
        const settings = loadAdminSettings();

        // Off until asked for: it is the one feature that spends CPU and disk on its own.
        expect(transcodeEnabled(settings.stagePolicy)).toBe(false);
        expect(settings.transcode.retentionDays).toBe(7);
        expect(settings.transcode.crf).toBe(21);
        expect(settings.dupes.imageDistance).toBeGreaterThan(0);
        expect(settings.trash.retentionDays).toBe(7);
        // Nothing decided is the default state, and it is what lets a stage added later
        // arrive at whatever its own `mode` says (§7b).
        expect(settings.stagePolicy).toEqual({});
    });

    /**
     * A row that no longer validates must not take the screen down.
     *
     * Hand-edited values and settings written by an older version both end up here, and the
     * useful behaviour is a working app on defaults rather than an error thrown far from the
     * edit that caused it.
     */
    it("ignores a stored value that does not validate", () => {
        store.set(SETTING_KEYS.transcode, { crf: "not a number", hwaccel: "telepathy" });

        expect(loadAdminSettings().transcode.crf).toBe(21);
    });
});

describe("writing", () => {
    it("refuses anyone without the admin scope", () => {
        expect(() => saveAdminSettings({ trash: { retentionDays: 1 } }, ["delete"])).toThrow();
        expect(store.size).toBe(0);
    });

    /**
     * The reason the patch is partial.
     *
     * Two admins on different cards would otherwise overwrite each other with values neither
     * of them touched, and the form would still have said the right thing when they left it.
     */
    it("leaves every group the caller did not send alone", () => {
        saveAdminSettings({ dupes: { ...loadAdminSettings().dupes, imageDistance: 2 } }, ["admin"]);
        saveAdminSettings({ trash: { retentionDays: 14 } }, ["admin"]);

        const after = loadAdminSettings();

        expect(after.dupes.imageDistance).toBe(2);
        expect(after.trash.retentionDays).toBe(14);
        // Never written, so still the default rather than something the patch invented.
        expect(store.has(SETTING_KEYS.transcode)).toBe(false);
        expect(after.transcode.crf).toBe(21);
    });

    /**
     * The shape the existing reader expects.
     *
     * `trash.retentionDays` is a bare number under a key that names the field, which is what
     * was already written there and what `loadTrashSettings` reads. Storing the object instead
     * would validate cleanly here and silently give every deletion the default window.
     */
    it("stores the retention window as a bare number", () => {
        saveAdminSettings({ trash: { retentionDays: 3 } }, ["admin"]);

        expect(store.get(SETTING_KEYS.trashRetention)).toBe(3);
    });

    it("stores stage toggles as deviations from the registry, in either direction", () => {
        saveAdminSettings({ stagePolicy: { phash: false, ocr: true } }, ["admin"]);

        // An automatic stage switched off and an opt-in stage switched on are the same kind
        // of fact -- a decision that differs from the registry -- and are stored alike.
        expect(store.get(SETTING_KEYS.stagePolicy)).toEqual({ phash: false, ocr: true });
        expect(loadAdminSettings().stagePolicy).toEqual({ phash: false, ocr: true });
    });

    /**
     * The screen sends the whole record back on every save, so a key for a stage that has
     * since been removed from the registry would fail validation for ever if it were
     * rejected — one retired capability and the settings page could never be saved again.
     * A decision about something that does not exist cannot mean anything (§7b).
     */
    it("forgets a decision about a stage that no longer exists", () => {
        saveAdminSettings({ stagePolicy: { phash: false, retiredStage: true } }, ["admin"]);

        expect(store.get(SETTING_KEYS.stagePolicy)).toEqual({ phash: false });
    });

    it("keeps transcoding's switch, which is in the policy without being a registry stage", () => {
        saveAdminSettings({ stagePolicy: { transcode: true } }, ["admin"]);

        expect(store.get(SETTING_KEYS.stagePolicy)).toEqual({ transcode: true });
    });

    it("rejects a value outside the schema's range rather than clamping it", () => {
        expect(() => saveAdminSettings({ trash: { retentionDays: 400 } }, ["admin"])).toThrow();
        expect(store.has(SETTING_KEYS.trashRetention)).toBe(false);
    });
});

/**
 * Switching transcoding off takes its renditions with it (§8).
 *
 * The transition is the thing under test, not the resulting value. Saving settings while it
 * is already off is an ordinary save, and turning it on must never delete anything — both of
 * which a check on the new value alone would get wrong.
 */
describe("switching transcoding off", () => {
    const enable = () => store.set(SETTING_KEYS.stagePolicy, { transcode: true, ocr: true });

    it("stops the encoders and queues the purge", () => {
        enable();

        saveAdminSettings({ stagePolicy: { transcode: false, ocr: true } }, ["admin"]);

        expect(queue.cancelled).toBe(1);
        expect(queue.enqueued).toEqual(["variantPurge"]);
    });

    it("does nothing of the sort when it was already off", () => {
        saveAdminSettings({ stagePolicy: { ocr: false } }, ["admin"]);

        expect(queue.cancelled).toBe(0);
        expect(queue.enqueued).toEqual([]);
    });

    it("never purges on the way back on", () => {
        saveAdminSettings({ stagePolicy: { transcode: true } }, ["admin"]);

        expect(queue.enqueued).toEqual([]);
    });

    it("leaves renditions alone when some other stage or a transcode setting changes", () => {
        enable();

        saveAdminSettings({ stagePolicy: { transcode: true, ocr: false } }, ["admin"]);
        saveAdminSettings({ transcode: transcodeSettingsSchema.parse({ maxHeight: 720 }) }, [
            "admin",
        ]);

        expect(queue.enqueued).toEqual([]);
    });
});
