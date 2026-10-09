"use client";

import { Suspense } from "react";

import { TagBrowsePage } from "@/components/tags/TagBrowsePage";

/** The people in the library, each with a strip of what they are in (§6 "Tags"). */
const PerformersPage: React.FC = () => (
    <Suspense>
        <TagBrowsePage
            kind="performer"
            eyebrow="Tags"
            title="Performers"
            sections={[
                {
                    scope: "public",
                    empty: "Nobody has been tagged yet. Add a performer on any item's page.",
                },
            ]}
        />
    </Suspense>
);

export default PerformersPage;
