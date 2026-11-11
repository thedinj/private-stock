"use client";

import { Text } from "@mantine/core";

import type { MediaDetail } from "@private-stock/core";

import { MiddleEllipsis } from "@/components/MiddleEllipsis";

import classes from "./StageCaption.module.scss";

/**
 * What is on a full screen, across its top while the controls are up (§14b).
 *
 * The question it answers is "who is this" without leaving full screen, so the people are the
 * reason it exists -- but the title leads, as every player people know puts it. The title is cut
 * in the middle (`MiddleEllipsis`): many are GUIDs or camera names, all beginning and end, and a
 * wrapped one would push the people off a phone screen.
 *
 * Something to read, never to press. A name that went to its page would take you out of the full
 * screen this is here to keep you in, and anything on it that took the pointer would catch taps
 * aimed at the picture under it -- which, on a phone, is how the bar comes and goes.
 *
 * Only the tags somebody put on the item: a face that has been recognised but not confirmed is a
 * suggestion, and a suggestion drawn over the picture would read as a fact.
 */
export type StageCaptionContent = {
    title: string;
    /** The item's tags, or null while they are on their way -- the title is shown regardless. */
    tags: MediaDetail["tags"] | null;
};

/** Past this, the rest are counted rather than named: a line of forty tags is not read. */
const TAGS_SHOWN = 6;

export const StageCaption: React.FC<StageCaptionContent & { hidden: boolean }> = ({
    title,
    tags,
    hidden,
}) => {
    const performers = (tags ?? []).filter((tag) => tag.kind === "performer");
    const others = (tags ?? []).filter((tag) => tag.kind !== "performer");
    const extra = others.length - TAGS_SHOWN;

    return (
        <div className={classes.caption} data-hidden={hidden || undefined} aria-hidden={hidden}>
            <MiddleEllipsis text={title} fw={600} className={classes.title} />

            {performers.length > 0 && (
                <Text size="sm" fw={500} truncate="end" className={classes.people}>
                    {performers.map((tag) => tag.name).join(" · ")}
                </Text>
            )}

            {others.length > 0 && (
                <Text size="xs" truncate="end" className={classes.tags}>
                    {others
                        .slice(0, TAGS_SHOWN)
                        .map((tag) => tag.name)
                        .join(" · ")}
                    {extra > 0 && ` · +${extra} more`}
                </Text>
            )}
        </div>
    );
};
