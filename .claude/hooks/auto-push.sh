#!/usr/bin/env bash
# Claude Code Stop hook: after every Claude response, commit everything in the
# working tree and push the current branch to GitHub. Each response is a
# checkpoint, so unfinished work is pushed too (squash-merge the PR).
#
# Guardrails (see CLAUDE.md):
#   - never commits or pushes on main/master or a detached HEAD
#   - never commits .env/key/credential files (only .env.example is allowed)
#     or files containing token-shaped secrets
#   - never pushes unpushed commits (e.g. ones Claude made itself) that touch
#     such files or tokens; those are left for a manual push
#   - skips while a merge/rebase/cherry-pick is in progress
#   - never force-pushes and never skips git hooks
#
# Opt out for a session: MODULEONE_AUTOPUSH=0 claude
set -uo pipefail

# Report to the user and stop. Hook output must be JSON: fold whitespace, then
# drop control characters, quotes and backslashes so the string stays valid.
say() {
  local text
  text=$(printf '%s' "$1" | tr '\n\r\t' '   ' | tr -d '\000-\037"\\')
  printf '{"systemMessage": "auto-push: %s"}\n' "$text"
  exit 0
}

# Paths that hold secrets, and token shapes for private keys, JWTs (Supabase
# keys), Anthropic/OpenAI, Supabase secret, GitHub and AWS keys.
SECRET_FILES='(^|/)(\.env[^/]*(/.*)?|\.netrc|\.pgpass|credentials[^/]*\.json|[^/]*service[-_]?account[^/]*\.json|[^/]*\.(pem|key|p12|pfx|jks|keystore)|id_(rsa|dsa|ecdsa|ed25519))$'
SECRET_TOKENS='-----BEGIN ([A-Z]+ )?PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|(^|[^A-Za-z0-9_-])sk-((ant|proj)-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{32,})|sb_secret_[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9]{36}|AKIA[0-9A-Z]{16}'
ENV_EXAMPLE='(^|/)\.env\.example$'

# Read NUL-separated paths on stdin; print the ones that look like secret files.
# Whole paths are matched, so a newline inside a filename can't split one.
secret_paths() {
  local f found=
  while IFS= read -r -d '' f; do
    if [[ $f =~ $SECRET_FILES && ! $f =~ $ENV_EXAMPLE ]]; then found+="$f "; fi
  done
  printf '%s' "$found"
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

# One run at a time per repository, so overlapping sessions can't commit or
# restore the index under each other. A lock older than 5 minutes is stale.
lock="$gitdir/autopush.lock"
[ -n "$(find "$lock" -maxdepth 0 -mmin +5 2>/dev/null)" ] && rmdir "$lock" 2>/dev/null
mkdir "$lock" 2>/dev/null || say "another auto-push is running on $branch, skipped"
backup=
trap '[ -n "$backup" ] && rm -f "$backup"; rmdir "$lock" 2>/dev/null' EXIT

if [ -n "$(git status --porcelain)" ]; then
  # Back up the index so a refusal leaves whatever the user had staged intact.
  index=$(git rev-parse --git-path index)
  backup=$(mktemp "$index.autopush.XXXXXX" 2>/dev/null) || backup=
  if [ -n "$backup" ] && ! cp "$index" "$backup" 2>/dev/null; then
    rm -f "$backup"; backup=
  fi
  restore() { if [ -n "$backup" ]; then mv -f "$backup" "$index"; else git reset -q; fi; }

  if ! out=$(git add -A 2>&1); then
    restore
    say "nothing committed - staging failed on $branch: $out"
  fi
  if [ -n "$(git diff --cached --name-only --diff-filter=d)" ]; then
    blocked=$(git diff --cached --name-only --diff-filter=d -z | secret_paths)
    if [ -z "$blocked" ]; then
      blocked=$(git diff --cached --name-only --diff-filter=d -z |
                  xargs -0 git grep --cached -l -z -E -e "$SECRET_TOKENS" -- | tr '\0' ' ')
    fi
    if [ -n "$blocked" ]; then
      restore
      say "nothing committed - possible secrets in: ${blocked% } (remove them or add to .gitignore)"
    fi
  fi
  if ! out=$(git commit -q -m "chore(auto): checkpoint after Claude Code run" 2>&1); then
    restore
    say "commit failed on $branch: $out"
  fi
fi

git remote get-url origin >/dev/null 2>&1 || say "no origin remote, nothing pushed"
if git rev-parse -q --verify "refs/remotes/origin/$branch" >/dev/null &&
   [ -z "$(git rev-list "origin/$branch..HEAD")" ]; then
  exit 0  # already up to date
fi

# Check every commit the push would send, not just the checkpoint above.
outgoing=(HEAD --not --remotes=origin)
blocked=$(git log --format= --name-only -z --diff-filter=d "${outgoing[@]}" | secret_paths)
if [ -z "$blocked" ]; then
  blocked=$(git log --text -G"$SECRET_TOKENS" --format=%h "${outgoing[@]}" | tr '\n' ' ')
fi
[ -n "$blocked" ] && say "not pushed - unpushed commits touch possible secrets: ${blocked% } (review, then push manually)"

# Retry transient network failures with backoff; a rejection won't fix itself.
for delay in 2 4 8 16 0; do
  if out=$(git push -q -u origin "$branch" 2>&1); then
    say "pushed $branch @ $(git rev-parse --short HEAD)"
  fi
  case "$out" in *rejected*|*denied*|*protected*) break ;; esac
  [ "$delay" -gt 0 ] && sleep "$delay"
done
say "push of $branch failed: $(printf '%s\n' "$out" | grep -v '^hint:')"
