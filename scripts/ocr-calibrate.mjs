/**
 * Measure how OCR behaves on a library, without anybody having to see the library (§5d).
 *
 * The thresholds this feature needs — what confidence is worth keeping, how much of a file a
 * string has to appear in — cannot be chosen from a sample of somebody else's content. They
 * have to come from the library they will run against. And some libraries cannot be shown to
 * the person tuning them.
 *
 * So this reports **statistics and nothing else**. By default it never prints a recognised
 * string, never prints a filename, and never leaves an extracted frame behind: the output is
 * counts, distributions, timings and a threshold grid, which is safe to paste to somebody
 * helping you tune it. `--inspect` prints the actual text for your own eyes, and says so.
 *
 *   node scripts/ocr-calibrate.mjs <directory> [options]
 *
 *   --inspect          also print recognised text. Local use only; do not share the output.
 *   --files <n>        stop after n files (default: all)
 *   --granularity      word | line | both   (default: both — the open design question)
 *   --probe <n>        frames in the cheap first pass (default 6)
 *   --burst <s>        seconds of opening covered densely (default 60)
 *   --burst-every <s>  interval within the burst (default 2)
 *   --sweep-every <s>  interval for the watermark sweep (default 180)
 *   --max-frames <n>   ceiling per file (default 60)
 *   --psm <n>          Tesseract page segmentation mode (default 11, sparse text)
 *   --min-length <n>   shortest string worth keeping (default 3)
 *   --probe-floor <c>  confidence a probe reading must clear to count (default 0.4)
 *   --probe-min-frames <n>  skip the probe when the whole pass is this small (default 12)
 *   --no-absorb        do not fold fragments into their parent, so --inspect shows both
 *   --contrast         stretch contrast before recognising, for faint watermarks
 */

import { execFile, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const VIDEO = new Set([".mp4", ".mkv", ".mov", ".m4v", ".avi", ".webm", ".wmv", ".mpg", ".mpeg"]);
const IMAGE = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".avif"]);

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
    const at = argv.indexOf(`--${name}`);

    return at === -1 ? fallback : argv[at + 1];
};
const has = (name) => argv.includes(`--${name}`);

const root = argv.find((value) => !value.startsWith("--") && !argv[argv.indexOf(value) - 1]?.startsWith("--"));

const OPTIONS = {
    inspect: has("inspect"),
    files: Number(flag("files", Infinity)),
    granularity: flag("granularity", "both"),
    probe: Number(flag("probe", 6)),
    burst: Number(flag("burst", 60)),
    burstEvery: Number(flag("burst-every", 2)),
    sweepEvery: Number(flag("sweep-every", 180)),
    maxFrames: Number(flag("max-frames", 60)),
    psm: flag("psm", "11"),
    // Resolved once `ocr.js` is loaded, below: the default is the shipped floor rather than
    // a copy of it, so the harness cannot quietly measure a threshold the app does not use.
    minLength: flag("min-length", null),
    /** Confidence a probe reading must clear before it counts as "this file has text". */
    probeFloor: Number(flag("probe-floor", 0.4)),
    /** Below this many frames in the whole pass, eliminating a file saves nothing. */
    probeMinFrames: Number(flag("probe-min-frames", 12)),
    /** Run with a rule off, so `--inspect` shows what it was removing. */
    noAbsorb: has("no-absorb"),
    contrast: has("contrast"),
};

if (!root) {
    console.error("Usage: node scripts/ocr-calibrate.mjs <directory> [--inspect] [--files n]");
    process.exit(1);
}

/** ffmpeg and ffprobe the same way the app finds them: env override, then PATH, then the dev packages. */
const require_ = createRequire(path.join(process.cwd(), "packages/core/package.json"));
const binary = (envVar, pkg, key) => {
    if (process.env[envVar]) return process.env[envVar];

    try {
        const resolved = require_(pkg);

        return key ? resolved[key] : resolved;
    } catch {
        return null;
    }
};

const FFMPEG = binary("PRIVATE_STOCK_FFMPEG", "ffmpeg-static");
const FFPROBE = binary("PRIVATE_STOCK_FFPROBE", "ffprobe-static", "path");
const TESSERACT = process.env.PRIVATE_STOCK_TESSERACT ?? "tesseract";

let version = "";

