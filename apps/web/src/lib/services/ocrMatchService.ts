import {
    ConflictError,
    NotFoundError,
    correctedText,
    normalizeText,
    type OcrChangeResult,
    type OcrCounts,
    type OcrMatchCandidate,
    type OcrMatchDecideInput,
    type OcrMatchItem,
    type OcrMatchItemPage,
    type OcrMatchItemsQuery,
    type OcrMatchManualInput,
    type OcrMatchPage,
    type OcrMatchQuery,
    type OcrMatchResult,
    type OcrMatchRow,
    type OcrQueueAcceptInput,
    type OcrQueueItem,
    type OcrQueuePage,
    type OcrQueueQuery,
    type OcrQueueSkipInput,
    type OcrQueueString,
    type OcrRuleTag,
    type OcrRuleTagPage,
    type OcrRuleTagQuery,
    type OcrRuleTagUndoInput,
} from "@private-stock/core";
import {
    artifactRepo,
    db,
    mediaTextRepo,
    ocrTagMatchRepo,
    searchRepo,
    tagBatchRepo,
    tagRepo,
} from "@private-stock/db";

import type { AuthContext } from "../auth/withAuth";
import { coverUrl } from "./artService";
import { undoBulkTag } from "./bulkTagService";
import { notThem } from "./notThem";
import { recountAfterCommit, tagsChangedOn, vocabularyChanged } from "./ocrMatchHooks";
import {
    decodeCursor,
    encodeCursor,
    fileNameOf,
    frameFinder,
    isItemCursor,
    isStringCursor,
    requireAdmin,
} from "./ocrReviewService";

/**
 * Tagging performers and sources from what OCR read (§5d "Tagging performers and sources from
 * what was read").
 *
 * The queue is items, newest first. A decision is about a pair — this string, that tag — and an
 * accepted pair is a rule: it tags every item the string was read on, and the worker applies it
 * to every item the string is read on afterwards (§5d "An accepted pair is a rule").
 *
 * **Admin only**, like the rest of the OCR review: an accept tags items for everybody, in the
 * library's vocabulary.
 */

const coverOf = (mediaId: string): string | null => {
    const cover = artifactRepo.findEffectiveCover(mediaId);

    return cover ? coverUrl(mediaId, cover.relPath, cover.generatedAt) : null;
};

const boxOf = (row: {
    boxX: number | null;
    boxY: number | null;
    boxW: number | null;
    boxH: number | null;
}): OcrQueueString["box"] =>
    row.boxX === null || row.boxY === null || row.boxW === null || row.boxH === null
        ? null
        : { x: row.boxX, y: row.boxY, w: row.boxW, h: row.boxH };

const toCandidate =
    (text: string) =>
    (row: ocrTagMatchRepo.CandidateRow): OcrMatchCandidate => ({
        matchId: row.id,
        tagId: row.tagId,
        tagName: row.tagName,
        tagKind: row.tagKind,
        kind: row.kind,
        matchedText: row.matchedText,
        state: row.state,
        untagged: row.untagged,
        correctedText: row.kind === "near" ? correctedText(text, row, row.tagName) : null,
    });

const sampleOf = (textNorm: string): OcrMatchRow["sample"] => {
    const found = ocrTagMatchRepo.sampleFinding(textNorm);

    if (!found) {
        return null;
    }

    return {
        mediaId: found.mediaId,
        coverUrl: coverOf(found.mediaId),
        frame: found.kind === "video" ? frameFinder(found.mediaId)(found.firstAtMs) : null,
        box: boxOf(found),
        atMs: found.firstAtMs,
    };
};

const isQueueCursor = (value: unknown): value is ocrTagMatchRepo.QueueCursor =>
    typeof value === "object" &&
    value !== null &&
    "at" in value &&
    typeof value.at === "string" &&
    "mediaId" in value &&
    typeof value.mediaId === "string";

