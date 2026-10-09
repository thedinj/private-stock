"use client";

import { Suspense } from "react";

import { TagBrowsePage } from "@/components/tags/TagBrowsePage";

/** Where things came from, each with a strip of what came from there (§6 "Tags"). */
const SourcesPage: React.FC = () => (
    <Suspense>
        <TagBrowsePage
            kind="source"
            eyebrow="Tags"
            title="Sources"
            sections={[
                {
                    scope: "public",
                    empty: "No sources yet. Add one on any item's page.",
                },
            ]}
        />
    </Suspense>
);

export default SourcesPage;
