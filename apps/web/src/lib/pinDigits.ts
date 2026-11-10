/**
 * The digits of a PIN being entered, on the screen lock's keypad or the wine rack (§12c, §21
 * "Getting into the cellar"). Pure, so the rules both surfaces share are tested once.
 */

/** `pinSchema` in core: four to eight digits. */
export const PIN_MIN_DIGITS = 4;
export const PIN_MAX_DIGITS = 8;

/** A digit pressed: kept, unless the PIN is already as long as one can be. */
export const withDigit = (digits: string, digit: string): string =>
    /^\d$/.test(digit) && digits.length < PIN_MAX_DIGITS ? digits + digit : digits;

/** Whether there is enough to be worth asking the server about. */
export const canTry = (digits: string): boolean => digits.length >= PIN_MIN_DIGITS;

/** The vintage on a bottle's tag. Its last figure is the digit it enters. */
export const vintageOf = (digit: string): string => `201${digit}`;
