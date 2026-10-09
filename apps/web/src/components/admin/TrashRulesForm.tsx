"use client";

import { Alert, NumberInput, Stack } from "@mantine/core";

import { useAdminSettings, useSaveAdminSettings, useSettingsDraft } from "@/lib/api/adminSettings";

import { SaveRow } from "./SaveRow";

/**
 * How long a deleted item stays recoverable (§10). In the Trash queue's Rules drawer.
 *
 * Its bytes sit on the data volume for the whole window, so this is a disk commitment as well as
 * a grace period.
 */
export const TrashRulesForm: React.FC = () => {
    const { data } = useAdminSettings();
    const save = useSaveAdminSettings();
    const { draft: trash, set, dirty, reset } = useSettingsDraft(data?.settings.trash);

    return (
        <Stack gap="md">
            <NumberInput
                label="Keep deleted items for"
                suffix=" days"
                description="Their space on the data volume is held for as long. 0 purges on the next hourly sweep."
                min={0}
                max={365}
                value={trash?.retentionDays ?? 7}
                onChange={(value) =>
                    trash && set({ ...trash, retentionDays: typeof value === "number" ? value : 0 })
                }
            />

            {trash?.retentionDays === 0 && (
                <Alert color="oxblood" variant="light">
                    With no retention, deleting is effectively permanent — restoring means catching
                    an item within the hour.
                </Alert>
            )}

            <SaveRow
                onSave={() => trash && save.mutate({ trash }, { onSuccess: reset })}
                saving={save.isPending}
                dirty={dirty}
                note="Applies to future deletions; items already here keep their window."
            />
        </Stack>
    );
};
