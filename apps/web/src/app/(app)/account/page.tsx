"use client";

import { useState } from "react";
import {
    Alert,
    Badge,
    Button,
    Card,
    Group,
    PasswordInput,
    Stack,
    Text,
    TextInput,
    Title,
} from "@mantine/core";

import { passwordSchema, type SessionUser } from "@private-stock/core";

import { PagePlate } from "@/components/shell/PagePlate";
import { useChangePassword, useUpdateProfile } from "@/lib/api/account";
import { useAuth } from "@/lib/api/AuthProvider";
import { ApiError } from "@/lib/api/client";

/**
 * Split an API failure into the per-field messages and the one that belongs to no field.
 *
 * Every form here reports the same way, so the rule for which goes where is written once.
 */
const describeFailure = (
    caught: unknown,
    fallback: string
): { fields: Record<string, string>; message: string | null } => {
    if (!(caught instanceof ApiError)) {
        return { fields: {}, message: fallback };
    }

    const fields = caught.fieldErrors;

    return { fields, message: Object.keys(fields).length ? null : caught.message };
};

const PERMISSION_LABELS = {
    admin: "Administrator",
    delete: "May delete files",
} as const;

/**
 * Your name, and — for an administrator — the address you sign in with (§12c).
 *
 * The address is shown to everybody, because "which account am I in" is a question anyone can
 * have. Only an administrator can change it: it is the username, and a typo in one locks the
 * account out, so it stays with the people who can also fix that. Read-only rather than
 * disabled for everybody else, so it can still be selected and copied.
 */
const ProfileCard: React.FC<{ user: SessionUser; isAdmin: boolean }> = ({ user, isAdmin }) => {
    const [displayName, setDisplayName] = useState(user.displayName);
    const [email, setEmail] = useState(user.email);
    const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
    const [error, setError] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);

    const update = useUpdateProfile();

    const nameChanged = displayName.trim() !== user.displayName;
    const emailChanged = isAdmin && email.trim().toLowerCase() !== user.email;

    const submit = () => {
        setError(null);
        setFieldErrors({});
        setSaved(false);

        update.mutate(
            {
                ...(nameChanged && { displayName }),
                // Sent only when it changed, and only by an administrator: anybody else sending
                // it is refused, not ignored.
                ...(emailChanged && { email }),
            },
            {
                onSuccess: (next) => {
                    setDisplayName(next.displayName);
                    setEmail(next.email);
                    setSaved(true);
                },
                onError: (caught) => {
                    const failure = describeFailure(caught, "Could not save the changes");
                    setFieldErrors(failure.fields);
                    setError(failure.message);
                },
            }
        );
    };

    return (
        <Card p="md">
            <Stack gap="md">
                <Title order={4}>Profile</Title>

                {error && (
                    <Alert color="oxblood" variant="light">
                        {error}
                    </Alert>
                )}
                {saved && (
                    <Alert color="brass" variant="light">
                        Saved.
                    </Alert>
                )}

                <TextInput
                    label="Display name"
                    description="How everyone else in the library sees you."
                    value={displayName}
                    onChange={(event) => {
                        setSaved(false);
                        setDisplayName(event.currentTarget.value);
                    }}
                    error={fieldErrors.displayName}
                    autoComplete="nickname"
                />

                <TextInput
                    label="Email"
                    description={
                        isAdmin
                            ? "What you sign in with. Nothing is ever sent to it — check it before saving, because a typo here is what you will have to sign in with."
                            : "What you sign in with. Nothing is ever sent to it. Ask an administrator if it needs to change."
                    }
                    type="email"
                    inputMode="email"
                    value={email}
                    readOnly={!isAdmin}
                    variant={isAdmin ? "default" : "filled"}
                    onChange={(event) => {
                        setSaved(false);
                        setEmail(event.currentTarget.value);
                    }}
                    error={fieldErrors.email}
                    autoComplete="username"
                />

                {user.scopes.length > 0 && (
                    <Group gap="xs">
                        {user.scopes.map((scope) => (
                            <Badge key={scope} color="brass" variant="light">
                                {PERMISSION_LABELS[scope]}
                            </Badge>
                        ))}
                    </Group>
                )}

                <Group justify="flex-end">
                    <Button
                        loading={update.isPending}
                        disabled={!nameChanged && !emailChanged}
                        onClick={submit}
                    >
                        Save
                    </Button>
                </Group>
            </Stack>
        </Card>
    );
};

