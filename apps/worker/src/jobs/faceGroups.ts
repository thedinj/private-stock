import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
    FACE_GROUPS_REL_PATH,
    decodeFaceGroups,
    encodeFaceGroups,
    groupCohesion,
    peopleInItem,
    placePerson,
    type FaceGroupsFile,
} from "@private-stock/core";
import { db, faceRepo } from "@private-stock/db";

import { writeInPlace } from "../embed/pictures.js";
import { breathe } from "../eventLoop.js";
import { enqueue } from "../queue.js";
import { enqueueFaceAnchors } from "./faceAnchors.js";
import { dataFile, readFaceVectors } from "./faceVectorFiles.js";
import { enqueueTagPictures } from "./tagPictures.js";

/**
 * The `faceGroups` job: the faces of one person, gathered across the library (§5f "Grouping").
 *
 * One job for the library, coalescing, as `dupes` is (§10b): a group is a property of the whole
 * set, and two runs at once would build groups from each other's half-written rows. Incremental:
 * the groups' sums are kept in `faces/groups.bin` between runs, with how far the last run got, so
 * a run reads only the items whose faces arrived since. Lost or unreadable, that file is rebuilt
 * from every face — a first-pass's worth of reading, once.
 *
 * Each item's faces are gathered into people first (`peopleInItem`), and then each person is
 * placed among the library's groups (`placePerson`). A person seen only once in a video — one
 * face, one moment — is in no group: a passer-by, or a face the detector half-found, and a group
 * of one is a row nobody wants in the review.
 */

/** Long enough for an import's burst of faces jobs to arrive; short enough to see them soon. */
const FACE_GROUPS_SETTLE_MS = 10 * 60 * 1000;

/** Items read per statement; the run continues until there are none left. */
const BATCH = 200;

/** Queue a grouping run, once, after the burst of faces jobs it belongs to has settled. */
export const enqueueFaceGroups = (): void => {
    enqueue(db, {
        kind: "faceGroups",
        priority: 200,
        availableAt: new Date(Date.now() + FACE_GROUPS_SETTLE_MS),
    });
};

const loadState = async (): Promise<FaceGroupsFile | null> => {
    try {
        return decodeFaceGroups(new Uint8Array(await readFile(dataFile(FACE_GROUPS_REL_PATH))));
    } catch {
        return null;
    }
};

export const runFaceGroups = async (): Promise<void> => {
    let state = await loadState();

    if (state === null) {
        // From scratch: every face is grouped again, so no group from before may survive.
        faceRepo.clearGroups();
        state = { cursor: 0, dims: 512, groups: new Map() };
    }

    // Groups somebody said are no one person (§5f "Grab bags"): their faces have left them, and
    // their sums go too, or the averaged-out centre would draw in the next obscured face.
    const dissolved = faceRepo.dissolvedGroups();

    for (const groupId of dissolved) state.groups.delete(groupId);

    let since = Date.now();
    let grouped = 0;

    for (;;) {
        const items = faceRepo.itemsToGroup(state.cursor, BATCH);

        if (items.length === 0) break;

        const assigned: { id: string; groupId: string | null }[] = [];
        // Where a merged group went, so a face placed earlier in this batch follows its group.
        const redirect = new Map<string, string>();
        const resolve = (id: string): string => {
            let at = id;

            while (redirect.has(at)) at = redirect.get(at)!;

            return at;
        };

        for (const item of items) {
            const faces = faceRepo.facesToGroup(item.mediaId);
            const vectors = await readFaceVectors(item.mediaId);

            state.cursor = Math.max(state.cursor, item.last);

            // The file and the rows disagree — a re-run under way, or a file the sweep has yet
            // to repair. The next run of the stage gives the item new rows, and new rows bring
            // it back here.
            if (vectors === null || faces.some((face) => face.vectorIndex >= vectors.length)) {
                continue;
            }

            for (const person of peopleInItem(faces.map((face) => vectors[face.vectorIndex]))) {
                const members = person.members.map((index) => faces[index].id);

                if (item.kind === "video" && members.length < 2) {
                    assigned.push(...members.map((id) => ({ id, groupId: null })));
                    continue;
                }

                const { groupId, merged } = placePerson(person, state.groups, randomUUID);

                for (const from of merged) redirect.set(from, groupId);

                assigned.push(...members.map((id) => ({ id, groupId })));
            }

            grouped += 1;
            since = await breathe(since);
        }

        faceRepo.applyGroups(
            assigned.map(({ id, groupId }) => ({
                id,
                groupId: groupId === null ? null : resolve(groupId),
            })),
            [...redirect.keys()].map((from) => ({ from, to: resolve(from) }))
        );

        // With each batch, not once at the end: a run that dies between the two used to leave
        // the rows holding merges and new groups the file had never heard of, and the next run
        // split new faces off into groups beside them.
        await writeInPlace(dataFile(FACE_GROUPS_REL_PATH), encodeFaceGroups(state));
    }

    if (grouped > 0) {
        console.log(
            `Grouped the faces of ${grouped} item(s); ${state.groups.size} group(s) in all`
        );
        // New faces, some carrying a confirmation over from a re-run of the stage: a performer's
        // best face, and so their picture, may have changed (§6 "A tag's picture").
        enqueueTagPictures();
    }

    if (grouped > 0 || dissolved.length > 0 || !faceRepo.hasGroupStats()) {
        if (dissolved.length > 0) {
            await writeInPlace(dataFile(FACE_GROUPS_REL_PATH), encodeFaceGroups(state));
            faceRepo.forgetDissolved(dissolved);
        }

        // How tightly each group holds together, so a loose one is marked and asked about last.
        faceRepo.replaceGroupStats(
            [...state.groups.values()].map((group) => ({
                groupId: group.id,
                cohesion: Math.round(groupCohesion(group) * 1000) / 1000,
            }))
        );
    }

    // New faces to score, and perhaps a performer's shared face to find.
    if (grouped > 0) {
        enqueueFaceAnchors();
    }
};
