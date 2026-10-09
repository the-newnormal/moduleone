import type { updateNode } from "@/app/admin/structure/actions";
import type * as TeamPageActions from "@/app/admin/teams/[id]/actions";

// The team page's server actions, handed down from the page as props (so the components can be
// rendered in tests with fakes). Its Edit saves with updateNode, which the Structure page uses too.
// Type-only: nothing here is bundled.
export type TeamActions = Pick<
  typeof TeamPageActions,
  "addMember" | "createMember" | "removeFromTeam" | "setRole" | "addLead" | "removeLead" | "giveLogin" | "resendInvite"
> & { updateNode: typeof updateNode };
