import { randomUUID } from "node:crypto";

import { NotFoundError, type StageState } from "@private-stock/core";
import { libraryFilePath } from "@private-stock/core/server";
import { db, mediaFileRepo, mediaRootRepo, searchRepo } from "@private-stock/db";

import { readEmbeddedText } from "../media/probe.js";
import type { JobRow } from "../queue.js";

/**
 * The `metadata` job: keep the descriptive tags a file carries about itself (§5b).
 *
 * Its own stage rather than part of the probe, because the probe cannot be re-run across a
 * library: it chains a cover, a hash and a transcode check behind itself every time, which is
 * how a changed file gets new ones. This one chains only the search document, so a version
 * bump here is a cheap sweep.
 *
 * Replaces only what it wrote before. A value somebody typed, or a scraper's, keeps its key --
 * `MediaAttribute` is unique per key, and the file's own claim is the weakest there is.
 */
export const runMetadata = async (job: JobRow): Promise<StageState> => {
    if (!job.fileId || !job.mediaId) {
        throw new Error("metadata job requires both fileId and mediaId");
    }

    const mediaId = job.mediaId;
    const file = mediaFileRepo.findById(job.fileId);

    if (!file) {
        return "empty";
    }

    const root = mediaRootRepo.findById(file.rootId);

    if (!root) {
        throw new NotFoundError(`Root ${file.rootId} no longer exists`);
    }

    const found = await readEmbeddedText(libraryFilePath(root.path, file.relPath));

    const changed = db.transaction((): boolean => {
        const removed = db
            .prepare(`DELETE FROM "MediaAttribute" WHERE "mediaId" = ? AND "source" = 'embedded'`)
            .run(mediaId).changes;

        const insert = db.prepare(
            `INSERT INTO "MediaAttribute" ("id", "mediaId", "key", "value", "source")
             VALUES (?, ?, ?, ?, 'embedded')
             ON CONFLICT ("mediaId", "key") DO NOTHING`
        );

        let inserted = 0;

        for (const [key, value] of found) {
            inserted += insert.run(randomUUID(), mediaId, key, value).changes;
        }

        return removed + inserted > 0;
    })();

    // The attributes are a column of the search document; one written before them is short.
    if (changed) {
        searchRepo.requestReindex([mediaId]);
    }

    return found.size > 0 ? "done" : "empty";
};
