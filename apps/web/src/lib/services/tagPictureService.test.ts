import { beforeEach, describe, expect, it, vi } from "vitest";

import { NotFoundError, ValidationError } from "@private-stock/core";

import type { AuthContext } from "../auth/withAuth";

/**
 * Choosing a tag's picture (§6 "A tag's picture"): who may, that the picture is cut from the
 * original with the crop asked for, and that taking it back hands over to the automatic one.
 */

interface TagFixture {
    id: string;
    kind: string;
    name: string;
    ownerId: string | null;
}

let tags: TagFixture[] = [];
let upserted: Record<string, unknown>[] = [];
let removedRows: string[] = [];
let effective = new Map<string, Record<string, unknown>>();
let spawned: string[][] = [];
let mediaKind = "video";

vi.mock("node:child_process", () => ({
    execFile: (
        _binary: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, result: { stdout: string; stderr: string }) => void
    ) => {
        spawned.push(args);
        callback(null, { stdout: "", stderr: "" });
    },
}));

vi.mock("node:fs/promises", () => ({
    mkdir: () => Promise.resolve(),
    rm: () => Promise.resolve(),
    readFile: () => Promise.resolve(Buffer.from("bytes")),
    stat: () => Promise.resolve({ size: 1024 }),
}));

vi.mock("@private-stock/core/server", async () => {
    const actual = await vi.importActual<typeof import("@private-stock/core/server")>(
        "@private-stock/core/server"
    );
    const path = await import("node:path");

    return {
        ...actual,
        loadConfig: () => ({ dataDir: path.resolve("/data") }),
        dataPaths: () => ({ tags: path.resolve("/data/tags") }),
        resolveFfmpeg: () => Promise.resolve("/usr/bin/ffmpeg"),
    };
});

vi.mock("@private-stock/db", () => ({
    tagRepo: { findById: (id: string) => tags.find((tag) => tag.id === id) },
    mediaRepo: {
        findDetail: (mediaId: string) =>
            mediaId === "m1" ? { id: "m1", kind: mediaKind, rootId: "r1", relPath: "a.mp4" } : null,
    },
    mediaRootRepo: { findById: () => ({ id: "r1", path: "/media" }) },
    tagPictureRepo: {
        upsert: (input: Record<string, unknown>) => {
            upserted.push(input);

            return { ...input, generatedAt: "2026-10-07 12:00:00" };
        },
        remove: (tagId: string, source: string) => {
            removedRows.push(`${tagId}:${source}`);

            return {
                tagId,
                source,
                relPath: `tags/${tagId.slice(0, 2)}/${tagId}-user-large.webp`,
                smallRelPath: `tags/${tagId.slice(0, 2)}/${tagId}-user-small.webp`,
            };
        },
        effectiveFor: () => effective,
    },
}));

const { clearTagPicture, setTagPicture } = await import("./tagPictureService");

const AUTH: AuthContext = {
    userId: "u-ada",
    email: "ada@example.test",
    displayName: "Ada",
    scopes: [],
    accessibleRootIds: ["r1"],
    tokenEpoch: 0,
};

const CROP = { x: 0.25, y: 0.1, w: 0.4, h: 0.8 };

beforeEach(() => {
    tags = [
        { id: "jane-tag", kind: "performer", name: "Jane", ownerId: null },
        { id: "bens-tag", kind: "tag", name: "Ben's", ownerId: "u-ben" },
    ];
    upserted = [];
    removedRows = [];
    effective = new Map();
    spawned = [];
    mediaKind = "video";
});

describe("setTagPicture", () => {
    it("lets anybody who can see a library tag choose its picture, cut from the original", async () => {
        const picture = await setTagPicture(
            "jane-tag",
            { mediaId: "m1", atMs: 4200, crop: CROP },
            AUTH
        );

        expect(picture.source).toBe("user");
        expect(upserted[0]).toMatchObject({
            tagId: "jane-tag",
            source: "user",
            mediaId: "m1",
            atMs: 4200,
            crop: CROP,
            setByUserId: "u-ada",
        });

        // The large one from the original at that moment, cropped; the small one from the large.
        const [large, small] = spawned;

        expect(large[large.indexOf("-ss") + 1]).toBe("4.200");
        expect(large[large.indexOf("-i") + 1].replace(/\\/g, "/")).toMatch(/\/media\/a\.mp4$/);
        expect(large[large.indexOf("-vf") + 1]).toMatch(/^crop=/);
        expect(small).not.toContain("-ss");
    });

    it("treats somebody else's private tag as not there", async () => {
        await expect(
            setTagPicture("bens-tag", { mediaId: "m1", atMs: 0, crop: CROP }, AUTH)
        ).rejects.toThrow(NotFoundError);
    });

    it("asks which moment of a video, and needs none of a photograph", async () => {
        await expect(
            setTagPicture("jane-tag", { mediaId: "m1", atMs: null, crop: CROP }, AUTH)
        ).rejects.toThrow(ValidationError);

        mediaKind = "image";
        await setTagPicture("jane-tag", { mediaId: "m1", atMs: null, crop: CROP }, AUTH);

        expect(spawned[0]).not.toContain("-ss");
    });

    it("refuses an item the viewer cannot see", async () => {
        await expect(
            setTagPicture("jane-tag", { mediaId: "elsewhere", atMs: 0, crop: CROP }, AUTH)
        ).rejects.toThrow(NotFoundError);
    });
});

describe("clearTagPicture", () => {
    it("takes back the chosen picture and answers with the one shown instead", async () => {
        effective.set("jane-tag", {
            tagId: "jane-tag",
            source: "auto",
            relPath: "tags/ja/jane-tag-auto-large.webp",
            smallRelPath: "tags/ja/jane-tag-auto-small.webp",
            mediaId: "m1",
            atMs: 1000,
            generatedAt: "2026-10-07 11:00:00",
        });

        const next = await clearTagPicture("jane-tag", AUTH);

        expect(removedRows).toEqual(["jane-tag:user"]);
        expect(next?.source).toBe("auto");
    });
});
