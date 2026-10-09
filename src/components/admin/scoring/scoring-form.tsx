"use client";

import { startTransition, useId, useMemo, useState, useTransition } from "react";
import { ActionError } from "@/components/admin/action-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type ActionResult, settle } from "@/lib/admin/errors";
import {
  canSaveScoring,
  checkScoringForm,
  DEFAULT_FORM,
  METRIC_LABELS,
  METRICS,
  SCORES,
  type ScoringField,
  type ScoringForm as Form,
  sameScoring,
} from "@/lib/admin/scoring";
import { ScoringPreview } from "./scoring-preview";

type Status =
  | { kind: "idle" }
  | { kind: "saved" }
  | { kind: "defaults" } // the defaults are filled in, and differ from what's saved
  | { kind: "defaults-saved" } // the defaults are filled in, and they're what's saved
  | { kind: "error"; message: string };

const METRIC_HELP = {
  activity: "What each activity grade counts for, from 1 (lowest) to 5.",
  excellence: "What each excellence grade counts for, from 1 (lowest) to 5.",
  morale:
    "Morale weighs the other two: below 1 lowers a check-in's score, above 1 raises it.",
} as const;

// The scoring settings form: 15 score values and two thresholds, checked as you type (the same
// checks as the database), with a live preview of how every possible check-in would be coloured.
// `saved` is the stored row as form text; `save` is the server action.
export function ScoringForm({
  saved,
  save,
}: {
  saved: Form;
  save: (form: Form) => Promise<ActionResult>;
}) {
  const id = useId();
  const [form, setForm] = useState<Form>(saved);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [pending, startSaving] = useTransition();

  const check = useMemo(() => checkScoringForm(form), [form]);
  const fieldErrors: Partial<Record<ScoringField, string>> = check.ok ? {} : check.fieldErrors;
  const problems = check.ok ? check.problems : [];
  const changed = !sameScoring(form, saved);
  const canSave = canSaveScoring(check, changed, pending);

  const edit = (field: ScoringField, value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
    setStatus({ kind: "idle" });
  };

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSave) return;
    startSaving(async () => {
      const result = await settle(() => save(form), "saveScoring");
      // State set after an await isn't part of the transition unless wrapped again.
      startTransition(() =>
        setStatus(result.ok ? { kind: "saved" } : { kind: "error", message: result.error }),
      );
    });
  };

  const input = (field: ScoringField, label: React.ReactNode, className = "") => {
    const inputId = `${id}-${field}`;
    const error = fieldErrors[field];
    return (
      <div key={field} className={`grid content-start gap-1.5 ${className}`}>
        <Label htmlFor={inputId}>{label}</Label>
        <Input
          id={inputId}
          name={field}
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          value={form[field]}
          onChange={(e) => edit(field, e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${inputId}-error` : undefined}
          className="tabular-nums"
        />
        {error && (
          <p id={`${inputId}-error`} className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
    );
  };

  return (
    <form onSubmit={submit} noValidate className="grid gap-8">
      <div className="grid gap-6">
        {METRICS.map((metric) => (
          <fieldset key={metric} className="grid gap-3 rounded-xl border bg-card p-5">
            <legend className="px-1 text-lg font-semibold">{METRIC_LABELS[metric]}</legend>
            <p className="text-sm text-muted-foreground">{METRIC_HELP[metric]}</p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              {SCORES.map((score) =>
                input(
                  `${metric}_${score}`,
                  <>
                    <span className="sr-only">{METRIC_LABELS[metric]} grade </span>
                    {score}
                  </>,
                ),
              )}
            </div>
          </fieldset>
        ))}

        <fieldset className="grid gap-3 rounded-xl border bg-card p-5">
          <legend className="px-1 text-lg font-semibold">Thresholds</legend>
          <p className="text-sm text-muted-foreground">
            A check-in&apos;s score is activity × excellence × morale. At or above the green threshold
            it&apos;s green, at or above the yellow one yellow, and red below that.
          </p>
          <div className="grid gap-3 sm:grid-cols-2 sm:max-w-md">
            {input("green_threshold", "Green at or above")}
            {input("yellow_threshold", "Yellow at or above")}
          </div>
        </fieldset>
      </div>

      <div aria-live="polite" className="grid gap-2 empty:hidden">
        {problems.length > 0 && (
          <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm">
            <p className="font-medium">These settings can&apos;t be saved yet:</p>
            <ul className="mt-1 list-disc pl-5">
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={!canSave}>
          {pending ? "Saving…" : "Save settings"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => {
            setForm({ ...DEFAULT_FORM });
            setStatus({ kind: sameScoring(DEFAULT_FORM, saved) ? "defaults-saved" : "defaults" });
          }}
        >
          Reset to defaults
        </Button>
        <p role="status" className="text-sm">
          {status.kind === "saved" && "Saved. The heat-map uses these settings now, for past weeks too."}
          {status.kind === "defaults" && "Filled in the defaults. Save to use them."}
          {status.kind === "defaults-saved" && "These are the defaults, and they're already saved."}
        </p>
      </div>
      <ActionError message={status.kind === "error" ? status.message : null} className="-mt-4" />

      <section aria-labelledby={`${id}-preview`} className="grid gap-3">
        <h2 id={`${id}-preview`} className="text-2xl">
          Preview
        </h2>
        {check.ok ? (
          <ScoringPreview config={check.config} />
        ) : (
          <p className="text-muted-foreground">The preview shows once every value is a number.</p>
        )}
      </section>
    </form>
  );
}
