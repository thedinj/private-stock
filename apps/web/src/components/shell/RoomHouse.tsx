"use client";

import { UnstyledButton } from "@mantine/core";

import { type DomainKind, domainKinds, domainProfiles } from "@private-stock/core";

import { roomThemes } from "@/theme";

import classes from "./RoomHouse.module.scss";

/** The steps of the stair, top to bottom: each one a riser and a tread. */
const STEPS = 6;
const RISE = 13;
const RUN = 14;

interface RoomHouseProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "onChoose"> {
    active: DomainKind;
    /** The rooms an administrator has left on (§21 "Turning a room off"). */
    enabled: readonly DomainKind[];
    /** Whether the stair has been found: the switcher was held (§21 "Getting into the cellar"). */
    revealed: boolean;
    /** A room was chosen; `from` is what was pressed, for the walk into it to start from. */
    onChoose: (kind: DomainKind, from: HTMLElement) => void;
}

/** A room's theme tokens. Every room's theme carries `other`; Mantine's type leaves it optional. */
const tokens = (kind: DomainKind): Record<string, string> => roomThemes[kind].other ?? {};

/** A room's own colours, from its own theme, for a room drawn inside another room's page. */
const roomStyle = (kind: DomainKind): React.CSSProperties => {
    const other = tokens(kind);
    return {
        "--room-ground": other.groundDark,
        "--room-text": other.textWarm,
        "--room-accent-rgb": other.accentRgb,
    } as React.CSSProperties;
};

const Sign: React.FC<{ kind: DomainKind }> = ({ kind }) => (
    <span className={`ps-room-sign ${classes.sign}`} data-room={kind}>
        {domainProfiles[kind].label}
    </span>
);

const RoomBody: React.FC<{ kind: DomainKind; here: boolean }> = ({ kind, here }) => (
    <>
        {here && <span className={classes.here}>You are here</span>}
        <Sign kind={kind} />
        {domainProfiles[kind].kept && (
            <span className={classes.kept}>{domainProfiles[kind].kept}</span>
        )}
    </>
);

/**
 * The house in section, as the room switcher draws it (§21 "Going from room to room").
 *
 * The rooms anyone may see stand side by side on the ground floor, each in its own colours with
 * its window lit in its own accent, and the room you are in among them, marked and not a button.
 * Under the floor is earth, which looks like any foundation until the switcher is held: then a
 * hatch opens in the floor, a stair is drawn down into the dark, and a light comes up at its foot.
 * From inside a guarded room the plan shows you down there instead.
 */
export const RoomHouse: React.FC<RoomHouseProps> = ({
    active,
    enabled,
    revealed,
    onChoose,
    className,
    ...rest
}) => {
    const upstairs = domainKinds.filter(
        (kind) => enabled.includes(kind) && !domainProfiles[kind].guarded
    );
    const stair = domainKinds.find(
        (kind) => kind !== active && enabled.includes(kind) && domainProfiles[kind].guarded
    );
    const below = domainProfiles[active].guarded;

    return (
        <div
            {...rest}
            role="group"
            aria-label="Rooms"
            className={[classes.house, className].filter(Boolean).join(" ")}
        >
            <svg
                className={classes.roof}
                viewBox="0 0 100 20"
                preserveAspectRatio="none"
                aria-hidden
            >
                <path d="M0 20 L50 1 L100 20" />
            </svg>
            <div className={classes.floor}>
                {upstairs.map((kind) =>
                    kind === active ? (
                        <div
                            key={kind}
                            className={classes.room}
                            data-here
                            aria-current="true"
                            style={roomStyle(kind)}
                        >
                            <RoomBody kind={kind} here />
                        </div>
                    ) : (
                        <UnstyledButton
                            key={kind}
                            className={classes.room}
                            style={roomStyle(kind)}
                            onClick={(event: React.MouseEvent<HTMLButtonElement>) =>
                                onChoose(kind, event.currentTarget)
                            }
                        >
                            <RoomBody kind={kind} here={false} />
                        </UnstyledButton>
                    )
                )}
            </div>
            <div className={classes.groundline} />
            <div className={classes.earth}>
                {below && (
                    <div className={classes.below} aria-current="true" style={roomStyle(active)}>
                        <RoomBody kind={active} here />
                    </div>
                )}
                {!below && revealed && stair && (
                    <UnstyledButton
                        className={classes.stair}
                        style={
                            { "--stair-light": tokens(active).stairLightRgb } as React.CSSProperties
                        }
                        onClick={(event: React.MouseEvent<HTMLButtonElement>) =>
                            onChoose(stair, event.currentTarget)
                        }
                    >
                        {/* The hatch: a cut in the floor and its leaf, swung up into the room. */}
                        <span className={classes.cut} aria-hidden />
                        <span className={classes.leaf} aria-hidden />
                        <span className={classes.glow} aria-hidden />
                        <svg
                            className={classes.steps}
                            viewBox={`0 0 ${RUN * STEPS + 12} ${RISE * STEPS + 2}`}
                            aria-hidden
                        >
                            {Array.from({ length: STEPS }, (_, i) => (
                                <path
                                    key={i}
                                    d={`M${i * RUN} ${i * RISE} V${(i + 1) * RISE} H${(i + 1) * RUN}${i === STEPS - 1 ? " h12" : ""}`}
                                    style={{ "--step": i } as React.CSSProperties}
                                />
                            ))}
                        </svg>
                        <span className={classes.entrance}>{domainProfiles[stair].entrance}</span>
                    </UnstyledButton>
                )}
            </div>
        </div>
    );
};
