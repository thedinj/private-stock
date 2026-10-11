import {
    AuthorizationError,
    PRIVATE_FACET_MESSAGE,
    allowsPrivate,
    COMPANION_STRIPS,
    ConflictError,
    NotFoundError,
    ValidationError,
    FACET_EXPANDED_LIMIT,
    isKnownFacet,
    normalizeName,
    SELECTION_TAG_LIMIT,
    orderTagMatches,
    rowidShuffleParams,
    TAG_BROWSE_PAGE_SIZE,
    TAG_STRIP_LENGTH,
    tagIdsInGroups,
    tagKinds,
    tagProfileKind,
    type ApplyTagsInput,
    type CreateTagInput,
    type Facet,
    type MediaKind,
    type MediaListItem,
    type MediaQuery,
    type MediaTag,
    type ReferencedTag,
    type SelectionTagsResponse,
    type Tag,
    type TagBrowseQuery,
    type TagBrowseResponse,
    type TagChangeResult,
    type TagCompanion,
    type TagCompanionsResponse,
    type TagProfile,
    type TagScope,
    type TagSearchResponse,
    type UpdateTagInput,
    type VocabularyQuery,
    type VocabularyResponse,
} from "@private-stock/core";
import {
    changeLogRepo,
    db,
    mediaRepo,
    searchRepo,
    tagRepo,
    userTagRepo,
    type FacetScope,
} from "@private-stock/db";

import type { AuthContext } from "../auth/withAuth";
import { buildFacets } from "../facets";
import { listMedia, toListPage } from "./mediaService";
import { notThem } from "./notThem";
import { tagsChangedOn, vocabularyChanged } from "./ocrMatchHooks";
import { picturesFor, withPictures } from "./tagPictureService";

/**
 * Tag reads and writes, with the authorization (§5b, §6).
 *
 * **Two separate systems, not one with a flag.** Public tags are the library's: everybody
 * sees them and anybody may set or remove one. Private tags are one person's, invisible to
 * everyone else including an administrator. Which one a write addresses comes from the
 * request, not from the caller's role.
 *
 * This replaced a split on *who you are*: an administrator's tagging was the library's and
 * everybody else's was silently private. That made a second household member unable to
 * contribute to the shared vocabulary at all, and an administrator unable to keep a note to
 * themselves — neither of which anybody chose, both of which fell out of one expression.
 *
 * **The two vocabularies do not fall back into each other.** Typing "beach" privately makes
 * *your* "beach", separate from the library's. The old behaviour resolved private-then-library,
 * so the same chip meant "the library's tag, applied privately" in one place and "my own tag"
 * in another — which is also why a public tag's count used to differ per viewer. Separate
 * systems, separate counts, one meaning per chip.
 *
 * Renaming, merging and deleting stay with whoever owns the vocabulary: `admin` for the
 * public one, the owner for their own. Those are retroactive — every item carrying the tag
 * now says something different, and nobody who applied it is consulted.
 */

const requireAdmin = (auth: AuthContext, action: string): void => {
    if (!auth.scopes.includes("admin")) {
        throw new AuthorizationError(`Only an administrator can ${action}`);
    }
};

/**
 * Whether this viewer can see this tag at all.
 *
 * **Administrators included.** `admin` manages the library, not other people's collections
 * (§6) — the same line playlists and saved filters draw, where sharing grants reading and
 * never writing even to an administrator. A private tag is stronger still: nobody but its
 * owner can read it either.
 *
 * Reported as not-found rather than forbidden, like everything else that turns on access.
 * Forbidden would confirm the tag exists, which is half of what was being kept private.
 */
const visibleTo = (tag: { ownerId: string | null }, auth: AuthContext): boolean =>
    tag.ownerId === null || tag.ownerId === auth.userId;

/**
 * The owner column for the system a write names: null for public, the viewer for private.
 *
 * The single place the two systems are told apart, and it reads the *request* rather than the
 * role. Exported because every bulk path asks the identical question, and two copies of the
 * rule that decides what everybody else sees is one copy too many.
 *
 * `auth` is still required and is not ceremony: a private write is private to *this* viewer,
 * and taking the id from anywhere else is how one account writes into another's.
 */
export const writesTo = (scope: TagScope, auth: AuthContext): string | null =>
    scope === "public" ? null : auth.userId;

/**
 * Guards a rename, merge or delete. Call *after* `visibleTo`.
 *
 * Only the library case needs a check. A private tag that got past `visibleTo` belongs to
 * the person asking, because that is the only way it could have: nobody else can see one,
 * administrators included. So there is no "only its owner" branch here -- it would be
 * unreachable, and an unreachable guard reads as a rule that exists when it does not.
 */
const requireCurator = (tag: { ownerId: string | null }, auth: AuthContext, action: string) => {
    if (tag.ownerId === null) {
        requireAdmin(auth, `${action} a library tag`);
    }
};

/**
 * Confirms the user can see this item before letting them tag it.
 *
 * Reusing the library's own visibility check rather than writing a second one: tagging is a
 * write, and a write to an item the user cannot read would let them confirm it exists and
 * attach data to it. `findDetail` returning nothing is indistinguishable from not existing,
 * which is exactly the answer to give.
 */
const assertVisible = (mediaId: string, auth: AuthContext): void => {
    if (!mediaRepo.findDetail(mediaId, auth.userId, auth.accessibleRootIds)) {
        throw new NotFoundError("Media not found");
    }
};

const toTag = (row: tagRepo.TagWithCountRow | tagRepo.TagRow): Tag => ({
    id: row.id,
    kind: row.kind,
    name: row.name,
    nameNorm: row.nameNorm,
    colorKey: row.colorKey,
    description: row.description,
    private: row.ownerId !== null,
    ...("mediaCount" in row
        ? { mediaCount: row.mediaCount, createdBy: row.createdBy, aliases: row.aliases }
        : {}),
});

/**
 * One tag as a write returns it, aliases included.
 *
 * With its aliases because the screen that just saved them renders what comes back, and a
 * response without them would read as the save having dropped them.
 */
