"use client";

import {
    ActionIcon,
    Alert,
    Badge,
    Button,
    Card,
    CopyButton,
    Group,
    Menu,
    Modal,
    NumberInput,
    PasswordInput,
    Select,
    Stack,
    Switch,
    Table,
    Text,
    TextInput,
    Title,
    Tooltip,
} from "@mantine/core";
import { useState } from "react";

import {
    formatInvitationCode,
    generateReadablePassword,
    passwordSchema,
    type Invitation,
    type ManagedUser,
} from "@private-stock/core";

import { ApiError } from "@/lib/api/client";

import {
    useCreateInvitation,
    useDeleteInvitation,
    useDeleteManagedUser,
    useInvitations,
    useManagedUsers,
    useRevokeInvitation,
    useSetUserPassword,
    useUpdateManagedUser,
} from "@/lib/api/access";
import { useAuth } from "@/lib/api/AuthProvider";
import { CheckGlyph, CopyGlyph, MoreGlyph } from "@/components/media/Glyph";

/**
 * Who can reach the library, and the invitations that let them in (§12c).
 *
 * Two tables under one heading because they are two halves of one question. The rule worth
 * stating on screen, because the two halves look like the same permission and are not:
 * **anyone with an invitation can join; only an administrator can invite.**
 *
 * Every control that cannot work is absent rather than disabled — the house pattern. An
 * administrator looking at their own row sees no disable switch and no delete button, because
 * the answer to "why is this greyed out" is a paragraph about locking a door from the inside.
 */

const relative = (iso: string): string =>
    new Date(iso).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
    });

/** How much of an invitation is left, in the fewest words that are still true. */
const remaining = (invitation: Invitation): string => {
    if (invitation.revokedAt) return "withdrawn";
    if (invitation.expiresAt && new Date(invitation.expiresAt) <= new Date()) return "expired";
    if (invitation.maxUses === null) return `${invitation.useCount} joined · no limit`;

    return `${invitation.useCount} of ${invitation.maxUses} used`;
};

