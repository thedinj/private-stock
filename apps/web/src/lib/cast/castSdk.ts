/**
 * Loading Google's Cast sender SDK, once, and only where it can work (§11).
 *
 * The SDK is a script from gstatic rather than a package: Google ships it that way and does not
 * publish it to npm, which is why `script-src` names `https://www.gstatic.com` (next.config.ts).
 * It only does anything in Chrome -- desktop and Android -- and only in a secure context; Safari
 * and Firefox have no Cast at all. Elsewhere the request is not made, and the answer is no.
 */

const SDK_URL = "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1";

let loading: Promise<boolean> | null = null;

/** Resolves true once `cast.framework` is usable, false where it never will be. */
export const loadCastSdk = (): Promise<boolean> => {
    if (loading) {
        return loading;
    }

    loading = new Promise<boolean>((resolve) => {
        // iOS reports itself as Chrome inside Chrome for iOS, which is WebKit and has no Cast.
        const chromium = "chrome" in window && !/iPhone|iPad|iPod/.test(navigator.userAgent);

        if (!window.isSecureContext || !chromium) {
            resolve(false);

            return;
        }

        window.__onGCastApiAvailable = (available) => resolve(available);

        const script = document.createElement("script");

        script.src = SDK_URL;
        script.async = true;
        script.onerror = () => resolve(false);
        document.head.appendChild(script);
    });

    return loading;
};
