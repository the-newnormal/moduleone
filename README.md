# moduleone

Normal's **team-health tool** — Module 1 of the Normal internal stack.

A weekly ~5-minute **360 check-in** (voice) scoring **Activity · Excellence · Morale**, transcribed and LLM-graded, rolled into a **Red/Yellow/Green heat-map** across teams and weeks. Built shallow + manual-input-first as a ~3-month stopgap.

## Stack
Next.js (App Router) · TypeScript · Tailwind + shadcn/ui · Supabase (Postgres + Auth, RLS) · Vercel. Reviewed by CodeRabbit (`.coderabbit.yaml`) and Qodo (`.pr_agent.toml`).

## Dev
```bash
pnpm install
cp .env.example .env.local        # fill in Supabase keys
pnpm supabase start               # local Postgres
pnpm supabase db reset            # apply migrations + seed
pnpm dev
```

`supabase/seed.sql` puts eight weeks of check-ins in three of the founding teams that migration 0003 loads (IP Lab 1, Atlas, Youth Day 1), plus Gather's head checking in at the division itself and Grace Lim (no login) at the organisation itself, and creates four logins: `hq@example.com` (hq and admin, with the recordings and Big Five grants), `leader@example.com`, `member@example.com` and `head@example.com` (Nora Lee, a leader who sits in the Gather division and so sees all of it). Request a link at `/login` and open it from Mailpit at http://127.0.0.1:54324.

To try **Give login** locally, also set `SUPABASE_SERVICE_ROLE_KEY` (the local secret or service_role key from `pnpm supabase status`) and `NEXT_PUBLIC_SITE_URL=http://localhost:3000` in `.env.local`; the invite arrives in Mailpit.

```bash
pnpm supabase test db             # RLS tests in supabase/tests/: who can read and write what
```

**The heat-map** is at `/portal/dashboard`. It opens on the **org chart**: a card per division, each domain and team inside it coloured R/Y/G for one week (this week by default; step back a week at a time), with bars for the eight weeks up to it. The **Trend** tab is teams × weeks (Singapore-time Mondays; the last 1, 4, 8 or 12, where a single week spells out each team's counts). Every box and cell is the mean score of that week's graded check-ins in the team and every team under it, and one that holds red check-ins says how many ("3 red"), since a green mean can hide them. Open one to read the check-ins, reviews and transcripts, team by team, and play recordings if you may. It reads with the viewer's own login, so RLS decides what each person sees: hq the whole org, a leader the teams they lead (the division and domain above them show uncoloured, since they can't read those check-ins). Members don't see grades; they're sent to their check-in.

**Tuning the heat-map:** the R/Y/G rules live in the single `scoring_settings` row: what each 1–5 score of activity, excellence and morale counts for, and the green and yellow thresholds. Members with the `admin` grant change them at `/admin/scoring`. Score values have two decimals and must be between 0.01 and 1000. Thresholds also have two decimals: yellow must be above 0 and green at most 999,999.99. The database refuses settings outside these limits or that leave a colour unreachable. Colours are computed from the stored scores on every page load, so an edit recolours past weeks too.

**Admin grants** (`member_grants`): `admin` edits teams, scoring and other members (not `hq` members, not themselves; only the project owner makes someone `hq`); `recordings` plays anyone's submitted recording (never a draft); `big_five` reads and edits Big Five profiles. Only the project owner adds or removes grants, in the Supabase Table Editor, so no one can promote themselves through the app.

**The admin pages** (`/admin`, linked from the portal for holders of the `admin` grant): the team structure, the scoring settings, and a page per division, domain or team (open it from the structure) where admins add and remove people, make them leaders or members, choose who else leads it, and give people a login. The structure is a top-down chart (React Flow): drag a box onto another to move it there (a team into a domain, a domain into a division), or use its ⋯ menu's Move to…; click a box for the same people and leads controls in a side panel; "Show people" puts everyone on the chart beside their box, to drag between teams. Anyone can sit in a division, a domain or a team (since migration 0005, a division's head sits in the division itself, so their check-ins are the division's own), and a leader leads where they sit and everything under it, plus any node they're added as a lead of. Above every division is the organisation, The New Normal (migration 0006): someone who sits there (placed by the project owner in the Supabase dashboard, never by an admin) leads every division and sees every check-in in them. Whoever sits in a division or the organisation leads it: placing a member there makes them a leader, and they can't be made a member while they sit there. A node's title for its leaders (`leader_title`, "President" for the organisation) is a label admins can rename; it never changes what anyone sees. The app calls the `hq` role "Master Admin"; it has nothing to do with the HQ division.

### Before inviting
"Give login" emails an invite from Supabase Auth, and the link brings the person back to this site signed in. On the hosted project, the owner does this once before the first invite:

