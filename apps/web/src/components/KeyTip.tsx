"use client";

import { cloneElement, Fragment } from "react";
import { Group, Kbd, Text, Tooltip } from "@mantine/core";

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
    /** The keys, pressed together: `["Shift", "Enter"]`. */
    keys: string[];
    children: React.ReactElement<{ "aria-keyshortcuts"?: string }>;
}> = ({ label, keys, children }) => (
    <Tooltip
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
                            {index > 0 && "+"}
                            <Kbd size="xs">{key}</Kbd>
                        </Fragment>
                    ))}
                </Text>
            </Group>
        }
    >
        {cloneElement(children, { "aria-keyshortcuts": keys.join("+") })}
    </Tooltip>
);
