export {
    db,
    getDb,
    openDatabase,
    applyPragmas,
    checkpointWal,
    isBusyError,
    withBusyTimeout,
    type Db,
} from "./db.js";
export { HAS_RELEASED } from "./released.js";
export * from "./repos/index.js";
export { generateBaseline, renderSchemaSql, BASELINE_PATH } from "./baseline.js";
export { initializeDatabase } from "./init.js";
/**
 * The migration runner is deliberately NOT re-exported here.
 *
 * It loads migration files through a computed `import()`, which a bundler cannot analyse
 * statically — pulling it into the Next build produces a "Critical dependency: the request
 * of a dependency is an expression" warning and drags the whole `migrations/` directory into
 * the server bundle for no reason. Nothing in the web app runs migrations; the CLI does, and
 * it imports `./migrate` directly.
 */
