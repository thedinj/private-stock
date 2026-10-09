"use client";

import { Center, Stack, Text, Title } from "@mantine/core";

import classes from "./EmptyState.module.scss";

/**
 * Nothing here yet, said the one way (§14, "house rules").
 *
 * Every page used to say it differently: a dimmed sentence at the top left on Reels, Clips and
 * Captures, a centred card on Trash, an oak alert on Duplicates -- while the room said it best,
 * with an eyebrow, a line in the display face and one sentence. This is that, a size down so
 * it sits inside a page under its plate rather than filling the screen.
 *
 * A search that matched nothing is an empty state too, and says so in `title`.
 */
interface EmptyStateProps {
    /** A few words of where this is, in the plate's brass. Optional. */
    eyebrow?: string;
    title: string;
    /** One sentence: what would put something here. */
    children?: React.ReactNode;
    /** Usually the one action that would fill it. */
    action?: React.ReactNode;
}

export const EmptyState: React.FC<EmptyStateProps> = ({ eyebrow, title, children, action }) => (
    <Center mih={220}>
        <Stack gap="xs" align="center" maw={460} ta="center">
            {eyebrow && <span className={classes.eyebrow}>{eyebrow}</span>}
            <Title order={4} className={classes.title}>
                {title}
            </Title>
            {children && (
                <Text size="sm" c="dimmed">
                    {children}
                </Text>
            )}
            {action && <div className={classes.action}>{action}</div>}
        </Stack>
    </Center>
);