const isRuleTagCursor = (value: unknown): value is ocrTagMatchRepo.RuleTagCursor =>
    typeof value === "object" &&
    value !== null &&
    "at" in value &&
    typeof value.at === "string" &&
    "id" in value &&
    typeof value.id === "string";

export const countQueue = (auth: AuthContext): OcrCounts => {
    requireAdmin(auth);

    return { waiting: ocrTagMatchRepo.countItemQueue(auth.accessibleRootIds) };
};

/**
 * The queue: items whose text names a performer or source nobody has decided about, most
 * recently matched first, each with its strings and the pairs they name.
 */
export const listQueue = (query: OcrQueueQuery, auth: AuthContext): OcrQueuePage => {
    requireAdmin(auth);

    const page = ocrTagMatchRepo.listItemQueue({
        rootIds: auth.accessibleRootIds,
        after: decodeCursor(query.after, isQueueCursor),
        limit: query.limit,
        media: query.media,
    });
    const mediaIds = page.rows.map((row) => row.mediaId);
    const candidates = ocrTagMatchRepo.itemCandidates(mediaIds);
    const heads = new Map(mediaTextRepo.listItemHeads(mediaIds).map((head) => [head.id, head]));

    const items = page.rows.flatMap((row): OcrQueueItem[] => {
        const head = heads.get(row.mediaId);
        const own = candidates.filter((candidate) => candidate.mediaId === row.mediaId);

        if (!head || own.length === 0) {
            return [];
        }

        const frameAt = head.kind === "video" ? frameFinder(row.mediaId) : () => null;
        const strings = new Map<string, OcrQueueString>();

        for (const candidate of own) {
            const string = strings.get(candidate.textNorm) ?? {
                textNorm: candidate.textNorm,
                text: candidate.text,
                frame: frameAt(candidate.firstAtMs),
                box: boxOf(candidate),
                atMs: candidate.firstAtMs,
                candidates: [],
            };

            string.candidates.push({
                matchId: candidate.id,
                tagId: candidate.tagId,
                tagName: candidate.tagName,
                tagKind: candidate.tagKind,
                kind: candidate.kind,
                matchedText: candidate.matchedText,
                state: null,
                untagged: candidate.untagged,
                correctedText:
                    candidate.kind === "near"
                        ? correctedText(candidate.text, candidate, candidate.tagName)
                        : null,
            });
            strings.set(candidate.textNorm, string);
        }

        const fileName = fileNameOf(head.listRelPath);

        return [
            {
                mediaId: row.mediaId,
                kind: head.kind,
                title: head.title ?? fileName,
                fileName,
                coverUrl: coverOf(row.mediaId),
                matchedAt: row.matchedAt,
                newName: own.every((candidate) => candidate.newName === 1),
                strings: [...strings.values()],
            },
        ];
    });

    return { items, next: page.next ? encodeCursor(page.next) : null };
};

/** The Rules list: strings with a decided pair, most-read first. */
export const listMatches = (query: OcrMatchQuery, auth: AuthContext): OcrMatchPage => {
    requireAdmin(auth);

    const page = ocrTagMatchRepo.listQueue({
        status: query.status,
        search: query.search,
        after: decodeCursor(query.after, isStringCursor),
        limit: query.limit,
    });
    const candidates = ocrTagMatchRepo.candidatesFor(page.rows.map((row) => row.textNorm));

    const rows = page.rows.map((row): OcrMatchRow => ({
        textNorm: row.textNorm,
        text: row.text,
        rowCount: row.rowCount,
        sample: sampleOf(row.textNorm),
        candidates: candidates
            .filter((candidate) => candidate.textNorm === row.textNorm)
            .map(toCandidate(row.text)),
    }));

    return { rows, next: page.next ? encodeCursor(page.next) : null };
};

