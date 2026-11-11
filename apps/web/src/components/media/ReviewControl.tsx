"use client";

import { Button, Group, Menu } from "@mantine/core";

import type { ItemReview, ReviewPass } from "@private-stock/core";

import { ViewerKeyTip } from "@/components/KeyTip";
import { CheckGlyph } from "@/components/media/Glyph";
import { useSetReviewMark } from "@/lib/api/reviewPasses";

/**
 * The item page's Review control (§14d "Reviewing recordings for a reel").
 *
 * Out of review mode it is one button: into the mode with the pass last used here, as Shift+D
 * is. Which passes the item has been through is not said here -- that is bookkeeping, and only
 * the pass being reviewed for matters while reviewing.
 *
 * In the mode it names the pass, and its menu switches pass, names a new one, and stops. Beside
 * it, whether this item is marked for that pass, as a toggle -- the way to take back a `d`, or to
 * mark without moving on.
 *
 * On a phone there is no `d` to wait for, so the button is not offered (Play ▸ Review is); a
 * mode entered that way still shows the in-mode control, so it can be stopped.
 */
export const ReviewControl: React.FC<{
    mediaId: string;
    reviews: ItemReview[];
    /** This room's passes, once known. */
    passes: ReviewPass[] | undefined;
    reviewing: boolean;
    /** The pass review mode is on, once resolved. */
    current: ReviewPass | null;
    narrow: boolean;
    onToggle: () => void;
    onReviewFor: (passId: string) => void;
    onNewPass: () => void;
}> = ({
    mediaId,
    reviews,
    passes,
    reviewing,
    current,
    narrow,
    onToggle,
    onReviewFor,
    onNewPass,
}) => {
    const mark = useSetReviewMark();

    if (!reviewing) {
        if (narrow) return null;

        return (
            <ViewerKeyTip
                action="reviewMode"
                label="Review: each waits for d instead of rolling on"
            >
                <Button variant="default" aria-pressed={false} onClick={onToggle}>
                    Review
                </Button>
            </ViewerKeyTip>
        );
    }

    const marked = current !== null && reviews.some((review) => review.passId === current.id);

    return (
        <Group gap="xs" wrap="nowrap">
            <Menu withinPortal position="bottom-end">
                <ViewerKeyTip
                    action="review"
                    label={`d marks each reviewed for ${current?.name ?? "the pass"} and goes to the next`}
                >
                    <Menu.Target>
                        <Button
                            variant="filled"
                            color="brass"
                            aria-pressed
                            rightSection={<span aria-hidden>▾</span>}
                        >
                            {current ? `Reviewing for ${current.name}` : "Reviewing"}
                        </Button>
                    </Menu.Target>
                </ViewerKeyTip>
                <Menu.Dropdown>
                    {(passes ?? []).length > 1 && (
                        <>
                            <Menu.Label>Review for</Menu.Label>
                            {(passes ?? []).map((pass) => (
                                <Menu.Item
                                    key={pass.id}
                                    onClick={() => onReviewFor(pass.id)}
                                    rightSection={
                                        current?.id === pass.id ? (
                                            <CheckGlyph size={14} />
                                        ) : undefined
                                    }
                                >
                                    {pass.name}
                                </Menu.Item>
                            ))}
                            <Menu.Divider />
                        </>
                    )}
                    <Menu.Item onClick={onNewPass}>New review pass…</Menu.Item>
                    <Menu.Item onClick={onToggle}>Stop reviewing</Menu.Item>
                </Menu.Dropdown>
            </Menu>

            {current && (
                <Button
                    variant={marked ? "light" : "subtle"}
                    color={marked ? "brass" : "gray"}
                    leftSection={marked ? <CheckGlyph size={14} /> : undefined}
                    aria-pressed={marked}
                    title={
                        marked
                            ? `Reviewed for ${current.name}. Click to take the mark off`
                            : `Not yet reviewed for ${current.name}. Click to mark it without moving on`
                    }
                    onClick={() => mark.mutate({ mediaId, passId: current.id, reviewed: !marked })}
                >
                    {marked ? "Reviewed" : "Not reviewed"}
                </Button>
            )}
        </Group>
    );
};
