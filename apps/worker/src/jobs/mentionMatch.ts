import { createHash } from "node:crypto";

import {
    buildTagMatcher,
    domainKinds,
    mentionsIn,
    parseDomain,
    type DomainKind,
    type TagMatcher,
    type TagNameEntry,
} from "@private-stock/core";
import { mentionRepo } from "@private-stock/db";

import { breathe } from "../eventLoop.js";

/**
 * Which tags each item's own text names (§5b "One rule for names").
 *
 * Two writers of `MediaMention`, one matcher per room:
 *
 * - **The index stage**, for one item, whenever it rebuilds that item's search document — its
 *   name, title or on-screen text may have changed (`mentionsForItem`).
 * - **This job**, for the whole library, whenever the vocabulary changes: a new name, alias,
 *   rename or merge can make every item name a tag it did not. The web enqueues it, held back a
 *   few seconds so a burst of names is one run, and it does nothing when the vocabulary is the one
 *   it last matched against. It also runs once after startup.
 *
 * **Each item is matched against its own room's names only** (§21): a Parlour filename that
 * happens to spell a Cellar performer names nobody. An item no library claims is in no room and
 * names nothing.
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

const fingerprintOf = (vocabularies: Map<DomainKind, TagNameEntry[]>): string =>
    createHash("sha256")
        .update(
            [...vocabularies]
                .map(
                    ([domain, vocabulary]) =>
                        `${domain}\n${vocabulary.map((entry) => `${entry.tagId}\t${entry.name}`).join("\n")}`
                )
                .join("\n\n")
        )
        .digest("hex");

const readVocabularies = (): Map<DomainKind, TagNameEntry[]> =>
    new Map(domainKinds.map((domain) => [domain, mentionRepo.vocabulary(domain)]));

const cached = new Map<DomainKind, { loadedAt: number; matcher: TagMatcher }>();

/**
 * The tags an item's text names, by field, with its room's matcher at most a minute old. An item
 * in no room names nothing.
 */
export const mentionsForItem = (
    texts: Parameters<typeof mentionsIn>[0],
    domain: string | null
): ReturnType<typeof mentionsIn> => {
    const room = parseDomain(domain);

    if (!room) {
        return [];
    }

    let entry = cached.get(room);

    if (!entry || Date.now() - entry.loadedAt > MATCHER_TTL_MS) {
        entry = { loadedAt: Date.now(), matcher: buildTagMatcher(mentionRepo.vocabulary(room)) };
        cached.set(room, entry);
    }

    return mentionsIn(texts, entry.matcher);
};

/** The vocabulary this process last matched the whole library against. */
let lastFingerprint: string | null = null;

export const runMentionMatch = async (): Promise<void> => {
    let since = Date.now();

    // Until the vocabulary holds still: a name coined while a run is under way finds this job
    // claimed, so the web queues nothing, and the run itself is what has to notice.
    for (;;) {
        const vocabularies = readVocabularies();
        const fingerprint = fingerprintOf(vocabularies);

        if (fingerprint === lastFingerprint) {
            return;
        }

        const matchers = new Map(
            [...vocabularies].map(([domain, vocabulary]) => [domain, buildTagMatcher(vocabulary)])
        );
        let cursor = 0;
        let read = 0;
        let written = 0;

        for (;;) {
            const documents = mentionRepo.documentsAfter(cursor, CHUNK);

            if (documents.length === 0) {
                break;
            }

            written += mentionRepo.writeChanged(
                documents.map((document) => {
                    const room = parseDomain(document.domain);
                    const matcher = room ? matchers.get(room) : undefined;

                    return {
                        mediaId: document.mediaId,
                        mentions: matcher ? mentionsIn(document.texts, matcher) : [],
                    };
                })
            );
            read += documents.length;
            cursor = documents[documents.length - 1].cursor;
            since = await breathe(since);
        }

        lastFingerprint = fingerprint;

        // The index stage's matchers follow the same vocabulary from now on.
        for (const [domain, matcher] of matchers) {
            cached.set(domain, { loadedAt: Date.now(), matcher });
        }

        const names = [...vocabularies.values()].reduce((sum, list) => sum + list.length, 0);

        console.log(
            `Matched ${read} item(s) against ${names} tag name(s); ` +
                `${written} item(s) name different tags than before`
        );
    }
};
