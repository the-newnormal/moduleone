import type { Metadata } from "next";
import { logError } from "@/lib/admin/errors";
import { readAll } from "@/lib/admin/read-all";
import { requireAdminPage } from "@/lib/admin/session";
import { costHistoryStart, monthlyCosts, type CostRow } from "@/lib/costs/costs";
import { graderModel } from "@/lib/grader";
import { sttConfig } from "@/lib/stt/config";

export const metadata: Metadata = { title: "Costs · Admin · Module One" };

const usd = (value: number) => `US$${value.toFixed(value < 1 ? 4 : 2)}`;
const count = (value: number) => Math.round(value).toLocaleString("en-SG");

export default async function CostsPage() {
  const { supabase } = await requireAdminPage("/admin/costs");

  const since = costHistoryStart();
  const { data, error } = await readAll<CostRow>((from, to) =>
    supabase
      .from("processing_costs")
      .select("checkin_id, step, model, audio_ms, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, created_at")
      .gte("created_at", since)
      .order("id")
      .range(from, to),
  );
  if (error) {
    logError("load processing costs", error);
    throw new Error("Couldn't load the processing costs.");
  }
  const months = monthlyCosts(data);

  let transcriber: string;
  try {
    const { primary } = sttConfig();
    transcriber = `${primary.provider}:${primary.model}`;
  } catch {
    transcriber = "misconfigured (check STT_PROVIDER)";
  }

  return (
    <>
      <header className="grid gap-2">
        <h1 className="text-4xl">Costs</h1>
        <p className="max-w-3xl text-muted-foreground">
          What transcribing and grading check-ins cost, by month (Singapore time), worked out from
          the minutes and tokens each call used and today&apos;s list prices. Use it to check the
          OpenAI and Anthropic bills; it is an estimate, not the bill. Only calls that succeeded are
          counted, so retries after a failure can make the bill a little higher.
        </p>
        <p className="text-sm text-muted-foreground">
          Transcribing with <span className="text-foreground">{transcriber}</span>, grading with{" "}
          <span className="text-foreground">{graderModel()}</span> (ANTHROPIC_MODEL).
        </p>
      </header>

      {months.length === 0 ? (
        <p className="text-muted-foreground">No check-ins have been processed yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm tabular-nums">
            <thead className="text-left text-muted-foreground">
              <tr className="border-b">
                <th className="py-2 pr-4 font-medium">Month</th>
                <th className="py-2 pr-4 text-right font-medium">Check-ins</th>
                <th className="py-2 pr-4 text-right font-medium">Audio min</th>
                <th className="py-2 pr-4 text-right font-medium">Transcription</th>
                <th className="py-2 pr-4 text-right font-medium">Gradings</th>
                <th className="py-2 pr-4 text-right font-medium">Tokens in</th>
                <th className="py-2 pr-4 text-right font-medium">Tokens out</th>
                <th className="py-2 pr-4 text-right font-medium">Grading</th>
                <th className="py-2 pr-4 text-right font-medium">Total</th>
                <th className="py-2 text-right font-medium">Per check-in</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m) => (
                <tr key={m.month} className="border-b align-top">
                  <th scope="row" className="py-2 pr-4 text-left font-medium">
                    {m.month}
                    {m.unpriced.length > 0 && (
                      <span className="block text-xs font-normal text-muted-foreground">
                        Not priced: {m.unpriced.join(", ")}
                      </span>
                    )}
                  </th>
                  <td className="py-2 pr-4 text-right">{count(m.checkins)}</td>
                  <td className="py-2 pr-4 text-right">{m.audioMinutes.toFixed(1)}</td>
                  <td className="py-2 pr-4 text-right">{usd(m.transcriptionUsd)}</td>
                  <td className="py-2 pr-4 text-right">{count(m.gradings)}</td>
                  <td className="py-2 pr-4 text-right">{count(m.inputTokens)}</td>
                  <td className="py-2 pr-4 text-right">{count(m.outputTokens)}</td>
                  <td className="py-2 pr-4 text-right">{usd(m.gradingUsd)}</td>
                  <td className="py-2 pr-4 text-right font-medium">{usd(m.totalUsd)}</td>
                  <td className="py-2 text-right">{m.checkins ? usd(m.totalUsd / m.checkins) : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
