// When the member is speaking, from how loud the microphone is. The live transcription model has no
// voice detection of its own, so the recorder uses this to end each turn when they pause, and to
// time the coach's reads and questions (pacing.ts).
//
// voiceStep is pure: feed it one level sample at a time. startLevelMeter is the browser side that
// produces the samples. Times are performance.now() milliseconds (liveClock in pacing.ts).

// Speech is at least 10 dB above the room's noise, and never quieter than this (a very quiet room
// would otherwise count breathing as speech).
const SPEECH_MARGIN = 10 ** (10 / 20);
export const MIN_SPEECH_LEVEL = 0.01;
// How long the level has to stay on the other side before speaking starts or stops, so a cough
// doesn't start a turn and a short gap between words doesn't end one.
export const HYSTERESIS_MS = 150;
// The noise floor drops quickly to a quieter room, and rises slowly: about 2 dB a second while they
// are quiet, and far slower while they speak, so a long answer doesn't lift it into their voice.
// A steady new noise (a fan) is still learned in the end.
const FLOOR_FALL_TAU_MS = 150;
const FLOOR_RISE_DB_PER_S_QUIET = 2;
const FLOOR_RISE_DB_PER_S_SPEAKING = 0.25;
// Below this the input is digital silence (a muted or starting track): no news about the room.
const FLOOR_MIN = 1e-4;
// A sample after a long gap (a throttled background tab) moves the floor no more than this much time would.
const MAX_STEP_MS = 250;

export type Voice = {
  speaking: boolean;
  // The room's level when nobody speaks (RMS); 0 until the first sample.
  noiseFloor: number;
  // The last sample loud enough to be speech.
  lastSpeechAt: number | null;
  // When the current silence began (null until they have spoken and stopped).
  lastSilenceAt: number | null;
  // When the level crossed to the other side of speaking, while waiting out the hysteresis.
  candidateSince: number | null;
  // When the current stretch of speech began (null while silent).
  speechStartedAt: number | null;
  // Speech before the current stretch, in ms.
  speechMs: number;
  // The previous sample.
  lastAt: number | null;
};

export function emptyVoice(): Voice {
  return {
    speaking: false,
    noiseFloor: 0,
    lastSpeechAt: null,
    lastSilenceAt: null,
    candidateSince: null,
    speechStartedAt: null,
    speechMs: 0,
    lastAt: null,
  };
}

// The level that counts as speech over this noise floor.
export function speechThreshold(noiseFloor: number): number {
  return Math.max(MIN_SPEECH_LEVEL, noiseFloor * SPEECH_MARGIN);
}

function nextFloor(v: Voice, level: number, now: number): number {
  if (level < FLOOR_MIN) return v.noiseFloor;
  if (v.noiseFloor === 0) return level;
  const dt = Math.min(MAX_STEP_MS, Math.max(0, now - (v.lastAt ?? now)));
  if (level < v.noiseFloor) return v.noiseFloor + (level - v.noiseFloor) * (1 - Math.exp(-dt / FLOOR_FALL_TAU_MS));
  const rate = v.speaking ? FLOOR_RISE_DB_PER_S_SPEAKING : FLOOR_RISE_DB_PER_S_QUIET;
  return Math.min(level, v.noiseFloor * 10 ** ((rate * dt) / 1000 / 20));
}

// One level sample: RMS in [0, 1], taken at `now`.
export function voiceStep(v: Voice, { level, now }: { level: number; now: number }): Voice {
  const clean = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
  // Judged against the floor before this sample moves it.
  const loud = v.noiseFloor > 0 && clean > speechThreshold(v.noiseFloor);
  const next: Voice = {
    ...v,
    noiseFloor: nextFloor(v, clean, now),
    lastSpeechAt: loud ? now : v.lastSpeechAt,
    lastAt: now,
  };
  if (loud === v.speaking) return { ...next, candidateSince: null };
  const since = v.candidateSince ?? now;
  if (now - since < HYSTERESIS_MS) return { ...next, candidateSince: since };
  // The change happened when the level first crossed, not when the hysteresis ran out.
  if (loud) return { ...next, speaking: true, speechStartedAt: since, candidateSince: null };
  return {
    ...next,
    speaking: false,
    speechMs: v.speechMs + Math.max(0, since - (v.speechStartedAt ?? since)),
    speechStartedAt: null,
    lastSilenceAt: since,
    candidateSince: null,
  };
}

// How long they have been quiet: 0 while speaking, Infinity if they haven't spoken yet.
export function silenceMs(v: Voice, now: number): number {
  if (v.speaking) return 0;
  if (v.lastSilenceAt === null) return Infinity;
  return Math.max(0, now - v.lastSilenceAt);
}

// How long they have spoken in all, including the stretch in progress.
export function spokenMs(v: Voice, now: number): number {
  return v.speechMs + (v.speaking && v.speechStartedAt !== null ? Math.max(0, now - v.speechStartedAt) : 0);
}

// Samples the microphone's level every 50 ms until stopped. A timer rather than
// requestAnimationFrame, which stops while the tab is in the background and the member is still
// talking. Never calls onLevel where Web Audio isn't available; the recorder then uses the fixed
// questions.
const SAMPLE_EVERY_MS = 50;
const FFT_SIZE = 1024;

export function startLevelMeter(stream: MediaStream, onLevel: (level: number, now: number) => void): () => void {
  const AudioContextClass: typeof AudioContext | undefined =
    globalThis.AudioContext ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) return () => {};

  let context: AudioContext;
  try {
    context = new AudioContextClass();
  } catch {
    return () => {};
  }
  let source: MediaStreamAudioSourceNode;
  let analyser: AnalyserNode;
  try {
    source = context.createMediaStreamSource(stream);
    analyser = context.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    source.connect(analyser);
  } catch {
    void context.close().catch(() => {});
    return () => {};
  }
  // Started from the Start button's click, so it may run; a context made without one starts suspended.
  if (context.state === "suspended") void context.resume().catch(() => {});

  const samples = new Float32Array(FFT_SIZE);
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    onLevel(Math.sqrt(sum / samples.length), performance.now());
  }, SAMPLE_EVERY_MS);

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    try {
      source.disconnect();
      analyser.disconnect();
    } catch {
      // Already disconnected.
    }
    void context.close().catch(() => {});
  };
}
