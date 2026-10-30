import { execSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { NextConfig } from "next";

/**
 * The workspace root, for file tracing.
 *
 * `new URL("../../", import.meta.url).pathname` looks equivalent and is not: on Windows it
 * yields "/D:/Users/..." with a leading slash, which is not a valid path. Next then fails to
 * emit the standalone output at all — silently, with a successful build — and the Docker
 * image ends up missing its server. `fileURLToPath` is the only correct conversion.
 */
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * `standalone` output is what keeps the runtime image small — only traced dependencies get
 * copied, rather than the whole node_modules tree (§15).
 *
 * `serverExternalPackages` keeps the database layer out of the bundler. better-sqlite3 is a
 * native addon whose `bindings` helper locates `better_sqlite3.node` by walking up from
 * `__dirname`; once webpack rewrites `__dirname` to the app directory, that search fails with
 * a dozen wrong paths and the route reports the database unreachable at runtime.
 *
 * `@private-stock/db` has to be listed alongside it. It is a workspace package, so Next
 * transpiles it and would otherwise pull its `better-sqlite3` import back into the bundle
 * through the back door — externalising only the leaf is not enough.
 *
 * There is a second half to this, in `package.json`: because an externalised import becomes a
 * runtime `require`, better-sqlite3 must be resolvable from `apps/web`. Under pnpm's strict
 * node_modules it is not, unless this app declares it — a transitive dependency of
 * `@private-stock/db` is deliberately invisible here. So `apps/web` lists better-sqlite3 as a
 * direct dependency even though no file in it imports the package by name.
 *
 * `onnxruntime-node` is the same case (§5e). `@private-stock/core/server` imports it lazily, and
 * every route that imports core/server for anything else would otherwise have webpack try to
 * parse its `.node` binaries, one per platform; and it is a direct dependency here for the same
 * runtime-`require` reason.
 */
/**
 * Standalone output is for the container only, and is opt-in via `BUILD_STANDALONE=1`
 * (set in `docker/Dockerfile`).
 *
 * Producing it on a Windows dev box needs symlink permission that a normal account does not
 * have, so the build fills with `EPERM: operation not permitted, symlink` warnings, emits an
 * incomplete tree, and breaks `next start`. None of that applies in the Linux image, which is
 * the only place the standalone tree is actually used.
 */
/**
 * Content Security Policy (§12).
 *
 * `'unsafe-inline'` on scripts and styles is a real weakness and a deliberate one for now:
 * Next inlines its own bootstrap and Mantine injects styles at runtime, so removing it needs
 * nonce plumbing through the document — which is the UI rewrite's work, not this one's. What
 * is here still closes the cheap holes: nothing loads from another origin, no plugins run, no
 * injected `<base>` can redirect relative URLs, and the app cannot be framed.
 *
 * The Cast sender SDK (§11) is the one script from another origin: Google ships it only from
 * `https://www.gstatic.com`, as a loader that pulls in the framework from the same place. It
 * talks to the TV through the browser's own media router, not over the network, so nothing else
 * here widens for it. `connect-src` must stay wide enough for the SSE change feed (§13b), which
 * is same-origin and so is already covered.
 *
 * `'unsafe-eval'` is development only. React's dev build and Fast Refresh evaluate strings;
 * nothing in a production build does, and granting it there turns any injected string that
 * reaches an `eval`-shaped sink into script for no benefit.
 */
const SCRIPT_SRC =
    process.env.NODE_ENV === "development"
        ? "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://www.gstatic.com"
        : "script-src 'self' 'unsafe-inline' https://www.gstatic.com";

const CONTENT_SECURITY_POLICY = [
    "default-src 'self'",
    SCRIPT_SRC,
    "style-src 'self' 'unsafe-inline'",
    // blob: is how a canvas-captured cover frame is previewed before it is uploaded (§9).
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
].join("; ");

/**
 * Headers every response carries (§12).
 *
 * Set here rather than in the reverse proxy so they hold however the app is reached — the
 * LAN-first deployment has no proxy at all, and a security header that only exists in a
 * config file somebody else owns is a security header that is missing half the time.
 */
const securityHeaders = [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    {
        /**
         * The strictest referrer policy there is, and this app needs it.
         *
         * A signed media URL carries its token in the query string (§12d). Any weaker policy
         * sends that whole URL to whatever a page links out to, handing a third party a day's
         * access to the item.
         */
        key: "Referrer-Policy",
        value: "no-referrer",
    },
    { key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
    {
        // Nothing here uses any of them, and a compromised dependency should not be able to.
        key: "Permissions-Policy",
        value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
    },
];

/**
 * HSTS, only where it can be honoured.
 *
 * Deliberately conditional. Sent to a browser that reached the app over plain HTTP on a LAN,
 * this would pin the hostname to HTTPS for a year — and since that deployment has no
 * certificate, the app would become unreachable from that browser with no way to undo it
 * short of clearing site data. The `has` condition means it is sent only to a request a
 * trusted proxy has already told us arrived over TLS.
 *
 * No `preload`, and no `includeSubDomains` — this is somebody's own domain, very likely a
 * DDNS hostname shared with other services, and neither is ours to decide for it.
 */
const STRICT_TRANSPORT_SECURITY = "max-age=31536000";

/**
 * API responses are never stored by the browser, or by anything between it and us (§12).
 *
 * Route handlers get no `Cache-Control` from Next at all, and "no header and no validator means
 * nothing caches it" is a heuristic, not a rule — a CDN told to cache everything, or a proxy
 * added later, would serve one user's library to another. This makes it explicit.
 *
 * **The exclusions are not optional, and the header cannot simply be set here and overridden
 * in the route.** Next copies a route's headers onto the response only where the config has
 * not already set one, so a route's own `Cache-Control` loses silently to this line. The art,
 * stream and tag picture routes set real cache lifetimes, the picture dialogue's still a short
 * private one, and the change feed sets its own no-cache, so all five are excluded by path.
 * `apiCachePolicy.test.ts` fails if a route sets its own policy without being listed here.
 */
const API_NO_STORE_SOURCE =
    "/api/:path((?!art/|events$|media/[^/]+/stream$|media/[^/]+/still$|tags/[^/]+/picture$).*)";

/**
 * Which build this is, for the About dialog.
 *
 * Baked in at build time, because the container has no repository to ask: `.dockerignore`
 * leaves `.git` out of the context, so `docker/ship.sh` -- which already works out the sha for
 * the image tag -- passes it in as `BUILD_SHA` and `BUILD_DATE`. A build on the dev box asks git
 * directly, and marks a tree with uncommitted changes the way the image tag does.
 */
const git = (command: string): string | null => {
    try {
        return execSync(`git ${command}`, {
            cwd: workspaceRoot,
            stdio: ["ignore", "pipe", "ignore"],
        })
            .toString()
            .trim();
    } catch {
        return null;
    }
};

const buildSha = (): string => {
    if (process.env.BUILD_SHA) return process.env.BUILD_SHA;

    const sha = git("rev-parse --short HEAD");

    if (sha === null) return "unknown";

    return git("status --porcelain --untracked-files=no") === "" ? sha : `${sha}-wip`;
};

/**
 * The build's timestamp, settled once per build.
 *
 * Written back into the environment because the build evaluates this file more than once —
 * its compiler workers each load it — and they inherit the environment from the process that
 * loaded it first. A fresh `new Date()` per evaluation would give the server and the browser
 * different stamps for one build, and the update check (`useBuildCheck`) compares exactly those
 * two: a page would reload once for an update that never happened.
 */
process.env.BUILD_DATE ||= new Date().toISOString();

const nextConfig: NextConfig = {
    env: {
        NEXT_PUBLIC_BUILD_SHA: buildSha(),
        NEXT_PUBLIC_BUILD_DATE: process.env.BUILD_DATE,
    },
    async headers() {
        return [
            { source: "/:path*", headers: securityHeaders },
            {
                source: API_NO_STORE_SOURCE,
                headers: [{ key: "Cache-Control", value: "private, no-store" }],
            },
            {
                source: "/:path*",
                has: [{ type: "header", key: "x-forwarded-proto", value: "https" }],
                headers: [{ key: "Strict-Transport-Security", value: STRICT_TRANSPORT_SECURITY }],
            },
        ];
    },

    /**
     * Dev and production builds must not share an output directory.
     *
     * `next dev` continuously rewrites `.next`, so a `next build` or `next start` running
     * against the same folder reads chunks that are being deleted underneath it. The symptom
     * is bewildering rather than obvious: Next fails to load an App Router chunk, falls back
     * to the Pages Router `_document`, and reports
     *
     *     Error: <Html> should not be imported outside of pages/_document
     *
     * naming a file this project does not contain. `pnpm dev` therefore sets
     * NEXT_DIST_DIR=.next-dev and builds keep `.next` to themselves, so running the app and
     * building it at the same time is safe — which matters in a monorepo where `pnpm build`
     * at the root is routine.
     */
    distDir: process.env.NEXT_DIST_DIR || ".next",
    output: process.env.BUILD_STANDALONE === "1" ? "standalone" : undefined,
    outputFileTracingRoot: workspaceRoot,
    /**
     * onnxruntime-node's binding is traced, but the shared library it loads beside it is not:
     * `onnxruntime_binding.node` is found through a template path, and `libonnxruntime.so.1` is
     * opened by the dynamic linker, which no tracer can see. Without the include the image would
     * carry a binding that fails to load the first time somebody searches by look (§5e).
     *
     * The template path also drags in the macOS and Windows builds, 190 MB of them, and
     * `outputFileTracingExcludes` does not reach the per-route traces that list them — tried
     * with both relative and `**` globs. The Dockerfile's build stage deletes them instead.
     */
    outputFileTracingIncludes: {
        "/**": [
            "../../node_modules/.pnpm/onnxruntime-node@*/node_modules/onnxruntime-node/bin/napi-v6/linux/**/*",
        ],
    },
    serverExternalPackages: ["better-sqlite3", "@private-stock/db", "onnxruntime-node"],
    reactStrictMode: true,
    /**
     * Stop one `import { Button }` from compiling the whole of Mantine.
     *
     * `@mantine/core` is a barrel over 590 modules, and 38 files here import from it. Dev
     * does not tree-shake, so every route that touches a single component pulled all 590 in
     * — which is what made `next dev` feel broken rather than slow. Measured cold on this
     * machine, first request to `/login`:
     *
     *     webpack, as it was            21.3 s
     *     webpack, with this            6.2 s
     *     turbopack, without this       10.4 s
     *     turbopack, with this          6.1 s
     *
     * Worth reading twice, because the obvious fix is the wrong one: `--turbopack` alone is
     * half of what this line does. The barrel was the problem, not webpack.
     *
     * **"Within noise of each other" was true of this measurement and false of dev as a
     * whole.** It timed one cold request to one route, where process start and the shared
     * graph dominate. Every *subsequent* route compiles on first open too, and there webpack
     * costs two to five times what turbopack does — which is why `scripts/dev-web.mjs` passes
     * `--turbopack` and records the per-route figures.
     *
     * `experimental`, but not really: Next applies this to about thirty packages by default
     * and has since 14 — Mantine is simply not one of them. Listed here are the two that are
     * actually imported; `@mantine/form` and `@mantine/spotlight` are dependencies with no
     * importers at all, and naming them would be a claim that something uses them.
     */
    experimental: {
        optimizePackageImports: ["@mantine/core", "@mantine/hooks"],
    },
    eslint: {
        ignoreDuringBuilds: false,
    },
};

export default nextConfig;
