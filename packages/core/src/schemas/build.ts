import { z } from "zod";

/**
 * Which build the server is running, for a page that may have been open since an older one.
 *
 * An opaque identity, compared for equality and nothing else. The commit it embeds is shown to
 * signed-in users in the About dialog already, and this is behind the same sign-in.
 */
export const buildStampSchema = z.object({
    id: z.string(),
});
export type BuildStamp = z.infer<typeof buildStampSchema>;
