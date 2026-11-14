import { windowsFileUrl } from "./networkPath.js";
import {
    msToFrames,
    sameRate,
    timecodeToFrames,
    type FrameRate,
    type ReelTimeline,
    type TimelineSource,
} from "./timeline.js";

/**
 * A reel timeline as FCPXML 1.10, the file Resolve's File → Import → Timeline reads best
 * (§14d "Editor export").
 *
 * FCPXML over OTIO because Resolve's OTIO import keeps only cuts: speed, markers and clip names
 * -- three of the four things a reel carries -- arrive through FCPXML and are lost through OTIO.
 *
 * Every time is a rational number of seconds (`1001/30000s`), never a decimal, because a decimal
 * 29.97 frame is not a frame and the editor rounds it somewhere you did not choose. The XML is
 * built by hand: the structure is small and fixed, and the escaping helper is the whole of what
 * a library would add.
 *
 * Time maps follow auto-editor's FCPXML writer, the reference that is known to import: a clip
 * with a speed has a `timeMap` from clip time to media time across the whole asset, and its
 * `start` is then in clip time -- the in-point divided by the speed.
 */

/** Seconds as an exact FCPXML time: `n/d` seconds, reduced, `"0s"` for zero. */
const seconds = (numerator: number, denominator: number): string => {
    if (numerator === 0) return "0s";

    const divisor = gcd(Math.abs(numerator), denominator);
    const n = numerator / divisor;
    const d = denominator / divisor;

    return d === 1 ? `${n}s` : `${n}/${d}s`;
};

/** `frames` whole frames at `rate`, as a time. */
const framesAt = (frames: number, rate: FrameRate): string => seconds(frames * rate.den, rate.num);

/** A speed as a rational to the thousandth, which covers every value the player can set. */
const speedRatio = (speed: number): { num: number; den: number } => ({
    num: Math.round(speed * 1000),
    den: 1000,
});

export const escapeXml = (text: string): string =>
    text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;")
        // XML 1.0 cannot carry these at all, escaped or not.
        // eslint-disable-next-line no-control-regex -- matching them is the point
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

