import { useCallback, useMemo, useState } from "react";
import {
    Alert,
    Badge,
    Button,
    Checkbox,
    Group,
    Loader,
    Modal,
    Paper,
    Stack,
    Text,
    Tooltip,
} from "@mantine/core";

import { BULK_ACTION_LIMIT, type UnreadableItem, type UnreadableTab } from "@private-stock/core";

import { useAuth } from "@/lib/api/AuthProvider";
import {
    usePurgeUnreadable,
    useRereadUnreadable,
    useTrashUnreadable,
    useUnreadable,
} from "@/lib/api/unreadable";
import { formatBytes } from "@/lib/dupeTriage";
import barClasses from "@/components/library/SelectionBar.module.scss";
import { describeBulkResult } from "@/components/library/describeBulkResult";
import { VirtualFeed } from "@/components/ocr/VirtualFeed";

import classes from "./UnreadableSheet.module.scss";

const errorText = (error: unknown): string =>
    error instanceof Error ? error.message : "That could not be done.";

const plural = (count: number, one: string, many: string): string =>
    `${count.toLocaleString()} ${count === 1 ? one : many}`;

/** SQLite stores UTC without a zone marker; said explicitly, or the browser reads it as local. */
const dayOf = (at: string): string =>
    new Date(`${at.replace(" ", "T")}Z`).toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
    });

const fileNameOf = (relPath: string): string => relPath.split("/").at(-1) ?? relPath;

const directoryOf = (relPath: string): string => {
    const cut = relPath.lastIndexOf("/");

    return cut > 0 ? relPath.slice(0, cut) : "";
};

interface UnreadableSheetProps {
    tab: UnreadableTab;
}

/**
 * Unreadable files (§10g), largest first, ticked and acted on: the ones still in the library on
 * Review › Unreadable, and the ones in the bin under the trash's "Unreadable only" filter.
 *
 * Each row says what the file is, where it lives, how big it is and what the probe said about
 * it. There is no picture to show -- that is the point of the list -- so the reason is the
 * row's evidence, and a row whose reason is not a known corruption says so and offers a second
 * read rather than inviting a deletion.
 *
 * A row that cannot be acted on has no tick rather than a disabled one: a read-only library in
 * the library list, a file still being copied into the bin in the trash.
 */