try {
    version = execFileSync(TESSERACT, ["--version"], { encoding: "utf8" }).split("\n")[0].trim();
} catch {
    console.error(
        `Cannot run Tesseract as "${TESSERACT}".\n` +
            "Put it on PATH, or set PRIVATE_STOCK_TESSERACT to the executable."
    );
    process.exit(1);
}

const { reconcileText, isWorthStoring, OCR_MIN_LENGTH } = await import(
    path.join(process.cwd(), "packages/core/dist/ocr.js").replace(/\\/g, "/").replace(/^/, "file:///")
);

OPTIONS.minLength = Number(OPTIONS.minLength ?? OCR_MIN_LENGTH);

/** Every media file under a directory, depth first. Paths are never printed. */
const walk = (dir) => {
    const found = [];

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);

        if (entry.isDirectory()) found.push(...walk(full));
        else {
            const extension = path.extname(entry.name).toLowerCase();

            if (VIDEO.has(extension) || IMAGE.has(extension)) {
                found.push({ path: full, kind: VIDEO.has(extension) ? "video" : "image" });
            }
        }
    }

    return found;
};

const durationMs = async (file) => {
    try {
        const { stdout } = await execFileAsync(FFPROBE, [
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=nw=1:nk=1",
            file,
        ]);

        return Math.round(Number(stdout.trim()) * 1000) || 0;
    } catch {
        return 0;
    }
};

/**
 * Pull the frames at these positions, greyscaled and height-capped, in as few calls as
 * possible. One call per contiguous run, which is what the real handler will do.
 */
const extract = async (file, positionsMs, dir) => {
    const written = [];

    for (const [index, atMs] of positionsMs.entries()) {
        const out = path.join(dir, `f${String(index).padStart(3, "0")}.png`);

        try {
            await execFileAsync(
                FFMPEG,
                [
                    "-v", "error", "-y",
                    "-ss", (atMs / 1000).toFixed(3),
                    "-i", file,
                    "-frames:v", "1",
                    "-vf",
                    OPTIONS.contrast
                        ? // Stretched before recognition, which is the lever for a watermark
                          // nearly the same brightness as whatever is behind it.
                          "format=gray,scale='min(iw,1280)':-2,eq=contrast=1.6:brightness=0.02,unsharp=5:5:1.0"
                        : "format=gray,scale='min(iw,1280)':-2",
                    out,
                ],
                { timeout: 30_000 }
            );

            written.push({ file: out, atMs });
        } catch {
            // A frame that cannot be read is not an error worth stopping a survey for.
        }
    }

    return written;
};

/** Tesseract TSV -> observations, at word or line granularity. */
const recognise = (imageFile, atMs, granularity) => {
    let tsv = "";

    try {
        tsv = execFileSync(TESSERACT, [imageFile, "stdout", "--psm", OPTIONS.psm, "tsv"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 60_000,
        });
    } catch {
        return [];
    }

    const rows = tsv
        .split("\n")
        .slice(1)
        .map((row) => row.split("\t"))
        .filter((c) => c.length >= 12 && c[0] === "5" && c[11]?.trim() && Number(c[10]) >= 0);

    const geometry = (c) => ({
        left: Number(c[6]),
        top: Number(c[7]),
        width: Number(c[8]),
        height: Number(c[9]),
    });

    if (granularity === "word") {
        return rows.map((c) => {
            const g = geometry(c);

            return {
                atMs,
                text: c[11].trim(),
                confidence: Number(c[10]) / 100,
                box: g,
            };
        });
    }

    const lines = new Map();

    for (const c of rows) {
        const key = `${c[2]}:${c[3]}:${c[4]}`;
        const g = geometry(c);
        const entry = lines.get(key) ?? {
            words: [], confs: [], x0: Infinity, y0: Infinity, x1: 0, y1: 0,
        };

        entry.words.push(c[11].trim());
        entry.confs.push(Number(c[10]) / 100);
        entry.x0 = Math.min(entry.x0, g.left);
        entry.y0 = Math.min(entry.y0, g.top);
        entry.x1 = Math.max(entry.x1, g.left + g.width);
        entry.y1 = Math.max(entry.y1, g.top + g.height);
        lines.set(key, entry);
    }

    return [...lines.values()].map((e) => ({
        atMs,
        text: e.words.join(" "),
        confidence: e.confs.reduce((a, b) => a + b, 0) / e.confs.length,
        box: { left: e.x0, top: e.y0, width: e.x1 - e.x0, height: e.y1 - e.y0 },
    }));
};