const NewInvitation: React.FC<{ opened: boolean; onClose: () => void }> = ({ opened, onClose }) => {
    const { hasScope } = useAuth();
    const [label, setLabel] = useState("");
    const [maxUses, setMaxUses] = useState<number | "">(1);
    const [expiresInDays, setExpiresInDays] = useState<string | null>("7");
    const [grantsDelete, setGrantsDelete] = useState(false);
    const [minted, setMinted] = useState<Invitation | null>(null);

    const create = useCreateInvitation((invitation) => setMinted(invitation));

    const close = () => {
        setMinted(null);
        setLabel("");
        setMaxUses(1);
        setExpiresInDays("7");
        setGrantsDelete(false);
        onClose();
    };

    return (
        <Modal
            opened={opened}
            onClose={close}
            title={minted ? "Invitation ready" : "New invitation"}
        >
            {minted ? (
                <Stack gap="md">
                    <Text size="sm">
                        Give this code to {minted.label ?? "whoever it is for"}. It is shown once
                        here, but you can read it from the list at any time.
                    </Text>

                    <Group gap="sm">
                        <Text
                            fz={22}
                            ff="var(--mantine-font-family-monospace)"
                            style={{ letterSpacing: "0.08em" }}
                        >
                            {formatInvitationCode(minted.code)}
                        </Text>
                        <CopyButton value={formatInvitationCode(minted.code)}>
                            {({ copied, copy }) => (
                                <Button size="xs" variant="light" onClick={copy}>
                                    {copied ? "Copied" : "Copy"}
                                </Button>
                            )}
                        </CopyButton>
                    </Group>

                    <CopyButton value={`${window.location.origin}/register?code=${minted.code}`}>
                        {({ copied, copy }) => (
                            <Button size="xs" variant="default" onClick={copy}>
                                {copied ? "Link copied" : "Copy a joining link instead"}
                            </Button>
                        )}
                    </CopyButton>

                    <Button onClick={close}>Done</Button>
                </Stack>
            ) : (
                <Stack gap="md">
                    <TextInput
                        label="Who is it for"
                        description="Only so the list is readable. They never see it."
                        placeholder="Mum, houseguests…"
                        value={label}
                        onChange={(event) => setLabel(event.currentTarget.value)}
                    />

                    <NumberInput
                        label="How many people may use it"
                        description="Leave empty for no limit."
                        min={1}
                        max={1000}
                        value={maxUses}
                        onChange={(value) => setMaxUses(typeof value === "number" ? value : "")}
                    />

                    <Select
                        label="Expires"
                        data={[
                            { value: "1", label: "In a day" },
                            { value: "7", label: "In a week" },
                            { value: "30", label: "In a month" },
                            { value: "", label: "Never" },
                        ]}
                        value={expiresInDays}
                        onChange={setExpiresInDays}
                        allowDeselect={false}
                    />

                    {/*
                     * Absent unless the person minting holds `delete` themselves. The service
                     * refuses to grant a permission its caller does not hold, and offering a
                     * switch that is always refused would be a control that cannot work.
                     */}
                    {hasScope("delete") && (
                        <Switch
                            label="May delete files"
                            description="Removing files from a library, not just hiding them."
                            checked={grantsDelete}
                            onChange={(event) => setGrantsDelete(event.currentTarget.checked)}
                        />
                    )}

                    <Text size="xs" c="dimmed">
                        Whoever uses this can see every shared library, and their own ratings, tags
                        and playlists stay private to them.
                    </Text>

                    <Button
                        loading={create.isPending}
                        onClick={() =>
                            create.mutate({
                                label: label.trim() || null,
                                scopes: grantsDelete ? ["delete"] : [],
                                maxUses: maxUses === "" ? null : maxUses,
                                expiresInDays: expiresInDays ? Number(expiresInDays) : null,
                            })
                        }
                    >
                        Create invitation
                    </Button>
                </Stack>
            )}
        </Modal>
    );
};

const InvitationRow: React.FC<{ invitation: Invitation }> = ({ invitation }) => {
    const revoke = useRevokeInvitation();
    const remove = useDeleteInvitation();

    return (
        <Table.Tr>
            <Table.Td>
                <Stack gap={2}>
                    <Group gap="xs" wrap="nowrap">
                        <Text
                            size="sm"
                            ff="var(--mantine-font-family-monospace)"
                            style={{ letterSpacing: "0.04em" }}
                        >
                            {formatInvitationCode(invitation.code)}
                        </Text>
                        <CopyButton value={formatInvitationCode(invitation.code)}>
                            {({ copied, copy }) => (
                                <Tooltip label={copied ? "Copied" : "Copy"}>
                                    <ActionIcon
                                        size="sm"
                                        variant="subtle"
                                        color="brass"
                                        onClick={copy}
                                        aria-label="Copy invitation code"
                                    >
                                        {copied ? (
                                            <CheckGlyph size={16} />
                                        ) : (
                                            <CopyGlyph size={16} />
                                        )}
                                    </ActionIcon>
                                </Tooltip>
                            )}
                        </CopyButton>
                        {invitation.scopes.includes("delete") && (
                            <Badge size="xs" color="oxblood" variant="light">
                                may delete
                            </Badge>
                        )}
                    </Group>
                    {invitation.label && (
                        <Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>
                            {invitation.label}
                        </Text>
                    )}
                </Stack>
            </Table.Td>

            <Table.Td>
                <Text size="sm" c={invitation.usable ? undefined : "dimmed"}>
                    {remaining(invitation)}
                </Text>
                {invitation.expiresAt && !invitation.revokedAt && (
                    <Text size="xs" c="dimmed">
                        until {relative(invitation.expiresAt)}
                    </Text>
                )}
            </Table.Td>

            <Table.Td>
                <Text size="xs" c="dimmed">
                    {invitation.createdByName ?? "someone since removed"}
                    {" · "}
                    {relative(invitation.createdAt)}
                </Text>
            </Table.Td>

            <Table.Td>
                <Group gap="xs" justify="flex-end" wrap="nowrap">
                    {/*
                     * Withdraw for one somebody has used, Remove for one nobody has. Never
                     * both, and never a disabled one: deleting an invitation with accounts
                     * behind it would throw away the only record of how they got in, and the
                     * server refuses it — so the button that would be refused is absent.
                     */}
                    {!invitation.revokedAt && (
                        <Button
                            size="xs"
                            variant="subtle"
                            color="oxblood"
                            loading={revoke.isPending}
                            onClick={() => revoke.mutate(invitation.id)}
                        >
                            Withdraw
                        </Button>
                    )}
                    {invitation.useCount === 0 && (
                        <Button
                            size="xs"
                            variant="subtle"
                            color="oxblood"
                            loading={remove.isPending}
                            onClick={() => remove.mutate(invitation.id)}
                        >
                            Remove
                        </Button>
                    )}
                </Group>
            </Table.Td>
        </Table.Tr>
    );
};

