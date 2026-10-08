// Stable codes stored with each transcript (checkins.transcript_warnings), so whoever reads a
// check-in can tell when the text may not reflect what was said, and read its grade with care.

// Ordinary speech runs at 120-160 words a minute. Far below that over a real recording usually
// means the service dropped audio or heard mostly silence.
const LOW_WORDS_PER_MINUTE = 40;
const MIN_SECONDS_FOR_RATE = 30;
// Above this share of non-Latin letters the speaker probably used another language (or the
// service guessed one), and an English rubric may misread it.
const NON_LATIN_SHARE = 0.3;

export function transcriptWarnings(text: string, durationSeconds?: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) return ["empty_transcript"];

  const warnings: string[] = [];
  if (durationSeconds !== undefined && durationSeconds >= MIN_SECONDS_FOR_RATE) {
    const words = trimmed.split(/\s+/).length;
    if (words / (durationSeconds / 60) < LOW_WORDS_PER_MINUTE) warnings.push("low_words_per_minute");
  }

  const letters = trimmed.match(/\p{L}/gu) ?? [];
  const latin = trimmed.match(/\p{Script=Latin}/gu) ?? [];
  if (letters.length > 0 && (letters.length - latin.length) / letters.length > NON_LATIN_SHARE) {
    warnings.push("non_latin_script");
  }
  return warnings;
}
