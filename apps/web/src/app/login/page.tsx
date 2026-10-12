"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
    Alert,
    Anchor,
    Button,
    Card,
    Center,
    PasswordInput,
    Stack,
    Text,
    TextInput,
    Title,
} from "@mantine/core";

import type { SetupStatus } from "@private-stock/core";

import { CorkStamp } from "@/components/shell/CorkStamp";
import { useAuth } from "@/lib/api/AuthProvider";
import { ApiError } from "@/lib/api/client";

/**
 * Sign-in.
 *
 * Also the place that notices setup has never been completed and redirects — a first-run
 * install would otherwise present a login form against an empty user table with no way
 * forward.
 */
const LoginPage: React.FC = () => {
    const router = useRouter();
    const { user, ready, signIn } = useAuth();

    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        void fetch("/api/setup/status")
            .then((response) => (response.ok ? (response.json() as Promise<SetupStatus>) : null))
            .then((status) => {
                if (status?.needsSetup) {
                    router.replace("/setup");
                }
            })
            .catch(() => {
                // A failing status check should not block the login form; the sign-in attempt
                // will report anything genuinely wrong.
            });
    }, [router]);

    useEffect(() => {
        if (ready && user) {
            router.replace("/");
        }
    }, [ready, user, router]);

    const submit = async (event: React.FormEvent) => {
        event.preventDefault();
        setError(null);
        setFieldErrors({});
        setBusy(true);

        try {
            await signIn(email, password);
            router.replace("/");
        } catch (caught) {
            if (caught instanceof ApiError) {
                setFieldErrors(caught.fieldErrors);
                // An auth failure has no field detail by design — one message for wrong
                // password and unknown account alike, so neither enumerates accounts.
                setError(caught.issues?.length ? null : caught.message);
            } else {
                setError(caught instanceof Error ? caught.message : "Sign in failed");
            }
        } finally {
            setBusy(false);
        }
    };

    return (
        <Center mih="100dvh" px="md">
            <Card w="100%" maw={400} p="xl" radius="md">
                <form onSubmit={submit} noValidate>
                    <Stack gap="lg">
                        <Stack gap={4}>
                            <CorkStamp size={120} />
                            <Title order={2}>private-stock</Title>
                            <Text size="sm" c="dimmed">
                                Sign in to your library
                            </Text>
                        </Stack>

                        {error && (
                            <Alert color="oxblood" variant="light">
                                {error}
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

                        <PasswordInput
                            label="Password"
                            value={password}
                            onChange={(event) => setPassword(event.currentTarget.value)}
                            error={fieldErrors.password}
                            autoComplete="current-password"
                            required
                        />

                        <Button type="submit" loading={busy} fullWidth>
                            Sign in
                        </Button>

                        {/*
                         * Stated rather than offered as a call to action. There is no open
                         * sign-up, so somebody without a code has nothing to do here — and a
                         * prominent "Create an account" would send them to a page that can
                         * only turn them away.
                         */}
                        <Text size="xs" c="dimmed" ta="center">
                            Been given an invitation code?{" "}
                            <Anchor component={Link} href="/register" inherit>
                                Use it to join
                            </Anchor>
                        </Text>
                    </Stack>
                </form>
            </Card>
        </Center>
    );
};

export default LoginPage;
