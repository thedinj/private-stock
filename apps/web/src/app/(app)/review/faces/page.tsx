"use client";

import { Suspense, useRef } from "react";
import { Stack, Tabs } from "@mantine/core";

import { reviewMedia } from "@private-stock/core";

import { AutoTagSheet } from "@/components/faces/AutoTagSheet";
import { FaceHistorySheet } from "@/components/faces/FaceHistorySheet";
import { NewPeopleSheet } from "@/components/faces/NewPeopleSheet";
import { SuggestionsSheet } from "@/components/faces/SuggestionsSheet";
import { PagePlate } from "@/components/shell/PagePlate";
import { defineView, enumField, textField, useUrlView } from "@/lib/urlView";

/**
 * Faces (§5f): who the people in items are, across the library. A performer's own Faces tab is
 * where what is decided about them is seen and corrected; this is for the rest.
 *
 * - **Suggestions**: people in items who look clearly like a performer, a performer at a time,
 *   one card for each person in each item (§5f "Suggestions").
 * - **New people**: people who match nobody known, seen on three or more items — "Who is this?"
 *   (§5f "New people").
 * - **Would tag**: what faces would tag by themselves, checked before they are allowed to, and
 *   the switch that allows them.
 * - **History**: every face decision, yours and the app's, each undoable (§5f "Decisions you can
 *   take back").
 *
 * Suggestions opens on videos; photos are behind its kind control, since they are the exception
 * in this collection. Would tag has none: it is a fair sample of what the rule would do, and
 * narrowing it would no longer be one.
 */
const facesView = defineView("/review/faces", {
    tab: enumField("tab", ["suggestions", "newPeople", "wouldTag", "history"], "suggestions"),
    // A performer's page links here narrowed to them.
    performer: textField("performer"),
    media: enumField("media", reviewMedia, "video"),
});

const FacesReview: React.FC = () => {
    const [view, apply] = useUrlView(facesView);
    // Whether this visit went into a performer from the list, so "Everyone" can be Back.
    const drilledIn = useRef(false);

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
                    <Tabs.Tab value="newPeople">New people</Tabs.Tab>
                    <Tabs.Tab value="wouldTag">Would tag</Tabs.Tab>
                    <Tabs.Tab value="history">History</Tabs.Tab>
                </Tabs.List>

                <Tabs.Panel value="suggestions">
                    <SuggestionsSheet
                        performer={view.performer || null}
                        onPerformer={(performer) => {
                            if (performer) {
                                // A step into one performer: Back returns to everyone.
                                drilledIn.current = true;
                                apply({ performer }, { push: true });
                            } else if (drilledIn.current) {
                                // Undo the step rather than stacking another entry on it.
                                drilledIn.current = false;
                                window.history.back();
                            } else {
                                // Arrived narrowed to them, from their page: nothing to go back to.
                                apply({ performer: "" });
                            }
                        }}
                        media={view.media}
                        onMedia={(media) => apply({ media })}
                    />
                </Tabs.Panel>

                <Tabs.Panel value="newPeople">
                    <NewPeopleSheet />
                </Tabs.Panel>

                <Tabs.Panel value="wouldTag">
                    <AutoTagSheet />
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
