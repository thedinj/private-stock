import type { DupeGroup, DupeMember, DupeResolveItem } from "@private-stock/core";

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
 * Whether a row starts ticked.
 *
 * Ticked unless there is a reason not to, because the sheet exists so a page of
 * recommendations can be accepted in one press — and the reasons are exactly the groups a
 * glance would get wrong. A group already marked reviewed starts unticked too: reviewing it was
 * a decision to leave it as it is.
 */
export const tickedByDefault = (group: DupeGroup, keepId: string): boolean =>
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