const readTag = (tagId: string): Tag => {
    const row = tagRepo.findById(tagId);

    if (!row) {
        throw new NotFoundError("Tag not found");
    }

    return { ...toTag(row), aliases: tagRepo.aliasesByTag([tagId]).get(tagId) ?? [] };
};

/**
 * One assignment, as the API describes it.
 *
 * `private` collapses the repo's `1 | null` -- the shape partial indexes and NULL-as-false
 * force on the database (§4) -- into the boolean the client actually wants.
 */
const toMediaTag = (row: tagRepo.MediaTagRow): MediaTag => ({
    tagId: row.tagId,
    kind: row.kind,
    name: row.name,
    colorKey: row.colorKey,
    addedBy: row.addedBy,
    source: row.source,
    confidence: row.confidence,
    position: row.position,
    private: row.private === 1,
});

/**
 * An item's tags, each with its picture: the item page draws a tag that has one as a picture
 * rather than a chip (§6 "A tag's picture").
 */
export const toMediaTags = (rows: tagRepo.MediaTagRow[], auth: AuthContext): MediaTag[] => {
    const pictures = picturesFor(
        rows.map((row) => row.tagId),
        auth
    );

    return rows.map((row) => ({ ...toMediaTag(row), picture: pictures.get(row.tagId) ?? null }));
};

/**
 * One system's vocabulary for one facet, for the box that writes into it (§6).
 *
 * Scoped rather than merged: the two boxes suggest into different systems, and offering a
 * public name in the private box would suggest reuse that cannot happen -- typing it there
 * coins a private tag of the same name.
 */
export const listTags = (kind: string, scope: TagScope, auth: AuthContext, limit?: number): Tag[] =>
    tagRepo.listByKind(kind, writesTo(scope, auth), limit).map(toTag);

/**
 * How many names the server considers before ordering them. The match set for anything typed
 * is small; this only bounds a one-letter search in a vocabulary of thousands.
 */
const SEARCH_CANDIDATES = 2_000;

/**
 * One system's names in a facet matching what somebody typed, best match first (§5b "One rule
 * for names"): the whole vocabulary searched by the server's rule, then ordered by how well each
 * name or alias matches, the count breaking ties.
 */
export const searchTags = (
    kind: string,
    scope: TagScope,
    typed: string,
    auth: AuthContext,
    limit: number
): TagSearchResponse => {
    const { rows, near } = tagRepo.searchByKind(
        kind,
        writesTo(scope, auth),
        typed,
        SEARCH_CANDIDATES
    );
    const tags = rows.map(toTag);

    if (near) {
        // Close spellings: nothing matched as typed, so there is no better match to order by.
        return { tags: withPictures(tags.slice(0, limit), auth), near };
    }

    const byName = new Map(tags.map((tag) => [tag.name, tag]));
    const ordered = orderTagMatches(
        tags.map((tag) => tag.name),
        new Map(tags.map((tag) => [tag.name, tag.aliases ?? []])),
        typed
    );

    return {
        tags: withPictures(
            ordered.slice(0, limit).flatMap((name) => byName.get(name) ?? []),
            auth
        ),
        near,
    };
};

/**
 * Facets that exist, in display order.
 *
 * Known facets come first in `tagKinds` order, because that ordering is editorial — performer
 * before source before keyword is how the filter panel reads best. Anything else a
 * scraper invented follows, alphabetically, rather than being hidden: an unknown facet is
 * unstyled, not unsupported.
 */
export const listFacetKinds = (auth: AuthContext): string[] => {
    const present = new Set(tagRepo.listKinds(auth.userId).map((row) => row.kind));

    const known = tagKinds.filter((kind) => present.has(kind));
    const unknown = [...present].filter((kind) => !isKnownFacet(kind)).sort();

    return [...known, ...unknown];
};

/**
 * Every tag a ticked selection carries, in both systems, with how much of it carries each.
 *
 * What the untag dialogue is built on, and the reason untagging stopped being a spelling
 * test. Nothing else could answer it: `getFacets` counts a `MediaQuery` and this is a list of
 * ids, while the grid's tiles hold a truncated two names and a `+3` (§14b).
 *
 * Both systems at once, deliberately. The scope of each tag is reported rather than chosen, so
 * the screen needs no scope control -- and with none there is nothing to set wrongly before
 * removing something from everybody (§6).
 *
 * An id the viewer cannot see is simply absent. A read has no per-item failure list to put it
 * in, and naming it would say an id is real in a library they were not granted.
 */
export const listSelectionTags = (mediaIds: string[], auth: AuthContext): SelectionTagsResponse => {
    const visible = mediaRepo
        .listByIds(mediaIds, auth.userId, auth.accessibleRootIds)
        .map((row) => row.id);

    // One over the limit, so "is there more" is answered by the same query that fetched the
    // page rather than by a second count.
    const rows = tagRepo.listForSelection(visible, auth.userId, SELECTION_TAG_LIMIT + 1);

    return {
        tags: rows.slice(0, SELECTION_TAG_LIMIT).map((row) => ({
            tagId: row.tagId,
            kind: row.kind,
            name: row.name,
            colorKey: row.colorKey,
            scope: row.private === 1 ? "private" : "public",
            count: row.count,
        })),
        selected: visible.length,
        truncated: rows.length > SELECTION_TAG_LIMIT,
    };
};

export const getMediaTags = (mediaId: string, auth: AuthContext): MediaTag[] => {
    assertVisible(mediaId, auth);

    return toMediaTags(tagRepo.listForMedia(mediaId, auth.userId), auth);
};

/**
 * Applies a facet's tags to one item.
 *
 * Names are resolved to tags here rather than by the client, in the same transaction as the
 * assignment. Two people adding the same new performer at once would otherwise each create
 * one, and the unique index would turn the second into an error on an action that should
 * simply have worked.
 */
