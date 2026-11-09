"use client";

import { useQuery } from "@tanstack/react-query";

import type { LibraryListResponse } from "@private-stock/core";

import { SectionHead } from "@/components/library/LibraryRoom";
import { ClipCard } from "@/components/media/ClipCard";
import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/queryKeys";
import { useOpenClip } from "@/lib/clipPage";
import { DEFAULT_VIEW } from "@/lib/libraryQuery";
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
    const openClip = useOpenClip();
    // Opening one carries on through this tag's clips, as the Clips tab filtered to it would.
    const open = (clipId: string) =>
        openClip(clipId, { ...DEFAULT_VIEW, mode: "grid", kind: "clip", tags: [tagId] });

    const clips = (data?.items ?? []).flatMap((entry) =>
        entry.type === "clip" ? [entry.clip] : []
    );

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
                        onToggle={() => open(clip.id)}
                        onPlay={() => open(clip.id)}
                        square={false}
                        showSource={false}
                    />
                ))}
            </div>
        </div>
    );
};
