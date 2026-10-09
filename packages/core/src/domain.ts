import { z } from "zod";

/**
 * Domain vocabulary shared by every layer.
 *
 * These are the values the database CHECK constraints enforce, so the schema and the types
 * cannot drift apart silently — `packages/db/src/init.ts` references these lists in comments
 * and `schemaSnapshot.test.ts` renders any change.
 */

export const mediaKinds = ["image", "video"] as const;
export const mediaKindSchema = z.enum(mediaKinds);
export type MediaKind = z.infer<typeof mediaKindSchema>;

/**
 * Which kind a review queue shows (§10c, §5d, §5f): one of them, or both.
 *
 * The queues open on videos, because the collection is mostly video and photos are the
 * exception; a request leaving `media` out means both, so a caller that predates the control
 * sees what it always saw.
 */
export const reviewMedia = ["video", "image", "all"] as const;
export const reviewMediaSchema = z.enum(reviewMedia);
export type ReviewMedia = z.infer<typeof reviewMediaSchema>;

/** The `media` a review request carries for a choice: nothing for both. */
export const reviewMediaKind = (media: ReviewMedia): MediaKind | undefined =>
    media === "all" ? undefined : media;

/** How much of a review queue is of each kind, for the counts on its control. */
export const mediaKindCountsSchema = z.object({ video: z.number(), image: z.number() });
export type MediaKindCounts = z.infer<typeof mediaKindCountsSchema>;

/**
 * File lifecycle. `missing` is not a soft delete — it means the file was not seen on the
 * last scan, which on a NAS usually means the share is offline (§7).
 */
export const fileStates = ["active", "missing", "archived"] as const;
export const fileStateSchema = z.enum(fileStates);
export type FileState = z.infer<typeof fileStateSchema>;

/**
 * What the scanner decided a file is (§18.5). Without this, a first scan fills the library
 * with thousands of junk images from `folder.jpg` and NAS thumbnail directories.
 */
export const fileClassifications = ["media", "companion", "ignored"] as const;
export const fileClassificationSchema = z.enum(fileClassifications);
export type FileClassification = z.infer<typeof fileClassificationSchema>;

/**
 * Facets of the tag system (§5b). Open-ended by design — a new facet is a row, not a
 * migration, and `Tag.kind` is an unconstrained string that accepts anything.
 *
 * Three, deliberately. This began as seven — genre, series, studio, location and event as
 * well — on the reasoning that a facet costs nothing to declare. It costs something to
 * *offer*: the tag editor draws a box per facet, so seven boxes asked seven questions about
 * every item, six of which were usually blank, and filing "funny" meant first deciding which
 * of seven drawers a joke belongs in. That is the tax a faceted system charges, and it is
 * only worth paying where the facet genuinely changes what a value means.
 *
 * `performer` earns its own facet because it is a person and `normalizeName` folds spellings
 * of a name together; `source` earns one because it records where an item came from rather
 * than what it is.
 *
 * **The order is the app's one facet order**: Performer, Source, Keyword — the item editor,
 * the bulk dialogue (whose default is the first entry), the filter panel, the management
 * screen and the sidebar all read it. Who is in it is the question most tagging answers, and
 * where it came from the next. `tag` was first when there were seven boxes and a catch-all
 * after six specific ones went unreached; at three, it is one row down, not buried.
 *
 * Nothing rejects a tag of a retired kind: one still searches, still filters and still counts,
 * and simply groups under "other" (§5b). The list is a *display* order, not a constraint.
 */
export const tagKinds = ["performer", "source", "tag"] as const;

/**
 * The facets a clip can carry (§14d "Tagging clips").
 *
 * No `source`: where something came from is a fact about the whole video, and /clips already
 * searches the video's own tags as a field of its own. A list in code rather than a CHECK, so
 * widening it is an edit and not a migration.
 */
export const clipTagKinds = ["performer", "tag"] as const;
export type ClipTagKind = (typeof clipTagKinds)[number];

export const isClipTagKind = (kind: string): kind is ClipTagKind =>
    (clipTagKinds as readonly string[]).includes(kind);

/**
 * Facets a person may keep to themselves (§6).
 *
 * Only `tag`, and the asymmetry is the point rather than a simplification. A private tag is a
 * personal annotation — "funny", "to cut", "show Mum" — and the catch-all facet is exactly
 * where those belong. The other two are *facts about the item*: who is in it, and where it came
 * from. Those are true whoever is looking, so a private one is either a fact the library ought
 * to know and does not, or a fact the person has got wrong on their own.
 *
 * It also removes a question nobody wants to answer. With three private boxes, filing "to cut"
 * means first deciding whether it is a tag, a performer or a source — the tax §5b already
 * charges for faceting, paid a second time on the half of the system where there is only ever
 * one right answer.
 *
 * Enforced rather than merely not offered: `ensureTag` refuses, so no route, bulk apply or
 * future scraper can create one by supplying a `kind` the boxes never showed.
 */
export const privateFacets = ["tag"] as const;

export const allowsPrivate = (kind: string): boolean =>
    (privateFacets as readonly string[]).includes(kind);

/**
 * Where a tag assignment came from. Lets re-parsing replace only its own work (§18.6).
 *
 * `ocr` is listed before anything reads it, deliberately. The values are enforced by a CHECK
 * constraint, and SQLite cannot alter one — adding a value after release means rebuilding the
 * table through the twelve-step dance. Reserving it now costs a word; reserving it later costs
 * a migration. See §5d for the feature that will use it.
 */
export const tagSources = ["user", "filename", "scraper", "ai", "ocr"] as const;
export const tagSourceSchema = z.enum(tagSources);
export type TagSource = z.infer<typeof tagSourceSchema>;