export const applyTags = (
    mediaId: string,
    input: ApplyTagsInput,
    auth: AuthContext
): MediaTag[] => {
    assertVisible(mediaId, auth);

    const scope = writesTo(input.scope, auth);

    const tags = db.transaction((): MediaTag[] => {
        /**
         * A name resolves in the system it was typed into, and nowhere else.
         *
         * No fallback between the two: typing "beach" privately makes your own "beach" even
         * when the library has one. That is what keeps the systems separate — with a fallback
         * the same chip means "the library's tag, applied privately" in one place and "my own
         * tag" in another, and a public tag's count stops being the same for everybody.
         */
        // Read before `ensureTag` makes it true: a name coined here is a new performer or
        // source for OCR text to name (§5d).
        const coins =
            input.mode !== "remove" &&
            input.names.some((name) => !tagRepo.resolveName(input.kind, name, scope));
        const tagIds =
            input.mode === "remove"
                ? []
                : input.names.map((name) =>
                      tagRepo.ensureTag(input.kind, name, scope, auth.userId)
                  );

        /**
         * `replaceFacet` deletes within one system only, which is what makes this safe in
         * both directions: re-doing an item's public performers cannot wipe anybody's private
         * additions, and editing your own cannot touch the library's.
         */
        if (input.mode === "replace") {
            const removed = tagRepo.replaceFacet(mediaId, input.kind, tagIds, {
                userId: scope,
                createdById: auth.userId,
                source: "user",
            });

            // Whoever left the facet was taken off on purpose.
            if (input.notThem !== false) {
                for (const tagId of removed) notThem([mediaId], tagId, auth.userId);
            }
        } else if (input.mode === "remove") {
            /**
             * Resolved, never created: removing a name nobody has used is a no-op, not a
             * coinage. Every source of the assignment goes, not only `user` -- somebody taking
             * a suggestion off is rejecting it, and `replace`, which leaves other sources
             * alone, used to put a removed suggestion straight back on the chip.
             */
            for (const name of input.names) {
                const resolved = tagRepo.resolveName(input.kind, name, scope);

                if (
                    resolved &&
                    tagRepo.unassign(mediaId, resolved.tag.id, scope) > 0 &&
                    input.notThem !== false
                ) {
                    notThem([mediaId], resolved.tag.id, auth.userId);
                }
            }
        } else {
            const first = tagRepo.nextPosition(mediaId, input.kind, scope);

            tagIds.forEach((tagId, index) => {
                tagRepo.assign({
                    mediaId,
                    tagId,
                    userId: scope,
                    createdById: auth.userId,
                    source: "user",
                    position: first + index,
                });
            });
        }

        // In the same transaction as the change it describes (§13b) — a change that commits
        // without its notification leaves every open grid silently stale, and there is no
        // later moment at which that can be detected.
        changeLogRepo.record({
            entity: "media",
            entityId: mediaId,
            op: "update",
            detail: `tags:${input.kind}`,
        });

        // Inside, so the request is one transaction that landed or did not: outside, a busy
        // database could refuse the reindex after the tags had committed, and a save that
        // worked would answer as a failure. The route retries the whole thing on busy (§20).
        searchRepo.requestReindex([mediaId]);

        if (coins) {
            vocabularyChanged(input.kind, scope);
        }

        return toMediaTags(tagRepo.listForMedia(mediaId, auth.userId), auth);
    })();

    // After the commit: the OCR queue's recount reads outside the write lock (§5d "Counts"). Every
    // pair of the item's strings rather than the tags named, because a replace does not say which
    // tags it took off; one item's strings are a few pairs.
    tagsChangedOn([mediaId], input.kind, scope, null);

    return tags;
};

/**
 * Coins a tag.
 *
 * Into whichever vocabulary the request names. The clash check is against that one only,
 * not both: somebody's private "beach" must not stop the library's being coined, and the
 * library's must not stop somebody keeping a private one of the same name — which is the
 * point of the two partial uniques rather than one.
 */
export const createTag = (input: CreateTagInput, auth: AuthContext): Tag => {
    const owner = writesTo(input.scope, auth);
    const existing = tagRepo.resolveName(input.kind, input.name, owner);

    if (existing) {
        // A 409 rather than silently returning the existing tag: the caller asked to create
        // something, and quietly handing back a different tag with a different name is how a
        // typo becomes permanent. An alias is named as one, because "already exists" about a
        // name nobody can see in the list is a riddle.
        throw new ConflictError(
            existing.via === "alias"
                ? tagRepo.nameTakenMessage(existing, input.name)
                : `A ${input.kind} tag named "${existing.tag.name}" already exists`
        );
    }

    const id = tagRepo.ensureTag(
        input.kind,
        input.name,
        owner,
        auth.userId,
        input.colorKey ?? null
    );

    if (input.description) {
        tagRepo.updateTag(id, { description: input.description });
    }

    vocabularyChanged(input.kind, owner);

    return readTag(id);
};

/**
 * Renames or restyles a tag, and edits its aliases.
 *
 * Whoever owns the vocabulary, because a rename is retroactive: every item carrying the tag
 * now says something different, and nobody who applied it is consulted. Aliases are the same
 * kind of change -- one alters what a typed name resolves to, for everybody who types it.
 *
 * **Renaming onto one of the tag's own aliases is a swap, not a clash.** The alias becomes the
 * name, and with `keepOldNameAsAlias` the old name takes its place among the aliases: the
 * performer who married is filed under the new name and still found under the old one. No
 * separate "make primary" action, because this is that action.
 */