/**
 * Pixel boxes to fractions of the frame.
 *
 * A survey has no single frame size, so each file is normalised against its own extent. Used
 * by the survey and by the probe, which has to judge corroboration the same way the survey
 * would or it is answering a different question from the one it gates.
 */
const asFractions = (observed) => {
    const maxX = Math.max(1, ...observed.map((o) => o.box.left + o.box.width));
    const maxY = Math.max(1, ...observed.map((o) => o.box.top + o.box.height));

    return observed.map((o) => ({
        atMs: o.atMs,
        text: o.text,
        confidence: o.confidence,
        box: {
            x: o.box.left / maxX,
            y: o.box.top / maxY,
            w: o.box.width / maxX,
            h: o.box.height / maxY,
        },
    }));
};

/**
 * A file's findings, reduced to the two numbers that decide anything.
 *
 * `best` is ranked by confidence *times* stability rather than by stability alone: a cluster
 * read at zero confidence in two of twenty frames is not a file's strongest finding, and
 * reporting it as one hid what the strongest actually was.
 *
 * `notable` counts everything that would survive the thresholds a real run would apply --
 * **including the length floor, whichever variant is being counted**. Without that the
 * comparison is rigged: the floor is a pure post-election filter, so switching it off can only
 * add short clusters and can never alter a longer one, and a count that admits those short
 * clusters reports the floor as having deleted a finding on essentially every file. It cried
 * wolf on five of six and drowned out the one flag that meant something.
 *
 * Counting the set the same way for every variant leaves each rule judged on what it can
 * actually do: the floor provably cannot remove a string of three characters or more, while
 * absorption can remove a cluster of any length at all.
 */
const summarise = (rows) => {
    const ranked = [...rows].sort((a, b) => b.confidence * b.stability - a.confidence * a.stability);

    return {
        best: ranked[0] ?? null,
        notable: rows.filter(
            (row) => isWorthStoring(row) && row.text.trim().length >= OPTIONS.minLength
        ).length,
    };
};

/** Frame positions for the three passes the design calls for. */
const probePositions = (duration) =>
    duration === 0
        ? [0]
        : Array.from({ length: OPTIONS.probe }, (_, i) =>
              i < OPTIONS.probe / 2
                  ? Math.round((30_000 / Math.ceil(OPTIONS.probe / 2)) * i)
                  : Math.round((duration / (OPTIONS.probe + 1)) * (i + 1))
          ).filter((at) => at < duration);

const burstPositions = (duration) => {
    const end = Math.min(duration, OPTIONS.burst * 1000);

    return Array.from(
        { length: Math.floor(end / (OPTIONS.burstEvery * 1000)) },
        (_, i) => i * OPTIONS.burstEvery * 1000
    );
};

const sweepPositions = (duration) =>
    Array.from(
        { length: Math.max(0, Math.floor(duration / (OPTIONS.sweepEvery * 1000))) },
        (_, i) => (i + 1) * OPTIONS.sweepEvery * 1000
    ).filter((at) => at < duration);

// ── the survey ───────────────────────────────────────────────────────────────────────────

const files = walk(root).slice(0, OPTIONS.files);
const granularities = OPTIONS.granularity === "both" ? ["word", "line"] : [OPTIONS.granularity];

const stats = Object.fromEntries(
    granularities.map((g) => [
        g,
        {
            clusters: [],
            filesWithAny: 0,
            withoutLength: 0,
            withoutAbsorb: 0,
        },
    ])
);

/** One summary row per file, in survey order. Never a name -- an index and numbers. */
const perFileSummary = [];
let framesSampled = 0;
let recogniseMs = 0;
let stoppedAtProbe = 0;
const startedAt = Date.now();

const workDir = mkdtempSync(path.join(tmpdir(), "ps-ocr-"));

