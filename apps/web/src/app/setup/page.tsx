"use client";

import {
    Alert,
    Button,
    Card,
    Center,
    Code,
    PasswordInput,
    Stack,
    Text,
    TextInput,
    Title,
} from "@mantine/core";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { passwordSchema, type SetupStatus } from "@private-stock/core";

import { useAuth } from "@/lib/api/AuthProvider";
import { ApiError } from "@/lib/api/client";

/**
 * First-run admin creation (§12c).
 *
 * Only reachable while no users exist. From a remote address it additionally demands the
 * token printed to the container log, so exposing the port before setup is finished does not
 * hand the library to whoever arrives first.
 */
const SetupPage: React.FC = () => {
    const router = useRouter();
    const { signIn } = useAuth();

    const [status, setStatus] = useState<SetupStatus | null>(null);
    const [email, setEmail] = useState("");
    const [displayName, setDisplayName] = useState("");
    const [password, setPassword] = useState("");
    const [confirm, setConfirm] = useState("");
    const [setupToken, setSetupToken] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        void fetch("/api/setup/status")
            .then((response) => response.json() as Promise<SetupStatus>)
            .then((value) => {
                setStatus(value);
                if (!value.needsSetup) {
                    router.replace("/login");
                }
            })
            .catch(() => setError("Could not reach the server"));
    }, [router]);

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
            const response = await fetch("/api/setup", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    email,
                    displayName: displayName || email,
                    password,
                    setupToken: setupToken || undefined,
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
                    body.message ?? "Setup failed",
                    body.requestId,
                    body.issues
                );
            }

            // Sign straight in — asking someone to retype credentials they just chose is
            // friction with no purpose.
            await signIn(email, password);
            router.replace("/");
        } catch (caught) {
            if (caught instanceof ApiError) {
                // Put each problem next to the input that caused it. A bare "Request failed
                // validation" is what turned a typo into a guessing game.
                setFieldErrors(caught.fieldErrors);

                const unattached = (caught.issues ?? []).filter((issue) => !issue.path);
                setError(
                    caught.issues?.length
                        ? unattached.map((issue) => issue.message).join(". ") || null
                        : caught.message
                );
            } else {
                setError(caught instanceof Error ? caught.message : "Setup failed");
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
                            <Title order={2}>Welcome</Title>
                            <Text size="sm" c="dimmed">
                                Create the first account. It will be an administrator.
                            </Text>
                        </Stack>

                        {error && (
                            <Alert color="oxblood" variant="light">
                                {error}
                            </Alert>
                        )}

                        {status && !status.isLocalRequest && (
                            <Alert color="brass" variant="light">
                                Nothing here can confirm where you are connecting from, so setup
                                requires the one-time token printed in the server log —
                                <Code>docker logs private-stock</Code>. It changes every time the
                                server restarts.
                            </Alert>
                        )}

                        <TextInput
                            label="Email"
                            type="email"
                            inputMode="email"
                            value={email}
                            onChange={(event) => setEmail(event.currentTarget.value)}
                            error={fieldErrors.email}
                            autoComplete="username"
                            autoFocus
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

                        {status && !status.isLocalRequest && (
                            <TextInput
                                label="Setup token"
                                value={setupToken}
                                onChange={(event) => setSetupToken(event.currentTarget.value)}
                                error={fieldErrors.setupToken}
                                required
                            />
                        )}

                        <Button type="submit" loading={busy} fullWidth>
                            Create account
                        </Button>
                    </Stack>
                </form>
            </Card>
        </Center>
    );
};

export default SetupPage;
