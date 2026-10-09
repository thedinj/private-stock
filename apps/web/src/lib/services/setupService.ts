import { randomBytes, timingSafeEqual } from "node:crypto";

import {
    AuthorizationError,
    ConflictError,
    clientIpFrom,
    type SetupRequest,
} from "@private-stock/core";
import { loadConfig } from "@private-stock/core/server";
import { userRepo } from "@private-stock/db";

import { createUser } from "./authService";

/**
 * First-boot admin creation (§12c).
 *
 * The danger this guards against: the port is exposed before setup is finished, and whoever
 * reaches it first owns the library. So setup is available only while there are no users,
 * and then only from a private address or with a token printed to the container log.
 */

export const needsSetup = (): boolean => userRepo.countUsers() === 0;

/**
 * The one-time token, generated per process start and logged.
 *
 * Regenerating on restart is deliberate: a token that outlives the process it was printed
 * for is a long-lived credential sitting in a log file.
 *
 * It is printed the moment it is generated, and that is the whole point of it. It used to be
 * generated lazily inside the comparison in `completeSetup` and printed nowhere at all, so
 * the only way to learn the token was to already know it. Setup was therefore impossible for
 * any caller the check below could not vouch for -- which, once `isPrivateRequest` stopped
 * recognising anybody, was everyone. The comment three lines up claimed otherwise, and that
 * claim is why nothing looked wrong.
 */
let setupToken: string | null = null;

export const getSetupToken = (): string => {
    if (!setupToken) {
        setupToken = randomBytes(16).toString("hex");

        // The container log is the delivery mechanism, not a debug aid.
        console.log(
            [
                "",
                `  Setup token: ${setupToken}`,
                "  Create the first account with this at /setup.",
                "  Valid until this process restarts.",
                "",
            ].join("\n")
        );
    }

    return setupToken;
};

/**
 * Is the caller on a private network?
 *
 * Deliberately conservative — anything not clearly private is treated as remote and made to
 * supply the token.
 *
 * The address comes from `clientIpFrom` under the configured `trustedProxyHops`, exactly as
 * rate limiting identifies a caller (§12), rather than from the first `X-Forwarded-For`
 * entry. The leftmost entry is the one the *client* appended, so reading it let a remote
 * caller assert `X-Forwarded-For: 10.0.0.1` and be judged private — skipping the setup token
 * on the one request that decides who owns the library. With no proxy configured the header
 * is not evidence of anything and is ignored outright.
 */
export const isPrivateRequest = (request: Request): boolean => {
    const candidate = clientIpFrom(request.headers, loadConfig().trustedProxyHops);

    if (!candidate) {
        // Nothing a proxy vouched for, so we cannot say where this came from -- and on the
        // one request that hands out `admin` and `delete`, "cannot say" has to mean no.
        //
        // This used to fall back to the hostname in `request.url`, which was wrong twice over.
        // Next's standalone server builds that URL from HOSTNAME, which entrypoint.sh sets to
        // 0.0.0.0 so the server binds every interface -- so the fallback read 0.0.0.0 for
        // every caller, judged all of them remote, and demanded a token that was never
        // printed. The unit test missed it by constructing `new Request("http://nas:8842/")`
        // by hand: it asserted the shape the author expected Next to produce rather than the
        // shape Next produces.
        //
        // Reading the Host *header* instead would fix the first fault and keep the second: a
        // header the caller writes is not evidence of where the caller is, and `Host: nas` is
        // one line of curl. That is a poor guard for the request that claims the library, so
        // there is no fallback at all now. Unidentifiable callers supply the setup token,
        // which is printed to the container log and is the guard actually worth having.
        return false;
    }

    return isPrivateAddress(candidate);
};

export const isPrivateAddress = (address: string): boolean => {
    const value = address.replace(/^\[|\]$/g, "").replace(/^::ffff:/, "");

    if (value === "localhost" || value === "::1" || value === "127.0.0.1") {
        return true;
    }

    if (/^10\./.test(value)) return true;
    if (/^192\.168\./.test(value)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(value)) return true;
    if (/^169\.254\./.test(value)) return true;
    if (/^f[cd][0-9a-f]{2}:/i.test(value)) return true;

    // No rule for a bare hostname. This is only ever handed an `X-Forwarded-For` entry, where a
    // name is not an address -- some proxies write `unknown` there -- and anything that is not
    // recognisably private has to fall to the token rather than be waved through as "the LAN".
    return false;
};

/** Constant-time, so response timing says nothing about how much of a guess was right. */
const matchesSetupToken = (supplied: string | undefined): boolean => {
    const expected = Buffer.from(getSetupToken());
    const given = Buffer.from(supplied ?? "");

    return given.length === expected.length && timingSafeEqual(given, expected);
};

export const completeSetup = async (input: SetupRequest, request: Request) => {
    if (!needsSetup()) {
        throw new ConflictError("Setup has already been completed");
    }

    if (!isPrivateRequest(request) && !matchesSetupToken(input.setupToken)) {
        throw new AuthorizationError(
            "Setup from a remote address requires the token printed in the server log"
        );
    }

    // The first account is necessarily an admin, and gets delete as well — otherwise nobody
    // can grant it, since granting requires an admin.
    return createUser({
        email: input.email,
        displayName: input.displayName,
        password: input.password,
        scopes: ["admin", "delete"],
    });
};
