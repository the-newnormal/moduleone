"use server";

import { type ActionResult, fail, toUserMessage } from "@/lib/admin/errors";
import { parseNodeFields } from "@/lib/admin/node-fields";
import { revalidateTeamTree } from "@/lib/admin/revalidate";
import { requireAdmin } from "@/lib/admin/session";
import { asRecord, isCreatableKind, isIndex, isParentId, isTeamKind, isUuid, MAX_INDEX } from "@/lib/admin/validate";

// Writes to divisions, domains and teams: move, add, edit, archive and restore. The Structure page
// uses all of them; a team's page uses updateNode for its Edit. Each one checks the admin grant
// first, then its input, then writes as the signed-in admin, so RLS and 0003's tree rules decide.
// The database's own refusals ("Move its 2 members out first.") are shown as they are
// (toUserMessage). Nothing here deletes a node.

const GONE = "It isn't there any more. Reload the page to see the structure as it is now.";
const BAD_MOVE = "That move isn't possible. Reload the page and try again.";

// Move a node: { teamId, parentId (null: the top level), index } as admin_move_team takes them
// (index among the active siblings; dropToMove and moveOptions work it out).
export async function moveNode(input: unknown): Promise<ActionResult> {
  const admin = await requireAdmin();
  if (!admin.ok) return admin;

  const move = asRecord(input);
  if (!isUuid(move.teamId) || !isParentId(move.parentId) || !isIndex(move.index)) return fail(BAD_MOVE);

  const { error } = await admin.value.supabase.rpc("admin_move_team", {
    p_team_id: move.teamId,
    p_parent_id: move.parentId,
    p_index: move.index,
  });
  if (error) return fail(toUserMessage(error, "moveNode"));

  revalidateTeamTree();
  return { ok: true, value: null };
}

// Add a division (parentId null), a domain (in a division, or null: unplaced) or a team (in a
// domain): { kind, parentId, name, code, type, note }. It goes last among its active siblings.
// A division goes in the organisation node when there is one (migration 0006), else at the top.
export async function createNode(input: unknown): Promise<ActionResult<{ id: string }>> {
  const admin = await requireAdmin();
  if (!admin.ok) return admin;
  const { supabase } = admin.value;

  const form = asRecord(input);
  const { kind } = form;
  const parentId = form.parentId ?? null;
  if (!isCreatableKind(kind) || !isParentId(parentId)) return fail("Choose what to add, and where.");
  // The database refuses these too, but in its constraints' words.
  if (kind === "division" && parentId !== null) return fail("A division can only sit at the top level.");
  if (kind === "team" && parentId === null) return fail("A team can only sit under a domain.");

  const fields = parseNodeFields(kind, form);
  if (!fields.ok) return fail(fields.error);

  let parent = parentId;
  if (kind === "division") {
    const org = await supabase.from("teams").select("id").eq("kind", "organisation").is("parent_id", null).limit(1);
    if (org.error) return fail(toUserMessage(org.error, "createNode"));
    parent = (org.data as { id: string }[] | null)?.[0]?.id ?? null;
  }

  // Last place: one after the highest active sibling. When the siblings are numbered 0..n-1, as
  // admin_move_team leaves them, that's the number of active siblings; after an archive leaves a
  // gap it's still after all of them.
  const siblings = supabase.from("teams").select("sort_order").is("archived_at", null);
  const last = await (parent === null ? siblings.is("parent_id", null) : siblings.eq("parent_id", parent))
    .order("sort_order", { ascending: false })
    .limit(1);
  if (last.error) return fail(toUserMessage(last.error, "createNode"));
  const highest = Number((last.data as { sort_order: number }[] | null)?.[0]?.sort_order ?? -1);
  const sort_order = Math.min(Number.isInteger(highest) ? highest + 1 : 0, MAX_INDEX);

  const { data, error } = await supabase
    .from("teams")
    .insert({ kind, parent_id: parent, ...fields.value, sort_order })
    .select("id")
    .single();
  if (error) return fail(toUserMessage(error, "createNode"));

  revalidateTeamTree();
  return { ok: true, value: { id: (data as { id: string }).id } };
}

// Edit a node's name, code, type and note: { id, name, code, type, note }. Its kind stays as it
// is (the type goes in the column for that kind).
export async function updateNode(input: unknown): Promise<ActionResult> {
  const admin = await requireAdmin();
  if (!admin.ok) return admin;
  const { supabase } = admin.value;

  const form = asRecord(input);
  const { id } = form;
  if (!isUuid(id)) return fail(GONE);

  const current = await supabase.from("teams").select("kind").eq("id", id).maybeSingle();
  if (current.error) return fail(toUserMessage(current.error, "updateNode"));
  const kind = (current.data as { kind: unknown } | null)?.kind;
  if (!isTeamKind(kind)) return fail(GONE);

  const fields = parseNodeFields(kind, form);
  if (!fields.ok) return fail(fields.error);

  const { data, error } = await supabase.from("teams").update(fields.value).eq("id", id).select("id");
  if (error) return fail(toUserMessage(error, "updateNode"));
  if (!data || data.length === 0) return fail(GONE);

  revalidateTeamTree();
  return { ok: true, value: null };
}

// Archive a node. The database refuses while it has active children or members, and says so.
export async function archiveNode(id: unknown): Promise<ActionResult> {
  const admin = await requireAdmin();
  if (!admin.ok) return admin;
  if (!isUuid(id)) return fail(GONE);

  const { data, error } = await admin.value.supabase
    .from("teams")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", id)
    .is("archived_at", null)
    .select("id");
  if (error) return fail(toUserMessage(error, "archiveNode"));
  if (!data || data.length === 0) return fail("It's already archived, or it isn't there any more. Reload the page.");

  revalidateTeamTree();
  return { ok: true, value: null };
}

// Restore an archived node where it was. The database refuses while its parent is archived.
export async function restoreNode(id: unknown): Promise<ActionResult> {
  const admin = await requireAdmin();
  if (!admin.ok) return admin;
  if (!isUuid(id)) return fail(GONE);

  const { data, error } = await admin.value.supabase
    .from("teams")
    .update({ archived_at: null })
    .eq("id", id)
    .not("archived_at", "is", null)
    .select("id");
  if (error) return fail(toUserMessage(error, "restoreNode"));
  if (!data || data.length === 0) return fail("It isn't archived, or it isn't there any more. Reload the page.");

  revalidateTeamTree();
  return { ok: true, value: null };
}
