import * as path from "node:path";

import { expandCompounds, searchVariants, type MediaAttribute } from "@private-stock/core";
import {
    db,
    mediaAttributeRepo,
    mediaTextRepo,
    mentionRepo,
    searchRepo,
    tagRepo,
} from "@private-stock/db";

import type { JobRow } from "../queue.js";

import { mentionsForItem } from "./mentionMatch.js";

/**
 * The `index` job: assembling one item's search document (§5c).
 *
 * A worker stage rather than SQL triggers, for three reasons. The document is built from six
 * tables, and a trigger would have to fire correctly on every one of them. A stage is
 * re-runnable, so changing the recipe is a version bump and a backfill rather than a
 * migration. And it runs off the request path — tagging fifty items in a bulk action marks
 * fifty documents stale in microseconds, and the rebuilding happens here.
 */

/**
 * The recipe version lives in the stage registry (§7b).
 *
 * Raising `index`'s version there re-indexes the library gradually through the ordinary job
 * queue — the same mechanism every capability uses, which is the point of having one.
 */

interface DocumentSourceRow {
    id: string;
    title: string | null;
    relPath: string | null;
}

/**
 * Filename text, as words.
 *
 * Scene filenames are the single most information-dense field in a library like this, and
 * they are almost never spaces-and-words: `Studio.Name.2019.1080p.x264-GROUP.mp4` tokenizes
 * to one useless term if the separators are left alone. Splitting them turns the filename
 * into the terms people actually search for.
 *
 * The directory path is kept as well as the basename, because a library organised into
 * folders has real information in those folder names — often the studio or series that
 * nothing else has recorded yet.
 *
 * The extension is dropped: every video matching "mp4" is not a useful search result, and
 * including it makes the extension a common term that dilutes ranking for everything else.
 *
 * One string per folder and one for the file, rather than one for the path, for the glued
 * spellings (§5c "Word boundaries"), which pair adjacent words: the last word of a folder and
 * the first of the filename were never written side by side.
 */
export const filenameSegments = (relPath: string | null): string[] => {
    if (!relPath) {
        return [];
    }

    const withoutExtension = relPath.slice(0, relPath.length - path.extname(relPath).length);

    return withoutExtension
        .split(/[\\/]/)
        .map((segment) =>
            segment
                .replace(/[._\-[\]()]+/g, " ")
                .replace(/\s+/g, " ")
                .trim()
        )
        .filter(Boolean);
};

/**
 * Tags, split by facet.
 *
 * Performers get a document column of their own so BM25 can weight a name separately;
 * everything else — generic tags, sources, and whatever a scraper invented — lands in
 * `tags`. `series` and `studio` had columns until the facets were cut back to three (§5b),
 * and splitting what is left into more columns would only give BM25 less text in each.
 *
 * A name may appear in both columns, which is correct: a performer also tagged by name is
 * both, and the item should be found either way.
 *
 * Only library-wide assignments are indexed. One shared index cannot hold per-user text
 * without leaking it into other people's results.
 *
 * A tag's aliases go in beside its name, in the same column (§5b "Aliases"): searching the
 * maiden name finds what was filed under the married one, and ranks it as a performer match
 * rather than as loose text.
 */
const tagText = (mediaId: string): { performers: string[]; tags: string[] } => {
    const assigned = tagRepo.listForMedia(mediaId, null);
    const aliases = tagRepo.aliasesByTag(assigned.map((tag) => tag.tagId));

    const names = (include: (kind: string) => boolean): string[] =>
        assigned
            .filter((tag) => include(tag.kind))
            .flatMap((tag) => [tag.name, ...(aliases.get(tag.tagId) ?? [])]);

    return {
        performers: names((kind) => kind === "performer"),
        tags: names((kind) => kind !== "performer"),
    };
};

/**
 * The library's tag names, squashed, for `searchVariants` to find inside glued words.
 *
 * Cached, because the index stage runs once per item and a bulk reindex runs it two hundred
 * thousand times; reading the vocabulary for each would be most of the stage's work. A minute is
 * long enough to make that a rounding error and short enough that a tag created during a scan
 * reaches the items indexed after it. Items indexed *before* a tag existed are not revisited for
 * it: they are still found by the name's words, and only the glued spelling waits for the item's
 * next reindex.
 */
const VOCABULARY_TTL_MS = 60_000;
let vocabulary: { loadedAt: number; names: Map<string, string> } | null = null;

