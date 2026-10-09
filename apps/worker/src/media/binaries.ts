/**
 * Where ffmpeg and ffprobe are.
 *
 * Re-exported rather than implemented here: the web app needs the same answer now that a
 * capture is extracted inside a request (§13), and two copies of "find ffmpeg" would drift
 * the moment one of them learned about a new environment. The implementation is in
 * `@private-stock/core/server`; this keeps the ten call sites in the worker reading as they
 * always have.
 */
export { resolveFfmpeg, resolveFfprobe } from "@private-stock/core/server";
