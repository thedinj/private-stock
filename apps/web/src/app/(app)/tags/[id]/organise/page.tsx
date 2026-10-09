"use client";

import { Suspense, use } from "react";

import { TagOrganise } from "@/components/tags/TagOrganise";

/**
 * Organising one tag (§6 "Tags", §5f "Starting from the performer").
 *
 * Its own route rather than a mode of the tag's page, so browsing a tag can never mount it: what
 * is asked here reads faces across the library, and the page you browse must not wait on that.
 */
const TagOrganisePage: React.FC<{ params: Promise<{ id: string }> }> = ({ params }) => {
    const { id } = use(params);

    return (
        <Suspense>
            <TagOrganise tagId={id} />
        </Suspense>
    );
};

export default TagOrganisePage;
