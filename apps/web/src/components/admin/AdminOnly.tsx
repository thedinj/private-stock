"use client";

import { Alert } from "@mantine/core";

import { useAuth } from "@/lib/api/AuthProvider";

/**
 * The admin area's one gate, in the layouts of `/admin` and `/review`.
 *
 * Each page used to carry its own copy of this check, and two of them did not: they relied on
 * the API refusing, and rendered an empty page around the refusal. The API still decides (§12c);
 * this only stops the page drawing controls that cannot work.
 */
export const AdminOnly: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { hasScope } = useAuth();

    if (!hasScope("admin")) {
        return (
            <Alert color="oxblood" variant="light">
                This page requires the administrator permission.
            </Alert>
        );
    }

    return <>{children}</>;
};
