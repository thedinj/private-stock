import { randomUUID } from "node:crypto";

import {
    AuthorizationError,
    ConflictError,
    NotFoundError,
    ValidationError,
    identicalKeeper,
    planIdentical,
    rankCopies,
    suggestSets,
    verdictsOfSets,
    type DupeApartCopy,
    type DupeApartListResponse,
    type DupeApartQuery,
    type DupeKind,
    type DupeSortInput,
    type DupeSortResponse,
    type IdenticalCopy,
    type IdenticalListResponse,
    type IdenticalPlan,
    type IdenticalQuery,
    type IdenticalSummary,
    type IdenticalTrashRequest,
    type IdenticalTrashResponse,
    type BulkActionFailure,
    type DupeGroup,
    type DupeGroupOutcome,
    type DupeListResponse,
    type DupeMember,
    type DupeQuery,
    type DupeResolveItem,
    type DupeResolveResponse,
    type KeepCandidate,
    type MediaKind,
    type MediaKindCounts,
    type MediaCopiesResponse,
    type MediaCopy,
    type TrashMediaResponse,
} from "@private-stock/core";
import { db, dupeRepo, mediaRepo } from "@private-stock/db";

import type { AuthContext } from "../auth/withAuth";
import { coverUrl } from "./artService";
import { copyCaution, groupCautions } from "./dupeCautions";
import { directMatcher } from "./dupeLinks";
import { costOfKeeping, keepReason } from "./keepAdvice";
import { trashMedia } from "./trashService";

/**
 * Duplicate review (§10).
 *
 * **Admin only.** Reviewing duplicates is the prelude to deleting files, and the whole page
 * is a list of decisions about which copy of something to destroy. It also spans the entire
 * library by construction, so a user restricted to one root would otherwise see that items
 * exist in roots they were never granted — a group is a cross-root object and cannot be
 * filtered into safety without becoming meaningless.
 */

const requireAdmin = (auth: AuthContext): void => {
    if (!auth.scopes.includes("admin")) {
        throw new AuthorizationError("Only an administrator can review duplicates");
    }
};

interface MemberRow {
    id: string;
    kind: "image" | "video";
    title: string | null;
    durationMs: number | null;
    width: number | null;
    height: number | null;
    bitrate: number | null;
    codec: string | null;
    addedAt: string;
    capturedAt: string | null;
    sizeBytes: number | null;
    relPath: string;
    contentHash: string | null;
    rootId: string;
    rootLabel: string;
    writable: number | null;
    coverPath: string | null;
    coverGeneratedAt: string | null;
    clipCount: number;
}

/**
 * A member's columns and joins, shared by a group's members and an item's copies.
 *
 * One definition, so the review screen and the delete confirmation compare copies on the same
 * numbers -- they are the same comparison, asked from two places.
 *
 * The cover is the generated one even where someone chose another (§10i "Comparing by the
 * generated cover"). Every generated cover is taken the same way into its file, so two copies of
 * one video show the same picture; a chosen one can be any moment, and makes duplicates look
 * different. The chosen cover stands in only when nothing has been generated yet.
 */
const MEMBER_SELECT = `m."id", m."kind", m."title", m."durationMs", m."width", m."height",
                    m."bitrate", m."codec", m."addedAt", m."capturedAt",
                    f."size" AS "sizeBytes", f."relPath", f."contentHash",
                    r."id" AS "rootId", r."label" AS "rootLabel", r."writable",
                    COALESCE(generated."relPath", chosen."relPath") AS "coverPath",
                    COALESCE(generated."generatedAt", chosen."generatedAt") AS "coverGeneratedAt",
                    (SELECT count(*) FROM "Clip" c WHERE c."mediaId" = m."id") AS "clipCount"`;

const MEMBER_JOINS = `JOIN "Media" m ON m."id" = dm."mediaId"
               JOIN "MediaFileLink" fl ON fl."mediaId" = m."id" AND fl."role" = 'original'
               JOIN "MediaFile" f ON f."id" = fl."fileId"
               JOIN "MediaRoot" r ON r."id" = f."rootId"
               LEFT JOIN "Artifact" chosen ON chosen."id" = m."coverArtifactId"
               LEFT JOIN "Artifact" generated ON generated."mediaId" = m."id"
                                             AND generated."kind" = 'cover'
                                             AND generated."ordinal" = 0`;

