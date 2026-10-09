import { randomUUID } from "node:crypto";

import {
    allowsPrivate,
    ConflictError,
    isTypoOf,
    mediaKinds,
    normalizeName,
    squashName,
    tagNamePatterns,
    ValidationError,
} from "@private-stock/core";

import { db } from "../db.js";
import { tagNameMatchSql } from "../tagNameMatch.js";

/**
 * Faceted tags and their assignments (§5b).
 *
 * One table for genres, performers, series and studios, distinguished by `kind`. The thing
 * this repo is careful about is `source`: an assignment made by filename parsing or by AI
 * must be replaceable without touching what a person typed, because otherwise nobody ever
 * dares re-run those stages and the library ossifies.
 */

export interface TagRow {
    id: string;
    kind: string;
    name: string;
    nameNorm: string;
    colorKey: string | null;
    description: string | null;
    /** NULL for the library's vocabulary; a user id for that person's own (§6). */
    ownerId: string | null;
    /** Who coined the name, or null once that account is gone (§6). */
    createdById: string | null;
}

export interface TagWithCountRow extends TagRow {
    mediaCount: number;
    /** Display name of whoever coined it, or null once that account is gone. */
    createdBy: string | null;
    /** Its other names, alphabetically (§5b "Aliases"). */
    aliases: string[];
}

/**
 * The aliases of the tag in scope as `t`, as a JSON array, for a listing to carry.
 *
 * A correlated subquery rather than another join, because the listings already group by tag to
 * count assignments and a second one-to-many join would multiply every count by the number of
 * aliases.
 */
const ALIASES_COLUMN = `(SELECT json_group_array(a."name" ORDER BY a."name" COLLATE NOCASE)
                           FROM "TagAlias" a WHERE a."tagId" = t."id") AS "aliases"`;

/** `ALIASES_COLUMN` as SQLite returns it, before parsing. */
type WithAliasesJson<T> = Omit<T, "aliases"> & { aliases: string };

const parseAliases = <T>(row: WithAliasesJson<T>): Omit<T, "aliases"> & { aliases: string[] } => ({
    ...row,
    aliases: JSON.parse(row.aliases) as string[],
});

/**
 * A search on a tag's name *or any of its aliases*, for the tag in scope as `t`.
 *
 * Every box that finds a tag by typing goes through this -- the vocabulary screen, the merge
 * picker, the facet modal -- so somebody who knows a performer by a married name finds them
 * under either. Bound to `tagNamePatterns` as `:search` and `:searchSquashed`.
 */
const NAME_OR_ALIAS_MATCH = `(${tagNameMatchSql("t", "search", "searchSquashed")}
        OR EXISTS (SELECT 1 FROM "TagAlias" a
                    WHERE a."tagId" = t."id"
                      AND ${tagNameMatchSql("a", "search", "searchSquashed")}))`;

/**
 * The search condition for a box that finds tags by typing, with a typo fallback (§5b).
 *
 * The patterns first: a prefix of any word, or the glued spelling anywhere. Only when nothing in
 * scope matches them does it fall back to `isTypoOf` — "margret" finding "Aunt Margaret" — and
 * then the condition is the list of tags that are one or two slips away. Never both at once: a
 * close spelling ranked beside an exact match is how fuzzy search buries what was typed.
 *
 * The decision is made on `scope` alone, before the caller's other conditions, so that two
 * queries built from the same scope — a facet's list and its total — always take the same branch
 * and cannot disagree. The cost is that a match that the caller then filters out (an unused tag,
 * on a page that shows only used ones) still suppresses the fallback.
 *
 * The fallback reads the whole scoped vocabulary into JS, which is thousands of short names and
 * happens only on a search that found nothing.
 */
const tagSearchCondition = (
    search: string,
    scope: { owner: TagOwner; kind?: string }
): { sql: string; params: Record<string, unknown> } | null => {
    const patterns = tagNamePatterns(search);

    if (!patterns) {
        return null;
    }

    const scopeSql = `t."ownerId" IS :owner${scope.kind ? ` AND t."kind" = :kind` : ""}`;
    const scopeParams: Record<string, unknown> = { owner: scope.owner };

    if (scope.kind) {
        scopeParams.kind = scope.kind;
    }

    const literal = { search: patterns.words, searchSquashed: patterns.squashed };

    const matched = db
        .prepare(`SELECT 1 FROM "Tag" t WHERE ${scopeSql} AND ${NAME_OR_ALIAS_MATCH} LIMIT 1`)
        .get({ ...scopeParams, ...literal });

    if (matched) {
        return { sql: NAME_OR_ALIAS_MATCH, params: literal };
    }

    const names = db
        .prepare(
            `SELECT t."id", t."nameNorm" FROM "Tag" t WHERE ${scopeSql}
             UNION ALL
             SELECT t."id", a."nameNorm" FROM "TagAlias" a JOIN "Tag" t ON t."id" = a."tagId"
              WHERE ${scopeSql}`
        )
        .all(scopeParams) as { id: string; nameNorm: string }[];

    const ids = [
        ...new Set(names.filter((row) => isTypoOf(search, row.nameNorm)).map((row) => row.id)),
    ];

    return {
        sql: `t."id" IN (SELECT value FROM json_each(:typoIds))`,
        params: { typoIds: JSON.stringify(ids) },
    };
};

export interface MediaTagRow {
    tagId: string;
    kind: string;
    name: string;
    colorKey: string | null;
    source: "user" | "filename" | "scraper" | "ai" | "ocr";
    confidence: number | null;
    position: number | null;
    /** Display name of whoever applied it, or null once that account is gone (§6). */
    addedBy: string | null;
    /** 1 when this is one of the viewer's own tags; null when it is the library's. */
    private: 1 | null;
}

const SELECT_COLUMNS = `"id", "kind", "name", "nameNorm", "colorKey", "description", "ownerId", "createdById"`;

/**
 * The vocabulary this viewer can see: the library's, plus their own.
 *
 * Written once and reused, because getting it wrong in one query is how somebody else's
 * private tag ends up in a list. `userId` is null only for callers that genuinely want the
 * library's alone -- the search index is the one that does (§5c).
 */
const VISIBLE_TO = `("ownerId" IS NULL OR "ownerId" = ?)`;

export const findById = (tagId: string): TagRow | undefined =>
    db.prepare(`SELECT ${SELECT_COLUMNS} FROM "Tag" WHERE "id" = ?`).get(tagId) as
        TagRow | undefined;

export interface ResolvedName {
    tag: TagRow;
    /** Whether the name matched the tag's own name or one of its aliases. */
    via: "name" | "alias";
}

/**
 * The tag a typed name means within one vocabulary, by its name or by an alias (§5b).
 *
 * It replaced `findByName`, which asked only "is this some tag's name". Every caller of that was
 * really asking "which tag does somebody mean", and the two answers differ exactly when an alias
 * is involved.
 *
 * `ownerId` names *which* vocabulary to look in, and null means the library's. It is not a
 * filter that widens: asking for the library's "beach" must not answer with somebody's private
 * one, or creating a library tag would silently adopt a private row.
 *
 * Unambiguous by construction: within a vocabulary a normalised name belongs to at most one tag,
 * as its name or as an alias (`setAliases` and the services enforce it), so there is never a
 * choice between a name and an alias to make here.
 */
export const resolveName = (
    kind: string,
    name: string,
    ownerId: string | null
): ResolvedName | undefined => {
    const nameNorm = normalizeName(name);

    if (!nameNorm) {
        return undefined;
    }

    const named = db
        .prepare(
            `SELECT ${SELECT_COLUMNS} FROM "Tag"
              WHERE "kind" = ? AND "nameNorm" = ? AND "ownerId" IS ?`
        )
        .get(kind, nameNorm, ownerId) as TagRow | undefined;

    if (named) {
        return { tag: named, via: "name" };
    }

    const aliased = db
        .prepare(
            `SELECT t."id", t."kind", t."name", t."nameNorm", t."colorKey", t."description",
                    t."ownerId", t."createdById"
               FROM "TagAlias" a
               JOIN "Tag" t ON t."id" = a."tagId"
              WHERE a."nameNorm" = ? AND t."kind" = ? AND t."ownerId" IS ?
              LIMIT 1`
        )
        .get(nameNorm, kind, ownerId) as TagRow | undefined;

    return aliased ? { tag: aliased, via: "alias" } : undefined;
};

/**
 * Why a name cannot be given to a tag: somebody else in its vocabulary already answers to it.
 *
 * Shared by every write that introduces a name, so the refusal reads the same whichever box it
 * came from. A clash with another tag's *name* is a merge in disguise and says so; a clash with
 * an alias names the tag that holds it, because that is the one somebody has to go and edit.
 */
export const nameTakenMessage = (clash: ResolvedName, typed: string): string =>
    clash.via === "alias"
        ? `"${typed.trim()}" is already an alias of ${clash.tag.name}`
        : `A ${clash.tag.kind} tag named "${clash.tag.name}" already exists — merge instead`;

/**
 * The scope a write addresses, as the owner column spells it (§6).
 *
 * `null` is the public vocabulary, an id is that person's own. Named rather than passed as a
 * bare nullable string because every function below takes one and the two readings -- "the
 * library" and "nobody in particular" -- look identical at a call site otherwise.
 */
export type TagOwner = string | null;

/**
 * Refuses an assignment that would cross the two systems (§6).
 *
 * A private tag assigned publicly would publish a name its owner chose to keep; a public tag
 * assigned privately would be a second, invisible meaning for a shared chip. Both used to be
 * expressible and neither was ever wanted, so the pairing is exact: `MediaTag.userId` always
 * equals `Tag.ownerId`.
 *
 * Enforced here rather than by a constraint because it spans two tables -- a CHECK cannot see
 * it, and a trigger would fire on a hot write path to restate what this one function already
 * guarantees. Every write to `MediaTag` in the app goes through `assign` or `replaceFacet`.
 */
