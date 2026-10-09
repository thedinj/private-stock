"use client";

import { Stack } from "@mantine/core";

import { AccessCards } from "@/components/admin/AccessCards";
import { PagePlate } from "@/components/shell/PagePlate";

/**
 * Household (§12c, §18.1): who gets in.
 *
 * People and the invitations that let them in move together -- using an invitation creates an
 * account -- so they share a page, and nothing else does.
 */
const HouseholdPage: React.FC = () => (
    <Stack gap="lg">
        <PagePlate eyebrow="Admin" title="Household" />

        <Stack gap="lg" maw={860}>
            <AccessCards />
        </Stack>
    </Stack>
);

export default HouseholdPage;
