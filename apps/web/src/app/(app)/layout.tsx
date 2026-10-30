"use client";

import { Suspense } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
    AppShell,
    Badge,
    Burger,
    Group,
    Menu,
    NavLink,
    RemoveScroll,
    ScrollArea,
    Skeleton,
    Stack,
    Title,
} from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";

import { AboutModal } from "@/components/shell/AboutModal";
import { ActivityRail } from "@/components/shell/ActivityRail";
import { AppNavbar, AppNavbarUpkeep } from "@/components/shell/AppNavbar";
import { ArrivalScroll } from "@/components/shell/ArrivalScroll";
import { HeaderPlateTitle } from "@/components/shell/HeaderPlateTitle";
import { HeaderSearch } from "@/components/shell/HeaderSearch";
import { PageTurn } from "@/components/shell/PageTurn";
import { useScreenLock } from "@/components/shell/ScreenLock";
import { BusySeal } from "@/components/shell/BusySeal";
import { UpdateNotice } from "@/components/shell/UpdateNotice";
import { RequireAuth, useAuth } from "@/lib/api/AuthProvider";
import { useLibraryStats } from "@/lib/api/libraries";

// The page turn and the morph's pseudo-elements (§14, "Motion"). Global, because
// `::view-transition-*` hangs off the document root, which no module class can reach.
import "./viewTransitions.scss";

/**
 * The application shell.
 *
 * Responsive from the start (§14): the nav collapses to a burger below the `sm` breakpoint
 * rather than being bolted on later, and the header, the nav and the page each pay the
 * safe-area insets that `viewport-fit=cover` in the root layout buys.
 *
 * The nav itself lives in its own component behind a Suspense boundary. It reads the current
 * library from the URL, and `useSearchParams` called directly in a shared layout opts every
 * page under that layout out of static rendering — the build fails on `/duplicates` for a
 * hook the duplicates page has never heard of.
 */