/**
 * Refuses a private tag in a facet that cannot have one (§6).
 *
 * Only `tag` can be private: the other facets record what an item *is* rather than what one
 * person thinks of it. Enforced here rather than left to the boxes, because "not offered" is
 * not a rule -- a bulk apply, a hand-written request or a future scraper all reach `ensureTag`
 * with a `kind` of their own choosing.
 */
const assertPrivatable = (kind: string, ownerId: TagOwner): void => {
    if (ownerId !== null && !allowsPrivate(kind)) {
        throw new Error(`A ${kind} cannot be private — only tags can`);
    }
};

const assertScopeMatches = (tagId: string, userId: TagOwner): void => {
    const tag = db.prepare(`SELECT "ownerId" FROM "Tag" WHERE "id" = ?`).get(tagId) as
        { ownerId: string | null } | undefined;

    if (!tag) {
        throw new Error(`No such tag: ${tagId}`);
    }

    if ((tag.ownerId ?? null) !== (userId ?? null)) {
        throw new Error(
            tag.ownerId === null
                ? "A public tag cannot be assigned privately"
                : "A private tag cannot be assigned to anybody but its owner"
        );
    }
};

/**
 * Finds or creates a tag, returning its id.
 *
 * `ON CONFLICT DO UPDATE` rather than `DO NOTHING` so the statement always returns a row.
 * With `DO NOTHING` a concurrent create yields no `RETURNING` row and the caller has to
 * re-query, which is a race it will get wrong under exactly the conditions that produced it.
 *
 * The update is deliberately a no-op assignment: an existing tag keeps the name it already
 * has, so tagging something "JANE DOE" does not rewrite the display name everyone else sees.
 */
/**
 * `ownerId` has no default, deliberately.
 *
 * It used to default to `null`, which is the public vocabulary -- safe while only an
 * administrator could reach this, and a silent publish the moment anybody can. Omission is now
 * a compile error rather than a decision nobody made.
 */
export const ensureTag = (
    kind: string,
    name: string,
    ownerId: TagOwner,
    /**
     * Who coined it, recorded only when this call is what creates the row.
     *
     * The conflict branch leaves it alone for the same reason it leaves the display name
     * alone: the tag already existed, and the second person to type "beach" did not coin it.
     */
    createdById: string | null,
    colorKey?: string | null
): string => {
    const trimmed = name.trim();
    const nameNorm = normalizeName(trimmed);

    if (!nameNorm) {
        throw new Error("A tag name must contain at least one letter or digit");
    }

    assertPrivatable(kind, ownerId);

    /**
     * A name that is one of a tag's aliases means that tag (§5b "Aliases").
     *
     * Checked here rather than by each caller because every path that turns typing into a tag
     * arrives here -- the item editor, both bulk applies, and whatever parser or scraper comes
     * next. Typing "Jane Smith" tags Jane Doe everywhere at once, or nowhere reliably.
     *
     * Only aliases need asking about: a match on the name itself is the conflict branch below.
     */
    const aliased = db
        .prepare(
            `SELECT a."tagId" FROM "TagAlias" a
               JOIN "Tag" t ON t."id" = a."tagId"
              WHERE a."nameNorm" = ? AND t."kind" = ? AND t."ownerId" IS ?
              LIMIT 1`
        )
        .get(nameNorm, kind, ownerId) as { tagId: string } | undefined;

    if (aliased) {
        return aliased.tagId;
    }

    /**
     * Two conflict targets, because the uniqueness is two partial indexes.
     *
     * `ON CONFLICT("kind", "nameNorm")` no longer names anything: there is no such
     * constraint now, and a bare `ON CONFLICT` would catch the wrong one of the two.
     * Naming the index's own predicate is what makes SQLite pick the right one.
     */
    const conflict =
        ownerId === null
            ? `ON CONFLICT("kind", "nameNorm") WHERE "ownerId" IS NULL`
            : `ON CONFLICT("kind", "nameNorm", "ownerId") WHERE "ownerId" IS NOT NULL`;

    const row = db
        .prepare(
            `INSERT INTO "Tag"
                ("id", "kind", "name", "nameNorm", "colorKey", "ownerId", "createdById",
                 "updatedAt")
             VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
             ${conflict}
             DO UPDATE SET "updatedAt" = "Tag"."updatedAt"
             RETURNING "id"`
        )
        .get(randomUUID(), kind, trimmed, nameNorm, colorKey ?? null, ownerId, createdById) as {
        id: string;
    };

    return row.id;
};

export const updateTag = (
    tagId: string,
    changes: {
        name?: string;
        /**
         * Moves the tag to another facet, assignments and aliases with it -- they hang off the
         * tag rather than naming a facet, so one column is the whole move.
         */
        kind?: string;
        colorKey?: string | null;
        description?: string | null;
    }
): void => {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (changes.kind !== undefined) {
        const tag = findById(tagId);

        if (!tag) {
            throw new Error(`No such tag: ${tagId}`);
        }

        // A private tag moved to `performer` would be a private performer by the back door --
        // the same hole `setScope` closes from the other side (§6).
        assertPrivatable(changes.kind, tag.ownerId);

        sets.push(`"kind" = ?`);
        params.push(changes.kind);
    }

    if (changes.name !== undefined) {
        const trimmed = changes.name.trim();
        const nameNorm = normalizeName(trimmed);

        if (!nameNorm) {
            throw new Error("A tag name must contain at least one letter or digit");
        }

        // Both columns move together. Letting them drift means a rename stops matching
        // during filename parsing while still displaying correctly, which is invisible.
        sets.push(`"name" = ?`, `"nameNorm" = ?`);
        params.push(trimmed, nameNorm);
    }

    if (changes.colorKey !== undefined) {
        sets.push(`"colorKey" = ?`);
        params.push(changes.colorKey);
    }

    if (changes.description !== undefined) {
        sets.push(`"description" = ?`);
        params.push(changes.description);
    }

    if (sets.length === 0) {
        return;
    }

    sets.push(`"updatedAt" = CURRENT_TIMESTAMP`);
    params.push(tagId);

    db.prepare(`UPDATE "Tag" SET ${sets.join(", ")} WHERE "id" = ?`).run(...params);
};

/**
 * Every library-wide tag name and alias, keyed by its squashed form (§5c "Word boundaries").
 *
 * The dictionary the index stage finds names in glued words with: `auntmargaret` is a known
 * name because somebody filed something under "Aunt Margaret".
 *
 * **Public tags only.** What this finds is written into the shared search document, and a
 * private tag's name there would let everybody find items by somebody else's private vocabulary.
 */
export const publicNameVocabulary = (): Map<string, string> => {
    const rows = db
        .prepare(
            `SELECT "nameNorm" FROM "Tag" WHERE "ownerId" IS NULL
             UNION
             SELECT a."nameNorm" FROM "TagAlias" a JOIN "Tag" t ON t."id" = a."tagId"
              WHERE t."ownerId" IS NULL`
        )
        .pluck()
        .all() as string[];

    return new Map(rows.map((nameNorm) => [squashName(nameNorm), nameNorm]));
};

/**
 * A tag's aliases, for a set of tags at once.
 *
 * Keyed by tag rather than returned flat, because every caller holds a list of tags and wants
 * each one's names beside it: the search index for one item's tags, a single read for one.
 */
export const aliasesByTag = (tagIds: string[]): Map<string, string[]> => {
    const byTag = new Map<string, string[]>(tagIds.map((id) => [id, []]));

    if (tagIds.length === 0) {
        return byTag;
    }

    const rows = db
        .prepare(
            `SELECT "tagId", "name" FROM "TagAlias"
              WHERE "tagId" IN (SELECT value FROM json_each(?))
              ORDER BY "name" COLLATE NOCASE`
        )
        .all(JSON.stringify(tagIds)) as { tagId: string; name: string }[];

    for (const row of rows) {
        byTag.get(row.tagId)?.push(row.name);
    }

    return byTag;
};

/**
 * Replaces a tag's aliases with exactly these names (§5b "Aliases").
 *
 * The whole set rather than add and remove, because the screen edits the set: one list of
 * chips, saved together with the name, so a swap -- the married name becoming the name and the
 * maiden name an alias -- is one write and never a moment where either name means nothing.
 *
 * Names that normalise to the tag's own name are dropped rather than refused. That is what makes
 * renaming onto an alias work: the alias became the name, and there is nothing left for it to
 * say. Rows that survive keep their id and `createdById`; only the spelling is refreshed.
 *
 * **The one-name rule is enforced here.** Within a vocabulary a normalised name belongs to at
 * most one tag, as a name or an alias, because `ensureTag` has to know which tag a typed name
 * means. It spans two tables, so it cannot be a constraint -- the same trade-off the ownership
 * pairing above makes. Better-sqlite3 is synchronous and the worker never writes tags, so the
 * check and the write inside one transaction cannot be interleaved.
 */
