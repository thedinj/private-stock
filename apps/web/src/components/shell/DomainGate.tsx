"use client";

import { useState } from "react";

import { DEFAULT_DOMAIN, domainProfiles } from "@private-stock/core";

import { LockScreen } from "@/components/shell/ScreenLock";
import { usePinStatus } from "@/lib/api/account";
import { useAuth } from "@/lib/api/AuthProvider";
import { getActiveDomain, hasPassedGate, markGatePassed, switchDomain } from "@/lib/activeDomain";

/**
 * Asks for the PIN before a guarded room is shown (§21 "Getting into the cellar").
 *
 * A tab that opens in the cellar, by switching or by reopening a browser that was last there,
 * shows the screen lock's keypad first. Once the tab has passed, a reload does not ask again;
 * a new tab or a restarted browser does. Nothing underneath is mounted until then, so no query
 * for the guarded room leaves the tab before the PIN is entered.
 *
 * An account with no PIN has nothing to ask for, and the room opens. **This is a stopgap**: the
 * keypad says plainly that something is locked, and a quieter way in is still to be designed.
 */
export const DomainGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { user } = useAuth();
    const domain = getActiveDomain();
    const guarded = domainProfiles[domain].guarded;
    const [passed, setPassed] = useState(() => !guarded || hasPassedGate(domain));

    const { data: pinStatus, isPending } = usePinStatus(user !== null && guarded && !passed);

    if (user === null || passed) {
        return <>{children}</>;
    }

    // Asking whether the account has a PIN; nothing is shown in the meantime.
    if (isPending) {
        return null;
    }

    // Only a definite "no PIN" opens it. A failed read keeps the keypad up: failing open would
    // show the cellar whenever the network blinked.
    if (pinStatus?.set === false) {
        return <>{children}</>;
    }

    return (
        <LockScreen
            showKeypad
            displayName={user.displayName}
            onUnlock={() => {
                markGatePassed(domain);
                setPassed(true);
            }}
            leave={{
                label: `Go to the ${domainProfiles[DEFAULT_DOMAIN].label}`,
                onLeave: () => switchDomain(DEFAULT_DOMAIN),
            }}
        />
    );
};
