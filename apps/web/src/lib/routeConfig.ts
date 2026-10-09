/**
 * Route configuration — **must be copied literally into every route, not imported.**
 *
 * Next's caching is the real footgun in this app, not its streaming (§2 of ARCHITECTURE.md).
 * A cached media route serves stale bytes; a cached API route serves another user's library.
 *
 * The obvious fix — a shared module every route re-exports — does not work. Next reads these
 * fields by statically analysing the route file, so a re-export is silently ignored:
 *
 *     ⚠ Next.js can't recognize the exported `dynamic` field in "/api/health/route",
 *       it may be re-exported from another file. The default config will be used instead.
 *
 * "The default config will be used instead" is the dangerous part: the build succeeds, the
 * route looks configured, and the caching you thought you disabled is still on. So paste
 * this block verbatim at the top of every route handler under `app/api/`:
 *
 *     export const dynamic = "force-dynamic";
 *     export const revalidate = 0;
 *     export const runtime = "nodejs";
 *     export const fetchCache = "force-no-store";
 *
 * `runtime = "nodejs"` is not optional: better-sqlite3, ffmpeg subprocesses, and
 * `fs.createReadStream` range serving all require it, and the edge runtime has none of them.
 *
 * The constant below exists only so the string is greppable and this explanation has a home.
 */
export const ROUTE_CONFIG_SNIPPET = `export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const fetchCache = "force-no-store";` as const;
