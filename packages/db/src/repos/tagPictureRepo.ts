import type { PictureCrop, TagPictureSource } from "@private-stock/core";

import { db } from "../db.js";

/**
 * Tags' pictures (§6 "A tag's picture"): one somebody chose and one a job drew -- from a
 * performer's faces, or from a source's or a keyword's items -- at most, per tag. The chosen one
 * wins wherever both exist.
 *
 * Rows name files under `tags/`; the services write the files before the row, and take the row
 * away before the files, so a row never names a file that is not there for long (§9).
 */

export interface TagPictureRow {
    tagId: string;
    source: TagPictureSource;
    relPath: string;
    smallRelPath: string;
    mediaId: string | null;
    atMs: number | null;
    cropX: number;
    cropY: number;
    cropW: number;
    cropH: number;
    setByUserId: string | null;
    generatedAt: string;
}

const COLUMNS = `p."tagId", p."source", p."relPath", p."smallRelPath", p."mediaId", p."atMs",
                 p."cropX", p."cropY", p."cropW", p."cropH", p."setByUserId", p."generatedAt"`;

export interface TagPictureInput {
    tagId: string;
    source: TagPictureSource;
    relPath: string;
    smallRelPath: string;
    mediaId: string | null;
    atMs: number | null;
    crop: PictureCrop;
    setByUserId: string | null;
}

/** Write a picture, replacing the one of the same source. `generatedAt` is the new `?v=`. */
export const upsert = (input: TagPictureInput): TagPictureRow => {
    db.prepare(
        `INSERT INTO "TagPicture" ("tagId", "source", "relPath", "smallRelPath", "mediaId", "atMs",
                                   "cropX", "cropY", "cropW", "cropH", "setByUserId")
         VALUES (@tagId, @source, @relPath, @smallRelPath, @mediaId, @atMs,
                 @cropX, @cropY, @cropW, @cropH, @setByUserId)
         ON CONFLICT ("tagId", "source") DO UPDATE SET
             "relPath" = excluded."relPath", "smallRelPath" = excluded."smallRelPath",
             "mediaId" = excluded."mediaId", "atMs" = excluded."atMs",
             "cropX" = excluded."cropX", "cropY" = excluded."cropY",
             "cropW" = excluded."cropW", "cropH" = excluded."cropH",
             "setByUserId" = excluded."setByUserId",
             -- Seconds are the column's grain, and two choices within one second must still
             -- be two URLs: the later one is never older than the one it replaces.
             "generatedAt" = max(CURRENT_TIMESTAMP,
                                 datetime("TagPicture"."generatedAt", '+1 second'))`
    ).run({
        tagId: input.tagId,
        source: input.source,
        relPath: input.relPath,
        smallRelPath: input.smallRelPath,
        mediaId: input.mediaId,
        atMs: input.atMs,
        cropX: input.crop.x,
        cropY: input.crop.y,
        cropW: input.crop.w,
        cropH: input.crop.h,
        setByUserId: input.setByUserId,
    });

    return find(input.tagId, input.source)!;
};

export const find = (tagId: string, source: TagPictureSource): TagPictureRow | undefined =>
    db
        .prepare(`SELECT ${COLUMNS} FROM "TagPicture" p WHERE p."tagId" = ? AND p."source" = ?`)
        .get(tagId, source) as TagPictureRow | undefined;

/** Take one picture's row away, returning it so the caller can remove its files. */
export const remove = (tagId: string, source: TagPictureSource): TagPictureRow | undefined => {
    const row = find(tagId, source);

    if (row) {
        db.prepare(`DELETE FROM "TagPicture" WHERE "tagId" = ? AND "source" = ?`).run(
            tagId,
            source
        );
    }

    return row;
};

/**
 * The picture each of these tags shows this viewer: the chosen one, else the automatic one, of
 * those taken from an item they can see — or from an item since purged, which nobody can see
 * there any more and which the picture has outlived on purpose.
 *
 * An item in the trash hides a picture taken from it until it is restored, as it hides its
 * captures (§9).
 */