/** The items one string was read on, each saying which of the string's tags it carries. */
export const listMatchItems = (query: OcrMatchItemsQuery, auth: AuthContext): OcrMatchItemPage => {
    requireAdmin(auth);

    const page = mediaTextRepo.listItemIds({
        rootIds: auth.accessibleRootIds,
        textNorm: query.textNorm,
        after: decodeCursor(query.after, isItemCursor),
        limit: query.limit,
    });
    const pairs = ocrTagMatchRepo.candidatesFor([query.textNorm]);
    const tagged = ocrTagMatchRepo.taggedPairs(
        page.ids,
        pairs.map((pair) => pair.tagId)
    );
    const skipped = ocrTagMatchRepo.skippedPairs(
        page.ids,
        pairs.map((pair) => pair.id)
    );
    const heads = new Map(mediaTextRepo.listItemHeads(page.ids).map((head) => [head.id, head]));
    const findings = mediaTextRepo.listForMediaIds(page.ids, {
        status: "all",
        textNorm: query.textNorm,
    });

    const items = page.ids.flatMap((mediaId): OcrMatchItem[] => {
        const head = heads.get(mediaId);

        if (!head) {
            return [];
        }

        const finding = findings.find((row) => row.mediaId === mediaId);
        const atMs = finding?.firstAtMs ?? null;
        const fileName = fileNameOf(head.listRelPath);

        return [
            {
                mediaId,
                kind: head.kind,
                title: head.title ?? fileName,
                fileName,
                coverUrl: coverOf(mediaId),
                frame: head.kind === "video" ? frameFinder(mediaId)(atMs) : null,
                box: finding?.box ?? null,
                atMs,
                taggedWith: pairs
                    .filter((pair) => tagged.has(`${mediaId}:${pair.tagId}`))
                    .map((pair) => pair.tagId),
                skippedFrom: pairs
                    .filter((pair) => skipped.has(`${mediaId}:${pair.id}`))
                    .map((pair) => pair.id),
            },
        ];
    });

    return { items, next: page.next ? encodeCursor(page.next) : null };
};

const gone = (): NotFoundError =>
    new NotFoundError("That match is no longer there. Reload the list.");

/** These pairs as they stand, every one still waiting for a decision, or a 404. */
const openPairs = (matchIds: string[]): ocrTagMatchRepo.CandidateRow[] =>
    [...new Set(matchIds)].map((id) => {
        const pair = ocrTagMatchRepo.findById(id);

        if (!pair || pair.state !== null) {
            throw gone();
        }

        return pair;
    });

/** The same pairs without counts: for inside a transaction, where a count is pages under the lock. */
const pairIdsFor = (textNorm: string, tagIds: string[]): Array<{ id: string; tagId: string }> => {
    const unique = [...new Set(tagIds)];
    const pairs = ocrTagMatchRepo.findPairIds(textNorm, unique);

    if (pairs.length !== unique.length) {
        throw gone();
    }

    return pairs;
};

const describe = (text: string, pairs: ocrTagMatchRepo.CandidateRow[], count: number): string =>
    `Tagged ${count} item(s) from OCR "${text}": ${pairs
        .map((pair) => `${pair.tagName} (${pair.tagKind})`)
        .join(", ")}`.slice(0, 500);

/**
 * Accept some of one string's pairs: each tag goes to every item that shows the string and does
 * not carry it yet, less the items left out, as one batch; and the pairs become rules.
 *
 * A misreading is corrected first (§5d "A misreading is corrected, not aliased"), through the same
 * edit the details drawer makes, so the string's findings move to the corrected text and search
 * is fixed along with the tags. Which items get tagged is settled *before* that: the corrected
 * string may already exist with items of its own, and those are not the ones that were shown.
 *
 * The decision is one transaction; the pending counts it moves are recounted after it commits
 * (§5d "Counts"). Inside, that recount read pages while holding the write lock, and a run of
 * accepts froze the site.
 */
