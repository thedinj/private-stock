"use client";

import { Suspense } from "react";
import { Stack, Tabs } from "@mantine/core";

import { FailedJobsCard } from "@/components/admin/FailedJobsCard";
import { PlaybackCheckCard } from "@/components/admin/PlaybackCheckCard";
import { ProcessingProgress, useProcessingStatus } from "@/components/admin/ProcessingProgress";
import { QuietHoursCard } from "@/components/admin/QuietHoursCard";
import { StagesCard } from "@/components/admin/StagesCard";
import { TranscodeQueueCard } from "@/components/admin/TranscodeQueueCard";
import { TranscodingCard } from "@/components/admin/TranscodingCard";
import { useProcessingPauseControl } from "@/components/admin/useProcessingPauseControl";
import { OcrConfigPanel } from "@/components/ocr/OcrConfigPanel";
import { PagePlate } from "@/components/shell/PagePlate";
import { useProcessingPause } from "@/lib/api/processing";
import { defineView, enumField, useUrlView } from "@/lib/urlView";

/**
 * Processing (§7, §13c): what is done to the files, and whether it is healthy.
 *
 * Everything about the pipeline on one page. It used to be four cards scattered down the admin
 * page -- a pause switch, a progress card, the stage switches and the quiet hours -- with three
 * near-identical names and the people and invitations between them; OCR's switch was on one
 * page and the rest of its settings on another, and transcoding had a card of its own.
 *
 * The header is the page's state and its one kill switch, on every tab. The tabs are how it is
 * going, what runs, and the two stages with enough settings to need a tab of their own.
 */
const processingView = defineView("/admin/processing", {
    tab: enumField("tab", ["activity", "stages", "ocr", "transcoding"], "activity"),
});

const ProcessingTabs: React.FC = () => {
    const [view, apply] = useUrlView(processingView);
    const { data: status } = useProcessingStatus();
    const { data: pause } = useProcessingPause();
    const pauseControl = useProcessingPauseControl();

    const outstanding = status ? status.queue.pending + status.queue.claimed : null;
    const eyebrow = pause?.paused
        ? "Paused"
        : outstanding === null
          ? "Admin"
          : outstanding === 0
            ? "Up to date"
            : `${outstanding.toLocaleString()} queued`;

    return (
        <Stack gap="lg">
            <PagePlate
                eyebrow={eyebrow}
                title="Processing"
                actions={pauseControl.button}
                lede={pauseControl.note}
            />

            <Tabs
                value={view.tab}
                onChange={(value) =>
                    value &&
                    apply({ tab: processingView.parse(new URLSearchParams({ tab: value })).tab })
                }
                color="brass"
                keepMounted={false}
            >
                <Tabs.List mb="lg">
                    <Tabs.Tab value="activity">Activity</Tabs.Tab>
                    <Tabs.Tab value="stages">Stages</Tabs.Tab>
                    <Tabs.Tab value="ocr">OCR</Tabs.Tab>
                    <Tabs.Tab value="transcoding">Transcoding</Tabs.Tab>
                </Tabs.List>

                <Tabs.Panel value="activity">
                    <Stack gap="lg" maw={860}>
                        <ProcessingProgress />
                        <FailedJobsCard />
                    </Stack>
                </Tabs.Panel>

                <Tabs.Panel value="stages">
                    <Stack gap="lg" maw={860}>
                        <StagesCard />
                        <QuietHoursCard />
                    </Stack>
                </Tabs.Panel>

                <Tabs.Panel value="ocr">
                    <OcrConfigPanel />
                </Tabs.Panel>

                <Tabs.Panel value="transcoding">
                    <Stack gap="lg" maw={860}>
                        <TranscodingCard />
                        <TranscodeQueueCard />
                        <PlaybackCheckCard />
                    </Stack>
                </Tabs.Panel>
            </Tabs>
        </Stack>
    );
};

/** `useUrlView` reads the search parameters, which Next requires to sit under a boundary. */
const ProcessingPage: React.FC = () => (
    <Suspense>
        <ProcessingTabs />
    </Suspense>
);

export default ProcessingPage;
