/**
 * Download the models in models/manifest.json and verify each against its pinned sha256 (§5e).
 *
 *   node scripts/fetch-models.mjs          # or: pnpm models:fetch
 *
 * Idempotent: a file already present with the right size and checksum is left alone, so this is
 * safe to run on every build. The Docker image runs it in a stage of its own, keyed on the
 * manifest, so the models are downloaded once per manifest change rather than once per build.
 *
 * A download goes to `<file>.partial` and is renamed only after its checksum matches. A file that
 * fails verification is deleted and the script exits non-zero: a model that is not the one the
 * manifest names is not a model the app should load, and the place to find that out is here, not
 * as quietly different search results.
 */

import { createHash } from "node:crypto";
import {
    createReadStream,
    createWriteStream,
    existsSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
} from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const MODELS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "models");
const { models } = JSON.parse(readFileSync(path.join(MODELS_DIR, "manifest.json"), "utf8"));

const sha256Of = async (file) => {
    const hash = createHash("sha256");

    await pipeline(createReadStream(file), hash);

    return hash.digest("hex");
};

const megabytes = (bytes) => `${(bytes / 1e6).toFixed(0)} MB`;

let failed = false;

for (const model of models) {
    const target = path.join(MODELS_DIR, model.file);

    if (existsSync(target) && statSync(target).size === model.bytes) {
        if ((await sha256Of(target)) === model.sha256) {
            console.log(`  ok    ${model.id}`);
            continue;
        }

        console.log(`  stale ${model.id}: checksum differs, downloading again`);
    }

    const partial = `${target}.partial`;
    const response = await fetch(model.url);

    if (!response.ok || !response.body) {
        console.error(`  FAIL  ${model.id}: HTTP ${response.status} from ${model.url}`);
        failed = true;
        continue;
    }

    process.stdout.write(`  get   ${model.id} (${megabytes(model.bytes)})… `);

    const hash = createHash("sha256");
    const body = Readable.fromWeb(response.body);

    body.on("data", (chunk) => hash.update(chunk));
    await pipeline(body, createWriteStream(partial));

    const digest = hash.digest("hex");

    if (digest !== model.sha256) {
        rmSync(partial, { force: true });
        console.log("checksum mismatch");
        console.error(`        expected ${model.sha256}\n        got      ${digest}`);
        failed = true;
        continue;
    }

    renameSync(partial, target);
    console.log("verified");
}

process.exit(failed ? 1 : 0);
