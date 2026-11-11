"use client";

import { useEffect, useRef, useState } from "react";
import { Drawer, Group, Popover, Title, UnstyledButton } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";

import { type DomainKind, domainKinds, domainProfiles } from "@private-stock/core";

import { Glyph } from "@/components/media/Glyph";
import { RoomHouse } from "@/components/shell/RoomHouse";
import { useEnabledRooms } from "@/lib/api/rooms";
import { getActiveDomain, switchDomain } from "@/lib/activeDomain";
import { animate, DURATION } from "@/lib/motion";
import { roomThemes } from "@/theme";

import classes from "./DomainSwitcher.module.scss";

/** Pointer resting on the open plan this long finds the stair. */
const DWELL_MS = 1_500;

/** Holding the room name this long opens the plan with the stair already found. */
const LONG_PRESS_MS = 500;

/** Over everything, the open plan and its drawer included: the walk ends in a page load. */
const WALK_Z_INDEX = 10_000;

const ChevronGlyph: React.FC = () => (
    <Glyph size={14}>
        <path d="M6 9l6 6 6-6" />
    </Glyph>
);

/**
 * Walk into a room (§21 "Going from room to room").
 *
 * Changing room reloads the page, so the walk is what covers the reload: the room's ground grows
 * out of what was pressed until it fills the screen, and the page goes under it. The next page
 * paints its own ground, near enough the same, so the reload has nothing to show. Under reduced
 * motion it just goes.
 */
const walkInto = (kind: DomainKind, from: HTMLElement): void => {
    const veil = document.createElement("div");
    Object.assign(veil.style, {
        position: "fixed",
        inset: "0",
        zIndex: String(WALK_Z_INDEX),
        background: roomThemes[kind].other?.groundDark ?? "",
        pointerEvents: "none",
    });
    document.body.append(veil);

    // Back from the next page can restore this one from the cache, veil and all.
    window.addEventListener(
        "pageshow",
        (event) => {
            if (event.persisted) veil.remove();
        },
        { once: true }
    );

    const box = from.getBoundingClientRect();
    const start = `inset(${box.top}px ${window.innerWidth - box.right}px ${
        window.innerHeight - box.bottom
    }px ${box.left}px round 4px)`;
    const walk = animate(veil, [{ clipPath: start }, { clipPath: "inset(0px round 0px)" }], {
        duration: DURATION.move,
    });

    if (walk === null) {
        switchDomain(kind);
        return;
    }

    const go = () => switchDomain(kind);
    walk.finished.then(go, go);
};

/**
 * The room name in the header, and the way to the others (§21).
 *
 * It opens a plan of the house (`RoomHouse`): the rooms anyone may see on the ground floor, the
 * one you are in among them, and earth below. A popover on a desktop, a sheet from the bottom on a
 * phone. Choosing a room walks into it (`walkInto`).
 *
 * A guarded room is not drawn. The way to one is a stair that appears only when the plan is held:
 * the pointer resting on the open plan for a second and a half, or the room name pressed and held
 * (a finger, or a mouse button kept down). Once found it stays until the plan closes, which
 * fills it in again; nothing remembers it was shown.
 *
 * **What closes the plan:** a press outside it, Escape, choosing a room, or a click on the name.
 * Nothing else -- not the pointer leaving, and not the click that ends a long press, however long
 * it was held. The stair says only the room's `entrance` ("The stair"), never its name, and the
 * rack at the bottom of it asks for the PIN (`DomainGate`).
 *
 * A room an administrator has turned off is not in it at all, the stair included (§21 "Turning a
 * room off"). With no other room on, the name is only a name.
 */
