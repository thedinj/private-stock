"use client";

import { createTheme, type MantineColorsTuple } from "@mantine/core";

/**
 * The wine-cellar theme — one source for the whole look (§14).
 *
 * Deep oak and near-black ground, aged brass as the accent, oxblood for emphasis. The rule
 * that keeps it from becoming kitsch: texture and warmth live in the chrome, never behind
 * the media. A thumbnail sits in a rack; it is not printed on wood.
 */

/**
 * Gilt — the primary accent. Still called brass, because that is what every call site and
 * the whole of §14 call it; it is brighter than it was, gold leaf rather than aged metal, so
 * that it holds its own against a blacker ground and a blackletter plate.
 */
const brass: MantineColorsTuple = [
    "#fdf7e8",
    "#f7ebcd",
    "#efd9a3",
    "#e9c879",
    "#e4b955",
    "#dbab44",
    "#cf9d33",
    "#b48526",
    "#9c721e",
    "#835e14",
];

/**
 * Oak — the ground and its text. Browns that stay brown when dimmed, rather than sliding
 * grey; pulled a little towards the gilt and away from red, so the room reads as old gold on
 * black rather than as a brown study.
 */
const oak: MantineColorsTuple = [
    "#f4efe8",
    "#e2d8ca",
    "#cbbca8",
    "#b4a794",
    "#9e8e78",
    "#8f7e67",
    "#86745c",
    "#73634d",
    "#665641",
    "#584935",
];

/** Oxblood — emphasis, ratings, destructive confirmation. */
const oxblood: MantineColorsTuple = [
    "#ffeaec",
    "#fcd4d7",
    "#f4a7ac",
    "#ec777e",
    "#e64f57",
    "#e3353f",
    "#e22732",
    "#c91a25",
    "#b31220",
    "#9d0419",
];

/**
 * Verdigris — brass gone green. The one cool colour in the room, and so the one that can say
 * "ready" without borrowing a traffic light's green: it is what old brass becomes, not a
 * colour brought in from outside. Rare by design; see `diagReady`.
 */
const verdigris: MantineColorsTuple = [
    "#eef7f4",
    "#d5ebe4",
    "#b7dacf",
    "#9ac9bb",
    "#7fb3a3",
    "#6fa393",
    "#629484",
    "#517c6e",
    "#446a5e",
    "#365549",
];

/**
 * Mantine's dark palette, warmed (§14).
 *
 * Every surface Mantine draws for itself in dark mode comes from this tuple: text (0), dimmed
 * (2), borders (4), the fill of inputs and default buttons (6), cards, papers and the shell
 * (7), segmented tracks (8). Left at Mantine's own, all of it was neutral grey -- #242424
 * cards, #2e2e2e buttons -- and on the pages that are mostly cards and controls the largest
 * objects on screen were the only cool things in a warm room. Overriding the tuple rather
 * than each component warms every one of them at once, including ones added later.
 *
 * Built from the same ground: 0-3 are the oak text shades, 7 sits between the ground and the
 * rack surface so a card reads as standing off the wall without competing with a tile, and 9
 * is the well.
 */
const dark: MantineColorsTuple = [
    "#ece4d7",
    "#cbbca8",
    "#b4a794",
    "#968872",
    "#3d362e",
    "#322c25",
    "#25201b",
    "#1e1a16",
    "#16130f",
    "#0a0807",
];

