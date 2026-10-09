import { beforeEach, describe, expect, it, vi } from "vitest";

import {
    AuthorizationError,
    NotFoundError,
    RateLimitError,
    ValidationError,
} from "@private-stock/core";

import type { AuthContext } from "../auth/withAuth";

/**
 * Capturing frames, and choosing which one represents an item (§13).
 *
 * Three claims are worth proving here, because each fails quietly rather than loudly:
 *
 *  - the frame comes out of the **original**, never out of the web-safe rendition the player
 *    may be showing, and never with the `thumbnail` filter that would save a different moment;
 *  - a capture is `source: 'user'`, which is the flag that keeps regeneration and the cleanup
 *    sweep away from it forever;
 *  - deleting the generated cover, or pointing a cover at another item's artifact, is refused.
 */

interface ArtifactFixture {
    id: string;
    mediaId: string;
    kind: string;
    ordinal: number;
    relPath: string;
    atMs: number | null;
    source: "auto" | "user";
    /** Who took it, or null once their account is gone. Decides who may discard it (§6). */
    createdByUserId?: string | null;
    label?: string | null;
    generatedAt: string;
}

let artifacts: ArtifactFixture[] = [];
let chosenCover: string | null = null;
let removed: string[] = [];
/** Row removals and file deletions, interleaved, so their order can be asserted. */
let steps: string[] = [];
/** What the fake capture search was last asked, and what it answers. */
let searched: { query: unknown; scope: unknown; direction: string } | null = null;
let searchRows: Record<string, unknown>[] = [];
/** What the live feed was told, as `mediaId:detail`. */
let announced: string[] = [];
/** Every ffmpeg invocation, so the arguments can be asserted rather than assumed. */
let spawned: { binary: string; args: string[] }[] = [];
/** Bytes the fake ffmpeg "writes"; zero stands for a seek past the end. */
let producedBytes = 1024;
let mediaKind = "video";
let visible = true;
let writeCount = 0;
/** When set, the fake ffmpeg does not finish until this settles — a capture held open. */
let holdSpawns: Promise<void> | null = null;

vi.mock("node:child_process", () => ({
    execFile: (
        binary: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, result: { stdout: string; stderr: string }) => void
    ) => {
        spawned.push({ binary, args });
        void (holdSpawns ?? Promise.resolve()).then(() =>
            callback(null, { stdout: "", stderr: "" })
        );
    },
}));

vi.mock("node:fs/promises", () => ({
    mkdir: () => Promise.resolve(),
    rm: (target: string) => {
        steps.push(`file:${target.replace(/\\/g, "/").split("/").pop()}`);

        return Promise.resolve();
    },
    stat: () =>
        producedBytes > 0 ? Promise.resolve({ size: producedBytes }) : Promise.resolve({ size: 0 }),
}));

vi.mock("@private-stock/core/server", async () => {
    const actual = await vi.importActual<typeof import("@private-stock/core/server")>(
        "@private-stock/core/server"
    );

    // Resolved rather than written as a literal: the service compares an absolute path
    // against the artifacts root, and on Windows those differ in both the drive and the
    // separator, so a hard-coded "/data/art" never matches what `path.resolve` produces.
    const path = await import("node:path");

    return {
        ...actual,
        loadConfig: () => ({ dataDir: path.resolve("/data") }),
        dataPaths: () => ({
            art: path.resolve("/data/art"),
            captures: path.resolve("/data/captures"),
        }),
        resolveFfmpeg: () => Promise.resolve("/usr/bin/ffmpeg"),
    };
});