export const setAliases = (tagId: string, names: string[], createdById: string | null): void =>
    db.transaction((): void => {
        const tag = findById(tagId);

        if (!tag) {
            throw new Error(`No such tag: ${tagId}`);
        }

        const wanted = new Map<string, string>();

        for (const name of names) {
            const trimmed = name.trim();
            const nameNorm = normalizeName(trimmed);

            if (!nameNorm) {
                throw new ValidationError("An alias must contain at least one letter or digit");
            }

            if (nameNorm === tag.nameNorm || wanted.has(nameNorm)) {
                continue;
            }

            const clash = resolveName(tag.kind, trimmed, tag.ownerId);

            if (clash && clash.tag.id !== tagId) {
                throw new ConflictError(nameTakenMessage(clash, trimmed));
            }

            wanted.set(nameNorm, trimmed);
        }

        db.prepare(
            `DELETE FROM "TagAlias"
              WHERE "tagId" = ? AND "nameNorm" NOT IN (SELECT value FROM json_each(?))`
        ).run(tagId, JSON.stringify([...wanted.keys()]));

        const upsert = db.prepare(
            `INSERT INTO "TagAlias" ("id", "tagId", "name", "nameNorm", "createdById")
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT ("tagId", "nameNorm") DO UPDATE SET "name" = excluded."name"`
        );

        for (const [nameNorm, name] of wanted) {
            upsert.run(randomUUID(), tagId, name, nameNorm, createdById);
        }
    })();

/**
 * Drops a tag's aliases that another tag in the destination vocabulary already answers to.
 *
 * Run before a tag moves between the two systems (§6), because the one-name rule is per
 * vocabulary: an alias that was unique among your private tags can be the library's name for
 * something else. The move is the owner's decision and should not fail over a nickname, so the
 * clashing aliases go and the count is reported instead.
 *
 * `intoTagId` is the tag being folded into, when publishing onto a name the library already
 * has. Aliases it already answers to -- as its name or one of its own -- are removed without
 * being counted: nothing is lost, the destination says them already.
 */
export const dropClashingAliases = (
    tagId: string,
    owner: TagOwner,
    intoTagId: string | null = null
): number => {
    const tag = findById(tagId);

    if (!tag) {
        throw new Error(`No such tag: ${tagId}`);
    }

    if (intoTagId) {
        db.prepare(
            `DELETE FROM "TagAlias"
              WHERE "tagId" = :tagId
                AND ("nameNorm" = (SELECT "nameNorm" FROM "Tag" WHERE "id" = :into)
                     OR "nameNorm" IN (SELECT "nameNorm" FROM "TagAlias" WHERE "tagId" = :into))`
        ).run({ tagId, into: intoTagId });
    }

    return db
        .prepare(
            `DELETE FROM "TagAlias"
              WHERE "tagId" = :tagId
                AND EXISTS (
                    SELECT 1 FROM "Tag" t
                     WHERE t."kind" = :kind AND t."ownerId" IS :owner
                       AND t."id" <> :tagId AND t."id" IS NOT :into
                       AND (t."nameNorm" = "TagAlias"."nameNorm"
                            OR EXISTS (SELECT 1 FROM "TagAlias" other
                                        WHERE other."tagId" = t."id"
                                          AND other."nameNorm" = "TagAlias"."nameNorm")))`
        )
        .run({ tagId, kind: tag.kind, owner, into: intoTagId }).changes;
};

export const removeTag = (tagId: string): void => {
    // MediaTag cascades, so this also drops every assignment.
    db.prepare(`DELETE FROM "Tag" WHERE "id" = ?`).run(tagId);
};

/**
 * Folds one tag into another, keeping every assignment.
 *
 * The real use is cleanup: the same performer arriving as "Jane Doe" and "Jane Smith" because
 * she changed her name, or a stray spelling beside the canonical one. A delete-and-retag would
 * lose the assignments, so the links are repointed first.
 *
 * `OR IGNORE` covers items that already carry both tags — the unique indexes would otherwise
 * abort the whole merge partway through, on exactly the duplicates that motivated it.
 *
 * **The source's other names come along** (§5b "Aliases"). Its aliases move to the target, and
 * with `keepAlias` its own name becomes one too -- otherwise the next person to type it coins
 * the duplicate the merge just removed. Neither can clash: both tags are in one vocabulary, so
 * the one-name rule already kept everything the source answers to apart from the target's.
 */
/**
 * Moves people's own marks on one tag onto another that replaces it (§6 "Favourite tags").
 *
 * A favourite of a misspelt performer is a favourite of the performer, so it follows the merge
 * rather than vanishing with the source's cascade. Somebody with a row on both keeps a mark
 * either one carried -- a favourite on one side and an unfavourited row on the other is still a
 * favourite. The source's rows go with its delete.
 */
const carryUserMarks = (fromTagId: string, toTagId: string): void => {
    db.prepare(
        `INSERT INTO "UserTag" ("userId", "tagId", "favorite", "updatedAt")
         SELECT "userId", ?, "favorite", "updatedAt" FROM "UserTag" WHERE "tagId" = ?
         ON CONFLICT("userId", "tagId")
         DO UPDATE SET "favorite" = coalesce("UserTag"."favorite", excluded."favorite")`
    ).run(toTagId, fromTagId);
};

/**
 * Moves a chosen picture onto the tag that replaces it (§6 "A tag's picture"), unless that tag has
 * a chosen one of its own. The automatic one goes with the source's cascade: it was read from the
 * source's faces, and the job reads the survivor's again.
 */
const carryPicture = (fromTagId: string, toTagId: string): void => {
    db.prepare(
        `UPDATE OR IGNORE "TagPicture" SET "tagId" = ? WHERE "tagId" = ? AND "source" = 'user'`
    ).run(toTagId, fromTagId);
};

/**
 * What people said about faces and names, moved from a tag merged away to the one it joins (§5f
 * "Corrections stick"). Without it the source's delete took its confirmations (`SET NULL`) and
 * its refusals (`CASCADE`) with it — and a merge is exactly how a performer filed under two
 * names is put right. A face the target already had confirmed keeps no refusal for it.
 */
const carryFaceDecisions = (sourceTagId: string, targetTagId: string): void => {
    db.prepare(`UPDATE "Face" SET "tagId" = ? WHERE "tagId" = ?`).run(targetTagId, sourceTagId);
    db.prepare(
        `INSERT OR IGNORE INTO "FaceRefusal" ("faceId", "tagId", "decidedByUserId", "decidedAt", "how")
         SELECT "faceId", ?, "decidedByUserId", "decidedAt", "how" FROM "FaceRefusal" WHERE "tagId" = ?`
    ).run(targetTagId, sourceTagId);
    db.prepare(
        `DELETE FROM "FaceRefusal"
          WHERE "tagId" = ? AND "faceId" IN (SELECT "id" FROM "Face" WHERE "tagId" = ?)`
    ).run(targetTagId, targetTagId);
    db.prepare(
        `INSERT OR IGNORE INTO "PerformerNoFace" ("tagId", "decidedByUserId", "decidedAt")
         SELECT ?, "decidedByUserId", "decidedAt" FROM "PerformerNoFace" WHERE "tagId" = ?`
    ).run(targetTagId, sourceTagId);
    db.prepare(
        `INSERT OR IGNORE INTO "MentionRefusal" ("tagId", "mediaId", "decidedByUserId", "decidedAt")
         SELECT ?, "mediaId", "decidedByUserId", "decidedAt" FROM "MentionRefusal" WHERE "tagId" = ?`
    ).run(targetTagId, sourceTagId);
};

export const mergeTags = (
    sourceTagId: string,
    targetTagId: string,
    options: { keepAlias?: boolean; createdById?: string | null } = {}
): number =>
    db.transaction((): number => {
        if (sourceTagId === targetTagId) {
            return 0;
        }

        const moved = db
            .prepare(`UPDATE OR IGNORE "MediaTag" SET "tagId" = ? WHERE "tagId" = ?`)
            .run(targetTagId, sourceTagId).changes;

        // Clips carry the same vocabulary (§14d), so they follow the merge too. A clip already
        // carrying both keeps the target; its duplicate goes with the source's cascade.
        db.prepare(`UPDATE OR IGNORE "ClipTag" SET "tagId" = ? WHERE "tagId" = ?`).run(
            targetTagId,
            sourceTagId
        );

        // `OR IGNORE` for data written before the rule existed; the duplicate goes with the
        // source's cascade, and the target already answers to it.
        db.prepare(`UPDATE OR IGNORE "TagAlias" SET "tagId" = ? WHERE "tagId" = ?`).run(
            targetTagId,
            sourceTagId
        );

        if (options.keepAlias) {
            db.prepare(
                `INSERT INTO "TagAlias" ("id", "tagId", "name", "nameNorm", "createdById")
                 SELECT ?, ?, "name", "nameNorm", ? FROM "Tag" WHERE "id" = ?`
            ).run(randomUUID(), targetTagId, options.createdById ?? null, sourceTagId);
        }

        carryUserMarks(sourceTagId, targetTagId);
        carryPicture(sourceTagId, targetTagId);
        carryFaceDecisions(sourceTagId, targetTagId);

        db.prepare(`DELETE FROM "Tag" WHERE "id" = ?`).run(sourceTagId);

        return moved;
    })();

/**
 * Every tag of a facet, with how many items carry it.
 *
 * `LEFT JOIN` so a tag with no items still appears — a freshly created or newly emptied tag
 * that vanishes from the management list looks like the delete silently failed.
 */
/**
 * One facet's tags, as this viewer can see them.
 *
 * The library's vocabulary plus their own, and the count is what *they* can see too:
 * one system's, named by `owner`. Counts are that system's too: a public tag's count is the
 * library's and therefore the same for everybody, and a private tag is counted against its
 * owner's own use of it.
 */