const acceptString = (
    textNorm: string,
    pairs: ocrTagMatchRepo.CandidateRow[],
    excluded: Set<string>,
    auth: AuthContext
): OcrMatchResult => {
    const owed = pairs.map((pair) => {
        const pending = ocrTagMatchRepo.pendingMediaIds(pair.id);

        return {
            pair,
            tag: pending.filter((mediaId) => !excluded.has(mediaId)),
            skip: pending.filter((mediaId) => excluded.has(mediaId)),
        };
    });

    const text = ocrTagMatchRepo.stringText(textNorm) ?? textNorm;
    const near = pairs.filter((pair) => pair.kind === "near");
    const corrected = near.reduce(
        (current, pair) => correctedText(current, pair, pair.tagName),
        text
    );

    const { result, recount } = db.transaction(
        (): { result: OcrMatchResult; recount: string[] } => {
            let now = textNorm;
            let decided: Array<{ id: string; tagId: string }> = pairs;
            const rematched: string[] = [];

            if (near.length > 0 && corrected !== text) {
                const rows = mediaTextRepo.scopeStrings([textNorm], "edit");

                mediaTextRepo.editText(
                    rows.map((row) => row.id),
                    corrected,
                    auth.userId
                );
                searchRepo.requestReindex([...new Set(rows.map((row) => row.mediaId))]);

                now = normalizeText(corrected);
                rematched.push(...ocrTagMatchRepo.matchStrings([textNorm, now]));

                // The corrected string names the tag outright now; if the matcher somehow does
                // not agree, the decision stands as one made by hand.
                for (const pair of pairs) {
                    ocrTagMatchRepo.ensureManual(now, pair.tagId, corrected);
                }

                decided = pairIdsFor(
                    now,
                    pairs.map((pair) => pair.tagId)
                );
            }

            const assignments = owed.flatMap(({ pair, tag }) =>
                tag.map((mediaId) => ({ mediaId, tagId: pair.tagId }))
            );
            const mediaIds = [...new Set(assignments.map(({ mediaId }) => mediaId))];
            const { batchId, assigned } = tagBatchRepo.applyAssignments({
                userId: auth.userId,
                scope: null,
                summary: describe(corrected, pairs, mediaIds.length),
                assignments,
            });

            for (const { pair, skip } of owed) {
                const pairNow = decided.find((row) => row.tagId === pair.tagId);

                if (pairNow && skip.length > 0) {
                    ocrTagMatchRepo.addSkips(pairNow.id, skip);
                }
            }

            ocrTagMatchRepo.decide(
                decided.map((pair) => pair.id),
                "accepted",
                auth.userId,
                batchId
            );
            searchRepo.requestReindex(mediaIds);

            return {
                result: { tagged: assigned, mediaIds, textNorm: now },
                recount: [...rematched, ...decided.map((pair) => pair.id)],
            };
        }
    )();

    // Every pair this can have moved: the decided ones (tagged and skipped), the rematched
    // strings' after a correction, and the same tags' pairs for other strings on these items.
    recountAfterCommit([
        ...recount,
        ...ocrTagMatchRepo.pairsTouching(
            result.mediaIds,
            pairs.map((pair) => pair.tagId)
        ),
    ]);

    return result;
};

/**
 * Accept pairs from one item's row. Each string's pairs are accepted as their own batch, as they
 * always were, so that withdrawing one rule from the Rules list leaves the other.
 *
 * The count is checked across all of them first: the row said how many items one click tags,
 * and OCR may have read a string on more since (§5d "A whole-string accept carries the item
 * count it was shown").
 */
export const acceptOnItem = (input: OcrQueueAcceptInput, auth: AuthContext): OcrMatchResult => {
    requireAdmin(auth);

    const pairs = openPairs(input.matchIds);
    const shown = pairs.reduce((sum, pair) => sum + pair.untagged, 0);

    if (shown !== input.expectedCount) {
        throw new ConflictError(
            `This text has been read on more items since the page loaded (${shown} to tag ` +
                `now, ${input.expectedCount} shown). Reload and check them again.`
        );
    }

    // The row's own item is the one the reviewer looked at; it cannot be left out of itself.
    const excluded = new Set(input.excludeMediaIds.filter((id) => id !== input.mediaId));
    const strings = [...new Set(pairs.map((pair) => pair.textNorm))];
    const results = strings.map((textNorm) =>
        acceptString(
            textNorm,
            pairs.filter((pair) => pair.textNorm === textNorm),
            excluded,
            auth
        )
    );

    return {
        tagged: results.reduce((sum, result) => sum + result.tagged, 0),
        mediaIds: [...new Set(results.flatMap((result) => result.mediaIds))],
        textNorm: results[0]?.textNorm ?? "",
    };
};

