/**
 * A position in a video as people write it: `m:ss`, or `h:mm:ss` past the hour.
 *
 * Shared by the frame lightbox and the Captures page, which name the same moment and must
 * write it the same way.
 */
export const formatTimecode = (atMs: number): string => {
    const totalSeconds = Math.round(atMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    return hours > 0
        ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
        : `${minutes}:${String(seconds).padStart(2, "0")}`;
};
