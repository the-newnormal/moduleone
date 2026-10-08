# Module One — Engineering Contract

The Normal team-health tool: a weekly **360 check-in** (Activity · Excellence · Morale) → transcribed → LLM-graded → **Red/Yellow/Green heat-map** across teams and weeks. Keep it **shallow** — a review tool, not a task manager.

Stack: **Next.js (App Router) + TypeScript + Tailwind + shadcn/ui + Supabase + Vercel.**

## Git
- Never commit directly to `main`. Create a feature branch.
- Claude may merge a PR without asking once all three hold on its latest commit: CodeRabbit has approved it, Greptile's review scores it 5/5, and the CI `check` passed. Hold it while the PR lists unticked "Before merging" steps.
- Never bypass CI or branch protection. Don't post `@coderabbitai approve` unless the user asks; the approval must come from CodeRabbit's own review.
- Small, focused PRs.
- `main` protection lives in `.github/rulesets/protect-main.json` (applied with `scripts/protect-main.sh`), plus a classic branch-protection rule until that is removed. Change it only by PR; never loosen it in the GitHub UI.

## Database
- Never modify the production schema by hand. **All schema changes are migrations in `supabase/migrations/`.**
- **RLS ON for every table** (see 0001_init.sql, 0002). Members see their own check-ins and their team's members; leaders see check-ins made in their team; `hq` sees every team, member and check-in. Recordings and Big Five need the `recordings` / `big_five` grants, even for `hq`.
- Never expose the service-role key to the client — server-only.
- Members only **read**, through the Data API and Storage (see 0002). Check-in writes (transcripts, scores, mentions, recordings) go through server code using the service-role key, which takes the member from the session, never from the request.
- Admin edits are allowed by RLS only for holders of the matching grant in `member_grants` (`admin`: teams, other members' name/team/role except hq and themselves, `scoring_settings`; `big_five`: Big Five profiles). Only the project owner makes someone `hq`. Grants themselves are changed only by the project owner in the Supabase dashboard; never add an API write path for them. Linking a member to a login (`auth_user_id`) is server-side.
- New tables, views and functions get no grants by default (as on hosted Supabase): grant what's needed in the same migration, `revoke execute … from public` on new functions, and create views `with (security_invoker = true)` so RLS still applies.
- Recordings: private `checkin-audio` bucket, `<member_id>/<file>`. To record, the server creates a signed upload URL (upsert off) for a path it builds from the session, and the browser uploads straight to it. Only the speaker and holders of the `recordings` grant can play recordings. RLS tests live in `supabase/tests/` (`supabase test db`).
- Each check-in stores the team it was made in (`checkins.team_id`, filled from the member's team on insert). The heat-map groups by it, and leaders see check-ins by it. Teams are archived (`archived_at`), never deleted.
- Heat-map colours come from `src/lib/health` with the `scoring_settings` row (`settingsToConfig`), never from `checkins.category`.

## Security
- Never commit secrets (`.env*` is git-ignored; use `.env.example`).
- Never disable auth checks or weaken RLS without explicit review.

## Testing
- Add tests for new business logic. Write tests for the riskiest endpoints first: `transcribe()` and the rubric grader.
- Run `pnpm typecheck && pnpm lint && pnpm test` before opening a PR.

## Build philosophy
- build → simplify → automate. Manual-input-first.
- Scope guard: this is the 360 reviewer + weekly heat-map dashboard. Do NOT add a general task manager, CRM, or finance features.

## The thing to build (MVP by Friday)
1. Supabase magic-link auth → portal.
2. Weekly check-in page: "Start" records audio and auto-prompts 3 questions on screen
   - "What have you done this week?" → activity
   - "Where did you / your team use your superpower?" → excellence
   - "How are you feeling about the team?" → morale
3. `transcribe()` abstraction — web-API impl now, local Parakeet/OruKey impl stubbed behind the same interface.
4. Claude rubric-grader → `{ activity, excellence, morale, category, review }`, stored on the checkin.
5. Dashboard: teams × weeks grid, each cell R/Y/G from `activity × excellence × (morale as multiplier)`; click a cell to drill in.
