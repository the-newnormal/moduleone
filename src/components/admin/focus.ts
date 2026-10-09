// Focus the element for the first selector once React has drawn it (a row moved by a dialog, a
// node just added, a heading after the row that was focused went away): tries for about a second,
// then falls back to the first of the others that exists. Used by both admin pages. Only the
// latest request counts: a new one cancels one still waiting.
let cancelPending: (() => void) | null = null;

export function focusSoon(first: string, ...fallbacks: string[]) {
  cancelFocusSoon();
  const find = (selector: string) => document.querySelector<HTMLElement>(selector);
  let tries = 0;
  let timer: number | undefined;
  const done = () => {
    cancelPending = null;
  };
  const attempt = () => {
    const element = find(first);
    if (!element && ++tries < 10) {
      timer = window.setTimeout(attempt, 100);
      return;
    }
    done();
    (element ?? fallbacks.map(find).find((fallback) => fallback !== null))?.focus();
  };
  const frame = window.requestAnimationFrame(attempt);
  cancelPending = () => {
    window.cancelAnimationFrame(frame);
    window.clearTimeout(timer);
    cancelPending = null;
  };
}

// Drops a focusSoon that's still waiting (tests call it between renders).
export function cancelFocusSoon() {
  cancelPending?.();
}
