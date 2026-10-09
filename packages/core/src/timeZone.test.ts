import { describe, expect, it } from "vitest";

import {
    effectiveTimeZone,
    hourIn,
    isNamedTimeZone,
    isSupportedTimeZone,
    supportedTimeZones,
    systemTimeZone,
    timeZoneOffsetLabel,
    timeZoneSchema,
} from "./timeZone.js";

/**
 * The clock quiet hours are read on (§7c).
 *
 * All of this is `Intl` rather than a date library, so the tests are as much a check that the
 * engine behaves as assumed as they are a check of the code. Every one below is a way the
 * schedule can be an hour or six out while every part of it looks correct.
 */

describe("hourIn", () => {
    /**
     * The whole point. The same instant is a different hour in two places, and the schedule
     * has to be read in the one the admin lives in rather than the one the container runs in.
     */
    it("reads one instant as a different hour in each zone", () => {
        const at = new Date("2026-01-15T03:30:00Z");

        expect(hourIn("UTC", at)).toBe(3);
        expect(hourIn("America/Chicago", at)).toBe(21);
        expect(hourIn("Asia/Tokyo", at)).toBe(12);
    });

    /**
     * Daylight saving, which is the reason a stored offset would not have done. A fixed
     * `-06:00` for Chicago puts the whole window an hour out for eight months of the year --
     * and the four months it is right are the ones nobody tests in.
     */
    it("follows daylight saving rather than a fixed offset", () => {
        // 08:30 UTC is 02:30 in Chicago on standard time and 03:30 on summer time.
        expect(hourIn("America/Chicago", new Date("2026-01-15T08:30:00Z"))).toBe(2);
        expect(hourIn("America/Chicago", new Date("2026-07-15T08:30:00Z"))).toBe(3);
    });

    /**
     * `hour12: false` renders midnight as 24 on several engines, which would put the hour
     * outside 0-23 for one hour a day and quietly fail every window that includes it.
     */
    it("calls midnight zero, not twenty-four", () => {
        expect(hourIn("UTC", new Date("2026-03-01T00:30:00Z"))).toBe(0);
        expect(hourIn("UTC", new Date("2026-03-01T23:59:00Z"))).toBe(23);
    });

    /** Half-hour zones exist, and the hour is the one they are actually in. */
    it("handles a zone offset by half an hour", () => {
        expect(hourIn("Asia/Calcutta", new Date("2026-01-15T03:00:00Z"))).toBe(8);
        expect(hourIn("Asia/Calcutta", new Date("2026-01-15T03:31:00Z"))).toBe(9);
    });
});

describe("isSupportedTimeZone", () => {
    it("accepts a zone the engine knows", () => {
        expect(isSupportedTimeZone("America/Chicago")).toBe(true);
        expect(isSupportedTimeZone("UTC")).toBe(true);
    });

    it("rejects anything the engine cannot convert with", () => {
        expect(isSupportedTimeZone("Not/AZone")).toBe(false);
        expect(isSupportedTimeZone("")).toBe(false);
    });

    /**
     * Worth pinning, because it is surprising and it is why `isNamedTimeZone` exists: the
     * engine takes a bare offset as a time zone without complaint.
     */
    it("accepts a bare offset, which the engine really does allow", () => {
        expect(isSupportedTimeZone("-06:00")).toBe(true);
    });
});

describe("isNamedTimeZone", () => {
    it("accepts a named zone", () => {
        expect(isNamedTimeZone("America/Chicago")).toBe(true);
        expect(isNamedTimeZone("UTC")).toBe(true);
    });

    /**
     * A fixed offset reports the same hour all year, so a window stored as one is an hour
     * out for as long as summer time lasts -- the exact failure a stored zone exists to
     * prevent, reached through a value nothing rejected.
     */
    it("refuses a bare offset, which follows no daylight saving", () => {
        expect(isNamedTimeZone("-06:00")).toBe(false);
        expect(isNamedTimeZone("+05:30")).toBe(false);

        // Demonstrating why: the offset is frozen across the daylight-saving boundary.
        expect(hourIn("-06:00", new Date("2026-01-15T12:00:00Z"))).toBe(6);
        expect(hourIn("-06:00", new Date("2026-07-15T12:00:00Z"))).toBe(6);
    });
});

describe("timeZoneSchema", () => {
    it("defaults to the host's own zone, expressed as null", () => {
        expect(timeZoneSchema.parse(undefined)).toBeNull();
    });

    it("keeps a zone the engine knows", () => {
        expect(timeZoneSchema.parse("Europe/London")).toBe("Europe/London");
    });

    /**
     * The validation has to be here rather than at the picker. A settings PUT is an API, and
     * a zone that reaches the database unchecked makes every later `hourIn` throw inside the
     * claim loop.
     */
    it("refuses a zone the engine does not know", () => {
        expect(timeZoneSchema.safeParse("Mars/Olympus").success).toBe(false);
    });

    it("refuses a fixed offset even though the engine would take it", () => {
        expect(timeZoneSchema.safeParse("-06:00").success).toBe(false);
    });
});

describe("effectiveTimeZone", () => {
    it("uses the stored zone when there is one", () => {
        expect(effectiveTimeZone("Australia/Sydney")).toBe("Australia/Sydney");
    });

    it("falls back to the host for null", () => {
        expect(effectiveTimeZone(null)).toBe(systemTimeZone());
    });

    /**
     * Zone names are retired -- a library configured on one engine can be read by a later
     * one. Running on the host's clock is wrong; refusing to resolve an hour at all would
     * stop the worker claiming anything.
     */
    it("falls back rather than throwing on a zone this engine has never heard of", () => {
        expect(effectiveTimeZone("Middle/Earth")).toBe(systemTimeZone());
    });
});

describe("timeZoneOffsetLabel", () => {
    it("renders an offset the way a picker should show it", () => {
        expect(timeZoneOffsetLabel("America/Chicago", new Date("2026-01-15T12:00:00Z"))).toBe(
            "UTC-06:00"
        );
        expect(timeZoneOffsetLabel("Asia/Calcutta", new Date("2026-01-15T12:00:00Z"))).toBe(
            "UTC+05:30"
        );
    });

    /** The label moves with the season, because otherwise it is wrong for half the year. */
    it("shows the offset in force at that moment", () => {
        expect(timeZoneOffsetLabel("America/Chicago", new Date("2026-07-15T12:00:00Z"))).toBe(
            "UTC-05:00"
        );
    });

    /** `longOffset` gives UTC itself a bare "GMT" with no offset attached. */
    it("gives UTC an offset rather than an empty one", () => {
        expect(timeZoneOffsetLabel("UTC", new Date("2026-01-15T12:00:00Z"))).toBe("UTC+00:00");
    });
});

describe("supportedTimeZones", () => {
    it("offers a real list, all of which validate", () => {
        const zones = supportedTimeZones();

        expect(zones.length).toBeGreaterThan(100);
        expect(zones.every(isSupportedTimeZone)).toBe(true);
    });

    /**
     * The engine may list the backward-compatible spellings rather than the modern ones, so
     * the picker must not assume a name it wants is present -- it shows what it is given.
     * What matters is that a zone for the anchor cities exists under one spelling or the
     * other.
     */
    it("covers the major zones under whichever spelling the engine uses", () => {
        const zones = new Set(supportedTimeZones());

        expect(zones.has("Asia/Kolkata") || zones.has("Asia/Calcutta")).toBe(true);
        expect(zones.has("Europe/Kyiv") || zones.has("Europe/Kiev")).toBe(true);
        expect(zones.has("America/Chicago")).toBe(true);
    });
});
