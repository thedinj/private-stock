"use client";

import { useEffect, useRef, useState } from "react";
import { Group, Menu, Title, UnstyledButton } from "@mantine/core";

import { domainKinds, domainProfiles } from "@private-stock/core";

import { Glyph } from "@/components/media/Glyph";
import { useEnabledRooms } from "@/lib/api/rooms";
import { getActiveDomain, switchDomain } from "@/lib/activeDomain";

/** Pointer resting on the open menu this long shows the hidden line. */
const DWELL_MS = 1_500;

/** Holding the room name this long opens the menu with the hidden line already showing. */
const LONG_PRESS_MS = 500;

const ChevronGlyph: React.FC = () => (
    <Glyph size={14}>
        <path d="M6 9l6 6 6-6" />
    </Glyph>
);

/**
 * The room name in the header, and the way to the others (§21).
 *
 * A guarded room is not listed. The menu shows the rooms anyone may see, and the way to a guarded
 * one is a faint line that appears only when the menu is held: the pointer resting on the open
 * menu for a second and a half, or the room name pressed and held (a finger, or a mouse button
 * kept down). Closing the menu hides it again; nothing remembers it was shown. The line says only
 * the room's `entrance` ("The stair"), never its name, and the rack at the bottom of it asks for
 * the PIN (`DomainGate`).
 *
 * A room an administrator has turned off is not in it at all, the stair included (§21 "Turning a
 * room off"). With no other room on, the name is only a name.
 */
export const DomainSwitcher: React.FC = () => {
    const active = getActiveDomain();
    const rooms = useEnabledRooms();
    const others = domainKinds.filter((kind) => kind !== active && rooms.includes(kind));
    const listed = others.filter((kind) => !domainProfiles[kind].guarded);
    const hidden = others.filter((kind) => domainProfiles[kind].guarded);

    const [opened, setOpened] = useState(false);
    const [revealed, setRevealed] = useState(false);
    const dwell = useRef<number | null>(null);
    const press = useRef<number | null>(null);
    /** A long press opened the menu; the click that ends it must not close it again. */
    const swallowClick = useRef(false);

    const stopTimer = (timer: React.MutableRefObject<number | null>) => {
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = null;
    };

    useEffect(
        () => () => {
            stopTimer(dwell);
            stopTimer(press);
        },
        []
    );

    const onChange = (next: boolean) => {
        if (!next && swallowClick.current) {
            swallowClick.current = false;
            return;
        }

        setOpened(next);

        if (!next) {
            stopTimer(dwell);
            setRevealed(false);
        }
    };

    // `ps-room-name`: each room may sign its own name (globals.scss).
    const name = (
        <Title order={4} className="ps-room-name" style={{ whiteSpace: "nowrap" }}>
            {domainProfiles[active].label}
        </Title>
    );

    if (others.length === 0) {
        return (
            <Group mih={44} wrap="nowrap">
                {name}
            </Group>
        );
    }

    return (
        <Menu position="bottom-start" withinPortal opened={opened} onChange={onChange}>
            <Menu.Target>
                <UnstyledButton
                    aria-label={`${domainProfiles[active].label}. Change room`}
                    mih={44}
                    style={{
                        display: "flex",
                        alignItems: "center",
                        userSelect: "none",
                        WebkitUserSelect: "none",
                        WebkitTouchCallout: "none",
                    }}
                    onPointerDown={() => {
                        if (hidden.length === 0) return;
                        swallowClick.current = false;
                        stopTimer(press);
                        press.current = window.setTimeout(() => {
                            press.current = null;
                            // The click that ends the press would toggle the menu shut again.
                            // Swallowed once, and only for a moment, so a press that ends with
                            // no click (the finger slid off) cannot eat a later close.
                            swallowClick.current = true;
                            window.setTimeout(() => (swallowClick.current = false), 600);
                            setOpened(true);
                            setRevealed(true);
                        }, LONG_PRESS_MS);
                    }}
                    onPointerUp={() => stopTimer(press)}
                    onPointerLeave={() => stopTimer(press)}
                    onPointerCancel={() => stopTimer(press)}
                    // A held finger otherwise brings up the browser's own menu.
                    onContextMenu={(event) => {
                        if (hidden.length > 0) event.preventDefault();
                    }}
                >
                    <Group gap={4} wrap="nowrap">
                        {name}
                        <ChevronGlyph />
                    </Group>
                </UnstyledButton>
            </Menu.Target>
            <Menu.Dropdown
                onPointerEnter={(event) => {
                    if (hidden.length === 0 || event.pointerType !== "mouse") return;
                    stopTimer(dwell);
                    dwell.current = window.setTimeout(() => setRevealed(true), DWELL_MS);
                }}
                onPointerLeave={() => {
                    stopTimer(dwell);
                    setRevealed(false);
                }}
            >
                {/* Only the stair is left: the menu says what any menu with nothing in it
                    would, until it is held. */}
                {listed.length === 0 && !revealed && <Menu.Label>No other rooms</Menu.Label>}
                {listed.map((kind) => (
                    <Menu.Item key={kind} mih={44} onClick={() => switchDomain(kind)}>
                        {domainProfiles[kind].label}
                    </Menu.Item>
                ))}
                {revealed &&
                    hidden.map((kind) => (
                        <Menu.Item
                            key={kind}
                            mih={44}
                            onClick={() => switchDomain(kind)}
                            c="dimmed"
                            fz="sm"
                            style={{ animation: "ps-stair-in var(--ps-dur-signature) ease both" }}
                        >
                            {domainProfiles[kind].entrance}
                        </Menu.Item>
                    ))}
            </Menu.Dropdown>
        </Menu>
    );
};
