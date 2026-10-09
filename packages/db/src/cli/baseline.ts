/**
 * `pnpm db:baseline` — regenerate the baseline migration from `init.ts`.
 *
 * Pre-release only. After the release switch is flipped the baseline is frozen
 * history and rewriting it would strand every database already built from it, so
 * this refuses to run rather than asking for confirmation.
 */

import { writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { BASELINE_PATH, generateBaseline } from "../baseline.js";
import { HAS_RELEASED } from "../released.js";

if (HAS_RELEASED) {
    console.error(
        [
            "Refusing to regenerate the baseline: HAS_RELEASED is true.",
            "",
            "Databases exist that were built from this baseline, and rewriting it would",
            "leave them unable to reach the new schema. Write a timestamped migration in",
            "src/migrations/ instead, and update init.ts to match.",
        ].join("\n")
    );
    process.exit(1);
}

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const target = path.join(packageRoot, BASELINE_PATH);

writeFileSync(target, generateBaseline(), "utf8");

console.log(`✓ Regenerated ${BASELINE_PATH}`);
console.log("  Run `pnpm format` if the generated file needs reformatting.");
