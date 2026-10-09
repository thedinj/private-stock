import { z } from "zod";

import { scopeSchema } from "../domain.js";
import { INVITATION_CODE_LENGTH, normalizeInvitationCode } from "../invitationCode.js";

/**
 * Auth contracts, shared by the route handlers and the client.
 *
 * Accounts are identified by email address. Lower-cased and trimmed on the way in, because
 * nobody reliably reproduces the capitalisation they registered with and a login that fails
 * over a capital letter reads as a forgotten password.
 */

export const emailSchema = z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(255)
    .email("Enter a valid email address");

/**
 * Six characters minimum, no composition rules.
 *
 * Six is deliberate and deliberately low. Character-class requirements mostly produce
 * `Password1!`, and a minimum long enough to argue about is a minimum people work around with
 * a sticky note — this is a household library, and the controls that actually resist guessing
 * are elsewhere: bcrypt at cost 12, the per-account throttle, and the jail in front (§12).
 *
 * The ceiling is bcrypt's, which silently truncates past 72 *bytes*. This counts characters,
 * which is the same thing only for ASCII, so it is the form's early answer rather than the
 * guard: `hashPassword` checks the byte length, and refuses rather than storing a password
 * whose tail would be ignored.
 */
export const passwordSchema = z
    .string()
    .min(6, "Use at least 6 characters")
    .max(72, "Passwords are limited to 72 characters");

