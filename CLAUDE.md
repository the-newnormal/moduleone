# Module One — Engineering Contract

The Normal team-health tool: a weekly **360 check-in** (Activity · Excellence · Morale) → transcribed → LLM-graded → **Red/Yellow/Green heat-map** across teams and weeks. Keep it **shallow** — a review tool, not a task manager.

Stack: **Next.js (App Router) + TypeScript + Tailwind + shadcn/ui + Supabase + Vercel.**

## Git
- Never commit directly to `main`. Create a feature branch.
- Never merge your own PR. Never bypass CI.
- Small, focused PRs.
- `main` protection lives in `.github/rulesets/protect-main.json` (applied with `scripts/protect-main.sh`), plus a classic branch-protection rule until that is removed. Change it only by PR; never loosen it in the GitHub UI.

## Database
- Never modify the production schema by hand. **All schema changes are migrations in `supabase/migrations/`.**
- **RLS ON for every table** (see 0001_init.sql). Members see their own + their team's rows; `hq` sees all.
- Never expose the service-role key to the client — server-only.

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
