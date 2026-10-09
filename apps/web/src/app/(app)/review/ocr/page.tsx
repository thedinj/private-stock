"use client";

import { Suspense } from "react";
import Link from "next/link";
import { Button, Stack, Tabs } from "@mantine/core";

import { reviewMedia } from "@private-stock/core";

import { OcrQueueSheet } from "@/components/ocr/OcrQueueSheet";
import { OcrRuleLog } from "@/components/ocr/OcrRuleLog";
import { OcrRuleSheet } from "@/components/ocr/OcrRuleSheet";
import { ReviewKindFilter } from "@/components/review/ReviewKindFilter";
import { PagePlate } from "@/components/shell/PagePlate";
import { useOcrCounts } from "@/lib/api/ocr";
import { defineView, enumField, textField, useUrlSearch, useUrlView } from "@/lib/urlView";

/**
 * OCR (§5d "Tagging performers and sources from what was read"): which items' text names a
 * performer or source, so the library's names keep up as new items are read.
 *
 * - **To tag** is the queue: items with a name nobody has decided about, newest first. Tagging one
 *   makes the pair a rule, so the queue only ever holds what is new. It opens on videos; photos
 *   are behind its kind control, since they are the exception in this collection.
 * - **Tagged for you** is what rules tagged by themselves, for checking them.
 * - **Rules** is every decision by its text, for withdrawing one.
 *
 * Correcting or dismissing the text itself is done from an item's details, where it is read. How
 * OCR reads — its settings, the test bench and the tuner — is on Processing › OCR, linked from
 * the header.
 *
 * Everything is in the address except the scroll position, so opening an item and coming back
 * returns to the same list.
 */
const ocrView = defineView("/review/ocr", {
    tab: enumField("tab", ["queue", "auto", "rules"], "queue"),
    match: enumField("match", ["accepted", "rejected"], "accepted"),
    q: textField("q"),
    media: enumField("media", reviewMedia, "video"),
});

const OcrReview: React.FC = () => {
    const [view, apply] = useUrlView(ocrView);
    const counts = useOcrCounts();
    const [searchText, setSearchText] = useUrlSearch(view.q, (q) => apply({ q }));

    const byMedia = counts.data?.waiting;
    const waiting =
        byMedia && (view.media === "all" ? byMedia.video + byMedia.image : byMedia[view.media]);

    return (
        <Stack gap="lg">
            <PagePlate
                eyebrow={
                    waiting === undefined
                        ? "Review"
                        : waiting === 0
                          ? "Nothing to tag"
                          : `${waiting.toLocaleString()} ${waiting === 1 ? "item" : "items"} to tag`
                }
                title="OCR"
                actions={
                    <Button
                        component={Link}
                        prefetch={false}
                        href="/admin/processing?tab=ocr"
                        variant="default"
                    >
                        OCR settings
                    </Button>
                }
            />

            <Tabs
                value={view.tab}
                onChange={(value) =>
                    value &&
                    apply({ tab: ocrView.parse(new URLSearchParams({ tab: value })).tab, q: "" })
                }
                color="brass"
                // Each sheet binds its keys to the window, so only the one on screen may exist.
                keepMounted={false}
            >
                <Tabs.List mb="lg">
                    <Tabs.Tab value="queue">
                        To tag
                        {waiting ? ` · ${waiting.toLocaleString()}` : ""}
                    </Tabs.Tab>
                    <Tabs.Tab value="auto">Tagged for you</Tabs.Tab>
                    <Tabs.Tab value="rules">Rules</Tabs.Tab>
                </Tabs.List>

                <Tabs.Panel value="queue">
                    <Stack gap="md">
                        <ReviewKindFilter
                            value={view.media}
                            onChange={(media) => apply({ media })}
                            counts={byMedia}
                        />
                        <OcrQueueSheet media={view.media} />
                    </Stack>
                </Tabs.Panel>

                <Tabs.Panel value="auto">
                    <OcrRuleLog />
                </Tabs.Panel>

                <Tabs.Panel value="rules">
                    <OcrRuleSheet
                        filters={{ status: view.match, search: view.q }}
                        onFilters={(next) => apply(next.status ? { match: next.status } : {})}
                        searchText={searchText}
                        onSearchText={setSearchText}
                    />
                </Tabs.Panel>
            </Tabs>
        </Stack>
    );
};

/** `useUrlView` reads the search parameters, which Next requires to sit under a boundary. */
const OcrPage: React.FC = () => (
    <Suspense>
        <OcrReview />
    </Suspense>
);

export default OcrPage;
