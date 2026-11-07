"use client";

import { Group, Menu, Title, UnstyledButton } from "@mantine/core";

import { domainKinds, domainProfiles, type DomainKind } from "@private-stock/core";

import { Glyph } from "@/components/media/Glyph";
import { getActiveDomain, switchDomain } from "@/lib/activeDomain";

const LockGlyph: React.FC = () => (
    <Glyph size={18}>
        <rect x="5" y="11" width="14" height="9" rx="2" />
        <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </Glyph>
);

const ChevronGlyph: React.FC = () => (
    <Glyph size={14}>
        <path d="M6 9l6 6 6-6" />
    </Glyph>
);

/**
 * The room name in the header, and the way to the others (§21).
 *
 * A guarded room is not named while you are outside it: it is a lock with no label, so a menu
 * opened in front of somebody does not announce what is behind it. **A stopgap**, like the
 * keypad that guards it; a quieter entrance is still to be designed.
 */
export const DomainSwitcher: React.FC = () => {
    const active = getActiveDomain();
    const others = domainKinds.filter((kind) => kind !== active);

    const itemLabel = (kind: DomainKind) =>
        domainProfiles[kind].guarded ? <LockGlyph /> : domainProfiles[kind].label;

    return (
        <Menu position="bottom-start" withinPortal>
            <Menu.Target>
                <UnstyledButton
                    aria-label={`${domainProfiles[active].label}. Change room`}
                    mih={44}
                    style={{ display: "flex", alignItems: "center" }}
                >
                    <Group gap={4} wrap="nowrap">
                        <Title order={4} style={{ whiteSpace: "nowrap" }}>
                            {domainProfiles[active].label}
                        </Title>
                        <ChevronGlyph />
                    </Group>
                </UnstyledButton>
            </Menu.Target>
            <Menu.Dropdown>
                {others.map((kind) => (
                    <Menu.Item
                        key={kind}
                        mih={44}
                        onClick={() => switchDomain(kind)}
                        aria-label={domainProfiles[kind].guarded ? "Locked room" : undefined}
                    >
                        {itemLabel(kind)}
                    </Menu.Item>
                ))}
            </Menu.Dropdown>
        </Menu>
    );
};