vi.mock("@private-stock/db", () => ({
    artifactRepo: {
        listForMedia: (mediaId: string, kinds: string[]) =>
            artifacts.filter((row) => row.mediaId === mediaId && kinds.includes(row.kind)),
        findById: (id: string) => artifacts.find((row) => row.id === id),
        findOne: (mediaId: string, kind: string, ordinal: number) =>
            artifacts.find(
                (row) => row.mediaId === mediaId && row.kind === kind && row.ordinal === ordinal
            ),
        findChosenCover: () => chosenCover,
        findEffectiveCover: (mediaId: string) =>
            artifacts.find((row) => row.id === chosenCover) ??
            artifacts.find(
                (row) => row.mediaId === mediaId && row.kind === "cover" && row.ordinal === 0
            ),
        nextOrdinal: (mediaId: string, kind: string) =>
            artifacts.filter((row) => row.mediaId === mediaId && row.kind === kind).length + 1,
        setCoverArtifact: (_mediaId: string, artifactId: string | null) => {
            chosenCover = artifactId;

            return true;
        },
        remove: (id: string) => {
            removed.push(id);
            steps.push(`row:${id}`);
            artifacts = artifacts.filter((row) => row.id !== id);

            // `Media.coverArtifactId` is declared `ON DELETE SET NULL`, which is why the
            // service has no code for this case. The fake has to honour it or the tests
            // would be describing a database that does not exist.
            if (chosenCover === id) {
                chosenCover = null;
            }
        },
        setLabel: (id: string, label: string | null) => {
            const row = artifacts.find((artifact) => artifact.id === id);

            if (row?.kind !== "capture") {
                return false;
            }

            row.label = label;

            return true;
        },
        searchCaptures: (query: unknown, scope: unknown, direction: string) => {
            searched = { query, scope, direction };

            return searchRows;
        },
        countCaptures: () => searchRows.length + 100,
        recordArtifactChange: (mediaId: string, _rootId: string | null, detail: string) => {
            announced.push(`${mediaId}:${detail}`);
        },
        upsert: (input: Omit<ArtifactFixture, "id" | "generatedAt">) => {
            // A distinct timestamp per write, because that is what the served URL's version
            // token is built from — and the token is what keeps a recycled ordinal from
            // being a recycled URL.
            const row: ArtifactFixture = {
                ...input,
                id: `art-${(writeCount += 1)}`,
                generatedAt: `2026-02-02T00:00:0${writeCount}Z`,
            };

            artifacts.push(row);

            return row;
        },
    },
    mediaRepo: {
        findDetail: () =>
            visible
                ? { id: "m1", kind: mediaKind, rootId: "root", relPath: "clip.mkv" }
                : undefined,
    },
    mediaRootRepo: {
        findById: () => ({ id: "root", path: "/media/videos" }),
    },
}));

vi.mock("./artService", () => ({
    // Shaped like the real one: the version token is a function of the path and the time the
    // artifact was written, which is the part that matters below.
    artifactUrl: (mediaId: string, name: string, relPath: string, generatedAt: string) =>
        `/api/art/${mediaId}/${name}?v=${relPath}|${generatedAt}`,
}));

const {
    captureFrame,
    deleteCapture,
    discardCaptures,
    listCaptures,
    listFrames,
    renameCapture,
    setCover,
} = await import("./frameService");

const AUTH = { userId: "u1", accessibleRootIds: ["root"], scopes: [] } as unknown as AuthContext;

/** Somebody else sharing the same library, with no special powers. */
const OTHER = {
    userId: "u2",
    accessibleRootIds: ["root"],
    scopes: [],
} as unknown as AuthContext;

/** Somebody else who administers it. */
const ADMIN = {
    userId: "u3",
    accessibleRootIds: ["root"],
    scopes: ["admin"],
} as unknown as AuthContext;

const generated = () => {
    artifacts.push({
        id: "cover-0",
        mediaId: "m1",
        kind: "cover",
        ordinal: 0,
        relPath: "art/m1/cover.webp",
        atMs: 1000,
        source: "auto",
        generatedAt: "2026-01-01",
    });
    artifacts.push({
        id: "poster-1",
        mediaId: "m1",
        kind: "poster",
        ordinal: 1,
        relPath: "art/m1/poster-1.webp",
        atMs: 3000,
        source: "auto",
        generatedAt: "2026-01-01",
    });
};

beforeEach(() => {
    artifacts = [];
    chosenCover = null;
    removed = [];
    steps = [];
    searched = null;
    searchRows = [];
    announced = [];
    spawned = [];
    producedBytes = 1024;
    mediaKind = "video";
    visible = true;
    writeCount = 0;
    holdSpawns = null;
});

