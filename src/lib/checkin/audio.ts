// Recording files in the private 'checkin-audio' bucket. Paths are always built on the server from
// the signed-in member; anything a browser sends back is checked against the same rule the database
// enforces (checkins_audio_path_own_folder in 0002, checkin_drafts in 0004).

// File extension for each audio type the recorder can produce, keyed by base MIME type.
export const AUDIO_EXTENSIONS: Readonly<Record<string, string>> = {
  "audio/webm": "webm", // Chrome, Edge, Firefox (Opus)
  "audio/ogg": "ogg", // older Firefox
  "audio/mp4": "m4a", // Safari, iOS
  "audio/x-m4a": "m4a",
};

// The bucket's own limit (file_size_limit 26214400 in 0002).
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

// 'audio/webm;codecs=opus' → 'audio/webm' (lower case, parameters dropped).
export function baseMimeType(mime: string): string {
  return mime.split(";")[0].trim().toLowerCase();
}

// The extension for a recorder MIME type, or null if it isn't an allowed audio type.
export function extensionFor(mime: string): string | null {
  return AUDIO_EXTENSIONS[baseMimeType(mime)] ?? null;
}

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// A new, unguessable path in the member's own folder: '<member id>/<week>-<uuid>.<ext>'.
export function draftPath(memberId: string, weekStart: string, ext: string): string {
  return `${memberId}/${weekStart}-${crypto.randomUUID()}.${ext}`;
}

// True only for '<memberId>/<file name>' with a plain file name, exactly as the database checks it.
// Storage resolves '..' and percent-encoded dots, so anything else could reach another member's
// folder when the server opens it with the service role. With `weekStart`, the file must also be
// one made for that week.
export function isOwnAudioPath(path: string, memberId: string, weekStart?: string): boolean {
  const prefix = `${memberId}/`;
  if (!memberId || !path.startsWith(prefix)) return false;
  const name = path.slice(prefix.length);
  if (!FILE_NAME.test(name) || name.includes("..")) return false;
  return weekStart === undefined || name.startsWith(`${weekStart}-`);
}
