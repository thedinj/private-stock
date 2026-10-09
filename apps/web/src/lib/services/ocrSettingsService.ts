import {
    AuthorizationError,
    OCR_RECIPE_UNRECORDED,
    SETTING_KEYS,
    findStage,
    ocrRecipe,
    ocrSettingsOf,
    ocrSettingsRecordSchema,
    ocrSettingsSchema,
    type OcrRerunOutdatedInput,
    type OcrRerunOutdatedResult,
    type OcrSettings,
    type OcrSettingsRecord,
    type OcrSettingsView,
} from "@private-stock/core";
import { settingRepo, stageRepo } from "@private-stock/db";

import type { AuthContext } from "../auth/withAuth";
import { clearProcessingCache } from "./pipelineService";

/**
 * How OCR reads, as an administrator sets it (§5d "Settings and the test bench").
 *
 * Its own service and route rather than a card of the admin settings object, because saving
 * does two things the generic save does not: it advances the revision every outcome records,
 * and it reports how much of the library that leaves reading under older settings.
 */

const requireAdmin = (auth: AuthContext): void => {
    if (!auth.scopes.includes("admin")) {
        throw new AuthorizationError("Only an administrator can change how OCR reads");
    }
};

/** The stored record, or the defaults when nothing valid is stored. */
const loadRecord = (): OcrSettingsRecord => {
    const parsed = ocrSettingsRecordSchema.safeParse(settingRepo.get(SETTING_KEYS.ocr, {}));

    return parsed.success ? parsed.data : ocrSettingsRecordSchema.parse({});
};

const view = (record: OcrSettingsRecord): OcrSettingsView => {
    const outdated = stageRepo.countOutdated("ocr", ocrRecipe(record), OCR_RECIPE_UNRECORDED);

    return {
        settings: record,
        defaults: ocrSettingsSchema.parse({}),
        staleItems: outdated.items,
        staleReviewed: outdated.reviewed,
    };
};

export const getOcrSettings = (auth: AuthContext): OcrSettingsView => {
    requireAdmin(auth);

    return view(loadRecord());
};

/**
 * Save the settings, as a new revision when anything changed.
 *
 * Saving the same values again does not advance the revision: that would mark the whole
 * library as read under older settings for a change that changed nothing.
 *
 * Nothing is re-read (§5d "What happens when OCR settings change"). Jobs that start after this
 * use the new settings; finished items keep their text until somebody asks for them again.
 */
export const saveOcrSettings = (input: OcrSettings, auth: AuthContext): OcrSettingsView => {
    requireAdmin(auth);

    const current = loadRecord();
    const next = ocrSettingsSchema.parse(input);
    const changed = JSON.stringify(ocrSettingsOf(current)) !== JSON.stringify(next);

    if (!changed) {
        return view(current);
    }

    const record: OcrSettingsRecord = { ...next, revision: current.revision + 1 };

    settingRepo.set(SETTING_KEYS.ocr, record);

    return view(record);
};

/**
 * Queue one batch of items read under older settings, as ordinary background work.
 *
 * Not requested work: a library-wide re-read is what the working window is for (§7c), and
 * marking it requested would put hours of CPU ahead of everything else. The client loops batch
 * by batch so it can be stopped between them.
 */
export const rerunOutdated = (
    input: OcrRerunOutdatedInput,
    auth: AuthContext
): OcrRerunOutdatedResult => {
    requireAdmin(auth);

    const stage = findStage("ocr");

    if (!stage) {
        return { queued: 0, next: null };
    }

    const result = stageRepo.queueOutdated(
        stage,
        ocrRecipe(loadRecord()),
        OCR_RECIPE_UNRECORDED,
        input.after,
        input.limit
    );

    clearProcessingCache();

    return result;
};
