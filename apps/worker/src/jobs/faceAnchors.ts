import {
    ANCHOR_MIN_ITEMS,
    AUTO_TAG_LINE,
    AUTO_TAG_MARGIN,
    AUTO_TAG_RULE,
    AUTO_TAG_TRIAL,
    EMBED_DIMS,
    SETTING_KEYS,
    autoTagBraked,
    autoTagTrusted,
    autoTags,
    faceAutoTagSettingSchema,
    FACE_ANCHORS_REL_PATH,
    SAME_FACE_ACROSS_ITEMS,
    appearancesInItem,
    gatherNewPeople,
    NEW_PERSON_EYES,
    NEW_PERSON_SCORE,
    NEW_PERSON_UNMATCHED,
    encodeFaceAnchors,
    performerCentre,
    sharedFace,
    vectorSimilarity,
    type FaceAnchor,
    type Quantized,
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
    type AnchorRow,
    type AppearanceScore,
    type AppearanceSourceFace,
    type NewAppearance,
} from "@private-stock/db";

import { writeInPlace } from "../embed/pictures.js";
import { enqueueTagPictures } from "./tagPictures.js";
import { breathe } from "../eventLoop.js";
import { enqueue } from "../queue.js";
import { dataFile, readStoredFaces, unitFace } from "./faceVectorFiles.js";

/**
 * The `faceAnchors` job: one face, one score (§5f).
 *
 * Every library performer's reference, built from the faces a person confirmed as them and the
 * face their tagged items share — scenes with others included — weighing each item once; every
 * item's people gathered from its faces and scored against every reference, their best match and
 * the next best kept; the people who match nobody gathered into new people; and what the rule
 * would tag. Suggestions, New people and Would tag all read what it writes.
 *
 * **Only what changed** (§5f "Only what changed"). The first run in a process does the whole
 * library and keeps its work: every item's stored face vectors, every reference, every person and
 * their two best matches, and what the tables hold. After that a run takes what the `FaceStale`
 * triggers recorded, rebuilds only those items' people and those performers' references, and
 * rescores everybody only against a reference that actually moved — exactly, because a person
 * whose best match and runner-up are both unmoved can only be overtaken by a reference that did.
 * Then it writes only rows that differ. Naming one person used to read every faces file and
 * rewrite every row in the library; now it is a few hundred milliseconds of arithmetic.
 *
 * Coalescing. Runs once a burst of faces jobs has settled, a minute or two after decisions, and
 * once at start-up, which is the run that does everything.
 */

/** Items per performer the shared face is looked for in, newest first. */
const ITEMS_PER_TAG = 60;

