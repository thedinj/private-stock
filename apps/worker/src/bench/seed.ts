/**
 * Builds a synthetic library at real scale, with no ffmpeg (§20).
 *
 * Rows only: the question being measured is query cost, and covers, previews and sprites
 * contribute nothing to it. Text is drawn from a small vocabulary with deliberately skewed
 * frequencies so that some searches match a handful of rows and some match tens of
 * thousands -- the second kind is the one that decides whether paging works.
 */
import { randomUUID } from "node:crypto";

const { db } = await import("@private-stock/db");

const TOTAL = Number(process.argv[2] ?? 200_000);

// Deterministic pseudo-random, so a measurement can be repeated exactly.
let seed = 12345;
const rand = (): number => {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
    return seed / 0x7fffffff;
};
const pick = <T>(list: T[]): T => list[Math.floor(rand() * list.length)];

/** Frequent words match a large slice of the library; rare ones match a few rows. */
const COMMON = ["summer", "winter", "beach", "city", "night", "road"];
const MID = ["harbour", "forest", "market", "canyon", "bridge", "garden", "valley", "coast"];
const RARE = ["aurora", "zephyr", "obsidian", "lantern", "marble", "cobalt"];

const STUDIOS = Array.from({ length: 40 }, (_, i) => `Studio ${i}`);
const PERFORMERS = Array.from({ length: 2_000 }, (_, i) => `Performer ${i}`);
const GENRES = ["drama", "comedy", "documentary", "action", "travel", "music"];

const rootId = randomUUID();

db.prepare(
    `INSERT INTO "MediaRoot" ("id", "path", "label", "enabled", "writable", "updatedAt")
     VALUES (?, 'bench', 'Bench', 1, 1, CURRENT_TIMESTAMP)`
).run(rootId);

const insertMedia = db.prepare(
    `INSERT INTO "Media"
        ("id", "kind", "title", "durationMs", "width", "height", "bitrate", "fps",
         "codec", "container", "probedAt", "addedAt", "updatedAt")
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'h264', 'mov,mp4', CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP)`
);

const insertFile = db.prepare(
    `INSERT INTO "MediaFile"
        ("id", "rootId", "relPath", "size", "mtime", "lastSeenAt", "updatedAt")
     VALUES (?, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
);

const insertLink = db.prepare(
    `INSERT INTO "MediaFileLink" ("id", "mediaId", "fileId", "role")
     VALUES (?, ?, ?, 'original')`
);

const insertDoc = db.prepare(
    `INSERT INTO "MediaSearchDoc"
        ("mediaId", "filename", "title", "performers", "tags", "attributes", "notes")
     VALUES (?, ?, ?, ?, ?, '', '')`
);

const insertTag = db.prepare(
    `INSERT INTO "Tag" ("id", "kind", "name", "nameNorm", "updatedAt")
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING`
);

const insertMediaTag = db.prepare(
    `INSERT OR IGNORE INTO "MediaTag" ("id", "mediaId", "tagId", "source") VALUES (?, ?, ?, 'user')`
);

const insertUserMedia = db.prepare(
    `INSERT INTO "UserMedia"
        ("userId", "mediaId", "rating", "favorite", "viewCount", "lastViewedAt", "updatedAt")
     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
);

const userId = randomUUID();

db.prepare(
    `INSERT INTO "User" ("id", "email", "displayName", "password", "scopes", "updatedAt")
     VALUES (?, 'bench@example.test', 'Bench', 'x', 'admin,delete', CURRENT_TIMESTAMP)`
).run(userId);

// Tag vocabulary first, so assignments can reference it.
const tagIds: { kind: string; id: string; name: string }[] = [];

const addTag = (kind: string, name: string): void => {
    const id = randomUUID();
    insertTag.run(id, kind, name, name.toLowerCase());
    tagIds.push({ kind, id, name });
};

db.transaction(() => {
    // The three facets the app offers (§5b). GENRES and STUDIOS keep their names as word
    // lists -- what a benchmark needs is a realistic spread of values per item, and where
    // those words came from stopped mattering when the facets merged into one.
    for (const name of GENRES) addTag("tag", name);
    for (const name of STUDIOS) addTag("source", name);
    for (const name of PERFORMERS) addTag("performer", name);
})();

