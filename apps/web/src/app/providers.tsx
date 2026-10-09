"use client";

import { useState } from "react";
import { MantineProvider, type CSSVariablesResolver } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { WarmingHud } from "@/components/debug/WarmingHud";
import { AuthProvider } from "@/lib/api/AuthProvider";
import { theme } from "@/theme";

/**
 * `theme.other` as CSS variables, so the SCSS modules read the same tokens the TSX does.
 *
 * Without this there are two palettes: `theme.other` for anything written in JS, and
 * hardcoded hexes in every `.module.scss`. They drift, and the symptom is a surface that is
 * warm on one screen and grey on the next with no single place to fix it.
 */
const cssVariablesResolver: CSSVariablesResolver = (mantineTheme) => ({
    variables: {
        "--ps-ground": mantineTheme.other.groundDark,
        "--ps-surface": mantineTheme.other.surfaceDark,
        "--ps-well": mantineTheme.other.wellDark,
        "--ps-hairline": mantineTheme.other.hairline,
        "--ps-hairline-strong": mantineTheme.other.hairlineStrong,
        "--ps-hairline-fade": mantineTheme.other.hairlineFade,
        "--ps-plate-rule": mantineTheme.other.plateRule,
        "--ps-hover-glow": mantineTheme.other.hoverGlow,
        "--ps-voice-glow": mantineTheme.other.voiceGlow,
        "--ps-voice-glow-soft": mantineTheme.other.voiceGlowSoft,
        "--ps-rack-edge": mantineTheme.other.rackEdge,
        /**
         * The display titles' warm cream, and the drawer's body text: one token each rather
         * than a hex repeated across six stylesheets.
         */
        "--ps-title": mantineTheme.colors.brass[2],
        "--ps-text-warm": mantineTheme.other.textWarm,
        "--ps-diag-ready": mantineTheme.other.diagReady,
        "--ps-diag-pending": mantineTheme.other.diagPending,
        "--ps-diag-off": mantineTheme.other.diagOff,
        "--ps-diag-miss": mantineTheme.other.diagMiss,
        "--ps-diag-panel": mantineTheme.other.diagPanel,
    },
    light: {},
    dark: {
        /**
         * Secondary text is oak, not grey.
         *
         * Mantine's `dimmed` resolves to #828282 -- perfectly neutral, R=G=B -- and it
         * carries tile metadata, every page subtitle and the breadcrumbs. On the near-black
         * ground that reads faintly blue and dead, while the room and the details drawer use
         * warm secondaries a few lines away. Overriding the token rather than the call sites
         * warms roughly forty of them at once, and means `c="dimmed"` stays the right thing
         * to write.
         *
         * In `dark`, not `variables`: Mantine declares its own `dimmed` under the dark scheme's
         * selector, which is more specific than `:root`, so set here it was silently beaten and
         * every dimmed line measured #828282 anyway.
         */
        "--mantine-color-dimmed": mantineTheme.colors.oak[3],
    },
});

/**
 * Client providers.
 *
 * The QueryClient is created inside state rather than at module scope: a module-level client
 * is shared across every request on the server, which would leak one user's cached library
 * into another's response.
 */
export const Providers: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [queryClient] = useState(
        () =>
            new QueryClient({
                defaultOptions: {
                    queries: {
                        // The library changes only when the worker scans, so refetching on
                        // every window focus is churn. Live updates arrive via SSE in phase 2.
                        refetchOnWindowFocus: false,
                        staleTime: 30_000,
                        retry: 1,
                    },
                },
            })
    );

    return (
        <MantineProvider
            theme={theme}
            forceColorScheme="dark"
            cssVariablesResolver={cssVariablesResolver}
        >
            <QueryClientProvider client={queryClient}>
                <AuthProvider>
                    {children}
                    {/* Here rather than in the app shell, so it is over the tasting too. */}
                    <WarmingHud />
                </AuthProvider>
            </QueryClientProvider>
        </MantineProvider>
    );
};
