import { z } from "zod";

import {
    AuthorizationError,
    ValidationError,
    DEFAULT_HOME_LAYOUT,
    DEFAULT_TRASH_SETTINGS,
    SETTING_KEYS,
    adminSettingsPatchSchema,
    findStage,
    stagePolicySchema,
    TRANSCODE_POLICY_KEY,
    transcodeEnabled,
    dupeSettingsSchema,
    homeLayoutSchema,
    processingPauseSchema,
    scanSettingsSchema,
    throttleSettingsSchema,
    transcodeSettingsSchema,
    trashSettingsSchema,
    type AdminSettings,
    type AdminSettingsPatch,
} from "@private-stock/core";
import { jobRepo, settingRepo } from "@private-stock/db";

import { clearProcessingCache } from "./pipelineService";

/**
 * Everything an admin can change at runtime (§12b, §12c).
 *
 * One service rather than a settings endpoint per feature. The keys were previously read
 * wherever they were needed and written almost nowhere — `transcode` and `dupes` had no write
 * path at all, so the library ran on schema defaults an admin could not see, let alone
 * change. Collecting them makes that class of omission obvious: a setting with no field on
 * the screen is now a gap in one file.
 */

const requireAdmin = (scopes: string[]): void => {
    if (!scopes.includes("admin")) {
        throw new AuthorizationError("Only an administrator can change settings");
    }
};

/**
 * Reads a stored value through its schema, falling back to the schema's own defaults.
 *
 * Parsing rather than trusting is what makes a hand-edited or outdated row harmless: a
 * setting that no longer validates yields defaults and a working app, instead of a runtime
 * error somewhere far from the edit that caused it.
 */
const read = <S extends z.ZodTypeAny>(key: string, schema: S, fallback: z.infer<S>): z.infer<S> => {
    const parsed = schema.safeParse(settingRepo.get(key, undefined));

    return parsed.success ? parsed.data : fallback;
};

/**
 * Whether the library shows its "Won't play in a browser" filter (§8). Read by every viewer's
 * filter panel, so it is its own small read rather than the whole of the admin settings.
 */
export const playbackCheckEnabled = (): boolean =>
    read(SETTING_KEYS.playbackCheck, z.boolean(), false);

export const loadAdminSettings = (): AdminSettings => ({
    scan: {
        intervalMinutes: settingRepo.get(SETTING_KEYS.scanInterval, 60 * 24),
        watch: settingRepo.get(SETTING_KEYS.scanWatch, true),
    },
    // Stored as a bare number under its own key rather than as an object, because that is
    // what the key name promises and what was already written there.
    trash: trashSettingsSchema.parse({
        retentionDays: settingRepo.get(
            SETTING_KEYS.trashRetention,
            DEFAULT_TRASH_SETTINGS.retentionDays
        ),
    }),
    // The fallback is each schema parsing its own empty input, so defaults live in exactly one
    // place. Spelled out per call because an object schema and an array schema disagree about
    // what "empty" is, and a helper that guessed would be wrong for one of them.
    transcode: read(
        SETTING_KEYS.transcode,
        transcodeSettingsSchema,
        transcodeSettingsSchema.parse({})
    ),
    throttle: read(SETTING_KEYS.throttle, throttleSettingsSchema, throttleSettingsSchema.parse({})),
    dupes: read(SETTING_KEYS.dupes, dupeSettingsSchema, dupeSettingsSchema.parse({})),
    stagePolicy: read(SETTING_KEYS.stagePolicy, stagePolicySchema, {}),
    homeLayout: read(SETTING_KEYS.homeLayout, homeLayoutSchema, DEFAULT_HOME_LAYOUT),
    pause: read(SETTING_KEYS.pause, processingPauseSchema, processingPauseSchema.parse({})),
    playbackCheck: playbackCheckEnabled(),
});

/**
 * Applies whatever the caller sent, and nothing else.
 *
 * Partial on purpose: the screen saves one card at a time, so an admin editing transcode
 * settings cannot overwrite a retention window someone changed a minute earlier with the
 * value their page happened to load.
 */
