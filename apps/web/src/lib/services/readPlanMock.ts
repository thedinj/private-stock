import { vi } from "vitest";

import type * as Db from "@private-stock/db";

/**
 * Read-plan drivers for a test that mocks `@private-stock/db` (§20 "Reads off the thread").
 *
 * A service's plan asks for its statements by name (`read("listMedia", ...)`), and the real
 * drivers would run the real repo function that name stands for -- not the test's mock. These run
 * the mock's instead: which repo function each name stands for is found by identity in the real
 * registry, so the mapping is the package's own and cannot drift from it.
 *
 *     vi.mock("@private-stock/db", async () => {
 *         const repos = { mediaRepo: { ... }, tagRepo: { ... } };
 *         return { ...repos, ...(await readPlanMock(repos)) };
 *     });
 *
 * `runOffThread` runs inline, as it does under vitest anyway.
 */
export const readPlanMock = async (repos: Record<string, Record<string, unknown>>) => {
    const actual = await vi.importActual<typeof Db>("@private-stock/db");
    const source = new Map<unknown, [string, string]>();

    for (const namespace of ["mediaRepo", "tagRepo"] as const) {
        for (const [key, fn] of Object.entries(actual[namespace])) {
            source.set(fn, [namespace, key]);
        }
    }

    const run = (request: { name: Db.ReadName; args: unknown[] }): unknown => {
        const [namespace, key] = source.get(actual.reads[request.name]) ?? [];
        const fn = namespace && key ? repos[namespace]?.[key] : undefined;

        if (typeof fn !== "function") {
            throw new Error(`The mock has no ${namespace}.${key} for read "${request.name}"`);
        }

        return fn(...request.args);
    };

    // A wait on another plan (`join`) is answered as the real `runNow` answers it: it cannot wait,
    // so the plan does the work itself.
    const runNow = <T>(plan: Db.ReadPlan<T>): T => {
        let step = plan.next();

        while (!step.done) {
            step = plan.next("join" in step.value ? undefined : run(step.value));
        }

        return step.value;
    };

    return {
        read: actual.read,
        join: actual.join,
        runNow,
        runOffThread: async <T>(plan: Db.ReadPlan<T>): Promise<T> => runNow(plan),
    };
};
