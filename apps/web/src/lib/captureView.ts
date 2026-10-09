import { captureSorts } from "@private-stock/core";

import {
    defineView,
    directionField,
    enumField,
    flagField,
    pageField,
    textField,
    type ViewOf,
} from "./urlView";

/**
 * The Captures page's view, as it lives in the URL (§14b, §20: a page is an address).
 *
 * Sort, search, page and grouping are all in the address, so reloading, sharing and the back
 * button return to the same page of the same list. Defaults are left out, so the page's plain
 * address stays `/captures`.
 */
const fields = {
    sort: enumField("sort", captureSorts, "created"),
    /** Null means the sort's natural direction. */
    direction: directionField("dir"),
    search: textField("q"),
    page: pageField(),
    /** One list rather than grouped by the video each capture came from, which is the default. */
    flat: flagField("flat"),
};

export const captureView = defineView("/captures", fields);

export type CaptureView = ViewOf<typeof fields>;
