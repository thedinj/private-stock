"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button, Group } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";

import type { DupeListResponse } from "@private-stock/core";

import { api } from "@/lib/api/client";
import { useOcrCounts } from "@/lib/api/ocr";
import { queryKeys } from "@/lib/api/queryKeys";
import { useRememberedHref } from "@/lib/rememberedPages";

/**
 * The review queues, one row above whichever is open (§12c).
 *
 * Five queues behind one sidebar entry: each is a list of decisions about files, and none of
 * them is visited every day. A count beside a queue only where it is cheap to know -- duplicates
 * and OCR have count endpoints of their own; faces, the unreadable list and the trash would cost a
 * page load to count, and say their size on their own page.
 *
 * The counts are of videos, because that is what each queue opens on: a number here that the
 * queue then did not show would send somebody looking for decisions behind its Photos control.
 */
const QueueLink: React.FC<{ path: string; label: string; count?: number }> = ({
    path,
    label,
    count,
}) => {
    const pathname = usePathname();
    const href = useRememberedHref(path);
    const active = pathname === path;

    return (
        <Button
            component={Link}
            prefetch={false}
            href={href}
            size="compact-sm"
            variant={active ? "light" : "subtle"}
            color={active ? "brass" : "gray"}
            aria-current={active ? "page" : undefined}
        >
            {count === undefined || count === 0 ? label : `${label} · ${count.toLocaleString()}`}
        </Button>
    );
};

export const ReviewQueues: React.FC = () => {
    const { data: dupes } = useQuery({
        // The page's own request for its default view, so the two share a cache entry.
        queryKey: queryKeys.dupes.counts("video"),
        queryFn: () => api<DupeListResponse>("/api/dupes?limit=1&media=video"),
    });
    const ocr = useOcrCounts();

    return (
        <Group gap={4} wrap="wrap" component="nav" aria-label="Review queues">
            <QueueLink
                path="/review/duplicates"
                label="Duplicates"
                count={dupes ? dupes.pending.exact + dupes.pending.near : undefined}
            />
            <QueueLink path="/review/ocr" label="OCR" count={ocr.data?.waiting.video} />
            <QueueLink path="/review/faces" label="Faces" />
            <QueueLink path="/review/unreadable" label="Unreadable" />
            <QueueLink path="/review/trash" label="Trash" />
        </Group>
    );
};
