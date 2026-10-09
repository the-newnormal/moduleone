import { cn } from "@/lib/utils";

// Why an admin action didn't happen (the database's own sentence, or a check before it), shown
// the same way in every admin form and dialog. Renders nothing without a message.
export function ActionError({ message, className }: { message: string | null | undefined; className?: string }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className={cn("rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive", className)}
    >
      {message}
    </p>
  );
}
