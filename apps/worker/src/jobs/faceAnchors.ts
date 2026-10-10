import {
    ANCHOR_MIN_ITEMS,
    AUTO_TAG_LINE,
    AUTO_TAG_MARGIN,
    LOOKS_LIKE,
    SETTING_KEYS,
    autoTagBraked,
    autoTags,
    faceAutoTagSettingSchema,
    FACE_ANCHORS_REL_PATH,
    SAME_FACE_ACROSS_ITEMS,
    bestMatch,
    encodeFaceAnchors,
    performerCentre,
    sharedFace,
    vectorSimilarity,
    type FaceAnchor,
} from "@private-stock/core";
import {
    changeLogRepo,
    db,
    faceAutoTagRepo,
    faceDecisionRepo,
    faceRepo,
    searchRepo,
    settingRepo,
    tagBatchRepo,
    tagRepo,
} from "@private-stock/db";

import { writeInPlace } from "../embed/pictures.js";
import { enqueueTagPictures } from "./tagPictures.js";
import { breathe } from "../eventLoop.js";
import { enqueue } from "../queue.js";
import { dataFile, readFaceVectors } from "./faceVectorFiles.js";

/**
 * The `faceAnchors` job: one face, one score (§5f).
 *
 * Every library performer's reference, built from the faces a person confirmed as them and the
 * face their tagged items share — scenes with others included — weighing each item once; then
 * every face in the library scored against every reference, its best match and the next best
 * kept. One question, "is this face them", asked one way: the review's order and default ticks,
 * "looks like them", "Likely" and, later, tagging by itself all read these.
 *
 * Library-wide and coalescing, as `faceGroups` is. Runs after a grouping run, and a couple of
 * minutes after confirmations change. A few tens of seconds at a few thousand items, most of it
 * the shared-face search, which is the square of a performer's faces — hence `ITEMS_PER_TAG`.
 */

/** Items per performer the shared face is looked for in, newest first. */
const ITEMS_PER_TAG = 60;

/** Below this a best match is not kept: nothing reads a match that weak. */
const KEEP_MATCH = 0.3;

/** Queue a run, once. */
export const enqueueFaceAnchors = (delayMs = 0): void => {
    enqueue(db, {
        kind: "faceAnchors",
        priority: 200,
        availableAt: new Date(Date.now() + delayMs),
    });
};

/** A run's small cache of faces files: performers share items, and a file is a few KB. */
const fileCache = () => {
    const files = new Map<string, Float32Array[] | null>();

    return async (mediaId: string): Promise<Float32Array[] | null> => {
        if (!files.has(mediaId)) {
            if (files.size >= 256) files.delete(files.keys().next().value!);
            files.set(mediaId, await readFaceVectors(mediaId));
        }

        return files.get(mediaId)!;
    };
};

const byTag = <T extends { tagId: string }>(rows: readonly T[]): Map<string, T[]> => {
    const out = new Map<string, T[]>();

    for (const row of rows) {
        const list = out.get(row.tagId) ?? [];
        list.push(row);
        out.set(row.tagId, list);
    }

    return out;
};

/**
 * Tag what the rule proposes, if an administrator has let faces tag by themselves and what people
 * took back has not braked it (§5f "Tagging by itself"). One batch per performer, in the undo list
 * of whoever turned it on, written as `source = 'ai'` — which nothing that proposes or builds a
 * reference reads back. Returns the items tagged.
 */
const applyAutoTags = (proposals: readonly { mediaId: string; tagId: string }[]): number => {
    const setting = faceAutoTagSettingSchema.safeParse(
        settingRepo.get(SETTING_KEYS.faceAutoTag, {})
    );

    if (!setting.success || !setting.data.enabled || !setting.data.byUserId) {
        return 0;
    }

    if (autoTagBraked(faceAutoTagRepo.counts())) {
        console.log(
            "Faces are not tagging by themselves: too much of what they tagged was taken back"
        );
        return 0;
    }

    const byUserId = setting.data.byUserId;
    let tagged = 0;

    for (const [tagId, rows] of byTag(proposals)) {
        const tag = tagRepo.findById(tagId);

        if (!tag) continue;

        const mediaIds = rows.map((row) => row.mediaId);

        // The app's own decision, listed in History and undone there with "Wrong".
        faceDecisionRepo.record(
            { actor: "app", userId: byUserId, verdict: "is", tagId, surface: "auto" },
            () => {
                tagged += tagBatchRepo.applyAssignments({
                    userId: byUserId,
                    scope: null,
                    summary: `${tag.name} on ${mediaIds.length} ${mediaIds.length === 1 ? "item" : "items"}, tagged from their face`,
                    assignments: mediaIds.map((mediaId) => ({ mediaId, tagId })),
                    source: "ai",
                }).assigned;

                for (const mediaId of mediaIds)
                    faceAutoTagRepo.decide(mediaId, tagId, "applied", null);

                // Tags are in the search document, and an open grid is told the way an edit tells it.
                searchRepo.requestReindex(mediaIds);
                changeLogRepo.recordMany(
                    mediaIds.map((mediaId) => ({
                        entity: "media",
                        entityId: mediaId,
                        op: "update",
                        detail: "tags:faces",
                    }))
                );
            }
        );
    }

    return tagged;
};

