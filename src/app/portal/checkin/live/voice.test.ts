import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emptyVoice,
  HYSTERESIS_MS,
  MIN_SPEECH_LEVEL,
  silenceMs,
  speechThreshold,
  spokenMs,
  startLevelMeter,
  voiceStep,
  type Voice,
} from "./voice";

// One sample every 50 ms, as the level meter takes them, from `from` for `ms`.
function feed(v: Voice, level: number, from: number, ms: number): Voice {
  for (let now = from; now < from + ms; now += 50) v = voiceStep(v, { level, now });
  return v;
}

const QUIET = 0.002; // a quiet HDB bedroom
const SPEECH = 0.1;

describe("voiceStep: the noise floor", () => {
  it("starts from the room's level and drops quickly to a quieter one", () => {
    let v = feed(emptyVoice(), QUIET, 0, 1000);
    expect(v.noiseFloor).toBeCloseTo(QUIET, 4);
    v = feed(v, 0.0005, 1000, 1000);
    expect(v.noiseFloor).toBeLessThan(0.0006);
  });

  it("rises only slowly when the room gets louder, and learns it in the end", () => {
    let v = feed(emptyVoice(), 0.0005, 0, 1000);
    v = feed(v, 0.004, 1000, 1000);
    // About 2 dB in a second, nowhere near the new level yet.
    expect(v.noiseFloor).toBeLessThan(0.0007);
    v = feed(v, 0.004, 2000, 20_000);
    expect(v.noiseFloor).toBeCloseTo(0.004, 4);
    expect(v.speaking).toBe(false);
  });

  it("ignores digital silence (a track that hasn't started)", () => {
    let v = feed(emptyVoice(), 0, 0, 500);
    expect(v.noiseFloor).toBe(0);
    v = feed(v, QUIET, 500, 500);
    expect(v.noiseFloor).toBeCloseTo(QUIET, 4);
    v = feed(v, 0, 1000, 500);
    expect(v.noiseFloor).toBeCloseTo(QUIET, 4);
  });

  it("counts speech only 10 dB over the floor, and never below the minimum level", () => {
    expect(speechThreshold(0.0005)).toBe(MIN_SPEECH_LEVEL);
    expect(speechThreshold(0.02)).toBeCloseTo(0.0632, 4);

    // A quiet room: a murmur under the minimum isn't speech.
    let v = feed(emptyVoice(), 0.0005, 0, 1000);
    v = feed(v, 0.008, 1000, 1000);
    expect(v.speaking).toBe(false);

    // A noisy kopitiam: 8 dB over the floor isn't speech, 14 dB is.
    v = feed(emptyVoice(), 0.02, 0, 1000);
    v = feed(v, 0.05, 1000, 500);
    expect(v.speaking).toBe(false);
    v = feed(v, 0.1, 1500, 500);
    expect(v.speaking).toBe(true);
  });
});

describe("voiceStep: speaking", () => {
  const quietRoom = () => feed(emptyVoice(), QUIET, 0, 2000);

  it("starts speaking only after the level has stayed up for the hysteresis", () => {
    let v = quietRoom();
    v = voiceStep(v, { level: SPEECH, now: 2000 });
    v = voiceStep(v, { level: SPEECH, now: 2100 });
    expect(v.speaking).toBe(false);
    expect(v.candidateSince).toBe(2000);
    v = voiceStep(v, { level: SPEECH, now: 2000 + HYSTERESIS_MS });
    expect(v.speaking).toBe(true);
    // From when the level first rose.
    expect(v.speechStartedAt).toBe(2000);
    expect(v.lastSpeechAt).toBe(2150);
  });

  it("ignores a cough", () => {
    let v = feed(quietRoom(), SPEECH, 2000, 100);
    v = feed(v, QUIET, 2100, 1000);
    expect(v.speaking).toBe(false);
    expect(v.candidateSince).toBeNull();
    expect(silenceMs(v, 3100)).toBe(Infinity);
    expect(spokenMs(v, 3100)).toBe(0);
  });

  it("doesn't stop for a short gap between words", () => {
    let v = feed(quietRoom(), SPEECH, 2000, 1000);
    v = feed(v, QUIET, 3000, 100);
    v = feed(v, SPEECH, 3100, 500);
    expect(v.speaking).toBe(true);
    expect(v.speechStartedAt).toBe(2000);
    expect(v.lastSilenceAt).toBeNull();
  });

  it("stops after the hysteresis, dated from when the level fell", () => {
    let v = feed(quietRoom(), SPEECH, 2000, 1000);
    v = feed(v, QUIET, 3000, 100);
    expect(v.speaking).toBe(true);
    v = feed(v, QUIET, 3100, 100);
    expect(v.speaking).toBe(false);
    expect(v.lastSilenceAt).toBe(3000);
    expect(v.speechMs).toBe(1000);
  });
});

