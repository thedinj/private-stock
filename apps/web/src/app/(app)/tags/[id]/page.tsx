"use client";

import { Suspense, use } from "react";

import { TagProfile } from "@/components/tags/TagProfile";
import { useReturnCorrection } from "@/lib/useReturnCorrection";

/**
 * One tag's page (§6 "Tags").
 *
 * A dynamic segment beside `performers`, `sources`, `keywords` and `manage`: Next matches the
 * static names first, and a tag id is a UUID, so the two can never meet.
 */
const TagPage: React.FC<{ params: Promise<{ id: string }> }> = ({ params }) => {
    const { id } = use(params);

    useReturnCorrection();

    return (
        <Suspense>
            <TagProfile tagId={id} />
        </Suspense>
    );
};

export default TagPage;
