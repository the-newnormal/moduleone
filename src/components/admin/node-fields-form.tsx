"use client";

import { type ReactNode, startTransition, useId, useMemo, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { type ActionResult, settle } from "@/lib/admin/errors";
import { type NodeField, type NodeForm, parseNodeFields, typeOptions } from "@/lib/admin/node-fields";
import { NOTE_MAX, type TeamKind } from "@/lib/admin/validate";
import { ActionError } from "./action-error";

const NO_TYPE = "none"; // Radix Select items can't have an empty value

const FIELDS: readonly NodeField[] = ["name", "code", "type", "note"];

// The form for adding or editing a division, domain or team, as a dialog's content: name, code
// (upper-cased as you type), type (domains and divisions) and note, checked as you type with the
// same checks as the createNode and updateNode server actions (parseNodeFields). The Structure
// page uses it to add and edit, and a team's page for its Edit.
// - `saved`: the values it starts from. When editing, Save stays off until something changes.
// - `save` calls the server action with the form as typed (the action checks it again); on
//   success `onSaved` gets the action's value and the saved name, and the dialog decides what's
//   next. A refusal shows in the form, which stays open.
// - `onPendingChange` tells the dialog when a save starts and ends, so it can stay open meanwhile.
export function NodeFieldsForm<T>({
  kind,
  saved,
  editing,
  title,
  description,
  save,
  context,
  onSaved,
  onPendingChange,
}: {
  kind: TeamKind;
  saved: NodeForm;
  editing: boolean; // an existing node ("Save"), or a new one ("Add")
  title: string;
  description: ReactNode;
  save: (form: NodeForm) => Promise<ActionResult<T>>;
  context: string; // the server action's name, for the log if it throws
  onSaved: (value: T, name: string) => void;
  onPendingChange?: (pending: boolean) => void;
}) {
  const id = useId();
  const [form, setForm] = useState<NodeForm>(saved);
  const [touched, setTouched] = useState<Partial<Record<NodeField, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startSaving] = useTransition();

  const check = useMemo(() => parseNodeFields(kind, form), [kind, form]);
  const initial = useMemo(() => JSON.stringify(parseNodeFields(kind, saved)), [kind, saved]);
  const errors = check.ok ? {} : check.errors;
  const shown = (field: NodeField) => (submitted || touched[field] ? errors[field] : undefined);
  const unchanged = editing && JSON.stringify(check) === initial;
  const types = typeOptions(kind);

  const edit = (field: NodeField, value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
    setError(null);
  };
  const touch = (field: NodeField) => setTouched((current) => ({ ...current, [field]: true }));

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitted(true);
    if (!check.ok) {
      const first = FIELDS.find((f) => errors[f]);
      if (first) document.getElementById(`${id}-${first}`)?.focus();
      return;
    }
    if (unchanged || pending) return;
    const { name } = check.value;
    onPendingChange?.(true);
    startSaving(async () => {
      const result = await settle(() => save(form), context);
      // State set after an await isn't part of the transition unless wrapped again.
      startTransition(() => {
        onPendingChange?.(false);
        if (result.ok) onSaved(result.value, name);
        else setError(result.error);
      });
    });
  };

  const describedBy = (field: NodeField, help?: boolean) =>
    [help ? `${id}-${field}-help` : null, shown(field) ? `${id}-${field}-error` : null].filter(Boolean).join(" ") ||
    undefined;
  const fieldError = (field: NodeField) =>
    shown(field) ? (
      <p id={`${id}-${field}-error`} className="text-xs text-destructive">
        {shown(field)}
      </p>
    ) : null;
  const noteLength = [...form.note.replace(/\r\n?/g, "\n").trim()].length;

  return (
    <form onSubmit={submit} noValidate className="grid gap-5">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>

      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-name`}>Name</Label>
        <Input
          id={`${id}-name`}
          value={form.name}
          autoComplete="off"
          aria-required
          aria-invalid={shown("name") ? true : undefined}
          aria-describedby={describedBy("name")}
          onChange={(e) => edit("name", e.target.value)}
          onBlur={() => touch("name")}
        />
        {fieldError("name")}
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-code`}>Code</Label>
        <Input
          id={`${id}-code`}
          value={form.code}
          autoComplete="off"
          spellCheck={false}
          placeholder={kind === "team" ? "IP.1" : "IP.X"}
          className="max-w-40 font-mono"
          aria-invalid={shown("code") ? true : undefined}
          aria-describedby={describedBy("code", true)}
          onChange={(e) => {
            // Upper-case as you type, keeping the caret where it was.
            const input = e.target;
            const { selectionStart, selectionEnd } = input;
            input.value = input.value.toUpperCase();
            input.setSelectionRange(selectionStart, selectionEnd);
            edit("code", input.value);
          }}
          onBlur={() => touch("code")}
        />
        <p id={`${id}-code-help`} className="text-xs text-muted-foreground">
          Optional. 1–8 letters or digits, optionally a dot and 1–8 more, like IP.X or IP.1.
        </p>
        {fieldError("code")}
      </div>

      {types.length > 0 && (
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-type`}>Type</Label>
          <Select value={form.type || NO_TYPE} onValueChange={(v) => edit("type", v === NO_TYPE ? "" : v)}>
            <SelectTrigger
              id={`${id}-type`}
              className="w-full sm:w-72"
              aria-invalid={shown("type") ? true : undefined}
              aria-describedby={describedBy("type")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {types.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
              <SelectItem value={NO_TYPE}>No type</SelectItem>
            </SelectContent>
          </Select>
          {fieldError("type")}
        </div>
      )}

      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-note`}>Note</Label>
        <Textarea
          id={`${id}-note`}
          value={form.note}
          rows={3}
          aria-invalid={shown("note") ? true : undefined}
          aria-describedby={describedBy("note", true)}
          onChange={(e) => edit("note", e.target.value)}
          onBlur={() => touch("note")}
        />
        <p id={`${id}-note-help`} className="text-xs text-muted-foreground">
          Optional, shown under the name.{" "}
          <span className={noteLength > NOTE_MAX ? "text-destructive" : undefined}>
            {noteLength}/{NOTE_MAX}
          </span>
        </p>
        {fieldError("note")}
      </div>

      <ActionError message={error} />

      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline" disabled={pending}>
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" disabled={pending || unchanged}>
          {pending ? "Saving…" : editing ? "Save" : "Add"}
        </Button>
      </DialogFooter>
    </form>
  );
}