/**
 * The members of a group, with everything the comparison needs.
 *
 * One query per group rather than per member. A group of four rendered from the ordinary
 * detail endpoint would be four requests that each join artifacts, variants and the per-user
 * overlay, to display six numbers.
 */
const loadMembers = (groupId: string): MemberRow[] =>
    db
        .prepare(
            `SELECT ${MEMBER_SELECT}
               FROM "DupeMember" dm
               ${MEMBER_JOINS}
              WHERE dm."groupId" = ? AND f."state" = 'active'`
        )
        .all(groupId) as MemberRow[];

/**
 * Every copy of an item that still has a file, the item included, in every root.
 *
 * Across every group the item is in, as `dupeRepo.activeCopies` reads it, so "its copies" here
 * and "the copy that inherits" in the merge are the same set.
 */
const loadCopies = (mediaId: string): MemberRow[] =>
    db
        .prepare(
            `SELECT DISTINCT ${MEMBER_SELECT}
               FROM "DupeMember" mine
               JOIN "DupeMember" dm ON dm."groupId" = mine."groupId"
               ${MEMBER_JOINS}
              WHERE mine."mediaId" = ? AND f."state" = 'active'`
        )
        .all(mediaId) as MemberRow[];

const candidateOf = (row: MemberRow): KeepCandidate => ({
    mediaId: row.id,
    width: row.width,
    height: row.height,
    bitrate: row.bitrate,
    sizeBytes: row.sizeBytes,
    durationMs: row.durationMs,
    addedAt: row.addedAt,
});

/**
 * Rows best first (§10c).
 *
 * Ordering is a recommendation in its own right, and it is the one that costs nothing to
 * read. `rankCopies` rather than a second sort, so the order on screen and the copy marked
 * "Best copy" cannot disagree.
 */
const rankRows = (rows: MemberRow[]): { ranked: KeepCandidate[]; ordered: MemberRow[] } => {
    const ranked = rankCopies(rows.map(candidateOf));
    const byId = new Map(rows.map((row) => [row.id, row]));
    const ordered = ranked
        .map((candidate) => byId.get(candidate.mediaId))
        .filter((row): row is MemberRow => row !== undefined);

    return { ranked, ordered };
};

const toMember = (row: MemberRow, ranked: KeepCandidate[]): DupeMember => {
    const best = ranked[0];

    return {
        id: row.id,
        kind: row.kind,
        title: row.title ?? row.relPath,
        durationMs: row.durationMs,
        width: row.width,
        height: row.height,
        addedAt: row.addedAt,
        capturedAt: row.capturedAt,
        sizeBytes: row.sizeBytes,
        coverUrl: coverUrl(row.id, row.coverPath, row.coverGeneratedAt),
        // Previews are deliberately absent: a review screen showing four groups would
        // start twelve videos at once, which is past the decoder budget on any phone
        // and most desktops (§9).
        previewUrl: null,
        rating: null,
        favorite: false,
        // The review screen is about which *file* to keep, not about anybody's history
        // with it or how it has been described. Both are deliberately blank rather than
        // fetched: a second query per group, to render fields this screen does not draw.
        watchedAt: null,
        tags: [],
        tagCount: 0,
        performers: [],
        performerCount: 0,
        probed: true,
        // Not assessed: this screen compares copies and plays none of them. False is the
        // answer that cannot start a player on a file nobody checked.
        directPlay: false,
        relPath: row.relPath,
        rootLabel: row.rootLabel,
        // A copy on a read-only root cannot be removed whatever the reviewer decides
        // (§18.1), and the UI has to say so rather than offering an action that fails.
        deletable: row.writable === 1,
        bitrate: row.bitrate,
        codec: row.codec,
        // What this copy would cost if it were kept instead. Null on the best copy, and
        // null when the two are genuinely alike -- a card claiming a disadvantage that
        // does not exist would undermine every card that names a real one.
        costOfKeeping: best
            ? costOfKeeping(best, ranked.find((candidate) => candidate.mediaId === row.id) ?? best)
            : null,
        clipCount: row.clipCount,
    };
};

