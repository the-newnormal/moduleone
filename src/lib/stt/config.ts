import type { SttProvider, SttTarget } from "./types";

// Which speech-to-text model runs, read when a recording is transcribed (never at import time,
// so `next build` works without these set).
//   STT_PROVIDER  openai (default) | local
//   STT_MODEL     blank means the provider's default below
//   STT_FALLBACK  "<provider>:<model>", tried once when the main model fails in a way another model
//                 might not (outage, timeout, no access to it); "none" turns it off

export const DEFAULT_MODELS: Record<SttProvider, string> = {
  // OpenAI's model for transcribing finished recordings.
  openai: "gpt-transcribe",
  // Whatever the local OpenAI-compatible server calls its model.
  local: "parakeet",
};

export const DEFAULT_FALLBACK = "openai:whisper-1";

function parseProvider(value: string): SttProvider | null {
  const v = value.trim().toLowerCase();
  return v === "openai" || v === "local" ? v : null;
}

export function sttConfig(env: Record<string, string | undefined> = process.env): {
  primary: SttTarget;
  fallback: SttTarget | null;
} {
  const raw = env.STT_PROVIDER?.trim() || "openai";
  const provider = parseProvider(raw);
  if (!provider) throw new Error(`Unknown STT_PROVIDER "${raw}". Use openai or local.`);
  const primary = { provider, model: env.STT_MODEL?.trim() || DEFAULT_MODELS[provider] };

  const spec = (env.STT_FALLBACK ?? DEFAULT_FALLBACK).trim();
  if (!spec || spec.toLowerCase() === "none") return { primary, fallback: null };
  const colon = spec.indexOf(":");
  const fallbackProvider = parseProvider(colon === -1 ? spec : spec.slice(0, colon));
  if (!fallbackProvider) throw new Error(`Unknown STT_FALLBACK "${spec}". Use <provider>:<model> or none.`);
  const fallback = {
    provider: fallbackProvider,
    model: (colon === -1 ? "" : spec.slice(colon + 1).trim()) || DEFAULT_MODELS[fallbackProvider],
  };
  // Falling back to the same model would only repeat the failure.
  const same = fallback.provider === primary.provider && fallback.model === primary.model;
  return { primary, fallback: same ? null : fallback };
}
