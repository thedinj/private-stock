"use client";

import { useState } from "react";
import { Alert, Button, Group, Modal, Stack, Text, TextInput } from "@mantine/core";

import { REVIEW_PASS_NAME_MAX, domainProfiles, type ReviewPass } from "@private-stock/core";

import { getActiveDomain } from "@/lib/activeDomain";
import { ApiError } from "@/lib/api/client";
import { useCreateReviewPass } from "@/lib/api/reviewPasses";

/**
 * Naming a new review pass (§14d), in this room. Asked for from the viewer's Review menu, on
 * its own when review mode is turned on with no pass to review for, and from Account › Review
 * passes -- where nothing starts, so the button says what it does there.
 */
export const NameReviewPass: React.FC<{
    opened: boolean;
    onClose: () => void;
    onCreated: (pass: ReviewPass) => void;
    /** The button: "Start reviewing" from the viewer, where making it starts review mode. */
    confirmLabel?: string;
}> = ({ opened, onClose, onCreated, confirmLabel = "Start reviewing" }) => {
    const [name, setName] = useState("");
    const create = useCreateReviewPass();

    const submit = () => {
        const trimmed = name.trim();

        if (!trimmed || create.isPending) return;

        create.mutate(trimmed, {
            onSuccess: (pass) => {
                setName("");
                create.reset();
                onCreated(pass);
            },
        });
    };

    return (
        <Modal opened={opened} onClose={onClose} title="Name this review pass" centered>
            <Stack gap="md">
                <TextInput
                    label="Name"
                    placeholder="Players"
                    description={`What you are going through the items for. Yours, in the ${
                        domainProfiles[getActiveDomain()].label
                    }.`}
                    value={name}
                    maxLength={REVIEW_PASS_NAME_MAX}
                    data-autofocus
                    onChange={(event) => setName(event.currentTarget.value)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") submit();
                    }}
                />

                {create.error && (
                    <Alert color="oxblood" variant="light">
                        {create.error instanceof ApiError
                            ? create.error.message
                            : "Could not make the pass"}
                    </Alert>
                )}

                <Text size="xs" c="dimmed">
                    In review mode, d marks the item reviewed for it and goes to the next.
                </Text>

                <Group justify="flex-end">
                    <Button variant="subtle" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button
                        color="brass"
                        loading={create.isPending}
                        disabled={!name.trim()}
                        onClick={submit}
                    >
                        {confirmLabel}
                    </Button>
                </Group>
            </Stack>
        </Modal>
    );
};