export const updateTag = (tagId: string, input: UpdateTagInput, auth: AuthContext): Tag => {
    const existing = tagRepo.findById(tagId);

    if (!existing || !visibleTo(existing, auth)) {
        throw new NotFoundError("Tag not found");
    }

    requireCurator(existing, auth, input.name ? "rename" : "edit");

    const kind = input.kind ?? existing.kind;
    const moved = kind !== existing.kind;

    /**
     * Only `tag` can be private (§6), so a private tag has nowhere to move to. Checked here as
     * well as in the repo for the message, as `unpublishTag` does.
     */
    if (moved && existing.ownerId !== null && !allowsPrivate(kind)) {
        throw new ValidationError(PRIVATE_FACET_MESSAGE);
    }

    /**
     * Within the destination vocabulary: the library's "beach" and somebody's private one are
     * not a clash, which is exactly what the two partial uniques say. Renaming onto another
     * tag's name is a merge, and merging silently would destroy one of the two tags without
     * saying so -- refuse, and let the caller ask for the merge explicitly.
     *
     * A facet move is checked the same way, against the facet it is moving to, even with the
     * name unchanged: a performer "Jane Doe" filed as a plain tag cannot join the performers
     * while one of them is already called that.
     */
    if (input.name || moved) {
        const name = input.name ?? existing.name;
        const clash = tagRepo.resolveName(kind, name, existing.ownerId);

        if (clash && clash.tag.id !== tagId) {
            throw new ConflictError(
                moved && clash.via === "name"
                    ? // Not "merge instead": a merge needs both in one facet, which is the
                      // very thing that cannot happen yet.
                      `A ${kind} tag named "${clash.tag.name}" already exists, so this one cannot move there — rename one of them first`
                    : tagRepo.nameTakenMessage(clash, name)
            );
        }
    }

    const renamed = input.name !== undefined && normalizeName(input.name) !== existing.nameNorm;
    // Read before the write: the row is about to say the new name.
    const oldName = existing.name;

    db.transaction(() => {
        tagRepo.updateTag(tagId, {
            name: input.name,
            kind: moved ? kind : undefined,
            colorKey: input.colorKey,
            description: input.description,
        });

        /**
         * A move re-checks the aliases too, and this is where: `setAliases` reads the tag's kind
         * afresh, so after the update above it tests every alias against the destination facet.
         * One taken there throws, and the transaction takes the move back with it -- the tag
         * never sits in a facet where one of its names means something else.
         */
        if (input.aliases !== undefined || renamed || moved) {
            const aliases = input.aliases ?? tagRepo.aliasesByTag([tagId]).get(tagId) ?? [];

            // `setAliases` drops an alias equal to the new name, which completes the swap.
            tagRepo.setAliases(
                tagId,
                renamed && input.keepOldNameAsAlias ? [...aliases, oldName] : aliases,
                auth.userId
            );
        }
    })();

    searchRepo.requestReindex(tagRepo.mediaIdsWithTag(tagId));

    // Both facets: a performer filed as a plain tag stops being a name OCR text can match.
    if (renamed || moved || input.aliases !== undefined) {
        vocabularyChanged(existing.kind, existing.ownerId);
        vocabularyChanged(kind, existing.ownerId);
    }

    return readTag(tagId);
};

export const deleteTag = (tagId: string, auth: AuthContext): TagChangeResult => {
    const existing = tagRepo.findById(tagId);

    if (!existing || !visibleTo(existing, auth)) {
        throw new NotFoundError("Tag not found");
    }

    requireCurator(existing, auth, "delete");

    // Collected before the delete: afterwards there is nothing left to say which items need
    // their search document rebuilt, and nothing to report to the person who asked.
    const affected = tagRepo.mediaIdsWithTag(tagId);

    tagRepo.removeTag(tagId);
    searchRepo.requestReindex(affected);
    // A name leaving the vocabulary can let a shorter one count where it was: "Anna" inside text
    // that said "Anna Smith" (§5b "One rule for names").
    vocabularyChanged(existing.kind, existing.ownerId);

    return { affected: affected.length };
};

/**
 * Folds one tag into another (§6).
 *
 * `keepAlias` keeps the folded tag's name as an alias of the survivor (§5b "Aliases"), and its
 * own aliases come along regardless -- a merge that forgot every name the source answered to
 * would invite each of them back as a fresh duplicate.
 */
export const mergeTags = (
    sourceTagId: string,
    targetTagId: string,
    auth: AuthContext,
    keepAlias = true
): TagChangeResult => {
    const source = tagRepo.findById(sourceTagId);
    const target = tagRepo.findById(targetTagId);

    if (!source || !target || !visibleTo(source, auth) || !visibleTo(target, auth)) {
        throw new NotFoundError("Tag not found");
    }

    requireCurator(source, auth, "merge");
    requireCurator(target, auth, "merge");

    if (source.ownerId !== target.ownerId) {
        /**
         * Merging across vocabularies is two different operations wearing one name.
         *
         * Folding a private tag into the library's publishes every item somebody had kept
         * to themselves; folding the library's into a private one takes a shared name away
         * from everybody else. Neither is a spelling correction, and neither is what the
         * person clicking "merge" is asking for.
         */
        throw new ValidationError(
            "A private tag and a library tag cannot be merged into one another"
        );
    }

    if (source.kind !== target.kind) {
        // Merging across facets would silently reclassify every item: a studio becoming a
        // series is not a spelling correction, and there is no way to undo it.
        throw new ValidationError("Tags can only be merged within the same facet");
    }

    // Both sides, because both documents change: the source's items gain the target's name
    // and the target's lose nothing but are re-read anyway when the vocabulary moves.
    const moved = tagRepo.mediaIdsWithTag(sourceTagId);
    const affected = [...new Set([...moved, ...tagRepo.mediaIdsWithTag(targetTagId)])];

    tagRepo.mergeTags(sourceTagId, targetTagId, { keepAlias, createdById: auth.userId });
    searchRepo.requestReindex(affected);
    tagsChangedOn(moved, target.kind, target.ownerId, [targetTagId]);
    vocabularyChanged(target.kind, target.ownerId);

    // What the *source* carried, counted before the merge. The union would overstate it with
    // items that already had the target, and the target's total afterwards would count items
    // this merge never touched -- and that total is the number a dialogue would quote.
    return { affected: moved.length };
};

/**
 * Facet counts for the current filter (§5c).
 *
 * The truncation flag matters more than it looks: a performer facet on a real library has
 * thousands of values, and a list that silently stops at twenty implies the other ones do
 * not exist. Saying "20 of 340" is the difference between a filter panel people trust and
 * one they work around.
 */