const toGroup = (summary: dupeRepo.DupeGroupSummary): DupeGroup | null => {
    const rows = loadMembers(summary.id);

    // A group whose extra copies have been deleted is not a duplicate any more. Filtered
    // here as well as pruned by the worker, so the page never shows a group of one between
    // the deletion and the next clustering pass.
    if (rows.length < 2) {
        return null;
    }

    const links = dupeRepo.listMembers(summary.id);
    const maxDistance = Math.max(0, ...links.map((link) => link.distance ?? 0));

    // Best first, and the cards are rendered in this order.
    const { ranked, ordered } = rankRows(rows);
    const best = ranked[0];
    const members = ordered.map((row) => toMember(row, ranked));
    const { suggestedSets, confirmed } = sortingOf(summary.kind, ordered);

    /**
     * For identical files, the copy trashing every identical copy would keep (§10e) -- a
     * read-only one when there is one, so the writable copies can go. The ranking cannot tell
     * byte-identical files apart on quality, and preselecting a writable keeper beside a
     * read-only copy removed nothing at all.
     */
    const identicalKeep =
        summary.kind === "exact" ? identicalKeeper(rows.map(identicalCopyOf)) : null;
    const suggestedKeepId = identicalKeep ?? best?.mediaId ?? null;
    const keptReadOnly =
        identicalKeep !== null && rows.find((row) => row.id === identicalKeep)?.writable !== 1;

    return {
        id: summary.id,
        kind: summary.kind,
        reviewed: summary.reviewed,
        maxDistance,
        suggestedKeepId,
        keepReason: keptReadOnly
            ? "In a read-only library, so it stays whatever is decided"
            : best
              ? keepReason(best, ranked[1])
              : null,
        members,
        cautions: [
            ...groupCautions(summary.kind, members, suggestedKeepId),
            ...(suggestedSets.length > 1
                ? [
                      `Not every copy matches every other — these look like ${suggestedSets.length} different things. Sort them before trashing.`,
                  ]
                : []),
        ],
        suggestedSets,
        confirmed,
    };
};

/**
 * How a group's copies sort into sets of the same thing, and whether a person has said so (§10i).
 *
 * Identical files and pairs have nothing to sort: a pair is in its group because the two match.
 * For three or more, what people said decides each pair it covers and the comparison the rest,
 * which is only run when a pair is actually asked about -- a group somebody confirmed costs none.
 */
const sortingOf = (
    kind: DupeKind,
    ordered: MemberRow[]
): { suggestedSets: string[][]; confirmed: boolean } => {
    const ids = ordered.map((row) => row.id);

    if (kind === "exact") {
        return { suggestedSets: [ids], confirmed: false };
    }

    const verdicts = dupeRepo
        .verdictsAmong(ids)
        .map((row) => ({ a: row.aId, b: row.bId, verdict: row.verdict }));
    const same = verdicts.filter((verdict) => verdict.verdict === "same").length;
    const confirmed = same === (ids.length * (ids.length - 1)) / 2;

    if (ids.length < 3) {
        return { suggestedSets: [ids], confirmed };
    }

    let matcher: ((a: string, b: string) => boolean) | null = null;
    const matches = (a: string, b: string): boolean => {
        matcher ??= directMatcher(ordered);

        return matcher(a, b);
    };

    return { suggestedSets: suggestSets(ids, matches, verdicts), confirmed };
};

const identicalCopyOf = (row: MemberRow): IdenticalCopy => ({
    ...candidateOf(row),
    deletable: row.writable === 1,
    contentHash: row.contentHash,
    clipCount: row.clipCount,
});

