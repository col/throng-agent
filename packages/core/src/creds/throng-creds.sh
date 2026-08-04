#!/bin/bash
# throng-creds — GitHub credentials for the agent sandbox, fetched at the moment
# of use rather than injected at boot.
#
#   throng-creds git get|store|erase   git credential helper protocol (stdin)
#   throng-creds gh                    bare token on stdout, for the gh shim
#
# See docs/superpowers/specs/2026-08-04-agent-credential-pull-model-design.md
#
# Deliberately bash 3.2 compatible. The image runs bash 5.2, but macOS ships 3.2
# and the test suite spawns this script with `bash` from PATH. No mapfile, no
# `exec {fd}>`, no printf '%(%s)T', no associative arrays.
#
# No `set -e`: a credential helper must decide for itself what is fatal and what
# is a decline, and `-e` would turn an ordinary non-zero probe into an exit.

set -uo pipefail

CONFIG_FILE="${THRONG_CONFIG:-/run/throng/config.json}"
CACHE_DIR="${THRONG_CREDS_CACHE:-/run/throng/cache}"
SKEW=300              # serve_until = expires_at - SKEW

warn() { printf 'throng-creds: %s\n' "$*" >&2; }
die()  { warn "$*"; exit 1; }
now()  { date +%s; }

# REPLY <- the cache file for a canonical key. Sanitising can collide
# ("acme/app" and "acme_app" both become "acme_app"), which is why every entry
# records the key it was minted for; read_fresh rejects a mismatch.
cache_file() {
  local safe="${1//[^A-Za-z0-9._-]/_}"
  REPLY="$CACHE_DIR/$safe"
}

# Prints the cached credential lines when the entry exists, records this exact
# key, and is still inside its serve window. Returns 1 otherwise.
read_fresh() { # $1 = canonical key
  local file exp key line body=""
  cache_file "$1"; file="$REPLY"
  [ -f "$file" ] || return 1
  {
    read -r exp || return 1
    read -r key || return 1
    while IFS= read -r line; do body="$body$line
"; done
  } < "$file"
  case "$exp" in ''|*[!0-9]*) return 1 ;; esac
  [ "$key" = "$1" ] || return 1
  [ "$exp" -gt "$(now)" ] || return 1
  [ -n "$body" ] || return 1
  printf '%s' "$body"
}

# Prints the credential block for a key, from cache when fresh.
# Returns 1 to decline.
credential() { # $1=key $2=purpose $3=host $4=repo (may be empty)
  read_fresh "$1" && return 0
  return 1
}

git_get() {
  local line k v protocol="" host="" path="" repo=""
  while IFS= read -r line; do
    [ -z "$line" ] && break
    k="${line%%=*}"; v="${line#*=}"
    case "$k" in
      protocol) protocol="$v" ;;
      host)     host="$v" ;;
      path)     path="$v" ;;
    esac
  done

  # Decline anything that is not GitHub over HTTPS. Exit 0 with no output lets
  # git fall through to its own behaviour, which is what makes public clones in
  # an unconfigured sandbox keep working.
  [ "$protocol" = "https" ] || exit 0
  [ "$host" = "github.com" ] || exit 0

  # Requires credential.useHttpPath=true. Without it `path` is empty and the
  # request falls back to the task's default scope.
  repo="${path#/}"
  repo="${repo%.git}"

  credential "git|$host|$repo" git "$host" "$repo" || exit 0
  printf 'quit=1\n'
}

case "${1:-}" in
  git)
    case "${2:-}" in
      get)   git_get ;;
      store) cat >/dev/null ;;
      erase) cat >/dev/null ;;
      *)     exit 0 ;;
    esac
    ;;
  *) die "usage: throng-creds git <get|store|erase> | throng-creds gh" ;;
esac
