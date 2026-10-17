"use client";

import { useState } from "react";
import { Button, Group, Text } from "@mantine/core";

import { useOriginalLink } from "@/lib/api/media";

/**
 * Handing a file this browser refused to a player that will play it (§8, "Open in another app").
 *
 * The link is the original's bytes with a signed token in it (§12d), because the other app has
 * no way to sign in. On Android it opens straight away: an `intent:` link offers every installed
 * video player, VLC among them. Elsewhere there is no such hand-off -- VLC on Windows registers
 * no link type -- so the link is copied, to paste into VLC's "Open Network Stream". The token
 * lasts a day, which covers a film and its pauses.
 */

const onAndroid = (): boolean =>
    typeof navigator !== "undefined" && /Android/.test(navigator.userAgent);

/** An `intent:` link for any app that plays video, from the address it should open. */
const intentFor = (url: URL): string =>
    `intent://${url.host}${url.pathname}${url.search}` +
    `#Intent;scheme=${url.protocol.replace(":", "")};type=video/*;end`;

export const OpenElsewhere: React.FC<{ mediaId: string }> = ({ mediaId }) => {
    const link = useOriginalLink(mediaId);
    const [copied, setCopied] = useState(false);
    const [failed, setFailed] = useState(false);
    const android = onAndroid();

    const go = async () => {
        setFailed(false);

        try {
            const { path } = await link.mutateAsync();
            const url = new URL(path, window.location.origin);

            if (android) {
                window.location.href = intentFor(url);
            } else {
                await navigator.clipboard.writeText(url.toString());
                setCopied(true);
            }
        } catch {
            setFailed(true);
        }
    };

    return (
        <Group gap="sm" align="center" wrap="wrap">
            <Button
                size="xs"
                variant="light"
                color="brass"
                loading={link.isPending}
                onClick={() => void go()}
            >
                {android ? "Open in another app" : copied ? "Link copied" : "Copy stream link"}
            </Button>
            {copied && !android && (
                <Text size="xs" c="dimmed">
                    In VLC: Media › Open Network Stream, and paste. Works for a day.
                </Text>
            )}
            {failed && (
                <Text size="xs" c="oxblood">
                    Could not make a link.
                </Text>
            )}
        </Group>
    );
};
