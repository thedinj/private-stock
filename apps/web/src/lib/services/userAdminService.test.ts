import { beforeEach, describe, expect, it, vi } from "vitest";

import {
    AuthenticationError,
    AuthorizationError,
    ConflictError,
    NotFoundError,
    type Scope,
} from "@private-stock/core";

/**
 * Managing accounts (§12c).
 *
 * The tests that matter are the ones about locking a door from the inside. `/setup` only
 * reopens when the user count reaches zero, so a library whose last administrator has just
 * demoted, disabled or deleted themselves cannot be administered again by anybody, ever —
 * short of editing the database by hand over SSH.
 *
 * Each of those is checked in the service rather than only hidden in the UI, because the UI
 * hiding a control is an explanation and this is the rule.
 */

interface Row {
    id: string;
    email: string;
    displayName: string;
    password: string;
    scopes: string;
    disabled: 1 | null;
    tokenEpoch: number;
    invitationId: string | null;
    createdAt: string;
    updatedAt: string;
}

let rows: Row[] = [];
let deleted: string[] = [];
let revokedAllFor: string[] = [];

const row = (over: Partial<Row>): Row => ({
    id: "u-1",
    email: "a@example.test",
    displayName: "A",
    password: "x",
    scopes: "",
    disabled: null,
    tokenEpoch: 0,
    invitationId: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
});

vi.mock("@private-stock/db", () => ({
    userRepo: {
        findById: (id: string) => rows.find((candidate) => candidate.id === id),
        listUsers: () =>
            rows.map((candidate) => ({
                ...candidate,
                invitationLabel: candidate.invitationId ? "Houseguests" : null,
                invitationCode: candidate.invitationId ? "ABCDEFGHJK" : null,
            })),
        countWithScope: (scope: string) =>
            rows.filter(
                (candidate) =>
                    candidate.disabled === null && candidate.scopes.split(",").includes(scope)
            ).length,
        findByEmail: (email: string) =>
            rows.find((candidate) => candidate.email.toLowerCase() === email.toLowerCase()),
        setProfile: (id: string, patch: { displayName?: string; email?: string }) => {
            const target = rows.find((candidate) => candidate.id === id);
            if (!target) return;
            if (patch.displayName !== undefined) target.displayName = patch.displayName;
            if (patch.email !== undefined) target.email = patch.email;
        },
        // Mirrors the real statement, which bumps the epoch in the same UPDATE.
        setPassword: (id: string, hash: string) => {
            const target = rows.find((candidate) => candidate.id === id);
            if (target) {
                target.password = hash;
                target.tokenEpoch += 1;
            }
        },
        setScopes: (id: string, scopes: string) => {
            const target = rows.find((candidate) => candidate.id === id);
            if (target) target.scopes = scopes;
        },
        setDisabled: (id: string, disabled: boolean) => {
            const target = rows.find((candidate) => candidate.id === id);
            if (target) {
                target.disabled = disabled ? 1 : null;
                target.tokenEpoch += 1;
            }
        },
        deleteUser: (id: string) => {
            deleted.push(id);
            rows = rows.filter((candidate) => candidate.id !== id);
        },
    },
    refreshTokenRepo: {
        revokeAllForUser: (userId: string) => {
            revokedAllFor.push(userId);
        },
    },
}));

const service = await import("./userAdminService");

const auth = (userId: string, scopes: Scope[]) => ({
    userId,
    email: "admin@example.test",
    displayName: "The Admin",
    scopes,
    accessibleRootIds: [],
    tokenEpoch: 0,
});

const BOSS = auth("u-boss", ["admin", "delete"]);
const VIEWER = auth("u-guest", []);

const { hashPassword, verifyPassword } = await import("../auth/password");

/** The administrator's own password, which every reset has to be accompanied by. */
const BOSS_PASSWORD = "correct horse battery";

beforeEach(async () => {
    deleted = [];
    revokedAllFor = [];
    rows = [
        row({
            id: "u-boss",
            email: "boss@example.test",
            displayName: "Boss",
            scopes: "admin,delete",
            password: await hashPassword(BOSS_PASSWORD),
        }),
        row({
            id: "u-guest",
            email: "guest@example.test",
            displayName: "Guest",
            invitationId: "inv-1",
        }),
    ];
});

