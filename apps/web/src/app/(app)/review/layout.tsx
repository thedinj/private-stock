import { Stack } from "@mantine/core";

import { AdminOnly } from "@/components/admin/AdminOnly";
import { ReviewQueues } from "@/components/admin/ReviewQueues";

/** Review (§12c): the queues of decisions, under one sidebar entry and one switcher. */
const ReviewLayout: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <AdminOnly>
        <Stack gap="md">
            <ReviewQueues />
            {children}
        </Stack>
    </AdminOnly>
);

export default ReviewLayout;
