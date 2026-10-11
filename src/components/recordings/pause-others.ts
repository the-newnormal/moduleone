// Pauses every <audio> on the page except `keep` (all of them when null): one recording plays at a
// time, and nothing plays into a take the recorder is starting.
export function pauseOtherAudio(keep: HTMLAudioElement | null = null): void {
  for (const el of document.querySelectorAll("audio")) if (el !== keep) el.pause();
}