/**
 * A tag the caller owns, or a 404.
 *
 * Scope changes are the owner's alone — not an administrator's. `admin` curates the public
 * vocabulary, and moving somebody's private tag in or out of it is a decision about their
 * collection rather than about the library (§6). Not-found rather than forbidden, like every
 * other read of a private tag: forbidden confirms it exists.
 */
const ownedTag = (tagId: string, auth: AuthContext) => {
    const tag = tagRepo.findById(tagId);

    if (!tag || tag.ownerId !== auth.userId) {
        throw new NotFoundError("Tag not found");
    }

    return tag;
};

/**
 * Publishes one of your private tags, with everything you have put it on (§6).
 *
 * Two shapes, decided by whether the public vocabulary already holds the name:
 *
 * - **It does not** — the tag itself moves. `setScope` rewrites `Tag.ownerId` and every
 *   `MediaTag.userId` together, because the two agreeing *is* the model's definition of scope.
 * - **It does** — the tag cannot move onto an occupied name, so its assignments move into the
 *   existing public tag and the private one is deleted. The items end up tagged either way,
 *   which is what was asked for; the name survives as the one everybody already uses.
 *
 * The second case is a cross-scope merge, which `mergeTags` refuses and should keep refusing.
 * The refusal is there so nobody can publish *somebody else's* private tagging; it must not
 * stop the owner publishing their own, and the guard above is what tells the two apart.
 *
 * Reindexing is not optional here. Public tags are in the search document and private ones are
 * not, so this is the one operation that changes what other people's searches return (§5c).
 */
export const publishTag = (tagId: string, auth: AuthContext): TagChangeResult => {
    const tag = ownedTag(tagId, auth);
    /**
     * By name *or alias* (§5b "Aliases"). A private "Jane Smith" published into a library that
     * files that name as an alias of Jane Doe means Jane Doe, exactly as typing it there would.
     */
    const existing = tagRepo.resolveName(tag.kind, tag.name, null)?.tag;

    /**
     * Aliases travel with the tag, less any the library already gives to another one. The
     * publish is the owner's decision and should not fail over a nickname, so those are left
     * behind and counted, and the screen says so.
     */
    const { affected, aliasesDropped } = db.transaction(() => {
        const dropped = tagRepo.dropClashingAliases(tag.id, null, existing?.id ?? null);

        return {
            affected: existing
                ? tagRepo.moveAssignments(tag.id, existing.id, null)
                : tagRepo.setScope(tag.id, null),
            aliasesDropped: dropped,
        };
    })();

    changeLogRepo.record({
        entity: "media",
        entityId: tag.id,
        op: "update",
        detail: `tags:${tag.kind}`,
    });

    searchRepo.requestReindex(affected);

    // Aliases another name in the library already holds were dropped, which changes the names.
    vocabularyChanged(tag.kind, null);

    return { affected: affected.length, ...(aliasesDropped > 0 ? { aliasesDropped } : {}) };
};

/**
 * Takes a tag you published back out of the library.
 *
 * **Only while you are the only person who has used it.** Once somebody else has applied it,
 * unpublishing takes a shared name away from everybody and strands their work — the same
 * objection `mergeTags` raises against folding the library's tag into a private one. The UI
 * offers the action only when it is available rather than disabling it, so the rule is visible
 * as an absence rather than as a refusal after the click.
 *
 * The test is on `createdById`, not on `userId`: a public assignment has no owner, so who
 * *made* it is the only thing that distinguishes your tagging from everybody's.
 */
export const unpublishTag = (tagId: string, auth: AuthContext): TagChangeResult => {
    const tag = tagRepo.findById(tagId);

    /**
     * Only the person who coined it. "Nobody else has used it" is not ownership: without this,
     * anybody could take a name somebody else had just added to the library — or one an
     * administrator had set up and not yet applied — into their own private vocabulary, and
     * it would vanish from everybody else's. A tag whose coiner is unknown stays public.
     */
    if (!tag || tag.ownerId !== null || tag.createdById !== auth.userId) {
        throw new NotFoundError("Tag not found");
    }

    /**
     * Only `tag` can be private (§6), so most of the vocabulary cannot come back out.
     *
     * Checked here as well as in the repo, for the message: a performer reaching this is a
     * request the UI never makes, and "only tags can be private" is a better answer than
     * whatever the repo's invariant throws.
     */
    if (!allowsPrivate(tag.kind)) {
        throw new ValidationError(PRIVATE_FACET_MESSAGE);
    }

    if (tagRepo.hasAssignmentsByOthers(tagId, auth.userId)) {
        throw new ConflictError(
            "Somebody else has used this tag, so it can no longer be made private"
        );
    }

    const clash = tagRepo.resolveName(tag.kind, tag.name, auth.userId);

    if (clash) {
        throw new ConflictError(
            clash.via === "alias"
                ? `"${tag.name}" is already an alias of your private tag ${clash.tag.name}`
                : `You already have a private ${tag.kind} tag named "${tag.name}"`
        );
    }

    // Aliases come along, less any your own vocabulary already gives to another tag.
    const { affected, aliasesDropped } = db.transaction(() => {
        const dropped = tagRepo.dropClashingAliases(tagId, auth.userId);

        return { affected: tagRepo.setScope(tagId, auth.userId), aliasesDropped: dropped };
    })();

    searchRepo.requestReindex(affected);

    return { affected: affected.length, ...(aliasesDropped > 0 ? { aliasesDropped } : {}) };
};

/**
 * One system's vocabulary, paged (§6).
 *
 * The public one is readable by anybody — you cannot use a shared vocabulary you cannot see —
 * and the private one resolves through `writesTo`, so it can only ever be the caller's own.
 */
export const listVocabulary = (query: VocabularyQuery, auth: AuthContext): VocabularyResponse => {
    const { rows, total } = tagRepo.listVocabulary(writesTo(query.scope, auth), {
        kind: query.kind,
        search: query.search,
        unusedOnly: query.unusedOnly,
        sort: query.sort,
        limit: query.limit,
        offset: query.offset,
    });

    return { tags: rows.map(toTag), total };
};

