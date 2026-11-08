"use client";

import { Button, Group, Menu } from "@mantine/core";

import type { ItemReview, ReviewPass } from "@private-stock/core";

import { ViewerKeyTip } from "@/components/KeyTip";
import { CheckGlyph, CloseGlyph } from "@/components/media/Glyph";
import { useSetReviewMark } from "@/lib/api/reviewPasses";

/**
 * The item page's Review control (§14d "Reviewing recordings for a reel").
 *
 * The button turns review mode on and off -- with the pass last used here -- and while it is on
 * says which pass `d` marks for. Its menu switches pass, names a new one, marks this item for a
 * pass without entering the mode, and stops reviewing. Beside it, a chip per pass the item has
 * been through; clicking one takes that mark off, which is the only way back from a `d`.
 *
 * On a phone there is no `d` to wait for, so the mode is not offered here (Play ▸ Review is);
 * marking from the menu and the chips are.
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
    const unmarked = (passes ?? []).filter(
        (pass) => !reviews.some((review) => review.passId === pass.id)
    );

    const menu = (
        <Menu withinPortal position="bottom-end">
            <Menu.Target>
                {narrow ? (
                    <Button variant="default" aria-label="Review">
                        <CheckGlyph size={16} />
                    </Button>
                ) : (
                    <Button
                        variant={reviewing ? "filled" : "default"}
                        color={reviewing ? "brass" : undefined}
                        px="xs"
                        aria-label="Review passes"
                    >
                        ▾
                    </Button>
                )}
            </Menu.Target>
            <Menu.Dropdown>
                {!narrow && (passes ?? []).length > 0 && (
                    <>
                        <Menu.Label>Review for</Menu.Label>
                        {(passes ?? []).map((pass) => (
                            <Menu.Item
                                key={pass.id}
                                onClick={() => onReviewFor(pass.id)}
                                rightSection={
                                    reviewing && current?.id === pass.id ? (
                                        <CheckGlyph size={14} />
                                    ) : undefined
                                }
                            >
                                {pass.name}
                            </Menu.Item>
                        ))}
                    </>
                )}
                <Menu.Item onClick={onNewPass}>New review pass…</Menu.Item>

                {(passes ?? []).length > 0 && (
                    <>
                        <Menu.Divider />
                        <Menu.Label>Mark this one reviewed for</Menu.Label>
                        {unmarked.length === 0 ? (
                            <Menu.Item disabled>Every pass already</Menu.Item>
                        ) : (
                            unmarked.map((pass) => (
                                <Menu.Item
                                    key={pass.id}
                                    onClick={() =>
                                        mark.mutate({ mediaId, passId: pass.id, reviewed: true })
                                    }
                                >
                                    {pass.name}
                                </Menu.Item>
                            ))
                        )}
                    </>
                )}

                {reviewing && (
                    <>
                        <Menu.Divider />
                        <Menu.Item onClick={onToggle}>Stop reviewing</Menu.Item>
                    </>
                )}
            </Menu.Dropdown>
        </Menu>
    );

    return (
        <Group gap="xs" wrap="wrap">
            {narrow ? (
                menu
            ) : (
                <Button.Group>
                    {/* While reviewing, the key worth naming is d; otherwise Shift+D. */}
                    <ViewerKeyTip
                        action={reviewing ? "review" : "reviewMode"}
                        label={
                            reviewing
                                ? `d marks each reviewed for ${current?.name ?? "the pass"} and goes to the next. Click to stop reviewing`
                                : "Review: each waits for d instead of rolling on"
                        }
                    >
                        <Button
                            variant={reviewing ? "filled" : "default"}
                            color={reviewing ? "brass" : undefined}
                            aria-pressed={reviewing}
                            onClick={onToggle}
                        >
                            {reviewing && current ? `Reviewing for ${current.name}` : "Review"}
                        </Button>
                    </ViewerKeyTip>
                    {menu}
                </Button.Group>
            )}

            {reviews.map((review) => (
                <Button
                    key={review.passId}
                    size="compact-sm"
                    variant="light"
                    color="brass"
                    rightSection={<CloseGlyph size={12} />}
                    title={`Reviewed for ${review.name}. Click to take the mark off`}
                    aria-label={`Reviewed for ${review.name}: take the mark off`}
                    onClick={() => mark.mutate({ mediaId, passId: review.passId, reviewed: false })}
                >
                    {review.name}
                </Button>
            ))}
        </Group>
    );
};
