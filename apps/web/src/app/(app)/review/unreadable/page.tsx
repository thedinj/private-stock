"use client";

import { Suspense, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Anchor, Stack, Text } from "@mantine/core";

import { PagePlate } from "@/components/shell/PagePlate";
import { UnreadableSheet } from "@/components/unreadable/UnreadableSheet";
import { useUnreadable } from "@/lib/api/unreadable";
import { defineView, enumField, useUrlView } from "@/lib/urlView";

/**
 * Unreadable files (§10g): what the probe could not read, and giving their space back.
 *
 * Beside OCR in the Review area, and built the same way -- a plate, then a long list worked
 * through with ticks. One list: the files still in the library. Moving one to the trash frees
 * the media volume; purging it is the trash's business, where "Unreadable only" narrows the bin
 * to these. That second half used to be a tab here -- a copy of the trash with its own purge.
 */
const unreadableView = defineView("/review/unreadable", {
    // Only read, to send an old "In the trash" address on to where that list now lives.
    tab: enumField("tab", ["library", "trash"], "library"),
});

const UnreadableReview: React.FC = () => {
    const router = useRouter();
    const [view] = useUrlView(unreadableView);
    const library = useUnreadable("library");
    // The plate's count is the list's own summary; the trash side's is one small page.
    const trash = useUnreadable("trash");

    useEffect(() => {
        if (view.tab === "trash") {
            router.replace("/review/trash?filter=unreadable");
        }
    }, [view.tab, router]);

    const count = library.data?.pages[0]?.summary.count;
    const inTrash = trash.data?.pages[0]?.summary.count ?? 0;

    return (
        <Stack gap="lg">
            <PagePlate
                eyebrow={
                    count === undefined
                        ? "Files nothing can be made from"
                        : count === 0
                          ? "Nothing unreadable"
                          : `${count.toLocaleString()} ${count === 1 ? "file" : "files"} cannot be read`
                }
                title="Unreadable files"
                lede="Files the probe could not open, usually downloads that never finished. They cannot be played and still take their full size on disk."
            />

            <UnreadableSheet tab="library" />

            {inTrash > 0 && (
                <Text size="sm" c="dimmed">
                    <Anchor
                        component={Link}
                        href="/review/trash?filter=unreadable"
                        prefetch={false}
                    >
                        {inTrash.toLocaleString()} unreadable{" "}
                        {inTrash === 1 ? "file is" : "files are"} in the trash →
                    </Anchor>
                </Text>
            )}
        </Stack>
    );
};

/** `useUrlView` reads the search parameters, which Next requires to sit under a boundary. */
const UnreadablePage: React.FC = () => (
    <Suspense>
        <UnreadableReview />
    </Suspense>
);

export default UnreadablePage;
