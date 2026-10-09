import "server-only";
import { revalidatePath } from "next/cache";

// After any change to the team tree, a node's fields, who is in a team or who leads it: every page
// that shows them. The Structure page shows the tree with people and lead counts; each team page
// shows its breadcrumb, people, leads and the names of other teams ("moves from …"); the heat-map
// (and its drill-in pages) lists the teams by name, grouped by division. Only the page the action
// was called from re-renders in its response; the others are fetched fresh when next visited.
export function revalidateTeamTree(): void {
  revalidatePath("/admin/structure");
  revalidatePath("/admin/teams/[id]", "page");
  revalidatePath("/portal/dashboard", "layout");
}
