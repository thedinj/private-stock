import { z } from "zod";

import { dupeSettingsSchema } from "../dupes.js";
import { homeLayoutSchema } from "./home.js";
import { scanSettingsSchema } from "./media.js";
import { STAGES, type StageDefinition, type StageMode } from "../stages.js";
import { throttleSettingsSchema } from "../throttle.js";
import { transcodeSettingsSchema } from "../transcode.js";
import { trashSettingsSchema } from "./trash.js";

/**
 * Everything an admin can change at runtime, in one contract (§12b).
 *
 * The keys used to live wherever the code that read them happened to be — `"dupes"` in a job
 * handler, `"transcode"` in another, two `"scan.*"` strings inlined in a route. Nothing was
 * wrong with any of them individually, and collectively they meant no one place could answer
 * "what can an admin actually change", which is exactly the question a settings screen is.
 *
 * So the names and the shapes live here, and the screen is generated from the same schemas
 * the worker validates against. A setting that is added without a UI is then a visible
 * omission rather than an invisible one.
 */

export const SETTING_KEYS = {
    scanInterval: "scan.intervalMinutes",
    scanWatch: "scan.watch",
    trashRetention: "trash.retentionDays",
    transcode: "transcode",
    throttle: "processing.throttle",
    dupes: "dupes",
    stagePolicy: "stages.policy",
    homeLayout: "home.defaultLayout",
    /** The kill switch: background processing paused, and since when (§7c "Pausing"). */
    pause: "processing.pause",
    /** How OCR reads, and the revision each outcome records (§5d). Saved from its own page. */
    ocr: "ocr",
    /** The videos the OCR test bench compares settings on (§5d). */
    ocrTestSet: "ocr.testSet",
    /** Faces tagging by themselves (§5f "Tagging by itself"). Saved from Review › Faces. */
    faceAutoTag: "faces.autoTag",
    /** The library's "Won't play in a browser" filter, shown only while this is on (§8). */
    playbackCheck: "playback.check",
    /** Identical copies cleared every night (§10e "Every night"). Saved from Review › Duplicates. */
    identicalNightly: "dupes.identicalNightly",
} as const;

/**
 * Faces tagging by themselves (§5f "Tagging by itself"): off until an administrator turns it on,
 * having checked what it would tag. Who turned it on is kept: their undo list holds its batches.
 */
export const faceAutoTagSettingSchema = z.object({
    enabled: z.boolean().default(false),
    byUserId: z.string().nullable().default(null),
    since: z.string().nullable().default(null),
});
export type FaceAutoTagSetting = z.infer<typeof faceAutoTagSettingSchema>;

/**
 * Identical copies cleared by themselves, every night (§10e "Every night"): off until an
 * administrator turns it on. Who turned it on is kept, because a deletion needs a person to be
 * recorded against and this one is theirs. The last run is kept so the tab can say what it did.
 */
export const identicalNightlyRunSchema = z.object({
    at: z.string(),
    deleted: z.number(),
    failed: z.number(),
    /** Why the run did not happen at all, when it did not: the switch-holder lost a scope. */
    error: z.string().nullable(),
});
export type IdenticalNightlyRun = z.infer<typeof identicalNightlyRunSchema>;

export const identicalNightlySettingSchema = z.object({
    enabled: z.boolean().default(false),
    byUserId: z.string().nullable().default(null),
    since: z.string().nullable().default(null),
    lastRun: identicalNightlyRunSchema.nullable().default(null),
});
export type IdenticalNightlySetting = z.infer<typeof identicalNightlySettingSchema>;

/**
 * What an admin has decided about each stage, where they have decided anything (§7b).
 *
 * **Only the deviations are stored.** A stage nobody has touched is absent, which means "ask
 * the registry" — so a capability added in a later version arrives at whatever its `mode`
 * says, in every existing library, without anyone's stored settings being touched.
 *
 * That is the generalisation of the rule this replaced rather than a departure from it. The
 * setting used to be a list of *disabled* names, chosen so a new stage would be on by
 * default; storing only the exceptions is the same idea, freed of the assumption that the
 * exceptions all run in one direction. With three modes they do not — an `optIn` stage
 * deviates by being switched *on*.
 */
export const stagePolicySchema = z
    .record(z.string().min(1).max(40), z.boolean())
    .refine((policy) => Object.keys(policy).length <= STAGES.length + 20, {
        message: "Too many stage entries",
    })
    .default({});
export type StagePolicy = z.infer<typeof stagePolicySchema>;

/**
 * Transcoding's place in the stage policy (§7b, §8).
 *
 * Transcoding is not a pipeline stage -- it has its own job, its own backfill and its own
 * teardown -- but whether it runs is the same kind of decision as whether OCR runs, and it used
 * to be made with a different mechanism: a flag inside the transcode settings, saved with the
 * encoder's quality and preset. It is now one more entry in this record, under this key, so
 * "what runs across the library" has one answer in one place. The rest of the transcode settings
 * stay where they were: they describe the output, not whether there is any.
 *
 * **Off unless an admin turns it on.** Transcoding spends what cannot be got back cheaply --
 * hours of NAS CPU, and a second copy of every unplayable file, which for a remux is the same
 * size as the original. A default that starts doing that on the first scan decides for someone
 * who has not been told there was a decision.
 */
export const TRANSCODE_POLICY_KEY = "transcode";