/**
 * Your own password (§12d).
 *
 * The current one is asked for even though you are signed in: it is what stops a borrowed
 * session becoming permanent ownership of the account. No Generate button, unlike the
 * administrator's reset — that one is read down a phone, this one you will type yourself.
 */
const PasswordCard: React.FC = () => {
    const [currentPassword, setCurrentPassword] = useState("");
    const [newPassword, setNewPassword] = useState("");
    const [confirm, setConfirm] = useState("");
    const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
    const [error, setError] = useState<string | null>(null);
    const [changed, setChanged] = useState(false);

    const change = useChangePassword();

    // Checked only here: a confirmation field protects against a typo in the one field whose
    // contents you cannot see, and the server has no way to know what you meant to type.
    const mismatch = confirm.length > 0 && confirm !== newPassword;

    const submit = () => {
        setError(null);
        setFieldErrors({});
        setChanged(false);

        change.mutate(
            { currentPassword, newPassword },
            {
                onSuccess: () => {
                    setCurrentPassword("");
                    setNewPassword("");
                    setConfirm("");
                    setChanged(true);
                },
                onError: (caught) => {
                    const failure = describeFailure(caught, "Could not change the password");
                    setFieldErrors(failure.fields);
                    setError(failure.message);
                },
            }
        );
    };

    return (
        <Card p="md">
            <Stack gap="md">
                <Stack gap={2}>
                    <Title order={4}>Password</Title>
                    <Text size="sm" c="dimmed">
                        Changing it signs out your other devices and ends the video links already
                        issued to them. This one stays signed in.
                    </Text>
                </Stack>

                {error && (
                    <Alert color="oxblood" variant="light">
                        {error}
                    </Alert>
                )}
                {changed && (
                    <Alert color="brass" variant="light">
                        Your password has been changed. Every other device has been signed out.
                    </Alert>
                )}

                <PasswordInput
                    label="Current password"
                    value={currentPassword}
                    onChange={(event) => setCurrentPassword(event.currentTarget.value)}
                    error={fieldErrors.currentPassword}
                    autoComplete="current-password"
                />

                <PasswordInput
                    label="New password"
                    description={`At least ${passwordSchema.minLength} characters`}
                    value={newPassword}
                    onChange={(event) => setNewPassword(event.currentTarget.value)}
                    error={fieldErrors.newPassword}
                    autoComplete="new-password"
                />

                <PasswordInput
                    label="New password, again"
                    value={confirm}
                    onChange={(event) => setConfirm(event.currentTarget.value)}
                    error={mismatch ? "These do not match" : undefined}
                    autoComplete="new-password"
                />

                <Group justify="flex-end">
                    <Button
                        loading={change.isPending}
                        disabled={!currentPassword || !newPassword || confirm !== newPassword}
                        onClick={submit}
                    >
                        Change password
                    </Button>
                </Group>
            </Stack>
        </Card>
    );
};

/**
 * Your own account (§12c) — reached from your name at the foot of the sidebar.
 */
const AccountPage: React.FC = () => {
    const { user, hasScope } = useAuth();

    return (
        <Stack gap="lg" maw={640}>
            <PagePlate eyebrow="Signed in" title="Account" />

            {/* Keyed on the account, so the form's drafts start from the right values rather
                than the placeholder a first render might have had. */}
            {user && <ProfileCard key={user.id} user={user} isAdmin={hasScope("admin")} />}

            <PasswordCard />
        </Stack>
    );
};

export default AccountPage;