export const listDupes = (query: DupeQuery, auth: AuthContext): DupeListResponse => {
    requireAdmin(auth);

    const filter = { reviewed: query.status === "reviewed", kind: query.kind, media: query.media };
    const summaries = dupeRepo.listGroups({ ...filter, limit: query.limit, offset: query.offset });
    const pending = dupeRepo.countPending();
    // The tab counts follow the kind control, so a tab says what it holds under it.
    const of = (counts: MediaKindCounts): number =>
        query.media ? counts[query.media] : counts.video + counts.image;

    return {
        groups: summaries.map(toGroup).filter((group): group is DupeGroup => group !== null),
        total: dupeRepo.countGroups(filter),
        pending: { exact: of(pending.exact), near: of(pending.near) },
        reviewed: dupeRepo.countGroups({ reviewed: true, media: query.media }),
        pendingByMedia: {
            video: pending.exact.video + pending.near.video,
            image: pending.exact.image + pending.near.image,
        },
    };
};

/**
 * What trashing every identical copy would do to each pending identical group (§10e).
 *
 * Planned afresh on every call, from one query over the whole queue, so the summary, the pages
 * and each batch of the run all apply the rule to the catalogue as it is now.
 */
const identicalPlans = (media: MediaKind | undefined): Map<string, IdenticalPlan> => {
    const byGroup = new Map<string, IdenticalCopy[]>();

    for (const row of dupeRepo.pendingIdenticalCopies(media)) {
        const copies = byGroup.get(row.groupId) ?? [];

        copies.push({
            mediaId: row.mediaId,
            width: row.width,
            height: row.height,
            bitrate: row.bitrate,
            sizeBytes: row.sizeBytes,
            durationMs: row.durationMs,
            addedAt: row.addedAt,
            deletable: row.writable === 1,
            contentHash: row.contentHash,
            clipCount: row.clipCount,
        });
        byGroup.set(row.groupId, copies);
    }

    return new Map([...byGroup].map(([groupId, copies]) => [groupId, planIdentical(copies)]));
};

type RoutinePlan = Extract<IdenticalPlan, { kind: "routine" }>;

const routineOf = (plans: Map<string, IdenticalPlan>): [string, RoutinePlan][] =>
    [...plans].filter((entry): entry is [string, RoutinePlan] => entry[1].kind === "routine");

const summarize = (plans: Map<string, IdenticalPlan>): IdenticalSummary => {
    const routine = routineOf(plans);

    return {
        groups: routine.length,
        copies: routine.reduce((total, [, plan]) => total + plan.trashIds.length, 0),
        bytes: routine.reduce((total, [, plan]) => total + plan.bytes, 0),
        attention: [...plans.values()].filter((plan) => plan.kind === "attention").length,
    };
};

/**
 * The identical groups, split by whether the rule decides them (§10e).
 *
 * Routine groups biggest first, so the page leads with where the space is; the groups left for
 * a person in the order the queue keeps.
 */
export const listIdentical = (query: IdenticalQuery, auth: AuthContext): IdenticalListResponse => {
    requireAdmin(auth);

    const plans = identicalPlans(query.media);

    const ids =
        query.view === "routine"
            ? routineOf(plans)
                  .sort(([, a], [, b]) => b.bytes - a.bytes)
                  .map(([groupId]) => groupId)
            : [...plans]
                  .filter(([, plan]) => plan.kind === "attention")
                  .map(([groupId]) => groupId);

    const groups = ids
        .slice(query.offset, query.offset + query.limit)
        .map((groupId) => {
            const row = dupeRepo.findGroup(groupId);

            return row
                ? toGroup({
                      id: row.id,
                      kind: row.kind,
                      reviewed: row.reviewed === 1,
                      memberCount: 0,
                      createdAt: row.createdAt,
                  })
                : null;
        })
        .filter((group): group is DupeGroup => group !== null);

    return { summary: summarize(plans), total: ids.length, groups };
};

/**
 * One batch of trashing every identical copy (§10e).
 *
 * Each group is decided exactly as the review sheet would decide it with the rule's keeper
 * chosen -- through `resolveOne`, which re-reads the group, trashes only the copies named, and
 * marks it reviewed once nothing is left to decide. The plan is made again for every batch, so
 * a group edited, reviewed or given clips since the run began is judged as it is now.
 *
 * In group-id order from `after`, so each group is tried once per run: one that refused keeps
 * its place in the queue rather than being retried by every batch after it.
 */
