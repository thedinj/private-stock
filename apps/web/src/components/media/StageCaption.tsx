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
 *
 * **The viewer's own rating and heart sit at the end of the title line**, because the number pad
 * and `h` work in full screen and pressing the rating an item already has clears it: without
 * them on screen every press there was made blind. On the title line so they cost a phone no
 * height. All five stars are drawn, the empty ones dim, so four reads as "not five" at a glance;
 * an unrated item draws none, and the heart is drawn only when given. The caption still appears
 * only with the bar -- the press is answered by `StageFlash`, which is enough on its own.
 */
export type StageCaptionContent = {
    title: string;
    /** The item's tags, or null while they are on their way -- the title is shown regardless. */
    tags: MediaDetail["tags"] | null;
    /**
     * This viewer's marks, the page's optimistic values so they agree with the flash. Absent
     * where they cannot be given -- a reel's caption names a clip, not an item to rate.
     */
    rating?: number | null;
    favorite?: boolean;
};

const STARS = [1, 2, 3, 4, 5] as const;

/** Past this, the rest are counted rather than named: a line of forty tags is not read. */
const TAGS_SHOWN = 6;

export const StageCaption: React.FC<StageCaptionContent & { hidden: boolean }> = ({
    title,
    tags,
    rating = null,
    favorite = false,
    hidden,
}) => {
    const performers = (tags ?? []).filter((tag) => tag.kind === "performer");
    const others = (tags ?? []).filter((tag) => tag.kind !== "performer");
    const extra = others.length - TAGS_SHOWN;

    return (
        <div className={classes.caption} data-hidden={hidden || undefined} aria-hidden={hidden}>
            <div className={classes.titleLine}>
                <MiddleEllipsis text={title} fw={600} className={classes.title} />

                {(rating !== null || favorite) && (
                    <span className={classes.marks}>
                        {rating !== null && (
                            <span
                                className={classes.stars}
                                aria-label={`Rated ${rating} of 5`}
                                role="img"
                            >
                                {STARS.map((star) => (
                                    <span key={star} data-on={star <= rating || undefined}>
                                        ★
                                    </span>
                                ))}
                            </span>
                        )}
                        {favorite && (
                            <span className={classes.heart} aria-label="Favourite" role="img">
                                ♥
                            </span>
                        )}
                    </span>
                )}
            </div>

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
