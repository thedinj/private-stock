import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthenticationError, NotFoundError } from "@private-stock/core";

/**
 * The deferred "appears with" request (§6 "Tags", §20): the profile's auth, seed and
 * visibility rules, answered on its own.
 */

const getTagCompanions = vi.fn();
let authFails = false;

vi.mock("@private-stock/db", () => ({
    errorLogRepo: { logError: () => undefined },
    isBusyError: () => false,
}));

vi.mock("@/lib/auth/withAuth", () => ({
    requireAuth: async () => {
        if (authFails) throw new AuthenticationError("Not signed in");

        return { userId: "u1", accessibleRootIds: ["r1"], scopes: [] };
    },
}));

vi.mock("@/lib/services/tagService", () => ({
    getTagCompanions: (...args: unknown[]) => getTagCompanions(...args),
}));

const route = await import("./route");

const call = (query: string, id = "t1") =>
    route.GET(new Request(`http://localhost/api/tags/${id}/companions${query}`), {
        params: Promise.resolve({ id }),
    });

beforeEach(() => {
    authFails = false;
    getTagCompanions.mockReset();
    getTagCompanions.mockReturnValue({ companions: [] });
});

describe("GET /api/tags/:id/companions", () => {
    it("is dynamic, like every route", () => {
        expect(route.dynamic).toBe("force-dynamic");
        expect(route.revalidate).toBe(0);
        expect(route.runtime).toBe("nodejs");
        expect(route.fetchCache).toBe("force-no-store");
    });

    it("passes the tag, the profile's seed and the viewer to the service", async () => {
        const response = await call("?seed=42");

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ companions: [] });
        expect(getTagCompanions).toHaveBeenCalledWith(
            "t1",
            42,
            expect.objectContaining({ userId: "u1" })
        );
    });

    it("refuses a request without a seed, so strips cannot drift within a visit", async () => {
        expect((await call("")).status).toBe(400);
        expect(getTagCompanions).not.toHaveBeenCalled();
    });

    it("answers a tag the viewer may not see as not found", async () => {
        getTagCompanions.mockImplementation(() => {
            throw new NotFoundError("Tag not found");
        });

        expect((await call("?seed=1")).status).toBe(404);
    });

    it("needs a signed-in viewer", async () => {
        authFails = true;

        expect((await call("?seed=1")).status).toBe(401);
        expect(getTagCompanions).not.toHaveBeenCalled();
    });
});
