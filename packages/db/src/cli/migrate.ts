/**
 * `pnpm db:migrate` / `pnpm db:migrate:rollback`
 *
 * Also the path the container entrypoint takes on boot, after snapshotting the database.
 */

import { db } from "../db.js";
import { rollbackLastMigration, runMigrations } from "../migrate.js";

const command = process.argv[2];

const run = command === "rollback" ? rollbackLastMigration : runMigrations;

run(db)
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(
            command === "rollback" ? "Migration rollback failed:" : "Migration failed:",
            error
        );
        process.exit(1);
    });