describe("who may manage accounts", () => {
    it("refuses somebody without the admin scope", () => {
        expect(() => service.listUsers(VIEWER)).toThrow(AuthorizationError);
        expect(() => service.updateUser("u-guest", { disabled: true }, VIEWER)).toThrow(
            AuthorizationError
        );
        expect(() => service.deleteUser("u-guest", VIEWER)).toThrow(AuthorizationError);
    });

    it("reports an unknown account as not found", () => {
        expect(() => service.updateUser("nope", {}, BOSS)).toThrow(NotFoundError);
        expect(() => service.deleteUser("nope", BOSS)).toThrow(NotFoundError);
    });
});

describe("the list", () => {
    it("never carries the password hash", () => {
        for (const listed of service.listUsers(BOSS)) {
            expect(listed).not.toHaveProperty("password");
        }
    });

    it("marks the account doing the reading", () => {
        const listed = service.listUsers(BOSS);

        expect(listed.find((u) => u.id === "u-boss")?.isSelf).toBe(true);
        expect(listed.find((u) => u.id === "u-guest")?.isSelf).toBe(false);
    });

    it("says how somebody got in, and leaves the first admin without an answer", () => {
        const listed = service.listUsers(BOSS);

        expect(listed.find((u) => u.id === "u-guest")?.invitedAs).toBe("Houseguests");
        expect(listed.find((u) => u.id === "u-boss")?.invitedAs).toBeNull();
    });
});

describe("doors that must not lock from the inside", () => {
    it("refuses to remove your own administrator access", () => {
        expect(() => service.updateUser("u-boss", { scopes: ["delete"] }, BOSS)).toThrow(
            ConflictError
        );
    });

    it("refuses to disable your own account", () => {
        expect(() => service.updateUser("u-boss", { disabled: true }, BOSS)).toThrow(ConflictError);
    });

    it("refuses to delete your own account", () => {
        expect(() => service.deleteUser("u-boss", BOSS)).toThrow(ConflictError);
    });

    /**
     * The self-checks above are what actually keep the library administrable, and this is
     * why: the caller is necessarily an enabled administrator, so any *other* enabled
     * administrator makes the count at least two. Demoting somebody else therefore always
     * leaves the caller, and the "only administrator" guard in the service is defence in
     * depth rather than a path anybody reaches today.
     */
    it("allows demoting another administrator, because the caller is still one", () => {
        rows.push(row({ id: "u-other", email: "other@example.test", scopes: "admin" }));

        expect(service.updateUser("u-other", { scopes: [] }, BOSS).scopes).toEqual([]);
    });

    it("allows deleting another administrator for the same reason", () => {
        rows.push(row({ id: "u-other", email: "other@example.test", scopes: "admin" }));

        expect(() => service.deleteUser("u-other", BOSS)).not.toThrow();
    });

    /**
     * A disabled administrator is not one the library *has*, and `countWithScope` agrees.
     *
     * This is the case that had the guard backwards: with the caller as the only enabled
     * administrator, the count is one, so demoting an already-disabled administrator was
     * refused as "the only administrator" — naming an account that was not being touched and
     * an administrator who was in no danger.
     */
    it("lets a disabled administrator be demoted without claiming they are the last one", () => {
        rows.push(
            row({ id: "u-other", email: "other@example.test", scopes: "admin", disabled: 1 })
        );

        expect(() => service.updateUser("u-other", { scopes: [] }, BOSS)).not.toThrow();
    });

    it("lets a disabled administrator be deleted for the same reason", () => {
        rows.push(
            row({ id: "u-other", email: "other@example.test", scopes: "admin", disabled: 1 })
        );

        expect(() => service.deleteUser("u-other", BOSS)).not.toThrow();
    });

    /**
     * Scopes and `disabled` arrive together so the service judges one end state. Sent as two
     * requests, "keep admin" and "disable" would each pass their own check and still arrive
     * at an account holding administrator access that nobody can sign in to.
     */
    it("treats keeping admin while disabling as not being an administrator", () => {
        rows.push(row({ id: "u-other", email: "other@example.test", scopes: "admin" }));

        const updated = service.updateUser("u-other", { scopes: ["admin"], disabled: true }, BOSS);

        expect(updated.disabled).toBe(true);
        expect(updated.scopes).toEqual(["admin"]);
    });
});

