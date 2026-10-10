"use client";

import { Suspense } from "react";
import { Stack, Tabs } from "@mantine/core";

import { reviewMedia } from "@private-stock/core";

import { AutoTagSheet } from "@/components/faces/AutoTagSheet";
import { FaceReviewSheet } from "@/components/faces/FaceReviewSheet";
import { PagePlate } from "@/components/shell/PagePlate";
import { defineView, enumField, textField, useUrlView } from "@/lib/urlView";

/**
 * Faces (§5f "One review, two sources"): the face groups with something to decide, across the
 * library. A performer's own page is where their face is confirmed; this is for the rest.
 *
 * - **Matches**: groups that are, or might be, a performer, on items not tagged with them yet.
 * - **Unnamed**: "Who is this?" — the largest groups no performer is proposed for.
 * - **Would tag**: what faces would tag by themselves, checked before they are allowed to, and
 *   the switch that allows them.
 * - **Tagged for you**: what they tagged, to take back what is wrong.
 *
 * Matches and Unnamed open on faces in videos; photos are behind their kind control, since they
 * are the exception in this collection. Would tag and Tagged for you have no such control: the
 * first is a fair sample of what the rule would do, and narrowing it would no longer be one.
 */
const facesView = defineView("/review/faces", {
    tab: enumField("tab", ["matches", "unnamed", "wouldTag", "taggedForYou"], "matches"),
    // A performer's page links here narrowed to them.
    performer: textField("performer"),
    media: enumField("media", reviewMedia, "video"),
});

const FacesReview: React.FC = () => {
    const [view, apply] = useUrlView(facesView);

    return (
        <Stack gap="lg">
            <PagePlate eyebrow="Review" title="Faces" />

            <Tabs
                value={view.tab}
                onChange={(value) =>
                    value &&
                    apply({
                        tab: facesView.parse(new URLSearchParams({ tab: value })).tab,
                        performer: "",
                    })
                }
                color="brass"
                keepMounted={false}
            >
                <Tabs.List mb="lg">
                    <Tabs.Tab value="matches">Matches</Tabs.Tab>
                    <Tabs.Tab value="unnamed">Unnamed</Tabs.Tab>
                    <Tabs.Tab value="wouldTag">Would tag</Tabs.Tab>
                    <Tabs.Tab value="taggedForYou">Tagged for you</Tabs.Tab>
                </Tabs.List>

                <Tabs.Panel value="matches">
                    <FaceReviewSheet
                        tab="matches"
                        performer={view.performer || null}
                        onClearPerformer={() => apply({ performer: "" })}
                        onPerformer={(performer) => apply({ performer })}
                        media={view.media}
                        onMedia={(media) => apply({ media })}
                    />
                </Tabs.Panel>

                <Tabs.Panel value="unnamed">
                    <FaceReviewSheet
                        tab="unnamed"
                        performer={null}
                        media={view.media}
                        onMedia={(media) => apply({ media })}
                    />
                </Tabs.Panel>

                <Tabs.Panel value="wouldTag">
                    <AutoTagSheet mode="proposed" />
                </Tabs.Panel>

                <Tabs.Panel value="taggedForYou">
                    <AutoTagSheet mode="applied" />
                </Tabs.Panel>
            </Tabs>
        </Stack>
    );
};

/** `useUrlView` reads the search parameters, which Next requires to sit under a boundary. */
const FacesPage: React.FC = () => (
    <Suspense>
        <FacesReview />
    </Suspense>
);

export default FacesPage;