describe("capturing", () => {
    /**
     * The only ffmpeg in the web process has to be bounded in number as well as in work, or
     * anybody signed in can put as many of them on the request thread's machine as they like.
     */
    it("refuses a third capture while two are still running, and frees the slots after", async () => {
        let release!: () => void;
        holdSpawns = new Promise((resolve) => {
            release = resolve;
        });

        const running = [captureFrame("m1", 1_000, AUTH), captureFrame("m1", 2_000, OTHER)];

        await expect(captureFrame("m1", 3_000, AUTH)).rejects.toThrow(RateLimitError);

        release();
        await Promise.all(running);
        holdSpawns = null;

        await expect(captureFrame("m1", 4_000, AUTH)).resolves.toBeDefined();
    });

    it("reads the original, at the exact moment asked for", async () => {
        await captureFrame("m1", 90_500, AUTH);

        const { args } = spawned[0]!;

        // `libraryFilePath` joins with the platform separator, so the assertion has to as
        // well rather than assuming a POSIX box.
        expect(args.some((arg) => arg.endsWith("clip.mkv"))).toBe(true);

        // `-ss` must come *before* `-i`, or ffmpeg decodes from the start of the file: for a
        // two-hour video that is the difference between milliseconds and minutes, and it is
        // the entire reason this can run inside a request at all.
        expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
        expect(args[args.indexOf("-ss") + 1]).toBe("90.500");

        // No `thumbnail` filter: someone who paused on a frame means that frame, not the
        // most representative one within the next two seconds.
        expect(args.join(" ")).not.toContain("thumbnail");
    });

    it("marks the capture as a person's work", async () => {
        const frame = await captureFrame("m1", 1_000, AUTH);

        // The whole lifecycle distinction rests on this flag: an `auto` artifact is
        // disposable output a changed recipe may replace, and a `user` one is never touched.
        expect(frame.source).toBe("user");
        expect(frame.atMs).toBe(1_000);
    });

    it("recycles an ordinal after a delete, but not the URL", async () => {
        const first = await captureFrame("m1", 1_000, AUTH);

        await deleteCapture("m1", first.artifactId, AUTH);

        const second = await captureFrame("m1", 2_000, AUTH);

        // `nextOrdinal` is max-plus-one over the rows that still exist, so the slot genuinely
        // comes back. What stops that being a stale-cache bug is the version token: it is
        // derived from when the artifact was written, so the new frame is served from a URL
        // the browser has never seen, and any page still holding the old one gets a
        // short-lived revalidating response rather than a year-long immutable cache hit.
        expect(second.url).not.toBe(first.url);
    });

    it("refuses a position with no frame at it", async () => {
        producedBytes = 0;

        // Seeking past the end produces no file and no error from ffmpeg, so a size check is
        // the only thing standing between that and an artifact row naming nothing.
        await expect(captureFrame("m1", 999_999_999, AUTH)).rejects.toThrow(ValidationError);
        expect(artifacts).toHaveLength(0);
    });

    it("refuses an image", async () => {
        mediaKind = "image";

        await expect(captureFrame("m1", 0, AUTH)).rejects.toThrow(ValidationError);
    });

    it("reports an item this viewer cannot see as missing", async () => {
        visible = false;

        // Not "forbidden": that answer would confirm the item exists in a library this
        // account has no access to.
        await expect(captureFrame("m1", 0, AUTH)).rejects.toThrow(NotFoundError);
    });
});

