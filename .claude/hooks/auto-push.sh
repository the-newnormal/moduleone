#!/usr/bin/env bash
# Claude Code Stop hook: when a run finishes, commit everything in the working
# tree and push the current branch to GitHub.
#
# Guardrails (see CLAUDE.md):
#   - never commits or pushes on main/master or a detached HEAD
#   - never commits .env files (only .env.example is allowed)
#   - skips while a merge/rebase/cherry-pick is in progress
#   - never force-pushes and never skips git hooks
#
# Opt out for a session: MODULEONE_AUTOPUSH=0 claude
set -uo pipefail

# Report to the user and stop. Hook output must be JSON; strip characters that
# would break the hand-built string.
say() {
  local text
  text=$(printf '%s' "$1" | tr -d '"\\' | tr '\n\t' '  ')
  printf '{"systemMessage": "auto-push: %s"}\n' "$text"
  exit 0
}

[ "${MODULEONE_AUTOPUSH:-1}" = "0" ] && exit 0
cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

branch=$(git symbolic-ref --short -q HEAD) || say "detached HEAD, skipped"
case "$branch" in
  main|master) say "on $branch, skipped (never commit to $branch; create a feature branch)" ;;
esac

gitdir=$(git rev-parse --git-dir)
for marker in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD rebase-merge rebase-apply; do
  [ -e "$gitdir/$marker" ] && say "merge/rebase in progress on $branch, skipped"
done

if [ -n "$(git status --porcelain)" ]; then
  git add -A
  envfiles=$(git diff --cached --name-only | grep -E '(^|/)\.env' | grep -vE '(^|/)\.env\.example$')
  if [ -n "$envfiles" ]; then
    git reset -q
    say "refusing to commit env file(s): $envfiles - add them to .gitignore"
  fi
  if ! out=$(git commit -q -m "chore(auto): checkpoint after Claude Code run" 2>&1); then
    say "commit failed on $branch: $out"
  fi
fi

git remote get-url origin >/dev/null 2>&1 || say "no origin remote, nothing pushed"
if git rev-parse -q --verify "refs/remotes/origin/$branch" >/dev/null &&
   [ -z "$(git rev-list "origin/$branch..HEAD")" ]; then
  exit 0  # already up to date
fi

# Retry transient network failures with backoff; a rejection won't fix itself.
for delay in 2 4 8 16 0; do
  if out=$(git push -q -u origin "$branch" 2>&1); then
    say "pushed $branch @ $(git rev-parse --short HEAD)"
  fi
  case "$out" in *rejected*|*denied*|*protected*) break ;; esac
  [ "$delay" -gt 0 ] && sleep "$delay"
done
say "push of $branch failed: $(printf '%s\n' "$out" | grep -v '^hint:')"
