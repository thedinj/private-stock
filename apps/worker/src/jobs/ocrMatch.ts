import { createHash } from "node:crypto";

import { buildTagMatcher, type TagNameEntry } from "@private-stock/core";
import { ocrTagMatchRepo } from "@private-stock/db";

import { breathe } from "../eventLoop.js";

/**
 * The `ocrMatch` job: every OCR string matched again against the performers and sources
 * (§5d "Tagging performers and sources from what was read").
 *
 * The `ocr` job matches an item's own strings as it writes them, so this exists for the other
 * half: a name that did not exist when the text was read. The web enqueues it whenever the
 * vocabulary changes, held back a few seconds so a burst of names is one run; it does nothing
 * when the vocabulary is the one it last matched against. It also runs once at startup.
 *
 * Every run ends with a recount of every pair, which is what corrects a count left stale — by a
 * recount the web could not store because the database was busy, or by a path that changes
 * tags without telling the queue. It only reads unless a count moved. Then every accepted pair
 * applies whatever its rule is still owed (§5d "An accepted pair is a rule").
 *
 * **Nothing here holds the write lock while it reads.** Strings are read and matched outside any
 * transaction and only the strings whose pairs change are written (`matchKnownStrings`); counts
 * are read first and only the moved ones written (`recountPending`). A full run after one new
 * name used to rewrite every pair and recount all of them inside the transactions, seconds of
 * lock each, once per name coined.
 */

/** Strings matched per pass between breaths. */
const CHUNK = 500;

/** Pairs recounted per pass between breaths: each is a few cold pages on the NAS. */
const RECOUNT_CHUNK = 100;

/** The vocabulary this process last matched the whole library against. */
let lastFingerprint: string | null = null;

const fingerprintOf = (vocabulary: TagNameEntry[]): string =>
    createHash("sha256")
        .update(vocabulary.map((entry) => `${entry.tagId}\t${entry.name}`).join("\n"))
        .digest("hex");

export const runOcrMatch = async (): Promise<void> => {
    let since = Date.now();

    // Until the vocabulary holds still: a name coined while a run is under way finds this job
    // claimed, so the web queues nothing, and the run itself is what has to notice.
    for (;;) {
        const vocabulary = ocrTagMatchRepo.matchVocabulary();
        const fingerprint = fingerprintOf(vocabulary);

        if (fingerprint === lastFingerprint) {
            return;
        }

        const matcher = buildTagMatcher(vocabulary);
        let after: string | null = null;
        let matched = 0;

        for (;;) {
            const strings = ocrTagMatchRepo.matchableStrings(after, CHUNK);

            if (strings.length === 0) {
                break;
            }

            ocrTagMatchRepo.matchKnownStrings(strings, matcher);
            matched += strings.length;
            after = strings[strings.length - 1].textNorm;
            since = await breathe(since);
        }

        ocrTagMatchRepo.pruneOrphans();

        let recounted = 0;
        let afterId: string | null = null;

        for (;;) {
            const ids = ocrTagMatchRepo.pairIdsPage(afterId, RECOUNT_CHUNK);

            if (ids.length === 0) {
                break;
            }

            recounted += ocrTagMatchRepo.recountPending(ids);
            afterId = ids[ids.length - 1];
            since = await breathe(since);
        }

        // Whatever a rule is still owed: an apply the web could not finish because the database
        // was busy, or text read while the worker that matched it was stopping.
        const applied = ocrTagMatchRepo.applyRules(ocrTagMatchRepo.acceptedPairIds());

        ocrTagMatchRepo.recountPending(
            ocrTagMatchRepo.pairsTouching(applied.mediaIds, applied.tagIds)
        );

        lastFingerprint = fingerprint;

        console.log(
            `Matched ${matched} OCR string(s) against ${vocabulary.length} name(s); ` +
                `${recounted} pending count(s) corrected; ` +
                `${applied.mediaIds.length} item(s) tagged by rules`
        );
    }
};