export const effectiveFor = (
    tagIds: readonly string[],
    rootIds: readonly string[]
): Map<string, TagPictureRow> => {
    if (tagIds.length === 0) {
        return new Map();
    }

    const params: Record<string, unknown> = { tags: JSON.stringify([...new Set(tagIds)]) };

    rootIds.forEach((id, i) => {
        params[`root${i}`] = id;
    });

    const seen =
        rootIds.length === 0
            ? "0"
            : `m."listable" = 1 AND m."listRootId" IN (${rootIds
                  .map((_, i) => `:root${i}`)
                  .join(", ")})`;
    const rows = db
        .prepare(
            `SELECT ${COLUMNS}
               FROM "TagPicture" p LEFT JOIN "Media" m ON m."id" = p."mediaId"
              WHERE p."tagId" IN (SELECT value FROM json_each(:tags))
                AND (p."mediaId" IS NULL OR (${seen}))
              ORDER BY p."tagId", p."source" = 'auto'`
        )
        .all(params) as TagPictureRow[];
    const pictures = new Map<string, TagPictureRow>();

    for (const row of rows) {
        if (!pictures.has(row.tagId)) {
            pictures.set(row.tagId, row);
        }
    }

    return pictures;
};

/**
 * The automatic pictures of performers, or of every other facet: two jobs keep them, one from
 * confirmed faces and one from how the tag's items look, and each must see only its own.
 */
export const listAuto = (of: "performers" | "others"): TagPictureRow[] =>
    db
        .prepare(
            `SELECT ${COLUMNS} FROM "TagPicture" p JOIN "Tag" t ON t."id" = p."tagId"
              WHERE p."source" = 'auto' AND (t."kind" = 'performer') = ?`
        )
        .all(of === "performers" ? 1 : 0) as TagPictureRow[];

/**
 * Which listable items carry each tag that is not a performer: what a source's or a keyword's
 * typical look is read from. Private tags too -- the picture is drawn from its owner's own
 * tagging and shown only to them.
 */
export const lookPictureMembers = (): { tagId: string; mediaId: string }[] =>
    db
        .prepare(
            `SELECT mt."tagId", mt."mediaId"
               FROM "MediaTag" mt
               JOIN "Tag" t ON t."id" = mt."tagId" AND t."kind" <> 'performer'
               JOIN "Media" m ON m."id" = mt."mediaId" AND m."listable" = 1`
        )
        .all() as { tagId: string; mediaId: string }[];

/** Every listable item: the pool random sets are drawn from, to compare a tag's items with. */
export const listableMediaIds = (): string[] =>
    (db.prepare(`SELECT "id" FROM "Media" WHERE "listable" = 1`).all() as { id: string }[]).map(
        (row) => row.id
    );

/**
 * Every library performer on a listable item: each is pictured, by a stand-in where their faces
 * give nothing (§6 "A tag's picture").
 */
export const performersCarried = (): string[] =>
    db
        .prepare(
            `SELECT DISTINCT mt."tagId"
               FROM "MediaTag" mt
               JOIN "Tag" t ON t."id" = mt."tagId" AND t."kind" = 'performer' AND t."ownerId" IS NULL
               JOIN "Media" m ON m."id" = mt."mediaId" AND m."listable" = 1
              WHERE mt."userId" IS NULL`
        )
        .pluck()
        .all() as string[];

/**
 * A moment to picture a tag by when nothing better does -- a source or a keyword with no typical
 * frame, a performer with no face (§6 "A tag's picture"): somebody's capture from one of its
 * items, else one of its items' covers. Arbitrary on
 * purpose and stable from run to run -- the first by artifact id, which is random -- so the
 * picture does not change every time the job looks. Only frames with a known moment: a video's
 * cover without one would be read at the start, which is usually black.
 */
export const standInFor = (
    tagId: string
): { mediaId: string; kind: "video" | "image"; atMs: number | null; fileId: string } | undefined =>
    db
        .prepare(
            `SELECT m."id" AS "mediaId", m."kind", a."atMs", fl."fileId"
               FROM "MediaTag" mt
               JOIN "Media" m ON m."id" = mt."mediaId" AND m."listable" = 1
               JOIN "MediaFileLink" fl ON fl."mediaId" = m."id" AND fl."role" = 'original'
               JOIN "Artifact" a ON a."mediaId" = m."id" AND a."kind" IN ('capture', 'cover')
                               AND (m."kind" = 'image' OR a."atMs" IS NOT NULL)
              WHERE mt."tagId" = ?
              ORDER BY a."kind" = 'capture' DESC, a."id"
              LIMIT 1`
        )
        .get(tagId) as
        | { mediaId: string; kind: "video" | "image"; atMs: number | null; fileId: string }
        | undefined;

/** An item's kind and its original file, for reading a frame of it. */
export const originalOf = (
    mediaId: string
): { kind: "video" | "image"; fileId: string } | undefined =>
    db
        .prepare(
            `SELECT m."kind", fl."fileId" FROM "Media" m
               JOIN "MediaFileLink" fl ON fl."mediaId" = m."id" AND fl."role" = 'original'
              WHERE m."id" = ?`
        )
        .get(mediaId) as { kind: "video" | "image"; fileId: string } | undefined;
