"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import type { LibraryListResponse } from "@private-stock/core";

import { SectionHead } from "@/components/library/LibraryRoom";
import { ClipCard } from "@/components/media/ClipCard";
import { ClipViewer } from "@/components/media/ClipViewer";
import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/queryKeys";
import { GRID_GAP, GRID_TRACKS } from "@/lib/gridGeometry";

/** A row's worth: one shelf, as the item shelves above it are. */
const SHELF_CLIPS = 12;

/**
 * Your clips carrying this tag, on its page (§14e "What a kind is").
 *
 * The clip's own tags, as the Clips tab reads them, newest first. Its own request, under the
 * library's prefix, so tagging a clip anywhere refreshes it; absent when you have none, since
 * an empty shelf says nothing the counts above do not.
 */
export const TagClipsShelf: React.FC<{ tagId: string }> = ({ tagId }) => {
    const params = new URLSearchParams({ kind: "clip", tags: tagId, limit: String(SHELF_CLIPS) });
    const { data } = useQuery({
        queryKey: queryKeys.media.libraryPage(`shelf:${params.toString()}`, 0),
        queryFn: () => api<LibraryListResponse>(`/api/library?${params.toString()}`),
    });
    const [watching, setWatching] = useState<string | null>(null);

    const clips = (data?.items ?? []).flatMap((entry) =>
        entry.type === "clip" ? [entry.clip] : []
    );
    const index = clips.findIndex((clip) => clip.id === watching);

    if (clips.length === 0) {
        return null;
    }

    return (
        <div>
            <SectionHead
                title="Your clips"
                href={`/?view=grid&kind=clip&tags=${encodeURIComponent(tagId)}`}
            />
            <div style={{ display: "grid", gridTemplateColumns: GRID_TRACKS, gap: GRID_GAP }}>
                {clips.map((clip) => (
                    <ClipCard
                        key={clip.id}
                        clip={clip}
                        // A shelf is for looking and playing; ticking is the Clips tab's.
                        selected={false}
                        onToggle={() => setWatching(clip.id)}
                        onPlay={() => setWatching(clip.id)}
                        square={false}
                        showSource={false}
                    />
                ))}
            </div>

            {index >= 0 && (
                <ClipViewer
                    clip={clips[index]}
                    onClose={() => setWatching(null)}
                    onPrevious={index > 0 ? () => setWatching(clips[index - 1].id) : undefined}
                    onNext={
                        index < clips.length - 1
                            ? () => setWatching(clips[index + 1].id)
                            : undefined
                    }
                />
            )}
        </div>
    );
};
