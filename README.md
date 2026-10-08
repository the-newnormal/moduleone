# moduleone

Normal's **team-health tool** — Module 1 of the Normal internal stack.

A weekly ~5-minute **360 check-in** (voice) scoring **Activity · Excellence · Morale**, transcribed and LLM-graded, rolled into a **Red/Yellow/Green heat-map** across teams and weeks. Built shallow + manual-input-first as a ~3-month stopgap.

## Stack
Next.js (App Router) · TypeScript · Tailwind + shadcn/ui · Supabase (Postgres + Auth, RLS) · Vercel. Reviewed by CodeRabbit; Greptile for codebase intel.

## Dev
```bash
pnpm install
cp .env.example .env.local        # fill in Supabase keys
pnpm supabase start               # local Postgres
pnpm supabase db reset            # apply migrations + seed
pnpm dev
```

## Rules
See `CLAUDE.md` for the engineering contract. Hygiene is non-negotiable: protected `main`, migrations-in-Git, RLS on every table, CI + required Supabase migration check + human approval before merge. **No direct production changes. No blind auto-merging.**

### Branch protection
`main` is protected by the GitHub ruleset in `.github/rulesets/protect-main.json`, with no bypass (admins included):
- changes land only through a PR with 1 approval; a new push dismisses earlier approvals, and all review threads must be resolved
- the `ci / check` job must pass, on a branch that is up to date with `main`
- no force-pushes, no deleting `main`

A classic branch-protection rule on `main` also applies until it is removed (required `check` on an up-to-date branch, conversations resolved, admins included). GitHub enforces both, so changing the JSON alone can't loosen what the classic rule requires.

To change the rules, edit the JSON in a PR. Once it merges, a repo admin re-applies it:
```bash
scripts/protect-main.sh           # needs `gh` logged in as a repo admin; creates or updates the ruleset
```
Without the CLI, first-time setup only: Settings → Rules → Rulesets → New ruleset → Import a ruleset, then pick the JSON file (an import always creates a new ruleset). For later changes, edit the existing `protect-main` ruleset on that page.
