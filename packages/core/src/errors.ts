/**
 * Typed error classes.
 *
 * Services and repos throw these instead of `new Error("...")`, so the route handler's
 * `toErrorResponse()` can map each one to the right HTTP status without string matching.
 * Mirrors basket-bot's `@basket-bot/core` errors.
 */

export abstract class AppError extends Error {
    abstract readonly code: string;

    constructor(message: string) {
        super(message);
        this.name = new.target.name;
    }
}

/** No credentials, or credentials that did not verify. → 401 */
export class AuthenticationError extends AppError {
    readonly code = "AUTHENTICATION_REQUIRED";
}

/** Authenticated, but not permitted. → 403 */
export class AuthorizationError extends AppError {
    readonly code = "FORBIDDEN";
}

/** The addressed thing does not exist, or is not visible to this user. → 404 */
export class NotFoundError extends AppError {
    readonly code = "NOT_FOUND";
}

/** The request contradicts current state (duplicate name, already running scan). → 409 */
export class ConflictError extends AppError {
    readonly code = "CONFLICT";
}

/** Input failed validation. → 400 */
export class ValidationError extends AppError {
    readonly code = "VALIDATION_FAILED";

    constructor(
        message: string,
        readonly issues?: unknown
    ) {
        super(message);
    }
}

/**
 * A path escaped its media root, or pointed somewhere the app must never read.
 *
 * Separate from AuthorizationError because it is always a bug or an attack, never a
 * legitimate permission boundary, and should be logged loudly. → 400
 */
export class PathSafetyError extends AppError {
    readonly code = "PATH_NOT_ALLOWED";
}

/**
 * Too many attempts from one caller. → 429
 *
 * Carries the wait rather than leaving the route to invent one, because the number the
 * limiter used to refuse is the only number that is actually true.
 */
export class RateLimitError extends AppError {
    readonly code = "RATE_LIMITED";

    constructor(
        message: string,
        readonly retryAfterSeconds: number
    ) {
        super(message);
    }
}

/** A media root is mounted read-only and the operation would write to it. → 409 */
export class ReadOnlyRootError extends AppError {
    readonly code = "ROOT_READ_ONLY";
}
