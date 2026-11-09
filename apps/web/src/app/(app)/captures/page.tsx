import { redirect } from "next/navigation";

import type { SearchParams } from "@/lib/legacyRedirect";

/**
 * Captures are the library's Stills tab now (§14e "What a kind is", 2026-11-08). The old page's
 * search carries over; its other fields were a sort and a layout the tab has its own of.
 */
const OldCapturesPage = async ({
    searchParams,
}: {
    searchParams: SearchParams;
}): Promise<never> => {
    const params = await searchParams;
    const query = new URLSearchParams({ view: "grid", kind: "capture" });
    const search = Array.isArray(params.q) ? params.q[0] : params.q;

    if (search) query.set("search", search);

    redirect(`/?${query.toString()}`);
};

export default OldCapturesPage;
