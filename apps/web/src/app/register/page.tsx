"use client";

import {
    Alert,
    Button,
    Card,
    Center,
    PasswordInput,
    Stack,
    Text,
    TextInput,
    Title,
} from "@mantine/core";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

import { formatInvitationCode, normalizeInvitationCode, passwordSchema } from "@private-stock/core";

import { useAuth } from "@/lib/api/AuthProvider";
import { ApiError } from "@/lib/api/client";

/**
 * Creating an account from an invitation (§12c).
 *
 * The only way in besides `/setup`. There is no open registration and no setting that turns
 * one on, so this page is useless without a code — which is why it says so plainly at the top
 * rather than letting somebody fill in four fields to find out.
 *
 * The code may arrive in the query string, so an administrator can send a whole link rather
 * than dictating ten characters. It is still shown in the field, editable: a link that went
 * through a chat client which mangled the last character has to be fixable without going back
 * to ask for it again.
 */
const RegisterForm: React.FC = () => {
    const router = useRouter();
    const params = useSearchParams();
    const { signIn } = useAuth();

    const [code, setCode] = useState(() =>
        formatInvitationCode(normalizeInvitationCode(params.get("code") ?? ""))
    );
    const [email, setEmail] = useState("");
    const [displayName, setDisplayName] = useState("");
    const [password, setPassword] = useState("");
    const [confirm, setConfirm] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
    const [busy, setBusy] = useState(false);

    const submit = async (event: React.FormEvent) => {
        event.preventDefault();
        setError(null);
        setFieldErrors({});

        if (password !== confirm) {
            setFieldErrors({ confirm: "Passwords do not match" });
            return;
        }

        setBusy(true);

        try {
            const response = await fetch("/api/auth/register", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    invitationCode: code,
                    email,
                    displayName: displayName || email,
                    password,
                }),
            });

            if (!response.ok) {
                const body = (await response.json()) as {
                    code?: string;
                    message?: string;
                    requestId?: string;
                    issues?: { path: string; message: string }[];
                };

                throw new ApiError(
                    response.status,
                    body.code ?? "UNKNOWN",
                    body.message ?? "Could not create the account",
                    body.requestId,
                    body.issues
                );
            }

            // Straight in, as `/setup` does. Asking somebody to retype the password they chose
            // thirty seconds ago proves nothing the invitation has not already established.
            await signIn(email, password);
            router.replace("/");
        } catch (caught) {
            if (caught instanceof ApiError) {
                setFieldErrors(caught.fieldErrors);

                const unattached = (caught.issues ?? []).filter((issue) => !issue.path);
                setError(
                    caught.issues?.length
                        ? unattached.map((issue) => issue.message).join(". ") || null
                        : caught.message
                );
            } else {
                setError(caught instanceof Error ? caught.message : "Could not create the account");
            }
        } finally {
            setBusy(false);
        }
    };

    return (
        <Center mih="100dvh" px="md" py="xl">
            <Card w="100%" maw={440} p="xl" radius="md">
                <form onSubmit={submit} noValidate>
                    <Stack gap="lg">
                        <Stack gap={4}>
                            <Title order={2}>Join the library</Title>
                            <Text size="sm" c="dimmed">
                                You need an invitation code. Whoever runs the library can give you
                                one.
                            </Text>
                        </Stack>

                        {error && (
                            <Alert color="oxblood" variant="light">
                                {error}
                            </Alert>
                        )}

                        <TextInput
                            label="Invitation code"
                            placeholder="ABCDE-FGHJK"
                            value={code}
                            // Reformatted as it is typed, so the grouping the code was read
                            // aloud in appears whichever way it is entered — and the value
                            // sent is canonical however it looked on the way in.
                            onChange={(event) =>
                                setCode(
                                    formatInvitationCode(
                                        normalizeInvitationCode(event.currentTarget.value)
                                    )
                                )
                            }
                            error={fieldErrors.invitationCode}
                            autoFocus
                            required
                            styles={{
                                input: { fontFamily: "var(--mantine-font-family-monospace)" },
                            }}
                        />

                        <TextInput
                            label="Email"
                            type="email"
                            inputMode="email"
                            value={email}
                            onChange={(event) => setEmail(event.currentTarget.value)}
                            error={fieldErrors.email}
                            autoComplete="username"
                            required
                        />

                        <TextInput
                            label="Display name"
                            placeholder="Optional"
                            value={displayName}
                            onChange={(event) => setDisplayName(event.currentTarget.value)}
                            error={fieldErrors.displayName}
                        />

                        <PasswordInput
                            label="Password"
                            description={`At least ${passwordSchema.minLength} characters`}
                            value={password}
                            onChange={(event) => setPassword(event.currentTarget.value)}
                            error={fieldErrors.password}
                            autoComplete="new-password"
                            required
                        />

                        <PasswordInput
                            label="Confirm password"
                            value={confirm}
                            onChange={(event) => setConfirm(event.currentTarget.value)}
                            error={fieldErrors.confirm}
                            autoComplete="new-password"
                            required
                        />

                        <Button type="submit" loading={busy} fullWidth>
                            Create account
                        </Button>

                        <Text size="sm" c="dimmed" ta="center">
                            Already have an account? <Link href="/login">Sign in</Link>
                        </Text>
                    </Stack>
                </form>
            </Card>
        </Center>
    );
};

/**
 * `useSearchParams` opts the whole route into client rendering unless it sits under a
 * boundary, and without one the build fails rather than warning.
 */
const RegisterPage: React.FC = () => (
    <Suspense fallback={null}>
        <RegisterForm />
    </Suspense>
);

export default RegisterPage;
