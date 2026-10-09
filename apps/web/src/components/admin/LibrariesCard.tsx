"use client";

import { useState } from "react";
import {
    Alert,
    Badge,
    Button,
    Card,
    Group,
    Stack,
    Switch,
    Table,
    Text,
    Title,
    Tooltip,
} from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { ScanStatus } from "@private-stock/core";

import { api, ApiError } from "@/lib/api/client";
import { invalidateLibraries } from "@/lib/api/libraries";

import { LibraryDialogs } from "./LibraryDialogs";

/**
 * The libraries: each a directory, switched on or off and allowed or not to delete (§4, §10).
 *
 * `onScan` is the page's scan mutation, so a library's own Scan and the page's Scan now share one
 * "a scan is running" state.
 */
export const LibrariesCard: React.FC<{
    status: ScanStatus | undefined;
    onScan: (rootId: string) => void;
}> = ({ status, onScan }) => {
    const queryClient = useQueryClient();

    const [adding, setAdding] = useState(false);
    const [editing, setEditing] = useState<string | null>(null);
    const [renaming, setRenaming] = useState<string | null>(null);
    const [removing, setRemoving] = useState<string | null>(null);
    const [pathDraft, setPathDraft] = useState("");

    const updateRoot = useMutation({
        mutationFn: ({ id, ...body }: { id: string; enabled?: boolean; writable?: boolean }) =>
            api(`/api/admin/roots/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
        // Enabling a library is what puts it in the sidebar, so this reaches both caches.
        onSuccess: () => invalidateLibraries(queryClient),
    });

    const roots = status?.roots ?? [];

    return (
        <Card p="md">
            <Stack gap="md">
                <Group justify="space-between" align="flex-start" wrap="wrap" gap="sm">
                    <Stack gap={2}>
                        <Title order={4}>Libraries</Title>
                        <Text size="sm" c="dimmed">
                            New libraries start switched off. Moving one is a change of path —
                            nothing is catalogued again.
                        </Text>
                    </Stack>
                    <Button variant="light" onClick={() => setAdding(true)}>
                        Add library
                    </Button>
                </Group>

                {/* Mostly deletion refused because the folder is mounted read-only, which only
                    the compose file can change -- the message says which. */}
                {updateRoot.error && (
                    <Alert color="oxblood" variant="light">
                        {updateRoot.error instanceof ApiError
                            ? updateRoot.error.message
                            : "Something went wrong"}
                    </Alert>
                )}

                <Table.ScrollContainer minWidth={620}>
                    <Table verticalSpacing="sm">
                        <Table.Thead>
                            <Table.Tr>
                                <Table.Th>Library</Table.Th>
                                <Table.Th>Files</Table.Th>
                                <Table.Th>Enabled</Table.Th>
                                <Table.Th>
                                    <Tooltip
                                        multiline
                                        w={280}
                                        label="Deletion is the only write the app ever makes inside a library, and the volume must also be mounted read-write."
                                    >
                                        <span>Allow deleting files</span>
                                    </Tooltip>
                                </Table.Th>
                                <Table.Th />
                            </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                            {roots.map((root) => (
                                <Table.Tr key={root.id}>
                                    <Table.Td>
                                        <Group gap="xs" wrap="nowrap">
                                            <Text size="sm" fw={500}>
                                                {root.label}
                                            </Text>
                                            {root.verifying > 0 && (
                                                <Tooltip label="Hidden until a scan confirms they are where the library now points.">
                                                    <Badge size="xs" color="brass" variant="light">
                                                        verifying {root.verifying}
                                                    </Badge>
                                                </Tooltip>
                                            )}
                                            {!root.available && (
                                                <Tooltip label="This directory cannot be read right now. Nothing catalogued from it has been touched.">
                                                    <Badge
                                                        size="xs"
                                                        color="oxblood"
                                                        variant="light"
                                                    >
                                                        unavailable
                                                    </Badge>
                                                </Tooltip>
                                            )}
                                        </Group>
                                        <Text
                                            size="xs"
                                            c="dimmed"
                                            style={{ wordBreak: "break-all" }}
                                        >
                                            {root.path}
                                        </Text>
                                    </Table.Td>
                                    <Table.Td>
                                        <Text size="sm">{root.fileCount.toLocaleString()}</Text>
                                    </Table.Td>
                                    <Table.Td>
                                        <Switch
                                            aria-label={`${root.label} enabled`}
                                            checked={root.enabled}
                                            onChange={(event) =>
                                                updateRoot.mutate({
                                                    id: root.id,
                                                    enabled: event.currentTarget.checked,
                                                })
                                            }
                                        />
                                    </Table.Td>
                                    <Table.Td>
                                        <Switch
                                            aria-label={`Allow deleting files in ${root.label}`}
                                            color="oxblood"
                                            checked={root.writable}
                                            onChange={(event) =>
                                                updateRoot.mutate({
                                                    id: root.id,
                                                    writable: event.currentTarget.checked,
                                                })
                                            }
                                        />
                                    </Table.Td>
                                    <Table.Td>
                                        <Group gap={4} wrap="nowrap" justify="flex-end">
                                            <Button
                                                size="xs"
                                                variant="subtle"
                                                disabled={!root.enabled || status?.scanning}
                                                onClick={() => onScan(root.id)}
                                            >
                                                Scan
                                            </Button>
                                            <Button
                                                size="xs"
                                                variant="subtle"
                                                onClick={() => setRenaming(root.id)}
                                            >
                                                Rename
                                            </Button>
                                            <Button
                                                size="xs"
                                                variant="subtle"
                                                onClick={() => {
                                                    setEditing(root.id);
                                                    setPathDraft(root.path);
                                                }}
                                            >
                                                Move
                                            </Button>
                                            <Button
                                                size="xs"
                                                variant="subtle"
                                                color="oxblood"
                                                onClick={() => setRemoving(root.id)}
                                            >
                                                Forget
                                            </Button>
                                        </Group>
                                    </Table.Td>
                                </Table.Tr>
                            ))}
                            {status && roots.length === 0 && (
                                <Table.Tr>
                                    <Table.Td colSpan={5}>
                                        <Text size="sm" c="dimmed">
                                            No libraries yet. Add one to start cataloguing.
                                        </Text>
                                    </Table.Td>
                                </Table.Tr>
                            )}
                        </Table.Tbody>
                    </Table>
                </Table.ScrollContainer>

                <LibraryDialogs
                    adding={adding}
                    editing={editing}
                    renaming={renaming}
                    removing={removing}
                    pathDraft={pathDraft}
                    candidates={status?.candidates ?? []}
                    roots={roots}
                    onPathDraft={setPathDraft}
                    onClose={() => {
                        setAdding(false);
                        setEditing(null);
                        setRenaming(null);
                        setRemoving(null);
                    }}
                />
            </Stack>
        </Card>
    );
};
