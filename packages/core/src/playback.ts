/**
 * Deciding whether a browser can play a file as it stands (§8).
 *
 * **Direct play first**: H.264/AAC in MP4 is served as bytes with range support, at zero CPU
 * cost. That is the only path that performs acceptably on a NAS with several viewers, so the
 * job of this module is to be *accurate* about when it applies — an optimistic guess costs a
 * viewer a black rectangle with no explanation, and a pessimistic one burns NAS CPU
 * transcoding a file that would have played.
 *
 * Pure, and deliberately in core rather than in a service: the same verdict is needed by the
 * worker (to decide what to enqueue) and by the web app (to decide what to serve), and two
 * implementations of it would drift.
 */

/**
 * Containers a browser can demux.
 *
 * MKV is absent on purpose. It is the most common container in a downloaded library and no
 * browser supports it, whatever is inside — which is why remuxing rather than re-encoding is
 * usually enough to make such a file playable.
 */
const PLAYABLE_CONTAINERS = new Set(["mp4", "mov", "m4v", "webm", "isom", "mp42", "qt"]);

/**
 * ffprobe cannot tell MKV and WebM apart, and neither can this without help.
 *
 * They share one demuxer, so `format_name` is the literal string "matroska,webm" for both.
 * Matching that list against the playable set finds "webm" and declares every MKV in the
 * library directly playable — which is wrong for almost all of them, and fails silently: the
 * file is served, the browser refuses it, and nothing ever queues a rendition.
 *
 * The file extension is the only signal that separates the two, so it decides this case.
 */
const MATROSKA_FAMILY = "matroska";

/** Video codecs with broad browser support. */
const PLAYABLE_VIDEO_CODECS = new Set(["h264", "vp8", "vp9", "av1"]);

/**
 * H.264 profiles a browser will decode.
 *
 * Baseline, Main and High (8-bit 4:2:0) are universal. **High 10, High 4:2:2 and High 4:4:4
 * are not decodable by any mainstream browser**, and they are not rare: 10-bit H.264 is
 * standard in anime encodes and in some camera output. A file like that reports
 * `codec = h264` and plays in VLC, which is exactly why checking the codec alone produces a
 * library that mysteriously half-works.
 */
const PLAYABLE_H264_PROFILES = new Set([
    "baseline",
    "constrained baseline",
    "main",
    "high",
    "progressive high",
    "constrained high",
]);

/** Pixel formats a browser can render. Anything deeper than 8-bit needs a transcode. */
const PLAYABLE_PIX_FMTS = new Set([
    "yuv420p",
    "yuvj420p",
    "nv12",
    "yuv420p10le", // VP9/AV1 10-bit is fine; the H.264 profile check catches 10-bit H.264.
]);

/** Audio codecs with broad support. */
const PLAYABLE_AUDIO_CODECS = new Set(["aac", "mp3", "opus", "vorbis", "flac", "alac"]);

/**
 * The lists the verdict is made from, for the one place that has to ask it in SQL: the
 * library's `playback` filter (`mediaRepo`). Built from these rather than copied, and a test
 * holds the two answers to each other.
 */
export const PLAYBACK_RULES = {
    containers: PLAYABLE_CONTAINERS,
    matroskaFamily: MATROSKA_FAMILY,
    videoCodecs: PLAYABLE_VIDEO_CODECS,
    h264Profiles: PLAYABLE_H264_PROFILES,
    pixFmts: PLAYABLE_PIX_FMTS,
    audioCodecs: PLAYABLE_AUDIO_CODECS,
} as const;

export interface PlaybackInput {
    kind: "image" | "video";
    container: string | null;
    codec: string | null;
    videoProfile: string | null;
    pixFmt: string | null;
    audioCodec: string | null;
    /** Null when the file has not been probed yet. */
    probedAt: string | null;
    /**
     * The file's path or name, used only to tell MKV from WebM.
     *
     * Omitted means "assume MKV" for a matroska-family file, which is the safe default: the
     * cost of being wrong is one unnecessary remux, whereas the other way round is a file
     * that never plays and never gets queued for anything.
     */
    relPath?: string | null;
}

export type PlaybackBlocker =
    "container" | "videoCodec" | "videoProfile" | "pixelFormat" | "audioCodec";

