/**
 * Anything at all -- a string out of storage, `NaN`, a negative, `1e9` -- into one of `choices`.
 *
 * The numeric preferences are closed sets (§14b, §14g), and this is what keeps them closed:
 * whatever storage hands back, the result is a value the control that sets it can show as
 * selected. Snapped to the nearest offered value rather than clamped to a range. A value that
 * cannot be parsed at all is the fallback rather than the lowest: somebody whose storage is
 * corrupt should get the ordinary experience, not the fastest one.
 *
 * **A tie goes to the earlier choice**, so with choices in ascending order, the shorter one.
 * The rule has to be written down rather than left to the fold's starting value -- which is
 * how the dwell first returned five for four, for no reason anybody could have predicted from
 * reading it.
 *
 * `choices` must be in ascending order.
 */
export const snapChoice = <T extends number>(
    value: number | string | null | undefined,
    choices: readonly T[],
    fallback: T
): T => {
    // Empty and blank strings are checked before `Number`, which reads both as zero -- so a
    // cleared storage key would otherwise snap to the shortest choice rather than the fallback.
    if (typeof value === "string" && value.trim() === "") {
        return fallback;
    }

    const parsed = typeof value === "string" ? Number(value) : value;

    if (parsed === null || parsed === undefined || !Number.isFinite(parsed)) {
        return fallback;
    }

    // Seeded with the first choice and compared strictly, so an equidistant value keeps the
    // earlier one.
    return choices.reduce<T>(
        (closest, choice) =>
            Math.abs(choice - parsed) < Math.abs(closest - parsed) ? choice : closest,
        choices[0]
    );
};
