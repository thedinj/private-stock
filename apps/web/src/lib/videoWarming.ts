/**
 * Whether this device should spend bandwidth on the next item (§8b).
 *
 * Warming the next item buys a near-instant start and costs megabytes of somebody's
 * connection for something they may never open. It is asked for a video's bytes and for a
 * photograph's, which is why the question is about the device rather than about the medium. That trade is obviously right on a desktop on a
 * LAN, where the file is on a NAS in the same building, and obviously wrong on a phone on a
 * train — so it is asked rather than assumed.
 *
 * The signals are coarse on purpose, and the same coarse signals `previewBudget.ts` uses for
 * the decoder budget. There is no API that reports "this connection is metered": `saveData` is
 * the only thing a person can actually ask for, and everything else is inference.
 */

export interface DeviceSignals {
    /** The viewer has asked browsers to use less data. The one explicit signal there is. */
    saveData: boolean;
    /** The Network Information API's guess, or null where it is not implemented. */
    effectiveType: string | null;
    coarsePointer: boolean;
    narrow: boolean;
}

/** Connections where a few megabytes of speculation is somebody's afternoon. */
const SLOW = new Set(["slow-2g", "2g", "3g"]);

/**
 * Why this device is refused, in words, or null when it is not. The words are for the
 * admin tools and the warming overlay, which exist to answer "why is nothing warming".
 *
 * Pure, so the decision is testable without a browser.
 *
 * A phone is refused on the pair of signals rather than either alone: a narrow window on a
 * desktop is somebody who resized their browser, and a coarse pointer on a wide screen is a
 * touchscreen laptop or a television — neither is the case this protects.
 */
export const warmingRefusal = (signals: DeviceSignals): string | null => {
    if (signals.saveData) return "Save-Data is on";
    if (signals.effectiveType !== null && SLOW.has(signals.effectiveType)) {
        return `connection is ${signals.effectiveType}`;
    }
    if (signals.coarsePointer && signals.narrow) return "phone-sized touch device";

    return null;
};

export const warmingAllowed = (signals: DeviceSignals): boolean => warmingRefusal(signals) === null;

interface Connection {
    saveData?: boolean;
    effectiveType?: string;
}

/** Null where there is no browser to ask — the server, where the answer must be "no". */
export const readDeviceSignals = (): DeviceSignals | null => {
    if (typeof window === "undefined") return null;

    const connection = (navigator as Navigator & { connection?: Connection }).connection;

    return {
        saveData: connection?.saveData ?? false,
        effectiveType: connection?.effectiveType ?? null,
        coarsePointer: window.matchMedia?.("(pointer: coarse)").matches ?? false,
        narrow: window.innerWidth < 900,
    };
};

/**
 * Read once after mount, never during render.
 *
 * The answer differs between the server and the browser, so deciding during the first render
 * would mean the markup Next sent and the markup React builds disagree about whether there is
 * a second video element on the page.
 */
export const mayWarmNextItem = (): boolean => {
    const signals = readDeviceSignals();

    return signals !== null && warmingAllowed(signals);
};

/** The refusal as of now, for the diagnostics; "no browser" on the server. */
export const deviceWarmingRefusal = (): string | null => {
    const signals = readDeviceSignals();

    return signals === null ? "no browser" : warmingRefusal(signals);
};
