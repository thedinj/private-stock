import { redirect } from "next/navigation";

/**
 * The Tags section has no page of its own (§6 "Tags").
 *
 * Its entries are the facets and the management table, and a landing page listing four links
 * that are already in the sidebar would be a page that exists to be clicked past. Performers
 * first, because people are what the section is mostly for.
 */
const TagsPage = (): never => redirect("/tags/performers");

export default TagsPage;
