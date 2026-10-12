// Mantine's stylesheet in its own cascade layer, so every unlayered rule of ours beats it
// whatever order the two arrive in. Next does not keep that order: the production build put
// globals.scss before Mantine and dev puts it after, so the same tie went opposite ways in the
// two -- stars sat 13px high on a phone, the ground was Mantine's grey-brown rather than ours,
// and nothing in development showed it.
import "@mantine/core/styles.layer.css";
import "./globals.scss";

import { ColorSchemeScript, mantineHtmlProps } from "@mantine/core";
import type { Metadata, Viewport } from "next";
import {
    Atkinson_Hyperlegible_Next,
    Grenze_Gotisch,
    Homemade_Apple,
    Young_Serif,
} from "next/font/google";

import { Providers } from "./providers";

/**
 * The cellar's hands (§14).
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
 * Interface: Atkinson Hyperlegible Next.
 *
 * Drawn by the Braille Institute for low vision, with deliberately disambiguated letterforms.
 * The app is dark and is read in a dim room at nine in the evening, and metadata runs at 11px
 * — so a face that argues for itself on legibility is doing the work the contrast rule asks
 * for rather than merely not breaking it.
 *
 * **Next, not the original**: the same family redrawn by the same foundry, variable from 200 to
 * 800 with an italic. The original shipped 400 and 700 only, so every `fw={500}` in the app --
 * tile titles, playlist names, a dozen labels -- rendered as regular and every 600 as bold.
 * Loaded as the variable font, so one file carries every weight in between.
 */
const ui = Atkinson_Hyperlegible_Next({
    subsets: ["latin"],
    style: ["normal", "italic"],
    variable: "--font-ui",
    display: "swap",
});

/**
 * The label: Grenze Gotisch, on page plates and nowhere else.
 *
 * German wine labels still set the estate's name in blackletter, and the page plate is the
 * app's label -- one per screen, where you are, said loudly. A narrow variable Gothic rather
 * than a Fraktur revival, so it stays open enough to read a directory name at plate size; it
 * would not survive being asked to set a paragraph, and is never asked to. The blackletter
 * initial on a collection's description borrows it for a single letter.
 */
const label = Grenze_Gotisch({
    subsets: ["latin"],
    variable: "--font-label",
    display: "swap",
});

/**
 * The hand: Homemade Apple, for what the household wrote and nothing the app says.
 *
 * A note is somebody's own words, so it is set in somebody's handwriting, and the
 * distinction is the point: the app's voice is typeset, a person's is written. Only the
 * private note uses it -- a field you write in, read back by the one person who wrote it.
 */
const hand = Homemade_Apple({
    subsets: ["latin"],
    weight: ["400"],
    variable: "--font-hand",
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
    themeColor: "#0f0d0b",
    /**
     * The on-screen keyboard shrinks the page rather than covering it (Android Chrome; Safari
     * ignores this and is handled where it matters, in `TagNameInput`). Over the page, the
     * keyboard hid a focused box near the bottom, and a dropdown placed below it -- every tag
     * box's suggestions -- was positioned against a viewport that no longer showed it.
     */
    interactiveWidget: "resizes-content",
};

const RootLayout: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <html
        lang="en"
        className={`${display.variable} ${ui.variable} ${label.variable} ${hand.variable}`}
        {...mantineHtmlProps}
    >
        <head>
            <ColorSchemeScript forceColorScheme="dark" />
        </head>
        <body>
            <Providers>{children}</Providers>
        </body>
    </html>
);

export default RootLayout;