export const trashIdentical = async (
    request: IdenticalTrashRequest,
    auth: AuthContext
): Promise<IdenticalTrashResponse> => {
    requireAdmin(auth);

    if (!auth.scopes.includes("delete")) {
        throw new AuthorizationError("You do not have permission to delete files");
    }

    const ahead = routineOf(identicalPlans(request.media))
        .filter(([groupId]) => request.after === null || groupId > request.after)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    const batch = ahead.slice(0, request.limit);
    const failed: BulkActionFailure[] = [];
    let trashed = 0;

    for (const [groupId, plan] of batch) {
        const outcome = await resolveOne(
            { groupId, keepId: plan.keepId, trashIds: plan.trashIds },
            auth
        );

        trashed += outcome.trashed;
        failed.push(...outcome.failed);
    }

    const remaining = ahead.length - batch.length;

    return {
        groups: batch.length,
        trashed,
        failed,
        cursor: remaining > 0 ? (batch.at(-1)?.[0] ?? null) : null,
        remaining,
    };
};

/**
 * Marks groups reviewed, or reopens them. Touches no file (§10c).
 *
 * Ids that no longer exist are skipped rather than refused: a group pruned between the page
 * loading and the press was resolved by somebody, which is what marking it wanted anyway, and
 * one stale row must not fail the rest of the page.
 */
export const setReviewed = (groupIds: string[], reviewed: boolean, auth: AuthContext): number => {
    requireAdmin(auth);

    return dupeRepo.markReviewedMany(groupIds, reviewed);
};

/**
 * Queues a fresh clustering pass.
 *
 * Idempotent by way of the job queue's uniqueness index, so an impatient admin clicking
 * twice gets one pass rather than two competing ones.
 */
export const requestRescan = (auth: AuthContext): void => {
    requireAdmin(auth);

    dupeRepo.enqueueRescan();
};

const failureReason = (error: unknown): string =>
    error instanceof Error && error.message ? error.message : "Could not be deleted";

/**
 * One group's decision: keep one copy, trash the ones named (§10c).
 *
 * **Only copies that are named *and* still in the group are touched.** The request lists what
 * the reviewer saw going to the bin, and the group is read again here; a copy the clustering
 * pass merged in since the page loaded is in the group but not in the list, so it is left
 * alone and the group stays in the queue with it. A named copy that is no longer in the group
 * — trashed from its own page meanwhile — is reported rather than silently dropped.
 *
 * **The keeper has to still be here, or nothing is touched.** Removing "the others" around a
 * keeper that has already gone could leave no copy at all.
 */
const resolveOne = async (item: DupeResolveItem, auth: AuthContext): Promise<DupeGroupOutcome> => {
    const outcome = (fields: Partial<DupeGroupOutcome>): DupeGroupOutcome => ({
        groupId: item.groupId,
        keptId: item.keepId,
        trashed: 0,
        failed: [],
        reviewed: false,
        refused: null,
        ...fields,
    });

    if (!dupeRepo.findGroup(item.groupId)) {
        return outcome({ refused: "This group no longer exists" });
    }

    /**
     * The members with a file still attached, not `DupeMember` rows — the same read the page
     * renders from, so "in the group" means a card that could have been on screen.
     */
    const byId = new Map(loadMembers(item.groupId).map((row) => [row.id, row]));

    if (!byId.has(item.keepId)) {
        return outcome({ refused: "The copy to keep is no longer one of this group's copies" });
    }

    const failed: BulkActionFailure[] = [];
    let trashed = 0;

    /**
     * One at a time, like every other multi-item deletion (§14b).
     *
     * The free-space check each copy makes is only meaningful once the previous copy has been
     * accepted, and a failure is recorded against its copy rather than ending the run — the
     * copies that *can* go should still go.
     */
    for (const mediaId of new Set(item.trashIds)) {
        if (!byId.has(mediaId)) {
            failed.push({ mediaId, reason: "No longer one of this group's copies" });
            continue;
        }

        try {
            await trashMedia(mediaId, auth);
            trashed += 1;
            byId.delete(mediaId);
        } catch (error) {
            failed.push({ mediaId, reason: failureReason(error) });
        }
    }

    /**
     * Reviewed only when nothing is left to decide.
     *
     * That is: no failures, and every copy still here besides the keeper on a read-only root,
     * where no decision could ever remove it. A group still holding a deletable copy — one that
     * failed, or one merged in since the page loaded — stays in the queue, because hiding it
     * would take it off the only screen that can finish the job.
     */
    const leftovers = [...byId.values()].filter((row) => row.id !== item.keepId);
    const reviewed = failed.length === 0 && leftovers.every((row) => row.writable !== 1);

    if (reviewed) {
        dupeRepo.markReviewed(item.groupId, true);
    }

    return outcome({ trashed, failed, reviewed });
};

