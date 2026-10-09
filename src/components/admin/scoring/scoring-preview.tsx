import { BANDS } from "@/app/portal/dashboard/band";
import { scoringPreview } from "@/lib/admin/scoring";
import { type Band, formatScore, type HealthConfig } from "@/lib/health/health";

const ORDER: readonly Band[] = ["green", "yellow", "red"];

// How the heat-map would colour every possible check-in under `config`: counts, then one small
// grid per morale level. Each cell has an icon shape and a word (for screen readers) besides its
// colour, and its score via formatScore, so a number never contradicts its colour.
export function ScoringPreview({ config }: { config: HealthConfig }) {
  const { counts, grids } = scoringPreview(config);

  return (
    <div className="grid gap-5">
      <div className="grid gap-2">
        <p>Of the 125 possible check-ins (every combination of grades):</p>
        <ul className="flex flex-wrap gap-x-5 gap-y-1.5" aria-label="Check-ins by colour">
          {ORDER.map((band) => {
            const { label, Icon, icon, tint } = BANDS[band];
            return (
              <li
                key={band}
                className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 font-medium ${tint}`}
              >
                <Icon aria-hidden className={`size-4 ${icon}`} strokeWidth={2.25} />
                <span className="tabular-nums">{counts[band]}</span> {label.toLowerCase()}
              </li>
            );
          })}
        </ul>
        <p className="text-sm text-muted-foreground">
          One grid per morale grade. Rows are activity (5 at the top), columns excellence (1 to 5);
          each cell shows that check-in&apos;s score.
        </p>
      </div>

      <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-6">
        {grids.map((grid) => (
          <div key={grid.morale} className="overflow-x-auto">
            <table className="border-separate border-spacing-0.5 text-xs tabular-nums">
              <caption className="mb-1 text-left text-sm font-medium">
                Morale {grid.morale}{" "}
                <span className="font-normal text-muted-foreground">(weight {grid.weight})</span>
              </caption>
              <thead>
                <tr>
                  <td />
                  {grid.rows[0].map((cell) => (
                    <th key={cell.excellence} scope="col" className="px-1 font-medium text-muted-foreground">
                      <span aria-hidden>E{cell.excellence}</span>
                      <span className="sr-only">Excellence {cell.excellence}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {grid.rows.map((row) => (
                  <tr key={row[0].activity}>
                    <th scope="row" className="pr-1 text-left font-medium text-muted-foreground">
                      <span aria-hidden>A{row[0].activity}</span>
                      <span className="sr-only">Activity {row[0].activity}</span>
                    </th>
                    {row.map((cell) => {
                      const { label, Icon, icon, tint } = BANDS[cell.band];
                      return (
                        <td key={cell.excellence} className={`rounded-sm px-1 py-0.5 ${tint}`}>
                          <span className="flex items-center gap-0.5 whitespace-nowrap">
                            <Icon aria-hidden className={`size-3 shrink-0 ${icon}`} strokeWidth={2.5} />
                            {formatScore(cell.score, config)}
                            <span className="sr-only">, {label}</span>
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  );
}