const genericTags = tagIds.filter((tag) => tag.kind === "tag");
const sourceTags = tagIds.filter((tag) => tag.kind === "source");
const performerTags = tagIds.filter((tag) => tag.kind === "performer");

const started = Date.now();
const BATCH = 5_000;

/**
 * Frame rates and viewing history, from the row number rather than from `rand()`.
 *
 * Added after the rest, and drawing them from the generator would have shifted every value
 * after the first call -- a different library from the one every earlier measurement was taken
 * on. Taken from `i` instead, the existing columns are what they always were.
 */
const FRAME_RATES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];
const viewedAt = (i: number): string =>
    new Date(Date.now() - ((i * 7_919) % (365 * 86_400)) * 1_000)
        .toISOString()
        .replace("T", " ")
        .slice(0, 19);

for (let offset = 0; offset < TOTAL; offset += BATCH) {
    db.transaction(() => {
        for (let i = offset; i < Math.min(offset + BATCH, TOTAL); i += 1) {
            const mediaId = randomUUID();
            const fileId = randomUUID();

            // Skewed vocabulary: every row gets a common word, half get a mid word, a few
            // percent get a rare one.
            const words = [pick(COMMON)];
            if (rand() < 0.5) words.push(pick(MID));
            if (rand() < 0.03) words.push(pick(RARE));

            const title = `${words.join(" ")} ${i}`;
            const kind = rand() < 0.25 ? "image" : "video";
            const durationMs = kind === "video" ? Math.floor(rand() * 7_200_000) : null;
            const width = rand() < 0.5 ? 1920 : 1280;
            const relPath = `${pick(STUDIOS).replace(/ /g, ".")}/${title.replace(/ /g, ".")}.mp4`;

            // Spread over four years so date sorts have real variety.
            const addedAt = new Date(Date.now() - Math.floor(rand() * 4 * 365 * 86_400_000))
                .toISOString()
                .replace("T", " ")
                .slice(0, 19);

            insertMedia.run(
                mediaId,
                kind,
                title,
                durationMs,
                width,
                Math.round((width * 9) / 16),
                Math.floor(1_000_000 + rand() * 9_000_000),
                kind === "video" ? FRAME_RATES[i % FRAME_RATES.length] : null,
                addedAt
            );

            insertFile.run(fileId, rootId, relPath, Math.floor(rand() * 8_000_000_000));
            insertLink.run(randomUUID(), mediaId, fileId);

            const source = pick(sourceTags);
            const performer = pick(performerTags);
            const generic = pick(genericTags);

            insertDoc.run(
                mediaId,
                relPath.replace(/[./]/g, " "),
                title,
                performer.name,
                // Everything that is not a performer shares one column now.
                `${generic.name} ${source.name}`
            );

            // Roughly three tags each, which is what a scraped library looks like.
            insertMediaTag.run(randomUUID(), mediaId, source.id);
            insertMediaTag.run(randomUUID(), mediaId, performer.id);
            insertMediaTag.run(randomUUID(), mediaId, generic.id);

            // A third of the library rated, a tenth favourited, and half of those opened --
            // so most of the library has never been viewed, which is the case that decides
            // whether sorting by last viewed stays cheap past the items that have been.
            if (rand() < 0.33) {
                const viewed = i % 2 === 0;

                insertUserMedia.run(
                    userId,
                    mediaId,
                    1 + Math.floor(rand() * 5),
                    rand() < 0.3 ? 1 : null,
                    viewed ? 1 + (i % 5) : 0,
                    viewed ? viewedAt(i) : null
                );
            }
        }
    })();

    process.stdout.write(`\r  ${Math.min(offset + BATCH, TOTAL)} / ${TOTAL}`);
}

process.stdout.write("\n");

db.exec("ANALYZE");

console.log(
    JSON.stringify({
        userId,
        rootId,
        seconds: Math.round((Date.now() - started) / 1000),
    })
);

// Top-level await needs this file to be a module.
export {};
