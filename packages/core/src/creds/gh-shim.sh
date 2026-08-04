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
if [ -n "$TOKEN" ]; then
  exec env GH_TOKEN="$TOKEN" "$GH_REAL" "$@"
fi
exec "$GH_REAL" "$@"
