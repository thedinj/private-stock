"use client";

import Link from "next/link";
import { Button, Drawer, Stack, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";

import type { FaceReviewFace } from "@private-stock/core";

import { ReleasingVideo } from "@/components/media/ReleasingVideo";
import { itemHref } from "@/lib/lookMoment";
import { useCloseOnBack } from "@/lib/useCloseOnBack";

import { FileName } from "./FileName";

/** A second before the face, so it is seen arriving. */
const LEAD_MS = 1_000;

/**
 * An item played beside the review rather than instead of it (§5f "Checking faces quickly"):
 * for the face a closer look could not settle. Closing it returns to the row as it was — the
 * ticks are the list's, not this drawer's. "Open the full item" leaves the review; the ticks are
 * kept for the visit, so coming back finds them.
 */
export const FaceViewDrawer: React.FC<{
    face: FaceReviewFace | null;
    onClose: () => void;
    /** What is kept while it plays; a review's ticks unless said otherwise. */
    note?: string;
}> = ({ face, onClose, note = "Your ticks stay as they are while you look." }) => {
    const isPhone = useMediaQuery("(max-width: 48em)");
    const src = face ? `/api/media/${encodeURIComponent(face.mediaId)}/stream` : "";

    // Back closes it, not the review under it; and a pinch zooms, for a watermark OCR missed.
    useCloseOnBack(face !== null, onClose);

    return (
        <Drawer
            opened={face !== null}
            onClose={onClose}
            position={isPhone ? "bottom" : "right"}
            size={isPhone ? "85%" : "xl"}
            // The file it is, named: the title can be a scraped one.
            title={face ? <FileName mediaId={face.mediaId} /> : "The item"}
            removeScrollProps={{ allowPinchZoom: true }}
        >
            {face && (
                <Stack gap="sm">
                    {face.kind === "video" ? (
                        <ReleasingVideo
                            key={`${face.mediaId}:${face.atMs ?? 0}`}
                            src={src}
                            controls
                            autoPlay
                            // Autoplay is allowed only muted; the controls unmute it.
                            muted
                            playsInline
                            style={{
                                width: "100%",
                                borderRadius: 6,
                                background: "var(--mantine-color-black)",
                            }}
                            onLoadedMetadata={(event) => {
                                event.currentTarget.currentTime =
                                    Math.max(0, (face.atMs ?? 0) - LEAD_MS) / 1000;
                            }}
                        />
                    ) : (
                        // eslint-disable-next-line @next/next/no-img-element -- an original, served as it is
                        <img src={src} alt="The item" style={{ width: "100%", borderRadius: 6 }} />
                    )}
                    <Text size="xs" c="dimmed">
                        {note}
                    </Text>
                    <Button
                        component={Link}
                        href={itemHref(face.mediaId, face.atMs)}
                        prefetch={false}
                        variant="subtle"
                        color="gray"
                        style={{ alignSelf: "flex-start" }}
                    >
                        Open the full item
                    </Button>
                </Stack>
            )}
        </Drawer>
    );
};