/**
 * Resolves a page of groups in one request (§10c).
 *
 * The triage sheet shows a page of groups with the recommended keeper preselected, and the
 * reviewer accepts it in one press — the difference between an 87-page queue that gets worked
 * through and one that gets read. Each group is its own decision and is reported on its own;
 * one stale row refuses itself and the rest go ahead.
 *
 * **Both scopes, and the `delete` one is checked here rather than only per copy.** Reviewing
 * is admin-only (see above) and `trashMedia` enforces `delete` on each copy — but reached
 * through it, an admin without `delete` would get one identical failure per copy for a
 * permission that was never going to apply to any of them.
 *
 * A keeper listed among its own group's copies to trash is refused before anything moves: that
 * is a client bug rather than a stale page, and it is the one that would empty a group.
 */
export const resolveGroups = async (
    items: DupeResolveItem[],
    auth: AuthContext
): Promise<DupeResolveResponse> => {
    requireAdmin(auth);

    if (!auth.scopes.includes("delete")) {
        throw new AuthorizationError("You do not have permission to delete files");
    }

    if (items.some((item) => item.trashIds.includes(item.keepId))) {
        throw new ValidationError("The copy to keep cannot also be one to trash");
    }

    const groups: DupeGroupOutcome[] = [];

    for (const item of items) {
        groups.push(await resolveOne(item, auth));
    }

    return { groups };
};

/**
 * An item's other copies, for its delete confirmation (§10d).
 *
 * **Not admin-only, unlike everything above.** Anybody who may delete the item may be asked
 * whether its copies should go too, and cannot answer without seeing them. What made the review
 * screen admin-only -- a group is a cross-root object, and listing it would show items in roots
 * the viewer was never granted -- is answered here by listing only copies in the viewer's own
 * roots. The ranking still reads every copy, so "Best copy" means what it means on the detail.
 */
export const listCopies = (mediaId: string, auth: AuthContext): MediaCopiesResponse => {
    if (!mediaRepo.findDetail(mediaId, auth.userId, auth.accessibleRootIds)) {
        throw new NotFoundError("Media not found");
    }

    const rows = loadCopies(mediaId);
    const item = rows.find((row) => row.id === mediaId);

    if (!item || rows.length < 2) {
        return { copies: [] };
    }

    const { ranked, ordered } = rankRows(rows);
    const visible = new Set(auth.accessibleRootIds);
    const itemCover = coverUrl(item.id, item.coverPath, item.coverGeneratedAt);

    const copies = ordered
        .filter((row) => row.id !== mediaId && visible.has(row.rootId))
        .map((row): MediaCopy => {
            const member = toMember(row, ranked);
            const identical = item.contentHash !== null && row.contentHash === item.contentHash;

            return {
                ...member,
                identical,
                best: ranked[0]?.mediaId === row.id,
                caution: identical
                    ? null
                    : copyCaution({ ...item, coverUrl: itemCover }, { ...row, ...member }),
            };
        });

    return { copies };
};

/**
 * Trashes an item and the copies ticked with it (§10d).
 *
 * **Worst first, best last.** Each trash hands the departing copy's ratings, tags and playlist
 * places to the best copy still in the library (§10c). In this order that is the best of the
 * ones going, right up until it goes itself -- so when the whole group goes, everything anybody
 * recorded ends up on the one copy worth restoring, rather than scattered across the bin. When
 * some copy stays, it inherits exactly as it would have from a single deletion.
 *
 * **Only copies that are named *and* still copies of the item are touched**, for the reason
 * `resolveOne` gives: the group can have changed since the dialog opened. And one at a time, a
 * failure recorded against its copy rather than ending the run, like every multi-item deletion.
 *
 * Without copies it is the single deletion it always was, errors and all.
 */
