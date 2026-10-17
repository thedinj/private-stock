/**
 * Scrubber sprite sheets and their WebVTT index (§9).
 *
 * Pure arithmetic and string building, kept out of the worker so it can be tested without
 * ffmpeg. The numbers here decide both how useful scrubbing feels and how much disk a
 * 200k-item library costs, and getting either wrong is invisible until it is expensive.
 */

/**
 * Tiles per sheet, as a 10x10 grid — ffmpeg's `tile` filter lays them out row-major.
 *
 * Exactly `TARGET_TILE_COUNT`, so the common case is one sheet: one file, one request, one
 * decode, and the multi-sheet path only opens for videos long enough to hit `MAX_INTERVAL_MS`.
 * The two constants are meant to stay equal — a target above this silently doubles the number
 * of files for a handful of extra thumbnails nobody asked for.
 */
export const SPRITE_COLUMNS = 10;
export const SPRITE_ROWS = 10;
export const TILES_PER_SHEET = SPRITE_COLUMNS * SPRITE_ROWS;

/** Width of one thumbnail. Enough to read a face at scrubber size, small enough to be cheap. */
export const SPRITE_TILE_WIDTH = 200;

/**
 * Roughly how many thumbnails a video should get, whatever its length.
 *
 * A fixed interval cannot work for both a 30-second clip and a three-hour film: ten seconds
 * gives the clip three thumbnails and the film a thousand. Targeting a tile *count* instead
 * means scrubbing feels the same at either length, and the disk cost per video is bounded —
 * which is the number that matters when the library has 200k of them.
 *
 * 100 is calibrated against the pointer, not against the video. A measured sheet runs ~2.3 KB
 * per tile, so this is ~210 KB for a 12-minute video, against ~700 KB at the 300 this started
 * at. The extra tiles were unreachable: on a 900px scrubber 100 of them change the thumbnail
 * every 10px, which is already a thumb's precision, and 300 changed it every 3px.
 *
 * It is also where the savings stop being worth the coarseness. Dropping 150 to 100 saves
 * ~24 GB across a 200k library; 100 to 75 saves only ~9 GB, and buys 12px steps — far enough
 * apart that the preview visibly holds still while the pointer moves, which reads as lag
 * rather than as economy.
 */
export const TARGET_TILE_COUNT = 100;

/**
 * Never sample more often than this.
 *
 * Below a couple of seconds the sheets grow quickly and the thumbnails stop differing from
 * each other, so the extra tiles cost disk and buy nothing.
 */
export const MIN_INTERVAL_MS = 2_000;

/** Nor less often: past this the scrubber stops tracking what you are pointing at. */
export const MAX_INTERVAL_MS = 30_000;

export interface SpriteLayout {
    /** Seconds between sampled frames, in milliseconds. */
    intervalMs: number;
    /** Total thumbnails across all sheets. */
    tileCount: number;
    /** How many sheet files this produces. */
    sheetCount: number;
    columns: number;
    rows: number;
}

/**
 * Decide the sampling interval and sheet count for a video of this length.
 *
 * Returns a single-tile layout for a video of unknown or zero duration rather than throwing:
 * an unprobed file still gets *something*, and the scrubber degrades to one thumbnail rather
 * than to a crash.
 */
export const spriteLayout = (durationMs: number | null): SpriteLayout => {
    const duration = durationMs && durationMs > 0 ? durationMs : 0;

    if (duration === 0) {
        return {
            intervalMs: MIN_INTERVAL_MS,
            tileCount: 1,
            sheetCount: 1,
            columns: SPRITE_COLUMNS,
            rows: SPRITE_ROWS,
        };
    }

    const intervalMs = Math.min(
        MAX_INTERVAL_MS,
        Math.max(MIN_INTERVAL_MS, Math.ceil(duration / TARGET_TILE_COUNT / 1000) * 1000)
    );

    // `fps=1/N` emits a frame at 0, N, 2N… so a 10s video at 2s intervals yields 5 frames,
    // not 6: the sample at exactly 10s is past the last frame.
    const tileCount = Math.max(1, Math.ceil(duration / intervalMs));

    return {
        intervalMs,
        tileCount,
        sheetCount: Math.max(1, Math.ceil(tileCount / TILES_PER_SHEET)),
        columns: SPRITE_COLUMNS,
        rows: SPRITE_ROWS,
    };
};

/**
 * `01:23:45.678` — the only timestamp format WebVTT accepts.
 *
 * Hours are always written. They are optional in the spec, but a cue that omits them for the
 * first hour and includes them afterwards is a needless branch in every parser that reads it,
 * including ours.
 */
