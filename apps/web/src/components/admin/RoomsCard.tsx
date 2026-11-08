"use client";

import { useState } from "react";
import { Accordion, Alert, Stack, Switch, Text } from "@mantine/core";

import { domainKinds, domainProfiles, type DomainKind } from "@private-stock/core";

import { useRooms, useSwitchRoom } from "@/lib/api/rooms";

const nameList = (kinds: readonly DomainKind[]): string => {
    const names = kinds.map((kind) => domainProfiles[kind].label);

    return names.length <= 1
        ? (names[0] ?? "")
        : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
};

/**
 * Which rooms the household can go into (§21 "Turning a room off"), on Libraries because every
 * library is in one.
 *
 * Every room is listed here, the ones that are off included, so one can be turned back on. Each
 * switch saves as it moves: three switches have no draft worth keeping. The last room on cannot
 * be switched off, which the server refuses as well.
 */
export const RoomsCard: React.FC = () => {
    const { data } = useRooms();
    const switchRoom = useSwitchRoom();
    const [opened, setOpened] = useState<string | null>(null);

    const enabled = data?.enabled ?? [];
    const off = domainKinds.filter((kind) => !enabled.includes(kind));
    const summary = !data
        ? ""
        : off.length === 0
          ? "Every room is on"
          : `${nameList(off)} ${off.length === 1 ? "is" : "are"} off`;

    return (
        <Accordion variant="separated" chevronPosition="left" value={opened} onChange={setOpened}>
            <Accordion.Item value="rooms">
                <Accordion.Control>
                    <Text size="sm" fw={500}>
                        Rooms
                    </Text>
                    <Text size="xs" c="dimmed">
                        {summary}
                    </Text>
                </Accordion.Control>
                <Accordion.Panel>
                    <Stack gap="md">
                        <Text size="sm" c="dimmed">
                            A room that is off is only hidden from navigation, for everyone. Its
                            libraries keep being scanned and processed, and are as they were when it
                            is turned back on.
                        </Text>

                        {domainKinds.map((kind) => {
                            const on = enabled.includes(kind);
                            const last = on && enabled.length === 1;

                            return (
                                <Switch
                                    key={kind}
                                    label={domainProfiles[kind].label}
                                    description={last ? "The only room on" : undefined}
                                    checked={on}
                                    disabled={!data || last || switchRoom.isPending}
                                    onChange={(event) =>
                                        switchRoom.mutate({
                                            room: kind,
                                            enabled: event.currentTarget.checked,
                                        })
                                    }
                                />
                            );
                        })}

                        {switchRoom.isError && (
                            <Alert color="oxblood" variant="light">
                                {switchRoom.error.message}
                            </Alert>
                        )}
                    </Stack>
                </Accordion.Panel>
            </Accordion.Item>
        </Accordion>
    );
};