/** Queue a run, once. */
export const enqueueFaceAnchors = (delayMs = 0): void => {
    enqueue(db, {
        kind: "faceAnchors",
        priority: 200,
        availableAt: new Date(Date.now() + delayMs),
    });
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

/** One reference's inputs as the rows give them. */
type ConfirmedRef = ReturnType<typeof faceRepo.confirmedFaceRefs>[number];
type TaggedRef = ReturnType<typeof faceRepo.taggedFaceRefs>[number];

/**
 * A performer's reference from the faces people confirmed as them and the face their tagged
 * items share, each item weighed once; null below `ANCHOR_MIN_ITEMS` items. `vectorOf` is a face's
 * unit vector, or undefined where its file could not be read.
 */
const buildAnchor = (
    tagId: string,
    confirmed: readonly ConfirmedRef[],
    tagged: readonly TaggedRef[],
    vectorOf: (mediaId: string, index: number) => Float32Array | undefined
): FaceAnchor | null => {
    // Item → the vectors of theirs on it, from both sources, each face once.
    const items = new Map<string, Map<number, Float32Array>>();
    const confirmedItems = new Set<string>();
    const sharedItems = new Set<string>();
    const add = (mediaId: string, index: number, vector: Float32Array): void => {
        const faces = items.get(mediaId) ?? new Map<number, Float32Array>();
        faces.set(index, vector);
        items.set(mediaId, faces);
    };

    for (const row of confirmed) {
        const vector = vectorOf(row.mediaId, row.vectorIndex);

        if (vector) {
            add(row.mediaId, row.vectorIndex, vector);
            confirmedItems.add(row.mediaId);
        }
    }

    const candidates = tagged.flatMap((row) => {
        const vector = vectorOf(row.mediaId, row.vectorIndex);

        return vector ? [{ mediaId: row.mediaId, index: row.vectorIndex, vector }] : [];
    });
    const shared = sharedFace(candidates);

    if (shared) {
        const members = shared.members.map((i) => candidates[i]);
        const fromTags = performerCentre([members.map((m) => m.vector)]);
        const fromPeople = performerCentre([...items.values()].map((faces) => [...faces.values()]));

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

    if (items.size < ANCHOR_MIN_ITEMS) return null;

    const centre = performerCentre([...items.values()].map((faces) => [...faces.values()]));

    return centre
        ? {
              tagId,
              items: items.size,
              confirmedItems: confirmedItems.size,
              sharedItems: sharedItems.size,
              centre,
          }
        : null;
};

/** A person's best match among the references and the runner-up; -Infinity where there is none. */
interface Ranked {
    tagId: string | null;
    score: number;
    secondTagId: string | null;
    second: number;
}

const UNRANKED: Ranked = { tagId: null, score: -Infinity, secondTagId: null, second: -Infinity };

/**
 * Whether a score ranks above another. An exact tie goes to the lower tag id, so a ranking does
 * not depend on the order references were offered in — which a run that rebuilt a few of them
 * and a run that rebuilt all of them do not share.
 */
const above = (score: number, tagId: string, other: number, otherTagId: string | null): boolean =>
    score > other || (score === other && otherTagId !== null && tagId < otherTagId);

/** One reference's score offered to a ranking. */
const offer = (ranked: Ranked, tagId: string, score: number): Ranked =>
    above(score, tagId, ranked.score, ranked.tagId)
        ? { tagId, score, secondTagId: ranked.tagId, second: ranked.score }
        : above(score, tagId, ranked.second, ranked.secondTagId)
          ? { ...ranked, secondTagId: tagId, second: score }
          : ranked;

const rankAll = (centre: Float32Array, anchors: Iterable<FaceAnchor>): Ranked => {
    let ranked = UNRANKED;

    for (const anchor of anchors) {
        ranked = offer(ranked, anchor.tagId, vectorSimilarity(anchor.centre, centre));
    }

    return ranked;
};

/**
 * A ranking brought up to date after the references in `moved` changed, appeared or went.
 *
 * Exact, not an estimate: every reference that did not move scores what it did, which was at
 * most the old runner-up, so the new best two are among the old two and the moved. Unless one of
 * the old two is itself among the moved — then the third, which might now be second, was never
 * kept, and the person is ranked against everybody.
 */
const rerank = (
    centre: Float32Array,
    ranked: Ranked,
    moved: ReadonlySet<string>,
    anchors: ReadonlyMap<string, FaceAnchor>
): Ranked => {
    if (
        (ranked.tagId !== null && moved.has(ranked.tagId)) ||
        (ranked.secondTagId !== null && moved.has(ranked.secondTagId))
    ) {
        return rankAll(centre, anchors.values());
    }

    let next = ranked;

    for (const tagId of moved) {
        const anchor = anchors.get(tagId);

        if (anchor) next = offer(next, tagId, vectorSimilarity(anchor.centre, centre));
    }

    return next;
};

/** One person in one item, as runs keep them. */
interface Person {
    id: string;
    mediaId: string;
    faceIds: string[];
    bestFaceId: string;
    legible: boolean;
    centre: Float32Array;
    /** Clear enough and nobody decided about: a new person, if they match nobody. */
    stranger: boolean;
    ranked: Ranked;
}

/** What runs keep between them (§5f "Only what changed"); null until the first has run. */
interface Kept {
    /** Every item's face vectors as stored, by `vectorIndex`; null where unreadable. */
    faces: Map<string, Quantized[] | null>;
    /** Every item's people, in the order they were gathered. */
    people: Map<string, Person[]>;
    anchors: Map<string, FaceAnchor>;
    /** What the tables hold, so a run writes only what differs. */
    written: { anchors: Map<string, AnchorRow>; people: Map<string, NewAppearance> };
}

let kept: Kept | null = null;

/** Forget what runs keep, so the next does the whole library: after a failure, and for tests. */
export const forgetFaceReferences = (): void => {
    kept = null;
};

/** Which faces a person is, in any order: how a person gathered again keeps their row. */
const membersKey = (faceIds: readonly string[]): string => [...faceIds].sort().join(",");

/** An item's people, gathered from its faces; a person gathered as before keeps their id. */
const gatherItem = (
    faces: readonly AppearanceSourceFace[],
    stored: readonly Quantized[] | null,
    before: readonly { id: string; faceIds: string[] }[]
): Person[] => {
    const people = faces.flatMap((face) => {
        const vector = face.scattered === 0 ? stored?.[face.vectorIndex] : undefined;

        return vector ? [{ face, vector: unitFace(vector) }] : [];
    });

    if (people.length === 0) return [];

    const ids = new Map(before.map((person) => [membersKey(person.faceIds), person.id]));

    return appearancesInItem(
        people.map(({ face, vector }) => ({ vector, eyes: face.eyes, score: face.score })),
        people[0].face.kind
    ).map((person) => {
        const best = people[person.best].face;
        const faceIds = person.members.map((index) => people[index].face.id);

        return {
            id: ids.get(membersKey(faceIds)) ?? randomUUID(),
            mediaId: best.mediaId,
            faceIds,
            bestFaceId: best.id,
            legible: person.legible,
            centre: person.centre,
            stranger:
                best.eyes >= NEW_PERSON_EYES &&
                best.score >= NEW_PERSON_SCORE &&
                person.members.every((index) => people[index].face.decided === 0),
            ranked: UNRANKED,
        };
    });
};

/**
 * Each gathering of strangers given an id, kept from run to run: the one most of its people
 * already had, unless a larger gathering took it first. Nothing depends on an id surviving —
 * decisions land on faces — but a stable one is a row left alone.
 */
const newPersonIds = (
    strangers: readonly Person[],
    gatherings: readonly (number | null)[],
    written: ReadonlyMap<string, NewAppearance>
): Map<string, string> => {
    const members = new Map<number, Person[]>();

    gatherings.forEach((gathering, i) => {
        if (gathering === null) return;

        const list = members.get(gathering) ?? [];
        list.push(strangers[i]);
        members.set(gathering, list);
    });

    const taken = new Set<string>();
    const out = new Map<string, string>();

    for (const people of [...members.values()].sort((a, b) => b.length - a.length)) {
        const votes = new Map<string, number>();

        for (const person of people) {
            const before = written.get(person.id)?.newPersonId;

            if (before && !taken.has(before)) votes.set(before, (votes.get(before) ?? 0) + 1);
        }

        const kept = [...votes].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
        const id = kept ? kept[0] : randomUUID();

        taken.add(id);
        for (const person of people) out.set(person.id, id);
    }

    return out;
};

const round = (value: number): number => Math.round(value * 1000) / 1000;

/** A person as their row: matched wherever there is any reference at all. */
const asRow = (person: Person, newPersonId: string | null): NewAppearance => {
    const { tagId, score, second } = person.ranked;

    return {
        id: person.id,
        mediaId: person.mediaId,
        faceIds: person.faceIds,
        bestFaceId: person.bestFaceId,
        legible: person.legible,
        matchTagId: tagId,
        score: tagId === null ? null : round(score),
        second: tagId === null ? null : round(second === -Infinity ? 0 : second),
        newPersonId,
    };
};

const sameCentre = (a: Float32Array, b: Float32Array): boolean =>
    a.length === b.length && a.every((value, i) => value === b[i]);

const byItem = <T extends { mediaId: string }>(rows: readonly T[]): Map<string, T[]> => {
    const out = new Map<string, T[]>();

    for (const row of rows) {
        const list = out.get(row.mediaId) ?? [];
        list.push(row);
        out.set(row.mediaId, list);
    }

    return out;
};

/** The rows that differ between what the tables hold and what this run made. */
const appearanceChanges = (
    written: ReadonlyMap<string, NewAppearance>,
    rows: ReadonlyMap<string, NewAppearance>
): { removed: string[]; added: NewAppearance[]; rescored: AppearanceScore[] } => {
    const removed = new Set<string>();
    const added: NewAppearance[] = [];
    const rescored: AppearanceScore[] = [];

    // A row kept by id is the same faces, so the same best face; checked anyway, and remade
    // whole if not, since only a match and a new person are ever updated in place.
    for (const [id, before] of written) {
        const row = rows.get(id);

        if (!row || row.bestFaceId !== before.bestFaceId || row.legible !== before.legible) {
            removed.add(id);
        }
    }

    for (const row of rows.values()) {
        const before = written.get(row.id);

        if (!before || removed.has(row.id)) {
            added.push(row);
        } else if (
            row.matchTagId !== before.matchTagId ||
            row.score !== before.score ||
            row.second !== before.second ||
            row.newPersonId !== before.newPersonId
        ) {
            const { id, matchTagId, score, second, newPersonId } = row;
            rescored.push({ id, matchTagId, score, second, newPersonId });
        }
    }

    return { removed: [...removed], added, rescored };
};

const pass = async (): Promise<void> => {
    const started = Date.now();
    const full = kept === null;
    const stale = faceRepo.takeStale();
    const state: Kept = kept ?? {
        faces: new Map(),
        people: new Map(),
        anchors: new Map(),
        written: {
            anchors: new Map(faceRepo.anchorRows().map((row) => [row.tagId, row])),
            people: new Map(appearanceRepo.writtenAppearances().map((row) => [row.id, row])),
        },
    };
    // The people already written, by item: what a first run's people keep their ids from.
    const writtenByItem = full ? byItem([...state.written.people.values()]) : null;
    let since = Date.now();

    kept = state;

    // Items whose faces changed — every item, at first: vectors read again, people gathered again.
    const sources = byItem(appearanceRepo.sourceFaces(full ? null : stale.items));
    const regathered = new Set<string>();
    // Anything else kept that changed: an item gone, a reference's counts.
    let altered = false;

    for (const mediaId of full ? [...sources.keys()] : stale.items) {
        const faces = sources.get(mediaId);

        if (!faces) {
            state.faces.delete(mediaId);
            altered = state.people.delete(mediaId) || altered;
            continue;
        }

        const stored = await readStoredFaces(mediaId);
        const before = state.people.get(mediaId) ?? writtenByItem?.get(mediaId) ?? [];

        state.faces.set(mediaId, stored);
        state.people.set(mediaId, gatherItem(faces, stored, before));
        regathered.add(mediaId);
        since = await breathe(since);
    }

    // References that may have moved: every one at first; after that, those the triggers named
    // and those of the performers on items whose faces just changed.
    const tagIds = full
        ? null
        : [...new Set([...stale.tags, ...faceRepo.performersOn(stale.items)])];
    const confirmed = byTag(tagIds?.length === 0 ? [] : faceRepo.confirmedFaceRefs(tagIds));
    const tagged = byTag(
        tagIds?.length === 0 ? [] : faceRepo.taggedFaceRefs(ITEMS_PER_TAG, tagIds)
    );
    const vectorOf = (mediaId: string, index: number): Float32Array | undefined => {
        const vector = state.faces.get(mediaId)?.[index];

        return vector ? unitFace(vector) : undefined;
    };
    const rebuilt = tagIds ?? [...new Set([...confirmed.keys(), ...tagged.keys()])];
    const moved = new Set<string>();

    for (const tagId of rebuilt) {
        const anchor = buildAnchor(
            tagId,
            confirmed.get(tagId) ?? [],
            tagged.get(tagId) ?? [],
            vectorOf
        );
        const before = state.anchors.get(tagId);

        if (anchor === null) {
            if (state.anchors.delete(tagId)) moved.add(tagId);
        } else {
            if (!before || !sameCentre(before.centre, anchor.centre)) moved.add(tagId);
            else if (
                before.items !== anchor.items ||
                before.confirmedItems !== anchor.confirmedItems ||
                before.sharedItems !== anchor.sharedItems
            ) {
                altered = true;
            }

            state.anchors.set(tagId, anchor);
        }

        since = await breathe(since);
    }

    // Everybody gathered again is ranked against every reference; everybody else only against
    // the references that moved.
    for (const [mediaId, people] of state.people) {
        if (regathered.has(mediaId)) {
            for (const person of people) {
                person.ranked = rankAll(person.centre, state.anchors.values());
            }
        } else if (moved.size > 0) {
            for (const person of people) {
                person.ranked = rerank(person.centre, person.ranked, moved, state.anchors);
            }
        } else {
            continue;
        }

        since = await breathe(since);
    }

    const changed = full || altered || regathered.size > 0 || moved.size > 0;

    const written = changed ? await writeChanges(state, full, moved) : "nothing to write";

    // What the rule would tag now, for the "Would tag" list (§5f "Tagging by itself"). Every run,
    // since what it leaves out — items tagged, refused, checked — changes without any face doing.
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

    const anchors = [...state.anchors.values()];

    console.log(
        `Face references, ${full ? "the whole library" : "what changed"}, ` +
            `${Date.now() - started} ms: ${regathered.size} item(s) gathered, ` +
            `${rebuilt.length} reference(s) rebuilt, ${moved.size} moved; ` +
            `${anchors.length} performer(s), ` +
            `${anchors.filter((a) => a.confirmedItems === 0).length} from their tags alone; ` +
            `${written}; ` +
            `${proposals.length} item(s) the rule would tag` +
            (applied > 0 ? `, ${applied} tagged` : "")
    );
};

/**
 * New people gathered again, and every row that differs from the tables written. Only when
 * something was gathered or a reference moved: otherwise nothing kept has changed, and neither
 * can anything made from it.
 */
const writeChanges = async (
    state: Kept,
    full: boolean,
    moved: ReadonlySet<string>
): Promise<string> => {
    // New people: those who match nobody, gathered in item order across the whole library. A
    // gathering depends on the order people join it, so it is made whole — from what is kept,
    // which is arithmetic, not reading.
    const strangers: Person[] = [];

    for (const mediaId of [...state.people.keys()].sort()) {
        for (const person of state.people.get(mediaId)!) {
            if (
                person.stranger &&
                (person.ranked.tagId === null || person.ranked.score < NEW_PERSON_UNMATCHED)
            ) {
                strangers.push(person);
            }
        }
    }

    const newPersonOf = newPersonIds(
        strangers,
        gatherNewPeople(strangers.map(({ centre, mediaId }) => ({ centre, mediaId }))),
        state.written.people
    );

    // What differs from the tables, and only that, written.
    const rows = new Map<string, NewAppearance>();

    for (const people of state.people.values()) {
        for (const person of people) {
            rows.set(person.id, asRow(person, newPersonOf.get(person.id) ?? null));
        }
    }

    const changes = appearanceChanges(state.written.people, rows);
    const anchors = [...state.anchors.values()];
    const anchorRows = anchors.map(({ tagId, items, confirmedItems, sharedItems }) => ({
        tagId,
        items,
        confirmedItems,
        sharedItems,
    }));
    const changedAnchors = anchorRows.filter((row) => {
        const before = state.written.anchors.get(row.tagId);

        return (
            !before ||
            before.items !== row.items ||
            before.confirmedItems !== row.confirmedItems ||
            before.sharedItems !== row.sharedItems
        );
    });
    const goneAnchors = [...state.written.anchors.keys()].filter(
        (tagId) => !state.anchors.has(tagId)
    );

    if (full || moved.size > 0 || changedAnchors.length > 0 || goneAnchors.length > 0) {
        await writeInPlace(
            dataFile(FACE_ANCHORS_REL_PATH),
            encodeFaceAnchors(anchors[0]?.centre.length ?? EMBED_DIMS, anchors)
        );
    }

    db.transaction(() => {
        faceRepo.writeAnchors(changedAnchors, goneAnchors);
        appearanceRepo.writeAppearances(changes);
    })();
    state.written = {
        anchors: new Map(anchorRows.map((row) => [row.tagId, row])),
        people: rows,
    };

    return (
        `${rows.size} person(s) in items, ${changes.added.length} written, ` +
        `${changes.removed.length} removed, ${changes.rescored.length} rescored; ` +
        `${new Set(newPersonOf.values()).size} new person(s)`
    );
};

/** One run at a time: each builds on what the last kept. */
let inFlight: Promise<void> = Promise.resolve();

export const runFaceAnchors = async (): Promise<void> => {
    const previous = inFlight;
    let done = (): void => undefined;

    inFlight = new Promise<void>((resolve) => {
        done = resolve;
    });

    try {
        await previous;
        await pass();
    } catch (error) {
        // What was kept may be half brought up to date: the next run starts from the tables.
        kept = null;
        throw error;
    } finally {
        done();
    }
};