export const formatVttTimestamp = (ms: number): string => {
    const clamped = Math.max(0, Math.round(ms));

    const hours = Math.floor(clamped / 3_600_000);
    const minutes = Math.floor((clamped % 3_600_000) / 60_000);
    const seconds = Math.floor((clamped % 60_000) / 1000);
    const milliseconds = clamped % 1000;

    const pad = (value: number, width = 2): string => String(value).padStart(width, "0");

    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(milliseconds, 3)}`;
};

/** Where one thumbnail sits: which sheet, and its top-left corner in pixels. */
export interface SpriteTile {
    sheet: number;
    x: number;
    y: number;
}

/**
 * The tile at a given position in the sequence.
 *
 * Shared by the VTT and by anything that draws a tile itself, such as the OCR review page
 * showing the frame a string was read in. Two copies of this arithmetic would be two
 * opinions about which picture belongs to which moment.
 */
export const spriteTile = (
    index: number,
    columns: number,
    tileWidth: number,
    tileHeight: number
): SpriteTile => {
    const withinSheet = index % TILES_PER_SHEET;

    return {
        sheet: Math.floor(index / TILES_PER_SHEET),
        x: (withinSheet % columns) * tileWidth,
        y: Math.floor(withinSheet / columns) * tileHeight,
    };
};

/**
 * The tile covering a moment: the one whose interval contains `atMs`, clamped to the
 * sequence so a moment past the last sample still lands on the last tile.
 */
export const spriteTileAt = (
    atMs: number,
    layout: Pick<SpriteLayout, "intervalMs" | "tileCount" | "columns">,
    tileWidth: number,
    tileHeight: number
): SpriteTile => {
    const index = Math.min(layout.tileCount - 1, Math.max(0, Math.floor(atMs / layout.intervalMs)));

    return spriteTile(index, layout.columns, tileWidth, tileHeight);
};

export interface SpriteVttInput {
    layout: SpriteLayout;
    durationMs: number;
    /** Measured from the generated sheet, not assumed — the source aspect ratio decides it. */
    tileWidth: number;
    tileHeight: number;
    /** Given the sheet's ordinal, the URL the browser should fetch it from. */
    sheetUrl: (ordinal: number) => string;
}

/**
 * Build the WebVTT thumbnail track.
 *
 * Each cue points at a rectangle inside a sheet using the `#xywh=` media fragment, which is
 * the convention every player that supports thumbnail tracks understands — and which our own
 * scrubber uses to position a CSS background.
 */
export const buildSpriteVtt = ({
    layout,
    durationMs,
    tileWidth,
    tileHeight,
    sheetUrl,
}: SpriteVttInput): string => {
    const lines = ["WEBVTT", ""];

    for (let index = 0; index < layout.tileCount; index += 1) {
        const start = index * layout.intervalMs;

        // The final cue runs to the end of the video rather than one interval past it, so
        // pointing at the very end of the scrubber still lands on a cue.
        const end = Math.min(durationMs, start + layout.intervalMs);

        if (end <= start) {
            break;
        }

        const { sheet, x, y } = spriteTile(index, layout.columns, tileWidth, tileHeight);

        lines.push(
            String(index + 1),
            `${formatVttTimestamp(start)} --> ${formatVttTimestamp(end)}`,
            `${sheetUrl(sheet)}#xywh=${x},${y},${tileWidth},${tileHeight}`,
            ""
        );
    }

    return lines.join("\n");
};

export interface SpriteCue {
    startMs: number;
    endMs: number;
    url: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * Parse a thumbnail track back into cues.
 *
 * The browser's own `<track>` parsing is not usable here: the scrubber needs the rectangle
 * to position a background image, and a `TextTrackCue` only exposes the cue text as a string
 * that would have to be parsed anyway. Reading the file directly is both simpler and
 * testable.
 *
 * Deliberately lenient about everything except the fields it needs — a cue it cannot
 * understand is skipped rather than failing the whole track, because a scrubber with most of
 * its thumbnails beats a scrubber with none.
 */
export const parseSpriteVtt = (text: string): SpriteCue[] => {
    const cues: SpriteCue[] = [];
    const blocks = text.replace(/\r\n/g, "\n").split("\n\n");

    for (const block of blocks) {
        const lines = block.split("\n").filter((line) => line.trim().length > 0);
        const timingLine = lines.find((line) => line.includes("-->"));

        if (!timingLine) {
            continue;
        }

        const payload = lines[lines.indexOf(timingLine) + 1];

        if (!payload) {
            continue;
        }

        const [start, end] = timingLine.split("-->").map((part) => parseVttTimestamp(part.trim()));
        const fragment = /#xywh=(\d+),(\d+),(\d+),(\d+)\s*$/.exec(payload);

        if (start === null || end === null || !fragment) {
            continue;
        }

        cues.push({
            startMs: start,
            endMs: end,
            url: payload.slice(0, payload.lastIndexOf("#")),
            x: Number(fragment[1]),
            y: Number(fragment[2]),
            width: Number(fragment[3]),
            height: Number(fragment[4]),
        });
    }

    return cues;
};

/** `00:01:02.500` or `01:02.500` — WebVTT allows the hours field to be omitted. */
export const parseVttTimestamp = (value: string): number | null => {
    const match = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})\.(\d{1,3})$/.exec(value.trim());

    if (!match) {
        return null;
    }

    const [, hours, minutes, seconds, milliseconds] = match;

    return (
        Number(hours ?? 0) * 3_600_000 +
        Number(minutes) * 60_000 +
        Number(seconds) * 1000 +
        Number(milliseconds.padEnd(3, "0"))
    );
};

