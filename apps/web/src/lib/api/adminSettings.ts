import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { AdminSettings, AdminSettingsPatch, StageSetting } from "@private-stock/core";

import { api } from "@/lib/api/client";
import { invalidateProcessing } from "@/lib/api/processing";
import { queryKeys } from "@/lib/api/queryKeys";

/**
 * The runtime settings an admin owns (§12b), read and written from wherever they now live.
 *
 * Each setting sits beside what it configures -- the scan schedule on Libraries, the stages and
 * quiet hours on Processing, a queue's rules on that queue -- but there is still one contract and
 * one cache behind them, so a card on one page and a drawer on another never disagree.
 */
export interface AdminSettingsResponse {
    settings: AdminSettings;
    stages: StageSetting[];
}

export const useAdminSettings = () =>
    useQuery({
        queryKey: queryKeys.admin.settings(),
        queryFn: () => api<AdminSettingsResponse>("/api/admin/settings"),
    });

/** A partial save: each card sends only its own section, so two cards never overwrite each other. */
export const useSaveAdminSettings = () => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (patch: AdminSettingsPatch) =>
            api<AdminSettingsResponse>("/api/admin/settings", {
                method: "PUT",
                body: JSON.stringify(patch),
            }),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.admin.settings() });
            // Enabling a stage, changing the scan schedule or the quiet hours all change what
            // the Activity tab has to say (§7b).
            invalidateProcessing(queryClient);
        },
    });
};

/**
 * A card's draft of one section, which tracks the server until somebody edits it.
 *
 * `reset` drops the edit, and is what a successful save calls so the card follows the server
 * again rather than holding the values it sent.
 */
export const useSettingsDraft = <T>(
    current: T | undefined
): { draft: T | undefined; set: (next: T) => void; dirty: boolean; reset: () => void } => {
    const [draft, setDraft] = useState<T | undefined>(current);
    const [dirty, setDirty] = useState(false);

    useEffect(() => {
        if (!dirty) {
            setDraft(current);
        }
    }, [current, dirty]);

    return {
        draft,
        set: (next: T) => {
            setDraft(next);
            setDirty(true);
        },
        dirty,
        reset: () => setDirty(false),
    };
};
