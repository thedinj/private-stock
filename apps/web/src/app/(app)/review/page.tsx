import { redirect } from "next/navigation";

/**
 * Review has no page of its own: its sidebar entry goes to the queue last used (§14b), and an
 * address typed by hand lands on the first.
 */
const ReviewPage = (): never => redirect("/review/duplicates");

export default ReviewPage;