describe("silenceMs and spokenMs", () => {
  it("are Infinity and 0 before they have said anything", () => {
    const v = feed(emptyVoice(), QUIET, 0, 1000);
    expect(silenceMs(v, 1000)).toBe(Infinity);
    expect(spokenMs(v, 1000)).toBe(0);
  });

  it("are 0 and growing while they speak, then count the quiet from when it began", () => {
    let v = feed(feed(emptyVoice(), QUIET, 0, 2000), SPEECH, 2000, 1000);
    expect(silenceMs(v, 2950)).toBe(0);
    expect(spokenMs(v, 2950)).toBe(950);
    v = feed(v, QUIET, 3000, 1000);
    expect(silenceMs(v, 4000)).toBe(1000);
    expect(spokenMs(v, 4000)).toBe(1000);
    v = feed(v, SPEECH, 4000, 500);
    expect(silenceMs(v, 4450)).toBe(0);
    expect(spokenMs(v, 4450)).toBe(1450);
  });
});

describe("startLevelMeter", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does nothing without Web Audio", () => {
    vi.useFakeTimers();
    vi.stubGlobal("AudioContext", undefined);
    const onLevel = vi.fn();
    const stop = startLevelMeter({} as MediaStream, onLevel);
    vi.advanceTimersByTime(500);
    expect(onLevel).not.toHaveBeenCalled();
    expect(() => stop()).not.toThrow();
  });

  it("reports the RMS level every 50 ms, and lets everything go when stopped", () => {
    vi.useFakeTimers();
    const source = { connect: vi.fn(), disconnect: vi.fn() };
    const analyser = {
      fftSize: 2048,
      disconnect: vi.fn(),
      // A square wave at ±0.25: RMS 0.25.
      getFloatTimeDomainData: (samples: Float32Array) => samples.forEach((_, i) => (samples[i] = i % 2 ? 0.25 : -0.25)),
    };
    const contexts: { close: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn> }[] = [];
    const stream = {} as MediaStream;
    vi.stubGlobal(
      "AudioContext",
      class {
        state = "suspended";
        close = vi.fn(async () => {});
        resume = vi.fn(async () => {});
        constructor() {
          contexts.push(this);
        }
        createMediaStreamSource(given: MediaStream) {
          expect(given).toBe(stream);
          return source;
        }
        createAnalyser() {
          return analyser;
        }
      },
    );

    const onLevel = vi.fn();
    const stop = startLevelMeter(stream, onLevel);
    expect(analyser.fftSize).toBe(1024);
    expect(source.connect).toHaveBeenCalledWith(analyser);
    expect(contexts[0].resume).toHaveBeenCalled();

    vi.advanceTimersByTime(160);
    expect(onLevel).toHaveBeenCalledTimes(3);
    expect(onLevel.mock.calls[0][0]).toBeCloseTo(0.25, 6);
    expect(typeof onLevel.mock.calls[0][1]).toBe("number");

    stop();
    stop();
    vi.advanceTimersByTime(500);
    expect(onLevel).toHaveBeenCalledTimes(3);
    expect(source.disconnect).toHaveBeenCalledTimes(1);
    expect(analyser.disconnect).toHaveBeenCalledTimes(1);
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
  });

  it("gives up quietly when the microphone can't be attached", () => {
    vi.useFakeTimers();
    const close = vi.fn(async () => {});
    vi.stubGlobal(
      "AudioContext",
      class {
        state = "running";
        close = close;
        createMediaStreamSource() {
          throw new DOMException("no audio track", "InvalidStateError");
        }
      },
    );
    const onLevel = vi.fn();
    startLevelMeter({} as MediaStream, onLevel)();
    vi.advanceTimersByTime(500);
    expect(onLevel).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });
});