export const theme = createTheme({
    primaryColor: "brass",
    primaryShade: { light: 6, dark: 4 },
    colors: { brass, oak, oxblood, verdigris, dark },

    // A slabbed old-style serif for display against a legibility-first sans for UI. The
    // serif carries the cellar feeling; using it for body text would just hurt to read.
    //
    // Both arrive as CSS variables from `next/font` in the root layout, named for their role
    // rather than for the face. Naming the families directly here is what the theme did for
    // its first year, and neither font was ever loaded -- so every heading rendered in
    // Georgia and nobody noticed, because a fallback stack fails silently by design.
    //
    // **Headings are 400 because the display face has only 400.** Anything heavier is
    // synthesised by the browser, which thickens the slabs unevenly and fills the counters at
    // the sizes headings actually run at. Young Serif is heavy enough that the hierarchy
    // comes from size and colour instead, which is where it should come from anyway.
    //
    // **The interface face is variable, 200 to 800, with a real italic** (Atkinson
    // Hyperlegible Next). Its predecessor shipped 400 and 700 only, so `fw={500}` -- which the
    // tile title, the playlist name and a dozen other places ask for -- rendered as regular
    // for a year. It now renders as asked; any weight in the range is real, not synthesised.
    fontFamily:
        "var(--font-ui), -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",

    /**
     * A scale with drama at the top, rather than six sizes a tenth apart.
     *
     * Mantine's own headings run 34 / 26 / 22 / 18 / 17 / 15 — barely more than a percentage
     * apart at the bottom and a flat 1.3 at the top, which is a hierarchy nobody can see at a
     * glance. **The display face has one weight**, so every step of the hierarchy has to be
     * carried by size and colour; a scale that steps by a tenth cannot carry it.
     *
     * h1 is the page plate and nothing else uses it. It is fluid because it is the one place
     * in the app where a heading is supposed to be an event; everything below it is fixed
     * `rem`, because fluid type in a dense product UI makes the same row a different size on
     * two machines.
     */
    headings: {
        fontFamily: "var(--font-display), Georgia, 'Times New Roman', serif",
        fontWeight: "400",
        sizes: {
            h1: { fontSize: "clamp(2.375rem, 1.55rem + 3.3vw, 3.75rem)", lineHeight: "1.04" },
            h2: { fontSize: "clamp(1.75rem, 1.4rem + 1.4vw, 2.375rem)", lineHeight: "1.1" },
            h3: { fontSize: "1.625rem", lineHeight: "1.2" },
            h4: { fontSize: "1.25rem", lineHeight: "1.3" },
            h5: { fontSize: "1rem", lineHeight: "1.4" },
            h6: { fontSize: "0.875rem", lineHeight: "1.45" },
        },
    },

    defaultRadius: "sm",

    // Filled surfaces pick their own label colour by luminance.
    //
    // Brass is a light accent: at `primaryShade.dark = 4` a filled badge or button is
    // #e4b955, and Mantine's default white label on it is genuinely hard to read at 10-14px.
    // Set here rather than overridden per component so nothing new has to remember it.
    autoContrast: true,

    other: {
        // Candle-warm glow on hover instead of a blue focus ring.
        // Body text on a warm panel -- the details drawer's values -- a step warmer than oak-1.
        textWarm: "#e6dccc",
        hoverGlow: "0 0 0 1px rgba(228, 185, 85, 0.45), 0 4px 24px -6px rgba(228, 185, 85, 0.35)",
        // The showcase tile playing with sound (§14f): a solid brass ring and a wide halo, so
        // the one tile speaking can be found at a glance across the wall.
        // The dark drop beneath is what lifts it off the wall; the brass is what names it.
        voiceGlow:
            "0 0 0 3px rgba(228, 185, 85, 0.95), 0 0 48px 8px rgba(228, 185, 85, 0.45), 0 24px 48px -10px rgba(0, 0, 0, 0.85)",
        voiceGlowSoft:
            "0 0 0 3px rgba(228, 185, 85, 0.8), 0 0 32px 4px rgba(228, 185, 85, 0.3), 0 24px 48px -10px rgba(0, 0, 0, 0.85)",
        // Hairline brass edge plus inset shadow: tiles read as bottles in a rack. The lit
        // top edge does the lifting, so it is the half worth spending on.
        rackEdge: "inset 0 1px 0 rgba(236, 218, 186, 0.16), inset 0 -1px 0 rgba(0, 0, 0, 0.55)",
        /**
         * Three planes, far enough apart to be three.
         *
         * They used to be #17120f, #211a15 and #120e0b — a ground and a surface five points
         * apart, which at candlelight is one flat brown field with borders drawn on it. The
         * rack is furniture: a shelf stands off the wall and a bottle sits back into the
         * shelf, and the eye should get that before it finds a single hairline.
         */
        groundDark: "#0f0d0b",
        surfaceDark: "#1e1a16",
        // The well a thumbnail sits in -- darker than the ground, so media reads as set into
        // the page rather than laid on it.
        wellDark: "#0a0807",
        // Warm hairlines instead of grey dividers. The fading one is for section rules: a
        // line that travels and gives out reads as a flourish rather than a table border.
        hairline: "rgba(236, 218, 186, 0.10)",
        hairlineStrong: "rgba(236, 218, 186, 0.20)",
        hairlineFade:
            "linear-gradient(90deg, rgba(228, 185, 85, 0.42) 0%, rgba(228, 185, 85, 0.10) 38%, rgba(228, 185, 85, 0) 100%)",
        /**
         * The rule under a page title — the app's letterhead.
         *
         * Brass at nearly full strength where it starts, gone by two thirds. The quiet
         * `hairlineFade` is for dividing things that are alike; this one is for announcing
         * where you are, and there is exactly one of them per screen. An accent works because
         * it is rare (§14).
         */
        plateRule:
            "linear-gradient(90deg, rgba(228, 185, 85, 0.92) 0%, rgba(228, 185, 85, 0.34) 30%, rgba(228, 185, 85, 0) 72%)",
        /**
         * The warming overlay's four states (§8b, "Seeing it work"). An instrument, not
         * decoration, so it is allowed the plain traffic-light reading the rest of the cellar
         * avoids. Muted enough to sit on a film without shouting over it.
         */
        diagReady: verdigris[4],
        diagPending: "#d9a441",
        diagOff: "#8c8279",
        diagMiss: "#d8695a",
        diagPanel: "rgba(10, 8, 7, 0.86)",
    },

    components: {
        /**
         * Panels over the page wear the page's surface, not Mantine's neutral grey.
         *
         * `--mantine-color-body` is a cool #242424, and a Drawer or Modal in it was the one grey
         * object in a warm room. The header is given the same surface explicitly because it is
         * sticky: a sticky bar without a background lets the content scrolling under it show
         * through, which is what the viewer's Details panel did. The hairline under it says
         * where the fixed part ends.
         */
        Drawer: {
            styles: {
                content: { backgroundColor: "var(--ps-surface)" },
                header: {
                    backgroundColor: "var(--ps-surface)",
                    borderBottom: "1px solid var(--ps-hairline)",
                },
            },
        },
        Modal: {
            styles: {
                content: { backgroundColor: "var(--ps-surface)" },
                header: { backgroundColor: "var(--ps-surface)" },
            },
        },
        Card: {
            defaultProps: {
                radius: "sm",
                withBorder: true,
            },
        },
        Badge: {
            defaultProps: {
                radius: "sm",
                variant: "light",
            },
        },
        // Mantine stands an Indicator at z-index 200, above AppShell's 100, so the count on
        // the phone's Filters button showed through the nav as it slid over the page. It
        // only has to clear the control it is pinned to. Set here so the next one added is
        // right too.
        Indicator: {
            defaultProps: {
                zIndex: 1,
            },
        },
        Rating: {
            defaultProps: {
                color: "brass",
            },
        },
        // A SegmentedControl stands 3.7px taller than the inputs and buttons beside it
        // (39.7 against 36.0), because it wraps its labels in 4px of its own padding. Its
        // `size` is already `sm`, so the fix is the height rather than the size token:
        // 2.25rem is what Mantine gives a `sm` input, and matching it lines a toolbar up
        // top and bottom. Set here so the next one added is right too.
        SegmentedControl: {
            defaultProps: {
                size: "sm",
            },
            styles: {
                root: { height: "2.25rem" },
                label: { display: "flex", alignItems: "center" },
            },
        },
        // NavLink computes `border-radius: 0`, does not read `defaultRadius`, and has no
        // `radius` prop to pass -- so the nav was the only square-cornered surface in an app
        // where cards, buttons, badges, inputs, tiles and the drawer are all 4px. It has to
        // be said as a style.
        NavLink: {
            styles: {
                root: { borderRadius: "var(--mantine-radius-sm)" },
            },
        },
    },
});
