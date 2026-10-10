import { useCallback, useState } from "react";
import { Alert, Badge, Button, Group, Loader, Select, Stack, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useQueryClient } from "@tanstack/react-query";

import type { OcrMatchCandidate, OcrMatchRow, OcrMatchStatus } from "@private-stock/core";

import { ocrMatchesKey, useOcrMatches, useUndoOcrMatch, type OcrMatchFilters } from "@/lib/api/ocr";
import { facetLabel } from "@/lib/facetLabels";
import { SearchInput } from "@/components/SearchInput";

import { Highlighted, plural } from "./OcrMatchParts";
import { OcrThumb } from "./OcrThumb";
import classes from "./OcrReview.module.scss";
import { VirtualFeed } from "./VirtualFeed";

const STATUS_LABELS: Record<OcrMatchStatus, string> = {
    accepted: "Tagging",
    rejected: "Never",
};

const errorText = (error: unknown): string =>
    error instanceof Error ? error.message : "That change could not be saved.";

const RuleRow: React.FC<{
    row: OcrMatchRow;
    status: OcrMatchStatus;
    busy: boolean;
    onUndo: (candidate: OcrMatchCandidate) => void;
}> = ({ row, status, busy, onUndo }) => {
    const isPhone = useMediaQuery("(max-width: 48em)");
    const decided = row.candidates.filter((candidate) => candidate.state === status);

    return (
        <div className={classes.matchRow}>
            {row.sample ? (
                <OcrThumb
                    mediaId={row.sample.mediaId}
                    frame={row.sample.frame}
                    coverUrl={row.sample.coverUrl}
                    box={row.sample.box}
                    atMs={row.sample.atMs}
                    width={isPhone ? 280 : 120}
                    label={row.text}
                />
            ) : (
                <span />
            )}
            <div style={{ minWidth: 0 }}>
                <div className={classes.head}>
                    <Text component="span" className={classes.string}>
                        <Highlighted
                            text={row.text}
                            spans={decided.map((candidate) => candidate.matchedText)}
                        />
                    </Text>
                    <Text component="span" className={classes.stats}>
                        {plural(row.rowCount, "reading", "readings")}
                    </Text>
                    {busy && <Loader size="xs" />}
                </div>
                <div className={classes.candidates}>
                    {decided.map((candidate) => (
                        <div
                            key={candidate.matchId}
                            className={classes.candidate}
                            data-state={candidate.state ?? "open"}
                        >
                            <div style={{ minWidth: 0 }}>
                                <Text size="sm" fw={500} className={classes.candidateName}>
                                    {candidate.tagName}
                                </Text>
                                <Text className={classes.stats}>
                                    {facetLabel(candidate.tagKind)}
                                </Text>
                            </div>
                            <Group gap={4} wrap="nowrap">
                                <Badge
                                    size="sm"
                                    variant="light"
                                    color={status === "accepted" ? "brass" : "gray"}
                                    className={classes.badge}
                                >
                                    {STATUS_LABELS[status]}
                                </Badge>
                                <Button
                                    variant="subtle"
                                    color="gray"
                                    size="compact-xs"
                                    disabled={busy}
                                    onClick={() => onUndo(candidate)}
                                >
                                    {status === "accepted" ? "Withdraw" : "Undo"}
                                </Button>
                            </Group>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
};

interface OcrRuleSheetProps {
    filters: OcrMatchFilters;
    onFilters: (next: Partial<OcrMatchFilters>) => void;
    searchText: string;
    onSearchText: (text: string) => void;
}

/**
 * Review › OCR › Rules (§5d "An accepted pair is a rule"): every decision, by the text it was
 * made about, most-read first.
 *
 * Withdrawing an accepted pair takes off everything it tagged — what was accepted and what the
 * rule applied since — and puts its items back in the queue. Undoing a "never" lets the pair be
 * suggested again.
 */
export const OcrRuleSheet: React.FC<OcrRuleSheetProps> = ({
    filters,
    onFilters,
    searchText,
    onSearchText,
}) => {
    const queryClient = useQueryClient();
    const matches = useOcrMatches(filters);
    const undoMatch = useUndoOcrMatch();
    const rows = matches.data?.pages.flatMap((page) => page.rows) ?? [];
    const [busy, setBusy] = useState<string | null>(null);
    const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null);

    const undo = (row: OcrMatchRow, candidate: OcrMatchCandidate): void => {
        setBusy(row.textNorm);
        undoMatch.mutate(
            { matchIds: [candidate.matchId] },
            {
                onSuccess: (result) => {
                    void queryClient.invalidateQueries({ queryKey: ocrMatchesKey(filters) });
                    setOutcome({
                        ok: true,
                        message:
                            candidate.state === "accepted"
                                ? `Took ${candidate.tagName} off ${plural(result.mediaIds.length, "item", "items")}. They are back in the queue.`
                                : `${candidate.tagName} can be suggested for this text again.`,
                    });
                },
                onError: (error) => setOutcome({ ok: false, message: errorText(error) }),
                onSettled: () => setBusy(null),
            }
        );
    };

    const loadMore = useCallback(() => void matches.fetchNextPage(), [matches]);

    return (
        <Stack gap="md">
            <Group gap="sm" wrap="wrap" align="center">
                <SearchInput
                    aria-label="Find text"
                    placeholder="Find text"
                    value={searchText}
                    onChange={onSearchText}
                    style={{ flex: "1 1 220px" }}
                />
                <Select
                    aria-label="Show"
                    data={(Object.keys(STATUS_LABELS) as OcrMatchStatus[]).map((value) => ({
                        value,
                        label: STATUS_LABELS[value],
                    }))}
                    value={filters.status}
                    onChange={(value) => value && onFilters({ status: value as OcrMatchStatus })}
                    allowDeselect={false}
                    w={{ base: "100%", xs: 160 }}
                />
            </Group>

            {outcome && (
                <Alert
                    color={outcome.ok ? "brass" : "oxblood"}
                    variant="light"
                    withCloseButton
                    onClose={() => setOutcome(null)}
                >
                    {outcome.message}
                </Alert>
            )}

            {matches.isPending ? (
                <Loader size="sm" />
            ) : matches.isError ? (
                <Alert color="oxblood" variant="light">
                    {errorText(matches.error)}
                </Alert>
            ) : rows.length === 0 ? (
                <Text c="dimmed" size="sm">
                    {filters.search
                        ? "No text matches that."
                        : filters.status === "accepted"
                          ? "No rules yet. Tagging a name from the queue makes one."
                          : "Nothing marked never."}
                </Text>
            ) : (
                <VirtualFeed
                    items={rows}
                    keyOf={(row) => row.textNorm}
                    estimate={120}
                    hasMore={matches.hasNextPage}
                    loadingMore={matches.isFetchingNextPage}
                    onLoadMore={loadMore}
                    render={(row) => (
                        <RuleRow
                            row={row}
                            status={filters.status}
                            busy={busy === row.textNorm}
                            onUndo={(candidate) => undo(row, candidate)}
                        />
                    )}
                />
            )}
        </Stack>
    );
};
