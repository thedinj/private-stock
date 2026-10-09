import { mediaRootRepo } from "@private-stock/db";

import { scanRoot } from "../scan/scanner.js";
import type { JobRow } from "../queue.js";

/**
 * The `scan` job.
 *
 * Three shapes, narrowest first:
 *
 *   - `{ rootId, subPath }` — one directory, which is what a filesystem event queues.
 *   - `{ rootId }` — one whole root, the admin's "Scan now".
 *   - `{}` — every enabled root, the periodic safety net.
 */
export const runScan = async (job: JobRow): Promise<void> => {
    const payload = job.payloadJson
        ? (JSON.parse(job.payloadJson) as { rootId?: string; subPath?: string; force?: boolean })
        : {};

    const roots = payload.rootId
        ? [mediaRootRepo.findById(payload.rootId)].filter((root) => root !== undefined)
        : mediaRootRepo.listEnabledRoots();

    for (const root of roots) {
        if (!root.enabled) {
            continue;
        }

        const counts = await scanRoot(root, { subPath: payload.subPath, force: payload.force });
        const scope = payload.subPath ? `${root.label}/${payload.subPath}` : root.label;
        const mode = payload.force ? " (forced)" : "";

        console.log(
            `Scanned ${scope}${mode}: ${counts.filesSeen} seen, ${counts.filesAdded} added, ` +
                `${counts.filesChanged} changed, ${counts.filesMissing} missing`
        );
    }
};