export const transcodeEnabled = (policy: StagePolicy): boolean =>
    policy[TRANSCODE_POLICY_KEY] ?? false;

/**
 * The whole surface, as the admin screen reads and writes it.
 *
 * One request rather than four. These are read together every time the page opens, and a
 * screen that renders in four stages because it made four requests looks broken on a NAS.
 */
/**
 * Background processing paused (§7c "Pausing").
 *
 * For holding the library still while something is being decided — OCR settings tuned on the
 * bench, before a whole library is read with them. Work somebody asks for still runs; that is
 * how the bench gets to read while everything else waits.
 */
export const processingPauseSchema = z.object({
    paused: z.boolean().default(false),
    /** When it was paused, so the page can say how long the queue has been held. */
    since: z.string().nullable().default(null),
});
export type ProcessingPause = z.infer<typeof processingPauseSchema>;

export const adminSettingsSchema = z.object({
    scan: scanSettingsSchema,
    trash: trashSettingsSchema,
    transcode: transcodeSettingsSchema,
    /**
     * The hours the pipeline is allowed to work hard in (§7c).
     *
     * Separate from `transcode` although the thread cap lives here, because it governs the
     * whole pipeline rather than one kind of job -- and because the question an admin is
     * answering ("when may this box be busy") is not the question the transcode card asks
     * ("what should the output look like").
     */
    throttle: throttleSettingsSchema,
    dupes: dupeSettingsSchema,
    stagePolicy: stagePolicySchema,
    pause: processingPauseSchema,
    /**
     * The home page new accounts inherit (§6).
     *
     * A setting rather than a constant because what makes a good first screen depends on the
     * library: a collection with no tags and no playlists wants different rows from one that
     * has been curated for a year. Accounts that have never arranged their own home page
     * track this as it changes, rather than having been handed a copy on the day they signed
     * up.
     */
    homeLayout: homeLayoutSchema,
    /**
     * Whether the library offers a filter for the videos a browser is said not to play (§8).
     *
     * Off by default because it is a test bench rather than a way of browsing: it exists to try
     * those files on real devices, and nobody looking for something to watch needs it. The
     * default is the service's, not a `.default()` here: under `.partial()` a default would fill
     * in a patch that never mentioned it, and saving any other card would switch this off.
     */
    playbackCheck: z.boolean(),
});
export type AdminSettings = z.infer<typeof adminSettingsSchema>;

/**
 * A partial update, so a screen can save one card without resending the rest.
 *
 * Whole-object writes would make two admins editing different cards overwrite each other with
 * values neither of them touched — the kind of loss nobody attributes to the settings page
 * because the form still said the right thing when they left it.
 */
export const adminSettingsPatchSchema = adminSettingsSchema.partial();
export type AdminSettingsPatch = z.infer<typeof adminSettingsPatchSchema>;

/** What the admin screen shows beside each stage toggle, from the registry rather than a list. */
export interface StageSetting {
    name: string;
    describe: string;
    /**
     * The registry's own answer, carried so the screen can render three different things
     * rather than deduce them from two booleans (§7b).
     *
     * `automatic` and `optIn` both get a live switch; they differ only in which way the
     * switch points when nobody has touched it. `perItem` gets **no switch at all** — the
     * rule every other affordance here follows, and the one this card used to break by
     * rendering a greyed one that claimed a power it did not have.
     */
    mode: StageMode;
    /** Whether the sweep will actually run it, registry default and policy together. */
    enabled: boolean;
    /**
     * Items outstanding, or null where nobody is being asked to decide anything.
     *
     * "Enable OCR" and "enable OCR on eighteen thousand files" are different decisions, and
     * only one of them is on the screen otherwise (§7b). Counting is a scan of the matching
     * set (§20), so it is computed only for a stage that is *off* — a stage already running
     * has nothing left to decide, which in practice means one count per page load rather
     * than one per stage.
     */
    pending: number | null;
}

/**
 * Whether the sweep should run this stage (§7b).
 *
 * The single rule, kept here so the worker's loop and the admin screen cannot disagree about
 * what "enabled" means.
 *
 * `perItem` short-circuits before the policy is read, which is what makes it a ceiling rather
 * than a default: a stored `true` left behind by a stage later demoted from `optIn` cannot
 * resurrect a sweep. Writing one is refused at the settings service rather than stored inert.
 *
 * **Only the sweep.** A stage that is not swept stays runnable on demand: switching one off
 * means "do not sweep this across the library", not "never do this", and an admin asking for
 * one item explicitly has already overridden the policy by asking.
 */
export const sweepIncludes = (stage: StageDefinition, policy: StagePolicy): boolean =>
    stage.mode === "perItem" ? false : (policy[stage.name] ?? stage.mode === "automatic");

/**
 * The stage list for the admin screen.
 *
 * Derived from the registry so adding a capability adds a row here, which is the property
 * §7b was designed for and the one thing worth checking is still true.
 *
 * `countPending` is passed in rather than imported: this package has no database, and the
 * count is the one part of a stage's row that cannot be derived from the registry.
 */
export const stageSettings = (
    policy: StagePolicy,
    countPending: (stage: StageDefinition) => number
): StageSetting[] =>
    STAGES.map((stage) => {
        const enabled = sweepIncludes(stage, policy);

        return {
            name: stage.name,
            describe: stage.describe,
            mode: stage.mode,
            enabled,
            pending: enabled || stage.mode === "perItem" ? null : countPending(stage),
        };
    });
