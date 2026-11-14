/**
 * `pnpm dev:test-account` — a sign-in and a harmless library for checking work on the dev server.
 *
 * Made so an assistant (or anybody) can sign in to `pnpm dev` and look at what changed without
 * using a real account or looking at the real library. Each run:
 *
 *  1. creates the account `claude-test@example.test` if it is missing -- no scopes, so not an
 *     administrator and unable to delete -- and gives it a **fresh random password**, written to
 *     `.dev/test-account.json` at the workspace root (git-ignored) and nowhere else;
 *  2. generates a few test-pattern videos and pictures with ffmpeg into `media/claude-test`
 *     (git-ignored), once;
 *  3. registers that folder as a library in the **family** room -- the room a browser opens on --
 *     and queues a scan, which the worker from `pnpm dev` picks up.
 *
 * **Development only.** It refuses under `NODE_ENV=production`, and refuses unless the database
 * is inside this checkout (a git work tree), which the container's `/data` never is.
 *
 * Per-library access is not built yet, so the account can still reach every library in the dev
 * database. The test patterns are in the family room so there is a room to work in that holds
 * nothing else.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import bcrypt from "bcryptjs";

import { findWorkspaceRoot, loadConfig, resolveFfmpeg } from "@private-stock/core/server";

const EMAIL = "claude-test@example.test";
const DISPLAY_NAME = "Claude (test)";
const FOLDER = "claude-test";
const LABEL = "Test patterns";

/**
 * Each is ffmpeg's own synthetic source: nothing here was ever filmed.
 *
 * The last four exist for the editor export (§14d): a reel cut across them has the mixed frame
 * rates, the start timecode and the MPEG-TS container that real footage brings to Resolve.
 * `args` replaces the MP4 muxer options for a source that needs others.
 */
const VIDEOS: { name: string; source: string; seconds: number; args?: string[] }[] = [
    { name: "Colour bars.mp4", source: "smptehdbars=s=1280x720:r=30", seconds: 40 },
    { name: "Test card.mp4", source: "testsrc2=s=1280x720:r=30", seconds: 60 },
    { name: "Mandelbrot zoom.mp4", source: "mandelbrot=s=1280x720:r=30", seconds: 30 },
    { name: "Life.mp4", source: "life=s=640x360:r=15:mold=10:ratio=0.2", seconds: 45 },
    {
        name: "Gradient (portrait).mp4",
        source: "gradients=s=720x1280:r=30:speed=0.05",
        seconds: 25,
    },
    { name: "Counter 25 fps.mp4", source: "testsrc=s=1280x720:r=25", seconds: 30 },
    { name: "Counter 29.97 fps.mp4", source: "testsrc=s=1920x1080:r=30000/1001", seconds: 30 },
    { name: "Counter 60 fps.mp4", source: "testsrc=s=1280x720:r=60", seconds: 30 },
    {
        name: "Counter with timecode.mp4",
        source: "testsrc=s=1280x720:r=25",
        seconds: 30,
        args: ["-timecode", "01:00:00:00", "-movflags", "+faststart"],
    },
    {
        name: "Counter MPEG-TS.ts",
        source: "testsrc2=s=1280x720:r=30",
        seconds: 30,
        args: ["-f", "mpegts"],
    },
];

const PICTURES: { name: string; source: string }[] = [
    { name: "Bars.png", source: "smptebars=s=1600x900" },
    { name: "Card.png", source: "testsrc=s=1600x1200" },
    { name: "Fractal.png", source: "mandelbrot=s=1200x1600" },
];

const refuse = (why: string): never => {
    console.error(`✗ ${why}`);
    process.exit(1);
};

const generate = async (folder: string): Promise<number> => {
    const ffmpeg = await resolveFfmpeg();
    let made = 0;

    mkdirSync(folder, { recursive: true });

    for (const video of VIDEOS) {
        const out = path.join(folder, video.name);

        if (existsSync(out)) continue;

        // H.264 + AAC in MP4 with the index at the front: plays in any browser as it stands, so
        // nothing waits on a transcode before a clip can be played.
        execFileSync(ffmpeg, [
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            video.source,
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-t",
            String(video.seconds),
            ...(video.args ?? ["-movflags", "+faststart"]),
            out,
        ]);
        made += 1;
    }

    for (const picture of PICTURES) {
        const out = path.join(folder, picture.name);

        if (existsSync(out)) continue;

        execFileSync(ffmpeg, [
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            picture.source,
            "-frames:v",
            "1",
            out,
        ]);
        made += 1;
    }

    return made;
};

const main = async (): Promise<void> => {
    if (process.env.NODE_ENV === "production") {
        refuse("Refusing to run with NODE_ENV=production: this is for the dev server only.");
    }

    const root = findWorkspaceRoot();
    const config = loadConfig();
    const inCheckout = path.relative(root, config.dataDir);

    if (inCheckout.startsWith("..") || path.isAbsolute(inCheckout)) {
        refuse(`Refusing: the database (${config.dataDir}) is not inside this checkout.`);
    }

    if (!existsSync(path.join(root, ".git"))) {
        refuse(`Refusing: ${root} is not a git checkout, so this may not be a dev machine.`);
    }

    // Imported only now: opening the database is a side effect of loading the package.
    const { jobRepo, mediaRootRepo, userRepo } = await import("@private-stock/db");

    const password = randomBytes(18).toString("base64url");
    const hash = await bcrypt.hash(password, 12);
    const existing = userRepo.findByEmail(EMAIL);
    const user =
        existing ??
        userRepo.createUser({
            email: EMAIL,
            displayName: DISPLAY_NAME,
            passwordHash: hash,
            scopes: "",
        });

    if (existing) userRepo.setPassword(existing.id, hash);

    const credentialsDir = path.join(root, ".dev");

    mkdirSync(credentialsDir, { recursive: true });
    writeFileSync(
        path.join(credentialsDir, "test-account.json"),
        `${JSON.stringify({ email: EMAIL, password, userId: user.id }, null, 4)}\n`,
        { mode: 0o600 }
    );

    const folder = path.join(config.mediaDir, FOLDER);
    const made = await generate(folder);
    const library =
        mediaRootRepo.findByPath(folder) ?? mediaRootRepo.create(folder, LABEL, "family");

    // A library starts disabled; this one is only ever made to be used.
    if (!library.enabled) mediaRootRepo.setEnabled(library.id, true);

    jobRepo.enqueueRootScan(library.id);

    console.log(`✓ ${existing ? "Reset the password of" : "Created"} ${EMAIL}`);
    console.log(
        `  Credentials: ${path.relative(root, path.join(credentialsDir, "test-account.json"))}`
    );
    console.log(`✓ ${made} test file(s) made in ${path.relative(root, folder)}`);
    console.log(`✓ Library "${library.label}" (family room) queued for a scan`);
    console.log("  The worker from `pnpm dev` picks the scan up within seconds.");
};

void main();
