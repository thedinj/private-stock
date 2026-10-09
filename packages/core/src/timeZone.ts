import { z } from "zod";

/**
 * The clock a schedule is measured against (§7c).
 *
 * Quiet hours are stored as two numbers, `2` and `8`, and a number is not a time until
 * something says whose clock it is. Until now that was the host's, which on a QNAP container
 * is whatever `TZ` happened to be — usually UTC — while the admin setting it was reading a
 * wall clock five or six hours away. The schedule then fires at the right time and looks
 * broken, and nothing in the app disagrees with them.
 *
 * **No dependency.** `Intl` has carried the full IANA database since Node 14 and in every
 * browser we support: it enumerates the zones, validates one, and converts an instant into a
 * zone's local hour, with the daylight-saving rules and their historical changes included. A
 * date library would add a second copy of that database to the bundle to answer the two
 * questions below. What it would buy is arithmetic *on* zoned times — "add a month in
 * Auckland" — and nothing here does any.
 *
 * Deliberately scoped to the schedule rather than made an app-wide display setting. Every
 * timestamp a person reads is rendered in their own browser, which already knows their zone
 * and is right about it for each of several users at once. The server's zone matters only for
 * things the server decides on its own, and quiet hours is the only one of those.
 */

/** A zone the running engine actually knows, not merely a plausible-looking string. */
export const isSupportedTimeZone = (value: string): boolean => {
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: value });

        return true;
    } catch {
        // RangeError is the documented signal for an unknown zone. Anything else thrown here
        // is an engine without zone support at all, which is the same answer to the caller.
        return false;
    }
};

/**
 * A *named* zone, which is the only kind that carries daylight-saving rules.
 *
 * `Intl` also accepts a bare offset — `"-06:00"` is a valid `timeZone` and resolves to
 * itself — and it is a fixed offset, reporting the same hour in January and July. Accepting
 * one would hand somebody a quiet-hours window that is an hour out for eight months of the
 * year, arrived at through a value the engine raised no objection to. Since following
 * daylight saving is the entire reason a zone is stored rather than an offset, this is the
 * check the settings API uses.
 */
export const isNamedTimeZone = (value: string): boolean =>
    isSupportedTimeZone(value) && /^[A-Za-z]/.test(value);

/**
 * Null means the host's own zone.
 *
 * Stored rather than resolving to a concrete zone at write time, so that a container given a
 * correct `TZ` needs no setting at all, and one that is later corrected is followed rather
 * than overridden by a value captured from whatever it used to be.
 *
 * Validated against the engine, which is the only authority on what it can convert. Zone
 * names are added and retired — `Europe/Kyiv` did not exist a few years ago — so a hardcoded
 * list here would be a second source of truth that goes stale silently.
 */
export const timeZoneSchema = z
    .string()
    .min(1)
    .max(64)
    .refine(isNamedTimeZone, {
        message: "Not a named time zone this server recognises.",
    })
    .nullable()
    .default(null);

/** The host's zone, as the engine resolves it. */
export const systemTimeZone = (): string => {
    const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;

    // Undefined on an engine built without the full ICU data. UTC is the honest fallback:
    // wrong for most people, but unambiguous, and it fails the same way for everyone rather
    // than differently on each machine.
    return resolved && isSupportedTimeZone(resolved) ? resolved : "UTC";
};

/**
 * The zone a schedule should actually use.
 *
 * Falls back rather than throwing when a stored zone has been retired by a later engine. The
 * pipeline running on the wrong clock is a bad day; the pipeline refusing to start because a
 * zone was renamed is a worse one.
 */
export const effectiveTimeZone = (stored: string | null | undefined): string =>
    stored && isSupportedTimeZone(stored) ? stored : systemTimeZone();

/**
 * The hour of the day at an instant, in a zone.
 *
 * `hourCycle: "h23"` and not `hour12: false`, which is the same thing everywhere except
 * midnight, where several engines render `24`. An off-by-one that appears for one hour a day
 * is exactly the kind that ships.
 *
 * Daylight saving is the tz database's problem and it is already solved: the offset comes
 * from the rule in force at *that instant*, so a window does not drift by an hour twice a
 * year. Two edges are worth knowing about and neither needs handling. The hour that spring
 * forward skips never arrives, so a window starting in it simply does not open that day; the
 * hour that autumn repeats arrives twice, so such a window opens twice. Both are the truthful
 * reading of "between 2 and 3 local time".
 */
export const hourIn = (timeZone: string, at: Date = new Date()): number =>
    Number(
        new Intl.DateTimeFormat("en-US", {
            timeZone,
            hour: "numeric",
            hourCycle: "h23",
        }).format(at)
    );

/**
 * A zone's offset right now, as `UTC+05:30`.
 *
 * For the picker, where `Asia/Kolkata` alone does not tell somebody whether they have found
 * the zone they meant. Taken at an instant rather than stated as a constant because half the
 * world's offsets change twice a year, and a label that says `UTC+00:00` for London all
 * summer is worse than no label.
 */
export const timeZoneOffsetLabel = (timeZone: string, at: Date = new Date()): string => {
    const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
        .formatToParts(at)
        .find((candidate) => candidate.type === "timeZoneName");

    // `longOffset` renders UTC itself as a bare "GMT" rather than "GMT+00:00".
    const offset = (part?.value ?? "GMT").replace("GMT", "");

    return `UTC${offset === "" ? "+00:00" : offset}`;
};

/**
 * Every zone the engine knows.
 *
 * `Intl.supportedValuesOf` is ES2022 and absent on older engines, hence the fallback — a
 * short list is a usable picker, an exception is a broken settings page.
 */
export const supportedTimeZones = (): string[] => {
    try {
        return Intl.supportedValuesOf("timeZone");
    } catch {
        return ["UTC", systemTimeZone()].filter((zone, index, all) => all.indexOf(zone) === index);
    }
};