export const listByKind = (
    kind: string,
    /**
     * Which vocabulary to list (§6).
     *
     * `null` is the public one, the viewer's id their own. Both are offered separately rather
     * than merged, because the two boxes that consume this suggest into different systems --
     * a merged list would offer a public name in the private box, where typing it would coin
     * a private tag of the same name rather than reuse the one suggested.
     */
    owner: TagOwner,
    limit = 500
): TagWithCountRow[] =>
    db
        .prepare(
            `SELECT t."id", t."kind", t."name", t."nameNorm", t."colorKey", t."description",
                    t."ownerId", t."createdById", u."displayName" AS "createdBy",
                    count(m."id") AS "mediaCount", ${ALIASES_COLUMN}
               FROM "Tag" t
               LEFT JOIN "MediaTag" mt ON mt."tagId" = t."id"
               -- Only items the library would actually show. Counting the raw assignments
               -- includes trashed and archived ones, so a tag advertising 412 leads to a grid
               -- of 380 and the panel looks broken rather than stale.
               LEFT JOIN "Media" m ON m."id" = mt."mediaId" AND m."listable" = 1
               LEFT JOIN "User" u ON u."id" = t."createdById"
              WHERE t."kind" = ? AND t."ownerId" IS ?
              GROUP BY t."id"
              ORDER BY "mediaCount" DESC, t."name" COLLATE NOCASE
              LIMIT ?`
        )
        .all(kind, owner, limit)
        .map((row) => parseAliases(row as WithAliasesJson<TagWithCountRow>));

/**
 * One system's names in a facet that match what somebody is typing (§5b "One rule for names").
 *
 * The whole vocabulary is searched, by the server's rule (`tagSearchCondition`): the tag box used
 * to filter the 500 most-used names in the browser, so a rare name — the kind somebody types in
 * full precisely because it is rare — was never offered, and the box invited a duplicate of it.
 * `near` says the typo fallback answered: nothing matched as typed, and these are close spellings.
 * Ordering by how well each name matches is the caller's (`orderTagMatches`), over these rows in
 * count order.
 */
export const searchByKind = (
    kind: string,
    owner: TagOwner,
    search: string,
    limit: number
): { rows: TagWithCountRow[]; near: boolean } => {
    const condition = tagSearchCondition(search, { owner, kind });

    if (!condition) {
        return { rows: [], near: false };
    }

    const rows = db
        .prepare(
            `SELECT t."id", t."kind", t."name", t."nameNorm", t."colorKey", t."description",
                    t."ownerId", t."createdById", u."displayName" AS "createdBy",
                    count(m."id") AS "mediaCount", ${ALIASES_COLUMN}
               FROM "Tag" t
               LEFT JOIN "MediaTag" mt ON mt."tagId" = t."id"
               LEFT JOIN "Media" m ON m."id" = mt."mediaId" AND m."listable" = 1
               LEFT JOIN "User" u ON u."id" = t."createdById"
              WHERE t."kind" = :kind AND t."ownerId" IS :owner AND ${condition.sql}
              GROUP BY t."id"
              ORDER BY "mediaCount" DESC, t."name" COLLATE NOCASE
              LIMIT :limit`
        )
        .all({ kind, owner, limit, ...condition.params })
        .map((row) => parseAliases(row as WithAliasesJson<TagWithCountRow>));

    return { rows, near: "typoIds" in condition.params };
};

/**
 * The conditions `listFacetValues` and `countFacetValues` share.
 *
 * Written once because the two have to agree exactly: a list and a total built from
 * different conditions produce "showing 20 of 19", which reads as a bug in the counting
 * rather than in the query that fed it.
 */
const facetValueFilters = (
    options: Omit<FacetValueOptions, "limit">
): { where: string[]; params: Record<string, unknown> } => {
    const where = [`t."ownerId" IS :owner`];
    const params: Record<string, unknown> = { owner: options.owner };

    if (options.kind) {
        where.push(`t."kind" = :kind`);
        params.kind = options.kind;
    }

    if (options.search) {
        const condition = tagSearchCondition(options.search, {
            owner: options.owner,
            kind: options.kind,
        });

        if (condition) {
            where.push(condition.sql);
            Object.assign(params, condition.params);
        }
    }

    return { where, params };
};

export interface FacetValueRow {
    tagId: string;
    kind: string;
    name: string;
    colorKey: string | null;
    /**
     * How many listable items carry this tag across the library.
     *
     * The ordering key, and only that. It is not what the panel prints beside the name —
     * that number is counted against the current filter by `mediaRepo.facetCountsForTags`,
     * and the two differ the moment anything is filtered. Ordering by the library-wide figure
     * is deliberate: it is exact, it costs nothing extra here, and it keeps a chip from
     * jumping position every time an unrelated filter moves.
     */
    uses: number;
}

export interface FacetValueOptions {
    /** Which vocabulary to read: `null` the library's, a user id their own (§6). */
    owner: TagOwner;
    /** One facet only, for the expanded view. Every facet when absent. */
    kind?: string;
    /** Matched against the name or an alias, by `tagSearchCondition`. */
    search?: string;
    /** Values per facet, applied per kind rather than across the whole result. */
    limit: number;
}

/**
 * The values the filter panel may offer, per facet (§5c, §20).
 *
 * **Read from the vocabulary, not from the library.** The panel used to discover its values
 * by scanning the filtered media and grouping the tags it found, which is proportional to the
 * library and so had to be capped at a sample of candidates. The consequence was not a slow
 * panel but a wrong one: on a 14k-item library a keyword applied to a single video fell
 * outside the sample perhaps two times in three, and the chip for it simply did not exist.
 * Worse, the sample was not even stable — it was `LIMIT n` with no `ORDER BY`, so two queries
 * differing only in joins they never read disagreed about which values the library contained.
 *
 * Here the cost is proportional to the *vocabulary* and to how much has been tagged, which is
 * the thing being listed. Most items in a large library are never tagged at all, so this stays
 * small while the library does not.
 *
 * The join is inner on purpose: a tag nothing carries is not a filter, it is a row for the
 * vocabulary screen to tidy up. `listVocabulary` is the place that can see those.
 *
 * Counts are library-wide rather than restricted to the viewer's accessible roots. That is
 * honest while every user can reach every root, and has to be revisited when per-library
 * access lands — at which point this ordering key, and the total beside "show all", would
 * otherwise describe items the viewer cannot open.
 */
export const listFacetValues = (options: FacetValueOptions): FacetValueRow[] => {
    const { where, params } = facetValueFilters(options);

    return db
        .prepare(
            `SELECT "tagId", "kind", "name", "colorKey", "uses" FROM (
                 SELECT t."id" AS "tagId", t."kind", t."name", t."colorKey",
                        count(m."id") AS "uses",
                        row_number() OVER (
                            PARTITION BY t."kind"
                            ORDER BY count(m."id") DESC, t."name" COLLATE NOCASE
                        ) AS "rank"
                   FROM "Tag" t
                   JOIN "MediaTag" mt ON mt."tagId" = t."id" AND mt."userId" IS :owner
                   -- Only items the library would actually show. Counting raw assignments
                   -- includes trashed and archived ones, so a tag advertising 412 orders
                   -- itself above one with 380 that the grid would actually fill.
                   JOIN "Media" m ON m."id" = mt."mediaId" AND m."listable" = 1
                  WHERE ${where.join(" AND ")}
                  GROUP BY t."id"
             )
             WHERE "rank" <= :limit
             ORDER BY "kind", "uses" DESC, "name" COLLATE NOCASE`
        )
        .all({ ...params, limit: options.limit }) as FacetValueRow[];
};

/**
 * How many values each facet's vocabulary holds, so "show all" can say what "all" is.
 *
 * Separate from `listFacetValues` because that one caps per facet, and a list capped at
 * twenty cannot report the three hundred it is not showing. Counted the same way, over the
 * same rows, so the two can never disagree about what exists.
 */
export const countFacetValues = (
    options: Omit<FacetValueOptions, "limit">
): { kind: string; total: number }[] => {
    const { where, params } = facetValueFilters(options);

    return db
        .prepare(
            `SELECT "kind", count(*) AS "total" FROM (
                 SELECT t."kind" AS "kind"
                   FROM "Tag" t
                   JOIN "MediaTag" mt ON mt."tagId" = t."id" AND mt."userId" IS :owner
                   JOIN "Media" m ON m."id" = mt."mediaId" AND m."listable" = 1
                  WHERE ${where.join(" AND ")}
                  GROUP BY t."id"
             )
             GROUP BY "kind"`
        )
        .all(params) as { kind: string; total: number }[];
};

export interface VocabularyOptions {
    kind?: string;
    /** Matched against the name or an alias, by `tagSearchCondition`. */
    search?: string;
    /** Only tags nothing carries — the rows a cleanup is looking for. */
    unusedOnly?: boolean;
    /** Name by default; `count` puts the most-carried first. */
    sort?: "count" | "name";
    limit: number;
    offset: number;
}

/**
 * One system's whole vocabulary, for the management screen (§6).
 *
 * `listByKind` cannot back that screen and it is worth saying why rather than quietly adding a
 * second function: it pins **one** kind, has no search, no offset and no total, and its
 * `ORDER BY mediaCount DESC LIMIT 500` truncates unused tags first — which are exactly the
 * rows somebody tidying up came to find.
 *
 * Ordered by facet then name unless asked for count, because this is a list to *find* a tag
 * in. By count is the other question a tidy-up asks -- which of these actually matter -- and
 * the name breaks its ties so a page boundary never falls somewhere arbitrary.
 *
 * The count joins `listable`, so it matches the number of items clicking through will show.
 * Raw assignment counts include trashed and archived media, and a tag that promises 412 and
 * delivers 380 reads as broken data rather than as two different questions.
 */
