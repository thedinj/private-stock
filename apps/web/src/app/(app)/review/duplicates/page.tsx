"use client";

import { Alert, Button, Stack, Tabs, Text } from "@mantine/core";
import { useMutation, useQuery } from "@tanstack/react-query";

import { reviewMedia, reviewMediaKind, type DupeListResponse } from "@private-stock/core";

import { api, getCurrentUser } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/queryKeys";
import { DupeRulesForm } from "@/components/admin/DupeRulesForm";
import { RulesDrawer } from "@/components/admin/RulesDrawer";
import { DupeSheet } from "@/components/dupes/DupeSheet";
import { IdenticalPanel } from "@/components/dupes/IdenticalPanel";
import { ReviewKindFilter } from "@/components/review/ReviewKindFilter";
import { PagePlate } from "@/components/shell/PagePlate";
import { defineView, enumField, flagField, pageField, useUrlView } from "@/lib/urlView";

/**
 * Duplicates (§10c, §10e): three tabs, because there are three different visits.
 *
 * - **Identical** — byte-for-byte copies. Nothing to judge, so a rule decides them and one button
 *   applies it to the whole queue; only what the rule will not decide is shown as a sheet.
 * - **Look alike** — near duplicates, where the copies genuinely differ and the triage sheet's
 *   comparison is the whole point.
 * - **Reviewed** — groups somebody chose to keep as they are, for changing that mind.
 *
 * The old controls — an All/Identical/Looks-the-same filter, a page-size picker and a "show
 * reviewed" switch — were one sheet asked to serve all three. "All" mixed two different kinds
 * of decision on one page; the page size existed to get through identical groups faster, which
 * the rule now does; and the switch mixed decided groups into the queue of undecided ones.
 */

/**
 * The tab, its pages and the kind control, in the address (§14b).
 *
 * Held in component state, opening an item and coming back put you on the Identical tab, page
 * one, whatever you had been working through. `page` is the tab's own pager and `sheet` the
 * "Needs a look" sheet inside Identical, which pages separately; changing tab starts both over.
 */
const dupesView = defineView("/review/duplicates", {
    tab: enumField("tab", ["identical", "near", "reviewed"], "identical"),
    page: pageField(),
    sheet: pageField("sheet"),
    rules: flagField("rules"),
    // Videos unless asked: photos are the exception in this collection (§10c).
    media: enumField("media", reviewMedia, "video"),
});

/** The address is zero-based; the pagers count from one. */
const toPager = (page: number) => page + 1;
const fromPager = (page: number) => page - 1;

const DuplicatesPage: React.FC = () => {
    /**
     * Deleting is a per-user permission and reviewing is an admin one, and neither implies the
     * other (§18.1). An administrator without `delete` gets the comparison and no ticks.
     */
    const canDelete = getCurrentUser()?.scopes.includes("delete") ?? false;
    const [view, apply] = useUrlView(dupesView);
    const media = reviewMediaKind(view.media);
    const only: Record<string, string> = media ? { media } : {};

    /**
     * The labels' counts: pending of each kind and reviewed, under the kind control, and pending
     * of each media kind for the control itself -- from the smallest page there is.
     */
    const { data: counts } = useQuery({
        queryKey: queryKeys.dupes.counts(view.media),
        queryFn: () =>
            api<DupeListResponse>(`/api/dupes?${new URLSearchParams({ limit: "1", ...only })}`),
    });

    const rescan = useMutation({
        mutationFn: () => api("/api/dupes", { method: "POST" }),
    });

    const label = (name: string, count: number | undefined) =>
        count === undefined ? name : `${name} · ${count.toLocaleString()}`;

    const pendingTotal = counts ? counts.pending.exact + counts.pending.near : null;

    return (
        <Stack gap="lg">
            <PagePlate
                eyebrow={
                    pendingTotal === null
                        ? "Copies of the same thing"
                        : `${pendingTotal.toLocaleString()} ${pendingTotal === 1 ? "group" : "groups"} to review`
                }
                title="Duplicates"
                lede="Ratings, tags, notes and playlist places move to the copy you keep."
                actions={
                    <>
                        {/* "Re-check", not "scan": scanning is what finds files on disk, on the
                            Libraries page. This compares the files already catalogued. */}
                        <Button
                            variant="default"
                            loading={rescan.isPending}
                            onClick={() => rescan.mutate()}
                        >
                            Re-check for duplicates
                        </Button>
                        <RulesDrawer
                            title="Duplicate rules"
                            opened={view.rules}
                            onOpen={() => apply({ rules: true })}
                            onClose={() => apply({ rules: false })}
                        >
                            <Stack gap="md">
                                <Text size="sm" c="dimmed">
                                    How alike two files must be to be offered here.
                                </Text>
                                <DupeRulesForm />
                            </Stack>
                        </RulesDrawer>
                    </>
                }
            />

            {rescan.isSuccess && (
                <Alert color="brass" variant="light">
                    A fresh check is queued. Groups appear here as the worker finds them.
                </Alert>
            )}

            <ReviewKindFilter
                value={view.media}
                onChange={(next) => apply({ media: next, page: 0, sheet: 0 })}
                counts={counts?.pendingByMedia}
            />

            {/* Not kept mounted: each sheet binds its keys to the window, so only the tab on
                screen may have one. */}
            <Tabs
                value={view.tab}
                onChange={(value) =>
                    value &&
                    apply({
                        tab: dupesView.parse(new URLSearchParams({ tab: value })).tab,
                        page: 0,
                        sheet: 0,
                    })
                }
                color="brass"
                keepMounted={false}
            >
                <Tabs.List mb="lg">
                    <Tabs.Tab value="identical">
                        {label("Identical", counts?.pending.exact)}
                    </Tabs.Tab>
                    <Tabs.Tab value="near">{label("Look alike", counts?.pending.near)}</Tabs.Tab>
                    <Tabs.Tab value="reviewed">{label("Reviewed", counts?.reviewed)}</Tabs.Tab>
                </Tabs.List>

                <Tabs.Panel value="identical">
                    <IdenticalPanel
                        canDelete={canDelete}
                        page={toPager(view.page)}
                        onPage={(page) => apply({ page: fromPager(page) })}
                        sheetPage={toPager(view.sheet)}
                        onSheetPage={(page) => apply({ sheet: fromPager(page) })}
                        media={media}
                    />
                </Tabs.Panel>

                <Tabs.Panel value="near">
                    <DupeSheet
                        endpoint="/api/dupes"
                        params={{ kind: "near", status: "pending", ...only }}
                        keyFor={queryKeys.dupes.page}
                        canDelete={canDelete}
                        emptyTitle="Nothing to review"
                        emptyText="No look-alike groups are waiting. Anything already decided is on the Reviewed tab."
                        page={toPager(view.page)}
                        onPage={(page) => apply({ page: fromPager(page) })}
                    />
                </Tabs.Panel>

                <Tabs.Panel value="reviewed">
                    <DupeSheet
                        endpoint="/api/dupes"
                        params={{ status: "reviewed", ...only }}
                        keyFor={queryKeys.dupes.page}
                        canDelete={canDelete}
                        emptyTitle="Nothing reviewed yet"
                        emptyText="Groups you mark reviewed — kept as they are — are listed here, to reopen if you change your mind."
                        page={toPager(view.page)}
                        onPage={(page) => apply({ page: fromPager(page) })}
                    />
                </Tabs.Panel>
            </Tabs>
        </Stack>
    );
};

export default DuplicatesPage;