/**
 * How many candidates to sample per thumbnail wanted.
 *
 * The sample is drawn before access and hiding are applied, so a tag whose items are mostly in
 * a library this viewer cannot open would otherwise show a strip of one. Twice is plenty: the
 * common case is a household where everybody can see everything.
 */
const SAMPLE_OVERSAMPLE = 2;

/**
 * Sampled items per tag, as tiles the viewer may open, in the seed's order.
 *
 * The shape `playlistService.coversFor` uses, for its reason: one sample for the page, one
 * access-checked read for every id in it, and nothing per row.
 */
const stripsFor = (
    tagIds: string[],
    owner: string | null,
    seed: number,
    length: number,
    auth: AuthContext
): Map<string, MediaListItem[]> =>
    visibleStrips(
        tagRepo.sampleMediaIdsByTag(
            tagIds,
            owner,
            rowidShuffleParams(seed),
            length * SAMPLE_OVERSAMPLE
        ),
        length,
        auth
    );

/** Who a tag count is for: it has to match the grid this viewer would open from it. */
const viewerOf = (auth: AuthContext): tagRepo.TagViewer => ({
    userId: auth.userId,
    rootIds: auth.accessibleRootIds,
});

/** Sampled ids, keyed however the sampler keys them, as the tiles the viewer may open. */
const visibleStrips = (
    sampled: Map<string, string[]>,
    length: number,
    auth: AuthContext
): Map<string, MediaListItem[]> => {
    const visible = new Map(
        toListPage(
            mediaRepo.listByIds(
                [...new Set([...sampled.values()].flat())],
                auth.userId,
                auth.accessibleRootIds
            ),
            auth.userId
        ).map((item) => [item.id, item])
    );

    return new Map(
        [...sampled].map(([key, ids]) => [
            key,
            ids
                .map((id) => visible.get(id))
                .filter((item): item is MediaListItem => item !== undefined)
                .slice(0, length),
        ])
    );
};

/**
 * Who else appears on this performer's items, the first few with a strip of what they share.
 *
 * Library performers only, and only for a library performer: a private tag's companions would
 * be drawn from everybody's assignments and say something about them.
 */
const companionsFor = (tagId: string, seed: number, auth: AuthContext): TagCompanion[] => {
    const viewer = viewerOf(auth);
    const rows = tagRepo.companions(tagId, "performer", 16, viewer);
    const strips = visibleStrips(
        tagRepo.sampleSharedMediaIds(
            tagId,
            rows.slice(0, COMPANION_STRIPS).map((row) => row.tagId),
            rowidShuffleParams(seed),
            TAG_STRIP_LENGTH,
            viewer
        ),
        TAG_STRIP_LENGTH,
        auth
    );

    const pictures = picturesFor(
        rows.map((row) => row.tagId),
        auth
    );

    return rows.map((row) => ({
        ...row,
        picture: pictures.get(row.tagId) ?? null,
        strip: strips.get(row.tagId) ?? [],
    }));
};

/**
 * One facet of one system, a page at a time, each tag with a filmstrip (§6 "Tags").
 *
 * The private side is only ever the caller's own, through `writesTo`, exactly as the
 * management table resolves it.
 */
export const browseTags = (query: TagBrowseQuery, auth: AuthContext): TagBrowseResponse => {
    const owner = writesTo(query.scope, auth);
    const { rows, total } = tagRepo.browseTags(owner, {
        kind: query.kind,
        search: query.search,
        sort: query.sort,
        viewerId: auth.userId,
        rootIds: auth.accessibleRootIds,
        favorite: query.favorite,
        limit: TAG_BROWSE_PAGE_SIZE,
        offset: query.page * TAG_BROWSE_PAGE_SIZE,
    });

    const strips = stripsFor(
        rows.map((row) => row.id),
        owner,
        query.seed,
        TAG_STRIP_LENGTH,
        auth
    );

    const pictures = picturesFor(
        rows.map((row) => row.id),
        auth
    );

    return {
        rows: rows.map((row) => ({
            // Spelled out: `toTag` keys its listing fields on `mediaCount`, which a browse row
            // splits by kind, so without this the row's aliases never reached the page.
            tag: { ...toTag(row), aliases: row.aliases, picture: pictures.get(row.id) ?? null },
            favorite: row.favorite === 1,
            videoCount: row.videoCount,
            imageCount: row.imageCount,
            strip: strips.get(row.id) ?? [],
        })),
        total,
        page: query.page,
        hasMore: (query.page + 1) * TAG_BROWSE_PAGE_SIZE < total,
    };
};

/**
 * Marks a tag as one of the viewer's favourites, or unmarks it (§6 "Favourite tags").
 *
 * Anybody signed in, on any tag they can see: it is their own mark, like an item's heart, so
 * there is no curator check and no ChangeLog row. A private tag that is not theirs is "not
 * found", the same answer every other path gives about somebody else's vocabulary.
 */
export const setTagFavorite = (
    tagId: string,
    favorite: boolean,
    auth: AuthContext
): { favorite: boolean } => {
    const row = tagRepo.findById(tagId);

    if (!row || !visibleTo(row, auth)) {
        throw new NotFoundError("Tag not found");
    }

    userTagRepo.setFavorite(auth.userId, tagId, favorite);

    return { favorite };
};

/** Items per shelf on a tag's page. Two rows of the grid on a wide screen. */
const PROFILE_SHELF = 12;

/**
 * Several statements read as one snapshot (§20), `mediaService.listMedia`'s helper for its
 * reason: outside a transaction each statement starts from a cache the worker's last commit
 * emptied. Deferred, never the web default `IMMEDIATE` -- a read must not take the write lock.
 * Nested in a caller's transaction it is a savepoint and changes nothing.
 */
const inOneSnapshot = <T>(read: () => T): T => db.transaction(read).deferred();

/** The tag, if this viewer may see it; "not found" otherwise, for every path that opens one. */
const visibleTag = (tagId: string, auth: AuthContext): tagRepo.TagRow => {
    const row = tagRepo.findById(tagId);

    if (!row || !visibleTo(row, auth)) {
        throw new NotFoundError("Tag not found");
    }

    return row;
};

