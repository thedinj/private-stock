"use client";

import { ActionIcon, Group, Popover, SegmentedControl, Stack, Switch, Text } from "@mantine/core";

import { MutedGlyph, SoundGlyph } from "@/components/media/Glyph";
import {
    TASTING_LENGTH_DATA,
    snapTastingSeconds,
    type TastingSeconds,
} from "@/lib/tasting/lengths";

/**
 * The showcase's one setting, the spotlight: whether one tile at a time plays with sound, and
 * for how long (§14f).
 *
 * The clip length is the tasting's own preference, not a copy of it: a taste in the wall and a
 * taste full screen are the same few seconds of the same film.
 */

interface ShowcaseSoundMenuProps {
    opened: boolean;
    onOpened: (opened: boolean) => void;
    sound: boolean;
    onSound: (sound: boolean) => void;
    muted: boolean;
    onMuted: (muted: boolean) => void;
    clipSeconds: TastingSeconds;
    onClipSeconds: (seconds: TastingSeconds) => void;
}

export const ShowcaseSoundMenu: React.FC<ShowcaseSoundMenuProps> = ({
    opened,
    onOpened,
    sound,
    onSound,
    muted,
    onMuted,
    clipSeconds,
    onClipSeconds,
}) => (
    <Popover opened={opened} onChange={onOpened} position="bottom-end" withArrow shadow="md">
        <Popover.Target>
            <ActionIcon
                variant={sound ? "light" : "subtle"}
                color={sound ? "brass" : "gray"}
                size={44}
                radius="xl"
                aria-label="Spotlight (S)"
                aria-pressed={sound}
                onClick={() => onOpened(!opened)}
            >
                {sound && !muted ? <SoundGlyph /> : <MutedGlyph />}
            </ActionIcon>
        </Popover.Target>
        <Popover.Dropdown>
            <Stack gap="sm" maw={300}>
                <Switch
                    size="md"
                    color="brass"
                    checked={sound}
                    onChange={(event) => onSound(event.currentTarget.checked)}
                    label="Spotlight"
                    description="One tile at a time plays a few seconds with sound, then passes to the next."
                />
                <div>
                    <Text size="xs" c="dimmed" mb={4}>
                        Each clip
                    </Text>
                    <SegmentedControl
                        size="sm"
                        disabled={!sound}
                        value={String(clipSeconds)}
                        onChange={(value) => onClipSeconds(snapTastingSeconds(value, clipSeconds))}
                        data={TASTING_LENGTH_DATA}
                    />
                </div>
                <Group justify="space-between">
                    <Text size="sm">Mute (M)</Text>
                    <Switch
                        size="md"
                        color="brass"
                        disabled={!sound}
                        checked={muted}
                        onChange={(event) => onMuted(event.currentTarget.checked)}
                        aria-label="Mute"
                    />
                </Group>
            </Stack>
        </Popover.Dropdown>
    </Popover>
);
