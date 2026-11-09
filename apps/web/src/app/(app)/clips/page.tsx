import { redirect } from "next/navigation";

import type { SearchParams } from "@/lib/legacyRedirect";

/**
 * Clips are a library tab now (§14e "What a kind is", 2026-11-08). The old browser's address is
 * read into the library's spelling, so a bookmark or a reel's "find more" link arrives with its
 * search and filters.
 *
 * "Video has" has no exact counterpart -- the library's tag picks are the clip's own, widened to
 * its video by one switch -- so those picks become ordinary picks with the switch on, which finds
 * a superset rather than nothing.
 */
const SORTS: Record<string, string> = { created: "addedAt", label: "title", duration: "duration" };

const one = (value: string | string[] | undefined): string | undefined =>
    Array.isArray(value) ? value[0] : value;

const OldClipsPage = async ({ searchParams }: { searchParams: SearchParams }): Promise<never> => {
    const params = await searchParams;
    const query = new URLSearchParams({ view: "grid", kind: "clip" });
    const clipTags = one(params.ct)?.split(",").filter(Boolean) ?? [];
    const videoTags = one(params.vt)?.split(",").filter(Boolean) ?? [];
    const tags = [...clipTags, ...videoTags];
    const notTags = [
        ...(one(params.cnt)?.split(",") ?? []),
        ...(one(params.vnt)?.split(",") ?? []),
    ].filter(Boolean);

    if (one(params.q)) query.set("search", one(params.q) ?? "");
    if (tags.length > 0) query.set("tags", tags.join(","));
    if (notTags.length > 0) query.set("notTags", notTags.join(","));
    if (videoTags.length > 0 || one(params.orv)) query.set("orVideo", "1");
    if (one(params.unused)) query.set("unused", "1");
    if (one(params.af)) query.set("addedFrom", one(params.af) ?? "");
    if (one(params.at)) query.set("addedTo", one(params.at) ?? "");

    const sort = SORTS[one(params.sort) ?? ""];

    if (sort && sort !== "addedAt") query.set("sort", sort);

    redirect(`/?${query.toString()}`);
};

export default OldClipsPage;
