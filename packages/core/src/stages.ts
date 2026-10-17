import { z } from "zod";

/**
 * What has been done to each item, and what is left to do (§7b).
 *
 * The pipeline used to answer this four different ways: a timestamp for probing, a version
 * integer for the search index, the existence of an `Artifact` row for covers, and a non-null
 * column for file hashes. Each new capability invented its own marker and its own "what needs
 * work" query, and there were five of those before this existed.
 *
 * That scheme records what *output exists*, which is not the same question as what
 * *processing has happened*. The two coincide until a stage legitimately produces nothing —
 * a blank image has no perceptual hash, a five-second clip has no preview, an OCR pass finds
 * no text — and then "no output" is indistinguishable from "never tried". The backfill sweep
 * re-queued those items every five minutes, forever.
 *
 * A stage registry plus one row per (item, stage) answers both questions and makes adding a
 * capability a registry entry rather than a new column, a new query and a new convention.
 */

/**
 * How a stage comes to run (§7b).
 *
 * Three values, because there are three genuinely different answers:
 *
 *  - `automatic` — swept across the library unless an admin switches it off.
 *  - `optIn` — not swept until an admin switches it on, and then swept exactly like an
 *    automatic stage. For work that is affordable once somebody has decided to spend it.
 *  - `perItem` — never swept, whatever the settings say. The per-item route is the only one.
 *
 * The middle value is the one this enum did not have, and its absence was a gap rather than
 * a simplification. OCR is affordable on a chosen library and ruinous on 200k items, and
 * with two values that could only be said as "never sweeps" — which left no way to ask for
 * it across a library at all. Every item had to be requested by hand.
 *
 * `mode` is the default and, for `perItem`, the ceiling; the admin setting is the policy
 * that deviates from it. Promoting a stage is a single edit here — the backfill starts
 * including it, and items already processed on request are skipped because their row is
 * already at the current version. No migration, no backfill script.
 */
export const stageModeSchema = z.enum(["automatic", "optIn", "perItem"]);
export type StageMode = z.infer<typeof stageModeSchema>;

/**
 * The outcome of one attempt.
 *
 * `empty` is the value the old scheme could not express, and the whole reason for this table.
 * It means the stage ran correctly and there was nothing to produce — which is a *result*,
 * not a gap, and must not be retried. Without it a blank frame is reprocessed forever.
 *
 * `failed` is retried, up to a limit; `skipped` means the stage does not apply to this item
 * at all, such as a sprite sheet for a still image.
 */
export const stageStateSchema = z.enum(["done", "empty", "failed", "skipped"]);
export type StageState = z.infer<typeof stageStateSchema>;

/** Which items a stage applies to. */
export const stageAppliesToSchema = z.enum(["all", "video", "image"]);
export type StageAppliesTo = z.infer<typeof stageAppliesToSchema>;

export interface StageDefinition {
    /**
     * The stage's name, which is also the job kind that performs it.
     *
     * Stored as an open string rather than a CHECK constraint. SQLite cannot alter a CHECK,
     * so a closed vocabulary would make every new capability a table rebuild after release —
     * exactly the trap that `MediaTag.source` is in, and the reason `ocr` had to be reserved
     * there before anything used it.
     */
    name: string;
    /**
     * Bump to re-run the stage across the library.
     *
     * The backfill treats a row below the current version as work to do, so improving a
     * recipe is a number change and a gradual sweep through the ordinary job queue — not a
     * migration, and not a script someone has to remember to run.
     */
    version: number;
    mode: StageMode;
    appliesTo: StageAppliesTo;
    /**
     * Queue priority. Lower runs first.
     *
     * Ordered by what a person is waiting for: covers make the grid look finished, and the
     * search index makes items findable. Then the perceptual hash, ahead of previews and
     * sprites, because deleting a duplicate is how an admin avoids paying for those twice.
     */
    priority: number;
    /** Attempts before a failure is left alone. Null means never stop retrying. */
    maxAttempts: number | null;
    /**
     * Whether the stage waits for the probe.
     *
     * Everything that renders from the picture plans its frames from the duration and the
     * dimensions, and before the probe there are none: a sprite made then got a layout for a
     * guessed length and wrote sheets claiming a negative number of tiles. And a file the
     * probe cannot open is one ffmpeg cannot render either -- each of these stages used to
     * fail on it three times over before anything gave up.
     */
    needsProbe: boolean;
    /**
     * Another stage that must have settled on the item first, by the item's kind.
     *
     * `needsProbe` generalised, for the first stage that genuinely consumes another's output
     * (§7b "What it would still need thinking about"): `embed` reads the sprite sheets of a video
     * and the cover of a photograph. Until that stage has settled — done or empty at its current
     * version, or failed past its attempts — the item is not swept, counted or requestable for
     * this one, so nothing spends an attempt on output that does not exist yet. Settled but
     * empty is the handler's to answer: there is nothing to read, so it records `empty` too.
     */
    requires?: Partial<Record<"image" | "video", string>>;
    /** Shown in the admin view; explains what the stage is for in one line. */
    describe: string;
}