export const streamKinds = ["video", "audio", "subtitle"] as const;
export const streamKindSchema = z.enum(streamKinds);
export type StreamKind = z.infer<typeof streamKindSchema>;

/** Derived visual artifacts (§9). All stored on disk; the row holds only the path. */
export const artifactKinds = [
    "cover",
    "poster",
    "preview",
    "sprite",
    "spriteVtt",
    "subtitleVtt",
] as const;
export const artifactKindSchema = z.enum(artifactKinds);
export type ArtifactKind = z.infer<typeof artifactKindSchema>;

/** Transcode profiles (§18.8). Only `websafe-1080p` is generated eagerly. */
export const variantProfiles = ["websafe-1080p", "remote-720p", "tv-safe"] as const;
export const variantProfileSchema = z.enum(variantProfiles);
export type VariantProfile = z.infer<typeof variantProfileSchema>;

/** The scanner's job chain (§7), in order. */
export const jobKinds = [
    "scan",
    "probe",
    "parse",
    "cover",
    "sprite",
    "preview",
    "phash",
    "websafeCheck",
    "transcode",
    // Removing every rendition, after an admin switched transcoding off (§8).
    "variantPurge",
    "index",
    "trash",
    "restore",
    "purge",
    "orphanSweep",
    // Reserved, and deliberately unhandled: rendering a reel to a file is designed in §14d and
    // not built. This is a CHECK-constrained vocabulary, so reserving the word now costs a line
    // and adding it after release would cost a table rebuild.
    "reelRender",
    "backup",
] as const;
export const jobKindSchema = z.enum(jobKinds);
export type JobKind = z.infer<typeof jobKindSchema>;

export const jobStates = ["pending", "claimed", "done", "failed", "cancelled"] as const;
export const jobStateSchema = z.enum(jobStates);
export type JobState = z.infer<typeof jobStateSchema>;

/**
 * Which way round a sort runs.
 *
 * Here rather than beside one of the sorts that uses it: the library, the clip browser and the
 * reel index all speak it, and a vocabulary declared inside one schema file makes the next file
 * that needs it import sideways — which is how `schemas/media.ts` and `schemas/reels.ts` came
 * to point at each other.
 */
export const sortDirections = ["asc", "desc"] as const;
export const sortDirectionSchema = z.enum(sortDirections);
export type SortDirection = z.infer<typeof sortDirectionSchema>;

export const scanStates = ["running", "done", "failed"] as const;
export const scanStateSchema = z.enum(scanStates);
export type ScanState = z.infer<typeof scanStateSchema>;

/**
 * Who can see a collection: its owner, or everybody (§14c).
 *
 * Named for the idea rather than for one of its three carriers. A saved view, a playlist and a
 * reel all share this vocabulary and the rule that goes with it -- only an administrator may
 * move one to `shared`, and anybody may move their own back -- which is the whole reason it is
 * declared once.
 */
export const collectionVisibilities = ["private", "shared"] as const;
export const collectionVisibilitySchema = z.enum(collectionVisibilities);
export type CollectionVisibility = z.infer<typeof collectionVisibilitySchema>;

/**
 * Which order a playlist opens in when its address does not say (§14b).
 *
 * Only ever a default. Shuffling is a seed in the URL and writes nothing, so this is the one
 * place the two orders are a stored choice rather than a property of where you are standing.
 *
 * Playlists only. A reel has no equivalent and wants none: a playlist's order is an
 * arrangement of things that each stand alone, and a reel's order is the cut (§14d).
 */
export const playlistSortModes = ["stored", "shuffle"] as const;
export const playlistSortModeSchema = z.enum(playlistSortModes);
export type PlaylistSortMode = z.infer<typeof playlistSortModeSchema>;

/**
 * Authorization scopes, stored as a comma list in `User.scopes` (basket-bot convention).
 *
 * `delete` is deliberately separate from `admin` (§18.1): some accounts curate the library
 * without administering the app.
 */
export const scopes = ["admin", "delete"] as const;
export const scopeSchema = z.enum(scopes);
export type Scope = z.infer<typeof scopeSchema>;

export const parseScopes = (raw: string | null | undefined): Scope[] =>
    (raw ?? "")
        .split(",")
        .map((scope) => scope.trim())
        .filter((scope): scope is Scope => (scopes as readonly string[]).includes(scope));

export const hasScope = (raw: string | null | undefined, scope: Scope): boolean =>
    parseScopes(raw).includes(scope);

/** Characters that join a name's parts rather than separate them: `O'Brien` is one word. */
const NAME_JOINERS = /['’ʼ`]/g;

/**
 * A name as matching sees it — the one rule every name match in the app goes through (§5b
 * "One rule for names").
 *
 * - **Case and accents fold**: "Zoë", "ZOE" and "zoe" are one name. Letters with no plain
 *   equivalent (`æ`, `ø`, other scripts) are kept as they are.
 * - **Punctuation separates**: spaces, underscores, pluses, hyphens, dots, slashes — "Mary-Kate",
 *   `Mary_Kate`, `Mary+Kate` and "Mary Kate" are one name, and `examplesite.com` is two words.
 *   The glued spelling (`marykate`) is `squashName`'s, so matching tries both.
 * - **Apostrophes join**: "O'Brien" is `obrien`, as it is usually written when it is glued.
 *
 * It is what `Tag.nameNorm` stores, so two tags cannot differ only in accents or punctuation, and
 * what text is folded with before names are looked for in it.
 */
export const normalizeName = (name: string): string =>
    name
        .normalize("NFKD")
        .replace(/\p{M}/gu, "")
        .toLowerCase()
        .replace(NAME_JOINERS, "")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
