import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GRADING_USD_PER_MTOK, rowCostUsd } from "@/lib/costs/costs";
import { GRADER_TIMEOUT_MS, gradeCheckin, type Grade } from "./index";

// Grades the same real transcripts with two models and saves the results side by side, to check
// that a cheaper model's reviews are as specific before switching ANTHROPIC_MODEL. Calls the real
// API, so it costs money: opt in with
//
//   ANTHROPIC_API_KEY=... RUN_GRADER_COMPARISON=1 GRADER_COMPARE_INPUT=transcripts.json \
//     pnpm vitest run src/lib/grader/compare.live.test.ts
//
// GRADER_COMPARE_INPUT is a JSON array of { "id": "...", "transcript": "..." }, e.g. exported from
// the Supabase SQL editor with
//   select id, transcript from checkins where transcript is not null order by submitted_at desc limit 10;
// GRADER_COMPARE_MODELS (default "claude-opus-5-5,claude-haiku-5-5": the model that graded until
// now, then the new one) and GRADER_COMPARE_OUTPUT (default grader-compare/) are optional.
// The transcripts and reviews are members' check-ins: grader-compare/ is git-ignored, keep the
// input file out of the repository too, and delete both once you've compared.
const live =
  Boolean(process.env.ANTHROPIC_API_KEY) && process.env.RUN_GRADER_COMPARISON === "1" && Boolean(process.env.GRADER_COMPARE_INPUT);

type Input = { id: string; transcript: string };
type Outcome = { grade: Grade; usd: number | null } | { error: string };

const models = (process.env.GRADER_COMPARE_MODELS ?? "claude-opus-5-5,claude-haiku-5-5")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

// Every billed attempt priced at its own model's rates; null if any can't be priced.
function costOf(grade: Grade): number | null {
  let total = 0;
  for (const { model, usage } of grade.attempts) {
    const usd = GRADING_USD_PER_MTOK[model]
      ? rowCostUsd({
          checkin_id: "comparison",
          live_session_id: null,
          step: "grading",
          model,
          audio_ms: null,
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          cache_read_tokens: usage.cacheReadTokens,
          cache_write_tokens: usage.cacheWriteTokens,
          created_at: new Date().toISOString(),
        })
      : null;
    if (usd === null) return null;
    total += usd;
  }
  return total;
}

const sum = (grade: Grade, key: keyof Grade["attempts"][number]["usage"]) =>
  grade.attempts.reduce((n, attempt) => n + attempt.usage[key], 0);

function markdown(inputs: Input[], results: Map<string, Outcome[]>): string {
  const lines = [`# Grader comparison: ${models.join(" vs ")}`, "", `${inputs.length} transcripts, ${new Date().toISOString()}.`, ""];
  // A total (and a monthly estimate) only when every transcript was graded and priced: a failed or
  // unpriced call counted as free would make a model look cheaper than it is.
  const totals = models.map((model, i) => {
    const outcomes = inputs.map((input) => results.get(input.id)?.[i]);
    const failed = outcomes.filter((o) => !o || "error" in o).length;
    const unpriced = outcomes.filter((o) => o && "grade" in o && o.usd === null).length;
    if (failed || unpriced) {
      return `- **${model}**: incomplete (${failed} failed, ${unpriced} not priced), so no total or estimate`;
    }
    const usd = outcomes.reduce((n, o) => n + (o && "grade" in o ? (o.usd ?? 0) : 0), 0);
    return `- **${model}**: US$${usd.toFixed(4)} for these ${inputs.length} (about US$${((usd / inputs.length) * 433).toFixed(2)} a month at 433 check-ins)`;
  });
  lines.push("## Cost", "", ...totals, "");
  for (const input of inputs) {
    lines.push(`## ${input.id}`, "", "<details><summary>Transcript</summary>", "", input.transcript, "", "</details>", "");
    results.get(input.id)?.forEach((outcome, i) => {
      lines.push(`### ${models[i]}`, "");
      if ("error" in outcome) {
        lines.push(`Failed: ${outcome.error}`, "");
        return;
      }
      const { grade } = outcome;
      lines.push(
        `Activity ${grade.activity} · Excellence ${grade.excellence} · Morale ${grade.morale} · ${grade.category}` +
          (grade.model === models[i] ? "" : ` (answered by ${grade.model})`),
        "",
        grade.review,
        "",
        `_${sum(grade, "inputTokens") + sum(grade, "cacheReadTokens") + sum(grade, "cacheWriteTokens")} tokens in ` +
          `(${sum(grade, "cacheReadTokens")} from cache), ${sum(grade, "outputTokens")} out` +
          (grade.attempts.length > 1 ? ` over ${grade.attempts.length} attempts` : "") +
          (outcome.usd === null ? "_" : `, US$${outcome.usd.toFixed(5)}_`),
        "",
      );
    });
  }
  return lines.join("\n");
}

describe.skipIf(!live)("grader comparison against the real API", () => {
  it("grades every transcript with each model and saves the results", { timeout: 30 * 60_000 }, async () => {
    const inputs = JSON.parse(readFileSync(process.env.GRADER_COMPARE_INPUT!, "utf8")) as Input[];
    expect(Array.isArray(inputs) && inputs.every((i) => typeof i.id === "string" && typeof i.transcript === "string")).toBe(true);

    const results = new Map<string, Outcome[]>();
    // One transcript at a time, both models in parallel: consecutive calls to a model reuse its
    // cached rubric, as they would in production.
    for (const input of inputs) {
      const outcomes = await Promise.all(
        models.map(async (model): Promise<Outcome> => {
          try {
            const grade = await gradeCheckin({ transcript: input.transcript, model, signal: AbortSignal.timeout(GRADER_TIMEOUT_MS) });
            return { grade, usd: costOf(grade) };
          } catch (error) {
            return { error: error instanceof Error ? error.message : String(error) };
          }
        }),
      );
      results.set(input.id, outcomes);
    }

    const dir = process.env.GRADER_COMPARE_OUTPUT || "grader-compare";
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    writeFileSync(join(dir, `compare-${stamp}.md`), markdown(inputs, results));
    writeFileSync(
      join(dir, `compare-${stamp}.json`),
      JSON.stringify(
        inputs.map((input) => ({ id: input.id, results: Object.fromEntries(models.map((m, i) => [m, results.get(input.id)?.[i]])) })),
        null,
        2,
      ),
    );
    console.log(`Saved the comparison to ${dir}/compare-${stamp}.md`);
  });
});
