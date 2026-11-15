import { timelineMarkers, type FrameRate, type ReelTimeline } from "./timeline.js";

/**
 * A timeline's markers as an EDL, in the form Resolve writes and reads back with "Import →
 * Timeline Markers from EDL" (§14d "Editor export").
 *
 * The second file because the first could not carry them: Resolve's FCPXML import drops both
 * `<keyword>` and clip `<marker>` (tested 2026-11-14). An EDL of markers is Resolve's own way of
 * moving markers between timelines, so it is the route that is meant to work.
 *
 * Each marker is a one-frame event at its record timecode, with a comment line carrying the
 * colour, the name and the duration:
 *
 *     001  001      V     C        00:00:00:00 00:00:00:01 00:00:00:00 00:00:00:01
 *      |C:ResolveColorBlue |M:Jump |D:1
 *
 * Timecode is counted from the timeline's start (the FCPXML writes `tcStart="0s"`), non-drop at
 * the nominal rate -- 30 for 29.97 -- which is how the FCPXML's `tcFormat="NDF"` counts too.
 */

/** A colour per kind, so a glance along the timeline says which marker is which. */
const COLOURS: Record<string, string> = {
    label: "ResolveColorBlue",
    performer: "ResolveColorGreen",
    source: "ResolveColorYellow",
    tag: "ResolveColorCyan",
    rating: "ResolveColorRed",
};
const OTHER_COLOUR = "ResolveColorPurple";

const timecode = (frames: number, rate: FrameRate): string => {
    const fps = Math.round(rate.num / rate.den);
    const parts = [
        Math.floor(frames / (fps * 3600)),
        Math.floor(frames / (fps * 60)) % 60,
        Math.floor(frames / fps) % 60,
        frames % fps,
    ];

    return parts.map((part) => String(part).padStart(2, "0")).join(":");
};

/**
 * Text as one EDL field: `|` starts the next field and a line break ends the event, so neither
 * can stay; nor can the control characters a hand-written label might hold.
 */
const field = (text: string): string =>
    text
        // eslint-disable-next-line no-control-regex -- removing them is the point
        .replace(/[\u0000-\u001f\u007f]+/g, " ")
        .replace(/\|/g, "/")
        .trim();

/** Null for a timeline with nothing to mark: no file is better than an empty one. */
export const writeMarkerEdl = (timeline: ReelTimeline): string | null => {
    const markers = timelineMarkers(timeline);

    if (markers.length === 0) return null;

    const lines = [`TITLE: ${field(timeline.name)}`, "FCM: NON-DROP FRAME", ""];

    markers.forEach((marker, index) => {
        const from = timecode(marker.frame, timeline.rate);
        const to = timecode(marker.frame + 1, timeline.rate);
        const event = String(index + 1).padStart(3, "0");

        lines.push(`${event}  001      V     C        ${from} ${to} ${from} ${to}  `);
        lines.push(` |C:${COLOURS[marker.kind] ?? OTHER_COLOUR} |M:${field(marker.text)} |D:1`, "");
    });

    // CRLF: the line ending EDLs have always had, and the one Resolve writes.
    return lines.join("\r\n");
};