describe("the frame strip", () => {
    it("marks the generated cover when nobody has chosen one", () => {
        generated();

        const frames = listFrames("m1", AUTH);

        // Almost every item is in this state, so a strip that marked only an explicit choice
        // would show the current frame as none of them nearly all of the time.
        expect(frames.find((frame) => frame.isCover)?.artifactId).toBe("cover-0");
    });

    it("moves the mark when a frame is chosen, and back when it is cleared", async () => {
        generated();
        const capture = await captureFrame("m1", 5_000, AUTH);

        setCover("m1", capture.artifactId, AUTH);
        expect(listFrames("m1", AUTH).find((frame) => frame.isCover)?.artifactId).toBe(
            capture.artifactId
        );

        // Reverting costs nothing because the generated cover was never overwritten.
        setCover("m1", null, AUTH);
        expect(listFrames("m1", AUTH).find((frame) => frame.isCover)?.artifactId).toBe("cover-0");
    });

    it("lists every frame in the order it appears in the video", async () => {
        generated();

        // Taken back to front, which is how anyone hunting for a better thumbnail actually
        // works: scrub, grab, scrub somewhere else, grab again.
        await captureFrame("m1", 5_000, AUTH);
        await captureFrame("m1", 2_000, AUTH);

        // Ordered along the clip, not along the history of the strip. The generated cover
        // sits at 1s and the poster at 3s, so the captures interleave with them rather than
        // queueing up behind them.
        expect(listFrames("m1", AUTH).map((frame) => frame.atMs)).toEqual([1000, 2000, 3000, 5000]);
    });

    it("puts a later capture of an earlier moment ahead of the first one", async () => {
        generated();
        await captureFrame("m1", 5_000, AUTH);
        await captureFrame("m1", 2_000, AUTH);

        // The one taken second comes first, because it is earlier in the clip. Capture
        // order would have read 5s then 2s — two stills next to each other with no
        // relationship a viewer can see.
        expect(
            listFrames("m1", AUTH)
                .filter((frame) => frame.source === "user")
                .map((frame) => frame.atMs)
        ).toEqual([2000, 5000]);
    });

    it("sorts a frame with no position to the end", async () => {
        artifacts.push({
            id: "cover-0",
            mediaId: "m1",
            kind: "cover",
            ordinal: 0,
            // A still image's downscaled copy: there is no moment for it to be in.
            atMs: null,
            relPath: "art/m1/cover.webp",
            source: "auto",
            generatedAt: "2026-01-01",
        });
        await captureFrame("m1", 4_000, AUTH);

        expect(listFrames("m1", AUTH).map((frame) => frame.atMs)).toEqual([4000, null]);
    });
});