/**
 * Setting somebody else's password (§12c).
 *
 * The only account recovery there is, and the reason it exists: nothing is emailed, because
 * the "email" on an account is a username that happens to look like an address. So the
 * administrator reads the new password out, and the person changes it afterwards or does not.
 *
 * **The administrator types their own password to do it.** A stolen access token is fifteen
 * minutes of ambient authority, and this is the one action whose effect outlives the session
 * that performed it — so it asks the caller to be the caller, not merely to be sitting at
 * their unlocked desk.
 */
const SetPassword: React.FC<{ user: ManagedUser; onClose: () => void }> = ({ user, onClose }) => {
    const [password, setPassword] = useState("");
    const [adminPassword, setAdminPassword] = useState("");
    const [done, setDone] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

    const set = useSetUserPassword();

    const submit = () => {
        setError(null);
        setFieldErrors({});

        set.mutate(
            { id: user.id, input: { password, adminPassword } },
            {
                onSuccess: () => setDone(password),
                onError: (caught) => {
                    if (caught instanceof ApiError) {
                        setFieldErrors(caught.fieldErrors);
                        if (!Object.keys(caught.fieldErrors).length) setError(caught.message);
                    } else {
                        setError("Could not set the password");
                    }
                },
            }
        );
    };

    return (
        <Modal
            opened
            onClose={onClose}
            title={
                done
                    ? `${user.displayName} has a new password`
                    : `Set a password for ${user.displayName}`
            }
        >
            {done ? (
                <Stack gap="md">
                    <Text size="sm">
                        Tell them this yourself — nothing has been sent anywhere, and it is not
                        shown again after you close this.
                    </Text>

                    <Group gap="sm">
                        <Text
                            fz={20}
                            ff="var(--mantine-font-family-monospace)"
                            style={{ letterSpacing: "0.08em", overflowWrap: "anywhere" }}
                        >
                            {done}
                        </Text>
                        <CopyButton value={done}>
                            {({ copied, copy }) => (
                                <Button size="xs" variant="light" onClick={copy}>
                                    {copied ? "Copied" : "Copy"}
                                </Button>
                            )}
                        </CopyButton>
                    </Group>

                    <Text size="sm" c="dimmed">
                        Every session they had open has ended, and so has every video link already
                        issued to them. They can change this from their own account page.
                    </Text>

                    <Button onClick={onClose}>Done</Button>
                </Stack>
            ) : (
                <Stack gap="md">
                    {error && (
                        <Alert color="oxblood" variant="light">
                            {error}
                        </Alert>
                    )}

                    <Group gap="sm" align="flex-end" wrap="nowrap">
                        <PasswordInput
                            label="New password"
                            description={`At least ${passwordSchema.minLength} characters`}
                            value={password}
                            onChange={(event) => setPassword(event.currentTarget.value)}
                            error={fieldErrors.password}
                            autoComplete="new-password"
                            style={{ flex: 1 }}
                        />
                        {/*
                         * Generated from the same unambiguous alphabet as an invitation code,
                         * because this is also going to be read down a phone.
                         */}
                        <Button
                            variant="default"
                            onClick={() => setPassword(generateReadablePassword())}
                        >
                            Generate
                        </Button>
                    </Group>

                    <PasswordInput
                        label="Your own password"
                        description="Confirming it is you, not just your open session."
                        value={adminPassword}
                        onChange={(event) => setAdminPassword(event.currentTarget.value)}
                        error={fieldErrors.adminPassword}
                        autoComplete="current-password"
                    />

                    <Text size="xs" c="dimmed">
                        This ends every session {user.displayName} has open and every video link
                        already issued to them.
                    </Text>

                    <Group justify="flex-end">
                        <Button variant="default" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button loading={set.isPending} onClick={submit}>
                            Set the password
                        </Button>
                    </Group>
                </Stack>
            )}
        </Modal>
    );
};