export const trashWithCopies = async (
    mediaId: string,
    alsoTrash: string[],
    auth: AuthContext
): Promise<TrashMediaResponse> => {
    if (alsoTrash.length === 0) {
        await trashMedia(mediaId, auth);

        return { trashed: [mediaId], failed: [] };
    }

    // Checked once here: through `trashMedia` it would be one identical failure per copy.
    if (!auth.scopes.includes("delete")) {
        throw new AuthorizationError("You do not have permission to delete files");
    }

    const { copies } = listCopies(mediaId, auth);
    const current = new Set(copies.map((copy) => copy.id));
    const failed: BulkActionFailure[] = [];
    const targets = new Set([mediaId]);

    for (const id of new Set(alsoTrash)) {
        if (id === mediaId) continue;

        if (current.has(id)) {
            targets.add(id);
        } else {
            failed.push({ mediaId: id, reason: "No longer one of this item's copies" });
        }
    }

    const worstFirst = rankCopies(dupeRepo.activeCopies(mediaId))
        .map((copy) => copy.mediaId)
        .filter((id) => targets.has(id))
        .reverse();

    // An item already in the bin is not among the active copies; asked for anyway, so its
    // failure is reported rather than the item quietly missing from both lists.
    if (!worstFirst.includes(mediaId)) {
        worstFirst.unshift(mediaId);
    }

    const trashed: string[] = [];

    for (const id of worstFirst) {
        try {
            await trashMedia(id, auth);
            trashed.push(id);
        } catch (error) {
            failed.push({ mediaId: id, reason: failureReason(error) });
        }
    }

    return { trashed, failed };
};

/**
 * Sorts a look-alike group into what is the same thing and what is not (§10i).
 *
 * Records a verdict for every pair -- the same within a set, different across -- and replaces
 * the group with one per set of two or more, in one transaction. Clustering then never joins a
 * pair said to differ, so the sorting outlasts every later pass. Then, for each set the reviewer
 * also chose a keeper for, resolves it exactly as a row would (`resolveOne`): the copies named go
 * to the bin, and the copy kept inherits only from copies of the same thing.
 *
 * **Every copy the row showed, and only those.** A copy merged in since the page loaded has had
 * nothing said about it, and placing it in a set by default would be saying it on the reviewer's
 * behalf; the request is refused and nothing is recorded.
 */
export const sortGroup = async (
    input: DupeSortInput,
    auth: AuthContext
): Promise<DupeSortResponse> => {
    requireAdmin(auth);

    const group = dupeRepo.findGroup(input.groupId);

    if (!group) {
        throw new ConflictError("This group has changed since the page loaded");
    }

    if (group.kind !== "near") {
        throw new ValidationError("Identical files are the same thing; there is nothing to sort");
    }

    const named = input.sets.flatMap((set) => set.ids);

    if (new Set(named).size !== named.length) {
        throw new ValidationError("A copy can be in only one set");
    }

    const live = new Set(loadMembers(input.groupId).map((row) => row.id));

    if (named.length !== live.size || named.some((id) => !live.has(id))) {
        throw new ConflictError(
            "This group has changed since the page loaded. Nothing was recorded; look again."
        );
    }

    for (const set of input.sets) {
        if (set.keepId !== null && !set.ids.includes(set.keepId)) {
            throw new ValidationError("The copy to keep must be in its own set");
        }

        if (
            set.trashIds.some((id) => !set.ids.includes(id) || id === set.keepId) ||
            (set.trashIds.length > 0 && set.keepId === null)
        ) {
            throw new ValidationError(
                "Only other copies in a set can go, and only beside a keeper"
            );
        }
    }

    const resolving = input.sets.some((set) => set.trashIds.length > 0);

    if (resolving && !auth.scopes.includes("delete")) {
        throw new AuthorizationError("You do not have permission to delete files");
    }

    // Copies left together without being called the same: nothing is said among them.
    const unsaid = new Set(input.sets.filter((set) => !set.alike).flatMap((set) => set.ids));
    const groupIds = dupeRepo.recordSorting({
        groupId: input.groupId,
        decisionId: randomUUID(),
        userId: auth.userId,
        verdicts: verdictsOfSets(input.sets.map((set) => set.ids))
            .filter((pair) => pair.verdict === "different" || !unsaid.has(pair.a))
            .map((pair) => ({ aId: pair.a, bId: pair.b, verdict: pair.verdict })),
        sets: input.sets.map((set) => set.ids),
    });

    const groups: DupeGroupOutcome[] = [];
    let kept = 0;

    for (const [index, set] of input.sets.entries()) {
        const groupId = groupIds[index];

        if (!groupId) continue;

        if (set.keepId !== null && set.trashIds.length > 0) {
            groups.push(
                await resolveOne({ groupId, keepId: set.keepId, trashIds: set.trashIds }, auth)
            );
        } else {
            kept += 1;
        }
    }

    return { groups, kept };
};

