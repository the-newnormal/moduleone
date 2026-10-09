import Link from "next/link";
import type { Crumb, TeamSummary } from "@/app/admin/teams/[id]/team-view";
import { Badge } from "@/components/ui/badge";
import { EditTeamDialog } from "./edit-team-dialog";
import type { TeamActions } from "./types";

// The top of a team's page: where it sits (Structure › division › domain), its name with Edit, its
// kind, type, code and note.
export function TeamHeader({
  team,
  crumbs,
  updateNode,
}: {
  team: TeamSummary;
  crumbs: Crumb[];
  updateNode: TeamActions["updateNode"];
}) {
  const trail: Crumb[] = [{ key: "structure", label: "Structure", href: "/admin/structure" }, ...crumbs];

  return (
    <header className="grid gap-2">
      <nav aria-label="Breadcrumb">
        <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-muted-foreground">
          {trail.map((crumb) => (
            <li key={crumb.key} className="flex items-center gap-1.5">
              {crumb.href ? (
                <Link href={crumb.href} className="hover:text-foreground hover:underline">
                  {crumb.label}
                </Link>
              ) : (
                <span>{crumb.label}</span>
              )}
              <span aria-hidden="true">›</span>
            </li>
          ))}
          <li>
            <span aria-current="page" className="text-foreground">
              {team.name}
            </span>
          </li>
        </ol>
      </nav>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h1 className="min-w-0 text-4xl break-words">{team.name}</h1>
        <EditTeamDialog team={team} updateNode={updateNode} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{team.kindLabel}</Badge>
        {team.typeLabel && <Badge variant="secondary">{team.typeLabel}</Badge>}
        {team.code && (
          <Badge variant="outline" className="font-mono">
            <span className="sr-only">Code </span>
            {team.code}
          </Badge>
        )}
        {team.archived && <Badge variant="destructive">Archived</Badge>}
      </div>
      {team.note && <p className="max-w-3xl whitespace-pre-line text-muted-foreground">{team.note}</p>}
    </header>
  );
}
