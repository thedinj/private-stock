import { describe, expect, it } from "vitest";

import { classifyPath, shouldIgnoreDirectory, titleFromPath } from "./classify.js";

/**
 * Classification decides what a first scan imports. Getting it wrong fills the library with
 * thousands of junk entries that are tedious to undo, so the rules are pinned here.
 */

const kindOf = (relPath: string) => classifyPath(relPath).classification;

describe("classifyPath", () => {
    it("recognises video and image media", () => {
        expect(classifyPath("holiday/clip.mp4")).toMatchObject({
            classification: "media",
            kind: "video",
        });
        expect(classifyPath("trip/photo.JPG")).toMatchObject({
            classification: "media",
            kind: "image",
        });
    });

    it("treats folder and sibling artwork as companions, not library items", () => {
        // The specific failure this prevents: every season folder contributing a cover image
        // to the grid.
        expect(kindOf("season 1/folder.jpg")).toBe("companion");
        expect(kindOf("season 1/cover.png")).toBe("companion");
        expect(kindOf("season 1/episode-thumb.jpg")).toBe("companion");
        expect(kindOf("season 1/episode-poster.jpg")).toBe("companion");
    });

    it("keeps ordinary images that merely resemble artwork names", () => {
        // "folder" as a word is fine; it is the exact filename that is artwork.
        expect(kindOf("trips/folder party.jpg")).toBe("media");
        expect(kindOf("trips/my-cover-band.jpg")).toBe("media");
    });

    it("treats subtitles and metadata as companions", () => {
        expect(classifyPath("a/clip.srt")).toMatchObject({ companionKind: "subtitle" });
        expect(classifyPath("a/clip.ass")).toMatchObject({ companionKind: "subtitle" });
        expect(classifyPath("a/clip.nfo")).toMatchObject({ companionKind: "metadata" });
    });

    it("ignores NAS-generated directories", () => {
        // These are why a first scan on a Synology or QNAP otherwise imports thousands of
        // thumbnails.
        expect(kindOf("@eaDir/clip.mp4/thumb.jpg")).toBe("ignored");
        expect(kindOf(".@__thumb/x.jpg")).toBe("ignored");
        expect(kindOf("#recycle/old.mp4")).toBe("ignored");
        expect(kindOf("$RECYCLE.BIN/x.mp4")).toBe("ignored");
    });

    it("ignores system files and in-flight downloads", () => {
        expect(kindOf("a/Thumbs.db")).toBe("ignored");
        expect(kindOf("a/.DS_Store")).toBe("ignored");
        expect(kindOf("a/movie.mp4.part")).toBe("ignored");
        expect(kindOf("a/movie.mp4.crdownload")).toBe("ignored");
    });

    it("ignores unknown extensions rather than importing them", () => {
        expect(kindOf("a/notes.txt")).toBe("ignored");
        expect(kindOf("a/archive.zip")).toBe("ignored");
        expect(kindOf("a/README")).toBe("ignored");
        // Explicitly out of scope (§19) rather than silently unsupported.
        expect(kindOf("a/photo.heic")).toBe("ignored");
        expect(kindOf("a/raw.cr2")).toBe("ignored");
    });

    it("honours admin-supplied ignored directories", () => {
        expect(kindOf("private/x.mp4")).toBe("media");
        expect(
            classifyPath("private/x.mp4", { extraIgnoredDirectories: ["private"] }).classification
        ).toBe("ignored");
    });
});

describe("shouldIgnoreDirectory", () => {
    /**
     * The regression this exists for.
     *
     * The watcher originally reused `classifyPath` for directories. A directory has no
     * extension, so it classified as "ignored", and chokidar silently refused to descend
     * into the entire library: watching started successfully and no event ever arrived.
     */
    it("does not ignore an ordinary media directory", () => {
        expect(shouldIgnoreDirectory("holiday")).toBe(false);
        expect(shouldIgnoreDirectory("2024/summer trip")).toBe(false);

        // Whereas the file rule says the opposite, which is correct for a file and wrong here.
        expect(classifyPath("holiday").classification).toBe("ignored");
    });

    it("ignores NAS and hidden directories", () => {
        expect(shouldIgnoreDirectory("@eaDir")).toBe(true);
        expect(shouldIgnoreDirectory("videos/@eaDir")).toBe(true);
        expect(shouldIgnoreDirectory(".hidden")).toBe(true);
        expect(shouldIgnoreDirectory("#recycle")).toBe(true);
    });

    it("treats the root itself as watchable", () => {
        expect(shouldIgnoreDirectory("")).toBe(false);
        expect(shouldIgnoreDirectory(".")).toBe(false);
    });
});

describe("titleFromPath", () => {
    it("produces a readable title from a filename", () => {
        expect(titleFromPath("holiday/clip_1.mp4")).toBe("clip 1");
        expect(titleFromPath("a/My.Great.Video.mkv")).toBe("My Great Video");
        expect(titleFromPath("a/beach day.mp4")).toBe("beach day");
    });

    it("falls back to the filename when nothing is left", () => {
        expect(titleFromPath("a/___.mp4")).toBe("___.mp4");
    });
});