export const UnreadableSheet: React.FC<UnreadableSheetProps> = ({ tab }) => {
    const { hasScope } = useAuth();
    const list = useUnreadable(tab);
    const trash = useTrashUnreadable();
    const purge = usePurgeUnreadable();
    const reread = useRereadUnreadable();

    const [ticked, setTicked] = useState<Set<string>>(new Set());
    const [confirming, setConfirming] = useState(false);
    const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null);

    const rows = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);
    const summary = list.data?.pages[0]?.summary;

    /**
     * Moving to the trash is the bulk action's, so it needs the delete permission like every
     * other deletion. Without it the first tab is a report: no ticks, and a line saying why.
     */
    const canAct = tab === "trash" || hasScope("delete");
    const actionable = (item: UnreadableItem): boolean =>
        canAct && (tab === "library" ? item.writable : !item.moving);

    // Only what is still on screen: a row that left the list since it was ticked is not acted on.
    const tickedItems = rows.filter((item) => ticked.has(item.mediaId) && actionable(item));
    const tickedBytes = tickedItems.reduce((sum, item) => sum + item.bytes, 0);
    const selectable = rows.filter(actionable).slice(0, BULK_ACTION_LIMIT);
    const allTicked = selectable.length > 0 && tickedItems.length === selectable.length;

    const toggle = (mediaId: string, on: boolean): void =>
        setTicked((current) => {
            const next = new Set(current);
            if (on) next.add(mediaId);
            else next.delete(mediaId);
            return next;
        });

    const act = (): void => {
        const mediaIds = tickedItems.map((item) => item.mediaId);
        const done = (message: string): void => {
            setConfirming(false);
            setTicked(new Set());
            setOutcome({ ok: true, message });
        };
        const failed = (error: unknown): void => {
            setConfirming(false);
            setOutcome({ ok: false, message: errorText(error) });
        };

        if (tab === "library") {
            trash.mutate(mediaIds, {
                onSuccess: (result) => done(describeBulkResult(result)),
                onError: failed,
            });
        } else {
            purge.mutate(mediaIds, {
                onSuccess: (result) =>
                    done(
                        `${plural(result.queued, "file is", "files are")} being deleted for good` +
                            (result.freedBytes > 0
                                ? `; ${formatBytes(result.freedBytes)} goes back to the data volume as the purges run.`
                                : ".") +
                            (result.waiting > 0
                                ? ` ${plural(result.waiting, "was", "were")} still being moved into the trash and left.`
                                : "")
                    ),
                onError: failed,
            });
        }
    };

    const loadMore = useCallback(() => void list.fetchNextPage(), [list]);

    return (
        <Stack gap="md">
            {summary && summary.count > 0 && (
                <Text size="sm" c="dimmed">
                    {tab === "library"
                        ? `${plural(summary.count, "file", "files")} the probe cannot read, ${formatBytes(summary.bytes)} on the media volume. Largest first.`
                        : `${plural(summary.count, "unreadable file", "unreadable files")} in the trash, ${formatBytes(summary.bytes)} held on the data volume until purged.`}
                </Text>
            )}

            {tab === "library" && !hasScope("delete") && (
                <Alert color="oak" variant="light">
                    Moving files to the trash needs the delete permission, which your account does
                    not have.
                </Alert>
            )}

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

            {list.isPending ? (
                <Loader size="sm" />
            ) : list.isError ? (
                <Alert color="oxblood" variant="light">
                    {errorText(list.error)}
                </Alert>
            ) : rows.length === 0 ? (
                <Text c="dimmed" size="sm">
                    {tab === "library"
                        ? "Every file in the library can be read."
                        : "No unreadable files are waiting in the trash."}
                </Text>
            ) : (
                <>
                    {selectable.length > 0 && (
                        <div className={classes.tickAll}>
                            <Checkbox
                                checked={allTicked}
                                indeterminate={tickedItems.length > 0 && !allTicked}
                                onChange={(event) =>
                                    setTicked(
                                        event.currentTarget.checked
                                            ? new Set(selectable.map((item) => item.mediaId))
                                            : new Set()
                                    )
                                }
                                label={
                                    list.hasNextPage
                                        ? `Tick the ${selectable.length.toLocaleString()} loaded`
                                        : "Tick all"
                                }
                                color="brass"
                            />
                        </div>
                    )}

                    <VirtualFeed
                        items={rows}
                        keyOf={(item) => item.mediaId}
                        estimate={96}
                        hasMore={list.hasNextPage}
                        loadingMore={list.isFetchingNextPage}
                        onLoadMore={loadMore}
                        render={(item) => (
                            <div className={classes.row}>
                                <div className={classes.tick}>
                                    {actionable(item) && (
                                        <Checkbox
                                            checked={ticked.has(item.mediaId)}
                                            onChange={(event) =>
                                                toggle(item.mediaId, event.currentTarget.checked)
                                            }
                                            aria-label={`Select ${fileNameOf(item.relPath)}`}
                                            color="brass"
                                        />
                                    )}
                                </div>

                                <div className={classes.body}>
                                    <div className={classes.head}>
                                        <Text className={classes.name}>
                                            {fileNameOf(item.relPath)}
                                        </Text>
                                        <span className={classes.size}>
                                            {formatBytes(item.bytes)}
                                        </span>
                                    </div>

                                    <Text className={classes.where}>
                                        {item.rootLabel}
                                        {directoryOf(item.relPath)
                                            ? ` · ${directoryOf(item.relPath)}`
                                            : ""}
                                    </Text>

                                    {item.reason && (
                                        <Text className={classes.reason}>{item.reason}</Text>
                                    )}

                                    <div className={classes.meta}>
                                        <Text className={classes.when}>
                                            Gave up {dayOf(item.failedAt)}
                                        </Text>

                                        {!item.corrupt && (
                                            <Tooltip
                                                label="The probe ran out of attempts without naming damage to the file. It may read fine next time."
                                                multiline
                                                w={260}
                                            >
                                                <Badge color="brass" variant="light">
                                                    May be temporary
                                                </Badge>
                                            </Tooltip>
                                        )}

                                        {tab === "library" && !item.writable && (
                                            <Tooltip
                                                label="This library is read-only, so nothing in it can be deleted from here."
                                                multiline
                                                w={260}
                                            >
                                                <Badge color="oak" variant="light">
                                                    Read-only library
                                                </Badge>
                                            </Tooltip>
                                        )}

                                        {tab === "trash" && item.moving && (
                                            <Badge color="brass" variant="light">
                                                Moving to the trash
                                            </Badge>
                                        )}

                                        {tab === "library" && !item.corrupt && (
                                            <Button
                                                size="compact-sm"
                                                variant="subtle"
                                                color="brass"
                                                loading={
                                                    reread.isPending &&
                                                    reread.variables === item.mediaId
                                                }
                                                onClick={() =>
                                                    reread.mutate(item.mediaId, {
                                                        onSuccess: () =>
                                                            setOutcome({
                                                                ok: true,
                                                                message: `${fileNameOf(item.relPath)} will be read again. It leaves this list if it reads this time.`,
                                                            }),
                                                        onError: (error) =>
                                                            setOutcome({
                                                                ok: false,
                                                                message: errorText(error),
                                                            }),
                                                    })
                                                }
                                            >
                                                Read again
                                            </Button>
                                        )}
                                    </div>
                                </div>
                            </div>
                        )}
                    />
                </>
            )}

            {tickedItems.length > 0 && (
                <Paper className={barClasses.bar} shadow="md" radius="md" withBorder>
                    <Group gap="sm" wrap="wrap" justify="center">
                        <Text size="sm">
                            {plural(tickedItems.length, "file", "files")} ·{" "}
                            {formatBytes(tickedBytes)}
                        </Text>
                        <Button
                            size="compact-sm"
                            color="oxblood"
                            onClick={() => setConfirming(true)}
                        >
                            {tab === "library" ? "Move to trash…" : "Delete forever…"}
                        </Button>
                        <Button
                            size="compact-sm"
                            variant="subtle"
                            color="gray"
                            onClick={() => setTicked(new Set())}
                        >
                            Clear
                        </Button>
                    </Group>
                </Paper>
            )}

            <Modal
                opened={confirming}
                onClose={() => setConfirming(false)}
                title={tab === "library" ? "Move to the trash?" : "Delete forever?"}
                centered
            >
                <Stack gap="md">
                    {tab === "library" ? (
                        <Text size="sm">
                            {plural(tickedItems.length, "file", "files")} (
                            {formatBytes(tickedBytes)}) will be moved off the media volume into the
                            trash on the data volume. The media volume gets the space back now; the
                            data volume holds it until the files are purged, which you can do from
                            the trash. Until then they can be restored.
                        </Text>
                    ) : (
                        <>
                            <Text size="sm">
                                {plural(tickedItems.length, "file", "files")} will be removed from
                                disk with everything recorded about them, and{" "}
                                {formatBytes(tickedBytes)} goes back to the data volume.
                            </Text>
                            <Text size="sm" fw={600}>
                                Nothing can be restored afterwards.
                            </Text>
                        </>
                    )}

                    {/* Cancel has the focus: a reflexive Enter must not be what deletes. */}
                    <Group justify="flex-end">
                        <Button
                            variant="default"
                            onClick={() => setConfirming(false)}
                            data-autofocus
                        >
                            Cancel
                        </Button>
                        <Button
                            color="oxblood"
                            loading={trash.isPending || purge.isPending}
                            onClick={act}
                        >
                            {tab === "library"
                                ? `Move ${tickedItems.length.toLocaleString()} to trash`
                                : `Delete ${tickedItems.length.toLocaleString()} forever`}
                        </Button>
                    </Group>
                </Stack>
            </Modal>
        </Stack>
    );
};
