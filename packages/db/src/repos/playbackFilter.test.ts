import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { assessPlayback, mediaQuerySchema, type PlaybackInput } from "@private-stock/core";

import { initializeDatabase } from "../init.js";

/**
 * The library's `playback` filter against `assessPlayback` (§8).
 *
 * The filter is a SQL translation of the verdict, and a translation can drift without anything
 * looking wrong: the grid shows a plausible list, and the file that should be on it is not. So
 * every case here is asked of both, and the filter must answer exactly what the verdict does.
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

type Case = Omit<PlaybackInput, "relPath"> & { relPath: string };

const PROBED = "2026-10-17 12:00:00";

/** Plain H.264/AAC in MP4: what most of a library is, and what each case below varies. */
const base: Case = {
    kind: "video",
    relPath: "film.mp4",
    container: "mov,mp4,m4a,3gp,3g2,mj2",
    codec: "h264",
    videoProfile: "High",
    pixFmt: "yuv420p",
    audioCodec: "aac",
    probedAt: PROBED,
};

const CASES: Record<string, Partial<Case>> = {
    plain: {},
    hevcInMp4: { codec: "hevc", videoProfile: "Main" },
    hevc10InMov: { codec: "hevc", videoProfile: "Main 10", pixFmt: "yuv420p10le" },
    mpegTs: { container: "mpegts", relPath: "show.mpg", audioCodec: "mp3" },
    mkv: { container: "matroska,webm", relPath: "film.mkv" },
    mkvShouting: { container: "matroska,webm", relPath: "FILM.MKV" },
    webm: { container: "matroska,webm", relPath: "clip.webm", codec: "vp9", audioCodec: "opus" },
    webmShouting: { container: "matroska,webm", relPath: "CLIP.WEBM", codec: "vp9" },
    high10: { videoProfile: "High 10", pixFmt: "yuv420p10le" },
    paddedCodec: { codec: " H264 ", videoProfile: "HIGH" },
    unknownProfile: { videoProfile: null, pixFmt: null },
    emptyProfile: { videoProfile: "" },
    hevcNoProfile: { codec: "hevc", videoProfile: null },
    pcmAudio: { container: "mov,mp4,m4a,3gp,3g2,mj2", relPath: "cam.mov", audioCodec: "pcm_s16le" },
    silent: { audioCodec: null },
    noContainer: { container: null },
    emptyContainer: { container: "" },
    noCodec: { codec: null },
    prores: { codec: "prores", videoProfile: "Standard", pixFmt: "yuv422p10le" },
    vp9TenBit: {
        relPath: "clip.webm",
        container: "matroska,webm",
        codec: "vp9",
        pixFmt: "yuv420p10le",
    },
    unprobedHevc: { codec: "hevc", container: "matroska,webm", relPath: "x.mkv", probedAt: null },
    image: { kind: "image", codec: "mjpeg", container: "image2", relPath: "a.jpg" },
};

const given = (id: string, fields: Case): void => {
    db.prepare(
        `INSERT INTO "Media" ("id", "kind", "container", "codec", "videoProfile", "pixFmt",
                              "audioCodec", "probedAt", "durationMs", "addedAt", "updatedAt")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 60000, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).run(
        id,
        fields.kind,
        fields.container,
        fields.codec,
        fields.videoProfile,
        fields.pixFmt,
        fields.audioCodec,
        fields.probedAt
    );
    db.prepare(
        `INSERT INTO "MediaFile" ("id", "rootId", "relPath", "size", "mtime", "quickHash",
                                  "state", "classification", "lastSeenAt", "updatedAt")
         VALUES (?, 'r1', ?, 1000, CURRENT_TIMESTAMP, ?, 'active', 'media',
                 CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).run(`f-${id}`, `${id}/${fields.relPath}`, `q-${id}`);
    db.prepare(
        `INSERT INTO "MediaFileLink" ("id", "mediaId", "fileId", "role")
         VALUES (?, ?, ?, 'original')`
    ).run(`l-${id}`, id, `f-${id}`);
};

const blocked = (): string[] =>
    mediaRepo
        .listMedia(mediaQuerySchema.parse({ playback: "blocked", sort: "title" }), "u1", ["r1"])
        .rows.map((row) => row.id)
        .sort();

describe("playback filter", () => {
    it("names exactly the items assessPlayback says a browser cannot play", () => {
        const expected: string[] = [];

        for (const [id, overrides] of Object.entries(CASES)) {
            const fields = { ...base, ...overrides };
            given(id, fields);

            if (!assessPlayback({ ...fields, relPath: `${id}/${fields.relPath}` }).directPlay) {
                expected.push(id);
            }
        }

        expect(blocked()).toEqual(expected.sort());
    });

    it("finds the cases the library actually holds, and leaves plain files out", () => {
        for (const [id, overrides] of Object.entries(CASES)) {
            given(id, { ...base, ...overrides });
        }

        const ids = blocked();

        expect(ids).toEqual(expect.arrayContaining(["hevcInMp4", "mpegTs", "mkv", "pcmAudio"]));
        expect(ids).not.toContain("plain");
        expect(ids).not.toContain("webm");
        // Unprobed is "not known yet", which the verdict treats as playable.
        expect(ids).not.toContain("unprobedHevc");
    });
});
