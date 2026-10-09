// Rendering client components into a real (happy-dom) document, for tests of what happens when
// people click and type. A test file opts in with `// @vitest-environment happy-dom` on its first
// line, then:
//   const page = await render(<Thing />);
//   await click(button("Save"));
//   expect(page.text()).toContain("Saved.");
// Dialogs render into document.body (a portal), so the helpers search the whole document.

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach } from "vitest";
import { cancelFocusSoon } from "@/components/admin/focus";

// Tells React that tests wrap updates in act(), so it flushes them before act() returns.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const unmount of mounted.splice(0)) await unmount();
  // Closing dialogs hand focus back a tick later (Radix), which may ask focusSoon to focus
  // something; don't let that reach the next test's page.
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  cancelFocusSoon();
  document.body.innerHTML = "";
});

export async function render(ui: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(ui));
  mounted.push(() => act(async () => root.unmount()));
  return {
    container,
    rerender: (next: ReactNode) => act(async () => root.render(next)),
  };
}

// The page's text, with whitespace collapsed.
export const text = (element: Element = document.body) => (element.textContent ?? "").replace(/\s+/g, " ").trim();

// Elements by role-ish selectors and their accessible text (textContent, collapsed).
function find<T extends Element>(selector: string, name: string | RegExp, within: ParentNode = document): T {
  const matches = [...within.querySelectorAll<T>(selector)].filter((el) => {
    const label = (el.getAttribute("aria-label") ?? text(el)).trim();
    return typeof name === "string" ? label === name : name.test(label);
  });
  if (matches.length !== 1) {
    throw new Error(`expected one ${selector} named ${String(name)}, found ${matches.length}`);
  }
  return matches[0];
}
export const button = (name: string | RegExp, within?: ParentNode) => find<HTMLButtonElement>("button", name, within);
export const queryButton = (name: string | RegExp, within: ParentNode = document) =>
  [...within.querySelectorAll("button")].find((el) => {
    const label = (el.getAttribute("aria-label") ?? text(el)).trim();
    return typeof name === "string" ? label === name : name.test(label);
  }) ?? null;
// The control a <label> names (by its text).
export function labelled<T extends HTMLElement = HTMLElement>(label: string): T {
  const element = [...document.querySelectorAll("label")].find((l) => text(l) === label);
  const control = element?.htmlFor ? document.getElementById(element.htmlFor) : null;
  if (!control) throw new Error(`no control labelled ${label}`);
  return control as T;
}
// Picks an option of a Radix Select the way its hidden native <select> reports a choice (the
// Select must sit in a form, which is where Radix renders that native select).
export async function choose(trigger: HTMLElement, value: string) {
  const native = trigger.parentElement?.querySelector("select");
  if (!native) throw new Error("no native select next to this trigger");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(native, value);
    native.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
export const dialog = () => document.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]');

// Interactions, each flushed with act().
export const click = (element: Element) =>
  act(async () => {
    (element as HTMLElement).click();
  });
export const press = (element: Element, key: string) =>
  act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true }));
  });
export const type = (input: HTMLInputElement | HTMLTextAreaElement, value: string) =>
  act(async () => {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
// Lets pending promises (a server action's result) settle and React re-render.
export const settle = () => act(async () => {});

// A promise the test resolves when it likes: a server action that's still running.
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
