"use client";

import { Suspense } from "react";

import { TagBrowsePage } from "@/components/tags/TagBrowsePage";

/**
 * Keywords: private, then shared (§6 "Tags").
 *
 * The one facet that can be private, so the one page with two lists. Yours first -- the words
 * you made for yourself are the ones you came here for -- and left out entirely when you have
 * none, rather than announcing an absence above the list that has something in it.
 */
const KeywordsPage: React.FC = () => (
    <Suspense>
        <TagBrowsePage
            kind="tag"
            eyebrow="Tags"
            title="Keywords"
            sections={[
                { scope: "private", heading: "Private", empty: null },
                {
                    scope: "public",
                    heading: "Shared",
                    empty: "The library has no keywords yet. Add one on any item's page.",
                },
            ]}
        />
    </Suspense>
);

export default KeywordsPage;