/**
 * Every processing capability, in the order the pipeline wants them.
 *
 * Adding one means adding an entry here and a job handler. Nothing else: no column, no
 * backfill query, no bespoke "is it done" convention.
 */
export const STAGES: StageDefinition[] = [
    /**
     * First of everything, ahead of the probe (§10f), where it used to trail the previews at 170.
     *
     * A byte-identical copy can take every artifact its twin already has instead of rendering
     * its own, and nothing can tell it has a twin until this has run. The scanner therefore
     * queues this rather than the probe, and this queues the probe when it is done. It is the
     * cheapest stage there is — three seeks unless a quick hash collides — and is I/O rather
     * than a core, so going first delays nothing that holds one.
     */
    {
        name: "filehash",
        version: 1,
        mode: "automatic",
        appliesTo: "all",
        priority: 40,
        maxAttempts: 3,
        needsProbe: false,
        describe: "Identity hashes, which is what finds exact duplicates",
    },
    /**
     * Duration, dimensions and codecs, read by ffprobe -- and the gate on everything that
     * renders (`needsProbe`).
     *
     * A job kind long before it was a stage, chained from the identity hash. It became one
     * because nothing remembered a probe that failed: the job dead-lettered, `probedAt` stayed
     * null, and the item was never looked at again unless its bytes changed. One timed out
     * during a first import's probe storm and the file was fine. As a stage a failure is
     * recorded, retried by the sweep, and listed with the rest.
     */
    {
        name: "probe",
        version: 1,
        mode: "automatic",
        appliesTo: "all",
        priority: 50,
        maxAttempts: 3,
        needsProbe: false,
        describe: "Duration, dimensions and codecs, read from the file",
    },
    {
        name: "cover",
        version: 1,
        mode: "automatic",
        appliesTo: "all",
        priority: 70,
        maxAttempts: 3,
        needsProbe: true,
        describe: "The still shown in the grid",
    },
    {
        name: "preview",
        version: 1,
        mode: "automatic",
        appliesTo: "video",
        priority: 120,
        maxAttempts: 3,
        needsProbe: true,
        describe: "The silent looping clip for hover and gallery mode",
    },
    {
        name: "sprite",
        version: 1,
        mode: "automatic",
        appliesTo: "video",
        priority: 140,
        maxAttempts: 3,
        needsProbe: true,
        describe: "The filmstrip behind the scrubber",
    },
    {
        name: "index",
        /**
         * 2: the document carries text read out of the picture (§5d).
         *
         * A document written under 1 is not wrong, it is *short* — it was assembled before
         * there was an `ocr` column to fill, so an item whose watermark names its studio
         * cannot be found by that name. The bump is what a re-enqueue sweep reads to tell
         * the two apart, so existing items are rebuilt rather than left silently
         * unsearchable on the one field that most often carries a file's only real metadata.
         *
         * 3: compound words are indexed beside their parts, and the `variants` column carries
         * the glued spellings (§5c "Word boundaries"). A document written under 2 is again
         * short rather than wrong: "margaret" does not find `AuntMargaret.mp4` until it is
         * rebuilt.
         */
        version: 3,
        mode: "automatic",
        appliesTo: "all",
        priority: 90,
        maxAttempts: 3,
        // Built from the name and the tags as much as from the probe, and an item nobody can
        // find by its own filename looks like search is broken.
        needsProbe: false,
        describe: "The search document",
    },
    /**
     * The descriptive tags a file carries about itself -- title, comment, artist (§5b).
     *
     * Separate from the probe so it can be swept: a re-probe chains every rendering stage
     * behind it, and this chains only the search document. Videos only: the photographs in the
     * library carry nothing of the kind, and reading 5k of them to learn that is not worth it.
     */
    {
        name: "metadata",
        version: 1,
        mode: "automatic",
        appliesTo: "video",
        priority: 95,
        maxAttempts: 2,
        needsProbe: true,
        describe: "Titles, comments and artists written into the file, so they can be searched",
    },
    /**
     * Ahead of previews and sprites, which it used to trail at 180.
     *
     * Those two share its CPU budget and cost far more — a sprite decodes the whole file — so
     * at 180 near-duplicates could not surface until every preview and sprite in the library
     * had been made, including the ones for the copies about to be deleted. Hashing first
     * turns the first hours of a new library into a chance to prune it before paying for it.
     * The cover and the search index stay ahead: a duplicate nobody can see is one nobody can
     * judge.
     */
    {
        name: "phash",
        version: 1,
        mode: "automatic",
        appliesTo: "all",
        priority: 100,
        maxAttempts: 2,
        needsProbe: true,
        describe: "The perceptual fingerprint, for near-duplicate detection",
    },
    /**
     * The colour of each filmstrip tile, for duplicates the perceptual hash cannot line up
     * (§10h).
     *
     * Automatic, unlike the other stages that read the sprite sheets: it is a third of a second
     * per video, reads only /data, and duplicate detection is not a feature to opt into. Right
     * behind `sprite`, which it requires.
     */
    {
        name: "tileprint",
        version: 1,
        mode: "automatic",
        appliesTo: "video",
        priority: 145,
        maxAttempts: 2,
        needsProbe: true,
        requires: { video: "sprite" },
        describe:
            "The colour of each filmstrip frame, for duplicates that start at different moments",
    },
    /**
     * Burned-in text (§5d).
     *
     * `optIn`, which is the whole reason `mode` has a middle value. This is by a wide margin
     * the most expensive thing the pipeline can do — recognition over sampled frames, on
     * hardware already sharing CPU with ffmpeg — so it must be something an administrator
     * turns on for a library rather than something that starts sweeping 200k items because
     * the capability was added. Promoting it to `automatic` later is this one word.
     *
     * Not `perItem`: text is worth having across a library, and a library-wide result
     * assembled by clicking eighteen thousand items one at a time is not a result anybody
     * will ever have.
     *
     * Last in priority: nothing on screen is waiting for it, unlike a cover, and unlike the
     * search index nothing becomes findable the moment it lands — an item without OCR is
     * still findable by everything it was findable by before.
     *
     * Two attempts. An OCR failure is nearly always systematic rather than transient — no
     * engine on the host, an unreadable original — and retrying a systematic failure across
     * a library is how a queue fills with work that can never succeed.
     */
    {
        name: "ocr",
        version: 1,
        mode: "optIn",
        appliesTo: "all",
        priority: 200,
        maxAttempts: 2,
        needsProbe: true,
        describe: "Text burned into the picture, so it can be searched",
    },
    /**
     * What each moment looks like, as vectors (§5e).
     *
     * `optIn` for OCR's reason: the first pass over a library is the better part of a day of
     * CPU on a NAS, and that is a decision for an administrator rather than a side effect of
     * upgrading. Promoting it is this one word.
     *
     * After `sprite` in priority because it reads the sprite sheets, and `requires` says so.
     * Ahead of OCR, which nothing on screen waits for either, but which costs far more per item.
     *
     * Two attempts. A failure here is nearly always systematic — a model that will not load,
     * sheets that will not decode — and the sweep should not keep finding it.
     */
    {
        name: "embed",
        version: 1,
        mode: "optIn",
        appliesTo: "all",
        priority: 150,
        maxAttempts: 2,
        needsProbe: true,
        requires: { video: "sprite", image: "cover" },
        describe: "What each moment looks like, so the library can be watched by look",
    },
    /**
     * Who is in it, as faces to be named (§5f).
     *
     * `optIn` and window-only for `embed`'s reasons: the first pass is a day and a half of a core
     * on the NAS, and the models hold ~230 MB while they work. They share `embed`'s model child,
     * one family at a time, so the two never hold their models at once.
     *
     * After `embed` in priority: it is the dearer of the two per item, and a look is wanted
     * sooner than a suggestion. Reads every second sprite tile and a photograph's cover, never
     * the original.
     */
    {
        name: "faces",
        // 2: the first run stopped nearly every item at a memory ceiling drawn from the desktop,
        // using up the attempts of items whose files were never at fault (§5f).
        version: 2,
        mode: "optIn",
        appliesTo: "all",
        priority: 160,
        maxAttempts: 2,
        needsProbe: true,
        requires: { video: "sprite", image: "cover" },
        describe: "The faces in each item, so performers can be suggested for you to confirm",
    },
];

