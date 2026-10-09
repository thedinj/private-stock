"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
    CreateInvitationInput,
    Invitation,
    ManagedUser,
    SetUserPasswordInput,
    UpdateUserInput,
} from "@private-stock/core";

import { api } from "./client";
import { useAuth } from "@/lib/api/AuthProvider";
import { queryKeys } from "@/lib/api/queryKeys";

/**
 * Who can reach the library, client side (§12c).
 *
 * The accounts table and the invitations table share one invalidation prefix, and that is the
 * whole design: using an invitation creates an account, so the two are never separately
 * stale. Withdrawing an invitation cannot change the accounts list, but invalidating both
 * costs one request on a page with a handful of rows, and a rule with an exception is a rule
 * somebody gets wrong later.
 */

const ACCESS_KEY = queryKeys.admin.access();

interface UsersResponse {
    users: ManagedUser[];
}

interface InvitationsResponse {
    invitations: Invitation[];
}

export const useManagedUsers = (enabled = true) =>
    useQuery({
        queryKey: queryKeys.admin.users(),
        queryFn: () => api<UsersResponse>("/api/admin/users"),
        enabled,
    });

export const useInvitations = (enabled = true) =>
    useQuery({
        queryKey: queryKeys.admin.invitations(),
        queryFn: () => api<InvitationsResponse>("/api/admin/invitations"),
        enabled,
    });

/** Everything that writes here, sharing the one invalidation. */
const useAccessMutation = <TArgs, TResult>(
    request: (args: TArgs) => Promise<TResult>,
    onDone?: (result: TResult, args: TArgs) => void
) => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: request,
        onSuccess: (result, args) => {
            void queryClient.invalidateQueries({ queryKey: ACCESS_KEY });
            onDone?.(result, args);
        },
    });
};

export const useCreateInvitation = (onCreated?: (invitation: Invitation) => void) =>
    useAccessMutation(
        (input: CreateInvitationInput) =>
            api<{ invitation: Invitation }>("/api/admin/invitations", {
                method: "POST",
                body: JSON.stringify(input),
            }),
        (result) => onCreated?.(result.invitation)
    );

export const useRevokeInvitation = () =>
    useAccessMutation((id: string) =>
        api<{ invitation: Invitation }>(`/api/admin/invitations/${id}`, { method: "PATCH" })
    );

export const useDeleteInvitation = () =>
    useAccessMutation((id: string) =>
        api<void>(`/api/admin/invitations/${id}`, { method: "DELETE" })
    );

/**
 * Change an account, refreshing the shell when the account is the viewer's own.
 *
 * Here rather than in the dialogue that happens to edit a name, because every caller has the
 * same obligation and only one of them would have remembered it. The shell's copy of the
 * session user is set at sign-in and never again, so editing yourself left the foot of the
 * navbar calling you the old name until a reload.
 *
 * Unconditional rather than guarded on what changed: an extra `/api/auth/me` on an
 * administrator editing their own row is one small request, and working out which fields could
 * possibly matter to the shell is exactly the reasoning that goes stale when a field is added.
 */
export const useUpdateManagedUser = () => {
    const { user, refreshUser } = useAuth();

    return useAccessMutation(
        ({ id, patch }: { id: string; patch: UpdateUserInput }) =>
            api<{ user: ManagedUser }>(`/api/admin/users/${id}`, {
                method: "PATCH",
                body: JSON.stringify(patch),
            }),
        (_result, args) => {
            if (args.id === user?.id) {
                void refreshUser();
            }
        }
    );
};

/**
 * Set somebody else's password.
 *
 * Not an `useAccessMutation`: it changes nothing either table displays. The account list shows
 * permissions and provenance, and a password is neither — invalidating would refetch two
 * tables to render exactly what was already on screen.
 */
export const useSetUserPassword = () =>
    useMutation({
        mutationFn: ({ id, input }: { id: string; input: SetUserPasswordInput }) =>
            api<void>(`/api/admin/users/${id}/password`, {
                method: "POST",
                body: JSON.stringify(input),
            }),
    });

export const useDeleteManagedUser = (onDeleted?: () => void) =>
    useAccessMutation(
        (id: string) => api<void>(`/api/admin/users/${id}`, { method: "DELETE" }),
        () => onDeleted?.()
    );