/** The cue covering a moment, or null. Callers use it to position the scrubber preview. */
export const cueAt = (cues: SpriteCue[], atMs: number): SpriteCue | null => {
    if (cues.length === 0) {
        return null;
    }

    // Binary search: the scrubber calls this on every pointer move, and a long film has
    // hundreds of cues.
    let low = 0;
    let high = cues.length - 1;

    while (low <= high) {
        const middle = (low + high) >> 1;
        const cue = cues[middle];

        if (atMs < cue.startMs) {
            high = middle - 1;
        } else if (atMs >= cue.endMs) {
            low = middle + 1;
        } else {
            return cue;
        }
    }

    // Past the last cue — which happens whenever the pointer reaches the very end — the last
    // thumbnail is the right answer rather than nothing.
    return atMs >= cues[cues.length - 1].endMs ? cues[cues.length - 1] : cues[0];
};

/** One packet of a video's stream: when its frame is shown, and whether it is a keyframe. */
export interface VideoPacket {
    /** From the start of the file, as `-ss` counts: the container's start time taken off. */
    ptsMs: number;
    key: boolean;
}

/**
 * How far either side of a tile's nominal moment its picture can be: what to list the packets
 * of, before asking which of them the tile shows.
 *
 * Back one interval, for the keyframe at or before the moment that the seeking path reads; on
 * past the half interval that the `fps` paths reach, for the frame just short of it.
 */
export const tileReadWindow = (
    atMs: number,
    intervalMs: number
): { fromMs: number; toMs: number } => ({
    fromMs: Math.max(0, atMs - intervalMs),
    toMs: atMs + intervalMs / 2 + 500,
});

/**
 * The frames a tile at `atMs` may be (§9 "What a tile shows"), earliest first and each once.
 *
 * A tile's moment is `index × interval`, and its picture is seldom that frame. Measured against
 * ffmpeg 6.1 with a frame-numbered fixture: `fps=1/N` rounds each frame's time to the nearest
 * slot and keeps the *last* frame of each, so a tile shows what was on screen just short of
 * `atMs + N/2` -- half an interval late, up to fifteen seconds on a long video.
 *
 * - **full decode**: the last frame before `atMs + N/2`
 * - **keyframes only**: the last keyframe before it
 * - **seeking** (`SEEK_CODECS`): the keyframe at or before `atMs`
 * - and the frame at `atMs` itself, which the tile would be if it were what its time says
 *
 * Which path made a sprite is not recorded, so all four are offered, and what the tile looks
 * like decides between them.
 */
export const tileCandidates = (
    atMs: number,
    intervalMs: number,
    packets: readonly VideoPacket[]
): VideoPacket[] => {
    const late = atMs + intervalMs / 2;
    const pick = (
        matching: (packet: VideoPacket) => boolean,
        better: (packet: VideoPacket, than: VideoPacket) => boolean
    ): VideoPacket | undefined =>
        packets
            .filter(matching)
            .reduce<VideoPacket | undefined>(
                (best, packet) => (!best || better(packet, best) ? packet : best),
                undefined
            );
    const later = (packet: VideoPacket, than: VideoPacket): boolean => packet.ptsMs > than.ptsMs;
    const earlier = (packet: VideoPacket, than: VideoPacket): boolean => packet.ptsMs < than.ptsMs;

    // Half a millisecond's slack: the times come from decimal strings, and a frame exactly at
    // a moment must count as at it. A frame exactly at `late` rounds into the next slot.
    const found = [
        pick((packet) => packet.ptsMs < late - 0.5, later),
        pick((packet) => packet.key && packet.ptsMs < late - 0.5, later),
        pick((packet) => packet.key && packet.ptsMs <= atMs + 0.5, later),
        pick((packet) => packet.ptsMs >= atMs - 0.5, earlier),
    ].filter((packet): packet is VideoPacket => packet !== undefined);
    const distinct = new Map(found.map((packet) => [Math.round(packet.ptsMs * 1000), packet]));

    return [...distinct.values()].sort((left, right) => left.ptsMs - right.ptsMs);
};

/** How unlike two greyscale pictures of one size are: the mean difference of their pixels. */
export const pictureDistance = (left: Uint8Array, right: Uint8Array): number => {
    if (left.length !== right.length || left.length === 0) {
        return Number.POSITIVE_INFINITY;
    }

    let sum = 0;

    for (let index = 0; index < left.length; index += 1) {
        sum += Math.abs(left[index] - right[index]);
    }

    return sum / left.length;
};
