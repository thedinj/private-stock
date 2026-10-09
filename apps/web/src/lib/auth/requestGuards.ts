import { AuthorizationError, ValidationError } from "@private-stock/core";

/**
 * Guards for the endpoints that answer before anybody is signed in (§12).
 *
 * Everything else authenticates with a Bearer header, which a browser never attaches on its
 * own, so those routes are not reachable by cross-site request forgery and need neither guard.
 * These few are different: they set or clear the session cookie, and they read a body from
 * whoever asks.
 */

/**
 * Refuse a request another site's page made the browser send.
 *
 * `SameSite=Lax` stops the cookie riding *along* with a cross-site POST, but not a response
 * *setting* one — and a `text/plain` form can deliver a body that parses as JSON. So without
 * this, any page could sign a visitor into an account of the page's choosing, or sign them out
 * of their own.
 *
 * `Sec-Fetch-Site` rather than comparing `Origin` with `Host`, because the browser sets it and
 * page script cannot, and it needs nothing from the deployment: behind a proxy `Host` is
 * whatever the proxy forwards, and getting that comparison wrong locks everybody out of the
 * sign-in form. Only `cross-site` is refused. A client that sends no such header — curl, a
 * test, an older browser — is not a browser being steered by somebody else's page.
 */
export const rejectCrossSite = (request: Request): void => {
    if (request.headers.get("sec-fetch-site") === "cross-site") {
        throw new AuthorizationError("This request must come from the app itself");
    }
};

/**
 * Far above any sign-in, registration or setup form, and far below anything worth sending.
 *
 * Route handlers impose no body limit of their own and `request.json()` buffers the whole thing,
 * so an unauthenticated endpoint that called it would hold however many bytes a stranger chose
 * to send in memory, on a NAS, before validation had a chance to refuse any of them.
 */
const UNAUTHENTICATED_BODY_LIMIT = 16 * 1024;

/**
 * Read a small JSON body, refusing it as soon as it is known to be too large.
 *
 * `Content-Length` is checked first because it costs nothing, but it is the caller's claim and
 * may be absent under chunked encoding — so the stream is counted as it arrives as well, and
 * abandoned at the limit rather than read to the end.
 *
 * Malformed JSON is the caller's mistake and answers 400. `request.json()` threw a bare
 * `SyntaxError` for it, which reached the log as an internal error.
 */
export const readSmallJson = async (
    request: Request,
    limit = UNAUTHENTICATED_BODY_LIMIT
): Promise<unknown> => {
    const declared = Number(request.headers.get("content-length"));

    if (Number.isFinite(declared) && declared > limit) {
        throw new ValidationError("Request body is too large");
    }

    const chunks: Uint8Array[] = [];
    let received = 0;

    if (request.body) {
        const reader = request.body.getReader();

        for (;;) {
            const { done, value } = await reader.read();

            if (done) {
                break;
            }

            received += value.byteLength;

            if (received > limit) {
                await reader.cancel();
                throw new ValidationError("Request body is too large");
            }

            chunks.push(value);
        }
    }

    const bytes = new Uint8Array(received);
    let offset = 0;

    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }

    try {
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        throw new ValidationError("Request body is not valid JSON");
    }
};