export const DomainSwitcher: React.FC = () => {
    const active = getActiveDomain();
    const rooms = useEnabledRooms();
    const others = domainKinds.filter((kind) => kind !== active && rooms.includes(kind));
    const hasStair = others.some((kind) => domainProfiles[kind].guarded);
    const phone = useMediaQuery("(max-width: 48em)") ?? false;

    const [opened, setOpened] = useState(false);
    const [revealed, setRevealed] = useState(false);
    const dwell = useRef<number | null>(null);
    const press = useRef<number | null>(null);
    /**
     * The long press on the name has fired. The click that ends that press must not close the
     * plan it just opened, however long the press was held -- so this is cleared by the next
     * press, never by a timer (§21 "Going from room to room").
     */
    const pressFired = useRef(false);
    /** Set once a room is chosen: the page is leaving, and nothing should close under the walk. */
    const leaving = useRef(false);

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

    const setOpen = (next: boolean) => {
        if (leaving.current) return;
        setOpened(next);

        if (!next) {
            stopTimer(dwell);
            setRevealed(false);
        }
    };

    const choose = (kind: DomainKind, from: HTMLElement) => {
        if (leaving.current) return;
        leaving.current = true;
        walkInto(kind, from);
    };

    // `ps-room-sign`: each room signs its own name (globals.scss).
    const name = (
        <Title
            order={4}
            className="ps-room-sign"
            data-room={active}
            style={{ whiteSpace: "nowrap" }}
        >
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

    const target = (
        <UnstyledButton
            aria-label={`${domainProfiles[active].label}. Change room`}
            aria-expanded={opened}
            mih={44}
            className={classes.target}
            onClick={(event) => {
                // `detail` is 0 for a click from the keyboard, which no press preceded.
                if (pressFired.current && event.detail !== 0) {
                    pressFired.current = false;
                    return;
                }
                setOpen(!opened);
            }}
            onPointerDown={() => {
                pressFired.current = false;
                if (!hasStair) return;
                stopTimer(press);
                press.current = window.setTimeout(() => {
                    press.current = null;
                    pressFired.current = true;
                    // Opens, or keeps open: a long press on an open plan finds the stair in it.
                    setOpened(true);
                    setRevealed(true);
                }, LONG_PRESS_MS);
            }}
            onPointerUp={() => stopTimer(press)}
            onPointerLeave={() => stopTimer(press)}
            onPointerCancel={() => stopTimer(press)}
            // A held finger otherwise brings up the browser's own menu.
            onContextMenu={(event) => {
                if (hasStair) event.preventDefault();
            }}
        >
            <Group gap={4} wrap="nowrap">
                {name}
                <span className={classes.chevron} data-open={opened || undefined}>
                    <ChevronGlyph />
                </span>
            </Group>
        </UnstyledButton>
    );

    const house = (
        <RoomHouse
            active={active}
            enabled={rooms}
            revealed={revealed}
            onChoose={choose}
            className={phone ? classes.sheetHouse : undefined}
            onPointerEnter={(event) => {
                if (!hasStair || event.pointerType !== "mouse") return;
                stopTimer(dwell);
                dwell.current = window.setTimeout(() => setRevealed(true), DWELL_MS);
            }}
            // Leaving only stops the count. A found stair stays until the plan closes: hiding it
            // as the pointer drifted off took it away on the way to it.
            onPointerLeave={() => stopTimer(dwell)}
        />
    );

    if (phone) {
        return (
            <>
                {target}
                <Drawer
                    opened={opened}
                    onClose={() => setOpen(false)}
                    position="bottom"
                    size="auto"
                    withCloseButton={false}
                    padding={0}
                    classNames={{ content: classes.sheet }}
                >
                    {house}
                </Drawer>
            </>
        );
    }

    return (
        <Popover
            position="bottom-start"
            withinPortal
            opened={opened}
            onChange={setOpen}
            shadow="xl"
            radius="md"
            trapFocus
            returnFocus
        >
            <Popover.Target>{target}</Popover.Target>
            <Popover.Dropdown p={0} className={classes.dropdown}>
                {house}
            </Popover.Dropdown>
        </Popover>
    );
};
