import seal from "@/app/icon.svg";

/**
 * The seal, beside the wordmark.
 *
 * It loads the favicon's own file, `app/icon.svg`, so there is one drawing of it and nothing to
 * keep in step. It is decorative: the wordmark next to it already names the app, so it is
 * hidden from assistive technology rather than given alt text that would be read twice.
 *
 * Imported rather than linked as `/icon.svg`, for the content hash in the URL. Next serves the
 * icon route as immutable for a year, so a bare `/icon.svg` kept showing a phone the drawing it
 * first saw, through every redraw since.
 */
export const SealMark: React.FC<{ size: number }> = ({ size }) => (
    // eslint-disable-next-line @next/next/no-img-element -- a fixed-size SVG; next/image adds nothing
    <img
        src={seal.src}
        alt=""
        aria-hidden
        width={size}
        height={size}
        style={{ display: "block" }}
    />
);
