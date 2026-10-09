import { z } from "zod";

import {
    AuthorizationError,
    OCR_TEST_SET_LIMIT,
    SETTING_KEYS,
    ValidationError,
    ocrSettingsOf,
    ocrSettingsRecordSchema,
    ocrSettingsSchema,
    ocrTestSetSchema,
    ocrTrialFindingSchema,
    type OcrBench,
    type OcrBenchItem,
    type OcrExpectedInput,
    type OcrTestEntry,
    type OcrTestSetAddInput,
    type OcrTestSetInput,
    type OcrTrialRunInput,
    type OcrTrialSide,
} from "@private-stock/core";
import { loadConfig, removeTuneCache } from "@private-stock/core/server";
import { artifactRepo, mediaTextRepo, ocrTrialRepo, settingRepo } from "@private-stock/db";

import type { AuthContext } from "../auth/withAuth";
import { coverUrl } from "./artService";

/**
 * The OCR test bench (§5d "Settings and the test bench").
 *
 * A few nominated videos, each read under the current settings and under a candidate, side by
 * side. Reading both sides fresh is deliberate: comparing a candidate against the text already
 * stored would compare it against whatever settings that text was read under, which after a
 * few changes is nobody's current settings.
 */

const requireAdmin = (auth: AuthContext): void => {
    if (!auth.scopes.includes("admin")) {
        throw new AuthorizationError("Only an administrator can use the OCR test bench");
    }
};

/** The nominated videos, each with the text an administrator says it should yield. */
export const loadTestSet = (): OcrTestEntry[] => {
    const parsed = ocrTestSetSchema.safeParse(settingRepo.get(SETTING_KEYS.ocrTestSet, []));

    return parsed.success ? parsed.data : [];
};

/**
 * Store the bench, dropping what goes with any video taken off it: its trials, and the
 * tuner's cached readings, which would otherwise sit on disk for a video nobody tunes against.
 */
const saveTestSet = (before: OcrTestEntry[], next: OcrTestEntry[]): void => {
    settingRepo.set(SETTING_KEYS.ocrTestSet, next);

    const kept = new Set(next.map((entry) => entry.mediaId));
    const gone = before.map((entry) => entry.mediaId).filter((id) => !kept.has(id));

    ocrTrialRepo.removeForMedia(gone);

    const config = loadConfig();

    for (const mediaId of gone) {
        // Best effort: a cache left behind costs disk, never correctness.
        void removeTuneCache(config, mediaId).catch(() => undefined);
    }
};

const findingsSchema = z.array(ocrTrialFindingSchema);

const toSide = (row: ocrTrialRepo.OcrTrialRow | undefined): OcrTrialSide | null => {
    if (!row) {
        return null;
    }

    const settings = ocrSettingsSchema.safeParse(JSON.parse(row.settingsJson));
    const findings = row.findingsJson
        ? findingsSchema.safeParse(JSON.parse(row.findingsJson))
        : null;

    return {
        state: row.state,
        settings: settings.success ? settings.data : ocrSettingsSchema.parse({}),
        findings: findings?.success ? findings.data : [],
        framesRead: row.framesRead,
        elapsedMs: row.elapsedMs,
        error: row.error,
    };
};

const benchFor = (entries: OcrTestEntry[]): OcrBench => {
    const mediaIds = entries.map((entry) => entry.mediaId);
    const truth = new Map(entries.map((entry) => [entry.mediaId, entry]));
    const heads = new Map(mediaTextRepo.listItemHeads(mediaIds).map((head) => [head.id, head]));
    const trials = ocrTrialRepo.listForMediaIds(mediaIds);

    return {
        limit: OCR_TEST_SET_LIMIT,
        items: mediaIds.flatMap((mediaId): OcrBenchItem[] => {
            const head = heads.get(mediaId);

            if (!head) {
                return [];
            }

            const cover = artifactRepo.findEffectiveCover(mediaId);
            const fileName = head.listRelPath?.split("/").pop() ?? "";
            const mine = trials.filter((trial) => trial.mediaId === mediaId);

            return [
                {
                    mediaId,
                    kind: head.kind,
                    fileName,
                    title: head.title ?? fileName,
                    coverUrl: cover ? coverUrl(mediaId, cover.relPath, cover.generatedAt) : null,
                    expected: truth.get(mediaId)?.expected ?? [],
                    complete: truth.get(mediaId)?.complete ?? false,
                    current: toSide(mine.find((trial) => trial.side === "current")),
                    candidate: toSide(mine.find((trial) => trial.side === "candidate")),
                },
            ];
        }),
    };
};

