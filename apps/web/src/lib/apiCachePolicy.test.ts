import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import { describe, expect, it } from "vitest";

import nextConfig from "../../next.config";

/**
 * The API's default `Cache-Control`, and the routes that must be left out of it.
 *
 * Next sets config headers first and then copies a route's own headers only where none is set
 * yet, so a route that sets `Cache-Control` and is not excluded from the config default is
 * silently overruled — the art route's year-long `immutable` would become `no-store`, and a
 * forty-tile grid would re-fetch every cover on every scroll with nothing failing to say so.
 */

const API_DIR = fileURLToPath(new URL("../app/api", import.meta.url));

const routeFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            return routeFiles(full);
        }

        return entry.name === "route.ts" ? [full] : [];
    });

/** `app/api/media/[id]/stream/route.ts` → `/api/media/x/stream`. */
const urlFor = (file: string): string =>
    "/api/" +
    path
        .relative(API_DIR, path.dirname(file))
        .split(path.sep)
        .map((segment) => (segment.startsWith("[") ? "x" : segment))
        .join("/");

const noStoreMatcher = async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const rule = rules.find((candidate) =>
        candidate.headers.some((header) => header.key === "Cache-Control")
    );

    if (!rule) {
        throw new Error("next.config.ts sets no default Cache-Control for the API");
    }

    return getPathMatch(rule.source);
};

describe("API cache policy", () => {
    const routes = routeFiles(API_DIR).map((file) => ({
        url: urlFor(file),
        ownPolicy: readFileSync(file, "utf8").includes('"Cache-Control"'),
    }));

    it("finds the routes", () => {
        expect(routes.length).toBeGreaterThan(50);
        expect(routes.filter((route) => route.ownPolicy).map((route) => route.url)).toEqual(
            expect.arrayContaining(["/api/art/x/x", "/api/media/x/stream", "/api/events"])
        );
    });

    it("leaves every route that sets its own Cache-Control out of the default", async () => {
        const matches = await noStoreMatcher();
        const overruled = routes
            .filter((route) => route.ownPolicy && matches(route.url))
            .map((route) => route.url);

        expect(overruled).toEqual([]);
    });

    it("gives every other route the default", async () => {
        const matches = await noStoreMatcher();
        const uncovered = routes
            .filter((route) => !route.ownPolicy && !matches(route.url))
            .map((route) => route.url);

        expect(uncovered).toEqual([]);
    });
});
