/**
 * A slider mark's label at an end of the track, growing inward from its mark.
 *
 * Mantine centres every label on its mark, so one at either end hangs half its width past the
 * slider -- on a phone "identical" ran over the card's border.
 */
export const edgeLabel = (label: string, edge: "start" | "end"): React.ReactNode => (
    <span
        style={{
            display: "inline-block",
            transform: `translateX(${edge === "start" ? "50%" : "-50%"})`,
        }}
    >
        {label}
    </span>
);