describe("guarding the pointer", () => {
    it("refuses a cover belonging to another item", () => {
        artifacts.push({
            id: "other",
            mediaId: "m2",
            kind: "capture",
            ordinal: 1,
            relPath: "art/m2/capture-1.webp",
            atMs: 0,
            source: "user",
            generatedAt: "2026-01-01",
        });

        // Otherwise a cover is a way to serve bytes from an item — and so from a library —
        // the viewer may not be able to reach.
        expect(() => setCover("m1", "other", AUTH)).toThrow(NotFoundError);
    });

    it("refuses to delete a generated frame", async () => {
        generated();

        // Deleting the generator's output would only invite it back on the next sweep, and
        // the file it names is not anybody's work to lose.
        await expect(deleteCapture("m1", "cover-0", AUTH)).rejects.toThrow(ValidationError);
        expect(removed).toEqual([]);
    });

    it("deletes a capture and the rendering that draws it", async () => {
        const capture = await captureFrame("m1", 5_000, AUTH);

        await deleteCapture("m1", capture.artifactId, AUTH);

        // The rendering exists only to put this capture in a grid. Left behind it would be a
        // row describing a picture that no longer exists — and, when it happened to be the
        // cover, would leave the library showing a still the viewer had just deleted.
        expect(removed).toHaveLength(2);
        expect(removed).toContain(capture.artifactId);
        expect(artifacts).toHaveLength(0);
    });

    it("names every frame by its own ordinal, never by the cover alias", async () => {
        generated();
        const capture = await captureFrame("m1", 5_000, AUTH);

        const frames = listFrames("m1", AUTH);
        const urls = frames.map((frame) => frame.url);

        // The bare "cover" segment means *whichever* frame currently represents the item, so
        // a strip that asked for it would draw the current cover in the slot reserved for
        // the generated one -- and show it twice the moment a capture was chosen.
        expect(urls.some((url) => /\/cover\?/.test(url))).toBe(false);
        expect(urls).toContain(
            frames.find((frame) => frame.artifactId === "cover-0")?.url as string
        );
        expect(frames.find((frame) => frame.artifactId === "cover-0")?.url).toContain("cover-0");

        // And each frame is a different picture, which is the property that broke: every
        // capture tile was fetching the item's cover instead of its own rendering.
        expect(new Set(urls).size).toBe(urls.length);
        expect(capture.url).toContain("cover-1");
    });

    it("serves the strip from the rendering and the enlarged view from the still", async () => {
        const capture = await captureFrame("m1", 5_000, AUTH);

        // A row of 2560px stills scaled down by the browser would download every capture in
        // the library to draw a filmstrip.
        expect(capture.url).not.toBe(capture.fullUrl);
        expect(capture.url).toContain("cover-1");
        expect(capture.fullUrl).toContain("capture-1");
    });

    /**
     * A capture at ordinal 0, which only a row written before the numbering guard can be.
     *
     * The pairing is by ordinal and ordinal 0 belongs to the generator, so this capture has
     * no rendering — but `findOne(mediaId, "cover", 0)` answers with the generated cover,
     * which looks exactly like one. Both tests below failed before `renderingFor` existed,
     * and neither failed loudly: the first stored a pointer the reader correctly discards,
     * and the second deleted the generator's cover without a word.
     */
    const legacyCapture = () => {
        artifacts.push({
            id: "capture-0",
            mediaId: "m1",
            kind: "capture",
            ordinal: 0,
            relPath: "art/m1/capture-0.webp",
            atMs: 2000,
            source: "user",
            createdByUserId: "u1",
            generatedAt: "2026-01-01",
        });
    };

    it("refuses a capture that shares the generator's ordinal", () => {
        generated();
        legacyCapture();

        // Silently storing `cover-0` here is the whole bug: the pointer reads back as "no
        // choice" — correctly — so pressing the button did nothing, showed nothing, and
        // left no trace to find it by.
        expect(() => setCover("m1", "capture-0", AUTH)).toThrow(ValidationError);
        expect(chosenCover).toBeNull();
    });

    it("does not offer the cover button for a frame that cannot be one", () => {
        generated();
        legacyCapture();

        const frames = listFrames("m1", AUTH);

        expect(frames.find((frame) => frame.artifactId === "capture-0")?.coverable).toBe(false);
        // Everything the generator made is its own rendering, so it is always choosable.
        expect(frames.filter((frame) => frame.source === "auto").every((f) => f.coverable)).toBe(
            true
        );
    });

    it("never deletes the generated cover along with a capture", async () => {
        generated();
        legacyCapture();

        await deleteCapture("m1", "capture-0", AUTH);

        // The capture goes; `cover-0` stays. A `user` action destroying `auto` output is
        // survivable — a regeneration brings it back — but a `user` action destroying it by
        // *mistaking it for user output* is the source split failing at its one job (§13).
        expect(removed).toEqual(["capture-0"]);
        expect(artifacts.some((row) => row.id === "cover-0")).toBe(true);
    });

    it("refuses to make a capture the cover when its rendering is missing", async () => {
        const capture = await captureFrame("m1", 5_000, AUTH);

        // The pointer has to name the grid-sized copy, so without one there is nothing the
        // cover could be set to that the grid could safely draw.
        artifacts = artifacts.filter((row) => row.kind !== "cover");

        expect(() => setCover("m1", capture.artifactId, AUTH)).toThrow(ValidationError);
    });
});

