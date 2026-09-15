#!/bin/sh
# Git pre-push hook: refuse a push that would publish private data.
#
# Install once per clone:  ln -sf ../../scripts/pre-push-guard.sh .git/hooks/pre-push
#
# 1. Every commit about to leave (its added lines and its message) is searched
#    for LLM3_PRIVATE_TERMS from the git-ignored .env. The working-tree test
#    cannot see this: a term removed in a later commit still ships in history.
# 2. tests/no-personal-data.test.js runs on the tracked files.
#
# Bypass only with full knowledge: git push --no-verify

repo=$(git rev-parse --show-toplevel) || exit 1
zero=0000000000000000000000000000000000000000

terms=$(sed -n 's/^[[:space:]]*LLM3_PRIVATE_TERMS[[:space:]]*=[[:space:]]*//p' "$repo/.env" 2>/dev/null \
  | tail -n 1 | sed -E 's/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/')  # like src/local-env.js

failed=0
while read -r local_ref local_sha remote_ref remote_sha; do
  [ "$local_sha" = "$zero" ] && continue # a branch deletion carries no content
  if [ "$remote_sha" = "$zero" ]; then
    range="$local_sha --not --remotes"
  else
    range="$remote_sha..$local_sha"
  fi
  [ -n "$terms" ] || continue
  # shellcheck disable=SC2086 # $range is deliberately split into arguments
  hits=$(git log -p --no-color --format='@@commit %h %s%n%B' $range | awk -v terms="$terms" '
    BEGIN { n = split(tolower(terms), t, ","); for (i = 1; i <= n; i++) gsub(/^ +| +$/, "", t[i]) }
    /^@@commit / { commit = $2; inmsg = 1; next }
    /^diff --git / { inmsg = 0; next }
    {
      line = $0
      if (!inmsg) {
        if (substr(line, 1, 1) != "+" || substr(line, 1, 3) == "+++") next
      }
      low = tolower(line)
      for (i = 1; i <= n; i++) {
        if (t[i] != "" && index(low, t[i])) {
          printf "  %s %s: %s\n", commit, (inmsg ? "message" : "added line"), substr(line, 1, 100)
          break
        }
      }
    }')
  if [ -n "$hits" ]; then
    echo "pre-push: private terms in commits for $remote_ref:" >&2
    echo "$hits" >&2
    failed=1
  fi
done

if ! (cd "$repo" && node --test tests/no-personal-data.test.js >/dev/null 2>&1); then
  echo "pre-push: tests/no-personal-data.test.js fails; run it to see why." >&2
  failed=1
fi

if [ "$failed" -ne 0 ]; then
  echo "pre-push: push refused. Remove the data (rewrite unpushed commits if needed)." >&2
  exit 1
fi
exit 0
