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

`supabase/seed.sql` creates three teams with eight weeks of check-ins and three logins: `hq@example.com` (hq and admin, with the recordings and Big Five grants), `leader@example.com` and `member@example.com`. Request a link at `/login` and open it from Mailpit at http://127.0.0.1:54324.

```bash
pnpm supabase test db             # RLS tests in supabase/tests/: who can read and write what
```

**Tuning the heat-map:** the R/Y/G rules live in the single `scoring_settings` row: what each 1–5 score of activity, excellence and morale counts for, and the green and yellow thresholds. Members with the `admin` grant can change them (until the admin settings page exists, edit the row in the Supabase Table Editor). Score values have two decimals and must be between 0.01 and 1000. Thresholds also have two decimals: yellow must be above 0 and green at most 1,000,000. The database refuses settings outside these limits or that leave a colour unreachable. Colours are computed from the stored scores on every page load, so an edit recolours past weeks too.

**Admin grants** (`member_grants`): `admin` edits teams, scoring and other members (not `hq` members, not themselves; only the project owner makes someone `hq`); `recordings` plays anyone's submitted recording (never a draft); `big_five` reads and edits Big Five profiles. Only the project owner adds or removes grants, in the Supabase Table Editor, so no one can promote themselves through the app.

## Rules
See `CLAUDE.md` for the engineering contract. Hygiene is non-negotiable: protected `main`, migrations-in-Git, RLS on every table, CI + required Supabase migration check + an approving review before merge (CodeRabbit's counts). Claude merges a PR once CodeRabbit approves it, Greptile scores it 5/5 and CI passes, all on its latest commit. **No direct production changes. No merging past red CI or unticked pre-merge steps.**

### Branch protection
`main` is protected by the GitHub ruleset in `.github/rulesets/protect-main.json`, with no bypass (admins included):
- changes land only through a PR with 1 approval; a new push dismisses earlier approvals, and all review threads must be resolved
- the `ci / check` and `ci / migrations` jobs must pass, on a branch that is up to date with `main`
- `ci / migrations` applies every file in `supabase/migrations/` to a fresh local Supabase, and fails if one errors, leaves a table without RLS, or breaks an RLS test in `supabase/tests/`. Run it locally with `supabase db start && supabase db reset && scripts/check-migrations.sh && supabase test db`. `db reset` rebuilds the local database from the migrations and deletes its data; without it, an edited migration that was already applied is not retested
- no force-pushes, no deleting `main`

A classic branch-protection rule on `main` also applies until it is removed (required `check` on an up-to-date branch, conversations resolved, admins included). GitHub enforces both, so changing the JSON alone can't loosen what the classic rule requires.

To change the rules, edit the JSON in a PR. Once it merges, a repo admin re-applies it:
```bash
scripts/protect-main.sh           # needs `gh` logged in as a repo admin; creates or updates the ruleset
```
Without the CLI, first-time setup only: Settings → Rules → Rulesets → New ruleset → Import a ruleset, then pick the JSON file (an import always creates a new ruleset). For later changes, edit the existing `protect-main` ruleset on that page.
