#!/bin/sh
# Git commit-msg hook: a commit message is published with the history, so it
# may not carry the private LAN prefix either. Name the setting, not its value.
# Install: ln -sf ../../scripts/commit-msg-guard.sh .git/hooks/commit-msg
# Bypass only with full knowledge: git commit --no-verify

msg_file="$1"
needle="192""\.168"   # split so this script does not match itself
# Comment lines (git's template) are not part of the message.
if grep -v '^#' "$msg_file" | grep -nE "$needle" >/dev/null; then
  echo "commit-msg: refused -- the message contains a private LAN address:" >&2
  grep -v '^#' "$msg_file" | grep -nE "$needle" >&2
  exit 1
fi
exit 0
