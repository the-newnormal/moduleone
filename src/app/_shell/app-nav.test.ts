import { describe, expect, it } from "vitest";
import type { NavItem } from "@/lib/portal/access";
import { currentItem } from "./app-nav";

// The app bar marks the page the viewer is on (its section, on a page under it), so the same bar
// reads right on every page.
const ALL: NavItem[] = [
  { id: "portal", href: "/portal", label: "Portal" },
  { id: "checkin", href: "/portal/checkin", label: "Check-in" },
  { id: "team-health", href: "/portal/dashboard", label: "Team health" },
  { id: "admin", href: "/admin", label: "Admin" },
];

describe("currentItem", () => {
  it.each([
    ["/portal", "portal"],
    ["/portal/checkin", "checkin"],
    ["/portal/dashboard", "team-health"],
    ["/portal/dashboard/trend", "team-health"],
    ["/portal/dashboard/8d22479c-9e1f-4fc0-aa8b-bf71c4e32ed0/2026-10-05", "team-health"],
    ["/admin", "admin"],
    ["/admin/structure", "admin"],
    ["/admin/teams/8d22479c-9e1f-4fc0-aa8b-bf71c4e32ed0", "admin"],
  ] as const)("marks %s as %s", (path, id) => {
    expect(currentItem(ALL, path)).toBe(id);
  });

  it("marks Portal on the portal itself only, and nothing on a page no item leads to", () => {
    expect(currentItem(ALL, "/portal/somewhere-else")).toBeNull();
    expect(currentItem(ALL, "/portal/dashboardish")).toBeNull();
    expect(currentItem(ALL, "/administrator")).toBeNull();
  });

  it("marks nothing for an item the viewer isn't offered", () => {
    expect(currentItem(ALL.slice(0, 2), "/portal/dashboard")).toBeNull();
  });
});
