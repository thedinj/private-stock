"use client";

import { useState } from "react";
import { Button, Group, Modal, Stack, Text } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { ScanStatus } from "@private-stock/core";

import { LibrariesCard } from "@/components/admin/LibrariesCard";
import { ScanScheduleCard } from "@/components/admin/ScanScheduleCard";
import { PagePlate } from "@/components/shell/PagePlate";
import { api } from "@/lib/api/client";
import { invalidateProcessing } from "@/lib/api/processing";
import { queryKeys } from "@/lib/api/queryKeys";

/**
 * Libraries (§4, §12c): what is catalogued, and how new files are found.
 *
 * Every scan control is here and nowhere else in the admin area -- the whole library, one
 * library, and the schedule -- where they used to be split between a page header, a paragraph
 * explaining it several cards away, and a settings card.
 */
const LibrariesPage: React.FC = () => {
    const queryClient = useQueryClient();
    const [confirmingRescan, setConfirmingRescan] = useState(false);

    const { data } = useQuery({
        queryKey: queryKeys.admin.scan(),
        queryFn: () => api<ScanStatus>("/api/admin/scan"),
        refetchInterval: (query) => (query.state.data?.scanning ? 3_000 : false),
    });

    const scan = useMutation({
        mutationFn: (options: { rootId?: string; force?: boolean }) =>
            api("/api/admin/scan", { method: "POST", body: JSON.stringify(options) }),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.admin.scan() });
            // Something is now happening, and the Activity tab has to hear about it.
            invalidateProcessing(queryClient);
        },
    });

    return (
        <Stack gap="lg">
            <PagePlate
                eyebrow={data?.scanning ? "A scan is running…" : "Admin"}
                title="Libraries"
                lede={
                    <>
                        <strong>Scan now</strong> finds new, changed and removed files.{" "}
                        <strong>Full rescan</strong> also re-reads files that look unchanged — for
                        when the catalogue is out of step with the disk.
                    </>
                }
                actions={
                    <>
                        <Button
                            loading={
                                scan.isPending && !scan.variables?.force && !scan.variables?.rootId
                            }
                            disabled={data?.scanning}
                            onClick={() => scan.mutate({})}
                        >
                            Scan now
                        </Button>
                        <Button
                            variant="light"
                            color="oxblood"
                            loading={scan.isPending && scan.variables?.force === true}
                            disabled={data?.scanning}
                            onClick={() => setConfirmingRescan(true)}
                        >
                            Full rescan…
                        </Button>
                    </>
                }
            />

            <Stack gap="lg" maw={860}>
                <LibrariesCard status={data} onScan={(rootId) => scan.mutate({ rootId })} />
                <ScanScheduleCard />
            </Stack>

            <Modal
                opened={confirmingRescan}
                onClose={() => setConfirmingRescan(false)}
                title="Rescan every file?"
                centered
            >
                <Stack gap="md">
                    <Text size="sm">
                        Every file is examined again, including the ones whose size and timestamp
                        have not changed. On a large library this takes a long time, and the
                        processing queue fills behind it.
                    </Text>
                    <Group justify="flex-end" gap="sm">
                        <Button variant="default" onClick={() => setConfirmingRescan(false)}>
                            Cancel
                        </Button>
                        <Button
                            color="oxblood"
                            onClick={() => {
                                setConfirmingRescan(false);
                                scan.mutate({ force: true });
                            }}
                        >
                            Rescan everything
                        </Button>
                    </Group>
                </Stack>
            </Modal>
        </Stack>
    );
};

export default LibrariesPage;