export const listVocabulary = (
    owner: TagOwner,
    options: VocabularyOptions
): { rows: TagWithCountRow[]; total: number } => {
    const where = [`t."ownerId" IS :owner`];
    const params: Record<string, unknown> = {
        owner,
        limit: options.limit,
        offset: options.offset,
    };

    if (options.kind) {
        where.push(`t."kind" = :kind`);
        params.kind = options.kind;
    }

    if (options.search) {
        const condition = tagSearchCondition(options.search, { owner, kind: options.kind });

        if (condition) {
            where.push(condition.sql);
            Object.assign(params, condition.params);
        }
    }

    // A tag only clips carry is not unused: offering it for deletion would quietly strip it from
    // somebody's clips (§14d).
    const having = options.unusedOnly
        ? `HAVING count(m."id") = 0
              AND NOT EXISTS (SELECT 1 FROM "ClipTag" ct WHERE ct."tagId" = t."id")`
        : "";

    const rows = db
        .prepare(
            `SELECT t."id", t."kind", t."name", t."nameNorm", t."colorKey", t."description",
                    t."ownerId", t."createdById", u."displayName" AS "createdBy",
                    count(m."id") AS "mediaCount", ${ALIASES_COLUMN}
               FROM "Tag" t
               LEFT JOIN "MediaTag" mt ON mt."tagId" = t."id"
               LEFT JOIN "Media" m ON m."id" = mt."mediaId" AND m."listable" = 1
               LEFT JOIN "User" u ON u."id" = t."createdById"
              WHERE ${where.join(" AND ")}
              GROUP BY t."id"
              ${having}
              ORDER BY t."kind", ${options.sort === "count" ? `"mediaCount" DESC, ` : ""}t."name" COLLATE NOCASE
              LIMIT :limit OFFSET :offset`
        )
        .all(params)
        .map((row) => parseAliases(row as WithAliasesJson<TagWithCountRow>));

    /**
     * The total, counted the same way.
     *
     * Its own query rather than a window function, because `unusedOnly` filters on an
     * aggregate: the count has to be grouped before it can be filtered, and a `COUNT(*) OVER ()`
     * beside the rows would be computed before the HAVING and report the unfiltered number.
     */
    const total = (
        db
            .prepare(
                `SELECT count(*) AS n FROM (
                     SELECT t."id"
                       FROM "Tag" t
                       LEFT JOIN "MediaTag" mt ON mt."tagId" = t."id"
                       LEFT JOIN "Media" m ON m."id" = mt."mediaId" AND m."listable" = 1
                      WHERE ${where.join(" AND ")}
                      GROUP BY t."id"
                      ${having}
                 )`
            )
            .get(params) as { n: number }
    ).n;

    return { rows, total };
};

export interface BrowseTagRow extends TagRow {
    /** Listable items carrying it, videos and photos counted apart. */
    videoCount: number;
    imageCount: number;
    aliases: string[];
    /** The viewer's own mark (§6 "Favourite tags"), 1 or null like every flag. */
    favorite: 1 | null;
}

export type BrowseSort = "count" | "name" | "recent";

export interface BrowseOptions {
    kind: string;
    /** Matched against the name or an alias, by `tagSearchCondition`. */
    search?: string;
    sort: BrowseSort;
    /** Whose favourites to mark, and with `favorite`, to keep; and whose grid the counts match. */
    viewerId: string;
    /** The viewer's libraries, so a count matches the grid it opens. */
    rootIds: string[];
    favorite?: boolean;
    limit: number;
    offset: number;
}

/**
 * Every kind an item can be -- always true, and stated so the tag counts stay index-only.
 *
 * A count split by kind reads `m."kind"`, and a count narrowed to the viewer reads
 * `m."listRootId"`; without an index holding both, each assignment fetched its item's whole
 * row: ~1,000 pages for a page of the Tags page on a production-sized library (§20).
 * `idx_Media_listable_id_kind_root` holds them, and this term is that index's own WHERE: a
 * partial index is usable only by a query that states it, which is what keeps the library's
 * queries off it (see its migration). Built from `mediaKinds` -- the list the CHECK constraint
 * enforces -- so it matches the index's literal list; tagRepo.test.ts asserts the plans.
 *
 * Only in `VISIBLE_TO_VIEWER`. A join that only tests `listable` stays on the one-column
 * index: the term there buys nothing, and in some shapes it tempts the planner to start from
 * `Media` by kind instead, which reads the library.
 */
const ANY_KIND = `m."kind" IN (${mediaKinds.map((kind) => `'${kind}'`).join(", ")})`;

/** Who is asking, for the counts and samples that must match what their grid would show. */
export interface TagViewer {
    userId: string;
    /** `AuthContext.accessibleRootIds`: the libraries this viewer can reach. */
    rootIds: string[];
}

/**
 * The grid's population, as a condition on `m`: listable, in a library the viewer can reach,
 * and not hidden by them -- what `mediaRepo.listByIds` and the library query both apply.
 *
 * On every tag count that leads to a grid, so a number cannot say twelve and open nine.
 * Bound as `:viewer` and `:rootIds`; see `viewerParams`.
 *
 * Joined to `MEDIA_VISIBLE`, neither check reads the item's row: the root and the kind are in
 * its index, and the hidden check probes `idx_UserMedia_hidden`, which holds only hidden rows
 * -- named, because the planner otherwise takes the primary key and reads a page of
 * somebody's ratings and positions per item.
 */
const VISIBLE_TO_VIEWER = `m."listable" = 1 AND ${ANY_KIND}
    AND m."listRootId" IN (SELECT value FROM json_each(:rootIds))
    AND NOT EXISTS (SELECT 1 FROM "UserMedia" um INDEXED BY "idx_UserMedia_hidden"
                     WHERE um."userId" = :viewer AND um."mediaId" = m."id"
                       AND um."hidden" IS NOT NULL)`;

/**
 * `Media` as every viewer-narrowed tag count joins it: through the one index that answers
 * `VISIBLE_TO_VIEWER` and the kind split without the row.
 *
 * Named rather than left to the planner, which otherwise prefers the unique
 * `idx_Media_listable_id` and reads each row for its root. The "Appears with" statements also
 * reach it by `CROSS JOIN`, which SQLite never reorders: left alone, the planner read every
 * other tag on an item before checking the item could be seen at all. `tagRepo.test.ts`
 * asserts the plans.
 */
const MEDIA_VISIBLE = `"Media" m INDEXED BY "idx_Media_listable_id_kind_root"`;

const viewerParams = (viewer: TagViewer): { viewer: string; rootIds: string } => ({
    viewer: viewer.userId,
    rootIds: JSON.stringify(viewer.rootIds),
});

const BROWSE_ORDER: Record<BrowseSort, string> = {
    count: `("videoCount" + "imageCount") DESC, t."name" COLLATE NOCASE`,
    name: `t."name" COLLATE NOCASE`,
    recent: `max(mt."createdAt") DESC, t."name" COLLATE NOCASE`,
};

/**
 * One facet of one system, as somebody *looking* at it rather than tidying it (§6 "Tags").
 *
 * Not `listVocabulary`, which answers the management question: that one keeps unused tags
 * (they are what a cleanup is looking for) and orders by name only. Here the join is inner --
 * a tag nothing carries has nothing to show, and a row with an empty filmstrip is noise on a
 * page of people -- and the count is split by kind, because "Dad's videos" and "Dad's photos"
 * are two different things somebody opens this page for.
 */
export const browseTags = (
    owner: TagOwner,
    options: BrowseOptions
): { rows: BrowseTagRow[]; total: number } => {
    if (options.rootIds.length === 0) {
        return { rows: [], total: 0 };
    }

    const where = [`t."ownerId" IS :owner`, `t."kind" = :kind`];
    const params: Record<string, unknown> = {
        owner,
        kind: options.kind,
        ...viewerParams({ userId: options.viewerId, rootIds: options.rootIds }),
        limit: options.limit,
        offset: options.offset,
    };

    if (options.favorite) {
        where.push(`ut."favorite" = 1`);
    }

    if (options.search) {
        const condition = tagSearchCondition(options.search, { owner, kind: options.kind });

        if (condition) {
            where.push(condition.sql);
            Object.assign(params, condition.params);
        }
    }

    const from = `FROM "Tag" t
               JOIN "MediaTag" mt ON mt."tagId" = t."id" AND mt."userId" IS :owner
               JOIN ${MEDIA_VISIBLE} ON m."id" = mt."mediaId" AND ${VISIBLE_TO_VIEWER}
               LEFT JOIN "UserTag" ut ON ut."tagId" = t."id" AND ut."userId" = :viewer
              WHERE ${where.join(" AND ")}`;

    const rows = db
        .prepare(
            `SELECT t."id", t."kind", t."name", t."nameNorm", t."colorKey", t."description",
                    t."ownerId", ut."favorite",
                    sum(m."kind" = 'video') AS "videoCount",
                    sum(m."kind" = 'image') AS "imageCount",
                    ${ALIASES_COLUMN}
               ${from}
              GROUP BY t."id"
              ORDER BY ${BROWSE_ORDER[options.sort]}
              LIMIT :limit OFFSET :offset`
        )
        .all(params)
        .map((row) => parseAliases(row as WithAliasesJson<BrowseTagRow>));

    const total = (
        db.prepare(`SELECT count(DISTINCT t."id") AS n ${from}`).get(params) as { n: number }
    ).n;

    return { rows, total };
};

/**
 * A few items per tag, for a page of tags at once, in an order fixed by `seed`.
 *
 * One statement for the page rather than a shuffled library query per tag: thirty rows of
 * filmstrip would otherwise be thirty queries on every scroll. The order is the same computed
 * permutation the shuffled grid sorts by (`rowidShuffleParams`), applied to rowids, so a seed
 * gives the same strip every time it is asked -- which is what lets a strip stay put for a day
 * and be cached rather than reshuffling under somebody who pressed Back.
 *
 * The cost is the page's assignments, not the library. Only listable items, so a thumbnail
 * never leads to something the grid would not show; access and hiding are the caller's, via
 * `mediaRepo.listByIds`, which is why callers ask for a few more than they will draw.
 */
