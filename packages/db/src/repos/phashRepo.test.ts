import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { initializeDatabase } from "../init.js";

/**
 * The candidate lookups and the marks they feed (§10, §10b).
 *
 * Both failures these cover were silent on the live library: a re-encode pair matching 9
 * frames of 12 sat ungrouped because one side's frames arrived after it had been marked, and
 * because the video lookup kept an arbitrary 200 of the ~8,000 videos that shared a byte with
 * it. Nothing errors when a duplicate is missed; the review queue is just shorter.
 */

let db: Database.Database;

vi.mock("../db", async () => {
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const instance = new BetterSqlite3(":memory:");
    instance.pragma("foreign_keys = ON");

    return { db: instance, getDb: () => instance };
});

const phashRepo = await import("./phashRepo.js");
const mediaFileRepo = await import("./mediaFileRepo.js");
const { db: sharedDb } = await import("../db.js");

beforeEach(() => {
    db = sharedDb as unknown as Database.Database;
    initializeDatabase(db);
    db.exec(`
        DELETE FROM "DupeClustered"; DELETE FROM "PhashImage"; DELETE FROM "PhashVideo";
        DELETE FROM "MediaFileLink"; DELETE FROM "MediaFile"; DELETE FROM "Media";
        DELETE FROM "MediaRoot";
    `);
    db.prepare(
        `INSERT INTO "MediaRoot" ("id", "path", "label", "enabled", "updatedAt")
         VALUES ('r1', '/media/v', 'Videos', 1, CURRENT_TIMESTAMP)`
    ).run();
});

const givenMedia = (id: string, kind: "image" | "video" = "video"): string => {
    db.prepare(
        `INSERT INTO "Media" ("id", "kind", "updatedAt") VALUES (?, ?, CURRENT_TIMESTAMP)`
    ).run(id, kind);

    return id;
};

const givenFile = (mediaId: string, contentHash: string | null = null): string => {
    db.prepare(
        `INSERT INTO "MediaFile" ("id", "rootId", "relPath", "size", "mtime", "quickHash",
                                  "contentHash", "state", "classification", "lastSeenAt",
                                  "updatedAt")
         VALUES (?, 'r1', ?, 10, CURRENT_TIMESTAMP, ?, ?, 'active', 'media',
                 CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).run(`f-${mediaId}`, `${mediaId}.mp4`, `q-${mediaId}`, contentHash);

    db.prepare(
        `INSERT INTO "MediaFileLink" ("id", "mediaId", "fileId", "role")
         VALUES (?, ?, ?, 'original')`
    ).run(`l-${mediaId}`, mediaId, `f-${mediaId}`);

    return `f-${mediaId}`;
};

const markClustered = (mediaId: string): void => {
    db.prepare(`INSERT INTO "DupeClustered" ("mediaId") VALUES (?)`).run(mediaId);
};

const isMarked = (mediaId: string): boolean =>
    db.prepare(`SELECT 1 FROM "DupeClustered" WHERE "mediaId" = ?`).get(mediaId) !== undefined;

/** Deterministic noise, so a failure reproduces. */
const random = (() => {
    let state = 0x2545f491;

    return (): number => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;

        return state / 2 ** 32;
    };
})();

const randomHash = (): Uint8Array => Uint8Array.from({ length: 8 }, () => (random() * 256) | 0);

/** The hash with one bit flipped in each of the given bytes. */
const flipBytes = (hash: Uint8Array, bytes: number[]): Uint8Array => {
    const copy = Uint8Array.from(hash);

    for (const byte of bytes) {
        copy[byte] ^= 1 << (byte % 8);
    }

    return copy;
};

const framesOf = (hashes: Uint8Array[]) =>
    hashes.map((hash, frameIdx) => ({ frameIdx, atMs: frameIdx * 1000, hash }));

describe("writing a hash forgets the clustering mark", () => {
    it("forgets it when a video's frames arrive", () => {
        givenMedia("v1");
        markClustered("v1");

        phashRepo.putVideoHashes("v1", framesOf([randomHash()]));

        expect(isMarked("v1")).toBe(false);
    });

    it("forgets it when an image's hash arrives", () => {
        givenMedia("i1", "image");
        markClustered("i1");

        phashRepo.putImageHash("i1", randomHash());

        expect(isMarked("i1")).toBe(false);
    });

    it("forgets it when a file gains a content hash", () => {
        const fileId = givenFile(givenMedia("v1"));
        markClustered("v1");

        mediaFileRepo.setHashes(fileId, "q", "c1");

        expect(isMarked("v1")).toBe(false);
    });

    it("keeps it when the content hash is unchanged, or only the quick hash is written", () => {
        const fileId = givenFile(givenMedia("v1"), "c1");
        markClustered("v1");

        mediaFileRepo.setHashes(fileId, "q", "c1");
        mediaFileRepo.setHashes(fileId, "q2", null);

        expect(isMarked("v1")).toBe(true);
    });
});

describe("imageCandidates", () => {
    it("finds a hash within the distance however its bits are spread", () => {
        const seed = randomHash();
        givenMedia("near", "image");
        phashRepo.putImageHash("near", flipBytes(seed, [0, 1, 2, 3, 4]));

        expect(phashRepo.imageCandidates("seed", seed, 5).map((row) => row.mediaId)).toEqual([
            "near",
        ]);
    });

    it("leaves out a hash that shares too few bands to be within the distance", () => {
        const seed = randomHash();
        givenMedia("far", "image");
        phashRepo.putImageHash("far", flipBytes(seed, [0, 1, 2, 3, 4, 5]));

        expect(phashRepo.imageCandidates("seed", seed, 5)).toEqual([]);
    });
});

describe("videoCandidates", () => {
    it("finds a copy among hundreds of unrelated videos, with no limit to fall outside", () => {
        const seed = Array.from({ length: 12 }, randomHash);

        for (let i = 0; i < 400; i += 1) {
            phashRepo.putVideoHashes(
                givenMedia(`noise${i}`),
                framesOf(Array.from({ length: 12 }, randomHash))
            );
        }

        // Five bits apart on every frame, spread over five bands: the loosest copy the default
        // threshold accepts, and the one that shares the fewest bands with its seed.
        phashRepo.putVideoHashes(
            givenMedia("copy"),
            framesOf(seed.map((hash) => flipBytes(hash, [1, 2, 4, 5, 7])))
        );

        expect(phashRepo.videoCandidates("seed", seed, 5, 3)).toEqual(["copy"]);
    });

    it("leaves out a video reached from fewer seed frames than a match needs", () => {
        const seed = Array.from({ length: 12 }, randomHash);
        phashRepo.putVideoHashes(
            givenMedia("twoFrames"),
            framesOf([seed[0], seed[5], ...Array.from({ length: 10 }, randomHash)])
        );

        expect(phashRepo.videoCandidates("seed", seed, 5, 3)).toEqual([]);
        expect(phashRepo.videoCandidates("seed", seed, 5, 2)).toEqual(["twoFrames"]);
    });

    it("ranks the videos reached from the most seed frames first", () => {
        const seed = Array.from({ length: 12 }, randomHash);
        phashRepo.putVideoHashes(
            givenMedia("some"),
            framesOf([...seed.slice(0, 4), ...Array.from({ length: 8 }, randomHash)])
        );
        phashRepo.putVideoHashes(givenMedia("all"), framesOf(seed));

        expect(phashRepo.videoCandidates("seed", seed, 5, 3)).toEqual(["all", "some"]);
    });
});