const nameVocabulary = (): Map<string, string> => {
    if (!vocabulary || Date.now() - vocabulary.loadedAt > VOCABULARY_TTL_MS) {
        vocabulary = { loadedAt: Date.now(), names: tagRepo.publicNameVocabulary() };
    }

    return vocabulary.names;
};

/**
 * Scraped long-tail fields (§5b).
 *
 * Keys as well as values, so searching "director" finds items that have one. This column
 * carries the lowest BM25 weight precisely because it is the least curated text in the
 * document and would otherwise let a verbose description outrank a title.
 */
const attributeText = (attributes: MediaAttribute[]): string =>
    attributes.map((row) => `${row.key} ${row.value}`).join(" ");

/**
 * Text read out of the picture, joined into one field (§5d).
 *
 * Every stored finding, not only the confident ones: the floor that decides whether a finding
 * is worth keeping was already applied when the rows were written, and applying a second one
 * here would mean the details panel and the search index disagreed about what was found —
 * somebody would read a string off the panel, search for it, and get nothing.
 *
 * Joined with spaces and nothing else. The order carries no meaning to FTS5, and a separator
 * would become a token: the tokenizer splits on punctuation anyway, so anything added here is
 * either invisible or noise.
 */
const ocrText = (mediaId: string): string =>
    mediaTextRepo
        .listForMedia(mediaId)
        .map((finding) => finding.text)
        .join(" ");

/** Builds and stores the document for one item. */
export const indexMedia = (mediaId: string): void => {
    const row = db
        .prepare(
            `SELECT m."id", m."title", f."relPath"
               FROM "Media" m
               LEFT JOIN "MediaFileLink" fl
                      ON fl."mediaId" = m."id" AND fl."role" = 'original'
               LEFT JOIN "MediaFile" f ON f."id" = fl."fileId"
              WHERE m."id" = ?`
        )
        .get(mediaId) as DocumentSourceRow | undefined;

    if (!row) {
        // The item was deleted between the job being queued and being claimed. The cascade
        // has already removed any document, so there is nothing to clean up.
        return;
    }

    const tags = tagText(mediaId);
    const segments = filenameSegments(row.relPath);
    const title = row.title ?? "";

    const variants = searchVariants(
        {
            phrases: [...segments, title, ...tags.performers, ...tags.tags],
            // Tag names were typed by somebody choosing a name; filenames and titles are where
            // names arrive glued.
            messy: [...segments, title],
        },
        nameVocabulary()
    );

    /**
     * Read before the transaction, never as arguments inside it. A deferred transaction that
     * reads first takes the write lock at its first write, and SQLite refuses that upgrade
     * outright -- no busy wait -- when the web process committed in between; on the NAS these
     * reads are slow enough that a sign-in or a tag save landed in the gap often (§4, §20).
     */
    const attributeRows = mediaAttributeRepo.listForMedia(mediaId);
    const attributes = attributeText(attributeRows);
    // The values alone, in key order, joined as the library-wide rematch joins them
    // (`mentionRepo.documentsAfter`): two writers of one item's mentions must read one text.
    const metadata = attributeRows.map((row) => row.value).join(" ");
    const ocr = ocrText(mediaId);
    const filename = expandCompounds(segments.join(" "));
    const expandedTitle = expandCompounds(title);

    // The stage row is written by the job runner once this returns, so the document is the
    // only thing to store here.
    db.transaction(() => {
        searchRepo.upsertDocument({
            mediaId,
            // Curated text with each compound word's parts beside it (§5c "Word boundaries"):
            // `AuntMargaret` is indexed as itself and as `Aunt Margaret`, in its own column,
            // so "margaret" finds it at a title's weight rather than a variant's.
            filename,
            title: expandedTitle,
            performers: expandCompounds(tags.performers.join(" ")),
            tags: expandCompounds(tags.tags.join(" ")),
            attributes,
            notes: "",
            ocr,
            variants,
        });
    })();

    // What the same text names, by the one name rule (§5b): read and matched outside the
    // document's transaction, written only if it changed.
    mentionRepo.writeChanged([
        {
            mediaId,
            mentions: mentionsForItem({ filename, title: expandedTitle, screen: ocr, metadata }),
        },
    ]);
};

export const runIndex = async (job: JobRow): Promise<void> => {
    if (!job.mediaId) {
        throw new Error("index job requires a mediaId");
    }

    indexMedia(job.mediaId);
};
