"use client";

import { useEffect, useState } from "react";
import { Affix, Button, CloseButton, Group, Paper, Text } from "@mantine/core";

import { useBuildCheck } from "@/lib/api/build";

/** The server build a reload was last attempted for, so a reload that changes nothing is not repeated. */
const RELOADED_FOR = "ps.reloadedForBuild";

const readReloadedFor = (): string | null => {
    try {
        return sessionStorage.getItem(RELOADED_FOR);
    } catch {
        return null;
    }
};

const writeReloadedFor = (id: string): void => {
    try {
        sessionStorage.setItem(RELOADED_FOR, id);
    } catch {
        // Without storage there is no loop guard; the notice is offered instead (below).
    }
};

/**
 * Whether reloading now would take something from the person using the page: a video or
 * audio element playing, or a field with the focus, which may hold typing not yet saved.
 */
const isBusy = (): boolean => {
    for (const element of document.querySelectorAll("video, audio")) {
        if (element instanceof HTMLMediaElement && !element.paused && !element.ended) {
            return true;
        }
    }

    const focused = document.activeElement;

    return (
        focused instanceof HTMLInputElement ||
        focused instanceof HTMLTextAreaElement ||
        focused instanceof HTMLSelectElement ||
        (focused instanceof HTMLElement && focused.isContentEditable)
    );
};

/**
 * Picks up a new build (§14, "Installing").
 *
 * **Silently when nothing is lost.** The usual case is the app coming back from the background
 * after a deploy, nothing playing and nothing half-typed; the page reloads where it stands —
 * the URL carries the view — and the person sees the new build without being asked.
 *
 * **Otherwise it asks**, rather than stopping a film or discarding a note. It also asks rather
 * than reloading a second time for the same server build: if the page still disagrees after a
 * reload, reloading again would only loop.
 */
export const UpdateNotice: React.FC = () => {
    const check = useBuildCheck();
    const [dismissedFor, setDismissedFor] = useState<string | null>(null);
    const [offeredFor, setOfferedFor] = useState<string | null>(null);

    const serverId = check?.stale ? check.serverId : null;

    useEffect(() => {
        if (serverId === null) return;

        if (isBusy() || readReloadedFor() === serverId) {
            setOfferedFor(serverId);
            return;
        }

        writeReloadedFor(serverId);
        window.location.reload();
    }, [serverId]);

    if (offeredFor === null || offeredFor !== serverId || dismissedFor === serverId) return null;

    return (
        <Affix
            position={{
                bottom: "calc(var(--mantine-spacing-md) + var(--ps-safe-bottom))",
                left: 0,
                right: 0,
            }}
            zIndex={400}
        >
            <Group justify="center" px="md">
                <Paper withBorder shadow="md" radius="md" px="md" py="xs" maw={480} w="100%">
                    <Group justify="space-between" wrap="nowrap" gap="sm">
                        <Text size="sm">A new version is ready.</Text>
                        <Group gap={4} wrap="nowrap">
                            <Button
                                size="sm"
                                h={44}
                                onClick={() => {
                                    writeReloadedFor(serverId ?? "");
                                    window.location.reload();
                                }}
                            >
                                Reload
                            </Button>
                            <CloseButton
                                size="xl"
                                aria-label="Not now"
                                onClick={() => setDismissedFor(serverId)}
                            />
                        </Group>
                    </Group>
                </Paper>
            </Group>
        </Affix>
    );
};