/**
 * A tag's strip is its videos, and its photos only when it has no videos (§14e "Videos unless
 * you ask"). Videos rank first, so the photos a tag with videos still drew are all ranked after
 * them and are dropped by `VIDEO_OR_NONE` -- a short strip of videos rather than one topped up
 * with photos. Both need the window's `kind` and `hasVideo` columns beside them.
 */
const VIDEOS_FIRST = `(m."kind" = 'video') DESC`;
const VIDEO_OR_NONE = `("kind" = 'video' OR "hasVideo" = 0)`;

export const sampleMediaIdsByTag = (
    tagIds: string[],
    owner: TagOwner,
    shuffle: { a: number; b: number; prime: number },
    perTag: number
): Map<string, string[]> => {
    const byTag = new Map<string, string[]>();

    if (tagIds.length === 0) {
        return byTag;
    }

    const rows = db
        .prepare(
            `SELECT "tagId", "mediaId" FROM (
                 SELECT mt."tagId", mt."mediaId", m."kind",
                        row_number() OVER (
                            PARTITION BY mt."tagId"
                            ORDER BY ${VIDEOS_FIRST}, (m.rowid * :a + :b) % :prime
                        ) AS "rank",
                        max(m."kind" = 'video') OVER (PARTITION BY mt."tagId") AS "hasVideo"
                   FROM "MediaTag" mt
                   JOIN "Media" m ON m."id" = mt."mediaId" AND m."listable" = 1
                  WHERE mt."tagId" IN (SELECT value FROM json_each(:tagIds))
                    AND mt."userId" IS :owner
             )
             WHERE "rank" <= :perTag AND ${VIDEO_OR_NONE}
             ORDER BY "tagId", "rank"`
        )
        .all({
            tagIds: JSON.stringify(tagIds),
            owner,
            a: shuffle.a,
            b: shuffle.b,
            prime: shuffle.prime,
            perTag,
        }) as { tagId: string; mediaId: string }[];

    for (const row of rows) {
        const existing = byTag.get(row.tagId);

        if (existing) existing.push(row.mediaId);
        else byTag.set(row.tagId, [row.mediaId]);
    }

    return byTag;
};

/** Items carrying one tag that the viewer's grid would show, videos and photos apart. */
export const countByKind = (
    tagId: string,
    viewer: TagViewer
): { videoCount: number; imageCount: number } => {
    if (viewer.rootIds.length === 0) {
        return { videoCount: 0, imageCount: 0 };
    }

    return db
        .prepare(
            `SELECT COALESCE(sum(m."kind" = 'video'), 0) AS "videoCount",
                    COALESCE(sum(m."kind" = 'image'), 0) AS "imageCount"
               FROM "MediaTag" mt
               JOIN ${MEDIA_VISIBLE} ON m."id" = mt."mediaId" AND ${VISIBLE_TO_VIEWER}
              WHERE mt."tagId" = :tagId`
        )
        .get({ tagId, ...viewerParams(viewer) }) as { videoCount: number; imageCount: number };
};

export interface CompanionRow {
    tagId: string;
    name: string;
    /** Items carrying both that the viewer's grid would show. */
    shared: number;
}

/**
 * Who else turns up alongside a tag: the library's tags of `kind` sharing items with it.
 *
 * "Appears with" on a person's page. Public only, whatever `tagId` is -- a companion is a link
 * to another person's page, and only the library's performers are people everybody can see.
 *
 * Counted over what this viewer can see, because the count is a promise about the grid its
 * row leads to. Each item is checked before its other tags are read, so one the viewer cannot
 * see costs a probe rather than a walk of its tags; see `MEDIA_VISIBLE` for how.
 */
export const companions = (
    tagId: string,
    kind: string,
    limit: number,
    viewer: TagViewer
): CompanionRow[] => {
    if (viewer.rootIds.length === 0) {
        return [];
    }

    return db
        .prepare(
            `SELECT other."tagId", t."name", count(*) AS "shared"
               FROM "MediaTag" mine
              CROSS JOIN ${MEDIA_VISIBLE} ON m."id" = mine."mediaId" AND ${VISIBLE_TO_VIEWER}
              CROSS JOIN "MediaTag" other ON other."mediaId" = mine."mediaId"
                                    AND other."tagId" <> mine."tagId"
                                    AND other."userId" IS NULL
               JOIN "Tag" t ON t."id" = other."tagId" AND t."kind" = :kind
              WHERE mine."tagId" = :tagId
              GROUP BY other."tagId"
              ORDER BY "shared" DESC, t."name" COLLATE NOCASE
              LIMIT :limit`
        )
        .all({
            tagId,
            kind,
            limit,
            ...viewerParams(viewer),
        }) as CompanionRow[];
};

/**
 * A few items carrying both `tagId` and each companion, in an order fixed by `seed`.
 *
 * `sampleMediaIdsByTag` for pairs: one statement for every companion on the page and the same
 * rowid permutation, over the population `companions` counted -- so a strip is drawn from the
 * items its count promises, rather than oversampled in the hope of enough. It walks the same
 * rows `companions` just counted -- this tag's items and the library tags on them -- so it
 * costs what that did, not the library.
 */
export const sampleSharedMediaIds = (
    tagId: string,
    companionIds: string[],
    shuffle: { a: number; b: number; prime: number },
    perCompanion: number,
    viewer: TagViewer
): Map<string, string[]> => {
    const byCompanion = new Map<string, string[]>();

    if (companionIds.length === 0 || viewer.rootIds.length === 0) {
        return byCompanion;
    }

    const rows = db
        .prepare(
            `SELECT "tagId", "mediaId" FROM (
                 SELECT other."tagId", mine."mediaId", m."kind",
                        row_number() OVER (
                            PARTITION BY other."tagId"
                            ORDER BY ${VIDEOS_FIRST}, (m.rowid * :a + :b) % :prime
                        ) AS "rank",
                        max(m."kind" = 'video') OVER (PARTITION BY other."tagId") AS "hasVideo"
                   FROM "MediaTag" mine
                  CROSS JOIN ${MEDIA_VISIBLE} ON m."id" = mine."mediaId" AND ${VISIBLE_TO_VIEWER}
                  CROSS JOIN "MediaTag" other ON other."mediaId" = mine."mediaId"
                                        AND other."userId" IS NULL
                                        AND other."tagId" IN (SELECT value FROM json_each(:companionIds))
                  WHERE mine."tagId" = :tagId
             )
             WHERE "rank" <= :perCompanion AND ${VIDEO_OR_NONE}
             ORDER BY "tagId", "rank"`
        )
        .all({
            tagId,
            companionIds: JSON.stringify(companionIds),
            a: shuffle.a,
            b: shuffle.b,
            prime: shuffle.prime,
            perCompanion,
            ...viewerParams(viewer),
        }) as { tagId: string; mediaId: string }[];

    for (const row of rows) {
        const existing = byCompanion.get(row.tagId);

        if (existing) existing.push(row.mediaId);
        else byCompanion.set(row.tagId, [row.mediaId]);
    }

    return byCompanion;
};

/**
 * Moves a tag between the two systems, assignments and all (§6).
 *
 * `assertScopeMatches` treats scope as identity — `Tag.ownerId` and `MediaTag.userId` agree
 * exactly — so a scope change is never one row. Both sides move together in one transaction or
 * the invariant is briefly false, and briefly false is long enough for a concurrent read to
 * see a private tag on a public assignment.
 *
 * Returns the items whose assignments moved, because the caller has to reindex them: public
 * tags are in the search document and private ones are not, so publishing changes what *other*
 * people can find (§5c).
 */
/**
 * Whether anybody but this person has applied a tag (§6).
 *
 * `createdById`, not `userId`: a public assignment has no owner, so who *made* it is the only
 * thing that separates your tagging from everybody's. A row with no author at all counts as
 * somebody else's -- it predates attribution or its account is gone, and either way it is not
 * evidence that you were alone.
 */
export const hasAssignmentsByOthers = (tagId: string, userId: string): boolean =>
    db
        .prepare(
            `SELECT 1 FROM "MediaTag"
              WHERE "tagId" = :tagId AND ("createdById" IS NULL OR "createdById" <> :userId)
             UNION ALL
             SELECT 1 FROM "ClipTag" ct JOIN "Clip" c ON c."id" = ct."clipId"
              WHERE ct."tagId" = :tagId AND (c."userId" IS NULL OR c."userId" <> :userId)
              LIMIT 1`
        )
        .get({ tagId, userId }) !== undefined;

/**
 * Refuses making a tag somebody's own while it sits on anybody else's clip (§14d).
 *
 * A clip's assignments are for the clip's owner, so a private tag on another person's clip would
 * show them a name somebody chose to keep. `hasAssignmentsByOthers` is what the services ask
 * first; this is the guarantee underneath it.
 */
const assertNoForeignClips = (tagId: string, owner: TagOwner): void => {
    if (owner === null) {
        return;
    }

    const foreign = db
        .prepare(
            `SELECT 1 FROM "ClipTag" ct JOIN "Clip" c ON c."id" = ct."clipId"
              WHERE ct."tagId" = ? AND c."userId" IS NOT ?
              LIMIT 1`
        )
        .get(tagId, owner);

    if (foreign !== undefined) {
        throw new Error("Somebody else's clips carry this tag, so it cannot be made private");
    }
};

