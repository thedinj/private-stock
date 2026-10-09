import type { CSSProperties } from "react";

import type { Clip } from "@private-stock/core";

type SpriteRect = NonNullable<Clip["thumbRect"]>;

/**
 * The square at the centre of a sprite tile, as a rectangle of the same sheet.
 *
 * For a box that is square, which is how a look's matching frame is shown (§5e): a frame of any
 * shape — a 16:9 film, a 9:16 phone video — fills a square without stretching, where cropping
 * the whole tile into the grid's 16:9 box squashed every upright frame flat.
 */
export const centreSquare = (rect: SpriteRect): SpriteRect => {
    const side = Math.min(rect.width, rect.height);

    return {
        ...rect,
        x: rect.x + (rect.width - side) / 2,
        y: rect.y + (rect.height - side) / 2,
        width: side,
        height: side,
    };
};

/**
 * The style that shows `rect` of a sprite sheet filling its box (§14d).
 *
 * **The box must be the rectangle's shape**, or the picture stretches: a clip card takes its
 * tile's aspect, and a look's tile gives a square box `centreSquare`.
 *
 * **In percentages, so it scales with whatever box it is given.** A card in a fluid grid has no
 * width until it is laid out; a crop in pixels would need that width in advance, which is the
 * one thing a grid does not tell you. `background-size` blows the whole sheet up in proportion
 * and `background-position` keeps the rectangle in frame, both relative to the box. The pixel
 * rectangle the server computed still decides *which* part of the sheet; only the units change.
 *
 * `background-position` in percent places the *image* within the *box* — 100% means their right
 * edges meet — so the travel is the sheet minus the rectangle. A sheet no wider than it has none,
 * and dividing by it would put the crop nowhere.
 */
export const spriteCropStyle = (url: string, rect: SpriteRect): CSSProperties => {
    const travelX = rect.sheetWidth - rect.width;
    const travelY = rect.sheetHeight - rect.height;

    return {
        backgroundImage: `url(${url})`,
        backgroundRepeat: "no-repeat",
        backgroundSize: `${(rect.sheetWidth / rect.width) * 100}% ${
            (rect.sheetHeight / rect.height) * 100
        }%`,
        backgroundPosition: `${travelX > 0 ? (rect.x / travelX) * 100 : 0}% ${
            travelY > 0 ? (rect.y / travelY) * 100 : 0
        }%`,
    };
};