/**
 * The name shown everywhere, and the address the account signs in with.
 *
 * The email field is worth a word on screen: nothing is ever sent to it, so it is a username
 * that happens to look like an address — which is also why a typo in one locks somebody out
 * until it is fixed here.
 */
const EditDetails: React.FC<{ user: ManagedUser; onClose: () => void }> = ({ user, onClose }) => {
    const [displayName, setDisplayName] = useState(user.displayName);
    const [email, setEmail] = useState(user.email);
    const [error, setError] = useState<string | null>(null);
    const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

    const update = useUpdateManagedUser();

    const submit = () => {
        setError(null);
        setFieldErrors({});

        update.mutate(
            { id: user.id, patch: { displayName, email } },
            {
                onSuccess: onClose,
                onError: (caught) => {
                    if (caught instanceof ApiError) {
                        setFieldErrors(caught.fieldErrors);
                        if (!Object.keys(caught.fieldErrors).length) setError(caught.message);
                    } else {
                        setError("Could not save the changes");
                    }
                },
            }
        );
    };

    return (
        <Modal opened onClose={onClose} title={`Edit ${user.displayName}`}>
            <Stack gap="md">
                {error && (
                    <Alert color="oxblood" variant="light">
                        {error}
                    </Alert>
                )}

                <TextInput
                    label="Display name"
                    value={displayName}
                    onChange={(event) => setDisplayName(event.currentTarget.value)}
                    error={fieldErrors.displayName}
                />

                <TextInput
                    label="Email"
                    description="What they sign in with. Nothing is ever sent to it."
                    type="email"
                    inputMode="email"
                    value={email}
                    onChange={(event) => setEmail(event.currentTarget.value)}
                    error={fieldErrors.email}
                />

                <Group justify="flex-end">
                    <Button variant="default" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button loading={update.isPending} onClick={submit}>
                        Save
                    </Button>
                </Group>
            </Stack>
        </Modal>
    );
};