export const loginRequestSchema = z.object({
    email: emailSchema,
    password: z.string().min(1, "Enter your password").max(72),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const sessionUserSchema = z.object({
    id: z.string(),
    email: z.string(),
    displayName: z.string(),
    scopes: z.array(scopeSchema),
});
export type SessionUser = z.infer<typeof sessionUserSchema>;

export const loginResponseSchema = z.object({
    accessToken: z.string(),
    expiresInSeconds: z.number(),
    user: sessionUserSchema,
});
export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const setupRequestSchema = z.object({
    email: emailSchema,
    displayName: z.string().trim().min(1, "Enter a display name").max(100),
    password: passwordSchema,
    /** Required unless the request comes from a private-range address. See §12c. */
    setupToken: z.string().optional(),
});
export type SetupRequest = z.infer<typeof setupRequestSchema>;

/**
 * An invitation code as it arrives from a form (§12c).
 *
 * Normalised here rather than in the service, so that every caller -- route handler, test,
 * future client -- compares the same canonical string, and the length check happens on the
 * form that will actually be looked up. A wrong-length code is rejected without a query,
 * which matters on a route whose whole job is answering people who do not have one.
 */
export const invitationCodeSchema = z
    .string()
    .transform(normalizeInvitationCode)
    .refine((code) => code.length === INVITATION_CODE_LENGTH, {
        message: "That code does not look right",
    });

/**
 * Creating an account (§12c).
 *
 * There is no open registration and no setting that turns one on: without a live invitation
 * this route produces nothing. The code is therefore required rather than optional, which is
 * the difference between this and the sibling app it is modelled on -- there the requirement
 * was enforced in the service regardless of a setting that claimed to relax it, so the
 * setting was decoration over a gate that never opened.
 */
export const registerRequestSchema = z.object({
    invitationCode: invitationCodeSchema,
    email: emailSchema,
    displayName: z.string().trim().min(1, "Enter a display name").max(100),
    password: passwordSchema,
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

/**
 * What an invitation grants and how much of it is left, as the admin screen reads it.
 *
 * `useCount` is derived from the accounts naming the invitation rather than stored, so it can
 * go down when an account is deleted -- see `invitationRepo`.
 */
export const invitationSchema = z.object({
    id: z.string(),
    /** Canonical, ungrouped. The UI groups it for reading aloud. */
    code: z.string(),
    label: z.string().nullable(),
    scopes: z.array(scopeSchema),
    /** Null means unlimited. */
    maxUses: z.number().int().positive().nullable(),
    expiresAt: z.string().nullable(),
    revokedAt: z.string().nullable(),
    createdByName: z.string().nullable(),
    createdAt: z.string(),
    useCount: z.number().int().nonnegative(),
    /**
     * Whether it would be accepted right now.
     *
     * Computed on the server rather than in the browser, because "expired" depends on a clock
     * and the browser's is not the one that decides. A client working it out from `expiresAt`
     * would disagree with the server for anybody whose device clock is wrong -- and would show
     * an invitation as live that registration then refuses, with no explanation available.
     */
    usable: z.boolean(),
});
export type Invitation = z.infer<typeof invitationSchema>;

export const createInvitationSchema = z.object({
    label: z.string().trim().min(1).max(80).nullish(),
    scopes: z.array(scopeSchema).max(2).default([]),
    maxUses: z.number().int().positive().max(1000).nullish(),
    /** Days from now, rather than a date: the server owns the clock. Null never expires. */
    expiresInDays: z.number().int().positive().max(3650).nullish(),
});
export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;

/** An account, as the admin screen reads it. Never carries the password hash. */
export const managedUserSchema = z.object({
    id: z.string(),
    email: z.string(),
    displayName: z.string(),
    scopes: z.array(scopeSchema),
    disabled: z.boolean(),
    createdAt: z.string(),
    /** How they got in: the invitation's label, or its code when it had no label. */
    invitedAs: z.string().nullable(),
    /** True for the account reading the list, which may not disable or delete itself. */
    isSelf: z.boolean(),
});
export type ManagedUser = z.infer<typeof managedUserSchema>;

export const updateUserSchema = z.object({
    scopes: z.array(scopeSchema).max(2).optional(),
    disabled: z.boolean().optional(),
    /** The name shown everywhere. Changing it renames nothing the person owns. */
    displayName: z.string().trim().min(1, "Enter a display name").max(100).optional(),
    /**
     * The address the account signs in with.
     *
     * Worth being clear about, because the field is labelled "email" and does nothing an
     * email address normally does: nothing is ever sent to it. It is a username that happens
     * to look like an address, which is also why a typo in one locks somebody out until an
     * administrator fixes it here.
     */
    email: emailSchema.optional(),
});
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

/**
 * Editing your own account from `/account` (§12c).
 *
 * Anybody may change their own display name. The sign-in address is an administrator's to
 * change — on any account, their own included — and the service refuses `email` from anybody
 * else rather than ignoring it. Strict, so a field this shape does not know about is an error
 * too: a request that tried to set something here and was silently told "saved" would be the
 * worst answer.
 */
export const updateProfileSchema = z
    .object({
        displayName: z.string().trim().min(1, "Enter a display name").max(100).optional(),
        email: emailSchema.optional(),
    })
    .strict();
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

/**
 * An administrator setting somebody else's password (§12c).
 *
 * `adminPassword` is the caller re-proving who they are, and it is the point of the shape.
 * Without it, a stolen access token — fifteen minutes of ambient authority — is enough to
 * take permanent ownership of every other account in the library, because setting a password
 * is the one action whose effect outlives the session that performed it. `/api/auth/password`
 * already demands the current password for exactly this reason, and this is the same rule
 * applied to doing it on somebody else's behalf.
 *
 * It also means the administrator has to *be* the administrator, rather than merely be sitting
 * at their unlocked desk.
 */
export const setUserPasswordSchema = z.object({
    password: passwordSchema,
    /** The caller's own password, not the target's. */
    adminPassword: z.string().min(1, "Enter your own password").max(72),
});
export type SetUserPasswordInput = z.infer<typeof setUserPasswordSchema>;

export const setupStatusSchema = z.object({
    needsSetup: z.boolean(),
    /** False when the caller must supply the token printed to the container log. */
    isLocalRequest: z.boolean(),
});
export type SetupStatus = z.infer<typeof setupStatusSchema>;

/** JWT payload. Kept minimal — anything that can go stale is looked up per request. */
export const accessTokenClaimsSchema = z.object({
    sub: z.string(),
    scopes: z.array(scopeSchema),
});
export type AccessTokenClaims = z.infer<typeof accessTokenClaimsSchema>;

/**
 * A signed media token (§12d).
 *
 * Separate from the access token because it answers a different question: not "who is this
 * and what may they do", but "may this one request, for this one item, proceed". `purpose`
 * keeps the two from ever being mistaken for each other even if their claim sets converge
 * later — a media token must never authenticate an API call, and an access token must never
 * be replayable as a URL.
 *
 * No `scopes`. A media token reads bytes; every scoped action goes through the ordinary
 * header-authenticated path, so there is nothing for it to carry.
 */
export const mediaTokenClaimsSchema = z.object({
    sub: z.string(),
    /** The single item these bytes belong to. A token for one file is useless for another. */
    mediaId: z.string(),
    /**
     * The account's `tokenEpoch` when this was minted.
     *
     * Compared against the user row on every request, so changing a password invalidates
     * every outstanding media token immediately. Stateless revocation: nothing is stored, so
     * nothing can be missed or go stale. This is the one piece of authorization state the
     * token carries, and it carries it only to be checked for equality — never to be trusted.
     */
    epoch: z.number().int(),
    purpose: z.literal("media"),
});
export type MediaTokenClaims = z.infer<typeof mediaTokenClaimsSchema>;

/** What `POST /api/media/:id/token` hands back. */
export const mediaTokenSchema = z.object({
    token: z.string(),
    /**
     * Where to fetch the bytes, relative to the app's own origin.
     *
     * Relative on purpose. Building an absolute URL server-side would mean trusting `Host` or
     * `X-Forwarded-Host` to name an address the TV can reach, and behind a reverse proxy
     * those are whatever the proxy was configured to send. The browser knows the origin it
     * loaded from; the caller joins the two.
     */
    path: z.string(),
    expiresAt: z.string(),
});
export type MediaToken = z.infer<typeof mediaTokenSchema>;

/**
 * Changing your own password.
 *
 * The current password is required even though the request is already authenticated: it is
 * what stops a borrowed session from becoming a permanent one. Succeeding revokes every
 * refresh token and every signed media token the account had.
 */
export const changePasswordSchema = z.object({
    currentPassword: z.string().min(1),
    newPassword: passwordSchema,
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
