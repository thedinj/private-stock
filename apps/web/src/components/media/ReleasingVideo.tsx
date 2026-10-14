import React, { useCallback, useEffect, useRef } from "react";

/**
 * A `<video>` that cancels its download when it unmounts (§8b "A removed element keeps its
 * request").
 *
 * React removing a `<video>` from the page does not stop it loading. A detached element keeps
 * its player, and the player keeps its request open (deferred, reading nothing) until the
 * element is garbage collected, which can be minutes away. Over HTTP/2 that is worse than a
 * leak: everything it has not read still counts against the connection's flow-control window,
 * which every request to the app shares. A tasting that leaves a few of these behind stalls
 * that window, and every later stream, cover and API call arrives with headers and no body.
 *
 * Removing `src` and calling `load()` is how the HTML spec lets a page drop a media resource:
 * it aborts the fetch and frees the decoder there and then.
 *
 * **Only an element that has left the document is released.** In development React Strict
 * Mode runs every effect's cleanup once on a node that stays mounted; releasing that one would
 * leave a player with no source. A real unmount has already removed the node by the time a
 * passive cleanup runs.
 */
export const ReleasingVideo: React.FC<React.ComponentPropsWithRef<"video">> = ({
    ref,
    ...props
}) => {
    const elementRef = useRef<HTMLVideoElement | null>(null);

    /**
     * Keeps the element when React detaches the ref, because the cleanup below runs after that
     * detach and still needs it. The caller's ref sees exactly what it would have seen on a
     * plain `<video>`.
     */
    const attach = useCallback(
        (element: HTMLVideoElement | null) => {
            if (element) {
                elementRef.current = element;
            }

            if (typeof ref === "function") {
                ref(element);
            } else if (ref) {
                ref.current = element;
            }
        },
        [ref]
    );

    useEffect(
        () => () => {
            const video = elementRef.current;

            if (!video || video.isConnected) {
                return;
            }

            video.removeAttribute("src");
            video.load();
        },
        []
    );

    return <video ref={attach} {...props} />;
};
