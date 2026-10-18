import type { DupeGroup, DupeMember, DupeResolveItem, DupeSortInput } from "@private-stock/core";

/**
 * The triage sheet's arithmetic (§10c): what a row would do, and whether it starts ticked.
 *
 * Pure, and in one place, because three things read it — the row, the bar that counts the
 * page, and the confirmation — and a row that said "trash 2" beside a bar that counted 3 would
 * be a screen nobody trusts with a deletion.
 */

/** The copies a resolve would actually remove: everything but the keeper, on a writable root. */
export const removable = (group: DupeGroup, keepId: string): DupeMember[] =>
    group.members.filter((member) => member.id !== keepId && member.deletable);

/** Everything else that is not the keeper, which the reviewer has to be told is staying. */
export const stranded = (group: DupeGroup, keepId: string): DupeMember[] =>
    group.members.filter((member) => member.id !== keepId && !member.deletable);

/** Clips on the copies that would go — the one thing a merge does not carry (§10c). */
export const clipsAtRisk = (group: DupeGroup, keepId: string): number =>
    removable(group, keepId).reduce((total, member) => total + member.clipCount, 0);

/**
 * Every reason this row needs a closer look, for the keeper as it stands.
 *
 * The server's cautions do not depend on the keeper; clips at risk do, so that one is drawn
 * here and moves with the reviewer's choice.
 */
export const rowCautions = (group: DupeGroup, keepId: string): string[] => {
    const clips = clipsAtRisk(group, keepId);

    return clips > 0
        ? [
              ...group.cautions,
              `${clips} ${clips === 1 ? "clip is" : "clips are"} cut from the copies that would go, and purging destroys ${clips === 1 ? "it" : "them"}`,
          ]
        : group.cautions;
};

/** The copy that starts chosen: the recommendation, or the first when there is none. */
export const defaultKeep = (group: DupeGroup): string =>
    group.suggestedKeepId ?? group.members[0]?.id ?? "";

/**
 * Whether a group is decided one at a time (§10c "Look-alikes are decided one at a time"): a
 * look-alike is ticked only by somebody saying its copies are the same, and nothing on the page
 * ticks or marks it in bulk. Identical copies have nothing to judge, so they still go by the page.
 */
export const decidedOneByOne = (group: DupeGroup): boolean => group.kind === "near";

/**
 * Whether a row starts ticked.
 *
 * An identical row is ticked unless there is a reason not to, because a page of them can be
 * accepted in one press — and the reasons are exactly the groups a glance would get wrong. A
 * look-alike never starts ticked: matching finds varied enough copies that "looks the same" is a
 * question for a person every time. A group already marked reviewed starts unticked too:
 * reviewing it was a decision to leave it as it is.
 */
export const tickedByDefault = (group: DupeGroup, keepId: string): boolean =>
    !decidedOneByOne(group) &&
    !group.reviewed &&
    removable(group, keepId).length > 0 &&
    rowCautions(group, keepId).length === 0;

/** Whether the reviewer has kept something other than the app's recommendation. */
export const againstAdvice = (group: DupeGroup, keepId: string): boolean =>
    group.suggestedKeepId !== null && group.suggestedKeepId !== keepId;

/** One row's decision as the server wants it: the keeper, and exactly the copies shown going. */
export const toResolveItem = (group: DupeGroup, keepId: string): DupeResolveItem | null => {
    const trashIds = removable(group, keepId).map((member) => member.id);

    return trashIds.length > 0 ? { groupId: group.id, keepId, trashIds } : null;
};

/**
 * A group being sorted into sets of the same thing (§10i).
 *
 * `assign` is each copy's set, by number; numbers are not renumbered as sets empty, so a set
 * keeps its letter and its colour while copies move around it. `keepers` is the copies chosen
 * to keep, latest first: a set's keeper is the first of them it holds, else its best copy.
 */
export interface Sorting {
    assign: Record<string, number>;
    keepers: string[];
}

/** Sorting starts from how the app would sort (`suggestedSets`), so agreeing is one press. */
export const startSorting = (group: DupeGroup): Sorting => ({
    assign: Object.fromEntries(
        group.suggestedSets.flatMap((set, index) => set.map((id) => [id, index]))
    ),
    keepers: [],
});

/** The set a copy is in; a copy merged in since the suggestion was made starts in the first. */
export const setOf = (sorting: Sorting, memberId: string): number => sorting.assign[memberId] ?? 0;

