import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `next dev`, with ffmpeg findable (§13).
 *
 * Capturing a frame runs ffmpeg inside a request, so the web process has to be able to find
 * a binary. In the container that is the distro build on `PATH`. In development it is the
 * pinned `ffmpeg-static` package — and the web process is the one place that cannot reach it
 * on its own.
 *
 * The reason is worth stating, because the obvious fixes do not work. `core/server` falls
 * back to `import("ffmpeg-static")`, which is fine for the worker but not for Next: webpack
 * bundles `core` into the route, and `ffmpeg-static` locates its binary with `__dirname`,
 * which the bundler rewrites to the app directory — the same failure the Next config
 * documents for better-sqlite3. `serverExternalPackages` does not help either, because it
 * does not externalise a workspace package.
 *
 * So the path is resolved out here, by plain Node with nothing rewriting anything, and passed
 * in through the environment override that already exists for operators with a better ffmpeg.
 * Anything already set wins, so this never overrides a deliberate choice.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Resolved as `packages/core` would, because that is where the packages are declared.
 *
 * Under pnpm a dependency is only visible to the package that asks for it, so resolving from
 * this script's own directory finds nothing at all.
 */
const require = createRequire(path.join(root, "packages", "core", "package.json"));

const staticBinary = (packageName) => {
    try {
        // The package exports the path to its binary; requiring it here means `__dirname`
        // is the real directory on disk.
        const resolved = require(packageName);
        const candidate = typeof resolved === "string" ? resolved : resolved?.path;

        return typeof candidate === "string" ? candidate : null;
    } catch {
        // Absent is not an error: a developer with ffmpeg on PATH needs none of this.
        return null;
    }
};

const env = { ...process.env, NEXT_DIST_DIR: ".next-dev" };

for (const [variable, packageName] of [
    ["PRIVATE_STOCK_FFMPEG", "ffmpeg-static"],
    ["PRIVATE_STOCK_FFPROBE", "ffprobe-static"],
]) {
    if (env[variable]) {
        continue;
    }

    const binary = staticBinary(packageName);

    if (binary) {
        env[variable] = binary;
    }
}

// Said out loud, because the failure this exists to prevent was silent: capturing a frame
// returned a 500 that the page reported as nothing at all.
console.log(
    env.PRIVATE_STOCK_FFMPEG
        ? `ffmpeg for the web process: ${env.PRIVATE_STOCK_FFMPEG}`
        : "No ffmpeg found for the web process; capturing a frame will fail until one is on " +
              "PATH or PRIVATE_STOCK_FFMPEG is set"
);

/**
 * Next's own CLI entry point, run by this Node rather than through its shim.
 *
 * Spawning `next.cmd` is the obvious spelling and fails outright: since the fix for
 * CVE-2024-27980, Node refuses to spawn a `.cmd` or `.bat` without a shell, and returns
 * `EINVAL` rather than anything that names the cause. Going through a shell instead would
 * solve it by reintroducing exactly the quoting problem that change was about.
 *
 * Resolved as `apps/web` would resolve it, because that is the package that depends on Next.
 */
const webRequire = createRequire(path.join(root, "apps", "web", "package.json"));

/**
 * `--turbopack`, and the reason is navigation rather than startup (§15).
 *
 * `next.config.ts` records a measurement showing the two bundlers within noise of each other
 * once the Mantine barrel was dealt with. That measurement is honest and it answers the wrong
 * question: it timed *one* cold request to *one* route, which is dominated by process start
 * and the shared dependency graph. Dev is not one route. Every route compiles the first time
 * it is opened, and that per-route cost is what "it takes forever to click around" actually
 * is. Measured on this machine, first visit to each page of the app:
 *
 *     webpack, cache from a few sessions      4.5 - 5.0 s per route
 *     webpack, cache deleted                  1.1 - 2.3 s per route
 *     webpack, one-session-old cache          1.0 - 6.7 s per route
 *     turbopack                               0.8 - 1.1 s per route
 *
 * Recompiling after an edit is a wash -- both land around 0.3 s -- which is why this was easy
 * to miss: the loop that is measured constantly was never the slow one.
 *
 * The second line is worth reading. Webpack's filesystem cache does not simply help or not
 * help; a large one is *slower than none*, and the spread on the third line is the same
 * effect arriving unpredictably. Turbopack's numbers are the tightest of the four, and on a
 * machine where every figure here moved between runs, consistency is most of the value.
 *
 * There is a third reason, unmeasured and worth knowing: under the debugger,
 * `autoAttachChildProcesses` attaches to Next's Node compile workers. Turbopack compiles in
 * Rust and spawns none, so the inspector stops taxing compilation at all.
 */
const child = spawn(process.execPath, [webRequire.resolve("next/dist/bin/next"), "dev", "--turbopack", "--port", "8842"], {
    stdio: "inherit",
    env,
    cwd: path.join(root, "apps", "web"),
});

child.on("exit", (code, signal) => {
    // Pass the child's fate through, so Ctrl-C and a crash both look the same from turbo.
    if (signal) {
        process.kill(process.pid, signal);
    } else {
        process.exit(code ?? 0);
    }
});
