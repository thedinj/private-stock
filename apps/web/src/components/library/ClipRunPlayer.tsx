"use client";

import { Center, Loader, Modal, Text } from "@mantine/core";

import { LoadFailed } from "@/components/LoadFailed";
import { ReelPlayer } from "@/components/reel/ReelPlayer";
import { useLibraryClipRun } from "@/lib/api/libraryTabs";
import type { LibraryView } from "@/lib/libraryQuery";
import { useCloseOnBack } from "@/lib/useCloseOnBack";

interface ClipRunPlayerProps {
    view: LibraryView;
    onClose: () => void;
}

/**
 * The Clips tab played from the top (§14e "Playing the small kinds").
 *
 * An unsaved reel: the tab's clips in the tab's order, through the reel player, so the joins are
 * a reel's -- the next span warmed at its in point, unplayable ones skipped and said so, nothing
 * recorded as watched. Bounded as a reel is, and says so when the tab holds more.
 */
export const ClipRunPlayer: React.FC<ClipRunPlayerProps> = ({ view, onClose }) => {
    const run = useLibraryClipRun(view, true);

    // A phone's Back closes the player rather than leaving the library behind it.
    useCloseOnBack(true, onClose);

    return (
        <Modal
            opened
            onClose={onClose}
            size="xl"
            title={
                <Text size="sm">
                    Your clips, from the top
                    {run.data?.more && (
                        <Text span size="sm" c="dimmed">
                            {" "}
                            · the first {run.data.items.length}
                        </Text>
                    )}
                </Text>
            }
        >
            {run.isPending ? (
                <Center h={240}>
                    <Loader size="sm" />
                </Center>
            ) : run.isError ? (
                <LoadFailed error={run.error} onRetry={() => void run.refetch()} />
            ) : (
                <ReelPlayer entries={run.data.items} runningMs={run.data.runningMs} />
            )}
        </Modal>
    );
};