const UserRow: React.FC<{ user: ManagedUser }> = ({ user }) => {
    const { hasScope } = useAuth();
    const update = useUpdateManagedUser();
    const remove = useDeleteManagedUser();
    const [confirming, setConfirming] = useState(false);
    /** Which dialogue this row has open, if any. One at a time, by construction. */
    const [dialog, setDialog] = useState<"password" | "details" | null>(null);

    const setScope = (scope: "admin" | "delete", on: boolean) =>
        update.mutate({
            id: user.id,
            patch: {
                scopes: on
                    ? [...new Set([...user.scopes, scope])]
                    : user.scopes.filter((held) => held !== scope),
            },
        });

    return (
        <>
            <Table.Tr opacity={user.disabled ? 0.55 : 1}>
                <Table.Td>
                    <Stack gap={2}>
                        <Group gap="xs" wrap="nowrap">
                            <Text size="sm" fw={500} style={{ overflowWrap: "anywhere" }}>
                                {user.displayName}
                            </Text>
                            {user.isSelf && (
                                <Badge size="xs" color="brass" variant="light">
                                    you
                                </Badge>
                            )}
                            {user.disabled && (
                                <Badge size="xs" color="oxblood" variant="light">
                                    disabled
                                </Badge>
                            )}
                        </Group>
                        <Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>
                            {user.email}
                        </Text>
                    </Stack>
                </Table.Td>

                <Table.Td>
                    {/*
                     * The administrator switch is absent on your own row rather than disabled.
                     * Removing your own access is refused by the server, and a greyed switch
                     * invites you to work out why — where the answer is a paragraph about
                     * `/setup` reopening only when the last account is gone.
                     */}
                    {user.isSelf ? (
                        <Text size="xs" c="dimmed">
                            administrator
                        </Text>
                    ) : (
                        <Switch
                            size="sm"
                            checked={user.scopes.includes("admin")}
                            onChange={(event) => setScope("admin", event.currentTarget.checked)}
                            aria-label={`${user.displayName} is an administrator`}
                        />
                    )}
                </Table.Td>

                <Table.Td>
                    {/* Only somebody holding `delete` may hand it out — the service says so. */}
                    {hasScope("delete") ? (
                        <Switch
                            size="sm"
                            checked={user.scopes.includes("delete")}
                            onChange={(event) => setScope("delete", event.currentTarget.checked)}
                            aria-label={`${user.displayName} may delete files`}
                        />
                    ) : (
                        <Text size="xs" c="dimmed">
                            {user.scopes.includes("delete") ? "yes" : "no"}
                        </Text>
                    )}
                </Table.Td>

                <Table.Td>
                    <Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>
                        {user.invitedAs ?? "set up the library"}
                    </Text>
                </Table.Td>

                <Table.Td>
                    <Group gap="xs" justify="flex-end" wrap="nowrap">
                        {/*
                         * A menu rather than a row of buttons, once there are four actions.
                         * Editing details is offered on every row including your own — fixing
                         * your own name is not a door that locks behind you. Setting a password
                         * is not: your own lives on /account, where it asks for the one you are
                         * replacing, and the server refuses it here for that reason. So the
                         * item is absent rather than present-and-refused.
                         */}
                        <Menu position="bottom-end" withinPortal>
                            <Menu.Target>
                                <ActionIcon
                                    variant="subtle"
                                    color="brass"
                                    aria-label={`Manage ${user.displayName}`}
                                >
                                    <MoreGlyph size={18} />
                                </ActionIcon>
                            </Menu.Target>

                            <Menu.Dropdown>
                                <Menu.Item onClick={() => setDialog("details")}>
                                    Edit name and email
                                </Menu.Item>

                                {!user.isSelf && (
                                    <>
                                        <Menu.Item onClick={() => setDialog("password")}>
                                            Set a password
                                        </Menu.Item>

                                        <Menu.Divider />

                                        <Menu.Item
                                            onClick={() =>
                                                update.mutate({
                                                    id: user.id,
                                                    patch: { disabled: !user.disabled },
                                                })
                                            }
                                        >
                                            {user.disabled
                                                ? "Enable this account"
                                                : "Disable this account"}
                                        </Menu.Item>

                                        <Menu.Item
                                            color="oxblood"
                                            onClick={() => setConfirming(true)}
                                        >
                                            Remove from the library
                                        </Menu.Item>
                                    </>
                                )}
                            </Menu.Dropdown>
                        </Menu>
                    </Group>
                </Table.Td>
            </Table.Tr>

            {dialog === "password" && <SetPassword user={user} onClose={() => setDialog(null)} />}

            {dialog === "details" && <EditDetails user={user} onClose={() => setDialog(null)} />}

            <Modal
                opened={confirming}
                onClose={() => setConfirming(false)}
                title={`Remove ${user.displayName}?`}
            >
                <Stack gap="md">
                    {/*
                     * The house style for a destructive dialogue: say what happens, and say
                     * what does not. "Are you sure" asks a question the person cannot answer
                     * without knowing exactly this.
                     */}
                    <Text size="sm">
                        Their ratings, watch history, private tags, saved views and playlists are
                        deleted with the account. Nothing in the library itself is touched, and
                        anything they shared stays — without their name on it.
                    </Text>
                    <Text size="sm" c="dimmed">
                        They can be invited back, but nothing above comes back with them.
                    </Text>
                    <Group justify="flex-end">
                        <Button variant="default" onClick={() => setConfirming(false)}>
                            Keep the account
                        </Button>
                        <Button
                            color="oxblood"
                            loading={remove.isPending}
                            onClick={() =>
                                remove.mutate(user.id, { onSuccess: () => setConfirming(false) })
                            }
                        >
                            Remove {user.displayName}
                        </Button>
                    </Group>
                </Stack>
            </Modal>
        </>
    );
};