try {
    for (const [index, entry] of files.entries()) {
        process.stderr.write(`\r  ${index + 1}/${files.length} files…    `);

        const duration = entry.kind === "video" ? await durationMs(entry.path) : 0;
        const perFile = { word: [], line: [] };

        const run = async (positions) => {
            const frames = await extract(entry.path, positions, workDir);

            framesSampled += frames.length;

            for (const frame of frames) {
                for (const granularity of granularities) {
                    const began = Date.now();
                    const observed = recognise(frame.file, frame.atMs, granularity);

                    recogniseMs += Date.now() - began;
                    perFile[granularity].push(...observed);
                }
            }

            for (const frame of frames) rmSync(frame.file, { force: true });

            return frames.length;
        };

        const probeAt = probePositions(duration);
        const restAt =
            entry.kind === "video" ? [...burstPositions(duration), ...sweepPositions(duration)] : [];

        /**
         * A probe only pays for itself on a file that has frames to save.
         *
         * Eliminating a ten-second clip saves one frame and can cost the whole file: its
         * complete pass is barely longer than the probe. Measured -- a file whose entire
         * survey was four frames was thrown away by a gate that existed to avoid spending
         * thirty on it.
         */
        const worthProbing = probeAt.length + restAt.length > OPTIONS.probeMinFrames;

        const probeFrames = await run(probeAt);

        /**
         * "Did the probe find text" is not "did the probe find anything" -- and it is not
         * "did one frame read it confidently" either.
         *
         * Recognition returns something from almost any frame, so a probe that accepts any
         * observation never rejects a file. But the first fix for that went too far the other
         * way: requiring a single frame to clear a confidence floor contradicts the claim the
         * rest of the design rests on, which is that per-frame confidence is unreliable and
         * *recurrence* is the signal. A faint watermark read at 0.31 in every frame is
         * exactly the file this feature is for, and the floor alone discards it unexamined.
         *
         * So either answer keeps the file: one confident reading, or anything at all that
         * showed up twice in the same place.
         */
        const probeSaysText = (observed) =>
            observed.some(
                (o) =>
                    o.confidence >= OPTIONS.probeFloor &&
                    o.text.trim().length >= OPTIONS.minLength
            ) ||
            reconcileText(asFractions(observed), Math.max(1, probeFrames), {
                minLength: OPTIONS.minLength,
            }).some((row) => row.occurrences >= 2);

        const probeFound =
            !worthProbing || granularities.some((g) => probeSaysText(perFile[g]));

        let total = probeFrames;

        if (!probeFound) {
            stoppedAtProbe += 1;
        } else if (entry.kind === "video") {
            total += await run(restAt.slice(0, Math.max(0, OPTIONS.maxFrames - probeFrames)));
        }

        for (const granularity of granularities) {
            const observations = asFractions(perFile[granularity]);

            const framesFor = Math.max(1, total);

            const rows = reconcileText(observations, framesFor, {
                minLength: OPTIONS.minLength,
                absorb: !OPTIONS.noAbsorb,
            });

            /**
             * The same observations judged with each rule switched off.
             *
             * Reconciliation is pure and cheap next to recognition -- the frames are already
             * extracted and read -- so every run can afford to answer "which rule cost me
             * this?" instead of leaving it to be guessed at from two reports taken days
             * apart. Without this a change that loses a real watermark and a change that
             * removes noise look identical from here: both are a smaller number.
             */
            const withoutLength = reconcileText(observations, framesFor, { minLength: 1 });
            const withoutAbsorb = reconcileText(observations, framesFor, {
                minLength: OPTIONS.minLength,
                absorb: false,
            });

            if (rows.length > 0) stats[granularity].filesWithAny += 1;
            stats[granularity].clusters.push(...rows);
            stats[granularity].withoutLength += withoutLength.length;
            stats[granularity].withoutAbsorb += withoutAbsorb.length;

            if (granularity === granularities[0]) {
                perFileSummary.push({
                    frames: total,
                    clusters: rows.length,
                    eliminated: !probeFound,
                    ...summarise(rows),
                    notableWithoutLength: summarise(withoutLength).notable,
                    notableWithoutAbsorb: summarise(withoutAbsorb).notable,
                });
            }

            if (OPTIONS.inspect && granularity === granularities[0] && rows.length > 0) {
                console.log(`\n[inspect] ${path.basename(entry.path)}`);
                for (const row of rows.slice(0, 20)) {
                    console.log(
                        `    stab ${row.stability.toFixed(2)} conf ${row.confidence.toFixed(2)}` +
                            ` x${String(row.occurrences).padStart(2)}` +
                            ` @${row.box.x.toFixed(2)},${row.box.y.toFixed(2)}` +
                            `  ${JSON.stringify(row.text)}`
                    );
                }
            }
        }
    }
} finally {
    rmSync(workDir, { recursive: true, force: true });
}

process.stderr.write("\r".padEnd(40) + "\r");

// ── the report ───────────────────────────────────────────────────────────────────────────

const pct = (part, whole) => (whole === 0 ? "  0%" : `${String(Math.round((part / whole) * 100)).padStart(3)}%`);

