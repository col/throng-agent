#!/bin/bash
# gh shim — installed at /usr/local/bin/gh, ahead of the real binary at
# /usr/local/bin/gh.real.
#
# `gh` reads GH_TOKEN from its environment, and an environment is fixed at
# execve(), so a token placed there at boot cannot be refreshed. Fetching one
# per invocation is the only way `gh` can outlive a 1 hour installation token.
#
# The two _BIN variables exist so the test suite can exercise this without
# installing anything; in the image both defaults are correct.

set -uo pipefail

CREDS_BIN="${THRONG_CREDS_BIN:-/usr/local/bin/throng-creds}"
GH_REAL="${GH_REAL_BIN:-/usr/local/bin/gh.real}"

# Unquoted on purpose: the test suite passes "bash /path/to/throng-creds.sh",
# which must split into two words. The installed value is a single path with no
# spaces. Command substitution captures stdout only, so throng-creds' own
# diagnostics still reach the terminal on stderr.
TOKEN=$($CREDS_BIN gh)

# On a decline or a failure, exec gh WITHOUT GH_TOKEN rather than with an empty
# one: gh then reports that it is not logged in, which is the actual problem,
# instead of an auth rejection that misdirects. throng-creds has already
# explained itself on stderr.
#
# `env -u` rather than a bare exec, because not setting GH_TOKEN is not the same
# as it being absent: anything that exported one into this process — a boot-time
# injection, a developer's shell — would otherwise be inherited, and a stale
# token would silently win on precisely the path documented to produce a clean
# "not logged in". The decline must not depend on the environment already being
# clean. `-u` is in both macOS and GNU coreutils env.
if [ -n "$TOKEN" ]; then
  exec env GH_TOKEN="$TOKEN" "$GH_REAL" "$@"
fi
exec env -u GH_TOKEN "$GH_REAL" "$@"