export const setScope = (tagId: string, owner: TagOwner): string[] =>
    db.transaction((): string[] => {
        const tag = db.prepare(`SELECT "kind" FROM "Tag" WHERE "id" = ?`).get(tagId) as
            { kind: string } | undefined;

        if (!tag) {
            throw new Error(`No such tag: ${tagId}`);
        }

        // Unpublishing a performer would make a private one by the back door -- the one path
        // that can reach a private facet without creating a tag (§6).
        assertPrivatable(tag.kind, owner);
        assertNoForeignClips(tagId, owner);

        const affected = mediaIdsWithTag(tagId);

        db.prepare(
            `UPDATE "Tag" SET "ownerId" = ?, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ?`
        ).run(owner, tagId);
        db.prepare(`UPDATE "MediaTag" SET "userId" = ? WHERE "tagId" = ?`).run(owner, tagId);

        // A tag made private is nothing at all to anybody else, their favourite included:
        // left in place it would sit invisible and come back if the tag were published again.
        if (owner !== null) {
            db.prepare(`DELETE FROM "UserTag" WHERE "tagId" = ? AND "userId" <> ?`).run(
                tagId,
                owner
            );
        }

        return affected;
    })();

/**
 * Folds one tag's assignments into another and deletes it, across the two systems.
 *
 * Distinct from `mergeTags`, which refuses a cross-scope merge and should keep refusing: that
 * one is an administrator folding two shared names together, where this is the owner of a
 * private tag choosing to publish it onto a public name that already exists. The refusal
 * protects people from having their private tagging published by somebody else; it must not
 * stop them publishing it themselves.
 */