/** Not on this item. The pairs stay open for the other items showing their strings. */
export const skipOnItem = (input: OcrQueueSkipInput, auth: AuthContext): OcrMatchResult => {
    requireAdmin(auth);

    const pairs = openPairs(input.matchIds);

    db.transaction(() => {
        for (const pair of pairs) {
            ocrTagMatchRepo.addSkips(pair.id, [input.mediaId]);
        }
    })();

    recountAfterCommit(pairs.map((pair) => pair.id));

    return { tagged: 0, mediaIds: [], textNorm: pairs[0].textNorm };
};

const textNormOf = (matchIds: string[]): string => {
    const first = ocrTagMatchRepo.findById(matchIds[0]);

    if (!first) {
        throw gone();
    }

    return first.textNorm;
};

/** This string does not name this tag. Remembered, so the pair never comes back. */
export const reject = (input: OcrMatchDecideInput, auth: AuthContext): OcrMatchResult => {
    requireAdmin(auth);

    const textNorm = textNormOf(input.matchIds);

    // No count moves: a pair's count is its owed items, whatever was decided about it. The queue
    // leaves it out by its state.
    ocrTagMatchRepo.decide(input.matchIds, "rejected", auth.userId);

    return { tagged: 0, mediaIds: [], textNorm };
};

/**
 * Take a decision back. A rejection is simply forgotten. An accept is withdrawn whole: its batch,
 * which takes off what the person accepted and reopens every pair that batch accepted, and the
 * tags its rule applied since. Another rule for the same tag may still name those items, and
 * applies again.
 */
export const undo = (input: OcrMatchDecideInput, auth: AuthContext): OcrMatchResult => {
    requireAdmin(auth);

    const textNorm = textNormOf(input.matchIds);
    const pairs = input.matchIds.flatMap((id) => ocrTagMatchRepo.findById(id) ?? []);
    const accepted = pairs.filter((pair) => pair.state === "accepted");
    const batches = new Set(accepted.flatMap((pair) => (pair.batchId ? [pair.batchId] : [])));
    const mediaIds: string[] = [];

    for (const batchId of batches) {
        mediaIds.push(...tagBatchRepo.affectedMediaIds(batchId));

        try {
            undoBulkTag(batchId, auth);
        } catch (error) {
            // Withdrawn already, from the bulk history: the pair only needs reopening.
            if (!(error instanceof ConflictError)) {
                throw error;
            }
        }
    }

    const withdrawn = db.transaction(() => {
        const removed = accepted.flatMap((pair) => ocrTagMatchRepo.withdrawRuleTags(pair.id));

        searchRepo.requestReindex([...new Set(removed)]);

        return removed;
    })();

    // A withdrawn batch recounted its own pairs (`batchUndone`); a reopened rejection's count
    // was kept up to date while it was rejected, and is checked here all the same.
    const reopened = ocrTagMatchRepo.reopen(pairs.map((pair) => pair.id));
    const touched = ocrTagMatchRepo.pairsTouching(
        withdrawn,
        accepted.map((pair) => pair.tagId)
    );
    const reapplied = ocrTagMatchRepo.applyRules(touched);

    recountAfterCommit([
        ...reopened,
        ...touched,
        ...ocrTagMatchRepo.pairsTouching(reapplied.mediaIds, reapplied.tagIds),
    ]);

    return { tagged: 0, mediaIds: [...new Set([...mediaIds, ...withdrawn])], textNorm };
};