/**
 * One tag's page: the picture, the counts and three shelves (§6 "Tags").
 *
 * One request for all of it, for the room's reason (`homeService`): a page assembling itself
 * shelf by shelf over a slow link reads as broken rather than as loading. The recent and
 * top-rated shelves are library queries -- the same `MediaQuery` the grid behind "See all"
 * runs -- so a shelf and the page it leads to cannot disagree about what "top rated" means.
 *
 * **"Appears with" is not here** (`getTagCompanions`). It is the one part below the fold and
 * the one part only a performer has, and the page waited on it every time.
 *
 * **The picture and the shuffled shelf are one sample.** Both are the seed's permutation of
 * this tag's items, which is also the order the shuffled grid behind "See all" sorts by
 * (`rowidShuffleParams`), so the shelf is that grid's first page. Asked of the grid, a shuffle
 * reads its whole matching set to sort it -- ~440 pages on a production replica for a tag on
 * three dozen items -- where the sample walks only this tag's assignments (~200, picture
 * included). The price is the sample's: drawn before access and hiding, so a viewer who can
 * see under half of a tag's items may get a shorter shelf than the grid's page.
 *
 * Read under one snapshot, so the shelves' walks and hydrations share one warm cache.
 */
export const getTagProfile = (tagId: string, seed: number, auth: AuthContext): TagProfile => {
    const row = visibleTag(tagId, auth);

    const shelf = (query: Partial<MediaQuery>, kind: MediaKind): MediaListItem[] =>
        listMedia(
            {
                page: 0,
                direction: "desc",
                ...query,
                kind,
                tags: [tagId],
                limit: PROFILE_SHELF,
            } as MediaQuery,
            auth
        ).items;

    return inOneSnapshot((): TagProfile => {
        // The strip already keeps to the videos when there are any (`sampleMediaIdsByTag`).
        const shuffled =
            stripsFor([tagId], row.ownerId, seed, PROFILE_SHELF, auth).get(tagId) ?? [];
        const counts = tagRepo.countByKind(tagId, viewerOf(auth));
        const kind = tagProfileKind(counts);

        return {
            tag: {
                ...toTag(row),
                aliases: tagRepo.aliasesByTag([tagId]).get(tagId) ?? [],
                picture: picturesFor([tagId], auth).get(tagId) ?? null,
            },
            favorite: userTagRepo.isFavorite(auth.userId, tagId),
            ...counts,
            hero: shuffled[0] ?? null,
            shelves: {
                recent: shelf({ sort: "addedAt" }, kind),
                // `minRating` for the reason the room's "Top rated" has it: unrated items would
                // otherwise fill the row of things somebody judged.
                topRated: shelf({ sort: "rating", minRating: 1 }, kind),
                shuffled,
            },
        };
    });
};

/**
 * "Appears with" for one tag's page, asked for after the page has drawn (§6 "Tags", §20).
 *
 * The same visibility rule as the page -- a tag this viewer may not open is "not found" here
 * too, so the second request cannot confirm what the first one denies -- and the same seed, so
 * the strips stay put for the visit. Only a library performer has companions; anything else is
 * an empty answer rather than an error, and costs one lookup.
 *
 * One snapshot for the three statements -- who, which of their shared items, and those items
 * as tiles (one `listByIds` for every strip, `visibleStrips`) -- since they walk the same
 * assignments one after the other.
 */
export const getTagCompanions = (
    tagId: string,
    seed: number,
    auth: AuthContext
): TagCompanionsResponse => {
    const row = visibleTag(tagId, auth);

    if (row.kind !== "performer" || row.ownerId !== null) {
        return { companions: [] };
    }

    return { companions: inOneSnapshot(() => companionsFor(tagId, seed, auth)) };
};

/**
 * The filter panel's facets: a complete list of values, with exact counts (§5c, §20).
 *
 * **Which values exist and what each one holds are two questions, and only the second is
 * about the library.** They used to be one: values were found by scanning the filtered media
 * and grouping the tags on it, which is proportional to the library, so the scan stopped at a
 * sample of 5,000 candidates. The counts were honest about being approximate; the *list* was
 * not, and could not be — a keyword applied to a single video fell outside the sample far
 * more often than not, and the panel simply had no chip for it. A filter you cannot reach is
 * worse than a count that is off by a few, because nothing on screen says it is missing.
 *
 * So the list comes from the vocabulary, where it is complete by construction and costs what
 * the vocabulary costs, and the counts are asked of exactly the values about to be drawn.
 * Both are exact; neither samples anything.
 */