/**
 * Where a pass somebody asked for joins the queue: ahead of all automatic work, of every kind.
 *
 * The claim takes the lowest priority among the kinds with a free slot, and the CPU-bound kinds
 * share a handful of slots (§7c), so a requested job competes against every automatic stage for
 * the same core. It used to be the stage's own priority minus fifty, which outranked that
 * stage's sweep and nothing else: a requested OCR pass sat at 150, behind 8,415 automatic
 * sprites at 140, and was still waiting the next morning.
 *
 * A tenth of the stage's priority keeps the registry's order *among* requests — a cover someone
 * asked for still goes before their OCR pass — while landing every one of them below the
 * lowest automatic priority. The registry test holds that line, so a stage added at 15 fails
 * a test rather than quietly outranking what people ask for.
 */
export const requestedPriority = (stage: StageDefinition): number =>
    Math.max(1, Math.floor(stage.priority / 10));

export const findStage = (name: string): StageDefinition | undefined =>
    STAGES.find((stage) => stage.name === name);

/**
 * Whether a stage applies to an item of this kind.
 *
 * Used to record `skipped` rather than leaving a gap: a sprite sheet for a still image is not
 * missing work, and a backfill that cannot tell the difference re-queues every photograph in
 * the library on every sweep.
 */
export const stageApplies = (stage: StageDefinition, kind: "image" | "video"): boolean =>
    stage.appliesTo === "all" || stage.appliesTo === kind;

