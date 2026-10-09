import bcrypt from "bcryptjs";

import { ValidationError } from "@private-stock/core";

/**
 * Password hashing.
 *
 * Cost 12 is the current sensible default, but this runs on a NAS CPU that may be a decade
 * old, and login happens rarely while transcoding happens constantly — so it is worth
 * knowing that a single hash here can take a noticeable fraction of a second on weak
 * hardware. That is the intended trade; it is not a hot path.
 *
 * **On the real NAS it is not a fraction of a second, it is one to five of them**, because
 * `bcryptjs` is a pure-JavaScript implementation and there is no native fallback. Cost stays
 * at 12 — this app is meant to be reachable from the internet, and a cheaper hash is the wrong
 * saving — but the consequence has to be respected rather than assumed away: every call here
 * occupies the single thread that serves every other request, so nothing may call it except a
 * request that is genuinely signing somebody in or changing a password. §20 records the measured
 * numbers, and moving off `bcryptjs` to something that hashes on the libuv pool is the open
 * question there.
 */
const COST = 12;

/**
 * bcrypt reads 72 *bytes* and silently ignores the rest.
 *
 * `passwordSchema` caps characters, which is the same thing only for ASCII: 72 accented
 * letters are 144 bytes, and every password sharing their first half would have matched. So the
 * byte count is checked here, where every new password passes, rather than trusting a length
 * measured in the wrong unit. Verification needs no such check — a hash made here never had a
 * tail to lose.
 */
const BCRYPT_MAX_BYTES = 72;

export const hashPassword = (plain: string): Promise<string> => {
    if (Buffer.byteLength(plain, "utf8") > BCRYPT_MAX_BYTES) {
        throw new ValidationError(
            "That password is too long. Accented letters and symbols count as more than one character."
        );
    }

    return bcrypt.hash(plain, COST);
};

export const verifyPassword = (plain: string, hash: string): Promise<boolean> =>
    bcrypt.compare(plain, hash);

/**
 * A hash to compare against when the username does not exist.
 *
 * Without this, a missing user returns immediately while a real one costs a full bcrypt
 * comparison, and the timing difference enumerates accounts.
 *
 * **Computed on first use, not at module load.** It was a `hashSync` at module scope, which is
 * a cost-12 hash in pure JavaScript — `bcryptjs` has no native half — running on whichever
 * request first imported this file. That is the login page, and on the NAS it measured as a
 * **5.2 second** block of the event loop: not a slow login, but every request in the process
 * stopped while it ran, including the render of the page the person was waiting for (§20).
 *
 * Deferring it moves that cost onto the first sign-in attempt for an unknown username, where a
 * hash is what the timing defence is *for* and where a real account is paying the same cost
 * anyway. Cached after that, so it is paid once per process rather than per attempt.
 */
let dummyHash: string | null = null;

export const dummyHashFor = (): string => {
    dummyHash ??= bcrypt.hashSync("not-a-real-password-placeholder", COST);

    return dummyHash;
};
