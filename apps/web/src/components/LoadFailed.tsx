"use client";

import { Alert, Button, Group, Stack, Text } from "@mantine/core";

import { ApiError } from "@/lib/api/client";

/**
 * A read that did not come back (§14).
 *
 * The app had no such component, and the shape of the gap was consistent: every screen
 * treated *no data* as *no items*. The room reported "the cellar is empty", the grid offered
 * to clear filters that were not the problem, and both of them said so over a request that
 * had failed. A library that appears to have been emptied is the single most alarming thing
 * this app can put on a screen, and it was what a dropped Wi-Fi connection produced.
 *
 * So: what happened, and a way to ask again. The distinction that matters is between a fault
 * on this side and a fault on the other — "check your connection" is useless advice when the
 * server is the one having the problem, and vice versa.
 */

const explain = (error: unknown): { title: string; detail: string } => {
    // Checked first: an offline browser produces a `TypeError` from `fetch`, which carries no
    // status at all, and "something went wrong" is a poor way to say "you have no network".
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
        return {
            title: "You are offline",
            detail: "This device has no network connection. Nothing has been lost.",
        };
    }

    if (error instanceof ApiError) {
        if (error.status === 403) {
            return {
                title: "Not yours to see",
                detail: "This account does not have access to it.",
            };
        }

        if (error.status === 404) {
            return { title: "No longer there", detail: "It has been moved or removed." };
        }

        if (error.status === 429) {
            return {
                title: "Too many requests",
                detail: "The server is rate limiting this device. Wait a moment and try again.",
            };
        }

        if (error.status >= 500) {
            return {
                title: "The server could not answer",
                detail: `${error.message}${error.requestId ? ` (${error.requestId})` : ""}`,
            };
        }

        return { title: "That did not work", detail: error.message };
    }

    // A fetch that never reached the server: the box is off, asleep, or off the network. Said
    // plainly, because on a NAS at home this is the likeliest failure of all and the fix is
    // rarely in the browser.
    return {
        title: "Could not reach the server",
        detail: "It may be asleep or restarting. Nothing has been lost.",
    };
};

interface LoadFailedProps {
    error: unknown;
    /** Asking again. The button is absent without it, rather than doing nothing. */
    onRetry?: () => void;
    /** What failed to load, when the surrounding page does not already say. */
    what?: string;
}

export const LoadFailed: React.FC<LoadFailedProps> = ({ error, onRetry, what }) => {
    const { title, detail } = explain(error);

    return (
        <Alert color="oxblood" variant="light" title={what ? `${title} — ${what}` : title}>
            <Stack gap="sm" align="flex-start">
                <Text size="sm">{detail}</Text>
                {onRetry && (
                    <Group gap="sm">
                        <Button size="xs" variant="default" onClick={onRetry}>
                            Try again
                        </Button>
                    </Group>
                )}
            </Stack>
        </Alert>
    );
};