export interface PlaybackAssessment {
    /** Whether the original can be streamed to a browser as-is. */
    directPlay: boolean;
    /** Why not, most significant first. Empty when `directPlay` is true. */
    blockers: PlaybackBlocker[];
    /**
     * Whether only the container is wrong.
     *
     * A remux copies both streams into MP4 without re-encoding — seconds of I/O rather than
     * minutes of CPU. On a NAS that distinction is the difference between a file being
     * watchable now and being watchable this evening, so it is worth knowing before the job
     * is queued rather than discovered inside it.
     */
    remuxOnly: boolean;
    /** Null until probed: unknown is not the same as unplayable. */
    probed: boolean;
}

const normalise = (value: string | null): string | null => value?.trim().toLowerCase() || null;

/**
 * Containers arrive from ffprobe as a comma list — "mov,mp4,m4a,3gp,3g2,mj2".
 *
 * Any one match is enough: ffprobe is naming the demuxer family it recognised, not claiming
 * the file is all of them.
 */
const containerPlayable = (container: string | null, relPath: string | null): boolean => {
    const value = normalise(container);

    if (!value) {
        return false;
    }

    const names = value.split(",").map((name) => name.trim());

    // The matroska demuxer claims both names. Only a genuine .webm file is playable.
    if (names.includes(MATROSKA_FAMILY)) {
        return normalise(relPath)?.endsWith(".webm") ?? false;
    }

    return names.some((name) => PLAYABLE_CONTAINERS.has(name));
};

const videoCodecPlayable = (codec: string | null): boolean => {
    const value = normalise(codec);

    return value !== null && PLAYABLE_VIDEO_CODECS.has(value);
};

/**
 * Whether the H.264 profile is one a browser decodes.
 *
 * Only applies to H.264; other codecs do not carry a profile that changes browser support in
 * the same way. An unknown profile is treated as playable — ffprobe not reporting one is
 * common for remuxed files, and refusing to play those would transcode a large part of a
 * typical library for no reason.
 */
const profilePlayable = (codec: string | null, profile: string | null): boolean => {
    if (normalise(codec) !== "h264") {
        return true;
    }

    const value = normalise(profile);

    return value === null || PLAYABLE_H264_PROFILES.has(value);
};

const pixFmtPlayable = (pixFmt: string | null): boolean => {
    const value = normalise(pixFmt);

    // Unknown is assumed fine, for the same reason as the profile: absence of evidence.
    return value === null || PLAYABLE_PIX_FMTS.has(value);
};

/**
 * Silent video is playable; a file with no audio track is not a problem to solve.
 */
const audioCodecPlayable = (audioCodec: string | null): boolean => {
    const value = normalise(audioCodec);

    return value === null || PLAYABLE_AUDIO_CODECS.has(value);
};

export const assessPlayback = (input: PlaybackInput): PlaybackAssessment => {
    if (input.kind === "image") {
        return { directPlay: true, blockers: [], remuxOnly: false, probed: true };
    }

    if (!input.probedAt) {
        // Not yet probed. Optimistic on purpose: the player finds out in a second, whereas
        // queuing a transcode for every file the moment it is scanned would saturate the NAS
        // before anything had been looked at.
        return { directPlay: true, blockers: [], remuxOnly: false, probed: false };
    }

    const blockers: PlaybackBlocker[] = [];

    if (!containerPlayable(input.container, input.relPath ?? null)) blockers.push("container");
    if (!videoCodecPlayable(input.codec)) blockers.push("videoCodec");
    if (!profilePlayable(input.codec, input.videoProfile)) blockers.push("videoProfile");
    if (!pixFmtPlayable(input.pixFmt)) blockers.push("pixelFormat");
    if (!audioCodecPlayable(input.audioCodec)) blockers.push("audioCodec");

    return {
        directPlay: blockers.length === 0,
        blockers,
        // The common and happy case: an MKV holding perfectly good H.264 and AAC.
        remuxOnly: blockers.length === 1 && blockers[0] === "container",
        probed: true,
    };
};

/** Human-readable reason, for the detail page and the admin job view. */
export const describeBlocker = (blocker: PlaybackBlocker): string => {
    switch (blocker) {
        case "container":
            return "the container is not one browsers can open";
        case "videoCodec":
            return "the video codec is not supported by browsers";
        case "videoProfile":
            return "the H.264 profile is 10-bit or 4:2:2, which browsers cannot decode";
        case "pixelFormat":
            return "the pixel format is not one browsers can render";
        case "audioCodec":
            return "the audio codec is not supported by browsers";
    }
};
