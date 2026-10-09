"use client";

import { use } from "react";

import { PlaylistDetail } from "@/components/playlist/PlaylistDetail";
import { useReturnCorrection } from "@/lib/useReturnCorrection";

/**
 * One playlist.
 *
 * Its own route rather than a mode of the library, because a playlist is not a query: it has
 * no filters to narrow and no sort to choose, and its order is a thing somebody arranged
 * rather than something the server can derive. What it shares with the library is the grid
 * and the tiles, which are components rather than a page.
 */
const PlaylistPage: React.FC<{ params: Promise<{ id: string }> }> = ({ params }) => {
    const { id } = use(params);

    useReturnCorrection();

    return <PlaylistDetail playlistId={id} />;
};

export default PlaylistPage;
