"use client";

import { SegmentedControl } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";

import { reviewMediaSchema, type MediaKindCounts, type ReviewMedia } from "@private-stock/core";

/**
 * Videos, Photos or All, over a review queue (§10c, §5d, §5f).
 *
 * The queues open on Videos: the collection is mostly video, and photos are reviewed when
 * somebody chooses to, not mixed into every page of decisions. Photos are still processed --
 * hashed, read and grouped -- so their decisions wait behind this control rather than going
 * unmade. All comes last and carries no count, as on the library's kind tabs (§14e).
 *
 * A segmented control rather than tabs, because each queue already has a row of tabs for what
 * kind of decision it is asking, and this narrows whichever of them is open.
 */

/** Thumb height on a phone (§14). */
const TOUCH_HEIGHT = "2.75rem";

const withCount = (label: string, count: number | undefined): string =>
    count === undefined ? label : `${label} · ${count.toLocaleString()}`;

export const ReviewKindFilter: React.FC<{
    value: ReviewMedia;
    onChange: (media: ReviewMedia) => void;
    /** What is waiting of each kind; left off while unknown. */
    counts?: MediaKindCounts;
}> = ({ value, onChange, counts }) => {
    const touch = useMediaQuery("(max-width: 48em)") ?? false;

    return (
        <SegmentedControl
            value={value}
            onChange={(next) => onChange(reviewMediaSchema.catch("video").parse(next))}
            data={[
                { value: "video", label: withCount("Videos", counts?.video) },
                { value: "image", label: withCount("Photos", counts?.image) },
                { value: "all", label: "All" },
            ]}
            color="brass"
            size="sm"
            aria-label="Show videos, photos or both"
            fullWidth={touch}
            styles={touch ? { label: { lineHeight: TOUCH_HEIGHT } } : undefined}
            style={touch ? undefined : { alignSelf: "flex-start" }}
        />
    );
};
