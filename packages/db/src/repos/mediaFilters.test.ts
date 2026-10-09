import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mediaQuerySchema } from "@private-stock/core";

import { initializeDatabase } from "../init.js";

/**
 * Filtering by what a file measurably is (§14e).
 *
 * Every assertion here is about a boundary, because that is the only part of a range filter
 * that can be wrong without looking wrong. A bitrate filter off by one returns a plausible
 * library, in the right order, with the right covers — and the item that should have been
 * there is simply not, which nobody notices in a library of twenty thousand.
 *
 * The bands in `ranges.ts` are adjacent, so the inclusive/exclusive rule is load-bearing
 * rather than pedantic: an item exactly 1080 tall belongs to "1080p" and must not also be
 * counted under "720p", or the two filters stop being alternatives.
 */

let db: Database.Database;

vi.mock("../db", async () => {
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const instance = new BetterSqlite3(":memory:");
    instance.pragma("foreign_keys = ON");

    return { db: instance, getDb: () => instance };
});

const mediaRepo = await import("./mediaRepo.js");
const { db: sharedDb } = await import("../db.js");

beforeEach(() => {
    db = sharedDb as unknown as Database.Database;
    initializeDatabase(db);
    db.exec(`
        DELETE FROM "UserMedia"; DELETE FROM "MediaFileLink"; DELETE FROM "MediaFile";
        DELETE FROM "Media"; DELETE FROM "MediaRoot"; DELETE FROM "User";
    `);
    db.prepare(
        `INSERT INTO "MediaRoot" ("id", "path", "label", "enabled", "updatedAt")
         VALUES ('r1', '/media/v', 'Videos', 1, CURRENT_TIMESTAMP)`
    ).run();
    db.prepare(
        `INSERT INTO "User" ("id", "email", "displayName", "password", "updatedAt")
         VALUES ('u1', 'ada@example.test', 'Ada', 'x', CURRENT_TIMESTAMP)`
    ).run();
});

interface Fixture {
    kind?: "video" | "image";
    durationMs?: number | null;
    width?: number | null;
    height?: number | null;
    bitrate?: number | null;
    fps?: number | null;
    sizeBytes?: number;
    animated?: boolean;
}

