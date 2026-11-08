import {
    AuthorizationError,
    ValidationError,
    domainKinds,
    domainProfiles,
    roomSwitchSchema,
    SETTING_KEYS,
    type DomainKind,
    type Rooms,
    type RoomSwitch,
} from "@private-stock/core";
import { settingRepo } from "@private-stock/db";

/**
 * Which rooms the household can go into (§21 "Turning a room off").
 *
 * Navigation only. A room that is off keeps its libraries, and the scanner and the worker go on
 * as before; nothing here is read by either of them. One answer for every account, because the
 * rooms are the household's -- which is why only an administrator changes it.
 */

/** The rooms stored as off, read leniently: a room the code no longer knows is dropped. */
const storedOff = (): DomainKind[] => {
    const raw = settingRepo.get<unknown>(SETTING_KEYS.roomsOff, []);
    const list: unknown[] = Array.isArray(raw) ? raw : [];

    return domainKinds.filter((kind) => list.includes(kind));
};

/**
 * The rooms that are on, in `domainKinds` order. A row that would leave none on -- hand-edited,
 * or naming every room -- reads as all of them: the write path refuses that state, and a house
 * with no way in is not a reading of a setting anyone meant.
 */
export const enabledRooms = (): Rooms => {
    const off = storedOff();
    const enabled = domainKinds.filter((kind) => !off.includes(kind));

    return { enabled: enabled.length > 0 ? enabled : [...domainKinds] };
};

/** Turn one room on or off. Refuses to turn off the last room that is on. */
export const switchRoom = (input: RoomSwitch, scopes: string[]): Rooms => {
    if (!scopes.includes("admin")) {
        throw new AuthorizationError("Only an administrator can turn rooms on or off");
    }

    const { room, enabled } = roomSwitchSchema.parse(input);
    const current = enabledRooms().enabled;
    const next = enabled
        ? domainKinds.filter((kind) => kind === room || current.includes(kind))
        : current.filter((kind) => kind !== room);

    if (next.length === 0) {
        throw new ValidationError(
            `The ${domainProfiles[room].label} is the only room on. Turn another on first.`
        );
    }

    settingRepo.set(
        SETTING_KEYS.roomsOff,
        domainKinds.filter((kind) => !next.includes(kind))
    );

    return enabledRooms();
};
