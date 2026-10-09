/**
 * Which build is running, as `next.config.ts` baked it in.
 *
 * Read through `process.env.NEXT_PUBLIC_*` written out in full, because that literal is what
 * Next replaces at build time; a computed key would be undefined in the browser.
 *
 * The same values are inlined into the server's bundle and the browser's, so the two sides of
 * one build agree on `id`, and a page left open across a deploy does not (`useBuildCheck`).
 */
const sha = process.env.NEXT_PUBLIC_BUILD_SHA ?? "unknown";
const date = process.env.NEXT_PUBLIC_BUILD_DATE ?? "";

export const buildInfo = {
    /** The short commit, with `-wip` when the tree it was built from had uncommitted changes. */
    sha,
    /** ISO 8601, or empty when nobody said. */
    date,
    /**
     * One build, exactly. The sha alone is not enough: two `-wip` builds share it, and so does
     * a rebuild of one commit.
     */
    id: `${sha}@${date}`,
} as const;
