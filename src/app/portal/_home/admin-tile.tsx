import { ChevronRight } from "lucide-react";
import Link from "next/link";
import type { HealthConfig } from "@/lib/health/health";
import { Tile } from "./tile";

// For holders of the admin grant: the way into the admin pages, and the thresholds in force. Links
// only; /admin checks the grant again itself.
export function AdminTile({ thresholds }: { thresholds: HealthConfig["thresholds"] | null }) {
  const links = [
    {
      href: "/admin/structure",
      label: "Structure",
      hint: "Divisions, domains, teams, people and who leads them.",
    },
    {
      href: "/admin/scoring",
      label: "Scoring",
      hint: thresholds
        ? `Green ${thresholds.green} or more · Yellow ${thresholds.yellow} to under ${thresholds.green} · Red under ${thresholds.yellow}`
        : "Weights and thresholds.",
    },
  ];
  return (
    <Tile id="admin" title="Admin">
      <ul className="-mx-2 grid">
        {links.map(({ href, label, hint }) => (
          <li key={href} className="border-b last:border-b-0">
            <Link
              href={href}
              className="flex min-h-12 items-center justify-between gap-3 rounded-md px-2 py-2.5 hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <span className="grid gap-0.5">
                <span className="text-[15px] leading-[22px] font-medium">{label}</span>
                <span className="text-[13px] leading-[18px] text-muted-foreground">{hint}</span>
              </span>
              <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            </Link>
          </li>
        ))}
      </ul>
    </Tile>
  );
}
