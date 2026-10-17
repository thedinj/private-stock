import type { Database } from "better-sqlite3";

/**
 * The sprite tile an automatic picture was chosen by, by the tile's moment (§9 "What a tile
 * shows").
 *
 * A performer's picture is chosen by a face and a source's or a keyword's by a look
 * representative, both found on sprite tiles and both recording the tile's nominal moment. The
 * frame a tile shows is another one, usually half an interval later. A picture is now cut from
 * the frame really seen, and `atMs` says which -- so `atMs` no longer tells either job whether a
 * picture already shows what it would choose. `tileAtMs` does: the tile's moment, or NULL for a
 * photograph, a stand-in and anybody's chosen picture.
 *
 * Every automatic picture of a video drawn before this has it NULL, and so is drawn again once,
 * from the right frame. Nothing else is touched.
 */
const hasColumn = (db: Database): boolean =>
    db.prepare(`SELECT 1 FROM pragma_table_info('TagPicture') WHERE "name" = 'tileAtMs'`).get() !==
    undefined;

export function up(db: Database): void {
    if (!hasColumn(db)) {
        db.exec(`ALTER TABLE "TagPicture" ADD COLUMN "tileAtMs" INTEGER;`);
    }
}

export function down(db: Database): void {
    if (hasColumn(db)) {
        db.exec(`ALTER TABLE "TagPicture" DROP COLUMN "tileAtMs";`);
    }
}
