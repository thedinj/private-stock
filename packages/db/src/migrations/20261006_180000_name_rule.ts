import type { Database } from "better-sqlite3";

/**
 * Stored tag and alias names follow the one rule for names (§5b "One rule for names").
 *
 * `nameNorm` used to glue punctuation (`Mary-Kate` → `marykate`) and keep accents. The rule now
 * folds accents and treats every separator — hyphen, underscore, plus, dot — as a space, so
 * "Mary-Kate" is stored as `mary kate` and "Zoë" as `zoe`. Measured on the library before this
 * ran: 15 rows change (8 tags, 7 aliases, all dotted or hyphenated names) and none collide.
 *
 * Both rules are copied here rather than imported: a migration has to keep doing what it did when
 * it was written, whatever `normalizeName` becomes later.
 *
 * A row whose new form would collide with another name in its vocabulary keeps its old form and
 * is reported, rather than failing the boot over a name somebody can rename by hand. Idempotent:
 * a row already in the new form is left alone.
 */

const newRule = (name: string): string =>
    name
        .normalize("NFKD")
        .replace(/\p{M}/gu, "")
        .toLowerCase()
        .replace(/['’ʼ`]/g, "")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();

const oldRule = (name: string): string =>
    name
        .trim()
        .toLowerCase()
        .replace(/[\s_]+/g, " ")
        .replace(/[^\p{L}\p{N} ]/gu, "")
        .trim();

interface NameRow {
    id: string;
    name: string;
    nameNorm: string;
    /** What makes two names the same vocabulary: facet and owner for a tag, the tag for an alias. */
    scope: string;
}

const renormalise = (db: Database, rule: (name: string) => string): void => {
    const tags = db
        .prepare(
            `SELECT "id", "name", "nameNorm", "kind" || '|' || COALESCE("ownerId", '') AS "scope"
               FROM "Tag"`
        )
        .all() as NameRow[];
    const aliases = db
        .prepare(`SELECT "id", "name", "nameNorm", "tagId" AS "scope" FROM "TagAlias"`)
        .all() as NameRow[];

    const apply = (rows: NameRow[], table: "Tag" | "TagAlias"): void => {
        const taken = new Set(rows.map((row) => `${row.scope}\t${row.nameNorm}`));
        const update = db.prepare(`UPDATE "${table}" SET "nameNorm" = ? WHERE "id" = ?`);

        for (const row of rows) {
            const next = rule(row.name);

            if (next === row.nameNorm || next === "") {
                continue;
            }

            if (taken.has(`${row.scope}\t${next}`)) {
                console.warn(
                    `[migrate] ${table} "${row.name}" keeps its stored form: "${next}" is taken`
                );
                continue;
            }

            taken.delete(`${row.scope}\t${row.nameNorm}`);
            taken.add(`${row.scope}\t${next}`);
            update.run(next, row.id);
        }
    };

    db.transaction(() => {
        apply(tags, "Tag");
        apply(aliases, "TagAlias");
    })();
};

export function up(db: Database): void {
    renormalise(db, newRule);
}

export function down(db: Database): void {
    renormalise(db, oldRule);
}