describe("ordinary changes", () => {
    it("grants a scope", () => {
        expect(service.updateUser("u-guest", { scopes: ["delete"] }, BOSS).scopes).toEqual([
            "delete",
        ]);
    });

    it("disables and re-enables somebody else", () => {
        expect(service.updateUser("u-guest", { disabled: true }, BOSS).disabled).toBe(true);
        expect(service.updateUser("u-guest", { disabled: false }, BOSS).disabled).toBe(false);
    });

    /**
     * Disabling has to reach the signed media URLs already handed out, or a disabled account
     * goes on streaming until each one expires (§12d).
     */
    it("bumps the token epoch when disabling, which kills outstanding media URLs", () => {
        const before = rows.find((candidate) => candidate.id === "u-guest")!.tokenEpoch;

        service.updateUser("u-guest", { disabled: true }, BOSS);

        expect(rows.find((candidate) => candidate.id === "u-guest")!.tokenEpoch).toBe(before + 1);
    });

    /**
     * Granting one must not. Scopes are read from the row on every request, so the change
     * lands anyway — and bumping would stop the person's playback mid-item to give them
     * something.
     */
    it("leaves the epoch alone when only scopes change", () => {
        const before = rows.find((candidate) => candidate.id === "u-guest")!.tokenEpoch;

        service.updateUser("u-guest", { scopes: ["delete"] }, BOSS);

        expect(rows.find((candidate) => candidate.id === "u-guest")!.tokenEpoch).toBe(before);
    });

    it("does not touch the epoch when disabled is restated at its current value", () => {
        const before = rows.find((candidate) => candidate.id === "u-guest")!.tokenEpoch;

        service.updateUser("u-guest", { disabled: false }, BOSS);

        expect(rows.find((candidate) => candidate.id === "u-guest")!.tokenEpoch).toBe(before);
    });

    it("deletes somebody else", () => {
        service.deleteUser("u-guest", BOSS);

        expect(deleted).toEqual(["u-guest"]);
    });
});

describe("editing name and email", () => {
    it("renames an account", () => {
        expect(service.updateUser("u-guest", { displayName: "Guest Room" }, BOSS).displayName).toBe(
            "Guest Room"
        );
    });

    /**
     * The field is labelled "email" and does nothing an email address normally does — nothing
     * is ever sent to it. It is a username, which is why a typo in one locks somebody out
     * until an administrator fixes it here.
     */
    it("changes the address an account signs in with", () => {
        expect(service.updateUser("u-guest", { email: "new@example.test" }, BOSS).email).toBe(
            "new@example.test"
        );
    });

    it("refuses an address another account already uses", () => {
        expect(() => service.updateUser("u-guest", { email: "boss@example.test" }, BOSS)).toThrow(
            ConflictError
        );
    });

    /** Saving a form that did not touch the address must not collide with itself. */
    it("allows an account to keep the address it already has", () => {
        expect(() =>
            service.updateUser(
                "u-guest",
                { displayName: "Guest", email: "guest@example.test" },
                BOSS
            )
        ).not.toThrow();
    });

    it("lets an administrator fix their own name", () => {
        expect(service.updateUser("u-boss", { displayName: "The Boss" }, BOSS).displayName).toBe(
            "The Boss"
        );
    });

    /**
     * Nothing about identity has changed, so the signed media URLs in somebody's hands are
     * still theirs. Ending their sessions because a typo was fixed would be a sign-out with
     * no cause they could see.
     */
    it("does not disturb sessions or signed links", () => {
        const before = rows.find((candidate) => candidate.id === "u-guest")!.tokenEpoch;

        service.updateUser("u-guest", { displayName: "Renamed" }, BOSS);

        expect(rows.find((candidate) => candidate.id === "u-guest")!.tokenEpoch).toBe(before);
        expect(revokedAllFor).toEqual([]);
    });
});

