import { describe, expect, it } from "vitest";

import {
    INVITATION_CODE_LENGTH,
    formatInvitationCode,
    generateInvitationCode,
    generateReadablePassword,
    normalizeInvitationCode,
} from "./invitationCode.js";

/** A deterministic stand-in for `crypto.getRandomValues`, so codes are assertable. */
const bytes = (values: number[]) => (into: Uint8Array) => {
    into.set(values.slice(0, into.length));
    return into;
};

describe("normalizeInvitationCode", () => {
    it("forgives the grouping, which is cosmetic", () => {
        expect(normalizeInvitationCode("ABCDE-FGHJK")).toBe("ABCDEFGHJK");
        expect(normalizeInvitationCode("ABCDE FGHJK")).toBe("ABCDEFGHJK");
        expect(normalizeInvitationCode("abcdefghjk")).toBe("ABCDEFGHJK");
    });

    /**
     * The point of the confusion table. A code read aloud over the phone is heard, not seen,
     * so "oh" and "zero" are the same sound and must be the same code.
     */
    it("resolves the characters people type when they mean another", () => {
        expect(normalizeInvitationCode("O0")).toBe("00");
        expect(normalizeInvitationCode("Il1")).toBe("111");
        expect(normalizeInvitationCode("U")).toBe("V");
    });

    it("is idempotent, because the stored form goes through it too", () => {
        const once = normalizeInvitationCode("ce1-lar OK");
        expect(normalizeInvitationCode(once)).toBe(once);
    });

    it("drops everything that is not a code character", () => {
        expect(normalizeInvitationCode("  A@B#C$  ")).toBe("ABC");
        expect(normalizeInvitationCode("")).toBe("");
    });
});

describe("formatInvitationCode", () => {
    it("groups in fives for reading aloud", () => {
        expect(formatInvitationCode("ABCDEFGHJK")).toBe("ABCDE-FGHJK");
    });

    it("round-trips through normalisation", () => {
        const code = "ABCDEFGHJK";
        expect(normalizeInvitationCode(formatInvitationCode(code))).toBe(code);
    });

    it("leaves a short string alone rather than producing a trailing hyphen", () => {
        expect(formatInvitationCode("ABC")).toBe("ABC");
    });
});

describe("generateInvitationCode", () => {
    it("is the length the schema checks for", () => {
        expect(generateInvitationCode()).toHaveLength(INVITATION_CODE_LENGTH);
    });

    /**
     * A generated code is what makes the route's rate limiter a volume control rather than
     * the only thing between a stranger and an account — so it must never emit a character
     * that normalisation would rewrite, or the stored form would differ from what the person
     * types back and the invitation would be unusable.
     */
    it("only emits characters that survive normalisation unchanged", () => {
        for (let attempt = 0; attempt < 200; attempt += 1) {
            const code = generateInvitationCode();
            expect(normalizeInvitationCode(code)).toBe(code);
        }
    });

    it("maps bytes through the alphabet", () => {
        // 0 → "0", 1 → "1", 32 wraps to "0", 33 to "1".
        expect(generateInvitationCode(bytes([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]))).toBe("0123456789");
        expect(generateInvitationCode(bytes([32, 33, 34, 35, 36, 37, 38, 39, 40, 41]))).toBe(
            "0123456789"
        );
    });

    it("does not repeat itself", () => {
        const seen = new Set(Array.from({ length: 500 }, () => generateInvitationCode()));

        expect(seen.size).toBe(500);
    });

    /** Fifty bits is the claim the security reasoning rests on; this is it stated as a test. */
    it("draws from a 32-symbol alphabet at every position", () => {
        const perPosition = Array.from({ length: INVITATION_CODE_LENGTH }, () => new Set<string>());

        for (let attempt = 0; attempt < 4_000; attempt += 1) {
            for (const [index, character] of [...generateInvitationCode()].entries()) {
                perPosition[index].add(character);
            }
        }

        for (const observed of perPosition) {
            expect(observed.size).toBe(32);
        }
    });
});

describe("generateReadablePassword", () => {
    it("is twelve characters of the same unambiguous alphabet", () => {
        const password = generateReadablePassword();

        expect(password).toHaveLength(12);
        expect(password).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/);
    });

    /**
     * Longer than an invitation code on purpose: an invitation is bounded by its uses and its
     * expiry, and a temporary password stands until somebody changes it — which some people
     * never do.
     */
    it("is longer than an invitation code", () => {
        expect(generateReadablePassword().length).toBeGreaterThan(INVITATION_CODE_LENGTH);
    });

    it("does not repeat itself", () => {
        const seen = new Set(Array.from({ length: 500 }, () => generateReadablePassword()));

        expect(seen.size).toBe(500);
    });

    /**
     * It shares the alphabet with invitation codes because it has the same job: being read
     * aloud. Nothing normalises it on the way back, so every character has to be one nobody
     * mishears in the first place.
     */
    it("emits nothing that normalisation would have had to rewrite", () => {
        for (let attempt = 0; attempt < 200; attempt += 1) {
            const password = generateReadablePassword();

            expect(normalizeInvitationCode(password)).toBe(password);
        }
    });
});
