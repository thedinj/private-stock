import {
    AuthorizationError,
    SPRITE_COLUMNS,
    SPRITE_ROWS,
    ValidationError,
    normalizeText,
    spriteTileAt,
    type OcrChangeResult,
    type OcrEditInput,
    type OcrFrame,
    type OcrReviewInput,
    type OcrTarget,
} from "@private-stock/core";
import { artifactRepo, mediaTextRepo, ocrTagMatchRepo, searchRepo } from "@private-stock/db";

import type { AuthContext } from "../auth/withAuth";
import { artifactUrl } from "./artService";

/**
 * Reviewing text read out of the picture (§5d "Reviewing what was read"): confirming, correcting
 * and dismissing findings from an item's details, plus the helpers the OCR lists share.
 *
 * **Admin only**, like the duplicates review. Corrections change what the whole household
 * searches, so they are curation of the library rather than a private preference.
 */

export const requireAdmin = (auth: AuthContext): void => {
    if (!auth.scopes.includes("admin")) {
        throw new AuthorizationError("Only an administrator can review OCR text");
    }
};

/**
 * Cursors are opaque to the client: base64url JSON. A cursor that does not decode is treated
 * as a bad request rather than as "start again", which would silently show page one twice.
 */
export const encodeCursor = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

export const decodeCursor = <T>(
    cursor: string | undefined,
    valid: (value: unknown) => value is T
): T | null => {
    if (cursor === undefined) {
        return null;
    }

    try {
        const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));

        if (valid(value)) {
            return value;
        }
    } catch {
        // Falls through to the refusal below.
    }

    throw new ValidationError("That page of results is no longer valid; reload the list");
};

export const isStringCursor = (value: unknown): value is mediaTextRepo.StringCursor =>
    typeof value === "object" &&
    value !== null &&
    "textNorm" in value &&
    typeof value.textNorm === "string" &&
    "value" in value &&
    (value.value === null || typeof value.value === "number");

export const isItemCursor = (value: unknown): value is string => typeof value === "string";

/**
 * The tile of the item's own sprite sheet covering a moment, or null when it has none.
 *
 * The picture the engine looked at, near enough, for nothing: the sheets already exist for the
 * scrubber. `spriteTileAt` is the arithmetic the VTT is written with, so the review page and
 * the scrubber agree about which picture belongs to which moment.
 */
export const frameFinder = (mediaId: string): ((atMs: number | null) => OcrFrame | null) => {
    const sprites = artifactRepo.listForMedia(mediaId, ["sprite", "spriteVtt"]);
    const sheets = sprites.filter((row) => row.kind === "sprite");
    const track = sprites.find((row) => row.kind === "spriteVtt");
    const first = sheets[0];

    if (!first?.width || !first.height || !track?.tileCount || !track.intervalMs) {
        return () => null;
    }

    const tileWidth = first.width / SPRITE_COLUMNS;
    const tileHeight = first.height / SPRITE_ROWS;
    const layout = {
        intervalMs: track.intervalMs,
        tileCount: track.tileCount,
        columns: SPRITE_COLUMNS,
    };

    return (atMs) => {
        if (atMs === null) {
            return null;
        }

        const tile = spriteTileAt(atMs, layout, tileWidth, tileHeight);
        const sheet = sheets.find((row) => row.ordinal === tile.sheet);

        if (!sheet?.width || !sheet.height) {
            return null;
        }

        return {
            url: artifactUrl(mediaId, `sprite-${sheet.ordinal}`, sheet.relPath, sheet.generatedAt),
            x: tile.x,
            y: tile.y,
            width: tileWidth,
            height: tileHeight,
            sheetWidth: sheet.width,
            sheetHeight: sheet.height,
        };
    };
};

export const fileNameOf = (relPath: string | null): string =>
    relPath ? (relPath.split("/").pop() ?? relPath) : "";

/**
 * The search index carries the text, so anything that changes it owes those items a rebuild.
 * Returns them, so the client can refresh whichever of their details it has open.
 */
const reindex = (rows: mediaTextRepo.TargetRow[]): string[] => {
    const mediaIds = [...new Set(rows.map((row) => row.mediaId))];

    if (mediaIds.length > 0) {
        searchRepo.requestReindex(mediaIds);
    }

    return mediaIds;
};

/**
 * The strings an action touches, read before it: a correction moves findings to another string,
 * and both are then owed a fresh match against the performers and sources (§5d).
 */
const stringsOf = (target: OcrTarget): string[] =>
    mediaTextRepo.findByIds(target.rowIds).map((row) => row.textNorm);

export const review = (input: OcrReviewInput, auth: AuthContext): OcrChangeResult => {
    requireAdmin(auth);

    const strings = stringsOf(input.target);
    const rows = mediaTextRepo.scopeRowIds(input.target.rowIds, input.action);
    const ids = rows.map((row) => row.id);

    if (ids.length === 0) {
        return { updated: 0, mediaIds: [] };
    }

    if (input.action === "restore") {
        mediaTextRepo.restore(ids);
    } else {
        mediaTextRepo.setReviewState(
            ids,
            input.action === "confirm" ? "confirmed" : "dismissed",
            auth.userId
        );
    }

    // A dismissed string names nobody, and a restored one may again.
    ocrTagMatchRepo.rematchStrings(strings);

    return { updated: ids.length, mediaIds: reindex(rows) };
};

export const edit = (input: OcrEditInput, auth: AuthContext): OcrChangeResult => {
    requireAdmin(auth);

    const strings = stringsOf(input.target);
    const rows = mediaTextRepo.scopeRowIds(input.target.rowIds, "edit");

    if (rows.length === 0) {
        return { updated: 0, mediaIds: [] };
    }

    const text = input.text.replace(/\s+/g, " ");

    mediaTextRepo.editText(
        rows.map((row) => row.id),
        text,
        auth.userId
    );
    ocrTagMatchRepo.rematchStrings([...strings, normalizeText(text)]);
    return { updated: rows.length, mediaIds: reindex(rows) };
};