describe("whose capture it is", () => {
    /**
     * Captures are the one piece of user work that is library-wide (§6).
     *
     * Everybody sharing a library sees everybody's frames, which is right -- a good still of
     * an item is good for whoever looks at it. What is not right is that the strip then
     * offers a destructive control over somebody else's work to every account that can open
     * the page. Nothing else in the app permits a cross-user write; sharing a playlist or a
     * filter grants reading and never writing, administrators included. A capture is
     * stronger than either, because it cannot be regenerated.
     */
    it("lets the person who took it discard it", async () => {
        const capture = await captureFrame("m1", 5_000, AUTH);

        await expect(deleteCapture("m1", capture.artifactId, AUTH)).resolves.toBeDefined();
    });

    it("refuses somebody else sharing the same library", async () => {
        const capture = await captureFrame("m1", 5_000, AUTH);

        await expect(deleteCapture("m1", capture.artifactId, OTHER)).rejects.toThrow(
            AuthorizationError
        );
        expect(removed).toEqual([]);
    });

    it("lets an administrator discard anybody's", async () => {
        const capture = await captureFrame("m1", 5_000, AUTH);

        // Administering the library is the one role that spans other people's work here,
        // because somebody has to be able to clear out a departed account's frames.
        await expect(deleteCapture("m1", capture.artifactId, ADMIN)).resolves.toBeDefined();
    });

    it("treats an unattributed capture as nobody's but an administrator's", async () => {
        // `createdByUserId` is ON DELETE SET NULL: a capture outlives the account that made
        // it and loses only its attribution. Letting anyone claim one would mean deleting an
        // account quietly hands that person's frames to the whole library.
        artifacts.push({
            id: "orphan",
            mediaId: "m1",
            kind: "capture",
            ordinal: 1,
            relPath: "captures/m1/capture-1.webp",
            atMs: 4000,
            source: "user",
            createdByUserId: null,
            generatedAt: "2026-01-01",
        });

        await expect(deleteCapture("m1", "orphan", AUTH)).rejects.toThrow(AuthorizationError);
        await expect(deleteCapture("m1", "orphan", ADMIN)).resolves.toBeDefined();
    });

    it("tells the strip which frames it may offer to discard", async () => {
        generated();
        await captureFrame("m1", 5_000, AUTH);

        const mine = listFrames("m1", AUTH);
        const theirs = listFrames("m1", OTHER);

        // The button is not drawn rather than drawn and refused, the same rule the cover
        // control follows: a control that cannot work is worse than no control.
        expect(mine.filter((frame) => frame.discardable)).toHaveLength(1);
        expect(theirs.some((frame) => frame.discardable)).toBe(false);
        // And a generated frame is never discardable by anyone -- deleting one would only
        // invite it back on the next sweep.
        expect(listFrames("m1", ADMIN).filter((frame) => frame.discardable)).toHaveLength(1);
    });
});

describe("the first capture becomes the cover", () => {
    it("promotes it when the item has never had one", async () => {
        generated();

        const frame = await captureFrame("m1", 5_000, AUTH);

        // Capturing a frame for an item with no capture is almost always somebody fixing a
        // bad thumbnail. Making them open a panel and click the picture they just made is a
        // second step with no decision in it.
        expect(frame.isCover).toBe(true);
    });

    it("leaves the cover alone for every capture after the first", async () => {
        generated();

        const first = await captureFrame("m1", 5_000, AUTH);
        const second = await captureFrame("m1", 9_000, AUTH);

        // With more than one candidate there is a real decision, and it stays manual.
        expect(second.isCover).toBe(false);
        expect(listFrames("m1", AUTH).find((frame) => frame.isCover)?.artifactId).toBe(
            first.artifactId
        );
    });

    it("still promotes after the generated cover was clicked in the strip", async () => {
        generated();

        // Clicking the generated frame means "no choice", not "I choose this one". Stored as
        // an explicit pointer it would look identical on screen and would quietly disable
        // the promotion for the life of the item.
        setCover("m1", "cover-0", AUTH);

        expect((await captureFrame("m1", 5_000, AUTH)).isCover).toBe(true);
    });

    it("never overrides a cover somebody chose", async () => {
        generated();
        setCover("m1", "poster-1", AUTH);

        const frame = await captureFrame("m1", 5_000, AUTH);

        // An explicit choice outranks the convenience. Promoting over it would be the one
        // case where this destroys curation rather than standing in for its absence.
        expect(frame.isCover).toBe(false);
    });

    it("does not re-promote after a deliberate return to the generated cover", async () => {
        generated();

        const first = await captureFrame("m1", 5_000, AUTH);

        // "Use the generated cover" clears the pointer, so a rule keyed only on "nothing is
        // chosen" would hand the cover straight back to the next capture — overriding a
        // choice instead of filling a gap. The first-capture condition is what stops it.
        setCover("m1", null, AUTH);

        const second = await captureFrame("m1", 9_000, AUTH);

        expect(second.isCover).toBe(false);
        expect(listFrames("m1", AUTH).find((frame) => frame.isCover)?.artifactId).toBe("cover-0");
        expect(first.isCover).toBe(true);
    });

    it("promotes again once every capture has been deleted", async () => {
        generated();

        const first = await captureFrame("m1", 5_000, AUTH);
        await deleteCapture("m1", first.artifactId, AUTH);

        // Deleting the frame the cover pointed at reverts the item to the generated one via
        // the foreign key, so the next capture is genuinely the first again — clearing the
        // shelf and starting over should behave like starting over.
        expect(listFrames("m1", AUTH).find((frame) => frame.isCover)?.artifactId).toBe("cover-0");
        expect((await captureFrame("m1", 9_000, AUTH)).isCover).toBe(true);
    });
});

