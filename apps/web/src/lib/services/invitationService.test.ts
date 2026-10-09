import { beforeEach, describe, expect, it, vi } from "vitest";

import {
    AuthorizationError,
    ConflictError,
    NotFoundError,
    ValidationError,
    type Scope,
} from "@private-stock/core";

/**
 * Invitations (§12c).
 *
 * Two claims carry the security of the whole feature and each has a test that fails loudly if
 * it stops holding:
 *
 *   - **Nobody grants what they do not hold.** Without it, anybody who can mint an invitation
 *     can mint one carrying `admin` and use it themselves, and there is only one kind of
 *     account in the app.
 *   - **A code that cannot be used is refused**, whether it was withdrawn, has expired, or is
 *     spent. `usable` on the admin list and the refusal in `consumeInvitation` come from one
 *     function, so the screen cannot say yes while the gate says no.
 */

interface Row {
    id: string;
    code: string;
    label: string | null;
    scopes: string;
    maxUses: number | null;
    expiresAt: string | null;
    revokedAt: string | null;
    createdById: string | null;
    createdAt: string;
}

let rows: Row[] = [];
let uses: Record<string, number> = {};

vi.mock("@private-stock/db", () => ({
    invitationRepo: {
        listInvitations: () =>
            rows.map((row) => ({
                ...row,
                useCount: uses[row.id] ?? 0,
                createdByName: "The Admin",
            })),
        findById: (id: string) => rows.find((row) => row.id === id),
        findByCode: (code: string) => rows.find((row) => row.code === code),
        countUses: (id: string) => uses[id] ?? 0,
        createInvitation: (input: Omit<Row, "id" | "revokedAt" | "createdAt">) => {
            const row: Row = {
                ...input,
                id: `inv-${rows.length + 1}`,
                revokedAt: null,
                createdAt: new Date().toISOString(),
            };
            rows.push(row);
            return row;
        },
        revokeInvitation: (id: string) => {
            const row = rows.find((candidate) => candidate.id === id);
            if (row && !row.revokedAt) row.revokedAt = new Date().toISOString();
        },
        deleteUnusedInvitation: (id: string) => {
            if ((uses[id] ?? 0) > 0) return false;
            rows = rows.filter((row) => row.id !== id);
            return true;
        },
    },
}));

const service = await import("./invitationService");

const auth = (scopes: Scope[]) => ({
    userId: "u-admin",
    email: "admin@example.test",
    displayName: "The Admin",
    scopes,
    accessibleRootIds: [],
    tokenEpoch: 0,
});

const ADMIN = auth(["admin", "delete"]);
const ADMIN_ONLY = auth(["admin"]);
const VIEWER = auth([]);

beforeEach(() => {
    rows = [];
    uses = {};
});

const mint = (over: Partial<Parameters<typeof service.createInvitation>[0]> = {}, as = ADMIN) =>
    service.createInvitation({ scopes: [], ...over }, as);

describe("who may mint", () => {
    it("refuses somebody without the admin scope", () => {
        expect(() => mint({}, VIEWER)).toThrow(AuthorizationError);
    });

    /**
     * The rule the whole permission model rests on. An admin-only account minting a code that
     * grants `delete` would be granting itself `delete` the moment it used the code.
     */
    it("refuses to grant a permission the maker does not hold", () => {
        expect(() => mint({ scopes: ["delete"] }, ADMIN_ONLY)).toThrow(AuthorizationError);
    });

    it("allows granting a permission the maker does hold", () => {
        expect(mint({ scopes: ["delete"] }, ADMIN).scopes).toEqual(["delete"]);
    });

    it("names the permission it refused, because the caller can act on that", () => {
        expect(() => mint({ scopes: ["delete"] }, ADMIN_ONLY)).toThrow(/delete/);
    });
});

describe("the code itself", () => {
    /**
     * There is no parameter for the code and deliberately no way to add one: a chosen code
     * carries whatever entropy went into choosing it, which is what would make the route's
     * rate limiter load-bearing instead of a volume control.
     */
    it("is generated, not supplied", () => {
        const first = mint().code;
        const second = mint().code;

        expect(first).toHaveLength(10);
        expect(first).not.toBe(second);
        expect(first).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
    });

    it("starts unused and usable", () => {
        const invitation = mint();

        expect(invitation.useCount).toBe(0);
        expect(invitation.usable).toBe(true);
    });
});

