"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Center, Loader } from "@mantine/core";

import type { Scope, SessionUser } from "@private-stock/core";

import * as client from "./client";

/**
 * Session state for the app shell.
 *
 * On mount it attempts a refresh rather than assuming signed-out. The refresh cookie is the
 * thing that survives a reload, so without this every page load would bounce a signed-in
 * user to the login screen.
 */

interface AuthState {
    user: SessionUser | null;
    ready: boolean;
    signIn: (email: string, password: string) => Promise<void>;
    signOut: () => Promise<void>;
    /**
     * Re-read the signed-in account from the server.
     *
     * The session user was set once, at sign-in, and then never again — so anything that
     * changed the account afterwards left the shell showing what was true when the person
     * signed in. The foot of the navbar is where it showed: renaming your own account from
     * Admin › People updated the row and the database and went on calling you the old name
     * until a reload.
     *
     * A scope granted by another administrator has the same shape of staleness, and it is the
     * worse one: the server reads scopes from the row on every request, so the affordances the
     * shell offers and the ones the server honours drift apart.
     */
    refreshUser: () => Promise<void>;
    hasScope: (scope: Scope) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [user, setUser] = useState<SessionUser | null>(null);
    const [ready, setReady] = useState(false);

    useEffect(() => {
        let cancelled = false;

        void client.refreshSession().then((ok) => {
            if (cancelled) return;

            setUser(ok ? client.getCurrentUser() : null);
            setReady(true);
        });

        return () => {
            cancelled = true;
        };
    }, []);

    // A refresh refused mid-session sends the shell to the login page (`RequireAuth`) instead
    // of leaving it on screen, where every query would go on taking 401s.
    useEffect(() => client.onSignedOut(() => setUser(null)), []);

    const signIn = useCallback(async (email: string, password: string) => {
        setUser(await client.login(email, password));
    }, []);

    const signOut = useCallback(async () => {
        await client.logout();
        setUser(null);
    }, []);

    const refreshUser = useCallback(async () => {
        setUser(await client.fetchCurrentUser());
    }, []);

    const hasScope = useCallback((scope: Scope) => user?.scopes.includes(scope) ?? false, [user]);

    const value = useMemo<AuthState>(
        () => ({ user, ready, signIn, signOut, refreshUser, hasScope }),
        [user, ready, signIn, signOut, refreshUser, hasScope]
    );

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = (): AuthState => {
    const context = useContext(AuthContext);

    if (!context) {
        throw new Error("useAuth must be used inside AuthProvider");
    }

    return context;
};

/**
 * Gate for pages that need a session.
 *
 * Renders a loader until the refresh attempt settles — redirecting before then would send a
 * signed-in user to the login page on every reload.
 */
export const RequireAuth: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { user, ready } = useAuth();
    const router = useRouter();

    useEffect(() => {
        if (ready && !user) {
            router.replace("/login");
        }
    }, [ready, user, router]);

    if (!ready || !user) {
        return (
            <Center h="100dvh">
                <Loader color="brass" />
            </Center>
        );
    }

    return <>{children}</>;
};
