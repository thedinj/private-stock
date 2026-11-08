"use client";

import { useState } from "react";
import { Alert, Button, Card, Collapse, Group, Stack, Text, TextInput, Title } from "@mantine/core";

import {
    REVIEW_PASS_NAME_MAX,
    domainKinds,
    domainProfiles,
    type ReviewPass,
} from "@private-stock/core";

import { NameReviewPass } from "@/components/media/NameReviewPass";
import { getActiveDomain } from "@/lib/activeDomain";
import { ApiError } from "@/lib/api/client";
import {
    useAllReviewPasses,
    useDeleteReviewPass,
    useRenameReviewPass,
} from "@/lib/api/reviewPasses";

const marksIn = (count: number): string => `${count} item${count === 1 ? "" : "s"} marked`;

const failure = (caught: unknown, fallback: string): string =>
    caught instanceof ApiError ? caught.message : fallback;

/** One pass: its name and count, renamed in place, deleted after saying what goes with it. */
const PassRow: React.FC<{ pass: ReviewPass }> = ({ pass }) => {
    const [editing, setEditing] = useState<string | null>(null);
    const [confirming, setConfirming] = useState(false);
    const rename = useRenameReviewPass();
    const remove = useDeleteReviewPass();

    const save = () => {
        const name = editing?.trim();

        if (!name || name === pass.name) {
            setEditing(null);
            return;
        }

        rename.mutate({ passId: pass.id, name }, { onSuccess: () => setEditing(null) });
    };

    if (editing !== null) {
        return (
            <Stack gap={4}>
                <Group gap="xs" wrap="nowrap" align="flex-start">
                    <TextInput
                        aria-label="Name"
                        value={editing}
                        maxLength={REVIEW_PASS_NAME_MAX}
                        style={{ flex: 1 }}
                        data-autofocus
                        onChange={(event) => setEditing(event.currentTarget.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") save();
                            if (event.key === "Escape") setEditing(null);
                        }}
                    />
                    <Button color="brass" loading={rename.isPending} onClick={save}>
                        Save
                    </Button>
                    <Button variant="subtle" onClick={() => setEditing(null)}>
                        Cancel
                    </Button>
                </Group>
                {rename.error && (
                    <Text size="xs" c="oxblood">
                        {failure(rename.error, "Could not rename the pass")}
                    </Text>
                )}
            </Stack>
        );
    }

    if (confirming) {
        return (
            <Stack gap={6}>
                <Text size="sm">
                    {pass.marks === 0
                        ? `Delete ${pass.name}? Nothing is marked for it.`
                        : `Delete ${pass.name} and its ${pass.marks} mark${pass.marks === 1 ? "" : "s"}?`}
                </Text>
                <Group gap="xs">
                    <Button variant="default" onClick={() => setConfirming(false)}>
                        Cancel
                    </Button>
                    <Button
                        color="oxblood"
                        loading={remove.isPending}
                        onClick={() => remove.mutate(pass.id)}
                    >
                        Delete
                    </Button>
                </Group>
                {remove.error && (
                    <Text size="xs" c="oxblood">
                        {failure(remove.error, "Could not delete the pass")}
                    </Text>
                )}
            </Stack>
        );
    }

    return (
        <Group justify="space-between" wrap="nowrap" gap="xs">
            <Stack gap={0} style={{ minWidth: 0 }}>
                <Text size="sm" truncate="end">
                    {pass.name}
                </Text>
                <Text size="xs" c="dimmed">
                    {marksIn(pass.marks)}
                </Text>
            </Stack>
            <Group gap={4} wrap="nowrap">
                <Button variant="subtle" onClick={() => setEditing(pass.name)}>
                    Rename
                </Button>
                <Button variant="subtle" color="oxblood" onClick={() => setConfirming(true)}>
                    Delete
                </Button>
            </Group>
        </Group>
    );
};

/**
 * Your review passes, by room (§14d): renamed and deleted here, made from an item's Review menu.
 *
 * Collapsed, and not even asked for until opened: people keep a handful and come back to this
 * rarely. Deleting says how many marks go with the pass, in the page rather than a browser
 * dialogue, because that number is the thing worth reading before agreeing.
 */
export const ReviewPassesCard: React.FC = () => {
    const [open, setOpen] = useState(false);
    const [naming, setNaming] = useState(false);
    const { data, error, isLoading } = useAllReviewPasses(open);
    const passes = data?.passes ?? [];

    return (
        <Card p="md">
            <Stack gap="md">
                <Group justify="space-between" wrap="nowrap" align="flex-start">
                    {/* The text takes what is left; the button keeps its own width, or the
                        nowrap row squeezed it until its caption no longer fit. */}
                    <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
                        <Title order={4}>Review passes</Title>
                        <Text size="sm" c="dimmed">
                            What you go through items for, one room at a time. New ones are made
                            here or from an item&apos;s Review menu.
                        </Text>
                    </Stack>
                    <Button
                        variant="default"
                        style={{ flexShrink: 0 }}
                        aria-expanded={open}
                        onClick={() => setOpen((current) => !current)}
                    >
                        {open ? "Hide" : "Show"}
                    </Button>
                </Group>

                <Collapse in={open}>
                    <Stack gap="lg">
                        {/* The viewer's own naming dialog: a pass is made in the room you are
                            in, so the button names it. */}
                        <Group>
                            <Button variant="light" color="brass" onClick={() => setNaming(true)}>
                                New pass in the {domainProfiles[getActiveDomain()].label}
                            </Button>
                        </Group>
                        {error && (
                            <Alert color="oxblood" variant="light">
                                Could not load your review passes
                            </Alert>
                        )}
                        {!isLoading && !error && passes.length === 0 && (
                            <Text size="sm" c="dimmed">
                                None yet.
                            </Text>
                        )}
                        {domainKinds
                            .filter((room) => passes.some((pass) => pass.domain === room))
                            .map((room) => (
                                <Stack key={room} gap="xs">
                                    <Text size="xs" tt="uppercase" fw={600} c="dimmed">
                                        {domainProfiles[room].label}
                                    </Text>
                                    {passes
                                        .filter((pass) => pass.domain === room)
                                        .map((pass) => (
                                            <PassRow key={pass.id} pass={pass} />
                                        ))}
                                </Stack>
                            ))}
                    </Stack>
                </Collapse>
            </Stack>

            <NameReviewPass
                opened={naming}
                onClose={() => setNaming(false)}
                onCreated={() => setNaming(false)}
                confirmLabel="Create"
            />
        </Card>
    );
};
