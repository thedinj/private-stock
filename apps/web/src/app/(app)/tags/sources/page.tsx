"use client";

import { Suspense } from "react";

import { TagBrowsePage } from "@/components/tags/TagBrowsePage";
import { facetLabelPlural } from "@/lib/facetLabels";

/** Where things came from, each with a strip of what came from there (§6 "Tags"). */
const SourcesPage: React.FC = () => (
    <Suspense>
        <TagBrowsePage
            kind="source"
            eyebrow="Tags"
            title={facetLabelPlural("source")}
            sections={[
                {
                    scope: "public",
                    empty: `No ${facetLabelPlural("source").toLowerCase()} yet. Add one on any item's page.`,
                },
            ]}
        />
    </Suspense>
);

export default SourcesPage;