const givenMedia = (id: string, fields: Fixture = {}): string => {
    const size = fields.sizeBytes ?? 1_000;

    db.prepare(
        `INSERT INTO "Media" ("id", "kind", "durationMs", "width", "height", "bitrate", "fps",
                              "isAnimated", "addedAt", "updatedAt")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).run(
        id,
        fields.kind ?? "video",
        fields.durationMs === undefined ? 600_000 : fields.durationMs,
        fields.width === undefined ? 1920 : fields.width,
        fields.height === undefined ? 1080 : fields.height,
        fields.bitrate === undefined ? 5_000_000 : fields.bitrate,
        fields.fps === undefined ? 30 : fields.fps,
        fields.animated ? 1 : null
    );

    db.prepare(
        `INSERT INTO "MediaFile" ("id", "rootId", "relPath", "size", "mtime", "quickHash",
                                  "state", "classification", "lastSeenAt", "updatedAt")
         VALUES (?, 'r1', ?, ?, CURRENT_TIMESTAMP, ?, 'active', 'media',
                 CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).run(`f-${id}`, `${id}.mp4`, size, `q-${id}`);

    db.prepare(
        `INSERT INTO "MediaFileLink" ("id", "mediaId", "fileId", "role")
         VALUES (?, ?, ?, 'original')`
    ).run(`l-${id}`, id, `f-${id}`);

    return id;
};

/** Ids matching a query, through the same schema a request would be parsed by. */
const matching = (params: Record<string, string | number>): string[] =>
    mediaRepo
        .listMedia(mediaQuerySchema.parse({ ...params, sort: "title" }), "u1", ["r1"])
        .rows.map((row) => row.id)
        .sort();

describe("length", () => {
    beforeEach(() => {
        givenMedia("clip", { durationMs: 30_000 });
        givenMedia("short", { durationMs: 120_000 });
        givenMedia("feature", { durationMs: 5_400_000 });
    });

    it("reads its bound in seconds, not the column's milliseconds", () => {
        expect(matching({ minDurationSec: 60 })).toEqual(["feature", "short"]);
    });

    it("excludes the item sitting exactly on the upper bound", () => {
        // 120 s is where "1–5 min" begins, so the two-minute item belongs to that band and
        // must not also appear under the one below it.
        expect(matching({ maxDurationSec: 120 })).toEqual(["clip"]);
    });

    it("includes the item sitting exactly on the lower bound", () => {
        expect(matching({ minDurationSec: 120, maxDurationSec: 300 })).toEqual(["short"]);
    });

    /**
     * An image has no duration, so it is not in any duration band. Treating NULL as zero
     * would quietly file every photograph under "under a minute".
     */
    it("matches nothing that has no length to measure", () => {
        givenMedia("photo", { kind: "image", durationMs: null });

        expect(matching({ maxDurationSec: 60 })).toEqual(["clip"]);
    });
});

describe("resolution", () => {
    beforeEach(() => {
        givenMedia("sd", { width: 854, height: 480 });
        givenMedia("hd", { width: 1280, height: 720 });
        givenMedia("fhd", { width: 1920, height: 1080 });
        givenMedia("uhd", { width: 3840, height: 2160 });
    });

    it("puts each item in the tier it is named after", () => {
        expect(matching({ minResolution: 1080 })).toEqual(["fhd", "uhd"]);
    });

    it("puts an item exactly on a tier boundary in the higher tier only", () => {
        expect(matching({ minResolution: 720, maxResolution: 1080 })).toEqual(["hd"]);
        expect(matching({ minResolution: 1080, maxResolution: 1440 })).toEqual(["fhd"]);
    });

    /**
     * The case that made this the shorter side rather than the height.
     *
     * An upright phone video is 1080x1920: the same frame as the landscape one beside it,
     * turned. Reading height would file it under 1440p -- a tier it has no pixels to justify
     * -- and every portrait item in the library would be promoted the same way.
     */
    it("calls an upright video by the tier its frame deserves", () => {
        givenMedia("upright", { width: 1080, height: 1920 });

        expect(matching({ minResolution: 1080, maxResolution: 1440 })).toEqual(["fhd", "upright"]);
        expect(matching({ minResolution: 1440 })).toEqual(["uhd"]);
    });

    it("treats a rotated frame as the same resolution as the frame it came from", () => {
        givenMedia("landscape4k", { width: 3840, height: 2160 });
        givenMedia("portrait4k", { width: 2160, height: 3840 });

        expect(matching({ minResolution: 2160 })).toEqual(["landscape4k", "portrait4k", "uhd"]);
    });

    /** An ultrawide is not 4K. Ranking by pixel count would say it was. */
    it("does not promote an ultrawide on the strength of its width", () => {
        givenMedia("ultrawide", { width: 2560, height: 1080 });

        expect(matching({ minResolution: 2160 })).toEqual(["uhd"]);
    });

    it("files a square crop by the side it actually has", () => {
        givenMedia("square", { width: 1080, height: 1080 });

        expect(matching({ minResolution: 1080, maxResolution: 1440 })).toEqual(["fhd", "square"]);
    });
});

describe("bit rate and frame rate", () => {
    it("reads bit rate in kbps, not the column's bits per second", () => {
        givenMedia("low", { bitrate: 800_000 });
        givenMedia("high", { bitrate: 12_000_000 });

        expect(matching({ minBitrateKbps: 1_000 })).toEqual(["high"]);
        expect(matching({ maxBitrateKbps: 1_000 })).toEqual(["low"]);
    });

    /**
     * Frame rates cluster on 23.976, 29.97 and 59.94 rather than on the round numbers they
     * are named after, so the bands' bounds sit in the gaps. A filter that split 29.97 from
     * 30 would miss half of what it was asked for.
     */
    it("keeps the broadcast rates with the round numbers they are called", () => {
        givenMedia("film", { fps: 23.976 });
        givenMedia("ntsc", { fps: 29.97 });
        givenMedia("smooth", { fps: 59.94 });

        expect(matching({ maxFps: 24.5 })).toEqual(["film"]);
        expect(matching({ minFps: 24.5, maxFps: 31 })).toEqual(["ntsc"]);
        expect(matching({ minFps: 31, maxFps: 61 })).toEqual(["smooth"]);
    });
});

describe("file size", () => {
    it("reads its bound in megabytes", () => {
        givenMedia("small", { sizeBytes: 50 * 1_024 * 1_024 });
        givenMedia("big", { sizeBytes: 3 * 1_024 * 1_024 * 1_024 });

        expect(matching({ maxSizeMb: 100 })).toEqual(["small"]);
        expect(matching({ minSizeMb: 1_024 })).toEqual(["big"]);
    });
});

describe("orientation", () => {
    beforeEach(() => {
        givenMedia("wide", { width: 1920, height: 1080 });
        givenMedia("tall", { width: 1080, height: 1920 });
        givenMedia("square", { width: 1000, height: 1000 });
    });

    it("tells the three apart", () => {
        expect(matching({ orientation: "landscape" })).toEqual(["wide"]);
        expect(matching({ orientation: "portrait" })).toEqual(["tall"]);
        expect(matching({ orientation: "square" })).toEqual(["square"]);
    });

    /** Unprobed has no orientation rather than a square one, which is what NULL = NULL is. */
    it("does not call an unprobed item square", () => {
        givenMedia("unprobed", { width: null, height: null });

        expect(matching({ orientation: "square" })).toEqual(["square"]);
    });
});

describe("movement", () => {
    beforeEach(() => {
        givenMedia("gif", { kind: "image", durationMs: null, animated: true });
        givenMedia("photo", { kind: "image", durationMs: null });
        givenMedia("film", { kind: "video" });
    });

    it("finds the animated stills", () => {
        expect(matching({ animated: "yes" })).toEqual(["gif"]);
    });

    /**
     * The one that would have gone wrong. `isAnimated` is NULL on every video as well as on
     * every still photograph, so "stills only" without the kind clause returns the entire
     * video collection — which reads as the filter having been ignored.
     */
    it("does not return the video collection when asked for stills", () => {
        expect(matching({ animated: "no" })).toEqual(["photo"]);
    });
});

describe("ratings as a band", () => {
    beforeEach(() => {
        givenMedia("one");
        givenMedia("three");
        givenMedia("five");
        db.prepare(
            `INSERT INTO "UserMedia" ("userId", "mediaId", "rating", "updatedAt")
             VALUES ('u1', 'one', 1, CURRENT_TIMESTAMP),
                    ('u1', 'three', 3, CURRENT_TIMESTAMP),
                    ('u1', 'five', 5, CURRENT_TIMESTAMP)`
        ).run();
    });

    /** Inclusive at both ends, unlike the measurements — stars are counted, not measured. */
    it("includes both named ratings", () => {
        expect(matching({ minRating: 3, maxRating: 5 })).toEqual(["five", "three"]);
        expect(matching({ maxRating: 3 })).toEqual(["one", "three"]);
    });
});

describe("combining them", () => {
    it("narrows rather than widens", () => {
        // Widths given explicitly: resolution is the shorter side, so a fixture that set only
        // the height would be filtered by the default width beside it.
        givenMedia("keep", { width: 3840, height: 2160, durationMs: 5_400_000 });
        givenMedia("short4k", { width: 3840, height: 2160, durationMs: 30_000 });
        givenMedia("longsd", { width: 854, height: 480, durationMs: 5_400_000 });

        expect(matching({ minResolution: 2160, minDurationSec: 3_600 })).toEqual(["keep"]);
    });
});
