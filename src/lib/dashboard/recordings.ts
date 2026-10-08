import type { SupabaseClient } from "@supabase/supabase-js";

// Check-in recordings live in the private checkin-audio bucket. Storage's own policies decide who
// may play one (the speaker, or holders of the recordings grant); everything here uses the
// signed-in viewer's client, so those policies always apply.

const BUCKET = "checkin-audio";

// Long enough to play a check-in through; the player asks for a new link if one runs out.
export const RECORDING_LINK_SECONDS = 10 * 60;

// The drill-in's address for a recording. It never goes stale: each request signs a fresh link
// (src/app/portal/dashboard/recording/[checkinId]/route.ts), so a page left open still plays.
export const recordingPath = (checkinId: string) => `/portal/dashboard/recording/${checkinId}`;

// Which of these files the viewer may play: Storage signs only those. The links themselves are
// thrown away (the player gets its own when it plays), so they live just long enough to check.
export async function playableRecordings(
  supabase: SupabaseClient,
  paths: readonly string[],
): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  const { data } = await supabase.storage.from(BUCKET).createSignedUrls([...paths], 60);
  return new Set((data ?? []).flatMap((s) => (s.path && s.signedUrl && !s.error ? [s.path] : [])));
}

// A fresh short-lived link to one check-in's recording, or null when there is none the viewer may
// play: RLS decides whether they can read the check-in, then Storage whether it signs the file.
export async function recordingLink(supabase: SupabaseClient, checkinId: string): Promise<string | null> {
  const { data, error } = await supabase.from("checkins").select("audio_path").eq("id", checkinId).maybeSingle();
  if (error) throw new Error(`Couldn't load the check-in: ${error.message}`);
  if (!data?.audio_path) return null;
  const signed = await supabase.storage.from(BUCKET).createSignedUrl(data.audio_path, RECORDING_LINK_SECONDS);
  return signed.data?.signedUrl ?? null;
}
