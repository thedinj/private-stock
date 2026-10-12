"use client";

import { useEffect, useState } from "react";
import { Anchor, Divider, Modal, Stack, Switch, Text, Title, UnstyledButton } from "@mantine/core";

import { CorkStamp } from "@/components/shell/CorkStamp";
import { useAuth } from "@/lib/api/AuthProvider";
import { buildInfo } from "@/lib/buildInfo";
import { recordTap, tapsRemaining } from "@/lib/tapUnlock";
import { deviceWarmingRefusal } from "@/lib/videoWarming";
import { setEnabled, useWarmingHudEnabled } from "@/lib/warmMonitor";

/**
 * What this is and which build of it is running, with the admin tools behind the build line.
 *
 * **The tools are hidden, not secret.** Seven taps on the build line is the phone's
 * developer-options gesture: a door that is there for whoever knows, and out of the way of
 * everyone else. The gate is the `admin` scope, checked here; to anybody without it the line is
 * only a line. What is behind it is diagnostics for this device -- nothing there changes the
 * library or anybody else's view of it -- so per-device `localStorage` is the right place for
 * both the unlock and the switches, like the playback preferences.
 */

const UNLOCK_KEY = "ps:adminTools";

/** Below this many taps to go, the count is shown -- the gesture's usual courtesy. */
const HINT_FROM = 3;

const readUnlocked = (): boolean => {
    try {
        return localStorage.getItem(UNLOCK_KEY) === "1";
    } catch {
        return false;
    }
};

const writeUnlocked = (value: boolean): void => {
    try {
        if (value) localStorage.setItem(UNLOCK_KEY, "1");
        else localStorage.removeItem(UNLOCK_KEY);
    } catch {
        // Not persisted; the tools stay open for this visit.
    }
};

const formatBuildDate = (iso: string): string | null => {
    const date = new Date(iso);

    return iso === "" || Number.isNaN(date.getTime())
        ? null
        : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};

interface AboutModalProps {
    opened: boolean;
    onClose: () => void;
}

export const AboutModal: React.FC<AboutModalProps> = ({ opened, onClose }) => {
    const { hasScope } = useAuth();
    const admin = hasScope("admin");

    const [unlocked, setUnlocked] = useState(false);
    const [taps, setTaps] = useState<number[]>([]);
    const [refusal, setRefusal] = useState<string | null>(null);
    const overlay = useWarmingHudEnabled();

    // After mount and on every opening: storage and the connection are the browser's, and the
    // connection may have changed since the dialog was last open.
    useEffect(() => {
        if (!opened) return;

        setUnlocked(readUnlocked());
        setRefusal(deviceWarmingRefusal());
        setTaps([]);
    }, [opened]);

    const remaining = tapsRemaining(taps);

    const tap = () => {
        if (!admin || unlocked) return;

        const run = recordTap(taps, performance.now());

        setTaps(run);

        if (tapsRemaining(run) === 0) {
            setUnlocked(true);
            writeUnlocked(true);
        }
    };

    const lock = () => {
        setUnlocked(false);
        setTaps([]);
        writeUnlocked(false);
    };

    const builtAt = formatBuildDate(buildInfo.date);

    return (
        <Modal opened={opened} onClose={onClose} title="About" centered>
            <Stack gap="md">
                <Stack gap={4}>
                    <CorkStamp size={104} />
                    <Title order={3}>private-stock</Title>
                    <Text size="sm" c="dimmed">
                        A self-hosted cataloguer and viewer for a large local library.
                    </Text>
                </Stack>

                <UnstyledButton
                    onClick={tap}
                    mih={44}
                    style={{ cursor: "default", userSelect: "none" }}
                >
                    <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
                        Build
                    </Text>
                    <Text ff="monospace" size="sm">
                        {buildInfo.sha}
                        {builtAt && (
                            <Text span c="dimmed" ff="inherit" inherit>
                                {" · "}
                                {builtAt}
                            </Text>
                        )}
                    </Text>
                    {admin && !unlocked && remaining > 0 && remaining <= HINT_FROM && (
                        <Text size="xs" c="dimmed" mt={2}>
                            {remaining === 1 ? "1 more tap" : `${remaining} more taps`}
                        </Text>
                    )}
                </UnstyledButton>

                {admin && unlocked && (
                    <Stack gap="sm">
                        <Divider label="Admin tools" labelPosition="left" />

                        <Switch
                            checked={overlay}
                            onChange={(event) => setEnabled(event.currentTarget.checked)}
                            label="Show warming overlay"
                            description="A badge over every player saying whether the next item is buffering, and how each join went. This device only."
                        />

                        <Text size="sm">
                            Warming on this device:{" "}
                            {refusal === null ? (
                                <Text span c="var(--ps-diag-ready)" inherit>
                                    allowed
                                </Text>
                            ) : (
                                <Text span c="var(--ps-diag-miss)" inherit>
                                    refused, {refusal}
                                </Text>
                            )}
                        </Text>

                        <Anchor component="button" size="sm" c="dimmed" onClick={lock} ta="left">
                            Hide admin tools
                        </Anchor>
                    </Stack>
                )}
            </Stack>
        </Modal>
    );
};
