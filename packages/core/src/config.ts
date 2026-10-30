import { z } from "zod";

/**
 * The bootstrap configuration — §12b.
 *
 * Only what is needed to start the process or find the database lives here. Anything an
 * admin might change at runtime is a `Setting` row edited in the UI instead. Keeping this
 * list short is a design rule, not an accident: every key added here is a key someone has
 * to SSH in to change.
 */
export const configSchema = z.object({
    /** HTTP listen port. QTS itself occupies 8080/8081/443/8443, hence 8842. */
    port: z.coerce.number().int().min(1).max(65535).default(8842),

    /** Database, artifacts, variants, trash, backups. The only directory the app writes to. */
    dataDir: z.string().min(1).default("./data"),

    /** Parent of the mounted media roots. Roots are discovered by listing this. */
    mediaDir: z.string().min(1).default("./media"),

    logLevel: z.enum(["error", "warn", "info", "debug"]).default("info"),

    /**
     * How many reverse proxies of our own stand in front of the app.
     *
     * Config rather than a `Setting` row, which is the one exception the §12b rule needs
     * explaining: this describes the *deployment*, exactly as `port` does, and it is read
     * before anyone is authenticated. It also decides how a client is identified for rate
     * limiting, so leaving it editable in the UI would put the lock on the inside of the door.
     *
     * 0 — nothing trusted, which is correct when the container is reached directly.
     * 1 — the usual: one Caddy in front.
     * 2 — Caddy behind Cloudflare, or any other pair.
     *
     * Setting this higher than the number of proxies actually present is the dangerous
     * direction: it makes the app believe a `X-Forwarded-For` entry the client wrote itself.
     */
    trustedProxyHops: z.coerce.number().int().min(0).max(10).default(0),

    /**
     * Where a TV fetches a cast item from (§11, "Casting decides the certificate").
     *
     * A Cast receiver fetches the URL itself and cannot be told about a private certificate
     * authority, but it does play plain HTTP. So the LAN install publishes a second, token-only
     * port that serves nothing but `stream?t=`, and this names it: `http://<nas-ip>:<port>`.
     * Null — the public install, whose certificate a TV already trusts — hands out the path
     * alone and the browser joins it to the origin it loaded from.
     *
     * Config rather than a `Setting` for the reason `trustedProxyHops` is: it describes the
     * deployment, it has to match a port the compose file publishes, and it decides where a
     * credential is sent, which is not a thing to leave editable from inside the app.
     */
    castOrigin: z
        .string()
        .refine((value) => {
            try {
                const url = new URL(value);

                return (
                    (url.protocol === "http:" || url.protocol === "https:") &&
                    url.pathname === "/" &&
                    !url.search &&
                    !url.hash &&
                    !url.username
                );
            } catch {
                return false;
            }
        }, "An origin like http://192.168.1.10:8843 — scheme, host and port, no path")
        .transform((value) => new URL(value).origin)
        .nullable()
        .default(null),

    /**
     * JWT and media-URL signing key. Generated into `<dataDir>/secret.key` on first boot
     * when neither the file nor the environment supplies one, so nobody has to invent a
     * key and nobody accidentally ships a default.
     */
    secret: z.string().min(32).nullable().default(null),
});

export type Config = z.infer<typeof configSchema>;

/** Env var name for each config key. Env always wins over the file. */
export const CONFIG_ENV_KEYS: Record<keyof Config, string> = {
    port: "PRIVATE_STOCK_PORT",
    dataDir: "PRIVATE_STOCK_DATA_DIR",
    mediaDir: "PRIVATE_STOCK_MEDIA_DIR",
    logLevel: "PRIVATE_STOCK_LOG_LEVEL",
    trustedProxyHops: "PRIVATE_STOCK_TRUSTED_PROXY_HOPS",
    castOrigin: "PRIVATE_STOCK_CAST_ORIGIN",
    secret: "PRIVATE_STOCK_SECRET",
};

/**
 * Strip annotation keys before validation.
 *
 * JSON has no comments, so the loader ignores any key beginning with `//`. That is enough
 * to annotate `config.example.json` without reaching for JSON5.
 */
export const stripComments = (raw: unknown): unknown => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        return raw;
    }

    return Object.fromEntries(
        Object.entries(raw as Record<string, unknown>).filter(([key]) => !key.startsWith("//"))
    );
};

/**
 * Merge file config with environment overrides and validate the result.
 *
 * Pure, so it is testable without touching the filesystem — the reading half lives in
 * `@private-stock/core/server`.
 */
export const resolveConfig = (
    fileConfig: unknown,
    env: Record<string, string | undefined>
): Config => {
    const fromFile = stripComments(fileConfig) as Record<string, unknown>;

    const fromEnv: Record<string, unknown> = {};
    for (const [key, envKey] of Object.entries(CONFIG_ENV_KEYS)) {
        const value = env[envKey];
        if (value !== undefined && value !== "") {
            fromEnv[key] = value;
        }
    }

    const parsed = configSchema.safeParse({ ...fromFile, ...fromEnv });

    if (!parsed.success) {
        const detail = parsed.error.issues
            .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
            .join("\n");

        throw new Error(`Invalid configuration:\n${detail}`);
    }

    return parsed.data;
};
