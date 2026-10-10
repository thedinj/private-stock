"use client";

import { Suspense } from "react";
import { Stack, Tabs } from "@mantine/core";

import { reviewMedia } from "@private-stock/core";

import { AutoTagSheet } from "@/components/faces/AutoTagSheet";
import { FaceHistorySheet } from "@/components/faces/FaceHistorySheet";
import { SuggestionsSheet } from "@/components/faces/SuggestionsSheet";
import { FaceReviewSheet } from "@/components/faces/FaceReviewSheet";
import { PagePlate } from "@/components/shell/PagePlate";
import { defineView, enumField, textField, useUrlView } from "@/lib/urlView";

/**
 * Faces (§5f "One review, two sources"): the face groups with something to decide, across the
 * library. A performer's own page is where their face is confirmed; this is for the rest.
 *
 * - **Suggestions**: people in items who look clearly like a performer, a performer at a time,
 *   one card for each person in each item (§5f "Suggestions").
 * - **Matches**: groups that are, or might be, a performer, on items not tagged with them yet —
 *   the old review, off the tab list and behind a link in Suggestions until it goes.
 * - **Unnamed**: "Who is this?" — the largest groups no performer is proposed for.
 * - **Would tag**: what faces would tag by themselves, checked before they are allowed to, and
 *   the switch that allows them.
 * - **Tagged for you**: what they tagged, to take back what is wrong.
 * - **History**: every face decision, yours and the app's, each undoable (§5f "Decisions you can
 *   take back").
 *
 * Matches and Unnamed open on faces in videos; photos are behind their kind control, since they
 * are the exception in this collection. Would tag and Tagged for you have no such control: the
 * first is a fair sample of what the rule would do, and narrowing it would no longer be one.
 */
const facesView = defineView("/review/faces", {
    tab: enumField(
        "tab",
        ["suggestions", "matches", "unnamed", "wouldTag", "taggedForYou", "history"],
        "suggestions"
    ),
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
                    <Tabs.Tab value="suggestions">Suggestions</Tabs.Tab>
                    <Tabs.Tab value="unnamed">Unnamed</Tabs.Tab>
                    <Tabs.Tab value="wouldTag">Would tag</Tabs.Tab>
                    <Tabs.Tab value="taggedForYou">Tagged for you</Tabs.Tab>
                    <Tabs.Tab value="history">History</Tabs.Tab>
                </Tabs.List>

                <Tabs.Panel value="suggestions">
                    <SuggestionsSheet
                        performer={view.performer || null}
                        onPerformer={(performer) => apply({ performer: performer ?? "" })}
                        media={view.media}
                        onMedia={(media) => apply({ media })}
                        onGroups={() => apply({ tab: "matches", performer: "" })}
                    />
                </Tabs.Panel>

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

                <Tabs.Panel value="history">
                    <FaceHistorySheet />
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
