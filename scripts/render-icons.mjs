/**
 * Render the raster icons from the seal, apps/web/src/app/icon.svg.
 *
 *   node scripts/render-icons.mjs          # or: pnpm icons:render
 *
 * Writes, beside the SVG, the two files Next picks up by name from `app/`:
 *
 * - `favicon.ico` — 16, 32 and 48 px PNG frames. Browsers that take the SVG ignore it; it is
 *   for the ones that do not, and for anything that asks for /favicon.ico by habit.
 * - `apple-icon.png` — 180 px for an iOS home screen. iOS fills transparency with black and
 *   rounds the corners itself, so the seal sits on the page ground (the `themeColor` in
 *   layout.tsx) inside the safe area rather than on transparency.
 *
 * And, under `apps/web/public/icons/`, the three the manifest (`app/manifest.ts`) names:
 *
 * - `icon-192.png`, `icon-512.png` — the seal on transparency, for launchers that draw their
 *   own backdrop.
 * - `icon-maskable-512.png` — for launchers that crop to a circle or squircle. Everything that
 *   matters must sit inside the central circle of 80% diameter; the seal's widest ripple is
 *   placed inside it, on the page ground, which fills whatever shape the crop leaves.
 *
 * The outputs are committed, so neither the build nor the image needs this to run. sharp comes
 * through Next, which already depends on it, rather than being a dependency of its own.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appDir = path.join(root, "apps/web/src/app");
const iconsDir = path.join(root, "apps/web/public/icons");

const requireFromWeb = createRequire(path.join(root, "apps/web/package.json"));
const requireFromNext = createRequire(requireFromWeb.resolve("next/package.json"));
const sharp = requireFromNext("sharp");

const svg = readFileSync(path.join(appDir, "icon.svg"));

/** The SVG is drawn on a 64-unit grid; this density rasterises it at `size` px directly. */
const render = (size) =>
    sharp(svg, { density: (72 * size) / 64 })
        .resize(size, size)
        .png()
        .toBuffer();

/** An ICO is a directory of images; modern ones may hold PNGs verbatim. */
const toIco = (frames) => {
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2); // 1 = icon
    header.writeUInt16LE(frames.length, 4);

    let offset = 6 + 16 * frames.length;
    const entries = frames.map(({ size, png }) => {
        const entry = Buffer.alloc(16);
        entry.writeUInt8(size >= 256 ? 0 : size, 0);
        entry.writeUInt8(size >= 256 ? 0 : size, 1);
        entry.writeUInt8(0, 2); // no palette
        entry.writeUInt8(0, 3);
        entry.writeUInt16LE(1, 4); // planes
        entry.writeUInt16LE(32, 6); // bits per pixel
        entry.writeUInt32LE(png.length, 8);
        entry.writeUInt32LE(offset, 12);
        offset += png.length;
        return entry;
    });

    return Buffer.concat([header, ...entries, ...frames.map((frame) => frame.png)]);
};

const GROUND = "#14100d";
const APPLE = 180;
const APPLE_SEAL = 148;
const MASKABLE = 512;
/** The seal reaches r=30 of its 64-unit box; at 72% of 512 that is a 172 px radius, inside the 205 px safe circle. */
const MASKABLE_SEAL = 368;

/** The seal centred on the page ground, with nothing transparent left. */
const onGround = async (size, sealSize) => {
    const inset = (size - sealSize) / 2;

    return sharp({ create: { width: size, height: size, channels: 4, background: GROUND } })
        .composite([{ input: await render(sealSize), left: inset, top: inset }])
        .flatten({ background: GROUND })
        .png()
        .toBuffer();
};

const main = async () => {
    const frames = [];
    for (const size of [16, 32, 48]) {
        frames.push({ size, png: await render(size) });
    }
    writeFileSync(path.join(appDir, "favicon.ico"), toIco(frames));

    writeFileSync(path.join(appDir, "apple-icon.png"), await onGround(APPLE, APPLE_SEAL));

    mkdirSync(iconsDir, { recursive: true });
    writeFileSync(path.join(iconsDir, "icon-192.png"), await render(192));
    writeFileSync(path.join(iconsDir, "icon-512.png"), await render(512));
    writeFileSync(
        path.join(iconsDir, "icon-maskable-512.png"),
        await onGround(MASKABLE, MASKABLE_SEAL)
    );

    console.log("wrote favicon.ico, apple-icon.png and public/icons/ (192, 512, maskable 512)");
};

await main();
