import { readFileSync } from "node:fs";
import * as path from "node:path";

import {
    assertSafeRelativePath,
    buildSegmentPlaylist,
    segmentIndexRelPath,
    segmentIndexSchema,
} from "@private-stock/core";
import { loadConfig } from "@private-stock/core/server";

import type { ResolvedFile } from "./mediaService";

/**
 * An MPEG-TS file's playlist of byte ranges of itself (§8), or null when there is none to give.
 *
 * Null when the `segments` stage has not run yet, and when its index describes some other file:
 * an original replaced in place keeps its item, and an index of the old bytes would send the
 * player to the wrong places in the new ones. The stream route then serves the file as it is,
 * which a browser refuses, and the item page explains -- the same as before the stage existed.
 *
 * Read from disk on every request rather than cached: a few kilobytes, and the playlist is asked
 * for once per play.
 */
export const segmentPlaylist = (
    mediaId: string,
    file: ResolvedFile,
    segmentUri: string
): string | null => {
    let index: unknown;

    try {
        const indexPath = path.resolve(
            loadConfig().dataDir,
            assertSafeRelativePath(segmentIndexRelPath(mediaId))
        );

        index = JSON.parse(readFileSync(indexPath, "utf8"));
    } catch {
        return null;
    }

    const parsed = segmentIndexSchema.safeParse(index);

    if (
        !parsed.success ||
        parsed.data.sizeBytes !== file.sizeBytes ||
        Math.floor(parsed.data.mtimeMs) !== Math.floor(file.mtimeMs)
    ) {
        return null;
    }

    return buildSegmentPlaylist(parsed.data, segmentUri);
};
