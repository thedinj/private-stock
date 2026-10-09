import { describe, expect, it } from "vitest";

import { STAGES, findStage } from "../stages.js";
import {
    adminSettingsPatchSchema,
    stagePolicySchema,
    stageSettings,
    sweepIncludes,
    transcodeEnabled,
} from "./settings.js";

/**
 * Admin-controlled settings (§12b) and stage enablement (§7b).
 *
 * The interesting part is the direction the stage toggles are stored in, and the line between
 * a capability declared in code and a policy chosen at runtime. Both are the kind of decision
 * that looks arbitrary later and is expensive to reverse once libraries hold the rows.
 */

describe("stage enablement", () => {
    /**
     * Storing the deviations rather than the whole set.
     *
     * A capability added in a later version arrives at its registry default, because nobody
     * has decided anything about it. Storing the full answer instead would freeze every
     * existing library on the day it was written, and the symptom — work that simply never
     * happens, or work nobody asked for — is one nobody thinks to investigate.
     */
    it("leaves a stage nobody has decided about at its own default", () => {
        const settings = stageSettings({ cover: false }, () => 0);

        expect(settings.find((stage) => stage.name === "cover")?.enabled).toBe(false);

        for (const stage of settings.filter((entry) => entry.name !== "cover")) {
            expect(stage.enabled).toBe(findStage(stage.name)?.mode === "automatic");
        }
    });

    it("offers every registered stage, so adding one needs no second list", () => {
        expect(stageSettings({}, () => 0).map((stage) => stage.name)).toEqual(
            STAGES.map((stage) => stage.name)
        );
    });

    /**
     * The registry's default and the admin's decision are not the same switch (§7b).
     *
     * `mode` says what a library should do when nobody has said otherwise; the toggle says
     * what this one does. `perItem` is the exception that proves they are different kinds of
     * thing: it is a ceiling rather than a default, and no policy can lift it.
     */
    it("carries the mode, so the screen can draw three different things", () => {
        const ocr = stageSettings({}, () => 0).find((entry) => entry.name === "ocr");

        expect(ocr?.mode).toBe("optIn");
        expect(ocr?.enabled).toBe(false);
    });

    /**
     * The count is the size of the commitment, and it is only asked for where somebody is
     * being asked to make one (§7b). Counting is a scan of the matching set (§20), so a
     * running stage must not pay for a number that answers nothing.
     */
    it("counts only what is switched off, and asks once per stage at most", () => {
        const asked: string[] = [];
        const rows = stageSettings({ cover: false }, (stage) => {
            asked.push(stage.name);
            return 7;
        });

        // `cover` was switched off; `ocr`, `embed` and `faces` are off by default; the rest are
        // running.
        expect(asked.sort()).toEqual(["cover", "embed", "faces", "ocr"]);
        expect(rows.find((entry) => entry.name === "cover")?.pending).toBe(7);
        expect(rows.find((entry) => entry.name === "phash")?.pending).toBeNull();
    });

    /**
     * Only the deviations are stored, in either direction.
     *
     * An automatic stage switched off and an opt-in stage switched on are the same kind of
     * fact. That is what lets a capability added later arrive at its own default in every
     * existing library without anybody's settings being touched.
     */
    it("lets a decision override the registry, whichever way it runs", () => {
        const cover = findStage("cover")!;
        const ocr = findStage("ocr")!;

        expect(sweepIncludes(cover, {})).toBe(true);
        expect(sweepIncludes(cover, { cover: false })).toBe(false);
        expect(sweepIncludes(ocr, {})).toBe(false);
        expect(sweepIncludes(ocr, { ocr: true })).toBe(true);

        // A decision about one stage says nothing about another.
        expect(sweepIncludes(cover, { ocr: true })).toBe(true);
    });

    /**
     * `perItem` is a ceiling, not a default.
     *
     * Nothing in the registry is `perItem` today, so this builds one: the rule has to hold
     * before there is a stage relying on it, because the day a capability is demoted from
     * `optIn` is the day a stored `true` would otherwise resurrect a sweep nobody wants.
     */
    it("never sweeps a per-item stage, whatever the setting says", () => {
        const perItem = { ...findStage("ocr")!, name: "transcribe", mode: "perItem" as const };

        expect(sweepIncludes(perItem, {})).toBe(false);
        expect(sweepIncludes(perItem, { transcribe: true })).toBe(false);
    });

    it("defaults to nothing decided when the setting has never been written", () => {
        expect(stagePolicySchema.parse(undefined)).toEqual({});
    });

    /**
     * A stage removed from the registry leaves its name behind in the setting. Dropping it
     * on read would silently restore the registry's default if it ever came back under that
     * name; the write path prunes it instead, where the loss is deliberate.
     */
    it("keeps a decision about a name that is no longer a registered stage", () => {
        expect(stagePolicySchema.parse({ "retired-stage": false })).toEqual({
            "retired-stage": false,
        });
    });
});

describe("the settings patch", () => {
    /**
     * Each card saves on its own.
     *
     * A whole-object write would let an admin editing transcode settings overwrite a retention
     * window someone changed a minute earlier, using the value their page happened to load —
     * a loss nobody attributes to the settings screen, because the form still said the right
     * thing when they left it.
     */
    it("accepts one group at a time", () => {
        const parsed = adminSettingsPatchSchema.parse({ trash: { retentionDays: 3 } });

        expect(parsed.trash?.retentionDays).toBe(3);
        expect(parsed.transcode).toBeUndefined();
        expect(parsed.scan).toBeUndefined();
    });

    it("still validates what it is given", () => {
        expect(() => adminSettingsPatchSchema.parse({ trash: { retentionDays: -1 } })).toThrow();
        expect(() =>
            adminSettingsPatchSchema.parse({ transcode: { maxHeight: 99_999 } })
        ).toThrow();
    });
});

describe("transcoding's switch", () => {
    it("is switched off until an admin asks for it", () => {
        // Transcoding spends hours of NAS CPU and keeps a second copy of every unplayable
        // file — which for a remux is the size of the original. A library should not start
        // doing that on its first scan because nobody said otherwise.
        expect(transcodeEnabled({})).toBe(false);
        expect(transcodeEnabled({ ocr: true })).toBe(false);
    });

    it("is the policy's transcode entry", () => {
        expect(transcodeEnabled({ transcode: true })).toBe(true);
        expect(transcodeEnabled({ transcode: false })).toBe(false);
    });
});
