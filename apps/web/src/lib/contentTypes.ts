/**
 * What the stream route says it is sending.
 *
 * Shared with the media-token service because a Cast receiver is told the type up front, in the
 * load request, rather than reading it from the response — the two have to give the same answer.
 */

const CONTENT_TYPES: Record<string, string> = {
    mp4: "video/mp4",
    m4v: "video/mp4",
    mov: "video/quicktime",
    webm: "video/webm",
    mkv: "video/x-matroska",
    ts: "video/mp2t",
    m2ts: "video/mp2t",
    mpg: "video/mpeg",
    mpeg: "video/mpeg",
    avi: "video/x-msvideo",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
};

export const contentTypeFor = (relPath: string): string => {
    const ext = relPath.slice(relPath.lastIndexOf(".") + 1).toLowerCase();

    return CONTENT_TYPES[ext] ?? "application/octet-stream";
};

/** An MPEG-TS file served as HLS byte ranges of itself (§8). */
export const PLAYLIST_TYPE = "application/vnd.apple.mpegurl";
