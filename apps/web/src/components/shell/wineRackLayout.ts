/**
 * Where the wine rack's bottles and tags sit on its picture, in percent of the rack (§21 "Getting
 * into the cellar").
 *
 * Generated with the pictures in `public/cellar/` by `apps/web/scripts/wineRackArt.html`: the
 * openings are hand-cut, each a little off true, so the bottles and tags follow the openings the
 * picture actually has. Regenerate the two together or the bottles will sit beside their holes.
 */

/** The picture's own size, in the CSS pixels it was drawn at. */
export const RACK_SIZE = { width: 300, height: 384 };

/** A bottle's box, in percent of the rack's width and height. */
export const BOTTLE_SIZE = { width: 25.333, height: 19.792 };

export const BOTTLES = [
    { digit: "1", left: 6.493, top: 4.538 },
    { digit: "2", left: 37.797, top: 4.723 },
    { digit: "3", left: 68.536, top: 4.377 },
    { digit: "4", left: 6.221, top: 27.795 },
    { digit: "5", left: 37.052, top: 28.165 },
    { digit: "6", left: 68.034, top: 27.411 },
    { digit: "7", left: 5.781, top: 51.243 },
    { digit: "8", left: 37.811, top: 51.664 },
    { digit: "9", left: 68.482, top: 51.288 },
    { digit: "0", left: 37.479, top: 75.056 },
] as const;

/** Each bottle's paper tag, and the string it hangs from. */
export const TAGS = [
    {
        digit: "1",
        left: 21.972,
        top: 21.27,
        tilt: -3.85,
        stringLeft: 27.305,
        stringTop: 18.145,
        stringTilt: -5.5,
    },
    {
        digit: "2",
        left: 53.815,
        top: 20.947,
        tilt: -5.65,
        stringLeft: 59.149,
        stringTop: 17.822,
        stringTilt: -8.07,
    },
    {
        digit: "3",
        left: 83.958,
        top: 20.689,
        tilt: -3.1,
        stringLeft: 89.292,
        stringTop: 17.564,
        stringTilt: -4.44,
    },
    {
        digit: "4",
        left: 21.62,
        top: 44.447,
        tilt: -5.91,
        stringLeft: 26.953,
        stringTop: 41.322,
        stringTilt: -8.44,
    },
    {
        digit: "5",
        left: 52.247,
        top: 44.629,
        tilt: 5.05,
        stringLeft: 57.581,
        stringTop: 41.504,
        stringTilt: 7.21,
    },
    {
        digit: "6",
        left: 84.859,
        top: 44.178,
        tilt: -3.09,
        stringLeft: 90.192,
        stringTop: 41.053,
        stringTilt: -4.41,
    },
    {
        digit: "7",
        left: 21.157,
        top: 67.88,
        tilt: 3.07,
        stringLeft: 26.49,
        stringTop: 64.755,
        stringTilt: 4.39,
    },
    {
        digit: "8",
        left: 53.961,
        top: 67.632,
        tilt: -5.93,
        stringLeft: 59.294,
        stringTop: 64.507,
        stringTilt: -8.47,
    },
    {
        digit: "9",
        left: 83.895,
        top: 67.982,
        tilt: -2.41,
        stringLeft: 89.228,
        stringTop: 64.857,
        stringTilt: -3.44,
    },
    {
        digit: "0",
        left: 53.44,
        top: 91.495,
        tilt: 4.06,
        stringLeft: 58.773,
        stringTop: 88.37,
        stringTilt: 5.8,
    },
] as const;
