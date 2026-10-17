/**
 * Trying one file in this browser, for the playback check (§8).
 *
 * The question is the one a viewer would answer by watching: does a picture appear, is there
 * sound, and does it keep going. Each has a sign the element exposes without anybody looking --
 * decoded frames, decoded audio bytes, the clock moving -- so a page can try a dozen files on a
 * phone and report, where by hand it would be a dozen visits and a list kept on paper.
 *
 * Muted, so it may start without a tap. Chrome still decodes the sound of a muted element (its
 * audio is the clock the picture is timed against), so the audio count is still a real answer.
 */

export type TrialResult =
    | { outcome: "played"; picture: boolean; sound: boolean | null }
    | { outcome: "noPicture" }
    | { outcome: "refused"; detail: string }
    | { outcome: "stalled" };

/** How much of the file has to play before it counts as playing rather than starting. */
const PLAYED_SECONDS = 1.5;

/** Generous: an MKV's index can sit at the end of a large file, on NAS disks (§8b). */
const TIMEOUT_MS = 20_000;

/** Null where the browser does not count (Firefox, Safari): "cannot tell", not "no". */
const decodedAudio = (video: HTMLVideoElement): boolean | null => {
    const count: unknown = Reflect.get(video, "webkitAudioDecodedByteCount");

    return typeof count === "number" ? count > 0 : null;
};

const decodedPicture = (video: HTMLVideoElement): boolean =>
    typeof video.getVideoPlaybackQuality === "function"
        ? video.getVideoPlaybackQuality().totalVideoFrames > 0
        : video.videoWidth > 0;

export const tryPlayback = (
    video: HTMLVideoElement,
    src: string,
    hasAudio: boolean
): Promise<TrialResult> =>
    new Promise((resolve) => {
        let settled = false;
        let startedAt: number | null = null;

        const finish = (result: TrialResult) => {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(timer);
            video.removeEventListener("error", onError);
            video.removeEventListener("loadedmetadata", onMetadata);
            video.removeEventListener("timeupdate", onTime);
            video.pause();
            // Releases the decoder before the next file asks for one: phones have few (§14).
            video.removeAttribute("src");
            video.load();
            resolve(result);
        };

        const onError = () =>
            finish({
                outcome: "refused",
                detail: video.error?.message || `error ${video.error?.code ?? "unknown"}`,
            });

        // No error, and no picture: the browser kept the sound and dropped a video track it
        // could not decode (§8).
        const onMetadata = () => {
            if (video.videoWidth === 0) {
                finish({ outcome: "noPicture" });

                return;
            }

            video.play().catch((error: unknown) =>
                finish({
                    outcome: "refused",
                    detail: error instanceof Error ? error.message : String(error),
                })
            );
        };

        const onTime = () => {
            startedAt ??= video.currentTime;

            if (video.currentTime - startedAt >= PLAYED_SECONDS) {
                finish({
                    outcome: "played",
                    picture: decodedPicture(video),
                    sound: hasAudio ? decodedAudio(video) : null,
                });
            }
        };

        const timer = setTimeout(() => finish({ outcome: "stalled" }), TIMEOUT_MS);

        video.addEventListener("error", onError);
        video.addEventListener("loadedmetadata", onMetadata);
        video.addEventListener("timeupdate", onTime);
        video.muted = true;
        video.src = src;
        video.load();
    });

/** "Chrome on Android": what the results belong to, readable at a glance. */
export const describeDevice = (userAgent: string): string => {
    const browser = /Edg\//.test(userAgent)
        ? "Edge"
        : /Firefox\//.test(userAgent)
          ? "Firefox"
          : /Chrome\//.test(userAgent)
            ? "Chrome"
            : /Safari\//.test(userAgent)
              ? "Safari"
              : "a browser";
    const system = /Android/.test(userAgent)
        ? "Android"
        : /iPhone|iPad/.test(userAgent)
          ? "iOS"
          : /Windows/.test(userAgent)
            ? "Windows"
            : /Mac OS X/.test(userAgent)
              ? "macOS"
              : /Linux/.test(userAgent)
                ? "Linux"
                : "an unknown system";

    return `${browser} on ${system}`;
};

/** A result in a few words, for the page and for the copied summary alike. */
export const describeTrial = (result: TrialResult): string => {
    switch (result.outcome) {
        case "played":
            if (!result.picture) return "Ran, but no frames decoded";
            if (result.sound === false) return "Picture, no sound";
            if (result.sound === null) return "Plays (sound not checked)";

            return "Plays";
        case "noPicture":
            return "Sound only, no picture";
        case "refused":
            return "Refused";
        case "stalled":
            return "Stalled";
    }
};

export const trialPlays = (result: TrialResult): boolean =>
    result.outcome === "played" && result.picture && result.sound !== false;
