import Database from "better-sqlite3";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
    mediaKinds,
    mediaQuerySchema,
    type FilterGroup,
    type FilterRule,
    type MediaKind,
    type MediaQuery,
} from "@private-stock/core";

import { initializeDatabase } from "../init.js";

/**
 * No filter may return a partial set, under any sort (§20).
 *
 * The bug this exists for: favourites under Shuffle showed a handful of items and hid the
 * rest on pages nobody had a reason to visit, because the shuffle chose rows first and
 * filtered afterwards. Every page looked plausible; the set was wrong. So nothing here looks
 * at one page — every combination is walked to the end and the union is compared with a
 * brute-force model of the fixture.
 *
 * The fixture is built to hit the edges that make paging lie: equal sort values, NULLs in
 * every sortable column, rows that are not listable, rows this viewer has hidden, holes in
 * the rowid space, and a second account whose ratings and private tags must not leak in.
 *
 * The boolean half of a filter (§14e) is checked the same way: `notTags` and every kind of
 * group rule are answered by the model below, so "any of", "none of" and "my favourite
 * performers" are held to the same standard as the flat fields.
 */

let db: Database.Database;

vi.mock("../db", async () => {
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const instance = new BetterSqlite3(":memory:");
    instance.pragma("foreign_keys = ON");

    return { db: instance, getDb: () => instance };
});

const mediaRepo = await import("./mediaRepo.js");
const tagRepo = await import("./tagRepo.js");
const userMediaRepo = await import("./userMediaRepo.js");
const userTagRepo = await import("./userTagRepo.js");
const { db: sharedDb } = await import("../db.js");

const ROOT = "aaaaaaaa-0000-4000-8000-000000000000";
const USER = "99999999-0000-4000-8000-000000000000";
const OWNER = "99999999-0000-4000-8000-000000000001";
const ITEMS = 150;
const PAGE = 7;

interface Overlay {
    favorite: boolean;
    rating: number | null;
    watched: boolean;
    hidden: boolean;
}

interface Model {
    id: string;
    kind: "video" | "image";
    durationMs: number | null;
    width: number | null;
    height: number | null;
    bitrate: number | null;
    fps: number | null;
    animated: boolean;
    size: number;
    listable: boolean;
    tags: Set<string>;
    overlays: Record<string, Overlay>;
}

const models: Model[] = [];
const tags: Record<string, string> = {};
/** Facet of each tag key, for `favTags` and `untagged`. */
const kindOf: Record<string, string> = {};
/** Each account's favourite tag ids (§6 "Favourite tags"). */
const favorites: Record<string, Set<string>> = {};

const id = (n: number): string => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;

const pick = <T>(values: T[], n: number): T => values[n % values.length] as T;

const overlayFor = (userId: string, n: number): Overlay =>
    userId === USER
        ? {
              favorite: n % 4 === 0,
              rating: n % 6 === 0 ? null : (n % 5) + 1,
              watched: n % 3 === 1,
              hidden: n % 29 === 0,
          }
        : {
              favorite: n % 5 === 0,
              rating: n % 2 === 0 ? (n % 3) + 1 : null,
              watched: n % 4 === 1,
              hidden: n % 31 === 0,
          };

