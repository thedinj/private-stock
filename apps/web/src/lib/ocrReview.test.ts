import { describe, expect, it } from "vitest";

import type { OcrMatchCandidate, OcrQueueItem } from "@private-stock/core";

import { applyQueueDecision } from "./ocrReview";

/**
 * The queue after a decision, worked out on the client (§5d). Each case is a rule the server
 * follows, so the row on screen agrees with what a reload would show.
 */

const candidate = (matchId: string, tagId: string, untagged: number): OcrMatchCandidate => ({
    matchId,
    tagId,
    tagName: tagId,
    tagKind: "performer",
    kind: "exact",
    matchedText: tagId,
    state: null,
    untagged,
    correctedText: null,
});

const item = (mediaId: string, strings: Array<[string, OcrMatchCandidate[]]>): OcrQueueItem => ({
    mediaId,
    kind: "video",
    title: mediaId,
    fileName: mediaId,
    coverUrl: null,
    matchedAt: "2026-10-06 12:00:00",
    newName: false,
    strings: strings.map(([textNorm, candidates]) => ({
        textNorm,
        text: textNorm,
        frame: null,
        box: null,
        atMs: null,
        candidates,
    })),
});

/** Item m1 reads "jane doe" and a watermark; m2 and m3 read "jane doe"; m3 also reads "janedoe". */
const queue = (): OcrQueueItem[] => [
    item("m1", [
        ["jane doe", [candidate("p-jane", "jane", 3)]],
        ["examplesite", [candidate("p-site", "site", 1)]],
    ]),
    item("m2", [["jane doe", [candidate("p-jane", "jane", 3)]]]),
    item("m3", [
        ["jane doe", [candidate("p-jane", "jane", 3)]],
        ["janedoe", [candidate("p-glued", "jane", 1)]],
    ]),
];

const shape = (items: OcrQueueItem[]): string[] =>
    items.map(
        (row) =>
            `${row.mediaId}: ${row.strings
                .flatMap((string) => string.candidates)
                .map((c) => `${c.matchId}/${c.untagged}`)
                .join(" ")}`
    );

describe("the queue after a decision", () => {
    it("an accept settles the pair on every item, and the tag's other pairs there", () => {
        const next = applyQueueDecision(queue(), {
            kind: "accept",
            mediaId: "m1",
            matchIds: ["p-jane"],
            excluded: [],
        });

        expect(shape(next)).toEqual(["m1: p-site/1"]);
    });

    it("an item left out of an accept keeps the tag's other pairs", () => {
        const next = applyQueueDecision(queue(), {
            kind: "accept",
            mediaId: "m1",
            matchIds: ["p-jane"],
            excluded: ["m3"],
        });

        expect(shape(next)).toEqual(["m1: p-site/1", "m3: p-glued/1"]);
    });

    it("never leaves the row's own item out of its own accept", () => {
        const next = applyQueueDecision(queue(), {
            kind: "accept",
            mediaId: "m3",
            matchIds: ["p-jane"],
            excluded: ["m3"],
        });

        expect(shape(next)).toEqual(["m1: p-site/1"]);
    });

    it("a rejection takes the pairs off every item, and tags nothing", () => {
        const next = applyQueueDecision(queue(), {
            kind: "reject",
            mediaId: "m1",
            matchIds: ["p-jane"],
        });

        expect(shape(next)).toEqual(["m1: p-site/1", "m3: p-glued/1"]);
    });

    it("a skip takes the pairs off this item only, each owed one item fewer elsewhere", () => {
        const next = applyQueueDecision(queue(), {
            kind: "skip",
            mediaId: "m2",
            matchIds: ["p-jane"],
        });

        expect(shape(next)).toEqual(["m1: p-jane/2 p-site/1", "m3: p-jane/2 p-glued/1"]);
    });
});