export const getFacets = (
    query: Parameters<typeof mediaRepo.facetCountsForTags>[0],
    auth: AuthContext,
    perFacetLimit = 20,
    /**
     * Facets the caller has asked to see in full (§5c).
     *
     * A list rather than a flag, because expanding is per facet: asking to see every
     * performer says nothing about wanting every tag.
     */
    expanded: string[] = [],
    /**
     * Narrows the values by name, for the box in the expanded view.
     *
     * Server-side rather than filtering what was already sent, and that is the point of it:
     * the expanded list is a ceiling of `FACET_EXPANDED_LIMIT`, so a performer past it could
     * not be found by typing their name into a list that never contained them. Searching the
     * vocabulary reaches every value the facet has.
     */
    search?: string,
    /** Whose ratings the query asks about; see `savedFilterService.overlayForRequest`. */
    overlayUserId?: string
): { facets: Facet[]; referencedTags: Record<string, ReferencedTag> } => {
    /**
     * Every tag the filter names, in any role -- with, without, or inside a group.
     *
     * All of them are "selected" for the panel's purposes: each is a control that undoes part
     * of the current filter, so each must be drawn even when it is not among a facet's most
     * used, and sorted to the front where a cap cannot reach it.
     */
    const selectedTagIds = [
        ...new Set([
            ...(query.tags ?? []),
            ...(query.notTags ?? []),
            ...tagIdsInGroups(query.groups),
        ]),
    ];
    /**
     * The tag the filter looks for mentions of is named too, but not "selected": it is not one
     * of the panel's controls, and the chip that undoes it is above the grid (§5b "Find
     * untagged"). Its name and facet are also what the library offers to tag the matches with.
     */
    const referencedTags = referencedTagsOf(
        query.mentions ? [...new Set([...selectedTagIds, query.mentions])] : selectedTagIds,
        auth
    );
    const limitFor = (kind: string): number =>
        expanded.includes(kind) ? FACET_EXPANDED_LIMIT : perFacetLimit;

    /**
     * The query a facet's own chips are counted against (§20 "Disjunctive counts").
     *
     * Without that facet's "any of" group and its excluded chips. Under "any of", a chip's
     * count then says what selecting it would add -- counted against the group it would join,
     * it would only ever show the items it already shares with the others. An excluded chip
     * shows how many it is hiding, rather than a zero that says only that it is excluded.
     *
     * "All of" chips stay in, because there the drill-down count is the honest one: picking a
     * second performer narrows to the items with both, and that is the number to show.
     */
    const queryForFacet = (kind: string): typeof query => ({
        ...query,
        notTags: (query.notTags ?? []).filter((id) => referencedTags[id]?.kind !== kind),
        groups: (query.groups ?? []).filter((group) => group.facet !== kind),
    });

    /** Facets whose chips need their own count, because the filter has a part that is theirs. */
    const ownCountKinds = new Set([
        ...(query.groups ?? []).flatMap((group) => (group.facet ? [group.facet] : [])),
        ...(query.notTags ?? []).flatMap((id) => {
            const kind = referencedTags[id]?.kind;

            return kind ? [kind] : [];
        }),
    ]);

    const facetsFor = (scope: FacetScope): Facet[] => {
        const owner = writesTo(scope, auth);

        /**
         * One read at the largest limit any facet needs, trimmed per kind afterwards.
         *
         * Two reads to fetch two depths would pay for the vocabulary scan twice to save a few
         * hundred rows inside one process.
         */
        const values = tagRepo.listFacetValues({
            owner,
            search,
            limit: expanded.length > 0 ? FACET_EXPANDED_LIMIT : perFacetLimit,
        });

        /**
         * Counted for the values about to be drawn, and for the selections, and nothing else.
         *
         * This is what keeps an exact count affordable: the work is proportional to how much
         * has been tagged among the values on screen, not to the size of the library. A
         * thousand chips would be a thousand tags' worth of assignments to count, which is
         * why the list is capped per facet before it gets here rather than after.
         */
        const wanted = [...new Set([...values.map((row) => row.tagId), ...selectedTagIds])];
        const kindOfWanted = (tagId: string): string | undefined =>
            values.find((row) => row.tagId === tagId)?.kind ?? referencedTags[tagId]?.kind;

        /**
         * One count for every facet that only narrows, and one more per facet with an "any of"
         * group or an exclusion of its own. At most a handful of extra statements, each
         * proportional to its facet's tagging rather than to the library (§20).
         */
        const counted = [
            ...mediaRepo.facetCountsForTags(
                query,
                auth.userId,
                auth.accessibleRootIds,
                wanted.filter((tagId) => !ownCountKinds.has(kindOfWanted(tagId) ?? "")),
                scope,
                overlayUserId
            ),
            ...[...ownCountKinds].flatMap((kind) =>
                mediaRepo.facetCountsForTags(
                    queryForFacet(kind),
                    auth.userId,
                    auth.accessibleRootIds,
                    wanted.filter((tagId) => kindOfWanted(tagId) === kind),
                    scope,
                    overlayUserId
                )
            ),
        ];
        const countOf = new Map(counted.map((row) => [row.tagId, row.count]));

        /**
         * Selections the vocabulary page did not reach, rebuilt from their counts.
         *
         * `facetCountsForTags` is already scoped to the tag rather than to its assignments,
         * so a private selection cannot arrive in the public pass wearing a zero (§6). Their
         * `uses` is irrelevant: selections sort to the front regardless.
         */
        const listed = new Set(values.map((row) => row.tagId));
        const selected = counted
            .filter((row) => selectedTagIds.includes(row.tagId) && !listed.has(row.tagId))
            .map((row) => ({ ...row, uses: 0 }));

        return buildFacets({
            limitFor,
            scope,
            values,
            selected,
            countOf: (tagId) => countOf.get(tagId) ?? 0,
            totals: new Map(
                tagRepo.countFacetValues({ owner, search }).map((row) => [row.kind, row.total])
            ),
            selectedTagIds,
            order: listFacetKinds(auth),
        });
    };

    // Public first. The shared vocabulary is what most filtering is done with, and the order
    // of the two groups is the only ranking a panel of sections has.
    const facets = [...facetsFor("public"), ...facetsFor("private")];

    /**
     * The Favourites ♥ chip, once per kind, on the first section of it drawn (§14e).
     *
     * Counted like the kind's own chips, without its group and exclusions: the chip says what
     * choosing it would show, not what it already shows.
     */
    const placed = new Set<string>();

    for (const facet of facets) {
        if (placed.has(facet.kind)) continue;

        placed.add(facet.kind);
        facet.favorites = mediaRepo.facetCountForFavorites(
            queryForFacet(facet.kind),
            auth.userId,
            auth.accessibleRootIds,
            facet.kind,
            overlayUserId
        );
    }

    return { facets, referencedTags };
};

/**
 * Names for the tag ids a filter carries, as far as this viewer may see them (§14e).
 *
 * Somebody else's private tag is left out rather than named: an id in a shared address is not
 * a reason to tell the person holding it what the tag is called.
 */
const referencedTagsOf = (tagIds: string[], auth: AuthContext): Record<string, ReferencedTag> =>
    Object.fromEntries(
        tagIds.flatMap((tagId) => {
            const row = tagRepo.findById(tagId);

            return row && visibleTo(row, auth)
                ? [[tagId, { name: row.name, kind: row.kind, private: row.ownerId !== null }]]
                : [];
        })
    );