/** What the Reviewed tab draws of a copy in a decision: its name, its cover, and whether it is still here. */
const apartCopies = (mediaIds: string[]): Map<string, DupeApartCopy> => {
    if (mediaIds.length === 0) {
        return new Map();
    }

    const rows = db
        .prepare(
            `SELECT ${MEMBER_SELECT}, f."state"
               FROM (SELECT value AS "mediaId" FROM json_each(?)) dm
               ${MEMBER_JOINS}`
        )
        .all(JSON.stringify(mediaIds)) as (MemberRow & { state: string })[];

    return new Map(
        rows.map((row) => [
            row.id,
            {
                id: row.id,
                title: row.title ?? row.relPath,
                coverUrl: coverUrl(row.id, row.coverPath, row.coverGeneratedAt),
                active: row.state === "active",
            },
        ])
    );
};

/**
 * The sortings that kept copies apart, newest first, each with the sets it made (§10i).
 *
 * The sets are rebuilt from the decision's own verdicts: copies it called the same are one set,
 * and a copy it called the same as none of them is on its own.
 */
export const listApart = (query: DupeApartQuery, auth: AuthContext): DupeApartListResponse => {
    requireAdmin(auth);

    const decisions = dupeRepo.listApartDecisions(query.limit, query.offset).map((decision) => {
        const pairs = dupeRepo.verdictsOf(decision.decisionId);
        const items = [...new Set(pairs.flatMap((pair) => [pair.aId, pair.bId]))].sort();
        const setOf = new Map(items.map((id) => [id, id]));
        const root = (id: string): string => {
            let at = id;

            while (setOf.get(at) !== at) at = setOf.get(at)!;

            return at;
        };

        for (const pair of pairs) {
            if (pair.verdict === "same") setOf.set(root(pair.aId), root(pair.bId));
        }

        const sets = new Map<string, string[]>();

        for (const id of items) {
            sets.set(root(id), [...(sets.get(root(id)) ?? []), id]);
        }

        return { decision, sets: [...sets.values()] };
    });

    const copies = apartCopies([...new Set(decisions.flatMap(({ sets }) => sets.flat()))]);

    return {
        decisions: decisions.map(({ decision, sets }) => ({
            id: decision.decisionId,
            decidedAt: decision.decidedAt,
            decidedBy: decision.decidedBy,
            sets: sets
                .map((set) =>
                    set
                        .map((id) => copies.get(id))
                        .filter((copy): copy is DupeApartCopy => copy !== undefined)
                )
                .filter((set) => set.length > 0),
        })),
        total: dupeRepo.countApartDecisions(),
    };
};

/**
 * Takes a sorting back (§10i). Its verdicts go and its copies are compared again on the next
 * pass, which regroups them as it would have before anybody sorted them.
 */
export const undoApart = (decisionId: string, auth: AuthContext): { items: number } => {
    requireAdmin(auth);

    const items = dupeRepo.undoDecision(decisionId);

    if (items.length === 0) {
        throw new NotFoundError("That decision has already been taken back");
    }

    dupeRepo.enqueueRescan();

    return { items: items.length };
};