const AppLayout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [opened, { toggle, close }] = useDisclosure();
    const [aboutOpened, about] = useDisclosure();
    const isMobile = useMediaQuery("(max-width: 48em)");
    const { user, signOut } = useAuth();
    const { lockAfter, lockNow } = useScreenLock();
    const pathname = usePathname();

    // For the "Scanning" badge only. One shared query rather than a copy here: `useLibraryStats`
    // owns the poll interval, and the interval is the part that turned out to matter (§20).
    const { data: stats } = useLibraryStats();

    return (
        <RequireAuth>
            <AppShell
                // The bar is 56px of chrome *plus* whatever the phone puts above it. Passing a
                // bare 56 is what makes a notched device draw the title under its own status
                // bar: `viewport-fit=cover` in the root layout is what lets the ground colour
                // reach the edges, and the cost of that is paying the insets here (§14).
                header={{ height: "calc(56px + var(--ps-safe-top))" }}
                navbar={{
                    width: 240,
                    breakpoint: "sm",
                    collapsed: { mobile: !opened },
                }}
                padding={isMobile ? "sm" : "md"}
            >
                <AppShell.Header style={{ paddingTop: "var(--ps-safe-top)" }}>
                    <Group
                        h="100%"
                        justify="space-between"
                        wrap="nowrap"
                        // The same padding the page body uses, rather than a fixed `md`, so
                        // the wordmark sits on the content column at both breakpoints.
                        style={{
                            paddingInlineStart:
                                "calc(var(--app-shell-padding) + var(--ps-safe-left))",
                            paddingInlineEnd:
                                "calc(var(--app-shell-padding) + var(--ps-safe-right))",
                        }}
                    >
                        <Group gap="sm" wrap="nowrap">
                            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
                            {/* The wordmark is the way home, as it is everywhere else.
                                The anchor wraps the heading rather than Title rendering as
                                one: Title's polymorphism does not carry `href` through. */}
                            <Link href="/" style={{ color: "inherit", textDecoration: "none" }}>
                                <Group gap={8} wrap="nowrap">
                                    <BusySeal size={26} />
                                    <Title order={4} style={{ whiteSpace: "nowrap" }}>
                                        private-stock
                                    </Title>
                                </Group>
                            </Link>
                            {/* The plate's title, once the plate has scrolled away. */}
                            <HeaderPlateTitle />
                        </Group>

                        {/* The header search (§14): a box in the middle of the bar on a wide
                            screen, an icon at its end on a phone. */}
                        {!isMobile && <HeaderSearch compact={false} />}

                        <Group gap="xs" wrap="nowrap">
                            {stats?.scanning && (
                                <Badge color="brass" variant="light" visibleFrom="xs">
                                    Scanning
                                </Badge>
                            )}
                            {/* No queue depth here.

                                "14 queued" is the state of the worker, not of the library:
                                it goes up when something is being made and down when it is
                                made, and there is nothing a person can do with the number in
                                between. It sat on every screen including the front door,
                                which is the one place the app is supposed to be about the
                                collection rather than about the machine. The queue is on the
                                admin screen in full, where somebody can act on it.

                                "Scanning" stays: the catalogue is growing under you, which
                                changes what you are looking at. */}
                            {isMobile && <HeaderSearch compact />}
                        </Group>
                    </Group>
                    {/* Along the header's bottom edge, under every page (§14, "Waiting"). */}
                    <ActivityRail />
                </AppShell.Header>

                {/* On a phone the open nav covers the page, but it is only a fixed panel: a
                    drag on it that runs out of list, or lands where nothing scrolls, carried on
                    into the page underneath. The same lock Mantine's modals use -- the page
                    stays put and the nav's own list still scrolls. Only while it is open over
                    the page; on desktop the nav sits beside it and the page must scroll. */}
                <RemoveScroll enabled={Boolean(isMobile) && opened} forwardProps>
                    <AppShell.Navbar
                        py="sm"
                        style={{
                            // 6px of rail, so the rounded active highlight has an edge to sit
                            // inside rather than butting against the border. The links make up
                            // the rest, so a label still lands exactly under the wordmark.
                            paddingInlineStart: "calc(6px + var(--ps-safe-left))",
                            paddingInlineEnd: "6px",
                            paddingBottom:
                                "calc(var(--mantine-spacing-sm) + var(--ps-safe-bottom))",
                        }}
                    >
                        {/* The scrollbar overlays the content by default, and in a rail this
                            narrow it landed on the counts and the recent searches' close
                            buttons. `present` reserves a gutter for it only while the list
                            actually overflows, so a short list keeps its full width. */}
                        <AppShell.Section
                            grow
                            component={ScrollArea}
                            scrollbars="y"
                            scrollbarSize={8}
                            offsetScrollbars="present"
                        >
                            <Suspense
                                fallback={
                                    <Stack gap={6} p="xs">
                                        <Skeleton height={28} radius="sm" />
                                        <Skeleton height={28} radius="sm" />
                                        <Skeleton height={28} radius="sm" />
                                    </Stack>
                                }
                            >
                                <AppNavbar onNavigate={close} />
                            </Suspense>
                        </AppShell.Section>

                        {/* Outside the scrolling list and above the account: the upkeep pages sit
                        at the foot with it, ruled off from the destinations (§14). */}
                        <AppShell.Section>
                            <AppNavbarUpkeep onNavigate={close} />
                        </AppShell.Section>

                        {/* Its own section, so it sits at the foot of the rail. Inside the
                        scrolling section a `mt="auto"` never reaches the bottom — it had been
                        sitting directly under "Admin" as if it were another destination.

                        A menu rather than a link, because it holds more than one thing: your
                        account (§12c), what this build is, and signing out. It used to be only the second, which meant the
                        one entry with your name on it signed you out the moment you touched it.
                        The address underneath answers "which account am I in". */}
                        <AppShell.Section>
                            <Menu position="top-start" width="target" withinPortal>
                                <Menu.Target>
                                    <NavLink
                                        component="button"
                                        label={user?.displayName ?? "Account"}
                                        description={user?.email}
                                        active={pathname === "/account"}
                                        color="brass"
                                        style={{
                                            paddingInline: "calc(var(--app-shell-padding) - 6px)",
                                            minHeight: 44,
                                        }}
                                    />
                                </Menu.Target>

                                <Menu.Dropdown>
                                    <Menu.Item
                                        component={Link}
                                        href="/account"
                                        prefetch={false}
                                        onClick={close}
                                        mih={44}
                                    >
                                        Account settings
                                    </Menu.Item>
                                    <Menu.Item
                                        onClick={() => {
                                            close();
                                            about.open();
                                        }}
                                        mih={44}
                                    >
                                        About
                                    </Menu.Item>
                                    {/* Only where this device locks (§12c). */}
                                    {lockAfter !== null && (
                                        <Menu.Item
                                            onClick={() => {
                                                close();
                                                lockNow();
                                            }}
                                            mih={44}
                                        >
                                            Lock now
                                        </Menu.Item>
                                    )}
                                    <Menu.Item onClick={() => void signOut()} mih={44}>
                                        Sign out
                                    </Menu.Item>
                                </Menu.Dropdown>
                            </Menu>
                        </AppShell.Section>
                    </AppShell.Navbar>
                </RemoveScroll>

                {/* The gesture bar sits on top of the last thing on the page, so the page has
                    to end above it. Padding rather than margin: a scroll container's margin
                    collapses and the bottom of the library goes back under the bar.

                    **The offsets have to be restated.** AppShell.Main's own rule is
                    `calc(var(--app-shell-navbar-offset) + var(--app-shell-padding))`, and that
                    first term is the entire reason the page clears the sidebar. Overriding the
                    padding with the second term alone drops it, and the library slides under
                    the navbar — which is exactly what happened. Logical properties, to match
                    the rule being replaced. */}
                <AppShell.Main
                    style={{
                        paddingInlineStart:
                            "calc(var(--app-shell-navbar-offset, 0rem) + var(--app-shell-padding) + var(--ps-safe-left))",
                        paddingInlineEnd:
                            "calc(var(--app-shell-aside-offset, 0rem) + var(--app-shell-padding) + var(--ps-safe-right))",
                        paddingBottom:
                            "calc(var(--app-shell-footer-offset, 0rem) + var(--app-shell-padding) + var(--ps-safe-bottom))",
                    }}
                >
                    {children}
                </AppShell.Main>
            </AppShell>

            <AboutModal opened={aboutOpened} onClose={about.close} />
            <UpdateNotice />
            <ArrivalScroll />
            {/* Its own Suspense boundary, for the reason the nav has one: it reads the search
                params, and a bare `useSearchParams` in a shared layout opts every page out of
                static rendering. */}
            <Suspense fallback={null}>
                <PageTurn />
            </Suspense>
        </RequireAuth>
    );
};

export default AppLayout;