describe("what makes an invitation usable", () => {
    it("accepts a live one and reports what it grants", () => {
        const invitation = mint({ scopes: ["delete"] });

        expect(service.consumeInvitation(invitation.code)).toEqual({
            invitationId: invitation.id,
            scopes: ["delete"],
        });
    });

    it("refuses a code that does not exist", () => {
        expect(() => service.consumeInvitation("ZZZZZZZZZZ")).toThrow(ValidationError);
    });

    it("refuses a withdrawn one, and says so", () => {
        const invitation = mint();
        service.revokeInvitation(invitation.id, ADMIN);

        expect(() => service.consumeInvitation(invitation.code)).toThrow(/withdrawn/i);
    });

    it("refuses an expired one, and says so", () => {
        const invitation = mint({ expiresInDays: 1 });
        rows[0].expiresAt = new Date(Date.now() - 1000).toISOString();

        expect(() => service.consumeInvitation(invitation.code)).toThrow(/expired/i);
    });

    it("refuses one that has reached its limit", () => {
        const invitation = mint({ maxUses: 2 });
        uses[invitation.id] = 2;

        expect(() => service.consumeInvitation(invitation.code)).toThrow(/already been used/i);
    });

    it("keeps accepting one with uses left", () => {
        const invitation = mint({ maxUses: 2 });
        uses[invitation.id] = 1;

        expect(() => service.consumeInvitation(invitation.code)).not.toThrow();
    });

    it("never exhausts one with no limit", () => {
        const invitation = mint({ maxUses: null });
        uses[invitation.id] = 10_000;

        expect(() => service.consumeInvitation(invitation.code)).not.toThrow();
    });

    /**
     * The admin screen and the gate must not be able to disagree — a list showing an
     * invitation as live that registration then refuses is unexplainable from the screen.
     */
    it("reports the same verdict on the list as at the gate", () => {
        const live = mint();
        const dead = mint();
        service.revokeInvitation(dead.id, ADMIN);

        const listed = service.listInvitations(ADMIN);

        for (const invitation of listed) {
            const accepted = (() => {
                try {
                    service.consumeInvitation(invitation.code);
                    return true;
                } catch {
                    return false;
                }
            })();

            expect(accepted).toBe(invitation.usable);
        }

        expect(listed.find((row) => row.id === live.id)?.usable).toBe(true);
        expect(listed.find((row) => row.id === dead.id)?.usable).toBe(false);
    });
});

describe("withdrawing and removing", () => {
    it("refuses a non-admin", () => {
        const invitation = mint();

        expect(() => service.revokeInvitation(invitation.id, VIEWER)).toThrow(AuthorizationError);
        expect(() => service.deleteInvitation(invitation.id, VIEWER)).toThrow(AuthorizationError);
    });

    it("reports an unknown id as not found", () => {
        expect(() => service.revokeInvitation("nope", ADMIN)).toThrow(NotFoundError);
        expect(() => service.deleteInvitation("nope", ADMIN)).toThrow(NotFoundError);
    });

    it("removes one nobody used", () => {
        const invitation = mint();

        service.deleteInvitation(invitation.id, ADMIN);

        expect(service.listInvitations(ADMIN)).toHaveLength(0);
    });

    /** Deleting it would throw away the only record of how those accounts were created. */
    it("refuses to remove one somebody joined through, and says to withdraw instead", () => {
        const invitation = mint();
        uses[invitation.id] = 1;

        expect(() => service.deleteInvitation(invitation.id, ADMIN)).toThrow(ConflictError);
        expect(() => service.deleteInvitation(invitation.id, ADMIN)).toThrow(/[Ww]ithdraw/);
    });

    it("leaves the first withdrawal time alone when withdrawn again", () => {
        const invitation = mint();

        const first = service.revokeInvitation(invitation.id, ADMIN).revokedAt;
        const second = service.revokeInvitation(invitation.id, ADMIN).revokedAt;

        expect(second).toBe(first);
    });
});

describe("reading the list", () => {
    it("refuses a non-admin", () => {
        expect(() => service.listInvitations(VIEWER)).toThrow(AuthorizationError);
    });

    it("carries the label and the limits through", () => {
        mint({ label: "Houseguests", maxUses: 5 });

        const [row] = service.listInvitations(ADMIN);

        expect(row.label).toBe("Houseguests");
        expect(row.maxUses).toBe(5);
    });

    it("treats a blank label as none rather than as an empty name", () => {
        mint({ label: "   " });

        expect(service.listInvitations(ADMIN)[0].label).toBeNull();
    });
});
