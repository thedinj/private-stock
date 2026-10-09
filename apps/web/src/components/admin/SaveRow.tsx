"use client";

import { Button, Group, Text } from "@mantine/core";

/** The foot of every settings card: Save, and one line on when it takes effect. */
export const SaveRow: React.FC<{
    onSave: () => void;
    saving: boolean;
    dirty: boolean;
    note?: React.ReactNode;
}> = ({ onSave, saving, dirty, note }) => (
    <Group gap="sm">
        <Button onClick={onSave} loading={saving} disabled={!dirty}>
            Save
        </Button>
        {note && (
            <Text size="xs" c="dimmed">
                {note}
            </Text>
        )}
    </Group>
);
