import { randomUUID } from "node:crypto";

import { assessPlayback, findStage, NotFoundError } from "@private-stock/core";
import { libraryFilePath } from "@private-stock/core/server";
import { changeLogRepo, db, mediaFileRepo, mediaRootRepo, mediaRepo } from "@private-stock/db";

import { probeFile } from "../media/probe.js";
import { enqueue, type JobRow } from "../queue.js";

/**
 * Read from the registry rather than written out, so the chain and the sweep cannot
 * drift into separate priority bands for the same stage again (§7d).
 */
const COVER_PRIORITY = findStage("cover")?.priority ?? 70;
const PHASH_PRIORITY = findStage("phash")?.priority ?? 100;

/**
 * The `probe` job: read real metadata out of a file and record it.
 *
 * Until this runs, an item exists in the library with nothing but a filename — which is why
 * the grid distinguishes "not probed yet" from "has no duration" rather than showing both
 * as blank.
 */
export const runProbe = async (job: JobRow): Promise<void> => {
    if (!job.fileId || !job.mediaId) {
        throw new Error("probe job requires both fileId and mediaId");
    }

    const file = mediaFileRepo.findById(job.fileId);

    if (!file) {
        // The file was removed between the scan and now. Nothing to do, and not an error
        // worth retrying.
        return;
    }

    const root = mediaRootRepo.findById(file.rootId);

    if (!root) {
        throw new NotFoundError(`Root ${file.rootId} no longer exists`);
    }

    const absolutePath = libraryFilePath(root.path, file.relPath);

    const probe = await probeFile(absolutePath);

    db.transaction(() => {
        mediaRepo.applyProbe(job.mediaId!, probe);

        // Streams are replaced wholesale rather than merged: a re-probe follows the file
        // changing, so the previous track list is not evidence of anything.
        db.prepare(`DELETE FROM "MediaStream" WHERE "mediaId" = ?`).run(job.mediaId);

        const insert = db.prepare(
            `INSERT INTO "MediaStream"
                ("id", "mediaId", "kind", "streamIndex", "codec", "language", "title",
                 "channels", "isDefault", "isForced")
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );

        for (const stream of probe.streams) {
            insert.run(
                randomUUID(),
                job.mediaId,
                stream.kind,
                stream.streamIndex,
                stream.codec,
                stream.language,
                stream.title,
                stream.channels,
                stream.isDefault ? 1 : null,
                stream.isForced ? 1 : null
            );
        }

        /**
         * Tell the grid, in the same transaction as the metadata itself (§13b).
         *
         * Until this ran, an item was a filename: the tile said "processing…", carried no
         * duration, no dimensions and the raw file name in place of a title. The probe is what
         * replaces all of that, and it was the one stage in the chain that finished silently —
         * covers, previews and sprites each record a change and this did not. So a newly
         * scanned item stayed "processing…" on every open page until somebody reloaded, which
         * looks exactly like a library that has stopped working.
         *
         * `update` rather than `insert`: the row has been in the list since the scanner found
         * it, and an insert is what tells a client something has *arrived* — reporting one here
         * would count the same file twice in the "N new items" the grid offers to apply.
         */
        changeLogRepo.record({
            entity: "media",
            entityId: job.mediaId,
            rootId: file.rootId,
            op: "update",
            detail: "probe",
        });
    })();

    // Only now: the cover job samples frames as a fraction of the duration, which the probe
    // is what established. Enqueuing it from the scanner instead would mean every cover for
    // a fresh library came from the fallback offsets.
    /**
     * At the registry's priority, not one better (§7d).
     *
     * This used to be 60 against the sweep's 70, which split one stage across two bands: the
     * claim reads `priority ASC` first, so *every* chain-queued cover ran before the first
     * swept one regardless of which item either belonged to. The sweep orders newest-first
     * and was overruled for its entire backlog.
     *
     * Chaining still buys what it was meant to buy -- the job exists now rather than within
     * five minutes -- and ordering is left to the key that describes the library.
     */
    enqueue(db, {
        kind: "cover",
        mediaId: job.mediaId,
        fileId: job.fileId,
        priority: COVER_PRIORITY,
    });

    // Index now rather than waiting for the periodic backfill to notice (§5c). A newly
    // scanned item that is visible in the grid but cannot be found by searching for its own
    // filename reads as search being broken, and during a long scan that state would
    // otherwise last minutes.
    enqueue(db, { kind: "index", mediaId: job.mediaId, priority: 90 });

    /**
     * Perceptual hashing, after the probe, behind the cover and ahead of previews and sprites
     * (§10). The registry says why; this reads its number so the two cannot drift apart.
     *
     * Chained here rather than left to the periodic backfill, which would leave a freshly
     * scanned library with no duplicate detection for minutes and make the feature look
     * broken on exactly the run where someone first goes looking for it.
     *
     * After the probe because the video sampling plan is computed from the duration --
     * hashing first means hashing the fallback offsets of every video in the library.
     */
    enqueue(db, {
        kind: "phash",
        mediaId: job.mediaId,
        fileId: job.fileId,
        priority: PHASH_PRIORITY,
    });

    // No identity hash here: it ran before this did, and is what queued it (§10f).

    /**
     * Queue a web-safe rendition when the browser cannot play the original (§8).
     *
     * This is the only place the decision is made for background work, and it is made from
     * the probe's own results rather than from a filename or a guess. Lowest priority of
     * anything the pipeline queues: one transcode can run for an hour, and covers for the
     * whole library matter more than any single file becoming playable.
     */
    const media = mediaRepo.findBasic(job.mediaId);

    if (!media) {
        return;
    }

    const assessment = assessPlayback({
        // The scanner already classified this from the extension; re-deriving it from the
        // probe would disagree with the row the rest of the app reads.
        kind: media.kind,
        // ffprobe reports "matroska,webm" for both MKV and WebM; only the name separates them.
        relPath: file.relPath,
        container: probe.container,
        codec: probe.codec,
        videoProfile: probe.videoProfile,
        pixFmt: probe.pixFmt,
        audioCodec: probe.audioCodec,
        // Just written, in this transaction.
        probedAt: new Date().toISOString(),
    });

    if (!assessment.directPlay) {
        enqueue(db, {
            kind: "transcode",
            mediaId: job.mediaId,
            fileId: job.fileId,
            priority: 200,
            // A transcode is worth more attempts than a cover: the failures are usually
            // transient (a busy box, a share that blinked) rather than a bad file.
            maxAttempts: 3,
        });
    }
};
