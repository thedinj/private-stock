"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { ChangePasswordInput, SessionUser, UpdateProfileInput } from "@private-stock/core";

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