describe("discarding", () => {
    it("removes the rows before the files, so an interruption leaves only orphans", async () => {
        const capture = await captureFrame("m1", 5_000, AUTH);
        const renderingId = artifacts.find((row) => row.kind === "cover")!.id;

        await deleteCapture("m1", capture.artifactId, AUTH);

        expect(steps).toEqual([
            `row:${renderingId}`,
            `row:${capture.artifactId}`,
            "file:capture-1.webp",
            "file:cover-1.webp",
        ]);
    });

    it("discards a batch and reports each capture it could not", async () => {
        generated();
        const mine = await captureFrame("m1", 5_000, AUTH);
        const theirs = await captureFrame("m1", 9_000, OTHER);

        const result = await discardCaptures(
            [mine.artifactId, mine.artifactId, theirs.artifactId, "poster-1", "gone"],
            AUTH
        );

        expect(result.succeeded).toBe(1);
        expect(result.failed).toEqual([
            { artifactId: theirs.artifactId, reason: "Captured by somebody else" },
            { artifactId: "poster-1", reason: "Not found" },
            { artifactId: "gone", reason: "Not found" },
        ]);
        expect(artifacts.some((row) => row.id === mine.artifactId)).toBe(false);
        // The generated frames are untouched, whatever the batch named.
        expect(artifacts.map((row) => row.id)).toEqual(
            expect.arrayContaining(["cover-0", "poster-1"])
        );
    });

    it("reports captures of an item this viewer can no longer see as not found", async () => {
        const capture = await captureFrame("m1", 5_000, AUTH);
        visible = false;

        const result = await discardCaptures([capture.artifactId], AUTH);

        expect(result).toEqual({
            succeeded: 0,
            failed: [{ artifactId: capture.artifactId, reason: "Not found" }],
        });
        expect(removed).toEqual([]);
    });
});

/**
 * Discarding the capture that was the cover (§9, §13b).
 *
 * The item falls back to the generated cover by itself — the column is ON DELETE SET NULL.
 * What does not happen by itself is every tile already on screen learning that, in this
 * session's other caches and in everybody else's grid. The feed has to say which of two things
 * happened, because a tile pointed at the cover alias with nothing behind it is a broken image.
 */
describe("discarding the cover", () => {
    it("announces the fallback to the generated cover", async () => {
        generated();
        const capture = await captureFrame("m1", 5_000, AUTH);

        expect(capture.isCover).toBe(true);

        await deleteCapture("m1", capture.artifactId, AUTH);

        expect(announced).toEqual(["m1:cover"]);
        expect(listFrames("m1", AUTH).find((frame) => frame.isCover)?.artifactId).toBe("cover-0");
    });

    it("announces that there is no cover left when nothing was generated", async () => {
        const capture = await captureFrame("m1", 5_000, AUTH);

        expect(capture.isCover).toBe(true);

        await discardCaptures([capture.artifactId], AUTH);

        expect(announced).toEqual(["m1:coverCleared"]);
    });

    it("says nothing when the discarded capture was not the cover", async () => {
        generated();
        await captureFrame("m1", 5_000, AUTH);
        const second = await captureFrame("m1", 9_000, AUTH);

        await deleteCapture("m1", second.artifactId, AUTH);

        expect(announced).toEqual([]);
    });
});