export const saveAdminSettings = (patch: AdminSettingsPatch, scopes: string[]): AdminSettings => {
    requireAdmin(scopes);

    const validated = adminSettingsPatchSchema.parse(patch);

    if (validated.scan) {
        const scan = scanSettingsSchema.parse(validated.scan);
        settingRepo.set(SETTING_KEYS.scanInterval, scan.intervalMinutes);
        settingRepo.set(SETTING_KEYS.scanWatch, scan.watch);
    }

    if (validated.trash) {
        settingRepo.set(
            SETTING_KEYS.trashRetention,
            trashSettingsSchema.parse(validated.trash).retentionDays
        );
    }

    if (validated.transcode) {
        settingRepo.set(SETTING_KEYS.transcode, transcodeSettingsSchema.parse(validated.transcode));
    }

    if (validated.stagePolicy) {
        const policy = stagePolicySchema.parse(validated.stagePolicy);

        /**
         * A `perItem` stage cannot be swept, so storing `true` against one would record a
         * decision that has no effect (§7b). `sweepIncludes` ignores such a value on read,
         * which is what protects a library against a stage demoted from `optIn` — but a
         * *new* write saying so is a mistake, and the rule `requestProcessing` follows for
         * an unknown stage name applies here too: it should say so, not appear to work.
         */
        for (const [name, enabled] of Object.entries(policy)) {
            if (enabled && findStage(name)?.mode === "perItem") {
                throw new ValidationError(
                    `"${name}" runs per item only and cannot be swept across the library`
                );
            }
        }

        /**
         * Keys for stages that no longer exist are dropped rather than rejected.
         *
         * The screen sends the whole record back each time, so a capability removed from the
         * registry would otherwise leave a key that fails validation for ever — one retired
         * stage and the settings page can never be saved again. A decision about something
         * that does not exist cannot mean anything, so the write is the right moment to
         * forget it, and the admin loses nothing they could have acted on. Transcoding is
         * not a registry stage but is one of the policy's decisions (`TRANSCODE_POLICY_KEY`).
         */
        const known = Object.fromEntries(
            Object.entries(policy).filter(
                ([name]) => name === TRANSCODE_POLICY_KEY || findStage(name)
            )
        );

        /**
         * Read before the write, so the *transition* is visible rather than only the result.
         *
         * Switching transcoding off means the renditions it made go too (§8). Saving the same
         * policy again while it is already off must not queue a second purge, and turning it
         * on must never queue one at all — which is a distinction only the previous value can
         * draw.
         */
        const wasTranscoding = transcodeEnabled(
            read(SETTING_KEYS.stagePolicy, stagePolicySchema, {})
        );

        settingRepo.set(SETTING_KEYS.stagePolicy, known);

        if (wasTranscoding && !transcodeEnabled(known)) {
            /**
             * Stop the encoders here, purge the files in a job.
             *
             * The cancel is immediate because an admin switching this off usually wants the
             * box to stop working *now*, and waiting for the worker to pick up a job would
             * leave a transcode running for minutes after the switch moved. The deletion is a
             * job because there can be tens of thousands of files, which is not something a
             * settings request should hold a connection open for.
             */
            jobRepo.cancelAllTranscodes();
            jobRepo.enqueueKind("variantPurge", 50);
        }
    }

    if (validated.pause) {
        const was = read(
            SETTING_KEYS.pause,
            processingPauseSchema,
            processingPauseSchema.parse({})
        );
        const paused = validated.pause.paused;

        /**
         * The time is the server's, taken on the transition, so saving "paused" again does not
         * reset how long the queue has been held, and no client clock is trusted with it.
         */
        settingRepo.set(SETTING_KEYS.pause, {
            paused,
            since: paused ? (was.paused ? was.since : new Date().toISOString()) : null,
        });

        if (paused && !was.paused) {
            // Now, not when the slowest job in flight gets round to finishing (§7c "Pausing").
            jobRepo.releaseBackgroundClaims();
        }
    }

    if (validated.throttle) {
        settingRepo.set(SETTING_KEYS.throttle, throttleSettingsSchema.parse(validated.throttle));
    }

    if (validated.dupes) {
        settingRepo.set(SETTING_KEYS.dupes, dupeSettingsSchema.parse(validated.dupes));
    }

    if (validated.homeLayout) {
        settingRepo.set(SETTING_KEYS.homeLayout, homeLayoutSchema.parse(validated.homeLayout));
    }

    if (validated.playbackCheck !== undefined) {
        settingRepo.set(SETTING_KEYS.playbackCheck, validated.playbackCheck);
    }

    // The policy, the quiet hours and the pause are all on the processing view.
    clearProcessingCache();

    return loadAdminSettings();
};
