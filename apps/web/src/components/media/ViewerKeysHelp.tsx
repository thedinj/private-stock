"use client";

import { Kbd, Modal, SimpleGrid, Stack, Table, Text } from "@mantine/core";

import { facetLabelPlural } from "@/lib/facetLabels";
import { VIEWER_KEY_GROUPS, VIEWER_KEYS, fieldTitle } from "@/lib/viewerKeys";

/**
 * Every key the viewer answers, opened with `?` (§14 "Hotkeys").
 *
 * Drawn from the one table the handlers are checked against, so it cannot list a key that does
 * something else. The fields are named in the room's words -- Players and Games in the Game
 * Room -- because that is what the headings over the boxes say.
 */
export const ViewerKeysHelp: React.FC<{ opened: boolean; onClose: () => void }> = ({
    opened,
    onClose,
}) => (
    <Modal opened={opened} onClose={onClose} title="Keys" size="xl">
        <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg" verticalSpacing="md">
            {VIEWER_KEY_GROUPS.map(({ group, title }) => (
                <Stack key={group} gap={4}>
                    <Text size="sm" fw={600}>
                        {title}
                    </Text>
                    <Table withRowBorders={false} verticalSpacing={2} horizontalSpacing="xs">
                        <Table.Tbody>
                            {VIEWER_KEYS.filter((binding) => binding.group === group).map(
                                (binding) => (
                                    <Table.Tr key={binding.shown}>
                                        <Table.Td w={110} style={{ whiteSpace: "nowrap" }}>
                                            <Kbd size="xs">{binding.shown}</Kbd>
                                        </Table.Td>
                                        <Table.Td>
                                            <Text size="xs">
                                                {binding.field
                                                    ? fieldTitle(binding.field, facetLabelPlural)
                                                    : binding.does}
                                            </Text>
                                        </Table.Td>
                                    </Table.Tr>
                                )
                            )}
                        </Table.Tbody>
                    </Table>
                </Stack>
            ))}
        </SimpleGrid>
    </Modal>
);
