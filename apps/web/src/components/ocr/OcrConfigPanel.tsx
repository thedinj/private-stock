import { useEffect, useRef, useState } from "react";
import {
    Accordion,
    Alert,
    Anchor,
    Button,
    Card,
    Group,
    Loader,
    Stack,
    Text,
    Title,
} from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { ocrSettingsOf, type OcrRerunOutdatedResult, type OcrSettings } from "@private-stock/core";

import { StageSwitch } from "@/components/admin/StageSwitch";
import { useAdminSettings } from "@/lib/api/adminSettings";
import { api } from "@/lib/api/client";
import {
    useOcrBench,
    useOcrSettings,
    useOcrTune,
    useRunOcrTrials,
    useSaveOcrSettings,
} from "@/lib/api/ocr";
import { invalidateProcessing } from "@/lib/api/processing";
import { queryKeys } from "@/lib/api/queryKeys";

import { OcrBench } from "./OcrBench";
import { OcrSettingsFields } from "./OcrSettingsFields";
import { OcrTunePanel } from "./OcrTunePanel";

/** One re-run batch: big enough to get through a library, small enough to stop between. */
const RERUN_BATCH = 200;

const errorText = (error: unknown): string =>
    error instanceof Error ? error.message : "That did not work.";

const same = (left: OcrSettings, right: OcrSettings): boolean =>
    JSON.stringify(left) === JSON.stringify(right);

const TUNE_STATE: Record<string, string> = {
    pending: "starting",
    running: "running",
    done: "results ready",
    failed: "last run failed",
    cancelled: "last run stopped",
};

/**
 * OCR's configuration (§5d "Settings and the test bench"), on Processing › OCR.
 *
 * **One form.** The settings and the test bench used to have a form each -- twelve fields twice
 * -- and three different buttons that made settings live: Save, "Use the compared candidate"
 * and a tuning result's "Use these settings". Now the form's unsaved draft *is* the candidate:
 * "Compare on bench" reads the bench's videos with it, a tuning result loads into it, and Save
 * is the only thing that changes what the library is read with. The data model is unchanged --
 * the bench still stores a candidate per video beside the current settings (`OcrTrial`).
 *
 * **Collapsed by default.** The form's groups, the bench and the tuner each say what they hold
 * on their header, and open when there is something to do in them.
 *
 * What saving does is said once, beside Save: it changes what is read from then on, and nothing
 * already read until it is re-run -- which is the one line under the form.
 */
