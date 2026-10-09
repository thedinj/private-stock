import { z } from "zod";

import { timeZoneSchema } from "./timeZone.js";

/**
 * When the pipeline is allowed to work (§7c).
 *
 * §7b decides *what* processing is owed; this decides *when* it may be done. A NAS that
 * catalogues at full tilt at eight in the evening is technically working and practically
 * broken -- the library browses badly, playback stutters, and the cause is invisible because
 * everything in the admin view says "busy", which is exactly what it should say.
 *
 * Everything here is pure and takes the hour as a number. The worker owns the clock, this
 * owns the arithmetic, and the wrap across midnight -- the one case a hand-rolled comparison
 * gets wrong, and the likeliest setting on a home NAS -- is tested rather than assumed.
 */

export const throttleSettingsSchema = z
    .object({
        /**
         * Off on a fresh install.
         *
         * A first import should catalogue as fast as the box allows; throttling is something
         * an admin turns on after noticing the NAS struggling. A default that quietly halved
         * first-import speed would be read as the app being slow, and the setting that caused
         * it is the last place anyone would look.
         */
        enabled: z.boolean().default(false),
        /** First hour of the full-speed window, inclusive. */
        startHour: z.coerce.number().int().min(0).max(23).default(2),
        /** First hour *after* the window. Exclusive, so 2-8 is six hours, not seven. */
        endHour: z.coerce.number().int().min(0).max(23).default(8),
        /**
         * Cores an off-peak encode may use, as a share of what the box has.
         *
         * The concurrency floor does nothing for transcoding -- that kind is pinned at one
         * job either way -- and process priority only decides who wins a fight for the CPU,
         * not how much of an idle CPU ffmpeg takes. A thread cap is the only one of the three
         * levers that is a hard ceiling, and unlike a cheaper preset it changes how long the
         * encode takes without changing what comes out of it.
         */
        threadShare: z.coerce.number().min(0.1).max(1).default(0.5),
        /**
         * Whose clock `startHour` and `endHour` are on. Null means the host's own.
         *
         * A number is not a time until something says which clock it is read on, and the
         * answer used to be "the container's", which on a NAS is whatever `TZ` was left at.
         * An admin picking 2 to 8 from a browser in Chicago was configuring 20:00 to 02:00
         * of their own evening, the schedule fired exactly as written, and every screen in
         * the app agreed with them — so there was nothing to notice.
         *
         * Here rather than as an app-wide display setting on purpose (§12b). Timestamps a
         * person reads are rendered by their browser, which knows their zone and is right
         * about it for several users at once. Only what the server decides unattended needs
         * a zone of its own, and this is the only such decision.
         */
        timeZone: timeZoneSchema,
    })
    .refine((settings) => settings.startHour !== settings.endHour, {
        message: "The window needs a start and an end that differ.",
        path: ["endHour"],
    });
export type ThrottleSettings = z.infer<typeof throttleSettingsSchema>;

export const DEFAULT_THROTTLE_SETTINGS: ThrottleSettings = throttleSettingsSchema.parse({});

/**
 * Whether an hour falls inside the window.
 *
 * The second branch is the whole reason this is a function. `22 -> 06` is not an exotic
 * setting, it is the obvious one for a home NAS, and `hour >= start && hour < end` silently
 * matches nothing at all for it -- a throttle that is on, configured, and never once lifts.
 */
export const inWindow = (hour: number, startHour: number, endHour: number): boolean =>
    startHour < endHour ? hour >= startHour && hour < endHour : hour >= startHour || hour < endHour;

/**
 * Whether background work should be held back right now.
 *
 * Note the inversion: the window is when the pipeline runs *freely*, so being outside it is
 * what throttles. Storing it the other way round would read more directly here and worse
 * everywhere else -- an admin thinks in terms of "run hard overnight", not "be quiet for the
 * other eighteen hours".
 */
export const isThrottled = (settings: ThrottleSettings, hour: number): boolean =>
    settings.enabled && !inWindow(hour, settings.startHour, settings.endHour);

/**
 * The hour the current state ends, or null when nothing is scheduled to change.
 *
 * Only ever the start or the end of the window, because there are only two edges. It exists
 * so the progress view can say "throttled until 02:00" rather than leaving a barely-moving
 * bar to be read as a dead worker (§13c) -- which is the same failure the liveness badge was
 * added to prevent, arriving by a different route.
 */
export const throttleChangesAt = (settings: ThrottleSettings, hour: number): number | null => {
    if (!settings.enabled) {
        return null;
    }

    return inWindow(hour, settings.startHour, settings.endHour)
        ? settings.endHour
        : settings.startHour;
};

/**
 * How many encoder threads an off-peak transcode may use.
 *
 * Floored at one rather than rounded, because rounding a single-core box down to zero hands
 * ffmpeg a `-threads 0` that means "use everything" -- the exact opposite of the instruction,
 * arrived at by arithmetic, and only on the smallest machines.
 */
export const throttledThreads = (settings: ThrottleSettings, cpuCount: number): number =>
    Math.max(1, Math.floor(Math.max(1, cpuCount) * settings.threadShare));
