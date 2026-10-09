/**
 * Failures that describe the source file rather than the attempt (§7).
 *
 * The queue retries a failed job with backoff, which is right for a busy box or a share that
 * blinked and wrong for a file whose bytes cannot be decoded: those fail identically every
 * time, and each retry is another ffmpeg launch spent learning nothing. A truncated download —
 * an MP4 whose index was never written — was retried three times per stage, across every stage
 * the sweep offers it to.
 *
 * Deliberately a short list of messages ffmpeg prints about the *container*, not a pattern
 * over anything that looks like an error. A missed case costs the retries it always cost; a
 * false match settles work that could have succeeded, and nothing retries it until the file
 * changes. `Input/output error` is absent on purpose: that is what a share dropping mid-read
 * looks like, and it is exactly the transient case the retries exist for.
 */
const UNREADABLE_SOURCE_MARKERS = [
    // An MP4 or MOV with no index — nearly always a download that never finished.
    "moov atom not found",
    // FFmpeg's AVERROR_INVALIDDATA, reported while opening the input.
    "Invalid data found when processing input",
    // A Matroska or WebM file without a valid header.
    "EBML header parsing failed",
];

/**
 * One packet that would not decode, in a file that otherwise opened.
 *
 * ffmpeg reports it as `Error while decoding stream #0:0: Invalid data found when processing
 * input` -- the same AVERROR_INVALIDDATA text as a file that cannot be opened at all, so a
 * plain substring match settled damaged-but-decodable files as unreadable on their first
 * failure. In production that was two sprite jobs whose covers and previews had rendered.
 * Read line by line, so a decode error elsewhere in the output cannot hide a real open failure.
 */
const DECODE_ERROR = /error while decoding/i;

/**
 * Whether this error says the source file itself cannot be read.
 *
 * Reads the message, which for `execFile` carries the child's stderr after the command line.
 *
 * Never for a process that was killed. A timeout's message carries the same stderr, so a long
 * file with a damaged stretch would match a marker and be settled as unreadable when what
 * actually happened was that it ran out of time -- and time is what a retry might have.
 */
export const isUnreadableSource = (error: unknown): boolean => {
    if (error instanceof Error && "killed" in error && error.killed === true) {
        return false;
    }

    return describesUnreadableSource(error instanceof Error ? error.message : String(error));
};

/**
 * Whether stored error text names one of the markers, for a failure recorded earlier.
 *
 * What the unreadable-files list reads to tell a corrupt file from one whose probe ran out of
 * attempts some other way. The `killed` exemption cannot apply here -- a stage row keeps the
 * text, not the error -- but a timeout's text now says so first, and carries no marker unless
 * ffmpeg printed one.
 */
export const describesUnreadableSource = (text: string): boolean =>
    text
        .split(/\r?\n/)
        .some(
            (line) =>
                !DECODE_ERROR.test(line) &&
                UNREADABLE_SOURCE_MARKERS.some((marker) => line.includes(marker))
        );

/** Lines that say a command ran rather than what went wrong. */
const PREAMBLE = /^(Command failed:|\S+ exited with code |\S+ was killed )/;

/**
 * The line that says why, out of a recorded failure.
 *
 * Stored error text is usually the command line or "ffmpeg exited with code 1" and then the
 * complaint -- so the first line, which is what a one-line row would show, is the least useful
 * one, and a list of failures grouped by it reads as one row per file. The marker line is
 * preferred because it names what is wrong with the file ("moov atom not found", not the
 * "Invalid data found" summary after it); otherwise the last line, which is ffmpeg's
 * conclusion. The preamble itself only when it is all there is -- "ffmpeg was killed (SIGTERM)"
 * with nothing after it is still the reason.
 */
export const failureReason = (text: string | null): string | null => {
    const all = (text ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    const lines = all.filter((line) => !PREAMBLE.test(line));

    return lines.find((line) => describesUnreadableSource(line)) ?? lines.at(-1) ?? all[0] ?? null;
};
