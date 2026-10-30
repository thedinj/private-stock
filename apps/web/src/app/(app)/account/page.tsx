"use client";

import { useState } from "react";
import {
    Alert,
    Badge,
    Button,
    Card,
    Divider,
    Group,
    PasswordInput,
    Select,
    Stack,
    Switch,
    Text,
    TextInput,
    Title,
} from "@mantine/core";

import { passwordSchema, pinSchema, type SessionUser } from "@private-stock/core";

import { PagePlate } from "@/components/shell/PagePlate";
import { useScreenLock } from "@/components/shell/ScreenLock";
import {
    checkPin,
    useChangePassword,
    usePinStatus,
    useSetPin,
    useUpdateProfile,
} from "@/lib/api/account";
import { useAuth } from "@/lib/api/AuthProvider";
import { ApiError } from "@/lib/api/client";
import { DEFAULT_LOCK_AFTER_MINUTES, LOCK_AFTER_MINUTES } from "@/lib/screenLock";

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

const lockAfterLabel = (minutes: number): string =>
    minutes < 60 ? `${minutes} minutes` : minutes === 60 ? "1 hour" : `${minutes / 60} hours`;

/** Digits only: what a PIN field keeps of whatever is typed or pasted into it. */
const digitsOf = (value: string): string => value.replace(/\D/g, "");

const PIN_FIELD = { inputMode: "numeric", maxLength: 8, autoComplete: "off" } as const;

/**
 * The screen lock (§12c): the account's PIN, and whether this device asks for it.
 *
 * Two halves on purpose. The PIN is the account's and follows you to every device; turning the
 * lock on is this device's alone, so a tablet can lock while the desktop does not. Setting the
 * PIN asks for the password, and turning the lock off here asks for the PIN — otherwise the
 * unlocked screen the lock exists for would be the place to switch it off.
 */
const ScreenLockCard: React.FC = () => {
    const { data: status } = usePinStatus();
    const savePin = useSetPin();
    const { lockAfter, setLockAfter } = useScreenLock();

    const [currentPassword, setCurrentPassword] = useState("");
    const [pin, setPin] = useState("");
    const [confirm, setConfirm] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState<string | null>(null);

    const [turningOff, setTurningOff] = useState(false);
    const [offPin, setOffPin] = useState("");
    const [offError, setOffError] = useState<string | null>(null);
    const [offBusy, setOffBusy] = useState(false);

    const hasPin = status?.set ?? false;
    const pinValid = pinSchema.safeParse(pin).success;
    const mismatch = confirm.length > 0 && confirm !== pin;

    const save = (next: string | null) => {
        setError(null);
        setDone(null);

        savePin.mutate(
            { currentPassword, pin: next },
            {
                onSuccess: () => {
                    setCurrentPassword("");
                    setPin("");
                    setConfirm("");
                    setDone(
                        next === null
                            ? "PIN removed. Devices that locked with it no longer lock."
                            : "PIN saved. It applies on every device that locks."
                    );
                },
                onError: (caught) =>
                    setError(describeFailure(caught, "Could not save the PIN").message),
            }
        );
    };

    const cancelTurnOff = () => {
        setTurningOff(false);
        setOffPin("");
        setOffError(null);
    };

    const turnOff = async () => {
        setOffBusy(true);
        setOffError(null);

        try {
            const result = await checkPin(offPin);

            if (result.ok) {
                setLockAfter(null);
                cancelTurnOff();
            } else if (!result.signedOut) {
                setOffError(`Wrong PIN. ${result.remaining} tries left.`);
            }
            // Signed out: the session has gone, and the shell takes it from there.
        } catch {
            setOffError("Could not check the PIN");
        } finally {
            setOffBusy(false);
        }
    };

    return (
        <Card p="md">
            <Stack gap="md">
                <Stack gap={2}>
                    <Title order={4}>Screen lock</Title>
                    <Text size="sm" c="dimmed">
                        After a while away, a device you choose covers the library until your PIN is
                        entered. It keeps out whoever picks the device up, not someone set on
                        getting in.
                    </Text>
                </Stack>

                {error && (
                    <Alert color="oxblood" variant="light">
                        {error}
                    </Alert>
                )}
                {done && (
                    <Alert color="brass" variant="light">
                        {done}
                    </Alert>
                )}

                <PasswordInput
                    label="New PIN"
                    description="4 to 8 digits. Six is a good length."
                    value={pin}
                    onChange={(event) => {
                        setDone(null);
                        setPin(digitsOf(event.currentTarget.value));
                    }}
                    {...PIN_FIELD}
                />

                <PasswordInput
                    label="New PIN, again"
                    value={confirm}
                    onChange={(event) => setConfirm(digitsOf(event.currentTarget.value))}
                    error={mismatch ? "These do not match" : undefined}
                    {...PIN_FIELD}
                />

                <PasswordInput
                    label="Your password"
                    description={
                        hasPin ? "Needed to change or remove the PIN" : "Needed to set a PIN"
                    }
                    value={currentPassword}
                    onChange={(event) => setCurrentPassword(event.currentTarget.value)}
                    autoComplete="current-password"
                />

                <Group justify="flex-end">
                    {hasPin && (
                        <Button
                            variant="subtle"
                            color="oxblood"
                            disabled={!currentPassword}
                            loading={savePin.isPending}
                            onClick={() => save(null)}
                        >
                            Remove PIN
                        </Button>
                    )}
                    <Button
                        disabled={!currentPassword || !pinValid || confirm !== pin}
                        loading={savePin.isPending}
                        onClick={() => save(pin)}
                    >
                        {hasPin ? "Change PIN" : "Set PIN"}
                    </Button>
                </Group>

                <Divider />

                <Switch
                    label="Lock this device"
                    description={
                        hasPin
                            ? "Only this browser on this device. Your other devices keep their own setting."
                            : "Set a PIN first."
                    }
                    disabled={!hasPin}
                    checked={hasPin && lockAfter !== null}
                    onChange={(event) => {
                        if (event.currentTarget.checked) {
                            setLockAfter(DEFAULT_LOCK_AFTER_MINUTES);
                        } else {
                            setTurningOff(true);
                        }
                    }}
                    styles={{ body: { minHeight: 44, alignItems: "center" } }}
                />

                {hasPin && lockAfter !== null && (
                    <Select
                        label="Lock after"
                        description="This long in the background, or untouched with nothing playing"
                        data={LOCK_AFTER_MINUTES.map((minutes) => ({
                            value: String(minutes),
                            label: lockAfterLabel(minutes),
                        }))}
                        value={String(lockAfter)}
                        onChange={(value) => value && setLockAfter(Number(value))}
                        allowDeselect={false}
                        maw={240}
                    />
                )}

                {turningOff && (
                    <Group align="flex-end" gap="sm">
                        <PasswordInput
                            label="Your PIN, to turn the lock off"
                            value={offPin}
                            onChange={(event) => setOffPin(digitsOf(event.currentTarget.value))}
                            error={offError}
                            style={{ flex: 1 }}
                            {...PIN_FIELD}
                        />
                        <Button variant="default" onClick={cancelTurnOff}>
                            Cancel
                        </Button>
                        <Button
                            loading={offBusy}
                            disabled={offPin.length < 4}
                            onClick={() => void turnOff()}
                        >
                            Turn off
                        </Button>
                    </Group>
                )}
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

            <ScreenLockCard />
        </Stack>
    );
};

export default AccountPage;