describe("editing your own account", () => {
    it("lets anybody rename themselves", () => {
        expect(service.updateOwnProfile({ displayName: "Guest Room" }, VIEWER).displayName).toBe(
            "Guest Room"
        );
    });

    /**
     * The address is the username. Refused rather than ignored, so a client that sent it is
     * told it failed instead of being told "saved".
     */
    it("refuses a sign-in address from anybody but an administrator, and changes nothing", () => {
        expect(() =>
            service.updateOwnProfile({ displayName: "New", email: "mine@example.test" }, VIEWER)
        ).toThrow(AuthorizationError);

        const guest = rows.find((candidate) => candidate.id === "u-guest")!;
        expect(guest.email).toBe("guest@example.test");
        expect(guest.displayName).toBe("Guest");
    });

    it("lets an administrator change their own sign-in address", () => {
        expect(service.updateOwnProfile({ email: "chief@example.test" }, BOSS).email).toBe(
            "chief@example.test"
        );
    });

    it("refuses an address another account already uses", () => {
        expect(() => service.updateOwnProfile({ email: "guest@example.test" }, BOSS)).toThrow(
            ConflictError
        );
    });

    it("does not disturb sessions or signed links", () => {
        service.updateOwnProfile({ displayName: "Renamed", email: "chief@example.test" }, BOSS);

        expect(rows.find((candidate) => candidate.id === "u-boss")!.tokenEpoch).toBe(0);
        expect(revokedAllFor).toEqual([]);
    });
});

describe("setting somebody else's password", () => {
    const reset = (id: string, over: Partial<{ password: string; adminPassword: string }> = {}) =>
        service.setUserPassword(
            id,
            { password: "a-new-password", adminPassword: BOSS_PASSWORD, ...over },
            BOSS
        );

    it("refuses somebody without the admin scope", async () => {
        await expect(
            service.setUserPassword(
                "u-guest",
                { password: "a-new-password", adminPassword: BOSS_PASSWORD },
                VIEWER
            )
        ).rejects.toThrow(AuthorizationError);
    });

    it("reports an unknown account as not found", async () => {
        await expect(reset("nope")).rejects.toThrow(NotFoundError);
    });

    /**
     * The whole reason the caller re-proves themselves. A stolen access token is fifteen
     * minutes of ambient authority, and this is the one action whose effect outlives the
     * session that performed it — so an attacker holding a token and not a password gets
     * nowhere.
     */
    it("refuses without the caller's own password", async () => {
        await expect(reset("u-guest", { adminPassword: "not it" })).rejects.toThrow(
            AuthenticationError
        );
    });

    it("changes nothing when the caller's password is wrong", async () => {
        const before = rows.find((candidate) => candidate.id === "u-guest")!.password;

        await expect(reset("u-guest", { adminPassword: "not it" })).rejects.toThrow();

        expect(rows.find((candidate) => candidate.id === "u-guest")!.password).toBe(before);
        expect(revokedAllFor).toEqual([]);
    });

    it("sets a password the account can be signed in with", async () => {
        await reset("u-guest", { password: "brand-new-one" });

        const stored = rows.find((candidate) => candidate.id === "u-guest")!.password;

        expect(await verifyPassword("brand-new-one", stored)).toBe(true);
    });

    /**
     * Both halves, because a reset that left either alive would not have locked anybody out:
     * the epoch kills the signed media URLs (§12d), the revocation ends the sessions.
     */
    it("ends their sessions and kills their signed links", async () => {
        const before = rows.find((candidate) => candidate.id === "u-guest")!.tokenEpoch;

        await reset("u-guest");

        expect(rows.find((candidate) => candidate.id === "u-guest")!.tokenEpoch).toBe(before + 1);
        expect(revokedAllFor).toEqual(["u-guest"]);
    });

    /**
     * Your own password change lives in Settings, where it asks for the one you are replacing.
     * Allowing a self-reset here would be that endpoint without the check — which is exactly
     * the hole the re-authentication above exists to close.
     */
    it("refuses to reset your own password, and says where to do it", async () => {
        await expect(reset("u-boss")).rejects.toThrow(ConflictError);
        await expect(reset("u-boss")).rejects.toThrow(/account page/i);
    });

    it("works on a disabled account, which is the likeliest reason to need it", async () => {
        service.updateUser("u-guest", { disabled: true }, BOSS);

        await expect(reset("u-guest")).resolves.toBeUndefined();
    });
});
