import type { BulkActionResult } from "@private-stock/core";

/** A count that reads as a sentence rather than a label. */
export const describeBulkResult = (result: BulkActionResult): string => {
    const done = `${result.succeeded} item${result.succeeded === 1 ? "" : "s"} updated`;

    return result.failed.length === 0
        ? done
        : `${done}. ${result.failed.length} could not be: ${result.failed[0].reason}`;
};
