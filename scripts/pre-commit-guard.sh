#!/bin/sh
# Git pre-commit hook: refuse a commit that would record private data.
#
# Install once per clone (hooks are not versioned):
#   ln -sf ../../scripts/pre-commit-guard.sh .git/hooks/pre-commit
#   ln -sf ../../scripts/commit-msg-guard.sh .git/hooks/commit-msg
#
# Runs on the staged content -- what the commit will record:
#   tests/no-lan-addresses.test.js   no private LAN prefix in any committed file
#   tests/no-personal-data.test.js   personal markers, credentials, artifacts
# The commit message is checked by scripts/commit-msg-guard.sh.
#
# Bypass only with full knowledge: git commit --no-verify

repo=$(git rev-parse --show-toplevel) || exit 1
cd "$repo" || exit 1

if ! node --test tests/no-lan-addresses.test.js tests/no-personal-data.test.js >/tmp/llm3-pre-commit.$$ 2>&1; then
  echo "pre-commit: refused -- private data would be committed." >&2
  grep -E '✖|private LAN prefix|^\s+[a-zA-Z0-9_./-]+:[0-9]+' /tmp/llm3-pre-commit.$$ | head -40 >&2
  rm -f /tmp/llm3-pre-commit.$$
  exit 1
fi
rm -f /tmp/llm3-pre-commit.$$
exit 0
