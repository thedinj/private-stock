/**
 * Next's startup hook. The work is in `lib/requestLog.ts` (§20); this file only decides
 * whether to load it.
 *
 * **Keep the condition literal and the import inside it.** Next compiles this file for the
 * edge runtime as well, and it inlines `NEXT_RUNTIME` there -- so `=== "nodejs"` becomes a
 * constant false and the whole branch, import included, is dropped from the edge build. The
 * first version returned early on `!== "nodejs" || !flagged(...)` and imported the `node:`
 * modules after it. That is equally correct at runtime, but a compound condition is not
 * something the bundler folds away, so the edge build kept the imports and warned about
 * `node:diagnostics_channel` on every recompile.
 */
export const register = async (): Promise<void> => {
    if (process.env.NEXT_RUNTIME === "nodejs") {
        const { startRequestLog } = await import("./lib/requestLog");

        startRequestLog();
    }
};
