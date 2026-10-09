import { redirect } from "next/navigation";

import { queryOf, type SearchParams } from "@/lib/legacyRedirect";

/**
 * OCR's review moved to the Review area and its settings and bench to Processing (§5d, §12c).
 * The old tab says which. See `lib/legacyRedirect.ts`.
 */
const OldOcrPage = async ({ searchParams }: { searchParams: SearchParams }): Promise<never> => {
    const params = await searchParams;

    if (params.tab === "settings" || params.tab === "bench") {
        redirect("/admin/processing?tab=ocr");
    }

    redirect(`/review/ocr${queryOf(params)}`);
};

export default OldOcrPage;
