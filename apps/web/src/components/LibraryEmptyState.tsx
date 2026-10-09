"use client";

import Link from "next/link";
import { Button, Center, Code, Loader, Stack, Text } from "@mantine/core";

import type { LibraryStats } from "@private-stock/core";

import { useAuth } from "@/lib/api/AuthProvider";

/**
 * Why the library is empty.
 *
 * "0 items" is the least useful thing this screen can say. There are four quite different
 * reasons for an empty grid, and only one of them means "nothing to do":
 *
 *   - no directories mounted at all
 *   - directories found, but none enabled (the default for a newly discovered root)
 *   - enabled and scanning right now
 *   - scanned, genuinely empty — or a filter is hiding everything
 *
 * Roots start disabled deliberately: mounting a multi-terabyte share should not kick off a
 * scan of it. The cost of that safety is this screen having to say so, otherwise a first run
 * is an empty grid with no visible cause.
 */
interface LibraryEmptyStateProps {
    stats: LibraryStats | undefined;
    /** True when filters are active, so "no matches" can be distinguished from "no library". */
    filtered: boolean;
    onClearFilters: () => void;
}

export const LibraryEmptyState: React.FC<LibraryEmptyStateProps> = ({
    stats,
    filtered,
    onClearFilters,
}) => {
    const { hasScope } = useAuth();
    const isAdmin = hasScope("admin");

    const body = (() => {
        if (!stats) {
            return { title: "Loading…", detail: null, action: null };
        }

        if (stats.scanning) {
            return {
                title: "Scanning…",
                detail: "Items will appear here as they are found.",
                action: null,
                busy: true,
            };
        }

        if (stats.rootsTotal === 0) {
            return {
                title: "No media folders found",
                detail: (
                    <>
                        Mount your media directories under the configured media folder — each
                        subdirectory becomes a library root. In development that is{" "}
                        <Code>media/</Code> at the repository root.
                    </>
                ),
                action: null,
            };
        }

        if (stats.rootsEnabled === 0) {
            return {
                title: `${stats.rootsTotal} media folder${stats.rootsTotal === 1 ? "" : "s"} found, but none are enabled`,
                detail: isAdmin ? (
                    <>
                        New folders start disabled so that mounting a share never begins scanning it
                        unasked. Enable the ones you want indexed.
                    </>
                ) : (
                    "Ask an administrator to enable them."
                ),
                action: isAdmin ? (
                    <Button component={Link} href="/admin/libraries" variant="light">
                        Open Libraries
                    </Button>
                ) : null,
            };
        }

        if (!stats.everScanned) {
            return {
                title: "Waiting for the first scan",
                detail: "The worker picks this up within a few seconds of starting.",
                action: isAdmin ? (
                    <Button component={Link} href="/admin/libraries" variant="light">
                        Open Libraries
                    </Button>
                ) : null,
                busy: true,
            };
        }

        if (filtered) {
            return {
                title: "Nothing matches",
                detail: "No items match the current search and filters.",
                action: (
                    <Button variant="light" onClick={onClearFilters}>
                        Clear filters
                    </Button>
                ),
            };
        }

        return {
            title: "Nothing here yet",
            detail: "The scan found no supported media. New files are picked up automatically.",
            action: isAdmin ? (
                <Button component={Link} href="/admin/libraries" variant="light">
                    Libraries
                </Button>
            ) : null,
        };
    })();

    return (
        <Center h={280} px="md">
            <Stack align="center" gap="sm" maw={460}>
                {body.busy && <Loader size="sm" color="brass" />}
                <Text fw={500} ta="center">
                    {body.title}
                </Text>
                {body.detail && (
                    <Text size="sm" c="dimmed" ta="center">
                        {body.detail}
                    </Text>
                )}
                {body.action}
            </Stack>
        </Center>
    );
};