/**
 * Whether a recorded outcome means there is still work to do.
 *
 * The single rule the backfill uses, kept here so it cannot drift between the query that
 * selects work and the code that decides whether to enqueue it.
 */
export const needsWork = (
    stage: StageDefinition,
    recorded: { version: number; state: StageState; attempts: number } | null
): boolean => {
    if (!recorded) {
        return true;
    }

    // An improved recipe supersedes any previous outcome, including a failure.
    if (recorded.version < stage.version) {
        return true;
    }

    if (recorded.state === "failed") {
        return stage.maxAttempts === null || recorded.attempts < stage.maxAttempts;
    }

    // done, empty and skipped are all settled at this version.
    return false;
};

/**
 * The stage this one waits for on an item of this kind, if any (`requires`).
 *
 * Resolved against the registry, so a `requires` naming a stage that does not exist is a test
 * failure rather than a stage that silently never runs.
 */
export const prerequisiteOf = (
    stage: StageDefinition,
    kind: "image" | "video"
): StageDefinition | null => {
    const name = stage.requires?.[kind];

    return name ? (findStage(name) ?? null) : null;
};

/**
 * Whether an item's prerequisite for this stage has settled, given its recorded outcome.
 *
 * Settled is `needsWork`'s negation, the sweep's own rule: an outcome at the current version
 * that is not a retryable failure. A stage with no prerequisite for this kind is always ready.
 */
export const prerequisiteSettled = (
    stage: StageDefinition,
    kind: "image" | "video",
    recorded: { version: number; state: StageState; attempts: number } | null
): boolean => {
    const prerequisite = prerequisiteOf(stage, kind);

    return prerequisite === null || !needsWork(prerequisite, recorded);
};

/**
 * One item's record for a stage, as the API returns it.
 *
 * Declared here rather than in the db package so the web app can describe processing without
 * importing a repo's row type.
 */
export interface StageRow {
    mediaId: string;
    stage: string;
    version: number;
    state: StageState;
    attempts: number;
    detail: string | null;
    requestedByUserId: string | null;
    at: string;
    /**
     * Which configuration produced this outcome, for a stage whose output depends on admin
     * settings — OCR records its settings revision. Null where nothing configurable was used.
     */
    recipe: string | null;
}

/**
 * What a handler returns: an outcome, or an outcome with the recipe that produced it.
 *
 * A bare state is the common case. The longer form is for a stage whose result depends on
 * settings, so the library can later say which items were produced under settings that have
 * since changed (§5d "What happens when OCR settings change").
 */
export type StageOutcome = StageState | { state: StageState; recipe: string };
