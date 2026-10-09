import { useCallback, useState } from "react";
import { Alert, Button, Loader, Stack, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useQueryClient } from "@tanstack/react-query";

import type { OcrRuleTag, OcrRuleTagPage } from "@private-stock/core";

import { patchInfinite, useOcrRuleTags, useUndoRuleTag } from "@/lib/api/ocr";
import { queryKeys } from "@/lib/api/queryKeys";
import { facetLabel } from "@/lib/facetLabels";

import { shortDay } from "./OcrMatchParts";
import { OcrThumb } from "./OcrThumb";
import classes from "./OcrReview.module.scss";
import { VirtualFeed } from "./VirtualFeed";

const errorText = (error: unknown): string =>
    error instanceof Error ? error.message : "That change could not be saved.";

const Entry: React.FC<{ row: OcrRuleTag; busy: boolean; onUndo: () => void }> = ({
    row,
    busy,
    onUndo,
}) => {
    const isPhone = useMediaQuery("(max-width: 48em)");

    return (
        <div className={classes.matchRow}>
            <OcrThumb
                mediaId={row.mediaId}
                frame={row.frame}
                coverUrl={row.coverUrl}
                box={row.box}
                atMs={row.atMs}
                width={isPhone ? 280 : 120}
                label={row.fileName}
            />
            <div style={{ minWidth: 0 }}>
                <div className={classes.head}>
                    <Text component="span" className={classes.itemTitle}>
                        {row.fileName}
                    </Text>
                    <Text component="span" className={classes.stats}>
                        {shortDay(row.createdAt)}
                    </Text>
                </div>
                <Text size="sm" mt={4}>
                    <Text component="span" fw={500} className={classes.candidateName}>
                        {row.tagName}
                    </Text>{" "}
                    <Text component="span" className={classes.stats}>
                        {facetLabel(row.tagKind)}
                    </Text>
                </Text>
                {row.text && (
                    <Text className={classes.string} mt={2}>
                        “{row.text}”
                    </Text>
                )}
                <Button
                    mt="xs"
                    size={isPhone ? "md" : "compact-sm"}
                    variant="subtle"
                    color="oxblood"
                    loading={busy}
                    onClick={onUndo}
                >
                    Take {row.tagName} off
                </Button>
            </div>
        </div>
    );
};

/**
 * Review › OCR › Tagged for you (§5d "An accepted pair is a rule"): what rules tagged by
 * themselves, newest first.
 *
 * This is where the automation is checked. Taking a tag off here is the same as taking it off
 * the item: the rule is declined for that item and never puts the tag back. To stop a rule
 * everywhere, withdraw it under Rules.
 */
export const OcrRuleLog: React.FC = () => {
    const queryClient = useQueryClient();
    const log = useOcrRuleTags();
    const undo = useUndoRuleTag();
    const rows = log.data?.pages.flatMap((page) => page.rows) ?? [];
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const takeOff = (row: OcrRuleTag): void => {
        setBusy(row.id);
        undo.mutate(
            { id: row.id },
            {
                onSuccess: () =>
                    patchInfinite<OcrRuleTagPage, OcrRuleTag>(
                        queryClient,
                        queryKeys.ocr.ruleTags(),
                        (page) => page.rows,
                        (page, pageRows) => ({ ...page, rows: pageRows }),
                        (entry) => (entry.id === row.id ? null : entry)
                    ),
                onError: (failure) => setError(errorText(failure)),
                onSettled: () => setBusy(null),
            }
        );
    };

    const loadMore = useCallback(() => void log.fetchNextPage(), [log]);

    return (
        <Stack gap="md">
            <Text size="sm" c="dimmed">
                What rules tagged by themselves, newest first. Taking a tag off here keeps the rule
                from putting it back on that item.
            </Text>

            {error && (
                <Alert
                    color="oxblood"
                    variant="light"
                    withCloseButton
                    onClose={() => setError(null)}
                >
                    {error}
                </Alert>
            )}

            {log.isPending ? (
                <Loader size="sm" />
            ) : log.isError ? (
                <Alert color="oxblood" variant="light">
                    {errorText(log.error)}
                </Alert>
            ) : rows.length === 0 ? (
                <Text c="dimmed" size="sm">
                    Nothing yet. Once you tag a name from the queue, items read with the same text
                    afterwards are tagged by themselves and listed here.
                </Text>
            ) : (
                <VirtualFeed
                    items={rows}
                    keyOf={(row) => row.id}
                    estimate={120}
                    hasMore={log.hasNextPage}
                    loadingMore={log.isFetchingNextPage}
                    onLoadMore={loadMore}
                    render={(row) => (
                        <Entry row={row} busy={busy === row.id} onUndo={() => takeOff(row)} />
                    )}
                />
            )}
        </Stack>
    );
};
