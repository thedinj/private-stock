/**
 * Invitation codes (§12c).
 *
 * A code is a credential that is read aloud over the phone, so it is shaped for a human voice
 * and a human keyboard — and it is a credential on a route anybody on the internet can reach,
 * so it also has to survive being guessed at. Those two pull in opposite directions and the
 * resolution is that **the code is never chosen by a person**.
 *
 * The admin names the invitation with a `label` ("Mum", "houseguests"); the code itself is
 * generated here. That is what keeps somebody from creating `HOUSEGUEST` and handing an
 * internet-facing library to the first dictionary attack — and it is why the route's rate
 * limiter is a volume control rather than the thing standing between a stranger and an
 * account. A generated code carries about 50 bits, which no amount of request throughput
 * finds; a chosen one carries however much thought went into it, which is usually none.
 */

/**
 * Crockford's base32 alphabet, without the letters that get misheard or mistyped.
 *
 * No `I`, `L`, `O` or `U`: the first three are indistinguishable from `1` and `0` in most
 * fonts and in most handwriting, and `U` is dropped so that no code can spell an obscenity by
 * accident, which is a real thing that happens with random strings people read out.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Two groups of five. Ten characters of a 32-symbol alphabet is fifty bits. */
const GROUPS = 2;
const GROUP_LENGTH = 5;

/**
 * Characters people type when they mean an alphabet character, mapped to what they meant.
 *
 * Applied on the way in so that a code read aloud as "oh" and typed as `0` still works, and
 * so that the same code written `cel1ar` and `CELIAR` resolves one way. This is the same idea
 * as lower-casing an email address: the stored form is canonical and the typed form is
 * forgiven.
 */
const CONFUSIONS: Record<string, string> = { I: "1", L: "1", O: "0", U: "V" };

/**
 * Canonical form: upper case, confusions resolved, everything else dropped, regrouped.
 *
 * Grouping is cosmetic and therefore stripped rather than required — somebody will type the
 * hyphen and somebody will not, and both mean the same code. Comparison and storage both go
 * through this, which is the property that matters: a code is looked up by exactly the string
 * it was stored as.
 */
export const normalizeInvitationCode = (raw: string): string =>
    raw
        .toUpperCase()
        .replace(/[^0-9A-Z]/g, "")
        .split("")
        .map((character) => CONFUSIONS[character] ?? character)
        .join("");

/** How the code is shown and read aloud: groups of five, hyphen-separated. */
export const formatInvitationCode = (code: string): string =>
    (code.match(/.{1,5}/g) ?? [code]).join("-");

/**
 * `length` characters drawn uniformly from the alphabet.
 *
 * `randomValues` is injected rather than reached for, because `packages/core` is imported by
 * the browser bundle as well as by Node and must not close over either one's crypto. The
 * callers pass `crypto.getRandomValues`.
 *
 * The `limit` guard is rejection sampling, and with this alphabet it rejects nothing: 32
 * divides 256, so a plain modulo is already uniform. It is here because `ALPHABET` is a
 * constant somebody may later shorten by another confusable letter, at which point modulo
 * quietly starts favouring the first few symbols — a bug that produces perfectly
 * normal-looking secrets and would never be noticed.
 */
const drawFrom = (length: number, randomValues: (into: Uint8Array) => Uint8Array): string => {
    const limit = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
    const characters: string[] = [];

    while (characters.length < length) {
        for (const byte of randomValues(new Uint8Array(length))) {
            if (byte < limit && characters.length < length) {
                characters.push(ALPHABET[byte % ALPHABET.length]);
            }
        }
    }

    return characters.join("");
};

export const generateInvitationCode = (
    randomValues: (into: Uint8Array) => Uint8Array = (into) => crypto.getRandomValues(into)
): string => drawFrom(GROUPS * GROUP_LENGTH, randomValues);

/** Twelve characters, which is about sixty bits from this alphabet. */
const PASSWORD_LENGTH = 12;

/**
 * A temporary password for an administrator to read out (§12c).
 *
 * Shares the alphabet with invitation codes because it has the same job: it is going to be
 * spoken down a phone or written on paper, so a character that is ambiguous by ear or by eye
 * is a support call. Sixty bits rather than fifty, because unlike an invitation this one is
 * not limited by uses or expiry — it stands until the person changes it, and some of them
 * never will.
 *
 * Shown ungrouped, and `normalizeInvitationCode` is deliberately *not* applied to it. A
 * password is compared byte for byte by bcrypt, so nothing may forgive a typed variant — the
 * exact string the admin passed on is the only one that works, which is the whole point of a
 * password and the opposite of an invitation code.
 */
export const generateReadablePassword = (
    randomValues: (into: Uint8Array) => Uint8Array = (into) => crypto.getRandomValues(into)
): string => drawFrom(PASSWORD_LENGTH, randomValues);

/**
 * The length a valid code always has, for the schema to check before a lookup happens.
 *
 * Rejecting a wrong-length code costs no query, which matters on a route whose whole job is
 * answering people who do not have a code.
 */
export const INVITATION_CODE_LENGTH = GROUPS * GROUP_LENGTH;