/**
 * File the string under a performer or source the matcher did not propose: named, or coined.
 *
 * The pair is created undecided rather than accepted, so the next click is an ordinary accept
 * with its count on the chip. Tagging items under a pair whose count nobody has seen is what
 * the count on every accept exists to prevent.
 */
export const manual = (input: OcrMatchManualInput, auth: AuthContext): OcrMatchResult => {
    requireAdmin(auth);

    const text = ocrTagMatchRepo.stringText(input.textNorm);

    if (text === undefined) {
        throw new NotFoundError("That string is no longer there. Reload the list.");
    }

    const coins = !tagRepo.resolveName(input.kind, input.name, null);

    const tagId = db.transaction(() => {
        const ensured = tagRepo.ensureTag(input.kind, input.name, null, auth.userId);

        ocrTagMatchRepo.ensureManual(input.textNorm, ensured, text);

        if (input.replaceMatchId) {
            ocrTagMatchRepo.decide([input.replaceMatchId], "rejected", auth.userId);
        }

        return ensured;
    })();

    // The new pair's count, which is what its accept will be checked against.
    recountAfterCommit(ocrTagMatchRepo.findPairIds(input.textNorm, [tagId]).map((pair) => pair.id));

    if (coins) {
        vocabularyChanged(input.kind, null);
    }

    return { tagged: 0, mediaIds: [], textNorm: input.textNorm };
};

/** What rules tagged, newest first: the log an administrator checks the automation against. */
export const listRuleTags = (query: OcrRuleTagQuery, auth: AuthContext): OcrRuleTagPage => {
    requireAdmin(auth);

    const page = ocrTagMatchRepo.listRuleTags({
        rootIds: auth.accessibleRootIds,
        after: decodeCursor(query.after, isRuleTagCursor),
        limit: query.limit,
    });
    const heads = new Map(
        mediaTextRepo
            .listItemHeads([...new Set(page.rows.map((row) => row.mediaId))])
            .map((head) => [head.id, head])
    );

    const rows = page.rows.flatMap((row): OcrRuleTag[] => {
        const head = heads.get(row.mediaId);

        if (!head) {
            return [];
        }

        const found = ocrTagMatchRepo.ruleFinding(row.mediaId, row.tagId);
        const atMs = found?.firstAtMs ?? null;
        const fileName = fileNameOf(head.listRelPath);

        return [
            {
                id: row.id,
                mediaId: row.mediaId,
                kind: head.kind,
                title: head.title ?? fileName,
                fileName,
                coverUrl: coverOf(row.mediaId),
                frame: head.kind === "video" ? frameFinder(row.mediaId)(atMs) : null,
                box: found ? boxOf(found) : null,
                atMs,
                text: found?.text ?? null,
                tagId: row.tagId,
                tagName: row.tagName,
                tagKind: row.tagKind,
                createdAt: row.createdAt,
            },
        ];
    });

    return { rows, next: page.next ? encodeCursor(page.next) : null };
};

/**
 * Take a rule's tag off its item. The same as taking it off in the item's own tags: the rule is
 * declined for that item, so reading it again does not put the tag back.
 */
export const undoRuleTag = (input: OcrRuleTagUndoInput, auth: AuthContext): OcrChangeResult => {
    requireAdmin(auth);

    const row = ocrTagMatchRepo.findRuleTag(input.id);

    if (!row) {
        throw new NotFoundError("That tag has already been taken off. Reload the list.");
    }

    const removed = db.transaction(() => {
        const count = tagRepo.unassign(row.mediaId, row.tagId, null);

        if (count > 0) notThem([row.mediaId], row.tagId, auth.userId);

        searchRepo.requestReindex([row.mediaId]);

        return count;
    })();

    tagsChangedOn([row.mediaId], row.tagKind, null, [row.tagId]);

    return { updated: removed, mediaIds: [row.mediaId] };
};
