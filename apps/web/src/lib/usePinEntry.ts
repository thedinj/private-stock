import { useCallback, useState } from "react";

import { checkPin } from "@/lib/api/account";
import { useAuth } from "@/lib/api/AuthProvider";
import { canTry, withDigit } from "@/lib/pinDigits";

export interface PinEntry {
    digits: string;
    busy: boolean;
    /**
     * Tries left before this device is signed out, as the last wrong try said. Null until a try
     * has been wrong. Kept until the next try, so the rack can keep its last-try line up.
     */
    remaining: number | null;
    /** The last try could not reach the server. Cleared by the next press. */
    unreachable: boolean;
    press: (digit: string) => void;
    back: () => void;
    clear: () => void;
    submit: () => Promise<void>;
}

/**
 * Entering the account's PIN (§12c, §21 "Getting into the cellar"): the digits, the server's
 * answer and the attempt limit, behind the cellar's wine rack, which is
 * also the screen lock's face. A wrong try says nothing until the last one.
 */
export const usePinEntry = (onUnlock: () => void): PinEntry => {
    const { signOut } = useAuth();
    const [digits, setDigits] = useState("");
    const [busy, setBusy] = useState(false);
    const [remaining, setRemaining] = useState<number | null>(null);
    const [unreachable, setUnreachable] = useState(false);

    const settle = () => {
        setUnreachable(false);
    };

    const press = useCallback((digit: string) => {
        settle();
        setDigits((current) => withDigit(current, digit));
    }, []);

    const back = useCallback(() => {
        settle();
        setDigits((current) => current.slice(0, -1));
    }, []);

    const clear = useCallback(() => {
        settle();
        setDigits("");
    }, []);

    const submit = useCallback(async () => {
        if (busy || !canTry(digits)) return;

        setBusy(true);
        settle();

        try {
            const result = await checkPin(digits);

            setDigits("");

            if (result.ok) {
                setRemaining(null);
                onUnlock();
            } else if (result.signedOut) {
                await signOut();
            } else {
                setRemaining(result.remaining ?? null);
            }
        } catch {
            setUnreachable(true);
        } finally {
            setBusy(false);
        }
    }, [busy, digits, onUnlock, signOut]);

    return { digits, busy, remaining, unreachable, press, back, clear, submit };
};