export const runFaceAnchors = async (): Promise<void> => {
    const vectorsOf = fileCache();
    const confirmed = byTag(faceRepo.confirmedFaceRefs());
    const tagged = byTag(faceRepo.taggedFaceRefs(ITEMS_PER_TAG));
    const anchors: FaceAnchor[] = [];
    let since = Date.now();
    let dims = 512;

    for (const tagId of new Set([...confirmed.keys(), ...tagged.keys()])) {
        // Item → the vectors of theirs on it, from both sources, each face once.
        const items = new Map<string, Map<number, Float32Array>>();
        const confirmedItems = new Set<string>();
        const sharedItems = new Set<string>();
        const add = (mediaId: string, index: number, vector: Float32Array): void => {
            const faces = items.get(mediaId) ?? new Map<number, Float32Array>();
            faces.set(index, vector);
            items.set(mediaId, faces);
        };

        for (const row of confirmed.get(tagId) ?? []) {
            const vector = (await vectorsOf(row.mediaId))?.[row.vectorIndex];

            if (vector) {
                add(row.mediaId, row.vectorIndex, vector);
                confirmedItems.add(row.mediaId);
                dims = vector.length;
            }
        }

        const candidates: { mediaId: string; index: number; vector: Float32Array }[] = [];

        for (const row of tagged.get(tagId) ?? []) {
            const vector = (await vectorsOf(row.mediaId))?.[row.vectorIndex];

            if (vector) candidates.push({ mediaId: row.mediaId, index: row.vectorIndex, vector });
        }

        const shared = sharedFace(candidates);

        if (shared) {
            const members = shared.members.map((i) => candidates[i]);
            const fromTags = performerCentre([members.map((m) => m.vector)]);
            const fromPeople = performerCentre(
                [...items.values()].map((faces) => [...faces.values()])
            );

            // Where a person has said who they are, a tags' face that is somebody else — the
            // partner they are always tagged with — is not theirs.
            if (
                fromTags &&
                (!fromPeople || vectorSimilarity(fromTags, fromPeople) >= SAME_FACE_ACROSS_ITEMS)
            ) {
                for (const member of members) {
                    add(member.mediaId, member.index, member.vector);
                    sharedItems.add(member.mediaId);
                }
            }
        }

        if (items.size >= ANCHOR_MIN_ITEMS) {
            const centre = performerCentre([...items.values()].map((faces) => [...faces.values()]));

            if (centre) {
                anchors.push({
                    tagId,
                    items: items.size,
                    confirmedItems: confirmedItems.size,
                    sharedItems: sharedItems.size,
                    centre,
                });
            }
        }

        since = await breathe(since);
    }

    // Every face against every reference.
    const matches: { faceId: string; tagId: string; score: number; second: number }[] = [];

    if (anchors.length > 0) {
        let current: string | null = null;
        let vectors: Float32Array[] | null = null;

        for (const face of faceRepo.everyFaceRef()) {
            if (face.mediaId !== current) {
                current = face.mediaId;
                vectors = await readFaceVectors(face.mediaId);
                since = await breathe(since);
            }

            const vector = vectors?.[face.vectorIndex];
            const match = vector ? bestMatch(vector, anchors) : null;

            if (match && match.score >= KEEP_MATCH) {
                matches.push({
                    faceId: face.id,
                    tagId: match.tagId,
                    score: Math.round(match.score * 1000) / 1000,
                    second: Math.round(match.second * 1000) / 1000,
                });
            }
        }
    }

    await writeInPlace(dataFile(FACE_ANCHORS_REL_PATH), encodeFaceAnchors(dims, anchors));
    faceRepo.replaceAnchors(
        anchors.map(({ tagId, items, confirmedItems, sharedItems }) => ({
            tagId,
            items,
            confirmedItems,
            sharedItems,
        })),
        matches
    );

    // What the rule would tag now, for the "Would tag" list (§5f "Tagging by itself").
    const proposals = faceAutoTagRepo
        .candidates(LOOKS_LIKE, AUTO_TAG_LINE, AUTO_TAG_MARGIN)
        .filter((row) =>
            autoTags({
                strongFaces: row.strongFaces,
                bestScore: row.bestScore,
                named: row.named === 1,
                anchorItems: row.anchorItems,
            })
        );

    faceAutoTagRepo.replaceProposals(proposals);

    const applied = applyAutoTags(proposals);

    // A face an automatic tag rests on can be a performer's picture until they have a better one.
    if (applied > 0) {
        enqueueTagPictures();
    }

    console.log(
        `Face references: ${anchors.length} performer(s), ` +
            `${anchors.filter((a) => a.confirmedItems === 0).length} from their tags alone; ` +
            `${matches.length} face(s) matched; ${proposals.length} item(s) the rule would tag` +
            (applied > 0 ? `, ${applied} tagged` : "")
    );
};
