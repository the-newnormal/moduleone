import "server-only";
import { createServiceRoleClient } from "@/lib/supabase/admin";

// There is no privacy notice in the app (the product owner's decision, 13 October 2026). Members are
// told how their recordings are used, and agree, on a separate onboarding form outside Module One, and
// the app assumes everyone with a login has.
// How long a submitted recording is kept is still decided by 0013's submit_checkin_draft: a year only
// if, when the take started, the speaker's login had a recording_notices row promising a year (and
// nothing shorter since). So the Diary notes that assumption for the signed-in login every time it
// loads, before it can show the recorder (src/app/portal/checkin/page.tsx): every take recorded there
// starts after the note and is kept a year. Takes started before it keep what they were given.
// The row is Module One's note of an assumption, not consent and not evidence of it: its version says
// "assumed:", and accepted_at is when Module One first relied on the form for this login, not when the
// member filled it in. The first write is kept. Never backdate one, or write one for any login but the
// session's: that would lengthen recordings made under a 90-day notice (CLAUDE.md).
export const ONBOARDING_NOTE_VERSION = "assumed:onboarding-form.2026-10-13";
// How long the onboarding form says recordings submitted from now on are kept, in days (0013 allows 90
// or 365). Change it only with the form and a new ONBOARDING_NOTE_VERSION; any other value needs a
// migration.
export const RECORDING_KEEP_DAYS = 365;

// memberId and authUserId come from the session (the verified login and the member row RLS finds by
// it), never from a request. Safe to repeat. Never throws: a missing service key is an error like any other.
export async function noteOnboardingForm(
  memberId: string,
  authUserId: string,
): Promise<{ error: { code: string } | null }> {
  try {
    const { error } = await createServiceRoleClient()
      .from("recording_notices")
      .upsert(
        {
          member_id: memberId,
          auth_user_id: authUserId,
          notice_version: ONBOARDING_NOTE_VERSION,
          recording_keep_days: RECORDING_KEEP_DAYS,
        },
        // Keep the first note (its time) on every later load.
        { onConflict: "member_id,auth_user_id,notice_version", ignoreDuplicates: true },
      );
    return { error: error ? { code: error.code } : null };
  } catch (error) {
    return { error: { code: error instanceof Error ? error.name : "unknown" } };
  }
}