const attrs = (values: Record<string, string | number | undefined>): string =>
    Object.entries(values)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}="${escapeXml(String(value))}"`)
        .join(" ");

/** Final Cut's own format names for the common cases; anything else goes unnamed. */
const formatName = (rate: FrameRate, width: number, height: number): string | undefined => {
    const lines: Record<string, string> = { "1280x720": "720p", "1920x1080": "1080p" };
    const line = lines[`${width}x${height}`];
    const suffix: Record<string, string> = {
        "24000/1001": "2398",
        "24/1": "24",
        "25/1": "25",
        "30000/1001": "2997",
        "30/1": "30",
        "50/1": "50",
        "60000/1001": "5994",
        "60/1": "60",
    };
    const rateSuffix = suffix[`${rate.num}/${rate.den}`];

    return line && rateSuffix ? `FFVideoFormat${line}${rateSuffix}` : undefined;
};

/** Keyword text: FCPXML separates keywords with commas, so a comma inside a tag cannot stay. */
const keywordValue = (keywords: string[]): string =>
    keywords.map((keyword) => keyword.replace(/,/g, " ").trim()).join(", ");

export const writeFcpxml = (timeline: ReelTimeline): string => {
    const seqRate = timeline.rate;
    const lines: string[] = [];
    const formats: { id: string; rate: FrameRate; width: number; height: number }[] = [
        { id: "r1", rate: seqRate, width: timeline.width, height: timeline.height },
    ];
    let nextId = 2;

    const formatFor = (rate: FrameRate, width: number, height: number): string => {
        const found = formats.find(
            (f) => sameRate(f.rate, rate) && f.width === width && f.height === height
        );

        if (found) return found.id;

        const id = `r${nextId++}`;

        formats.push({ id, rate, width, height });

        return id;
    };

    // Per source: its clock, its timecode start and the length of the asset in its own frames.
    const assets = timeline.sources.map((source: TimelineSource) => {
        const rate = source.rate ?? seqRate;
        const tcFrames = source.timecode ? (timecodeToFrames(source.timecode, rate) ?? 0) : 0;
        const neededFrames = Math.max(
            0,
            ...timeline.clips
                .filter((clip) => clip.mediaId === source.mediaId)
                .map(
                    (clip) =>
                        clip.sourceInFrames +
                        msToFrames(
                            (clip.durationFrames * seqRate.den * 1000 * clip.speed) / seqRate.num,
                            rate
                        )
                )
        );
        const durationFrames = Math.max(
            source.durationMs ? msToFrames(source.durationMs, rate) : 0,
            neededFrames,
            1
        );

        return {
            source,
            id: `r${nextId++}`,
            rate,
            tcFrames,
            durationFrames,
            format: formatFor(
                rate,
                source.width ?? timeline.width,
                source.height ?? timeline.height
            ),
        };
    });
    const assetFor = new Map(assets.map((asset) => [asset.source.mediaId, asset]));

    lines.push('<?xml version="1.0" encoding="UTF-8"?>');
    lines.push("<!DOCTYPE fcpxml>");
    lines.push('<fcpxml version="1.10">');
    lines.push("    <resources>");

    for (const format of formats) {
        lines.push(
            `        <format ${attrs({
                id: format.id,
                name: formatName(format.rate, format.width, format.height),
                frameDuration: seconds(format.rate.den, format.rate.num),
                width: format.width,
                height: format.height,
            })}/>`
        );
    }

    for (const asset of assets) {
        const { source } = asset;

        lines.push(
            `        <asset ${attrs({
                id: asset.id,
                name: source.fileName,
                start: framesAt(asset.tcFrames, asset.rate),
                duration: framesAt(asset.durationFrames, asset.rate),
                hasVideo: 1,
                hasAudio: source.hasAudio ? 1 : undefined,
                format: asset.format,
                audioSources: source.hasAudio ? 1 : undefined,
                audioChannels: source.hasAudio ? (source.audioChannels ?? 2) : undefined,
            })}>`
        );
        lines.push(
            `            <media-rep ${attrs({
                kind: "original-media",
                src: windowsFileUrl(source.path),
            })}/>`
        );
        lines.push("        </asset>");
    }

    lines.push("    </resources>");
    lines.push("    <library>");
    lines.push(`        <event ${attrs({ name: timeline.name })}>`);
    lines.push(`            <project ${attrs({ name: timeline.name })}>`);
    lines.push(
        `                <sequence ${attrs({
            format: "r1",
            duration: framesAt(timeline.durationFrames, seqRate),
            tcStart: "0s",
            tcFormat: "NDF",
            audioLayout: "stereo",
            audioRate: "48k",
        })}>`
    );

    if (timeline.description) {
        lines.push(`                    <note>${escapeXml(timeline.description)}</note>`);
    }

    lines.push("                    <spine>");

    for (const clip of timeline.clips) {
        const asset = assetFor.get(clip.mediaId);

        if (!asset) continue;

        const srcRate = asset.rate;
        const speed = speedRatio(clip.speed);
        const retimed = speed.num !== speed.den;
        // In clip time: timecode start plus the in-point, divided by the speed when retimed.
        const start = retimed
            ? seconds(
                  asset.tcFrames * srcRate.den * speed.num +
                      clip.sourceInFrames * srcRate.den * speed.den,
                  srcRate.num * speed.num
              )
            : framesAt(asset.tcFrames + clip.sourceInFrames, srcRate);
        const duration = framesAt(clip.durationFrames, seqRate);
        const inner = "                            ";

        lines.push(
            `                        <asset-clip ${attrs({
                ref: asset.id,
                offset: framesAt(clip.offsetFrames, seqRate),
                name: clip.name,
                start,
                duration,
                tcFormat: "NDF",
            })}>`
        );

        if (retimed) {
            lines.push(`${inner}<timeMap>`);
            lines.push(
                `${inner}    <timept ${attrs({ time: "0s", value: "0s", interp: "linear" })}/>`
            );
            lines.push(
                `${inner}    <timept ${attrs({
                    time: seconds(
                        asset.durationFrames * srcRate.den * speed.den,
                        srcRate.num * speed.num
                    ),
                    value: framesAt(asset.durationFrames, srcRate),
                    interp: "linear",
                })}/>`
            );
            lines.push(`${inner}</timeMap>`);
        }

        if (clip.label) {
            lines.push(
                `${inner}<marker ${attrs({
                    start,
                    duration: framesAt(1, seqRate),
                    value: clip.label,
                })}/>`
            );
        }

        if (clip.keywords.length > 0) {
            lines.push(
                `${inner}<keyword ${attrs({ start, duration, value: keywordValue(clip.keywords) })}/>`
            );
        }

        lines.push("                        </asset-clip>");
    }

    lines.push("                    </spine>");
    lines.push("                </sequence>");
    lines.push("            </project>");
    lines.push("        </event>");
    lines.push("    </library>");
    lines.push("</fcpxml>");

    return `${lines.join("\n")}\n`;
};

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