export const getBench = (auth: AuthContext): OcrBench => {
    requireAdmin(auth);

    return benchFor(loadTestSet());
};

/** Replace the nominated videos. Trials of any taken off go with them. */
export const setTestSet = (input: OcrTestSetInput, auth: AuthContext): OcrBench => {
    requireAdmin(auth);

    const before = loadTestSet();
    const existing = new Map(before.map((entry) => [entry.mediaId, entry]));
    // Only items that exist, in the order given, once each — keeping what was expected of
    // those already there.
    const known = new Set(mediaTextRepo.listItemHeads(input.mediaIds).map((head) => head.id));
    const next = [...new Set(input.mediaIds)]
        .filter((id) => known.has(id))
        .map(
            (mediaId): OcrTestEntry =>
                existing.get(mediaId) ?? { mediaId, expected: [], complete: false }
        );

    saveTestSet(before, next);

    return benchFor(next);
};

/** Nominate more videos, refusing rather than silently dropping any past the limit. */
export const addToTestSet = (input: OcrTestSetAddInput, auth: AuthContext): OcrBench => {
    requireAdmin(auth);

    const current = loadTestSet().map((entry) => entry.mediaId);
    const next = [...new Set([...current, ...input.mediaIds])];

    if (next.length > OCR_TEST_SET_LIMIT) {
        throw new ValidationError(
            `The test bench holds ${OCR_TEST_SET_LIMIT} videos; remove some before adding more`
        );
    }

    return setTestSet({ mediaIds: next }, auth);
};

/**
 * Compare a candidate against the current settings on every nominated video.
 *
 * Both sides are read fresh, as requested work: ahead of background work and outside the
 * working window, because somebody is waiting at the bench (§7c). Each video's earlier
 * comparison is replaced.
 */
export const runTrials = (input: OcrTrialRunInput, auth: AuthContext): OcrBench => {
    requireAdmin(auth);

    const testSet = loadTestSet();

    if (testSet.length === 0) {
        throw new ValidationError("Nominate at least one video before running a comparison");
    }

    const stored = ocrSettingsRecordSchema.safeParse(settingRepo.get(SETTING_KEYS.ocr, {}));
    const current = ocrSettingsOf(stored.success ? stored.data : ocrSettingsRecordSchema.parse({}));
    const candidate = ocrSettingsSchema.parse(input.candidate);

    for (const { mediaId } of testSet) {
        ocrTrialRepo.replaceForMedia(
            mediaId,
            [
                { side: "current", settingsJson: JSON.stringify(current) },
                { side: "candidate", settingsJson: JSON.stringify(candidate) },
            ],
            auth.userId
        );
    }

    return benchFor(testSet);
};

/**
 * Say what a nominated video should yield (§5d "Tuning against expected text").
 *
 * Typed by an administrator: this is the ground truth the tuner scores settings against, and
 * the bench marks a comparison's hits and misses by it.
 */
export const setExpected = (input: OcrExpectedInput, auth: AuthContext): OcrBench => {
    requireAdmin(auth);

    const before = loadTestSet();

    if (!before.some((entry) => entry.mediaId === input.mediaId)) {
        throw new ValidationError("Put the video on the bench before saying what it should read");
    }

    const expected = [...new Set(input.expected.map((text) => text.replace(/\s+/g, " ")))];
    const next = before.map((entry) =>
        entry.mediaId === input.mediaId ? { ...entry, expected, complete: input.complete } : entry
    );

    saveTestSet(before, next);

    return benchFor(next);
};
