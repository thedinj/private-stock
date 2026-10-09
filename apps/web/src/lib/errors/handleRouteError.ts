import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";
import { ZodError } from "zod";

import {
    AuthenticationError,
    AuthorizationError,
    ConflictError,
    NotFoundError,
    PathSafetyError,
    RateLimitError,
    ReadOnlyRootError,
    ValidationError,
} from "@private-stock/core";
import { errorLogRepo, isBusyError } from "@private-stock/db";

/**
 * The single exit point for a failed request.
 *
 * Every route's `catch` calls this instead of hand-rolling a `NextResponse.json({...})`, so
 * status codes stay consistent, nothing leaks a stack trace to the client, and every failure
 * is recorded with an id the user can quote back.
 */

const STATUS_BY_ERROR: [new (...args: never[]) => Error, number][] = [
    [AuthenticationError, 401],
    [AuthorizationError, 403],
    [NotFoundError, 404],
    [ConflictError, 409],
    [ValidationError, 400],
    [PathSafetyError, 400],
    [ReadOnlyRootError, 409],
    [RateLimitError, 429],
];

interface ErrorContext {
    userId?: string | null;
}

export const toErrorResponse = (
    error: unknown,
    request: Request,
    context: ErrorContext = {}
): NextResponse => {
    const requestId = randomUUID().slice(0, 8);

    if (error instanceof ZodError) {
        // Field-level issues are safe to return and are the difference between "invalid
        // request" and a form that can highlight the offending input.
        return NextResponse.json(
            {
                code: "VALIDATION_FAILED",
                message: "Request failed validation",
                issues: error.issues.map((issue) => ({
                    path: issue.path.join("."),
                    message: issue.message,
                })),
                requestId,
            },
            { status: 400 }
        );
    }

    /**
     * Contention is not a failure of this request, and must not be recorded as one.
     *
     * `SQLITE_BUSY` means the write never got the lock — the worker was mid-stream of its own
     * writes and SQLite has no fairness (§20). Two things follow. It is a 503 with a
     * `Retry-After`, not a 500: nothing is broken, and the caller should come back. And it is
     * **not** written to the error log, because that log is a table in the database that is
     * currently contended — the one failure whose logging is guaranteed to wait for the same
     * lock that just refused, doubling the stall it is reporting.
     */
    if (isBusyError(error)) {
        console.warn(`[${requestId}] DATABASE_BUSY: ${new URL(request.url).pathname}`);

        return NextResponse.json(
            {
                code: "DATABASE_BUSY",
                message: "The library is busy writing. Try again in a moment.",
                requestId,
            },
            { status: 503, headers: { "Retry-After": "2" } }
        );
    }

    const match = STATUS_BY_ERROR.find(([type]) => error instanceof type);
    const status = match?.[1] ?? 500;
    const code = (error as { code?: string }).code ?? "INTERNAL_ERROR";
    const message = error instanceof Error ? error.message : String(error);

    // 4xx are the caller's problem and would drown the log; 5xx are ours and get recorded.
    if (status >= 500) {
        try {
            errorLogRepo.logError({
                requestId,
                userId: context.userId,
                code,
                message,
                stack: error instanceof Error ? (error.stack ?? null) : null,
                path: new URL(request.url).pathname,
                method: request.method,
            });
        } catch (loggingError) {
            // The database may be exactly what is broken. Never let logging mask the
            // original failure.
            console.error("Failed to record error", loggingError);
        }

        console.error(`[${requestId}] ${code}: ${message}`, error);

        return NextResponse.json(
            {
                code: "INTERNAL_ERROR",
                // Deliberately generic: internal messages can name paths and table columns.
                message: "Something went wrong. Quote this id if you report it.",
                requestId,
            },
            { status: 500 }
        );
    }

    // The only 4xx that carries a header. Without `Retry-After` a client has nothing to wait
    // on but a guess, and the guess is usually "immediately".
    const headers =
        error instanceof RateLimitError
            ? { "Retry-After": String(error.retryAfterSeconds) }
            : undefined;

    return NextResponse.json({ code, message, requestId }, { status, headers });
};