export const moveAssignments = (fromTagId: string, toTagId: string, owner: TagOwner): string[] =>
    db.transaction((): string[] => {
        assertNoForeignClips(fromTagId, owner);

        const affected = mediaIdsWithTag(fromTagId);

        const rows = db
            .prepare(
                `SELECT "mediaId", "createdById", "source", "confidence", "position", "batchId"
                   FROM "MediaTag" WHERE "tagId" = ?`
            )
            .all(fromTagId) as {
            mediaId: string;
            createdById: string | null;
            source: string;
            confidence: number | null;
            position: number | null;
            batchId: string | null;
        }[];

        // OR IGNORE for the items that already carry the destination tag: the unique index
        // says the assignment is already there, which is the answer rather than an error.
        // Ids in JS rather than from SQL, so they stay randomUUID()-shaped like every other
        // primary key in the schema (§4).
        const insert = db.prepare(
            `INSERT OR IGNORE INTO "MediaTag"
                 ("id", "mediaId", "tagId", "userId", "createdById", "source", "confidence",
                  "position", "batchId")
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );

        for (const row of rows) {
            insert.run(
                randomUUID(),
                row.mediaId,
                toTagId,
                owner,
                row.createdById,
                row.source,
                row.confidence,
                row.position,
                row.batchId
            );
        }

        // And its clips (§14d). They carry no "userId" to rewrite: the pairing is with the clip's
        // owner, which `assertNoForeignClips` has already checked against the destination.
        const clipRows = db
            .prepare(`SELECT "clipId", "position", "batchId" FROM "ClipTag" WHERE "tagId" = ?`)
            .all(fromTagId) as {
            clipId: string;
            position: number | null;
            batchId: string | null;
        }[];
        const insertClip = db.prepare(
            `INSERT OR IGNORE INTO "ClipTag" ("id", "clipId", "tagId", "position", "batchId")
             VALUES (?, ?, ?, ?, ?)`
        );

        for (const row of clipRows) {
            insertClip.run(randomUUID(), row.clipId, toTagId, row.position, row.batchId);
        }

        // Its other names follow its items. `dropClashingAliases` has already removed any the
        // destination vocabulary answers to, so nothing here can break the one-name rule.
        db.prepare(`UPDATE OR IGNORE "TagAlias" SET "tagId" = ? WHERE "tagId" = ?`).run(
            toTagId,
            fromTagId
        );

        carryUserMarks(fromTagId, toTagId);
        carryPicture(fromTagId, toTagId);

        db.prepare(`DELETE FROM "Tag" WHERE "id" = ?`).run(fromTagId);

        return affected;
    })();

export const listKinds = (userId: string): { kind: string; tagCount: number }[] =>
    db
        .prepare(
            `SELECT "kind", count(*) AS "tagCount" FROM "Tag"
              WHERE ${VISIBLE_TO}
              GROUP BY "kind" ORDER BY "kind"`
        )
        .all(userId) as { kind: string; tagCount: number }[];

/**
 * The tags on one item.
 *
 * Library-wide assignments plus this user's own private ones. `userId` is explicit rather
 * than ambient, per §6 — a repo that reads "the current user" from somewhere else is a repo
 * that eventually reads the wrong one.
 */
/**
 * The tags on a page of items, in one query (§14b).
 *
 * The tile shows two names and a `+3`, and the grid draws sixty tiles. Asking per tile is
 * sixty round trips against the hottest screen in the app; asking for the page's ids at once
 * is one indexed lookup. Grouped by the caller, which already has the page in hand.
 *
 * Ordered so the two that survive the cut are stable between renders rather than whatever
 * the planner happened to emit.
 */
export const listForMediaIds = (
    mediaIds: string[],
    userId: string
): { mediaId: string; name: string; kind: string }[] => {
    if (mediaIds.length === 0) {
        return [];
    }

    const placeholders = mediaIds.map(() => "?").join(", ");

    return db
        .prepare(
            `SELECT DISTINCT mt."mediaId", t."name", t."kind"
               FROM "MediaTag" mt
               JOIN "Tag" t ON t."id" = mt."tagId"
              WHERE mt."mediaId" IN (${placeholders})
                AND (mt."userId" IS NULL OR mt."userId" = ?)
              ORDER BY t."kind", t."name" COLLATE NOCASE`
        )
        .all(...mediaIds, userId) as { mediaId: string; name: string; kind: string }[];
};

export interface SelectionTagRow {
    tagId: string;
    kind: string;
    name: string;
    colorKey: string | null;
    /** 1 when it is the viewer's own, null when it is the library's -- the schema's NULL-as-false. */
    private: 1 | null;
    /** How many of the given items carry it. */
    count: number;
}

/**
 * Every tag a set of items carries, in both systems, with how many of them carry each.
 *
 * The question the untag dialogue asks, and the one nothing here could answer: `facetCounts`
 * takes a `MediaQuery` and a selection is a list of ids that somebody ticked.
 *
 * `json_each` rather than a placeholder per id, following `mediaRepo.listByIds`: a selection
 * runs to `BULK_ACTION_LIMIT` and binding it as parameters spends the statement's variable
 * budget on data. `listForMediaIds` above does use placeholders, and should not be copied --
 * it is handed one page of the grid, which is bounded by something much smaller.
 *
 * No `listable` filter, unlike `listByKind`. The ids arrive having already been through
 * `mediaRepo.listByIds`, which applies `listable`, `hidden` and the accessible roots; stating
 * the same rule twice is how the two come to disagree.
 */
export const listForSelection = (
    mediaIds: string[],
    userId: string,
    limit: number
): SelectionTagRow[] => {
    if (mediaIds.length === 0) {
        return [];
    }

    return db
        .prepare(
            /**
             * Counted per item, not per assignment.
             *
             * A library tag can be assigned both library-wide and privately by the same viewer
             * -- the two partial uniques on "MediaTag" permit exactly that -- and without the
             * DISTINCT an item that carries it both ways would count twice, so "on 12 of 10"
             * becomes expressible.
             *
             * The scope reported is the *tag's* (`t."ownerId"`), while what is visible is
             * decided by the *assignment* (`mt."userId"`). `assertScopeMatches` keeps the two
             * identical on every write; `listForMedia` reports it the same way.
             *
             * `private` breaks the tie that case creates: the library tag and the viewer's own
             * copy share a name and a count, so without it the order falls to the random ids
             * and the same selection lists them differently on each read. NULL sorts first, so
             * the shared tag leads and the personal copy follows it.
             */
            `SELECT t."id" AS "tagId", t."kind", t."name", t."colorKey",
                    CASE WHEN t."ownerId" IS NOT NULL THEN 1 END AS "private",
                    count(DISTINCT mt."mediaId") AS "count"
               FROM "MediaTag" mt
               JOIN "Tag" t ON t."id" = mt."tagId"
              WHERE mt."mediaId" IN (SELECT value FROM json_each(:ids))
                AND (mt."userId" IS NULL OR mt."userId" = :userId)
              GROUP BY t."id"
              ORDER BY "count" DESC, t."name" COLLATE NOCASE, "private"
              LIMIT :limit`
        )
        .all({ ids: JSON.stringify(mediaIds), userId, limit }) as SelectionTagRow[];
};

export const listForMedia = (mediaId: string, userId: string | null): MediaTagRow[] =>
    db
        .prepare(
            /**
             * One row per tag, not one per assignment.
             *
             * A library tag can be assigned both library-wide and privately by the same
             * viewer -- the two partial uniques on "MediaTag" permit exactly that -- and
             * without the grouping the item would show "beach" twice to the one person who
             * had also added it themselves. `min("userId")` is not meaningful data; it is
             * there so the group has a deterministic row to report, and `private` below is
             * the answer anyone actually wants.
             */
            `SELECT mt."tagId", t."kind", t."name", t."colorKey",
                    min(mt."source") AS "source",
                    min(mt."confidence") AS "confidence",
                    min(mt."position") AS "position",
                    min(u."displayName") AS "addedBy",
                    -- A property of the tag, not of this assignment of it: the two systems
                    -- are separate, so a tag cannot be carried both ways at once (§6).
                    CASE WHEN t."ownerId" IS NOT NULL THEN 1 END AS "private"
               FROM "MediaTag" mt
               JOIN "Tag" t ON t."id" = mt."tagId"
               LEFT JOIN "User" u ON u."id" = mt."createdById"
              WHERE mt."mediaId" = ?
                AND (mt."userId" IS NULL OR mt."userId" = ?)
              GROUP BY mt."tagId"
              ORDER BY t."kind", min(mt."position"), t."name" COLLATE NOCASE`
        )
        .all(mediaId, userId) as MediaTagRow[];

export interface AssignInput {
    mediaId: string;
    tagId: string;
    /**
     * Which system this assignment is in: null public, an id that person's own (§6).
     *
     * Required, with no default. It used to default to public, which was safe while only an
     * administrator could reach this and is a silent publish now that anybody can.
     */
    userId: TagOwner;
    /**
     * Who applied it.
     *
     * Separate from `userId`, which says who it is *for*. On a public tag those are no longer
     * the same fact, and without this one a collaborative vocabulary has nothing to review.
     */
    createdById: string | null;
    source?: "user" | "filename" | "scraper" | "ai" | "ocr";
    confidence?: number | null;
    position?: number | null;
}

/**
 * `OR IGNORE` because the unique indexes already express "at most once per item", and
 * re-tagging something that is already tagged is a no-op, not an error the UI should show.
 */
export const assign = (input: AssignInput): void => {
    assertScopeMatches(input.tagId, input.userId);

    db.prepare(
        `INSERT OR IGNORE INTO "MediaTag"
             ("id", "mediaId", "tagId", "userId", "createdById", "source", "confidence",
              "position")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
        randomUUID(),
        input.mediaId,
        input.tagId,
        input.userId,
        input.createdById,
        input.source ?? "user",
        input.confidence ?? null,
        input.position ?? null
    );
};

/**
 * The position after the last of a facet's tags on one item, within one system.
 *
 * For adding to the end. A null position sorts first, so a performer added on its own would
 * otherwise jump ahead of the ones `replaceFacet` numbered.
 */
export const nextPosition = (mediaId: string, kind: string, userId: TagOwner): number =>
    (
        db
            .prepare(
                `SELECT coalesce(max(mt."position") + 1, 0) AS "next"
                   FROM "MediaTag" mt
                   JOIN "Tag" t ON t."id" = mt."tagId"
                  WHERE mt."mediaId" = ? AND t."kind" = ? AND mt."userId" IS ?`
            )
            .get(mediaId, kind, userId) as { next: number }
    ).next;

/**
 * Replaces one facet's tags on one item, in a single transaction.
 *
 * Scoped by `source` as well as by facet, which is what makes the re-runnable stages safe:
 * re-parsing filenames passes `source: "filename"` and cannot touch a tag someone typed, even
 * within the same facet on the same item.
 *
 * All-or-nothing because the intermediate state — old tags deleted, new ones not yet
 * written — is an item that has silently lost its performers, and a crash in between would
 * leave it that way permanently.
 */
/**
 * Takes one tag off one item, within one scope.
 *
 * `userId` is the audience whose assignment is being removed, not a permission check:
 * passing null removes the library's and passing an id removes that person's. Without the
 * scope an administrator untagging would silently delete other people's private assignments
 * of the same tag, which they cannot see and would never know to expect (§6).
 */
export const unassign = (mediaId: string, tagId: string, userId: string | null): number =>
    db.transaction((): number => {
        const removed = db
            .prepare(
                `DELETE FROM "MediaTag"
                  WHERE "mediaId" = ? AND "tagId" = ? AND "userId" IS ?`
            )
            .run(mediaId, tagId, userId).changes;

        if (removed > 0) {
            pruneUnused([tagId]);
        }

        return removed;
    })();

/**
 * Deletes whichever of these tags nothing refers to any more.
 *
 * Called wherever an assignment is taken away, so that removing the last use of a tag removes
 * the tag. A typo applied to one item and then taken off again otherwise lingers in every
 * suggestion list until somebody finds it on the Tags page, and a vocabulary that fills with
 * strays is the one people stop trusting the suggestions of.
 *
 * **Only tags an assignment was just taken from**, never a sweep. A tag coined on the Tags
 * page has no items yet on purpose, and deleting it the moment it was made would be deleting
 * what somebody had just asked for. A tag with aliases is kept too: somebody curated its other
 * names, which is not what a mistyped one looks like. So is anybody's favourite -- a performer
 * whose last video went to the trash is still somebody's favourite performer.
 */
export const pruneUnused = (tagIds: string[]): number => {
    if (tagIds.length === 0) {
        return 0;
    }

    return db
        .prepare(
            `DELETE FROM "Tag"
              WHERE "id" IN (SELECT value FROM json_each(?))
                AND NOT EXISTS (SELECT 1 FROM "MediaTag" WHERE "tagId" = "Tag"."id")
                AND NOT EXISTS (SELECT 1 FROM "ClipTag" WHERE "tagId" = "Tag"."id")
                AND NOT EXISTS (SELECT 1 FROM "TagAlias" WHERE "tagId" = "Tag"."id")
                AND NOT EXISTS (SELECT 1 FROM "UserTag"
                                 WHERE "tagId" = "Tag"."id" AND "favorite" IS NOT NULL)`
        )
        .run(JSON.stringify(tagIds)).changes;
};

export const replaceFacet = (
    mediaId: string,
    kind: string,
    tagIds: string[],
    options: {
        /** Which system to replace within. Required for the reason `AssignInput.userId` is. */
        userId: TagOwner;
        createdById: string | null;
        source?: "user" | "filename" | "scraper" | "ai" | "ocr";
    }
): string[] => {
    const userId = options.userId;
    const source = options.source ?? "user";

    return db.transaction((): string[] => {
        // Only what leaves the set is deleted. Deleting the whole facet and putting back what
        // stayed used to be the same thing, until a deleted row came to mean something: a kept
        // performer's confirmed faces follow their row (§5f), and went with it.
        const removed = (
            db
                .prepare(
                    `DELETE FROM "MediaTag"
                      WHERE "mediaId" = ?
                        AND "userId" IS ?
                        AND "source" = ?
                        AND "tagId" IN (SELECT "id" FROM "Tag" WHERE "kind" = ?)
                        AND "tagId" NOT IN (SELECT value FROM json_each(?))
                  RETURNING "tagId"`
                )
                .all(mediaId, userId, source, kind, JSON.stringify(tagIds)) as { tagId: string }[]
        ).map((row) => row.tagId);
        const reorder = db.prepare(
            `UPDATE "MediaTag" SET "position" = ?
              WHERE "mediaId" = ? AND "tagId" = ? AND "userId" IS ? AND "source" = ?`
        );

        tagIds.forEach((tagId, index) => {
            // `position` orders performers within an item (§5b); it is the submitted order,
            // which is the only ordering information the caller actually has.
            reorder.run(index, mediaId, tagId, userId, source);
            assign({
                mediaId,
                tagId,
                userId,
                createdById: options.createdById,
                source,
                position: index,
            });
        });

        // After the re-assign, so a tag kept in the new set is not deleted on the way through.
        pruneUnused(removed);

        return removed;
    })();
};

/**
 * Items carrying a tag.
 *
 * Used to decide whose search documents a tag change invalidates. Callers that are about to
 * *move* assignments -- a merge -- must read this before the change, not after, or they find
 * the assignments already relocated and re-index the wrong set.
 */
export const mediaIdsWithTag = (tagId: string): string[] =>
    (
        db.prepare(`SELECT DISTINCT "mediaId" FROM "MediaTag" WHERE "tagId" = ?`).all(tagId) as {
            mediaId: string;
        }[]
    ).map((row) => row.mediaId);

/**
 * Copies one item's tag assignments onto another (§10c).
 *
 * A copy rather than a move, because the item being left behind is on its way to the trash
 * and may come back: restore promises an item returns "with everything attached to it
 * intact" (§10), and a merge that emptied it first would make that sentence false.
 *
 * Every scope travels, the library's and each viewer's private ones, because the merge runs
 * as an administrator over data they cannot see. `OR IGNORE` against the two unique indexes
 * turns "the survivor already carries this tag" into the no-op it is -- which is also what
 * makes this safe to run twice.
 *
 * `batchId` is carried over deliberately. The survivor is tagged *because* that bulk apply
 * happened, so withdrawing the batch should take this row with it; attributing it to no batch
 * would leave a tag nobody can now undo.
 */
export const copyAssignments = (fromMediaId: string, toMediaId: string): number => {
    if (fromMediaId === toMediaId) {
        return 0;
    }

    return db.transaction((): number => {
        const rows = db
            .prepare(
                `SELECT "tagId", "userId", "createdById", "source", "confidence", "position",
                        "batchId"
                   FROM "MediaTag" WHERE "mediaId" = ?`
            )
            .all(fromMediaId) as {
            tagId: string;
            userId: string | null;
            createdById: string | null;
            source: string;
            confidence: number | null;
            position: number | null;
            batchId: string | null;
        }[];

        // Ids are generated here rather than by SQL so they stay randomUUID()-shaped like
        // every other primary key in the schema (§4).
        // Attribution travels with the row: the copy on the surviving item was applied by
        // the same person, and losing that would make a merge look like an anonymous edit.
        const insert = db.prepare(
            `INSERT OR IGNORE INTO "MediaTag"
                 ("id", "mediaId", "tagId", "userId", "createdById", "source", "confidence",
                  "position", "batchId")
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );

        let copied = 0;

        for (const row of rows) {
            copied += insert.run(
                randomUUID(),
                toMediaId,
                row.tagId,
                row.userId,
                row.createdById,
                row.source,
                row.confidence,
                row.position,
                row.batchId
            ).changes;
        }

        return copied;
    })();
};