describe("captions", () => {
    it("lets the person who took it write and clear one", async () => {
        const capture = await captureFrame("m1", 5_000, AUTH);

        expect(renameCapture("m1", capture.artifactId, "The good one", AUTH).label).toBe(
            "The good one"
        );
        expect(listFrames("m1", AUTH).find((frame) => frame.kind === "capture")?.label).toBe(
            "The good one"
        );
        // An empty caption is no caption, not an empty string on screen.
        expect(renameCapture("m1", capture.artifactId, "", AUTH).label).toBeNull();
    });

    it("follows the discard rule: not somebody else, but an administrator", async () => {
        const capture = await captureFrame("m1", 5_000, AUTH);

        expect(() => renameCapture("m1", capture.artifactId, "Mine now", OTHER)).toThrow(
            AuthorizationError
        );
        expect(renameCapture("m1", capture.artifactId, "Tidied", ADMIN).label).toBe("Tidied");
    });

    it("refuses a generated frame, and another item's capture", async () => {
        generated();
        const capture = await captureFrame("m1", 5_000, AUTH);

        expect(() => renameCapture("m1", "poster-1", "Nope", AUTH)).toThrow(ValidationError);
        expect(() => renameCapture("m2", capture.artifactId, "Nope", AUTH)).toThrow(NotFoundError);
    });

    it("never gives a generated frame a caption on the strip", () => {
        generated();

        expect(listFrames("m1", AUTH).every((frame) => frame.label === null)).toBe(true);
    });
});

describe("the Captures page", () => {
    const row = (overrides: Record<string, unknown> = {}) => ({
        id: "cap-1",
        mediaId: "m1",
        kind: "capture",
        ordinal: 1,
        relPath: "captures/m1/capture-1.webp",
        atMs: 5000,
        source: "user",
        createdByUserId: "u1",
        label: null,
        generatedAt: "2026-02-02",
        mediaTitle: "Alpha",
        renderingId: "ren-1",
        renderingRelPath: "art/m1/cover-1.webp",
        renderingGeneratedAt: "2026-02-03",
        isCover: 1,
        ...overrides,
    });

    it("asks for this viewer's own, in the sort's natural direction", () => {
        listCaptures({ sort: "created", limit: 60, page: 0 }, AUTH);
        expect(searched).toMatchObject({
            scope: { userId: "u1", accessibleRootIds: ["root"] },
            direction: "desc",
        });

        listCaptures({ sort: "title", limit: 60, page: 0 }, AUTH);
        expect(searched?.direction).toBe("asc");

        listCaptures({ sort: "title", direction: "desc", limit: 60, page: 0 }, AUTH);
        expect(searched?.direction).toBe("desc");
    });

    it("draws the rendering and opens the still", () => {
        searchRows = [row()];

        const [capture] = listCaptures({ sort: "created", limit: 60, page: 0 }, AUTH).items;

        expect(capture.url).toContain("/cover-1?");
        expect(capture.fullUrl).toContain("/capture-1?");
        expect(capture).toMatchObject({
            mediaId: "m1",
            mediaTitle: "Alpha",
            isCover: true,
            coverable: true,
            discardable: true,
        });
    });

    it("falls back to the still when there is no rendering, and cannot then be the cover", () => {
        searchRows = [
            row({
                renderingId: null,
                renderingRelPath: null,
                renderingGeneratedAt: null,
                isCover: null,
            }),
        ];

        const [capture] = listCaptures({ sort: "created", limit: 60, page: 0 }, AUTH).items;

        expect(capture.url).toBe(capture.fullUrl);
        expect(capture.coverable).toBe(false);
        expect(capture.isCover).toBe(false);
    });

    it("knows whether there is another page from the total", () => {
        searchRows = [row()];

        // The fake counts a hundred more than it returns.
        const response = listCaptures({ sort: "created", limit: 60, page: 1 }, AUTH);

        expect(response.total).toBe(101);
        expect(response.hasMore).toBe(false);
        expect(listCaptures({ sort: "created", limit: 60, page: 0 }, AUTH).hasMore).toBe(true);
    });
});
