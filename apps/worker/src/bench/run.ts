/**
 * §20's performance budget, as something that can be run rather than hoped for.
 *
 *     pnpm bench:seed            # build a 200k-item library (about 12 minutes)
 *     pnpm bench <userId> <rootId>
 *
 * Calls the repo functions the app calls, so what is measured is what ships. None of this was
 * visible at the four-item scale of the test suite: the grid spent its first year of
 * development taking six seconds to render page one at 200k items, and every unit test passed
 * throughout.
 *
 * Exits non-zero when anything is outside budget, so it can be a gate rather than a report.
 */
const { mediaRepo, tagRepo, db } = await import("@private-stock/db");

const userId = process.argv[2];
const rootId = process.argv[3];

const median = (values: number[]): number =>
    [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

const results: [string, number, number][] = [];

const time = (label: string, budget: number, fn: () => unknown, runs = 5): void => {
    fn();

    const samples: number[] = [];

    for (let i = 0; i < runs; i += 1) {
        const start = process.hrtime.bigint();
        fn();
        samples.push(Number(process.hrtime.bigint() - start) / 1e6);
    }

    const ms = median(samples);

    results.push([label, ms, budget]);
    console.log(
        `${ms <= budget ? "  ok" : "SLOW"}  ${label.padEnd(46)} ${ms.toFixed(1).padStart(8)} ms  (budget ${budget})`
    );
};

const q = (overrides: Record<string, unknown> = {}) =>
    ({ sort: "addedAt", direction: "desc", limit: 60, page: 0, ...overrides }) as never;

const SORTS = [
    "addedAt",
    "capturedAt",
    "title",
    "duration",
    "size",
    "resolution",
    "bitrate",
    "fps",
    "rating",
    "lastViewed",
];

const libraryRows = (db.prepare(`SELECT count(*) AS n FROM "Media"`).get() as { n: number }).n;

console.log(`library: ${libraryRows.toLocaleString()} media
`);

console.log("=== grid pages, every sort ===");
for (const sort of SORTS) {
    time(`page 1     sort=${sort}`, 1_000, () =>
        mediaRepo.listMedia(q({ sort }), userId, [rootId])
    );
}

console.log();
console.log("=== deep pages: the cost must not grow with the library ===");
for (const page of [10, 100, 500, 1_000, 3_000]) {
    time(`page ${String(page).padStart(5)}  sort=addedAt`, 1_000, () =>
        mediaRepo.listMedia(q({ page }), userId, [rootId])
    );
}

console.log();
/**
 * Last viewed past the items that have been viewed.
 *
 * A per-user sort, so like rating it orders the matching set on every page. Most of a library
 * has never been opened, so the deep pages are the never-viewed tail -- which is where a sort
 * that only looked cheap on page one would show itself. Both directions, because the
 * never-viewed items go last either way round and ascending is the one SQLite would not put
 * there by itself.
 */
console.log("=== last viewed: the never-viewed tail ===");
for (const direction of ["desc", "asc"]) {
    for (const page of [0, 100, 1_000, 3_000]) {
        time(`lastViewed ${direction.padEnd(4)} page ${String(page).padStart(5)}`, 1_000, () =>
            mediaRepo.listMedia(q({ sort: "lastViewed", direction, page }), userId, [rootId])
        );
    }
}

console.log();
/**
 * Shuffle is a sort now, so it pays for ordering the matching set on every page.
 *
 * The slot walk it replaced cost 0.9 ms at any depth and returned mostly-empty pages under
 * any filter -- favourites came back as a handful on page one. Held to the same budget as
 * sort-by-rating, the other sort no index can serve.
 */
console.log("=== shuffle: a sort over the matching set ===");
for (const page of [0, 100, 1_000, 3_000]) {
    time(`shuffle page ${String(page).padStart(5)}`, 1_000, () =>
        mediaRepo.listMedia(q({ sort: "random", seed: 42, page }), userId, [rootId])
    );
}
time(`shuffle page     0  favorite`, 1_000, () =>
    mediaRepo.listMedia(q({ sort: "random", seed: 42, favorite: true }), userId, [rootId])
);

console.log();
console.log("=== per-user filters, every sort ===");
for (const sort of SORTS) {
    time(`page 1     favorite sort=${sort}`, 1_000, () =>
        mediaRepo.listMedia(q({ sort, favorite: true }), userId, [rootId])
    );
}
time(`page 1     minRating=5 kind=video`, 1_000, () =>
    mediaRepo.listMedia(q({ minRating: 5, kind: "video" }), userId, [rootId])
);
time(`page 1     favorite minRating=5`, 1_000, () =>
    mediaRepo.listMedia(q({ favorite: true, minRating: 5 }), userId, [rootId])
);
time(`page 1     watched=yes`, 1_000, () =>
    mediaRepo.listMedia(q({ watched: "yes" }), userId, [rootId])
);

console.log();
console.log("=== the count, once per filter ===");
time(`countMedia unfiltered`, 1_000, () => mediaRepo.countMedia(q(), userId, [rootId]));
time(`countMedia kind=video`, 1_000, () =>
    mediaRepo.countMedia(q({ kind: "video" }), userId, [rootId])
);
time(`countMedia favorite`, 1_000, () =>
    mediaRepo.countMedia(q({ favorite: true }), userId, [rootId])
);

console.log();
console.log("=== search ===");

/**
 * Broad searches get a looser budget, and §5c says why.
 *
 * The FTS match set has to be built before anything can filter it, so cost tracks the number
 * of *hits* rather than the page. A term matching 18% of the library is really browsing, and
 * at 215 ms it misses the 200 ms target by a margin that shrinks with every character typed.
 * The looser number here is a regression guard, not an endorsement: it is set where a real
 * degradation would still trip it.
 */
const BROAD_SEARCH_BUDGET = 400;

for (const [term, budget] of [
    ["aurora", 200],
    ["harbour", 200],
    ["summer", BROAD_SEARCH_BUDGET],
] as const) {
    time(`page 1     search="${term}"`, budget, () =>
        mediaRepo.listMedia(q({ search: term }), userId, [rootId])
    );
}

time(`page 1     search="summer" sort=relevance`, BROAD_SEARCH_BUDGET, () =>
    mediaRepo.listMedia(q({ search: "summer", sort: "relevance" }), userId, [rootId])
);

console.log();
console.log("=== facets ===");
// The public system is what the benchmark measures: the seeded library tags library-wide,
// and a private pass over a vocabulary nobody has built would time an empty query (§6).
// The two halves are timed apart on purpose. Listing is proportional to the vocabulary and
// counting to how much has been tagged, and when the panel gets slow it matters which of
// those grew -- a single number for "facets" hid exactly that and took a cap to fix.
const facetIds = tagRepo.listFacetValues({ owner: null, limit: 20 }).map((row) => row.tagId);

time(`listFacetValues top 20`, 200, () => tagRepo.listFacetValues({ owner: null, limit: 20 }));
time(`facetCountsForTags unfiltered`, 200, () =>
    mediaRepo.facetCountsForTags(q(), userId, [rootId], facetIds, "public")
);
time(`facetCountsForTags search="summer"`, 200, () =>
    mediaRepo.facetCountsForTags(q({ search: "summer" }), userId, [rootId], facetIds, "public")
);

console.log();
console.log("=== query plans: any SCAN of a large table is the thing to look for ===");
for (const row of db
    .prepare(
        `EXPLAIN QUERY PLAN
         SELECT m."id" FROM "Media" m
           LEFT JOIN "UserMedia" um ON um."mediaId" = m."id" AND um."userId" = :userId
          WHERE m."listable" = 1 AND um."hidden" IS NULL AND m."listRootId" IN (:root0)
          ORDER BY m."addedAt" DESC, m."id" DESC LIMIT 60`
    )
    .all({ userId, root0: rootId }) as { detail: string }[]) {
    console.log(`   ${/SCAN/.test(row.detail) ? "!!" : "  "} ${row.detail}`);
}

const slow = results.filter(([, ms, budget]) => ms > budget);

console.log();
console.log(
    slow.length === 0
        ? `ALL ${results.length} WITHIN BUDGET`
        : `${slow.length} OVER BUDGET: ${slow.map(([label]) => label).join(", ")}`
);

// Non-zero on a regression, so this can gate rather than merely inform.
process.exit(slow.length === 0 ? 0 : 1);

// Top-level await needs this file to be a module.
export {};
