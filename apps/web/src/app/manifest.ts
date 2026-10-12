import type { MetadataRoute } from "next";

/**
 * The web app manifest: what makes the app installable (§14, "Installing").
 *
 * A manifest and no service worker, on purpose. The app is no use offline — the library is on
 * the NAS — so a worker would buy nothing, and the usual app-shell cache would hold installed
 * copies on an old build until every window closed, and keep thumbnails and API answers in
 * device storage past sign-out. Chrome no longer asks for one before offering to install.
 *
 * Installing needs a secure origin: the Caddy front door, with its root trusted on the device,
 * or a real certificate. Over plain `http://nas:8842` a phone can only bookmark the page.
 *
 * Generated at build time; nothing here varies per request.
 */
const GROUND = "#0f0d0b"; // the `themeColor` in layout.tsx

const manifest = (): MetadataRoute.Manifest => ({
    name: "private-stock",
    short_name: "private-stock",
    id: "/",
    start_url: "/",
    scope: "/",
    // Not `fullscreen`: the player has its own, and the rest of the app wants the status bar.
    display: "standalone",
    background_color: GROUND,
    theme_color: GROUND,
    icons: [
        { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
        {
            src: "/icons/icon-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
        },
        { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
});

export default manifest;
