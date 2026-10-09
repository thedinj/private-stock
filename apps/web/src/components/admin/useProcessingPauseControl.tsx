import { Button, Stack, Text, Tooltip } from "@mantine/core";

import { useProcessingPause, useSetProcessingPause } from "@/lib/api/processing";

const errorText = (error: unknown): string =>
    error instanceof Error ? error.message : "That did not work.";

const formatSince = (since: string | null): string | null => {
    if (!since) return null;

    const at = new Date(since);

    return Number.isNaN(at.getTime())
        ? null
        : at.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};

/** What keeps running while paused. "Paused" that silently still runs things is worse than none. */
const STILL_RUNS =
    "The OCR test bench, tuning, anything run on a single item, and deletions keep working.";

/**
 * The kill switch for background processing (§7c "Pausing"), in the Processing page's header.
 *
 * One control in one place. It used to be on the admin page and again on the OCR settings tab,
 * because the case that motivated it was holding the library still while tuning OCR -- and OCR's
 * settings now sit on a tab of the same page, under this header.
 *
 * Two pieces from one pair of hooks, because the plate places them apart: the button among its
 * actions, the sentence under its rule.
 */
export const useProcessingPauseControl = (): { button: React.ReactNode; note: React.ReactNode } => {
    const pause = useProcessingPause();
    const setPause = useSetProcessingPause();
    const paused = pause.data?.paused ?? false;
    const since = formatSince(pause.data?.since ?? null);

    const button = (
        <Tooltip
            multiline
            w={300}
            disabled={paused}
            label={`Stops all background work at once — scans, covers, OCR, transcodes. Running jobs go back in the queue. ${STILL_RUNS}`}
        >
            <Button
                color={paused ? "brass" : "oxblood"}
                variant={paused ? "filled" : "light"}
                loading={setPause.isPending}
                disabled={pause.isPending}
                onClick={() => setPause.mutate(!paused)}
            >
                {paused ? "Resume processing" : "Pause processing"}
            </Button>
        </Tooltip>
    );

    const note =
        paused || setPause.isError ? (
            <Stack gap={4}>
                {paused && (
                    <Text size="sm">
                        Paused{since ? ` since ${since}` : ""}. Queued work carries on where it
                        stopped when you resume. {STILL_RUNS}
                    </Text>
                )}
                {setPause.isError && (
                    <Text size="sm" c="oxblood.4">
                        {errorText(setPause.error)}
                    </Text>
                )}
            </Stack>
        ) : null;

    return { button, note };
};
