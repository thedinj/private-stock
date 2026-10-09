"use client";

import { Button, Drawer } from "@mantine/core";

/**
 * A review queue's own settings, opened from its header (§12b).
 *
 * A drawer rather than a tab, because a review tab holds decisions and these are not decisions
 * about any item: they are the rules that decide what lands in the queue, kept beside it so the
 * effect of changing one is one close away.
 */
export const RulesDrawer: React.FC<{
    opened: boolean;
    onOpen: () => void;
    onClose: () => void;
    title: string;
    children: React.ReactNode;
}> = ({ opened, onOpen, onClose, title, children }) => (
    <>
        <Button variant="default" onClick={onOpen}>
            Rules
        </Button>
        <Drawer opened={opened} onClose={onClose} title={title} position="right" size="md">
            {children}
        </Drawer>
    </>
);
