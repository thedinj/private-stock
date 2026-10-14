import classes from "./settling.module.scss";

/**
 * Props for a list that stays on screen while its next answer loads (§14, "Waiting").
 *
 * Lists keep the previous answer (`placeholderData`) when a filter, sort or page changes, so
 * the screen does not flash to a spinner and back; this is what says the answer on screen is
 * the old one. It dims and a band of light passes over it -- a dim alone was invisible on a
 * list of names or of tiles with nothing in their wells yet. Pass `isPlaceholderData`.
 *
 * The element is made `position: relative`, which a flip grid's container already is.
 */
export const settling = (
    active: boolean
): { className: string; "aria-busy": boolean | undefined } => ({
    className: active ? `${classes.settles} ${classes.settling}` : classes.settles,
    "aria-busy": active || undefined,
});