/** The sets as they stand, each in the row's order (best first) and in order of their number. */
export const setsOf = (group: DupeGroup, sorting: Sorting): DupeMember[][] => {
    const byNumber = new Map<number, DupeMember[]>();

    for (const member of group.members) {
        const number = setOf(sorting, member.id);

        byNumber.set(number, [...(byNumber.get(number) ?? []), member]);
    }

    return [...byNumber.entries()].sort(([a], [b]) => a - b).map(([, members]) => members);
};

/**
 * The next set for a copy: the following one in use, then a new one, then round to the first.
 *
 * "In use" by the other copies: counting this one, a copy alone in the newest set would make a
 * newer set every press and never come round.
 */
export const nextSet = (group: DupeGroup, sorting: Sorting, memberId: string): number => {
    const highest = Math.max(
        0,
        ...group.members
            .filter((member) => member.id !== memberId)
            .map((member) => setOf(sorting, member.id))
    );
    const next = setOf(sorting, memberId) + 1;

    return next > highest + 1 ? 0 : next;
};

/** A set's keeper: the latest one chosen in it, or its best copy. */
export const setKeeper = (set: DupeMember[], sorting: Sorting): DupeMember =>
    sorting.keepers
        .map((id) => set.find((member) => member.id === id))
        .find((member): member is DupeMember => member !== undefined) ?? set[0]!;

/**
 * One set seen as a group of its own, so it can be counted, confirmed and argued about with the
 * same arithmetic and the same dialogue as a row. The cautions about the whole group do not
 * carry: the one that matters most -- that its copies are not all alike -- is what sorting
 * answered.
 */
export const asGroup = (group: DupeGroup, set: DupeMember[], index: number): DupeGroup => ({
    ...group,
    id: `${group.id}:${index}`,
    members: set,
    suggestedKeepId: set[0]?.id ?? null,
    keepReason: null,
    cautions: [],
    suggestedSets: [set.map((member) => member.id)],
});

/** The sets of two or more, with their keeper: what "Record and trash" would resolve. */
export const sortedDecisions = (
    group: DupeGroup,
    sorting: Sorting
): { group: DupeGroup; keepId: string }[] =>
    setsOf(group, sorting)
        .map((set, index) => ({ set, index }))
        .filter(({ set }) => set.length > 1)
        .map(({ set, index }) => ({
            group: asGroup(group, set, index),
            keepId: setKeeper(set, sorting).id,
        }));

/**
 * A sorting as the server takes it. With `resolve`, each set of two or more also names its
 * keeper and the copies shown going, exactly as a row's decision does.
 */
export const toSortInput = (
    group: DupeGroup,
    sorting: Sorting,
    resolve: boolean
): DupeSortInput => ({
    groupId: group.id,
    sets: setsOf(group, sorting).map((set) => {
        const keeper = setKeeper(set, sorting);
        const trashIds = resolve
            ? set.filter((member) => member.id !== keeper.id && member.deletable).map((m) => m.id)
            : [];

        return {
            ids: set.map((member) => member.id),
            alike: true,
            keepId: trashIds.length > 0 ? keeper.id : null,
            trashIds,
        };
    }),
});

/** "None of these match": every copy on its own. */
export const allApart = (group: DupeGroup): DupeSortInput => ({
    groupId: group.id,
    sets: group.members.map((member) => ({
        ids: [member.id],
        alike: true,
        keepId: null,
        trashIds: [],
    })),
});

/**
 * "Not the same as the others": this copy on its own, the rest left together -- and only left
 * together. Nothing is said about whether they are the same as each other.
 */
export const oneApart = (group: DupeGroup, memberId: string): DupeSortInput => ({
    groupId: group.id,
    sets: [
        { ids: [memberId], alike: true, keepId: null, trashIds: [] },
        {
            ids: group.members.filter((member) => member.id !== memberId).map((m) => m.id),
            alike: false,
            keepId: null,
            trashIds: [],
        },
    ],
});

export const formatBytes = (bytes: number | null): string => {
    if (!bytes) return "—";

    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let unit = 0;

    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }

    return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
};

export const formatDuration = (ms: number | null): string => {
    if (!ms) return "—";

    const total = Math.round(ms / 1000);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = String(total % 60).padStart(2, "0");

    return hours > 0
        ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
        : `${minutes}:${seconds}`;
};
