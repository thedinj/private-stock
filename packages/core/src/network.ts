/**
 * Working out who is asking (§12).
 *
 * Pure header arithmetic, kept here so it can be tested without a server. The web app is
 * Next's standalone server, which exposes no socket address to a route handler — so the only
 * thing that can name a client is a header, and a header is only as trustworthy as whatever
 * put it there.
 */

/**
 * The client address, or null when nothing here can be believed.
 *
 * `hops` is how many proxies of our own stand in front of the app. `X-Forwarded-For` is a
 * list each proxy appends to, so the entry `hops` from the right is the address our
 * outermost proxy actually saw; everything to the left of it was supplied by the caller and
 * is therefore a claim, not a fact.
 *
 * Zero means no proxy is trusted and the answer is null, even when the header is present and
 * looks plausible. That is the important case: with no proxy in front, `X-Forwarded-For` is
 * whatever the client typed, so honouring it would let anyone rate-limit somebody else out
 * of their account by forging an address — or evade their own limit by rotating one.
 */
export const clientIpFrom = (headers: Headers, hops: number): string | null => {
    if (hops <= 0) {
        return null;
    }

    const forwarded = headers.get("x-forwarded-for");

    if (!forwarded) {
        return null;
    }

    const chain = forwarded
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);

    // Fewer entries than proxies means the chain is shorter than the deployment says it is:
    // a misconfiguration, or a request that reached the app without going through them.
    // Either way the leftmost entry is not the client, so claim nothing.
    const address = chain[chain.length - hops];

    return address && chain.length >= hops ? normaliseAddress(address) : null;
};

/**
 * Strip the decorations proxies add, so one client is one bucket.
 *
 * A port makes every request from the same machine look like a different caller, which would
 * defeat a per-address limit entirely. IPv6 arrives bracketed, and `::ffff:` prefixes an IPv4
 * address mapped into v6 — the same host reached two ways.
 */
const normaliseAddress = (value: string): string => {
    let address = value.toLowerCase();

    // Bracketed IPv6, with or without a port: `[2001:db8::1]:443`.
    if (address.startsWith("[")) {
        const close = address.indexOf("]");
        address = close > 0 ? address.slice(1, close) : address.slice(1);
    }

    // `::ffff:203.0.113.5` is an IPv4 address mapped into v6 — the same host, and it has to
    // be unwrapped before the port test below, which would otherwise cut at the first colon
    // and leave nothing at all.
    if (address.startsWith("::ffff:")) {
        address = address.slice("::ffff:".length);
    }

    // IPv4 with a port. Matched rather than searched for a colon, because a bare IPv6
    // address is nothing but colons.
    const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(address);

    return withPort ? withPort[1] : address;
};

/**
 * Whether the request arrived over TLS, believing the proxy only when there is one.
 *
 * The refresh cookie's `Secure` flag depends on this. Trusting the header unconditionally
 * would let a client on a plain-HTTP LAN deployment assert `https` and be handed a cookie
 * the browser then refuses to send back — a self-inflicted lockout rather than an attack,
 * but a confusing one.
 */
export const isHttpsRequest = (request: Request, hops: number): boolean => {
    if (hops > 0) {
        const proto = request.headers.get("x-forwarded-proto");

        if (proto) {
            // Also a list when several proxies append to it; ours is the leftmost, which is
            // the scheme the client actually used.
            return proto.split(",")[0].trim().toLowerCase() === "https";
        }
    }

    return new URL(request.url).protocol === "https:";
};
