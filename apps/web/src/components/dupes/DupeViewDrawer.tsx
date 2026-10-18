"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button, Drawer, Group, SegmentedControl, Stack, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";

import type { DupeMember } from "@private-stock/core";

import { FileName } from "@/components/faces/FileName";
import { KeyTip } from "@/components/KeyTip";
import { ReleasingVideo } from "@/components/media/ReleasingVideo";
import { formatDuration } from "@/lib/dupeTriage";
import { rememberReturn } from "@/lib/returnTo";
import { isTypingTarget } from "@/lib/typingTarget";
import { useCloseOnBack } from "@/lib/useCloseOnBack";

/**
 * A copy played beside the sheet rather than instead of it (§10i), as a face is (§5f "Checking
 * faces quickly"): for the look-alike a closer look could not settle. Closing it returns to the
 * row as it was -- the choices are the sheet's, not this drawer's.
 *
 * **Every copy of the group is one press away, at the same moment.** Whether two look-alikes are
 * the same video is settled by watching one and then the other at the same point, so switching
 * copies keeps the time, and a digit switches without reaching for the pointer. The time is kept
 * as it is rather than as a share of the length: copies of one video run within a second or two
 * of each other, and the same second is closer to the same frame than the same percentage is.
 *
 * **It decides, too.** Watching is how a look-alike gets settled, so the answer is given where
 * the watching happened: `y` or "These are the same", `n` or "None match". Either closes the
 * drawer and moves the sheet on to the next group.
 */
export const DupeViewDrawer: React.FC<{
    /** The group's copies, in the order the row shows them. */
    members: DupeMember[];
    /** The copy playing, or null when closed. */
    viewingId: string | null;
    onView: (memberId: string) => void;
    onClose: () => void;
    /** Decides the group as the same thing; null where it cannot be, or is already decided. */
    onSame: (() => void) | null;
    /** Decides that none of its copies match; null where that cannot be said. */
    onNoneMatch: (() => void) | null;
}> = ({ members, viewingId, onView, onClose, onSame, onNoneMatch }) => {
    const isPhone = useMediaQuery("(max-width: 48em)");
    const video = useRef<HTMLVideoElement | null>(null);
    /** Where the last copy was when another was chosen; the next one starts there. */
    const [atMs, setAtMs] = useState(0);
    const member = members.find((candidate) => candidate.id === viewingId) ?? null;
    const open = member !== null;

    // Back closes it, not the sheet under it.
    useCloseOnBack(open, onClose);

    const switchTo = (memberId: string): void => {
        if (memberId === viewingId) return;

        setAtMs(Math.round((video.current?.currentTime ?? 0) * 1000));
        onView(memberId);
    };

    const switchRef = useRef(switchTo);
    switchRef.current = switchTo;
    const decideRef = useRef({ onSame, onNoneMatch });
    decideRef.current = { onSame, onNoneMatch };

    // A digit plays that copy, as it chooses one on the row; `y` and `n` decide the group.
    useEffect(() => {
        if (!open) return;

        const listener = (event: KeyboardEvent) => {
            if (event.ctrlKey || event.metaKey || event.altKey || isTypingTarget(event.target)) {
                return;
            }

            const target = /^[1-9]$/.test(event.key) ? members[Number(event.key) - 1] : undefined;
            const decide =
                event.key === "y"
                    ? decideRef.current.onSame
                    : event.key === "n"
                      ? decideRef.current.onNoneMatch
                      : null;

            if (target) {
                event.preventDefault();
                switchRef.current(target.id);
            } else if (decide) {
                event.preventDefault();
                decide();
            }
        };

        window.addEventListener("keydown", listener);

        return () => window.removeEventListener("keydown", listener);
    }, [open, members]);

    // A fresh look starts at the beginning.
    useEffect(() => {
        if (!open) setAtMs(0);
    }, [open]);

    const src = member ? `/api/media/${encodeURIComponent(member.id)}/stream` : "";

    return (
        <Drawer
            opened={open}
            onClose={onClose}
            position={isPhone ? "bottom" : "right"}
            size={isPhone ? "85%" : "xl"}
            title={member ? <FileName mediaId={member.id} /> : "The copy"}
            removeScrollProps={{ allowPinchZoom: true }}
        >
            {member && (
                <Stack gap="sm">
                    {members.length > 1 && (
                        <SegmentedControl
                            size="xs"
                            color="brass"
                            fullWidth
                            value={member.id}
                            onChange={switchTo}
                            data={members.map((candidate, index) => ({
                                value: candidate.id,
                                label: `${index + 1} · ${
                                    candidate.width && candidate.height
                                        ? `${candidate.width}×${candidate.height}`
                                        : formatDuration(candidate.durationMs)
                                }`,
                            }))}
                        />
                    )}

                    {member.kind === "video" ? (
                        <ReleasingVideo
                            key={member.id}
                            ref={video}
                            src={src}
                            controls
                            autoPlay
                            // Autoplay is allowed only muted; the controls unmute it.
                            muted
                            playsInline
                            style={{
                                width: "100%",
                                borderRadius: 6,
                                background: "var(--mantine-color-black)",
                            }}
                            onLoadedMetadata={(event) => {
                                event.currentTarget.currentTime = atMs / 1000;
                            }}
                        />
                    ) : (
                        // eslint-disable-next-line @next/next/no-img-element -- an original, served as it is
                        <img
                            key={member.id}
                            src={src}
                            alt="The copy"
                            style={{ width: "100%", borderRadius: 6 }}
                        />
                    )}

                    <Text size="xs" c="dimmed">
                        {members.length > 1
                            ? "Switching copies keeps the moment. Your choices on the row stay as they are."
                            : "Your choices on the row stay as they are."}
                    </Text>
                    {(onSame || onNoneMatch) && (
                        <Group gap="xs">
                            {onSame && (
                                <KeyTip
                                    label="Keep the chosen copy and trash the rest, then on to the next group"
                                    keys={["y"]}
                                >
                                    <Button variant="light" color="brass" onClick={onSame}>
                                        These are the same
                                    </Button>
                                </KeyTip>
                            )}
                            {onNoneMatch && (
                                <KeyTip
                                    label="Keep every copy and never offer them as duplicates again, then on to the next group"
                                    keys={["n"]}
                                >
                                    <Button variant="subtle" color="oxblood" onClick={onNoneMatch}>
                                        None match
                                    </Button>
                                </KeyTip>
                            )}
                        </Group>
                    )}
                    <Text size="xs" c="dimmed" visibleFrom="sm">
                        {members.length > 1 && (
                            <>
                                <kbd>1</kbd>–<kbd>{Math.min(members.length, 9)}</kbd> switch copy
                                ·{" "}
                            </>
                        )}
                        {onSame && (
                            <>
                                <kbd>y</kbd> the same ·{" "}
                            </>
                        )}
                        {onNoneMatch && (
                            <>
                                <kbd>n</kbd> none match ·{" "}
                            </>
                        )}
                        <kbd>Esc</kbd> back to the list
                    </Text>
                    <Group>
                        <Button
                            component={Link}
                            href={`/media/${member.id}`}
                            onClick={rememberReturn}
                            prefetch={false}
                            variant="subtle"
                            color="gray"
                        >
                            Open the full item
                        </Button>
                    </Group>
                </Stack>
            )}
        </Drawer>
    );
};
