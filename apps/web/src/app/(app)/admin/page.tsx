import { redirect } from "next/navigation";

/**
 * The admin area has no page of its own (§12c).
 *
 * It was one long page of eleven cards; it is now Libraries, Processing and Household, each in
 * the sidebar. An old link or bookmark to `/admin` lands on Processing, the closest thing to a
 * health check -- whether anything is queued, failing or paused.
 */
const AdminPage = (): never => redirect("/admin/processing");

export default AdminPage;
