/**
 * Progressive delay, as an alternative to refusal (§12).
 *
 * A fixed-window counter answers "has this been tried too often" with yes or no, and the
 * "no" is a lockout. That is the right shape for a key an attacker owns — their own address —
 * and the wrong shape for a key the *victim* owns. Once the app is reachable from the
 * internet, anybody who knows an address can spend a handful of junk requests every window
 * and keep its owner locked out of their own library indefinitely, from anywhere, for free.
 *
 * So the account is throttled rather than gated: the first few attempts cost nothing, and
 * each one after that waits longer than the last. A person who mistyped a password they know
 * is back in on the second try having noticed nothing; somebody working through a dictionary
 * is reduced to a handful of guesses a minute, permanently, with no window they can wait out
 * and no state they can reset.
 *
 * The cap is what keeps this from becoming a different denial of service. An unbounded delay
 * is a held connection an attacker can accumulate, so the wait stops growing well before
 * that matters and the per-address limiter — which *does* refuse, because there the person
 * inconvenienced is the one making the attempts — bounds how many can be held at once.
 */

export interface BackoffOptions {
    /** Attempts that cost nothing, for somebody with fumbling fingers rather than a list. */
    free: number;
    /** The wait after the first attempt past `free`. Doubles with each one after it. */
    stepMs: number;
    /** The longest this ever waits, however many attempts have been made. */
    maxMs: number;
}

/**
 * How long the attempt numbered `attempts` should wait before being answered.
 *
 * `attempts` counts the attempt being made, so the first call of a window passes 1.
 */
export const backoffDelayMs = (
    attempts: number,
    { free, stepMs, maxMs }: BackoffOptions
): number => {
    const over = attempts - free;

    if (over <= 0) {
        return 0;
    }

    // Doubling from `stepMs`, and `Math.min` before the exponent can reach a size worth
    // worrying about: `over` is bounded by how many attempts fit in a window, but the cap is
    // reached within a handful of steps regardless.
    return Math.min(maxMs, stepMs * 2 ** Math.min(over - 1, 30));
};
