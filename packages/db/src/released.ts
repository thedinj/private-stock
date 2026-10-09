/**
 * Has this app ever been deployed to a database we care about keeping?
 *
 * ──────────────────────────────────────────────────────────────────────────────
 *  PRE-RELEASE  (HAS_RELEASED === false)
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * No database exists that anyone would mind losing, so migrations are pure
 * overhead. Change the schema by editing `init.ts`, then run:
 *
 *     pnpm db:baseline     # regenerate the baseline migration from init.ts
 *     pnpm db:reset        # rebuild your local database from scratch
 *
 * The migration chain stays exactly one file — the baseline — which is rewritten
 * to match `init.ts` each time. `migrationDrift.test.ts` enforces that it *is*
 * current, so forgetting `pnpm db:baseline` fails the build rather than shipping
 * a baseline that cannot recreate the schema.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 *  POST-RELEASE  (HAS_RELEASED === true)  ← we are here
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * Real databases exist on the NAS holding real ratings, tags, and clips. From
 * that point the baseline is frozen history and every schema change is a new
 * timestamped migration, because the only way an existing database reaches the
 * new schema is by replaying them.
 *
 * ### Flipping the switch — do all of this in one commit
 *
 *  1. Make the schema final for the release, then `pnpm db:baseline` one last time.
 *  2. Set `HAS_RELEASED = true` below.
 *  3. Run `pnpm test`. The drift test changes meaning: it stops checking that the
 *     baseline is regenerable and starts replaying the whole chain against
 *     `init.ts`. `pnpm db:baseline` starts refusing to run.
 *  4. From then on: migration + `init.ts` + zod schema, all three, every time.
 *
 * There is no going back — once someone's data is out there, rewriting the
 * baseline would silently strand it.
 */
export const HAS_RELEASED = true;