export const AccessCards: React.FC = () => {
    const [inviting, setInviting] = useState(false);
    const users = useManagedUsers();
    const invitations = useInvitations();

    return (
        <>
            <Card p="md">
                <Stack gap="md">
                    <Stack gap={2}>
                        <Title order={4}>People</Title>
                        <Text size="sm" c="dimmed">
                            Everyone who can sign in. Each account keeps its own ratings, watch
                            history, private tags and playlists; the library itself is shared.
                        </Text>
                    </Stack>

                    <Table.ScrollContainer minWidth={640}>
                        <Table verticalSpacing="sm">
                            <Table.Thead>
                                <Table.Tr>
                                    <Table.Th>Person</Table.Th>
                                    <Table.Th>Administrator</Table.Th>
                                    <Table.Th>May delete</Table.Th>
                                    <Table.Th>Joined via</Table.Th>
                                    <Table.Th />
                                </Table.Tr>
                            </Table.Thead>
                            <Table.Tbody>
                                {users.data?.users.map((user) => (
                                    <UserRow key={user.id} user={user} />
                                ))}
                            </Table.Tbody>
                        </Table>
                    </Table.ScrollContainer>
                </Stack>
            </Card>

            <Card p="md">
                <Stack gap="md">
                    <Group justify="space-between" align="flex-start" wrap="wrap" gap="sm">
                        <Stack gap={2}>
                            <Title order={4}>Invitations</Title>
                            <Text size="sm" c="dimmed">
                                An invitation is the only way to create an account — there is no
                                open sign-up. Anyone holding a code can join; only an administrator
                                can hand one out.
                            </Text>
                        </Stack>

                        <Button variant="light" onClick={() => setInviting(true)}>
                            Invite someone
                        </Button>
                    </Group>

                    {invitations.data?.invitations.length === 0 ? (
                        <Text size="sm" c="dimmed">
                            No invitations yet. Create one to let somebody else in.
                        </Text>
                    ) : (
                        <Table.ScrollContainer minWidth={620}>
                            <Table verticalSpacing="sm">
                                <Table.Thead>
                                    <Table.Tr>
                                        <Table.Th>Code</Table.Th>
                                        <Table.Th>Used</Table.Th>
                                        <Table.Th>Created</Table.Th>
                                        <Table.Th />
                                    </Table.Tr>
                                </Table.Thead>
                                <Table.Tbody>
                                    {invitations.data?.invitations.map((invitation) => (
                                        <InvitationRow
                                            key={invitation.id}
                                            invitation={invitation}
                                        />
                                    ))}
                                </Table.Tbody>
                            </Table>
                        </Table.ScrollContainer>
                    )}
                </Stack>
            </Card>

            <NewInvitation opened={inviting} onClose={() => setInviting(false)} />
        </>
    );
};
