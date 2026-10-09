import { createHash } from "node:crypto";

import {
    buildTagMatcher,
    mentionsIn,
    type TagMatcher,
    type TagNameEntry,
} from "@private-stock/core";
import { mentionRepo } from "@private-stock/db";

import { breathe } from "../eventLoop.js";

/**
 * Which tags each item's own text names (§5b "One rule for names").
 *
 * Two writers of `MediaMention`, one matcher:
 *
 * - **The index stage**, for one item, whenever it rebuilds that item's search document — its
 *   name, title or on-screen text may have changed (`mentionsForItem`).
 * - **This job**, for the whole library, whenever the vocabulary changes: a new name, alias,
 *   rename or merge can make every item name a tag it did not. The web enqueues it, held back a
 *   few seconds so a burst of names is one run, and it does nothing when the vocabulary is the one
 *   it last matched against. It also runs once after startup.
 *
 * Nothing holds the write lock while it reads: documents are read and matched outside any
 * transaction, and only items whose mentions changed are written (`mentionRepo.writeChanged`).
 */

/** Documents matched per pass between breaths. */
const CHUNK = 500;

/**
 * How long a matcher is trusted before the vocabulary is read again for the index stage.
 *
 * The index stage runs once per item and a bulk reindex runs it for the whole library; reading the
 * vocabulary for each would be most of its work. A name coined inside the window reaches the items
 * indexed after it a minute late at most — and every item anyway, through this job's rematch.
 */
const MATCHER_TTL_MS = 60_000;

const fingerprintOf = (vocabulary: TagNameEntry[]): string =>
    createHash("sha256")
        .update(vocabulary.map((entry) => `${entry.tagId}\t${entry.name}`).join("\n"))
        .digest("hex");

let cached: { loadedAt: number; matcher: TagMatcher } | null = null;

/** The tags an item's text names, by field, with a matcher at most a minute old. */
export const mentionsForItem = (texts: Parameters<typeof mentionsIn>[0]) => {
    if (!cached || Date.now() - cached.loadedAt > MATCHER_TTL_MS) {
        cached = { loadedAt: Date.now(), matcher: buildTagMatcher(mentionRepo.vocabulary()) };
    }

    return mentionsIn(texts, cached.matcher);
};

/** The vocabulary this process last matched the whole library against. */
let lastFingerprint: string | null = null;

export const runMentionMatch = async (): Promise<void> => {
    let since = Date.now();

    // Until the vocabulary holds still: a name coined while a run is under way finds this job
    // claimed, so the web queues nothing, and the run itself is what has to notice.
    for (;;) {
        const vocabulary = mentionRepo.vocabulary();
        const fingerprint = fingerprintOf(vocabulary);

        if (fingerprint === lastFingerprint) {
            return;
        }

        const matcher = buildTagMatcher(vocabulary);
        let cursor = 0;
        let read = 0;
        let written = 0;

        for (;;) {
            const documents = mentionRepo.documentsAfter(cursor, CHUNK);

            if (documents.length === 0) {
                break;
            }

            written += mentionRepo.writeChanged(
                documents.map((document) => ({
                    mediaId: document.mediaId,
                    mentions: mentionsIn(document.texts, matcher),
                }))
            );
            read += documents.length;
            cursor = documents[documents.length - 1].cursor;
            since = await breathe(since);
        }

        lastFingerprint = fingerprint;
        // The index stage's matcher follows the same vocabulary from now on.
        cached = { loadedAt: Date.now(), matcher };

        console.log(
            `Matched ${read} item(s) against ${vocabulary.length} tag name(s); ` +
                `${written} item(s) name different tags than before`
        );
    }
};
