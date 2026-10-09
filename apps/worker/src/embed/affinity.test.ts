import { describe, expect, it } from "vitest";

import { SWITCH_AFTER_MS, withAffinity } from "./affinity.js";

/**
 * Keeping the model child on one family while it has work (§5e, §5f): embed and faces must not
 * alternate item by item, and neither may wait for ever.
 */
describe("model affinity", () => {
    const free = ["probe", "embed", "faces", "cover"];

    it("holds the other family back while the held one has work", () => {
        const waited = new Map([
            ["faces", 60_000],
            ["embed", 5_000],
        ]);

        expect(withAffinity(free, "faces", waited)).toEqual(["probe", "faces", "cover"]);
        expect(withAffinity(free, "embed", waited)).toEqual(["probe", "embed", "cover"]);
    });

    it("switches once the other family has waited long enough", () => {
        const waited = new Map([
            ["faces", 60_000],
            ["embed", SWITCH_AFTER_MS],
        ]);

        expect(withAffinity(free, "faces", waited)).toEqual(free);
    });

    it("offers everything when the held family has nothing left, or nothing is held", () => {
        const onlyEmbed = new Map([["embed", 1_000]]);

        expect(withAffinity(free, "faces", onlyEmbed)).toEqual(free);
        expect(
            withAffinity(
                free,
                null,
                new Map([
                    ["faces", 1],
                    ["embed", 1],
                ])
            )
        ).toEqual(free);
    });
});

/**
 * Against the real schema: the first version named the live-jobs index with a condition SQLite
 * could not match to it, threw on every claim, and stopped the worker.
 */
describe("how long model work has waited", () => {
    it("reads the queue without error, and only unrequested work available now", async () => {
        const { default: Database } = await import("better-sqlite3");
        const { initializeDatabase } = await import("@private-stock/db");
        const { enqueue } = await import("../queue.js");
        const { modelKindsWaited } = await import("./affinity.js");
        const db = new Database(":memory:");

        initializeDatabase(db);
        // Jobs alone are the question; the items they name need not exist.
        db.pragma("foreign_keys = OFF");
        enqueue(db, { kind: "faces", mediaId: "a" });
        enqueue(db, { kind: "embed", mediaId: "b", requestedByUserId: null });
        enqueue(db, {
            kind: "embed",
            mediaId: "c",
            availableAt: new Date(Date.now() + 3_600_000),
        });

        const waited = modelKindsWaited(db, 1);

        expect([...waited.keys()].sort()).toEqual(["embed", "faces"]);
        expect(waited.get("faces")).toBeGreaterThanOrEqual(0);
    });
});
