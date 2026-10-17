import { z } from "zod";

/**
 * Playing an MPEG-TS file without copying it (§8).
 *
 * No browser opens a `.ts` or `.mpg` file directly, and nothing can seek in one without knowing
 * where its keyframes are -- the container carries no index. HLS solves exactly this, and a
 * playlist may name **byte ranges of one file** as its segments, which is what ffmpeg itself
 * writes with `-hls_flags single_file`. So the `segments` stage reads each file once and records
 * its keyframes, and the stream route answers with a playlist whose segments are ranges of the
 * untouched original. The browser repackages each one as it plays; the NAS serves bytes.
 *
 * Proved before it was built, on a generated clip in Chrome: picture and sound, and seeking to
 * an unbuffered point and back, both through Chrome's own HLS and through hls.js.
 */

/**
 * The index the stage writes. Small: one pair per keyframe, so a two-hour film with a keyframe
 * every two seconds is a few thousand pairs.
 */
export const segmentIndexSchema = z.object({
    version: z.literal(1),
    /**
     * The file this describes, by the scanner's identity for it. A file replaced in place keeps
     * its item, and an index of the old one would send the player to the wrong bytes.
     */
    sizeBytes: z.number().int().positive(),
    mtimeMs: z.number(),
    durationMs: z.number().positive(),
    /** Each keyframe as `[presentation time in ms, byte offset]`, both increasing. */
    keyframes: z.array(z.tuple([z.number(), z.number().int().nonnegative()])).min(1),
});
export type SegmentIndex = z.infer<typeof segmentIndexSchema>;

/**
 * Keyframes from ffprobe's packet listing of the video stream:
 * `-select_streams v:0 -show_entries packet=pts_time,pos,flags -of csv=p=0`.
 *
 * Lines arrive as `1.466667,564,K_`. Blank lines, packets without a time or a position, and
 * anything that would step backwards are dropped: a segment is "from this keyframe to the next",
 * so the pairs must only ever increase.
 */
export const parseKeyframes = (csv: string): [number, number][] => {
    const keyframes: [number, number][] = [];

    for (const line of csv.split("\n")) {
        const [time, position, flags] = line.split(",").map((field) => field.trim());

        if (!flags?.includes("K")) {
            continue;
        }

        const ms = Number(time) * 1000;
        const pos = Number(position);

        if (!Number.isFinite(ms) || !Number.isInteger(pos) || pos < 0) {
            continue;
        }

        const last = keyframes.at(-1);

        if (last && (ms <= last[0] || pos <= last[1])) {
            continue;
        }

        keyframes.push([ms, pos]);
    }

    return keyframes;
};

/**
 * How long a segment runs before the next keyframe may start another.
 *
 * Seeking lands on a segment boundary and plays forward, so shorter is a more exact seek and
 * more requests. A few seconds is what HLS players are built around.
 */
const MIN_SEGMENT_MS = 4_000;

/**
 * The playlist for one file: its keyframes grouped into segments of a few seconds, each a byte
 * range of `uri`.
 *
 * The first segment starts at byte 0 rather than at the first keyframe, so it carries the
 * stream's tables (PAT and PMT) and whatever audio precedes the first picture; the last runs to
 * the end of the file. Between them the ranges are contiguous, so every byte is in exactly one.
 */
export const buildSegmentPlaylist = (index: SegmentIndex, uri: string): string => {
    const [first] = index.keyframes;
    const cuts: [number, number][] = [[first[0], 0]];

    for (const keyframe of index.keyframes.slice(1)) {
        if (keyframe[0] - cuts[cuts.length - 1][0] >= MIN_SEGMENT_MS) {
            cuts.push(keyframe);
        }
    }

    const endMs = first[0] + index.durationMs;
    const segments = cuts.map(([ms, offset], i) => {
        const next = cuts[i + 1];

        return {
            // At least a tenth of a second: the probe's duration and the keyframes' times come
            // from different clocks, and a last segment of zero or less is not a segment.
            seconds: Math.max((next ? next[0] : endMs) - ms, 100) / 1000,
            offset,
            length: (next ? next[1] : index.sizeBytes) - offset,
        };
    });

    return [
        "#EXTM3U",
        // Byte ranges arrived in version 4.
        "#EXT-X-VERSION:4",
        "#EXT-X-PLAYLIST-TYPE:VOD",
        "#EXT-X-MEDIA-SEQUENCE:0",
        // Every segment's duration, rounded, must not exceed this.
        `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...segments.map((s) => s.seconds)))}`,
        ...segments.flatMap((segment) => [
            `#EXTINF:${segment.seconds.toFixed(3)},`,
            `#EXT-X-BYTERANGE:${segment.length}@${segment.offset}`,
            uri,
        ]),
        "#EXT-X-ENDLIST",
        "",
    ].join("\n");
};
