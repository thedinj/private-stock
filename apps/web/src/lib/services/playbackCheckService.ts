import {
    AuthorizationError,
    describePlaybackKind,
    titleFromPath,
    type PlaybackCheck,
} from "@private-stock/core";
import { mediaRepo, type PlaybackBlockedRow } from "@private-stock/db";

import type { AuthContext } from "../auth/withAuth";

/**
 * The playback check's test set (§8).
 *
 * `assessPlayback` answers once for every device. This hands the admin's devices the files it
 * expects them to refuse, grouped by kind, so each device can be tried on them and the verdicts
 * that are wrong for the household's own phones and computers found -- before anything is built
 * to convert files that may already play.
 */

/** Enough to tell a fluke from a pattern, few enough that a phone runs the page in a minute. */
const SAMPLES_PER_KIND = 2;

const requireAdmin = (auth: AuthContext): void => {
    if (!auth.scopes.includes("admin")) {
        throw new AuthorizationError("Only an administrator can run the playback check");
    }
};

/**
 * Groups by kind, largest group first. Pure, so the grouping is tested without a database.
 * The rows arrive in id order, so the samples are the same on every device that asks.
 */
export const groupPlaybackCheck = (rows: PlaybackBlockedRow[]): PlaybackCheck => {
    const groups = new Map<string, PlaybackCheck["groups"][number]>();

    for (const row of rows) {
        const kind = describePlaybackKind({ ...row, kind: "video" });
        const group = groups.get(kind) ?? { kind, count: 0, samples: [] };

        group.count += 1;

        if (group.samples.length < SAMPLES_PER_KIND) {
            group.samples.push({
                id: row.id,
                title: row.title ?? titleFromPath(row.relPath),
                durationMs: row.durationMs,
                hasAudio: row.audioCodec !== null,
            });
        }

        groups.set(kind, group);
    }

    return {
        total: rows.length,
        groups: [...groups.values()].sort(
            (a, b) => b.count - a.count || a.kind.localeCompare(b.kind)
        ),
    };
};

export const getPlaybackCheck = (auth: AuthContext): PlaybackCheck => {
    requireAdmin(auth);

    return groupPlaybackCheck(mediaRepo.listPlaybackBlocked(auth.accessibleRootIds));
};
