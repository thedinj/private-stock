"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
    ChangePasswordInput,
    PinStatus,
    SessionUser,
    SetPinInput,
    UpdateProfileInput,
    VerifyPinResult,
} from "@private-stock/core";

import { api } from "./client";
import { useAuth } from "@/lib/api/AuthProvider";
import { queryKeys } from "@/lib/api/queryKeys";

/**
 * Your own account, client side (§12c).
 */

/**
 * Change your own password.
 *
 * Invalidates nothing: no cache displays a password. The response also carries a fresh refresh
 * cookie for this device, which the browser stores without anything here having to know.
 */
export const useChangePassword = () =>
    useMutation({
        mutationFn: (input: ChangePasswordInput) =>
            api<{ ok: true }>("/api/auth/password", {
                method: "POST",
                body: JSON.stringify(input),
            }),
    });

/**
 * Change your own name, or — as an administrator — your sign-in address.
 *
 * Two things show them: the shell's copy of the session user, which is set at sign-in and
 * otherwise never refetched, and Admin › People, where your own row carries both.
 */
export const useUpdateProfile = () => {
    const queryClient = useQueryClient();
    const { refreshUser } = useAuth();

    return useMutation({
        mutationFn: (input: UpdateProfileInput) =>
            api<SessionUser>("/api/auth/me", {
                method: "PATCH",
                body: JSON.stringify(input),
            }),
        onSuccess: () => {
            void refreshUser();
            void queryClient.invalidateQueries({ queryKey: queryKeys.admin.access() });
        },
    });
};

/**
 * Whether your account has a screen-lock PIN (§12c). `enabled` lets the lock skip asking on the
 * devices where it is off, which is most of them.
 */
export const usePinStatus = (enabled = true) =>
    useQuery({
        queryKey: queryKeys.account.pin(),
        queryFn: () => api<PinStatus>("/api/auth/pin"),
        enabled,
    });

/** Set, change or (with `pin: null`) remove your PIN. The answer is the new status. */
export const useSetPin = () => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (input: SetPinInput) =>
            api<PinStatus>("/api/auth/pin", {
                method: "PUT",
                body: JSON.stringify(input),
            }),
        onSuccess: (status) => queryClient.setQueryData(queryKeys.account.pin(), status),
    });
};

/** Ask the server whether a PIN is right. Not a mutation: nothing cached changes. */
export const checkPin = (pin: string): Promise<VerifyPinResult> =>
    api<VerifyPinResult>("/api/auth/pin/verify", {
        method: "POST",
        body: JSON.stringify({ pin }),
    });
