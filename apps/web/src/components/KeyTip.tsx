"use client";

import { cloneElement, Fragment } from "react";
import { Group, Kbd, Text, Tooltip } from "@mantine/core";

import { actionKeys, type ViewerAction } from "@/lib/viewerKeys";

/**
 * A control's tooltip that names its key (§14b), as the rating glasses and the heart do: a
 * shortcut nobody is told about is one only its author uses. The key is also given to assistive
 * technology as `aria-keyshortcuts`.
 *
 * Hover only, which is Mantine's default: on a phone there is no keyboard to name.
 */
export const KeyTip: React.FC<{
    /** What the control does, said a little more fully than its label. */
    label: React.ReactNode;
    /** The keys, pressed together: `["Shift", "Enter"]` -- or, with `either`, alternatives. */
    keys: string[];
    /** The keys are alternatives (`Space` or `k`), as the viewer's table gives them. */
    either?: boolean;
    /**
     * Drawn inside the control's own tree rather than at the end of the page. For the player's
     * bar: in full screen only the player is shown, and a tooltip outside it would never appear.
     */
    inline?: boolean;
    children: React.ReactElement<{ "aria-keyshortcuts"?: string }>;
}> = ({ label, keys, either = false, inline = false, children }) => (
    <Tooltip
        withinPortal={!inline}
        withArrow
        openDelay={400}
        multiline
        maw={320}
        label={
            <Group gap={6} wrap="nowrap" align="flex-start">
                <Text size="xs" span>
                    {label}
                </Text>
                <Text size="xs" span style={{ whiteSpace: "nowrap" }}>
                    {keys.map((key, index) => (
                        <Fragment key={key}>
                            {index > 0 && (either ? " or " : "+")}
                            <Kbd size="xs">{key}</Kbd>
                        </Fragment>
                    ))}
                </Text>
            </Group>
        }
    >
        {cloneElement(children, { "aria-keyshortcuts": keys.join(either ? " " : "+") })}
    </Tooltip>
);

/**
 * A viewer control's tooltip, its keys read from the viewer's one table (§14 "Hotkeys"), so a
 * re-key there reaches the tooltip without anyone remembering to.
 */
export const ViewerKeyTip: React.FC<{
    action: ViewerAction;
    label: React.ReactNode;
    /** See `KeyTip`'s `inline`: the player's bar, which full screen leaves alone on the screen. */
    inline?: boolean;
    children: React.ReactElement<{ "aria-keyshortcuts"?: string }>;
}> = ({ action, label, inline, children }) => {
    const keys = actionKeys(action);

    return (
        <KeyTip label={label} keys={keys} either={keys.length > 1} inline={inline}>
            {children}
        </KeyTip>
    );
};
