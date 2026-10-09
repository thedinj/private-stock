import { stat, writeFile } from "node:fs/promises";
import * as path from "node:path";

import {
    type SpriteLayout,
    type StageState,
    artifactRelPath,
    buildSpriteVtt,
    spriteLayout,
} from "@private-stock/core";
import { artifactVersion, loadConfig } from "@private-stock/core/server";
import { artifactRepo, db, mediaRepo } from "@private-stock/db";

import { renderSpriteSheets } from "../media/sprites.js";
import { resolveSource } from "../media/sourcePath.js";
import { adoptArtifacts, settledTwin } from "../media/twin.js";
import type { JobRow } from "../queue.js";

/**
 * The `sprite` job: the filmstrip behind the scrubber (§9).
 *
 * Videos only. A still image has nothing to scrub through, and an animated GIF is short
 * enough that the cover is already the whole story.
 */

/**
 * 2: the tile target dropped from 300 to 100 (§9).
 *
 * The grid is unchanged, so rows written under 1 are still self-consistent — each VTT was
 * built against the sheet beside it — and nothing is broken by leaving them. They just carry
 * roughly three times the tiles they need. The bump is what a re-enqueue sweep will read to
 * tell them apart.
 */
export const SPRITE_GENERATOR_VERSION = 2;

export const runSprite = async (job: JobRow): Promise<StageState | void> => {
    if (!job.mediaId || !job.fileId) {
        throw new Error("sprite job requires both mediaId and fileId");
    }

    const mediaId = job.mediaId;
    const media = mediaRepo.findBasic(mediaId);

    if (!media || media.kind !== "video") {
        // A still has nothing to scrub through.
        return "skipped";
    }

    const source = resolveSource(job.fileId);

    if (!source) {
        return "skipped";
    }

    const layout = spriteLayout(media.durationMs);
    const durationMs = media.durationMs ?? layout.tileCount * layout.intervalMs;

    // An identical copy already has its filmstrip (§10f).
    const twin = settledTwin(job.fileId, "sprite");

    if (twin?.state === "empty") {
        return "empty";
    }

    if (twin && (await borrowSheets(mediaId, twin.mediaId, source.rootId, layout, durationMs))) {
        return;
    }

    const config = loadConfig();
    const sheetRelPath = (ordinal: number): string => artifactRelPath(mediaId, "sprite", ordinal);
    const outputDir = path.resolve(config.dataDir, path.dirname(sheetRelPath(0)));

    const rendered = await renderSpriteSheets(source.absolutePath, outputDir, layout);

    const sheets = await Promise.all(
        rendered.sheetPaths.map(async (absolutePath, ordinal) => ({
            ordinal,
            relPath: sheetRelPath(ordinal),
            bytes: (await stat(absolutePath)).size,
        }))
    );

    /**
     * Sheet URLs are written into the VTT with a version token taken from each row's
     * `generatedAt`, which does not exist until the row is written — so the rows go in first
     * and the VTT is built from what they came back with.
     */
    const rows = db.transaction(() =>
        sheets.map((sheet) =>
            artifactRepo.upsert({
                mediaId,
                kind: "sprite",
                ordinal: sheet.ordinal,
                relPath: sheet.relPath,
                width: rendered.tileWidth * layout.columns,
                height: rendered.tileHeight * layout.rows,
                tileCount: Math.min(
                    layout.columns * layout.rows,
                    layout.tileCount - sheet.ordinal * layout.columns * layout.rows
                ),
                intervalMs: layout.intervalMs,
                bytes: sheet.bytes,
                source: "auto",
                generatorVersion: SPRITE_GENERATOR_VERSION,
            })
        )
    )();

    await writeSpriteVtt(mediaId, source.rootId, rows, {
        layout,
        durationMs,
        tileWidth: rendered.tileWidth,
        tileHeight: rendered.tileHeight,
        generatorVersion: SPRITE_GENERATOR_VERSION,
    });
};

/**
 * Take an identical copy's sprite sheets, and write this item its own VTT over them.
 *
 * The sheets copy as they are. The VTT cannot: every cue names its sheet by URL, and the URL
 * carries the item's id and a version token from the row — a copied VTT would send this
 * item's scrubber to the twin's sheets, which stop existing when the twin is deleted, and an
 * identical twin is exactly the item most likely to be.
 *
 * Only when the twin's sheets were cut to the layout this item would get. They describe the
 * same bytes, so they always should be; a mismatch means something has changed underneath,
 * and rendering is the answer that cannot be wrong.
 */
const borrowSheets = async (
    mediaId: string,
    twinMediaId: string,
    rootId: string,
    layout: SpriteLayout,
    durationMs: number
): Promise<boolean> => {
    const twinSheets = artifactRepo.listForMedia(twinMediaId, ["sprite"]);
    const first = twinSheets[0];

    if (!first?.width || !first.height || first.intervalMs !== layout.intervalMs) {
        return false;
    }

    const rows = await adoptArtifacts(mediaId, twinMediaId, (row) => row.kind === "sprite");

    if (!rows) {
        return false;
    }

    await writeSpriteVtt(mediaId, rootId, rows, {
        layout,
        durationMs,
        tileWidth: first.width / layout.columns,
        tileHeight: first.height / layout.rows,
        generatorVersion: first.generatorVersion,
    });

    return true;
};

/**
 * Write the VTT that maps the scrubber's timeline onto these sheets, and its row.
 *
 * The sheet count comes from the rows rather than the layout: ffmpeg decides how many sheets
 * it actually writes, a duration that was slightly wrong gives one more or one fewer than
 * the layout predicted, and the sheets on disk are the truth the VTT must describe.
 *
 * Sheet URLs carry the same version token the web app would produce, so the browser caches a
 * sheet for a year rather than revalidating it on every open.
 */
const writeSpriteVtt = async (
    mediaId: string,
    rootId: string,
    sheets: artifactRepo.ArtifactRow[],
    options: {
        layout: SpriteLayout;
        durationMs: number;
        tileWidth: number;
        tileHeight: number;
        generatorVersion: number;
    }
): Promise<void> => {
    const { layout } = options;
    const config = loadConfig();
    const vttRelPath = artifactRelPath(mediaId, "spriteVtt");

    const vtt = buildSpriteVtt({
        layout: { ...layout, sheetCount: sheets.length },
        durationMs: options.durationMs,
        tileWidth: options.tileWidth,
        tileHeight: options.tileHeight,
        sheetUrl: (ordinal) => {
            const row = sheets[Math.min(ordinal, sheets.length - 1)];

            return `/api/art/${mediaId}/sprite-${ordinal}?v=${artifactVersion(
                row.relPath,
                row.generatedAt
            )}`;
        },
    });

    const vttPath = path.resolve(config.dataDir, vttRelPath);
    await writeFile(vttPath, vtt, "utf8");

    db.transaction(() => {
        artifactRepo.upsert({
            mediaId,
            kind: "spriteVtt",
            ordinal: 0,
            relPath: vttRelPath,
            tileCount: layout.tileCount,
            intervalMs: layout.intervalMs,
            bytes: Buffer.byteLength(vtt, "utf8"),
            source: "auto",
            generatorVersion: options.generatorVersion,
        });

        artifactRepo.recordArtifactChange(mediaId, rootId, "spriteVtt");
    })();
};