const insertItem = (n: number): Model => {
    const kind = n % 3 === 0 ? "image" : "video";
    const video = kind === "video";
    const measured = n % 7 !== 0;
    const model: Model = {
        id: id(n),
        kind,
        durationMs: video && n % 5 !== 0 ? (n % 17) * 60_000 : null,
        width: measured ? pick([1920, 1080, 1280, 720, 1000], n) : null,
        height: measured ? pick([1080, 1920, 720, 1280, 1000], n >> 1) : null,
        bitrate: video ? (n % 11) * 1_000_000 : null,
        fps: video ? pick([24, 30, 60, null], n) : null,
        animated: !video && n % 2 === 0,
        size: (n % 13) * 50 * 1024 * 1024,
        listable: n % 19 !== 0 && n % 23 !== 0,
        tags: new Set(),
        overlays: {},
    };

    db.prepare(
        `INSERT INTO "Media" ("id", "kind", "title", "durationMs", "width", "height", "bitrate",
                              "fps", "isAnimated", "addedAt", "capturedAt", "probedAt",
                              "updatedAt")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).run(
        model.id,
        kind,
        // Titles, dates and sizes collide on purpose: ties are where offset paging repeats
        // or skips rows unless the tiebreak holds.
        `Title ${n % 40}`,
        model.durationMs,
        model.width,
        model.height,
        model.bitrate,
        model.fps,
        model.animated ? 1 : null,
        `2026-01-${String((n % 20) + 1).padStart(2, "0")} 00:00:00`,
        n % 6 === 0 ? null : `2025-0${(n % 9) + 1}-01 00:00:00`
    );

    const fileId = `f${String(n).padStart(7, "0")}-0000-4000-8000-000000000000`;

    db.prepare(
        `INSERT INTO "MediaFile" ("id", "rootId", "relPath", "size", "mtime", "state",
                                  "classification", "lastSeenAt", "updatedAt")
         VALUES (?, ?, ?, ?, 0, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).run(
        fileId,
        ROOT,
        `item-${n}.mp4`,
        model.size,
        n % 19 === 0 ? "trashed" : "active",
        n % 23 === 0 ? "companion" : "media"
    );

    db.prepare(
        `INSERT INTO "MediaFileLink" ("id", "mediaId", "fileId", "role")
         VALUES (?, ?, ?, 'original')`
    ).run(`l${String(n).padStart(7, "0")}-0000-4000-8000-000000000000`, model.id, fileId);

    for (const userId of [USER, OWNER]) {
        const overlay = overlayFor(userId, n);

        model.overlays[userId] = overlay;
        userMediaRepo.setFavorite(userId, model.id, overlay.favorite);
        userMediaRepo.setRating(userId, model.id, overlay.rating);
        userMediaRepo.setWatched(userId, model.id, overlay.watched);
        userMediaRepo.setHidden(userId, model.id, overlay.hidden);
    }

    return model;
};

beforeAll(() => {
    db = sharedDb as unknown as Database.Database;
    initializeDatabase(db);

    db.prepare(
        `INSERT INTO "MediaRoot" ("id", "path", "label", "enabled", "updatedAt")
         VALUES (?, 'videos', 'Videos', 1, CURRENT_TIMESTAMP)`
    ).run(ROOT);

    for (const [userId, email] of [
        [USER, "user@example.test"],
        [OWNER, "owner@example.test"],
    ]) {
        db.prepare(
            `INSERT INTO "User" ("id", "email", "displayName", "password", "updatedAt")
             VALUES (?, ?, 'User', 'x', CURRENT_TIMESTAMP)`
        ).run(userId, email);
    }

    tags.drama = tagRepo.ensureTag("genre", "Drama", null, USER);
    tags.noir = tagRepo.ensureTag("genre", "Noir", null, USER);
    tags.mine = tagRepo.ensureTag("tag", "Mine", USER, USER);
    tags.theirs = tagRepo.ensureTag("tag", "Theirs", OWNER, OWNER);

    for (const [key, kind] of [
        ["drama", "genre"],
        ["noir", "genre"],
        ["mine", "tag"],
        ["theirs", "tag"],
    ] as const) {
        kindOf[tags[key] as string] = kind;
    }

    // Each account favours a different genre, and its own private keyword. The owner's private
    // favourite is one the viewer cannot see assignments of, so it must match nothing for them.
    favorites[USER] = new Set([tags.noir as string, tags.mine as string]);
    favorites[OWNER] = new Set([tags.drama as string, tags.theirs as string]);

    for (const [userId, ids] of Object.entries(favorites)) {
        for (const tagId of ids) userTagRepo.setFavorite(userId, tagId, true);
    }

    for (let n = 1; n <= ITEMS; n += 1) {
        const model = insertItem(n);

        const assign = (key: string, userId: string | null, applies: boolean): void => {
            if (!applies) return;

            tagRepo.assign({
                mediaId: model.id,
                tagId: tags[key] as string,
                userId,
                createdById: userId ?? USER,
            });

            // Somebody else's private tag is not a tag this viewer can filter by.
            if (userId === null || userId === USER) model.tags.add(tags[key] as string);
        };

        assign("drama", null, n % 2 === 0);
        assign("noir", null, n % 3 === 0);
        assign("mine", USER, n % 5 === 0);
        assign("theirs", OWNER, n % 7 === 0);

        models.push(model);
    }

    // Holes in the rowid space, which a shuffle keyed on rowid has to survive.
    db.prepare(
        `DELETE FROM "Media" WHERE "rowid" IN (SELECT "rowid" FROM "Media" WHERE "rowid" % 17 = 0)`
    ).run();

    const surviving = new Set(
        (db.prepare(`SELECT "id" FROM "Media"`).all() as { id: string }[]).map((row) => row.id)
    );

    models.splice(0, models.length, ...models.filter((model) => surviving.has(model.id)));
});

type Filter = Partial<MediaQuery>;

const within = (value: number | null, min?: number, max?: number, scale = 1): boolean => {
    if (min === undefined && max === undefined) return true;
    if (value === null) return false;
    if (min !== undefined && value < min * scale) return false;
    if (max !== undefined && value >= max * scale) return false;

    return true;
};

const shorterSide = (model: Model): number | null =>
    model.width === null || model.height === null ? null : Math.min(model.width, model.height);

const orientationIs = (model: Model, value: "landscape" | "portrait" | "square"): boolean => {
    const { width, height } = model;

    if (value === "landscape") return width !== null && height !== null && width > height;
    if (value === "portrait") return width !== null && height !== null && height > width;

    return width !== null && width === height;
};

const animatedIs = (model: Model, value: "yes" | "no"): boolean =>
    model.kind === "image" && (value === "yes" ? model.animated : !model.animated);

const MEASURE_OF: Record<string, [(model: Model) => number | null, number]> = {
    durationSec: [(model) => model.durationMs, 1_000],
    bitrateKbps: [(model) => model.bitrate, 1_000],
    fps: [(model) => model.fps, 1],
    resolution: [shorterSide, 1],
    sizeMb: [(model) => model.size, 1_024 * 1_024],
};

/** One group rule, answered from the fixture. */
const ruleHolds = (rule: FilterRule, model: Model, rated: Overlay, favUser: string): boolean => {
    const mine = model.overlays[USER] as Overlay;

    switch (rule.t) {
        case "tag":
            return model.tags.has(rule.id);
        case "favTags":
            return [...model.tags].some(
                (tagId) => kindOf[tagId] === rule.kind && favorites[favUser]?.has(tagId)
            );
        case "untagged":
            return ![...model.tags].some((tagId) => kindOf[tagId] === rule.kind);
        case "favorite":
            return rated.favorite;
        case "unrated":
            return rated.rating === null;
        case "rating":
            return (
                rated.rating !== null &&
                (rule.min === undefined || rated.rating >= rule.min) &&
                (rule.max === undefined || rated.rating <= rule.max)
            );
        case "watched":
            return rule.value === "yes" ? mine.watched : !mine.watched;
        case "measure": {
            const [read, scale] = MEASURE_OF[rule.measure] as [
                (model: Model) => number | null,
                number,
            ];

            return within(read(model), rule.min, rule.max, scale);
        }
        case "orientation":
            return orientationIs(model, rule.value);
        case "animated":
            return animatedIs(model, rule.value);
        case "kind":
            return model.kind === rule.value;
        case "root":
            return rule.id === ROOT;
    }
};

const groupHolds = (group: FilterGroup, model: Model, rated: Overlay, favUser: string) => {
    const results = group.rules.map((rule) => ruleHolds(rule, model, rated, favUser));

    if (group.match === "all") return results.every(Boolean);
    if (group.match === "any") return results.some(Boolean);

    return !results.some(Boolean);
};

/** The same question, answered by reading the fixture rather than by running SQL. */
const expected = (filter: Filter, overlayUserId?: string): string[] =>
    models
        .filter((model) => {
            const mine = model.overlays[USER] as Overlay;
            const rated = model.overlays[overlayUserId ?? USER] as Overlay;
            const shorter = shorterSide(model);

            if (!model.listable || mine.hidden) return false;
            if (filter.kind && model.kind !== filter.kind) return false;
            if (filter.tags && !filter.tags.every((tag) => model.tags.has(tag))) return false;
            if (filter.notTags && filter.notTags.some((tag) => model.tags.has(tag))) return false;
            if (
                filter.groups &&
                !filter.groups.every((group) =>
                    groupHolds(group, model, rated, overlayUserId ?? USER)
                )
            )
                return false;
            if (filter.favorite && !rated.favorite) return false;
            if (filter.unrated && rated.rating !== null) return false;
            if (filter.watched === "yes" && !mine.watched) return false;
            if (filter.watched === "no" && mine.watched) return false;
            if (
                filter.minRating !== undefined &&
                (rated.rating === null || rated.rating < filter.minRating)
            )
                return false;
            if (
                filter.maxRating !== undefined &&
                (rated.rating === null || rated.rating > filter.maxRating)
            )
                return false;
            if (!within(model.durationMs, filter.minDurationSec, filter.maxDurationSec, 1_000))
                return false;
            if (!within(model.bitrate, filter.minBitrateKbps, filter.maxBitrateKbps, 1_000))
                return false;
            if (!within(model.fps, filter.minFps, filter.maxFps)) return false;
            if (!within(shorter, filter.minResolution, filter.maxResolution)) return false;
            if (!within(model.size, filter.minSizeMb, filter.maxSizeMb, 1_024 * 1_024))
                return false;
            if (filter.orientation && !orientationIs(model, filter.orientation)) return false;
            if (filter.animated && !animatedIs(model, filter.animated)) return false;

            return true;
        })
        .map((model) => model.id)
        .sort();

const FILTERS: [string, () => Filter][] = [
    ["nothing", () => ({})],
    ["favourites", () => ({ favorite: true })],
    ["unrated", () => ({ unrated: true })],
    ["watched", () => ({ watched: "yes" })],
    ["unwatched", () => ({ watched: "no" })],
    ["three stars and up", () => ({ minRating: 3 })],
    ["two stars or less", () => ({ maxRating: 2 })],
    ["exactly four stars", () => ({ minRating: 4, maxRating: 4 })],
    ["videos", () => ({ kind: "video" })],
    ["images", () => ({ kind: "image" })],
    ["one library tag", () => ({ tags: [tags.drama as string] })],
    ["two library tags", () => ({ tags: [tags.drama as string, tags.noir as string] })],
    ["a private tag of mine", () => ({ tags: [tags.mine as string] })],
    ["somebody else's private tag", () => ({ tags: [tags.theirs as string] })],
    ["duration band", () => ({ kind: "video", minDurationSec: 120, maxDurationSec: 600 })],
    ["bitrate floor", () => ({ kind: "video", minBitrateKbps: 3_000 })],
    ["frame rate band", () => ({ kind: "video", minFps: 30, maxFps: 61 })],
    ["resolution band", () => ({ minResolution: 720, maxResolution: 1_080 })],
    ["size floor", () => ({ minSizeMb: 200 })],
    ["landscape", () => ({ orientation: "landscape" })],
    ["portrait", () => ({ orientation: "portrait" })],
    ["square", () => ({ orientation: "square" })],
    ["animated", () => ({ animated: "yes" })],
    ["stills", () => ({ animated: "no" })],
    ["favourite videos rated two up", () => ({ favorite: true, kind: "video", minRating: 2 })],
    [
        "favourite and unwatched, tagged",
        () => ({ favorite: true, watched: "no", tags: [tags.drama as string] }),
    ],

    // The boolean half (§14e).
    [
        "any of two tags",
        () => ({
            groups: [
                {
                    match: "any",
                    facet: "genre",
                    rules: [
                        { t: "tag", id: tags.drama as string },
                        { t: "tag", id: tags.noir as string },
                    ],
                },
            ],
        }),
    ],
    [
        "all of two tags, as a group",
        () => ({
            groups: [
                {
                    match: "all",
                    rules: [
                        { t: "tag", id: tags.drama as string },
                        { t: "tag", id: tags.noir as string },
                    ],
                },
            ],
        }),
    ],
    [
        "one tag without another",
        () => ({ tags: [tags.drama as string], notTags: [tags.noir as string] }),
    ],
    ["without a private tag of mine", () => ({ notTags: [tags.mine as string] })],
    ["without somebody else's private tag", () => ({ notTags: [tags.theirs as string] })],
    [
        "any of my favourite genres, unwatched",
        () => ({
            watched: "no",
            groups: [{ match: "any", facet: "genre", rules: [{ t: "favTags", kind: "genre" }] }],
        }),
    ],
    [
        "any of my favourite keywords",
        () => ({ groups: [{ match: "any", rules: [{ t: "favTags", kind: "tag" }] }] }),
    ],
    [
        "a favourite genre or a private tag of mine",
        () => ({
            groups: [
                {
                    match: "any",
                    facet: "genre",
                    rules: [
                        { t: "favTags", kind: "genre" },
                        { t: "tag", id: tags.mine as string },
                    ],
                },
            ],
        }),
    ],
    [
        "somebody else's private tag inside an any-group",
        () => ({
            groups: [
                {
                    match: "any",
                    rules: [
                        { t: "tag", id: tags.theirs as string },
                        { t: "kind", value: "image" },
                    ],
                },
            ],
        }),
    ],
    [
        "unrated or two stars at most, with a tag",
        () => ({
            tags: [tags.drama as string],
            groups: [
                {
                    match: "any",
                    rules: [{ t: "unrated" }, { t: "rating", max: 2 }],
                },
            ],
        }),
    ],
    [
        "none of: three stars up (unrated items stay)",
        () => ({ groups: [{ match: "none", rules: [{ t: "rating", min: 3 }] }] }),
    ],
    [
        "none of: two tags",
        () => ({
            groups: [
                {
                    match: "none",
                    rules: [
                        { t: "tag", id: tags.drama as string },
                        { t: "tag", id: tags.noir as string },
                    ],
                },
            ],
        }),
    ],
    [
        "high resolution or long",
        () => ({
            groups: [
                {
                    match: "any",
                    rules: [
                        { t: "measure", measure: "resolution", min: 1_080 },
                        { t: "measure", measure: "durationSec", min: 600 },
                    ],
                },
            ],
        }),
    ],
    [
        "not portrait",
        () => ({ groups: [{ match: "none", rules: [{ t: "orientation", value: "portrait" }] }] }),
    ],
    [
        "no genre tagged yet",
        () => ({ groups: [{ match: "all", rules: [{ t: "untagged", kind: "genre" }] }] }),
    ],
    [
        "a group measure beside a flat bound on the same measure",
        () => ({
            minDurationSec: 60,
            groups: [
                {
                    match: "any",
                    rules: [
                        { t: "measure", measure: "durationSec", max: 300 },
                        { t: "animated", value: "yes" },
                    ],
                },
            ],
        }),
    ],
    // "Any of" groups made only of rules with an index of their own, which a count, a kept order
    // and a shuffled page start from rather than test on every item (§20, `groupSourceSql`).
    [
        "a favourite genre, four stars up, or a favourite",
        () => ({
            groups: [
                {
                    match: "any",
                    rules: [
                        { t: "favTags", kind: "genre" },
                        { t: "rating", min: 4 },
                        { t: "favorite" },
                    ],
                },
            ],
        }),
    ],
    [
        "a rating band or a tag, videos not portrait",
        () => ({
            kind: "video",
            groups: [
                {
                    match: "any",
                    rules: [
                        { t: "rating", min: 2, max: 3 },
                        { t: "tag", id: tags.drama as string },
                    ],
                },
                { match: "none", rules: [{ t: "orientation", value: "portrait" }] },
            ],
        }),
    ],
    [
        "a lone favourite as an all group, landscape",
        () => ({
            orientation: "landscape",
            groups: [{ match: "all", rules: [{ t: "favorite" }] }],
        }),
    ],
    [
        "two tags or my favourite keywords, unwatched, without a private tag",
        () => ({
            watched: "no",
            notTags: [tags.mine as string],
            groups: [
                {
                    match: "any",
                    rules: [
                        { t: "tag", id: tags.noir as string },
                        { t: "favTags", kind: "tag" },
                        { t: "tag", id: tags.theirs as string },
                    ],
                },
            ],
        }),
    ],
    [
        "favourite or watched, in two groups",
        () => ({
            groups: [
                { match: "any", rules: [{ t: "favorite" }, { t: "watched", value: "yes" }] },
                {
                    match: "all",
                    rules: [
                        { t: "kind", value: "video" },
                        { t: "root", id: ROOT },
                    ],
                },
            ],
        }),
    ],
];

const SORTS: MediaQuery["sort"][] = [
    "addedAt",
    "capturedAt",
    "title",
    "duration",
    "size",
    "rating",
    "random",
];

const DIRECTIONS = ["asc", "desc"] as const;

/**
 * Every page, to the end, with the properties a partial set would break asserted as it goes.
 */
const walk = (
    filter: Filter,
    sort: MediaQuery["sort"],
    direction: "asc" | "desc",
    overlayUserId?: string
) => {
    const seen: string[] = [];
    const base = mediaQuerySchema.parse({ sort, direction, seed: 11, limit: PAGE });

    for (let page = 0; page < 200; page += 1) {
        const result = mediaRepo.listMedia(
            { ...base, ...filter, page },
            USER,
            [ROOT],
            overlayUserId
        );

        seen.push(...result.rows.map((row) => row.id));

        if (!result.hasMore) {
            return seen;
        }

        // A page that is not the last one is full. A short page in the middle is how a
        // partial set looks from the inside.
        expect(result.rows, `page ${page} short with more to come`).toHaveLength(PAGE);
    }

    throw new Error("Paging did not terminate");
};

describe.each([
    ["the viewer's ratings", undefined],
    ["a shared filter's owner's ratings", OWNER],
])("every filter under every sort, resolved against %s", (_label, overlayUserId) => {
    describe.each(FILTERS)("%s", (_name, makeFilter) => {
        it.each(SORTS.flatMap((sort) => DIRECTIONS.map((direction) => [sort, direction] as const)))(
            "sorted by %s %s returns the whole set exactly once",
            (sort, direction) => {
                const filter = makeFilter();
                const want = expected(filter, overlayUserId);
                const seen = walk(filter, sort, direction, overlayUserId);

                expect(new Set(seen).size, "an item appeared on two pages").toBe(seen.length);
                expect([...seen].sort()).toEqual(want);

                const query = mediaQuerySchema.parse({ ...filter, sort, direction, seed: 11 });

                expect(mediaRepo.countMedia(query, USER, [ROOT], overlayUserId)).toBe(want.length);

                // A kept order holds the same set, each slot with its item's kind, and every
                // slot passes the filter asked of it item by item -- which is the condition a
                // group that the order was driven from is otherwise never tested by.
                const order = mediaRepo.orderedRowids(query, USER, [ROOT], 10_000, overlayUserId);
                const byRowid = new Map(
                    (
                        sharedDb.prepare(`SELECT "rowid", "id", "kind" FROM "Media"`).all() as {
                            rowid: number;
                            id: string;
                            kind: MediaKind;
                        }[]
                    ).map((row) => [row.rowid, row])
                );

                expect(order.rowids.map((rowid) => byRowid.get(rowid)?.id).sort()).toEqual(want);
                expect([...order.kinds].map((kind) => mediaKinds[kind])).toEqual(
                    order.rowids.map((rowid) => byRowid.get(rowid)?.kind)
                );
                expect(
                    mediaRepo.stillMatching(query, USER, [ROOT], order.rowids, overlayUserId)
                ).toHaveLength(order.rowids.length);
                expect(
                    mediaRepo.listMediaIds(query, USER, [ROOT], 10_000, overlayUserId).sort()
                ).toEqual(want);
            }
        );
    });
});

describe("the fixture", () => {
    it("is not trivially empty", () => {
        // A model that matched nothing would make every assertion above vacuous.
        expect(expected({ favorite: true }).length).toBeGreaterThan(PAGE * 2);
        expect(expected({ favorite: true }, OWNER).length).toBeGreaterThan(PAGE * 2);
        expect(models.length).toBeLessThan(ITEMS);
    });

    /**
     * Every boolean filter has to split the fixture, or the walk above proves nothing about it:
     * a group the model and the SQL both answered "everything" or "nothing" for would pass.
     */
    it("is split by every boolean filter, under both accounts", () => {
        const everything = expected({}).length;

        for (const [name, makeFilter] of FILTERS) {
            const filter = makeFilter();

            if (!filter.groups && !filter.notTags) continue;
            // Matching everything is the point of this one: a tag the viewer cannot see the
            // assignments of can exclude nothing.
            if (name === "without somebody else's private tag") continue;

            for (const overlayUserId of [undefined, OWNER]) {
                const count = expected(filter, overlayUserId).length;

                // The owner's favourite keyword is their own private tag, whose assignments the
                // viewer cannot see: nothing is the right answer, and the privacy guarantee.
                if (overlayUserId === OWNER && name === "any of my favourite keywords") {
                    expect(count).toBe(0);
                    continue;
                }

                expect(count, `${name} matches nothing`).toBeGreaterThan(0);
                expect(count, `${name} matches everything`).toBeLessThan(everything);
            }
        }
    });

    it("answers favourites per account", () => {
        const favorite = (overlayUserId?: string) =>
            expected(
                { groups: [{ match: "any", rules: [{ t: "favTags", kind: "genre" }] }] },
                overlayUserId
            );

        // The viewer favours Noir, the owner Drama: two different sets of items.
        expect(favorite()).toEqual(expected({ tags: [tags.noir as string] }));
        expect(favorite(OWNER)).toEqual(expected({ tags: [tags.drama as string] }));
    });
});
