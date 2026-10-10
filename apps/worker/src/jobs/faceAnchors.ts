import {
    ANCHOR_MIN_ITEMS,
    AUTO_TAG_LINE,
    AUTO_TAG_MARGIN,
    AUTO_TAG_RULE,
    AUTO_TAG_TRIAL,
    SETTING_KEYS,
    autoTagBraked,
    autoTagTrusted,
    autoTags,
    faceAutoTagSettingSchema,
    FACE_ANCHORS_REL_PATH,
    SAME_FACE_ACROSS_ITEMS,
    appearancesInItem,
    bestMatch,
    gatherNewPeople,
    NEW_PERSON_EYES,
    NEW_PERSON_SCORE,
    NEW_PERSON_UNMATCHED,
    encodeFaceAnchors,
    performerCentre,
    sharedFace,
    vectorSimilarity,
    type FaceAnchor,
} from "@private-stock/core";
import { randomUUID } from "node:crypto";

import {
    appearanceRepo,
    changeLogRepo,
    db,
    faceAutoTagRepo,
    faceDecisionRepo,
    faceRepo,
    searchRepo,
    settingRepo,
    tagBatchRepo,
    tagRepo,
    type AppearanceSourceFace,
    type NewAppearance,
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
 * Library-wide and coalescing. Runs once a burst of faces jobs has settled, and a couple of
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
 * Tag what the rule proposes, if an administrator has let faces tag by themselves, what people
 * took back has not braked it, and enough of this rule's own proposals were checked right — with
 * none wrong — in "Would tag" (§5f "Tagging by itself"). One batch per performer, in the undo list
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

    // A rule earns tagging by itself: enough of its own proposals checked right, none wrong.
    const trial = faceAutoTagRepo.trial(AUTO_TAG_RULE);

    if (!autoTagTrusted(trial)) {
        console.log(
            `Faces are proposing, not tagging: ${trial.right} of ${AUTO_TAG_TRIAL} checked right, ` +
                `${trial.wrong} wrong`
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

    // Every face against every reference; and every item's people, scored the same way
    // (§5f "A person in a video") — one pass, so each faces file is read once.
    const matches: { faceId: string; tagId: string; score: number; second: number }[] = [];
    const appearances: NewAppearance[] = [];
    // Who might be a new person (§5f "New people"): beside `appearances`, by index.
    const strangers: { index: number; centre: Float32Array; mediaId: string }[] = [];
    const round = (value: number): number => Math.round(value * 1000) / 1000;

    const scoreItem = (
        faces: readonly AppearanceSourceFace[],
        vectors: Float32Array[] | null
    ): void => {
        const readable = faces.flatMap((face) => {
            const vector = vectors?.[face.vectorIndex];

            return vector ? [{ face, vector }] : [];
        });

        for (const { face, vector } of readable) {
            const match = anchors.length > 0 ? bestMatch(vector, anchors) : null;

            if (match && match.score >= KEEP_MATCH) {
                matches.push({
                    faceId: face.id,
                    tagId: match.tagId,
                    score: round(match.score),
                    second: round(match.second),
                });
            }
        }

        const people = readable.filter(({ face }) => face.scattered === 0);

        if (people.length === 0) return;

        for (const person of appearancesInItem(
            people.map(({ face, vector }) => ({ vector, eyes: face.eyes, score: face.score })),
            people[0].face.kind
        )) {
            const match = anchors.length > 0 ? bestMatch(person.centre, anchors) : null;
            const best = people[person.best].face;

            if (
                (!match || match.score < NEW_PERSON_UNMATCHED) &&
                best.eyes >= NEW_PERSON_EYES &&
                best.score >= NEW_PERSON_SCORE &&
                person.members.every((index) => people[index].face.decided === 0)
            ) {
                strangers.push({
                    index: appearances.length,
                    centre: person.centre,
                    mediaId: best.mediaId,
                });
            }

            appearances.push({
                id: randomUUID(),
                mediaId: people[0].face.mediaId,
                faceIds: person.members.map((index) => people[index].face.id),
                bestFaceId: people[person.best].face.id,
                legible: person.legible,
                matchTagId: match?.tagId ?? null,
                score: match ? round(match.score) : null,
                second: match ? round(match.second) : null,
                newPersonId: null,
            });
        }
    };

    let item: AppearanceSourceFace[] = [];

    for (const face of [...appearanceRepo.sourceFaces(), null]) {
        if (item.length > 0 && (face === null || face.mediaId !== item[0].mediaId)) {
            scoreItem(item, await readFaceVectors(item[0].mediaId));
            item = [];
            since = await breathe(since);
        }

        if (face) item.push(face);
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
    // New people: those who match nobody, gathered; a gathering on too few items stays nobody's.
    const gatheringIds = new Map<number, string>();

    gatherNewPeople(strangers).forEach((gathering, i) => {
        if (gathering === null) return;
        if (!gatheringIds.has(gathering)) gatheringIds.set(gathering, randomUUID());
        appearances[strangers[i].index].newPersonId = gatheringIds.get(gathering)!;
    });

    appearanceRepo.replaceAll(appearances);

    // What the rule would tag now, for the "Would tag" list (§5f "Tagging by itself").
    const proposals = faceAutoTagRepo.candidates(AUTO_TAG_LINE, AUTO_TAG_MARGIN).filter((row) =>
        autoTags({
            kind: row.kind,
            moments: row.strongFaces,
            score: row.bestScore,
            anchorItems: row.anchorItems,
        })
    );

    faceAutoTagRepo.replaceProposals(proposals, AUTO_TAG_RULE);

    const applied = applyAutoTags(proposals);

    // A face an automatic tag rests on can be a performer's picture until they have a better one.
    if (applied > 0) {
        enqueueTagPictures();
    }

    console.log(
        `Face references: ${anchors.length} performer(s), ` +
            `${anchors.filter((a) => a.confirmedItems === 0).length} from their tags alone; ` +
            `${matches.length} face(s) matched; ${appearances.length} person(s) in items, ` +
            `${gatheringIds.size} new person(s); ` +
            `${proposals.length} item(s) the rule would tag` +
            (applied > 0 ? `, ${applied} tagged` : "")
    );
};
