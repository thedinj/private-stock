import { redirect } from "next/navigation";

import { queryOf, type SearchParams } from "@/lib/legacyRedirect";

/**
 * Moved to the Review area (§12c); its "In the trash" tab is now the trash's "Unreadable only"
 * filter. See `lib/legacyRedirect.ts`.
 */
const OldUnreadablePage = async ({
    searchParams,
}: {
    searchParams: SearchParams;
}): Promise<never> => {
    const params = await searchParams;

    if (params.tab === "trash") {
        redirect("/review/trash?filter=unreadable");
    }

    redirect(`/review/unreadable${queryOf(params, ["tab"])}`);
};

export default OldUnreadablePage;