const histogram = (values, edges, label) => {
    const counts = edges.map(() => 0);

    for (const value of values) {
        const bucket = edges.findIndex((edge, i) => value < edge || i === edges.length - 1);

        counts[Math.max(0, bucket)] += 1;
    }

    console.log(`\n  ${label}`);
    edges.forEach((edge, i) => {
        const from = i === 0 ? 0 : edges[i - 1];
        const bar = "#".repeat(Math.round((counts[i] / Math.max(1, values.length)) * 40));

        console.log(
            `    ${from.toFixed(2)}–${edge.toFixed(2)}  ${String(counts[i]).padStart(6)}  ${bar}`
        );
    });
};

/** Character make-up, which separates noise from text without disclosing either. */
const shape = (text) => {
    const letters = (text.match(/[a-z]/gi) ?? []).length;
    const digits = (text.match(/[0-9]/g) ?? []).length;
    const other = text.length - letters - digits;

    if (other > text.length / 2) return "mostly punctuation";
    if (letters > text.length * 0.7) return "mostly letters";
    if (digits > text.length * 0.7) return "mostly digits";

    return "mixed";
};

console.log(`\nprivate-stock OCR calibration`);
console.log(`  engine        ${version}`);
console.log(`  files         ${files.length}`);
console.log(`  frames        ${framesSampled} sampled`);
console.log(
    `  cost          ${(recogniseMs / Math.max(1, framesSampled)).toFixed(0)} ms/frame recognising` +
        `, ${((Date.now() - startedAt) / 1000).toFixed(0)}s wall clock`
);
console.log(
    `  settings      psm ${OPTIONS.psm}, probe ${OPTIONS.probe} @ conf>=${OPTIONS.probeFloor}, ` +
        `burst ${OPTIONS.burst}s/${OPTIONS.burstEvery}s, sweep ${OPTIONS.sweepEvery}s, ` +
        `cap ${OPTIONS.maxFrames}, min length ${OPTIONS.minLength}` +
        `${OPTIONS.contrast ? ", contrast on" : ""}`
);
console.log(
    `    went on to the later passes     ${String(files.length - stoppedAtProbe).padStart(6)}  ${pct(files.length - stoppedAtProbe, files.length)} of files`
);

/**
 * What each judgement costs, per file.
 *
 * The aggregate histograms below cannot answer the only question that matters when a run
 * looks worse than the last one: *which file lost its watermark, and to which rule?* Pooled
 * across a library, a rule that deletes one real finding and a rule that deletes four hundred
 * noise clusters both read as "fewer clusters".
 *
 * So each file reports its strongest cluster, and reports it again with each rule switched
 * off. A rule that is working leaves the strongest cluster alone and removes the tail; a rule
 * that is costing a detection shows up as a file whose best cluster is better without it.
 */
const describeBest = (best) =>
    best === null
        ? "        --          "
        : `${best.stability.toFixed(2)}  ${best.confidence.toFixed(2)}  ` +
          `${String(best.text.length).padStart(3)}`;

/** Did switching a rule off leave this file with findings it does not have now? */
const improved = (notable, without) => without > notable;

console.log(`
── what each rule costs (${granularities[0]} granularity) ${"─".repeat(20)}`);
console.log(
    `  clusters kept ${String(stats[granularities[0]].clusters.length).padStart(6)}` +
        `   without min length ${String(stats[granularities[0]].withoutLength).padStart(6)}` +
        `   without absorption ${String(stats[granularities[0]].withoutAbsorb).padStart(6)}`
);
console.log(`
  strongest cluster per file    stab  conf  len   worth reporting`);

for (const [index, file] of perFileSummary.entries()) {
    const flags = [
        improved(file.notable, file.notableWithoutLength) ? "min-length" : "",
        improved(file.notable, file.notableWithoutAbsorb) ? "absorption" : "",
        file.eliminated ? "PROBE STOPPED IT" : "",
    ].filter(Boolean);

    console.log(
        `    file ${String(index + 1).padStart(2)}  ` +
            `${String(file.frames).padStart(3)} frames  ` +
            `${String(file.clusters).padStart(4)} clusters   ` +
            `${describeBest(file.best)}` +
            `${String(file.notable).padStart(8)}` +
            `${flags.length > 0 ? `   ${flags.join(", ")}` : ""}`
    );
}

