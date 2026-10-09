// Mantine's stylesheet in its own cascade layer, so every unlayered rule of ours beats it
// whatever order the two arrive in. Next does not keep that order: the production build put
// globals.scss before Mantine and dev puts it after, so the same tie went opposite ways in the
// two -- stars sat 13px high on a phone, the ground was Mantine's grey-brown rather than ours,
// and nothing in development showed it.
import "@mantine/core/styles.layer.css";
import "./globals.scss";

import { ColorSchemeScript, mantineHtmlProps } from "@mantine/core";
import type { Metadata, Viewport } from "next";
import { Atkinson_Hyperlegible, Young_Serif } from "next/font/google";

import { Providers } from "./providers";

/**
 * The cellar's two hands (§14).
 *
 * Loaded here rather than from a stylesheet link because `next/font` fetches them at build
 * time and serves them from our own origin: a NAS with no outbound internet still gets its
 * fonts, and there is no third-party request on every page load.
 *
 * The variables are named for the **role**, not the face. They used to be `--font-inter` and
 * `--font-bitter`, which meant that changing either one left a variable lying about what it
 * held — and a theme that names a typeface it no longer loads is how this app spent its first
 * year rendering every heading in Georgia without anyone noticing.
 */

/**
 * Display: Young Serif.
 *
 * Old-style with heavy slabbed serifs — estate letterpress rather than luxury branding, and
 * solid at 18px where a high-contrast face goes thin.
 *
 * **It ships one weight, and that is a constraint the theme has to respect** rather than
 * paper over: asking for 600 gets a synthetic bold, which smears the joins at exactly the
 * sizes headings run at. The face is heavy enough at 400 that the hierarchy survives.
 */
const display = Young_Serif({
    subsets: ["latin"],
    weight: ["400"],
    variable: "--font-display",
    display: "swap",
});

/**
 * Interface: Atkinson Hyperlegible.
 *
 * Drawn by the Braille Institute for low vision, with deliberately disambiguated letterforms.
 * The app is dark and is read in a dim room at nine in the evening, and metadata runs at 11px
 * — so a face that argues for itself on legibility is doing the work the contrast rule asks
 * for rather than merely not breaking it.
 */
const ui = Atkinson_Hyperlegible({
    subsets: ["latin"],
    weight: ["400", "700"],
    variable: "--font-ui",
    display: "swap",
});

export const metadata: Metadata = {
    title: "private-stock",
    description: "Self-hosted media cataloger",
    /**
     * Installed on iOS, run without Safari's bars. `black-translucent` lets the page draw under
     * the status bar, which the shell already allows for: every edge pays its safe-area inset
     * (`--ps-safe-*` in globals.scss). The manifest says the rest (`manifest.ts`).
     */
    appleWebApp: {
        capable: true,
        title: "private-stock",
        statusBarStyle: "black-translucent",
    },
};

/**
 * `viewportFit` and the width settings matter from phase 1, not later: the UI is responsive
 * from the start (§14), and a missing viewport tag is the difference between a phone layout
 * and a zoomed-out desktop one.
 */
export const viewport: Viewport = {
    width: "device-width",
    initialScale: 1,
    viewportFit: "cover",
    themeColor: "#14100d",
    /**
     * The on-screen keyboard shrinks the page rather than covering it (Android Chrome; Safari
     * ignores this and is handled where it matters, in `TagNameInput`). Over the page, the
     * keyboard hid a focused box near the bottom, and a dropdown placed below it -- every tag
     * box's suggestions -- was positioned against a viewport that no longer showed it.
     */
    interactiveWidget: "resizes-content",
};

const RootLayout: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <html lang="en" className={`${display.variable} ${ui.variable}`} {...mantineHtmlProps}>
        <head>
            <ColorSchemeScript forceColorScheme="dark" />
        </head>
        <body>
            <Providers>{children}</Providers>
        </body>
    </html>
);

export default RootLayout;