export const OcrConfigPanel: React.FC = () => {
    const queryClient = useQueryClient();
    const settings = useOcrSettings();
    const admin = useAdminSettings();
    const bench = useOcrBench();
    const tune = useOcrTune();
    const save = useSaveOcrSettings();
    const runTrials = useRunOcrTrials();
    const [draft, setDraft] = useState<OcrSettings | null>(null);
    const [openSections, setOpenSections] = useState<string[]>([]);
    const stopRef = useRef(false);
    const [run, setRun] = useState<{ queued: number; done: boolean; stopped: boolean } | null>(
        null
    );

    // The form starts from what is stored, once it arrives; after that it is the reader's.
    useEffect(() => {
        if (settings.data && draft === null) {
            setDraft(ocrSettingsOf(settings.data.settings));
        }
    }, [settings.data, draft]);

    /** Items read under older settings, read again a batch at a time, stoppable between. */
    const rerun = useMutation({
        mutationFn: async () => {
            stopRef.current = false;

            let after: string | null = null;
            let queued = 0;

            setRun({ queued, done: false, stopped: false });

            do {
                const batch: OcrRerunOutdatedResult = await api<OcrRerunOutdatedResult>(
                    "/api/ocr/settings/rerun",
                    { method: "POST", body: JSON.stringify({ after, limit: RERUN_BATCH }) }
                );

                queued += batch.queued;
                after = batch.next;
                setRun({ queued, done: false, stopped: false });
            } while (after !== null && !stopRef.current);

            setRun({ queued, done: true, stopped: stopRef.current });
        },
        onSettled: () => {
            invalidateProcessing(queryClient);
            void queryClient.invalidateQueries({ queryKey: queryKeys.ocr.settings() });
        },
    });

    if (settings.isPending || draft === null) {
        return <Loader size="sm" />;
    }

    if (settings.isError || !settings.data) {
        return (
            <Alert color="oxblood" variant="light">
                {errorText(settings.error)}
            </Alert>
        );
    }

    const { defaults, staleItems, staleReviewed } = settings.data;
    const current = ocrSettingsOf(settings.data.settings);
    const dirty = !same(current, draft);
    const stage = admin.data?.stages.find((candidate) => candidate.name === "ocr");
    const items = bench.data?.items ?? [];
    const latestTune = tune.data?.latest ?? null;

    // What the bench last compared, so its header can say when the form has moved on since.
    const compared = items.find((item) => item.candidate?.state === "done")?.candidate?.settings;
    const comparedIsDraft = compared !== undefined && same(compared, draft);

    const compare = (candidate: OcrSettings) => {
        setDraft(candidate);
        setOpenSections((open) => (open.includes("bench") ? open : [...open, "bench"]));
        runTrials.mutate({ candidate });
    };

    const benchSummary =
        items.length === 0
            ? "no videos yet"
            : `${items.length} of ${bench.data?.limit ?? items.length} videos${
                  compared === undefined
                      ? " · not compared yet"
                      : comparedIsDraft
                        ? " · compared with this draft"
                        : " · the form has changed since the last comparison"
              }`;

    return (
        <Stack gap="lg" maw={860}>
            <Card p="md">
                <Stack gap="md">
                    <Group justify="space-between" wrap="wrap" gap="sm">
                        <Title order={4}>OCR</Title>
                        {stage && (
                            <StageSwitch stage={stage} label="Read text across the library" />
                        )}
                    </Group>

                    <OcrSettingsFields value={draft} defaults={defaults} onChange={setDraft} />

                    {(save.isError || runTrials.isError) && (
                        <Alert color="oxblood" variant="light">
                            {errorText(save.error ?? runTrials.error)}
                        </Alert>
                    )}

                    <Group gap="sm" wrap="wrap">
                        <Button
                            color="brass"
                            disabled={!dirty}
                            loading={save.isPending}
                            onClick={() =>
                                save.mutate(draft, {
                                    onSuccess: (next) => setDraft(ocrSettingsOf(next.settings)),
                                })
                            }
                        >
                            Save
                        </Button>
                        <Button
                            variant="default"
                            disabled={items.length === 0}
                            loading={runTrials.isPending}
                            onClick={() => compare(draft)}
                        >
                            Compare on bench
                        </Button>
                        <Button
                            variant="subtle"
                            color="gray"
                            disabled={!dirty}
                            onClick={() => setDraft(current)}
                        >
                            Discard
                        </Button>
                        <Button
                            variant="subtle"
                            color="gray"
                            disabled={same(draft, defaults)}
                            onClick={() => setDraft(defaults)}
                        >
                            Reset to defaults
                        </Button>
                    </Group>

                    <Text size="xs" c="dimmed">
                        Saving changes what is read from now on; nothing already read changes until
                        it is re-run. Reviewed strings are kept either way.
                    </Text>

                    {/* The one line about the rest of the library. */}
                    <Group gap="xs" wrap="wrap">
                        <Text size="sm">
                            {staleItems === 0
                                ? "Every item was read under the current settings."
                                : `${staleItems.toLocaleString()} ${staleItems === 1 ? "item" : "items"} read under older settings${
                                      staleReviewed > 0
                                          ? ` (${staleReviewed.toLocaleString()} reviewed)`
                                          : ""
                                  }`}
                            {run &&
                                (run.done
                                    ? ` · ${run.stopped ? "stopped after queuing" : "queued"} ${run.queued.toLocaleString()}`
                                    : ` · queuing… ${run.queued.toLocaleString()}`)}
                        </Text>
                        {staleItems > 0 &&
                            (rerun.isPending ? (
                                <Anchor
                                    component="button"
                                    size="sm"
                                    onClick={() => {
                                        stopRef.current = true;
                                    }}
                                >
                                    Stop
                                </Anchor>
                            ) : (
                                <Anchor
                                    component="button"
                                    size="sm"
                                    // Re-run with the settings you mean, not a half-edited form.
                                    disabled={dirty}
                                    title={dirty ? "Save or discard your changes first" : undefined}
                                    onClick={() => rerun.mutate()}
                                >
                                    Re-run
                                </Anchor>
                            ))}
                        {rerun.isError && (
                            <Text size="sm" c="oxblood.4">
                                {errorText(rerun.error)}
                            </Text>
                        )}
                    </Group>
                </Stack>
            </Card>

            <Accordion
                multiple
                variant="separated"
                chevronPosition="left"
                value={openSections}
                onChange={setOpenSections}
            >
                <Accordion.Item value="bench">
                    <Accordion.Control>
                        <Text size="sm" fw={500}>
                            Test bench
                        </Text>
                        <Text size="xs" c="dimmed">
                            {benchSummary}
                        </Text>
                    </Accordion.Control>
                    <Accordion.Panel>
                        <OcrBench />
                    </Accordion.Panel>
                </Accordion.Item>

                <Accordion.Item value="tune">
                    <Accordion.Control>
                        <Text size="sm" fw={500}>
                            Tune automatically
                        </Text>
                        <Text size="xs" c="dimmed">
                            {latestTune
                                ? (TUNE_STATE[latestTune.state] ?? latestTune.state)
                                : "searches for settings that read what the bench videos should"}
                        </Text>
                    </Accordion.Control>
                    <Accordion.Panel>
                        <OcrTunePanel items={items} onLoad={setDraft} onCompare={compare} />
                    </Accordion.Panel>
                </Accordion.Item>
            </Accordion>
        </Stack>
    );
};
