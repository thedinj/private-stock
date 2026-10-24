import type { Clip } from "@private-stock/core";

type SpriteRect = NonNullable<Clip["thumbRect"]>;

/** How much of the face's surroundings a crop keeps: the box alone cuts off the chin and hair. */
const MARGIN = 1.4;

/**
 * A square around a face found on a picture, in the picture's own pixels, for `spriteCropStyle`
 * (§5f "Who is this?"). The face's box is given as fractions of the picture; the square is centred
 * on it, kept inside the picture, and no larger than its shorter side.
 */
export const faceSquare = (
    face: { x: number; y: number; w: number; h: number },
    width: number,
    height: number
): SpriteRect => {
    const side = Math.min(Math.max(face.w * width, face.h * height) * MARGIN, width, height);
    const centreX = (face.x + face.w / 2) * width;
    const centreY = (face.y + face.h / 2) * height;
    const clamp = (value: number, room: number) => Math.min(Math.max(value, 0), room - side);

    return {
        x: clamp(centreX - side / 2, width),
        y: clamp(centreY - side / 2, height),
        width: side,
        height: side,
        sheetWidth: width,
        sheetHeight: height,
    };
};
