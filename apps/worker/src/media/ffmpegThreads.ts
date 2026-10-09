import { threadsPerJob } from "../throttle.js";

/**
 * Hold one ffmpeg invocation to the threads its job has a slot for (§7c, §20).
 *
 * ffmpeg has no single thread setting. Decoders take `-threads` as an input option, encoders as
 * an output option, and filtergraphs have pools of their own; leave any of them out and that
 * stage sizes itself from every core the container can see. So this places all of them:
 *
 * - the two filter pools, as global options at the front;
 * - `-threads` before every `-i`, for that input's decoder;
 * - `-threads` before the last argument, which is the output file in every invocation this
 *   worker makes — one output, named last.
 *
 * Applied to the argument list rather than written into each call site so that a new
 * invocation gets the same treatment by wrapping its list, and cannot cap its encoder while
 * forgetting its decoder.
 */
export const capThreads = (args: string[], threads: number = threadsPerJob()): string[] => {
    // `-threads 0` means "every core" to ffmpeg, so a zero here would uncap rather than cap.
    const count = String(Math.max(1, Math.floor(threads)));
    const output = args.length - 1;
    const capped = ["-filter_threads", count, "-filter_complex_threads", count];

    args.forEach((arg, index) => {
        if (arg === "-i" || index === output) {
            capped.push("-threads", count);
        }

        capped.push(arg);
    });

    return capped;
};