1. **Custom SMTP** (Authentication → Emails → SMTP Settings), and a higher email rate limit (Authentication → Rate Limits). Supabase's built-in sender only mails members of the Supabase organisation, at most 2 emails an hour for the whole project, so invites to anyone else fail ("Supabase can't email that address yet"). Steps in [#7](https://github.com/the-newnormal/moduleone/issues/7).
2. **Site URL and redirect URLs** (Authentication → URL Configuration): Site URL is the production address (the invite link is built from it), and the redirect URLs include `<production URL>/auth/callback**`.
3. **The invite template** (Authentication → Emails → Templates → Invite user): subject "Your Module One login", and paste the whole of `supabase/templates/invite.html` as the body. Supabase's default invite link doesn't work with `/auth/callback`. Its link expires with the email OTP expiry (1 hour by default).
4. **Vercel environment variables**, then redeploy: `SUPABASE_SERVICE_ROLE_KEY` (Supabase → Project Settings → API keys: the secret key, or the legacy `service_role` key) as a **server-only** variable, never with a `NEXT_PUBLIC_` prefix, marked Sensitive; and `NEXT_PUBLIC_SITE_URL`, the production URL without a trailing slash, the same as the Site URL in step 2. Without them the page says logins can't be given yet.

Only the team page's `giveLogin` and `resendInvite` actions (`src/app/admin/teams/[id]/actions.ts`) and the check-in's server code (recording, transcribing and grading) use the service-role key, through `src/lib/supabase/admin.ts`. Give login records who gave each login and when, and never gives one to a Master Admin, to someone who already has a login, to someone who holds grants, or to a row that still has check-ins, a Big Five profile or recordings from an earlier login (a new login would inherit them; the project owner links those rows in the dashboard).

An invited person signs in from the invite link first. Until they do, `/login` can't send them a link (Supabase counts them as not signed up yet), and the link expires after an hour. If it expires or gets lost, an admin uses **Resend invite** on their row: Supabase sends a new link to the same address, and the old one stops working. For a mistyped address, the project owner deletes that user in Authentication → Users; the member goes back to "No login yet", and an admin gives the login again. Supabase also re-sends a pending invite when Give login is tried with an address another member was invited at and hasn't used yet: that member gets a new link (their old one stops working), and the admin is told "That email already has a login."

**Taking someone's login away:** delete the user in Authentication → Users, and remove the member's rows in `member_grants` too. The member row keeps its check-ins and recordings, so Give login won't link a new login to it.

## Rules
See `CLAUDE.md` for the engineering contract. Hygiene is non-negotiable: protected `main`, migrations-in-Git, RLS on every table, CI + required Supabase migration check + an approving review before merge (CodeRabbit's counts). Claude merges a PR once CodeRabbit approves it, Qodo's review leaves no open "Action required" finding and CI passes, all on its latest commit. **No direct production changes. No merging past red CI or unticked pre-merge steps.**

### Branch protection
`main` is protected by the GitHub ruleset in `.github/rulesets/protect-main.json`, with no bypass (admins included):
- changes land only through a PR with 1 approval; a new push dismisses earlier approvals, and all review threads must be resolved
- the `ci / check` and `ci / migrations` jobs must pass, on a branch that is up to date with `main`
- `ci / migrations` applies every file in `supabase/migrations/` to a fresh local Supabase, and fails if one errors, leaves a table without RLS, or breaks an RLS test in `supabase/tests/`. It then applies 0006 (the organisation) on top of people sitting in divisions, an archived division and check-ins (`scripts/check-organisation-upgrade.sh`), and 0003 (the team tree) on top of hand-made teams, members and check-ins (`scripts/check-team-tree-upgrade.sh`), as production gets them. Run it locally with `supabase db start && supabase db reset && scripts/check-migrations.sh && supabase test db`, then `supabase db reset --version 0005 --no-seed && scripts/check-organisation-upgrade.sh`, `supabase db reset --version 0002 --no-seed && scripts/check-team-tree-upgrade.sh && supabase db reset`. `db reset` rebuilds the local database from the migrations and deletes its data; without it, an edited migration that was already applied is not retested
- no force-pushes, no deleting `main`

A classic branch-protection rule on `main` also applies until it is removed (required `check` on an up-to-date branch, conversations resolved, admins included). GitHub enforces both, so changing the JSON alone can't loosen what the classic rule requires.

To change the rules, edit the JSON in a PR. Once it merges, a repo admin re-applies it:
```bash
scripts/protect-main.sh           # needs `gh` logged in as a repo admin; creates or updates the ruleset
```
Without the CLI, first-time setup only: Settings → Rules → Rulesets → New ruleset → Import a ruleset, then pick the JSON file (an import always creates a new ruleset). For later changes, edit the existing `protect-main` ruleset on that page.