for (const granularity of granularities) {
    const { clusters, filesWithAny } = stats[granularity];

    console.log(`\n── ${granularity} granularity ${"─".repeat(Math.max(0, 50 - granularity.length))}`);
    console.log(`  clusters      ${clusters.length}`);
    console.log(`  files with >=1 ${filesWithAny}  (${pct(filesWithAny, files.length)})`);

    if (clusters.length === 0) continue;

    histogram(clusters.map((c) => c.confidence), [0.2, 0.4, 0.6, 0.8, 1.01], "confidence");
    histogram(clusters.map((c) => c.stability), [0.1, 0.25, 0.5, 0.75, 1.01], "stability");

    const sizes = { "1": 0, "2": 0, "3–4": 0, "5+": 0 };

    for (const c of clusters) {
        if (c.occurrences === 1) sizes["1"] += 1;
        else if (c.occurrences === 2) sizes["2"] += 1;
        else if (c.occurrences <= 4) sizes["3–4"] += 1;
        else sizes["5+"] += 1;
    }

    console.log(`\n  frames corroborating a cluster`);
    for (const [label, count] of Object.entries(sizes)) {
        console.log(`    ${label.padEnd(10)} ${String(count).padStart(6)}  ${pct(count, clusters.length)}`);
    }

    const lengths = { "1–2": 0, "3–5": 0, "6–10": 0, "11–20": 0, "21+": 0 };

    for (const c of clusters) {
        const n = c.text.length;

        if (n <= 2) lengths["1–2"] += 1;
        else if (n <= 5) lengths["3–5"] += 1;
        else if (n <= 10) lengths["6–10"] += 1;
        else if (n <= 20) lengths["11–20"] += 1;
        else lengths["21+"] += 1;
    }

    console.log(`\n  length of the elected string`);
    for (const [label, count] of Object.entries(lengths)) {
        console.log(`    ${label.padEnd(10)} ${String(count).padStart(6)}  ${pct(count, clusters.length)}`);
    }

    const shapes = {};

    for (const c of clusters) shapes[shape(c.text)] = (shapes[shape(c.text)] ?? 0) + 1;

    console.log(`\n  character make-up`);
    for (const [label, count] of Object.entries(shapes).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${label.padEnd(20)} ${String(count).padStart(6)}  ${pct(count, clusters.length)}`);
    }

    console.log(`\n  what survives a threshold pair  (clusters kept)`);
    const stabilities = [0.1, 0.2, 0.3, 0.5];

    console.log(`                 ${stabilities.map((s) => `stab>=${s.toFixed(2)}`).join("  ")}`);

    for (const confidence of [0.4, 0.5, 0.6, 0.7, 0.8]) {
        const cells = stabilities.map((stability) => {
            const kept = clusters.filter(
                (c) => c.confidence >= confidence && c.stability >= stability
            ).length;

            return String(kept).padStart(10);
        });

        console.log(`    conf>=${confidence.toFixed(2)}  ${cells.join("  ")}`);
    }

    /**
     * The same question asked with occurrences instead of stability, because stability is the
     * wrong gate for *storage*.
     *
     * Stability is occurrences over frames sampled, so the identical piece of evidence scores
     * differently depending on how long the file is: a title card read in two frames scores
     * 0.20 on a ten-minute item and 0.03 on a feature. Gating on it discards real text for a
     * reason that has nothing to do with the text. It is the right number for *ranking* --
     * that is how a permanent watermark separates from a card -- and the wrong one for
     * deciding whether a row exists at all.
     */
    console.log(
        `
  kept by the shipped rule  ${clusters.filter(isWorthStoring).length}` +
            ` of ${clusters.length}`
    );
    console.log(`
  what would be stored  (clusters kept)`);
    const counts = [1, 2, 3, 5];

    console.log(`                 ${counts.map((n) => ` seen>=${n}`).join("  ")}`);

    for (const confidence of [0.4, 0.5, 0.6, 0.7, 0.8]) {
        const cells = counts.map((n) =>
            String(
                clusters.filter((c) => c.confidence >= confidence && c.occurrences >= n).length
            ).padStart(8)
        );

        console.log(`    conf>=${confidence.toFixed(2)}  ${cells.join("  ")}`);
    }
}

console.log(
    `\n  This report contains no recognised text and no filenames.` +
        `${OPTIONS.inspect ? "\n  --inspect was on, so the lines above marked [inspect] DO contain text. Do not share those." : ""}\n`
);
