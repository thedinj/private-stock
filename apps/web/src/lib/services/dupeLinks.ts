import { readFileSync } from "node:fs";
import * as path from "node:path";

import {
    SETTING_KEYS,
    alignTilePrints,
    assertSafeRelativePath,
    compareVideos,
    decodeTilePrints,
    dupeSettingsSchema,
    durationsComparable,
    hammingDistance,
    prepareTilePrints,
    tilePrintRelPath,
    tilesMatch,
    type DupeSettings,
    type PreparedTilePrints,
} from "@private-stock/core";
import { loadConfig } from "@private-stock/core/server";
import { phashRepo, settingRepo } from "@private-stock/db";

/**
 * Which copies in a look-alike group match each other directly (§10i).
 *
 * A group is a chain of links (§10), so two of its copies may only be in it through a third. The
 * clustering pass knows which links it found and keeps none of them; asked again here, for the
 * copies of one group, it is a handful of comparisons over evidence already stored -- the frame
 * hashes in the database and each video's tile prints on `/data` -- with the same tests and the
 * same thresholds as the pass, so "matches" means here what it meant there.
 */

export interface LinkMember {
    id: string;
    kind: "image" | "video";
    durationMs: number | null;
}

const loadSettings = (): DupeSettings => {
    const parsed = dupeSettingsSchema.safeParse(settingRepo.get(SETTING_KEYS.dupes, {}));

    return parsed.success ? parsed.data : dupeSettingsSchema.parse({});
};

/** Whether two of these copies match on their own, without a third between them. */
export const directMatcher = (members: LinkMember[]): ((a: string, b: string) => boolean) => {
    const settings = loadSettings();
    const byId = new Map(members.map((member) => [member.id, member]));
    const { dataDir } = loadConfig();
    const prints = new Map<string, PreparedTilePrints | null>();
    const frames = new Map<string, ReturnType<typeof phashRepo.listVideoHashes>>();
    const known = new Map<string, boolean>();

    const printsOf = (mediaId: string): PreparedTilePrints | null => {
        if (!prints.has(mediaId)) {
            try {
                const bytes = readFileSync(
                    path.resolve(dataDir, assertSafeRelativePath(tilePrintRelPath(mediaId)))
                );

                prints.set(mediaId, prepareTilePrints(decodeTilePrints(new Uint8Array(bytes))));
            } catch {
                // Not printed yet: the hash alone decides.
                prints.set(mediaId, null);
            }
        }

        return prints.get(mediaId)!;
    };

    const framesOf = (mediaId: string) => {
        let rows = frames.get(mediaId);

        if (!rows) {
            rows = phashRepo.listVideoHashes(mediaId);
            frames.set(mediaId, rows);
        }

        return rows;
    };

    const compare = (a: LinkMember, b: LinkMember): boolean => {
        if (a.kind === "image" || b.kind === "image") {
            const [x, y] = [phashRepo.findImageHash(a.id), phashRepo.findImageHash(b.id)];

            return (
                x !== undefined &&
                y !== undefined &&
                hammingDistance(x, y) <= settings.imageDistance
            );
        }

        if (compareVideos(framesOf(a.id), framesOf(b.id), settings)) {
            return true;
        }

        if (!a.durationMs || !b.durationMs || !durationsComparable(a.durationMs, b.durationMs)) {
            return false;
        }

        const [mine, theirs] = [printsOf(a.id), printsOf(b.id)];

        return (
            mine !== null &&
            theirs !== null &&
            tilesMatch(alignTilePrints(mine, theirs), settings.minMatchingFrames)
        );
    };

    return (a, b) => {
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        let answer = known.get(key);

        if (answer === undefined) {
            const [x, y] = [byId.get(a), byId.get(b)];

            answer = x !== undefined && y !== undefined && x.kind === y.kind && compare(x, y);
            known.set(key, answer);
        }

        return answer;
    };
};
