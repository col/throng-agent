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

# /dev/shm, not /run, and the reason is the uid this runs as. E2B's envd starts
# the sandbox as uid 1000, while `docker run` honours the image's USER (root) —
# so the same image runs under two different uids depending on the host. /run is
# tmpfs owned root:root mode 0755, so `mkdir /run/throng` is EACCES for
# everything E2B actually runs, and pre-creating it in the image cannot help
# because /run is mounted fresh at boot.
#
# /dev/shm is tmpfs as well, so a credential still never lands on a persisted
# filesystem, and it is mode 1777, so it needs neither root nor sudoers
# membership. It behaves identically under `docker run` and under E2B, which is
# the property /run turned out not to have. The directory itself is created 0700
# and the config file 0600 (see creds/config.ts), so /dev/shm being
# world-writable does not make the token readable; the sticky bit stops another
# uid removing or renaming what we create there.
CONFIG_FILE="${THRONG_CONFIG:-/dev/shm/throng/config.json}"
CACHE_DIR="${THRONG_CREDS_CACHE:-/dev/shm/throng/cache}"
SKEW=300              # serve_until = expires_at - SKEW
# 10 years, for a literal github_token. Never expiring is safe because
# the config file is written once when the sandbox is created and never
# again: a changed static token cannot appear in a running sandbox, so a cache
# entry minted from it can never go stale relative to its source.
STATIC_TTL=315360000
# × 0.2s = 15s before giving up on the lock. Overridable only so the test suite
# can assert the wait-then-reclaim-then-proceed behaviour without spending 15s a
# test on it; the behaviour is identical at any tick count.
LOCK_TICKS="${THRONG_CREDS_LOCK_TICKS:-75}"
LOCK_STALE_MIN=2      # a live holder is bounded by curl's --max-time/--retry-max-time

warn() { printf 'throng-creds: %s\n' "$*" >&2; }
die()  { warn "$*"; exit 1; }
now()  { date +%s; }

# Validated here rather than beside the assignment above only because `warn`
# does not exist yet up there. An unusable LOCK_TICKS does not merely mistime the
# wait: `[ "$ticks" -ge "$LOCK_TICKS" ]` errors on every iteration, so the
# timeout branch is never reached and the loop waits forever — the worst failure
# mode a credential helper has, since it stalls the git operation that called it.
#
# `??????*` is not redundant with the digit check. Digits alone are not enough:
# `[` parses base 10 into a C integer, so 99999999999999999999 passes
# `*[!0-9]*` and then produces exactly the same per-tick error and the same
# hang. Six digits is the cutoff because 99999 ticks is already 5.5 hours, far
# past any value worth honouring. (Unlike `(( ))`, `[` does not read a leading
# zero as octal, so "08" and "0000" are genuinely fine.)
case "$LOCK_TICKS" in
  ''|*[!0-9]*|??????*)
    warn "ignoring unusable THRONG_CREDS_LOCK_TICKS '$LOCK_TICKS'"
    LOCK_TICKS=75 ;;
esac

# git_erase removes this directory whole — as root under `docker run`, as uid
# 1000 under E2B — and lock directories live in it too, so a mis-set
# THRONG_CREDS_CACHE is an `rm -rf` on
# whatever it names. `${CACHE_DIR:?}` only rejects empty/unset, never a
# dangerous *value*; these checks reject the value. Nothing can make an
# arbitrary path safe, but `/`, a bare top-level directory, and anything
# reachable by traversal are the ones that end a machine.
#
# Called from the modes that touch the cache rather than at startup. `git store`
# must exit 0 whatever the environment says: git's protocol gives it no way to
# report a failure, and it reads and writes nothing here.
check_cache_dir() {
  local CACHE_DIR_RAW="$CACHE_DIR"  # quote back what was set, not the normalised form
  # Trailing slashes go first: "/cache/" has the same parent as "/run/cache" and
  # would otherwise walk straight past the depth check below.
  while [ "$CACHE_DIR" != "/" ] && [ "$CACHE_DIR" != "${CACHE_DIR%/}" ]; do
    CACHE_DIR="${CACHE_DIR%/}"
  done
  case "$CACHE_DIR" in
    /*) ;;
    *)  die "THRONG_CREDS_CACHE must be an absolute path, got '$CACHE_DIR_RAW'." ;;
  esac
  case "$CACHE_DIR" in
    */.|*/..|*/./*|*/../*)
        die "THRONG_CREDS_CACHE must not contain '.' or '..', got '$CACHE_DIR_RAW'." ;;
  esac
  # Two segments minimum: "/", "/cache" and "/tmp" are all refused,
  # "/dev/shm/throng/cache" — the default — is not.
  case "${CACHE_DIR%/*}" in
    ''|/) die "refusing '$CACHE_DIR_RAW' as the cache directory: too close to the filesystem root, and 'git credential erase' deletes it whole." ;;
  esac
  # /dev/shm passes the depth rule for free — its parent is /dev, not "/" — but
  # it is a tmpfs mount shared with every other process in the sandbox, and it is
  # now the parent of the default cache path. "Just point it at /dev/shm" is
  # therefore the plausible mis-set that "/run" used to be, and the depth rule no
  # longer catches it, so it is named here.
  case "$CACHE_DIR" in
    /dev/shm) die "refusing '$CACHE_DIR_RAW' as the cache directory: it is a tmpfs mount shared with the whole sandbox, and 'git credential erase' deletes it whole." ;;
  esac
}

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

# Atomic within the cache directory: git may be reading while we write.
write_cache() { # $1=key $2=serve_until $3=username $4=token $5=password_expiry
  local file tmp
  cache_file "$1"; file="$REPLY"
  mkdir -p "$CACHE_DIR" 2>/dev/null || return 1
  tmp="$file.$$"
  {
    printf '%s\n' "$2"
    printf '%s\n' "$1"
    printf 'username=%s\n' "$3"
    printf 'password=%s\n' "$4"
    printf 'password_expiry_utc=%s\n' "$5"
  } > "$tmp" || { rm -f "$tmp"; return 1; }
  chmod 600 "$tmp" 2>/dev/null
  mv -f "$tmp" "$file"
}

# Single-flight. `mkdir` is atomic on every POSIX filesystem and needs no
# util-linux (flock is absent on macOS, where these tests run). The cost of
# mkdir is that the lock outlives an owner that cannot run its EXIT trap —
# SIGKILL and the OOM killer — so this waits, then reclaims, then proceeds
# regardless. Waiting alone is not enough: a leaked lock that is never reclaimed
# makes every later miss on that key wait the full LOCK_TICKS and mint anyway,
# which is the whole stampede plus 15s a head — strictly worse than no lock.
# A duplicate API call is a far better outcome than either.
LOCK_DIR=""
acquire_lock() { # $1 = canonical key
  local lock ticks=0 broke=0
  cache_file "$1"; lock="$REPLY.lock"
  mkdir -p "$CACHE_DIR" 2>/dev/null
  # Armed before the lock is taken, not after: a signal in the window between
  # the winning mkdir and the trap would otherwise leak the lock. Arming early
  # is a no-op on every path that bails, because release_lock does nothing until
  # LOCK_DIR names a directory this process created.
  trap 'release_lock' EXIT
  while ! mkdir "$lock" 2>/dev/null; do
    # mkdir also fails for reasons waiting cannot fix — an unwritable or
    # uncreatable cache directory. Only an existing lock means another process
    # is minting, so only that is worth sleeping on; otherwise every single
    # credential lookup would stall the full 15s before declining.
    [ -d "$lock" ] || return 0
    if [ "$ticks" -ge "$LOCK_TICKS" ]; then
      # A live holder cannot outlast curl's own ceiling (--max-time 10,
      # --retry-max-time 20), so a lock this process has already watched go
      # nowhere for LOCK_TICKS *and* whose mtime is minutes old belongs to an
      # owner that was killed. Staleness is established two independent ways
      # rather than by mtime alone. `find -maxdepth 0 -mmin` reads the same on
      # BSD and GNU, unlike stat's -c/-f split; `broke` caps the total wait at
      # 2 × LOCK_TICKS and tries the break exactly once, so a lock that cannot
      # be removed cannot spin.
      #
      # Residual race, accepted: two waiters can both time out, both read an old
      # mtime, and both rmdir, so one deletes a lock the other has just created.
      # The window is sub-millisecond and unavoidable with mkdir, and its worst
      # case is two mints — exactly the status quo it replaces, with
      # write_cache's `mv -f` keeping the entry itself atomic.
      if [ "$broke" -eq 0 ] && [ -n "$(find "$lock" -maxdepth 0 -mmin "+$LOCK_STALE_MIN" 2>/dev/null)" ]; then
        broke=1; ticks=0; rmdir "$lock" 2>/dev/null; continue
      fi
      warn "proceeding without the single-flight lock"
      return 0
    fi
    sleep 0.2
    ticks=$((ticks + 1))
  done
  LOCK_DIR="$lock"
}

release_lock() {
  [ -n "$LOCK_DIR" ] && rmdir "$LOCK_DIR" 2>/dev/null
  LOCK_DIR=""
}

# REPLY <- a request id. /proc is Linux-only and the test suite runs on macOS.
uuid() {
  if [ -r /proc/sys/kernel/random/uuid ]; then
    read -r REPLY < /proc/sys/kernel/random/uuid
  elif command -v uuidgen >/dev/null 2>&1; then
    REPLY=$(uuidgen)
  else
    REPLY="$$-$(now)-$RANDOM"
  fi
}

# GNU date and BSD date disagree on parsing; try both. The API contract
# specifies ISO-8601 with a Z suffix, which is all we accept.
#
# The strict BSD form goes FIRST, and the order is load-bearing. On a BSD that
# still has `date -d` (FreeBSD, and macOS before it was dropped), `date -u -d
# "<iso>" +%s` reads the timestamp as a daylight-saving flag and prints the
# CURRENT epoch with exit 0 — so a leading `-d` attempt would be silently
# accepted and every token would be dated now. The `-j -f` form cannot be
# misread: GNU date has no `-j` and simply exits non-zero.
iso_to_epoch() {
  date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$1" +%s 2>/dev/null && return 0
  date -u -d "$1" +%s 2>/dev/null && return 0
  return 1
}

fetch() { # $1=key $2=purpose $3=host $4=repo $5=url $6=task_token
  local req resp rc rid status body msg username tok exp_iso exp_epoch serve_until scope

  req=$(jq -nc --arg p "$2" --arg h "$3" --arg r "$4" \
        '{purpose:$p, host:$h} + (if $r == "" then {} else {repo:$r} end)')

  # Copied out of REPLY immediately: cache_file and write_cache own that global
  # too, so anything added between here and the curl could otherwise turn the
  # Idempotency-Key into a cache filename.
  uuid; rid="$REPLY"

  # --retry covers 5xx, connection failures, and the transient 4xx that curl
  # recognises (408 and 429). Every other 4xx is sent once and only once, which
  # is what we want: a 403 will not become a 200.
  #
  # --retry-max-time is not optional. --max-time bounds each transfer but not
  # the sleeps between attempts, and curl obeys Retry-After when retrying — a
  # routine `Retry-After: 60` would otherwise stall every git fetch for minutes
  # with no output at all. Measured: 429 + `Retry-After: 45` takes 90s without
  # it and 0s with it, while a plain 429 still gets its 3 attempts in 3s.
  resp=$(curl -sS --max-time 10 --retry 2 --retry-max-time 20 --retry-connrefused \
           -w '\n%{http_code}' \
           -H "Authorization: Bearer $6" \
           -H "Content-Type: application/json" \
           -H "Idempotency-Key: $rid" \
           -d "$req" "$5/v1/credentials/github" 2>/dev/null)
  rc=$?
  if [ "$rc" -ne 0 ] || [ -z "$resp" ]; then
    die "the Throng credential service is unreachable. This is transient — retry the same command."
  fi

  # -w always appends "\n<code>", so the status is everything after the final
  # newline and the body is everything before it. Correct even when the body is
  # empty or carries no trailing newline of its own.
  status="${resp##*
}"
  body="${resp%
*}"

  # Not `${4:-the task's default scope}`: bash honours a single quote inside
  # ${...} even within double quotes, so the apostrophe would open a string
  # that never closes and the whole script would fail to parse.
  scope="$4"
  [ -n "$scope" ] || scope="the task's default scope"
  case "$status" in
    200) ;;
    401) die "task identity rejected — this task may have been revoked or completed." ;;
    403)
      msg=$(printf '%s' "$body" | jq -r '.message // empty' 2>/dev/null)
      die "this task's credentials do not cover $scope. This is a policy decision and will not change on retry: do not retry it, and do not attempt the same operation against a different repository or remote.${msg:+ ($msg)}"
      ;;
    429) die "the Throng credential service is rate limiting. This is transient — retry the same command." ;;
    5??) die "the Throng credential service returned HTTP $status. This is transient — retry the same command." ;;
    # Anything else is a 4xx we do not have a specific message for. A 404 is the
    # likeliest — a mistyped credentials.url, or an API version bump — and it
    # will never succeed, so it must not be described as worth retrying.
    *)   die "the Throng credential service returned HTTP $status. This is a configuration or protocol error, not a transient one: retrying will not help." ;;
  esac

  username=$(printf '%s' "$body" | jq -r '.username // empty' 2>/dev/null)
  tok=$(printf '%s' "$body" | jq -r '.token // empty' 2>/dev/null)
  exp_iso=$(printf '%s' "$body" | jq -r '.expires_at // empty' 2>/dev/null)
  [ -n "$tok" ] || die "the credential service returned no token."
  # Without expires_at the entry could never age out, and the installation-token
  # creation limit would be exhausted by the resulting churn elsewhere.
  [ -n "$exp_iso" ] || die "the credential service returned no expires_at."

  exp_epoch=$(iso_to_epoch "$exp_iso") || die "could not parse expires_at '$exp_iso'."
  serve_until=$(( exp_epoch - SKEW ))
  # A token expiring within SKEW would be written with serve_until already in
  # the past: write_cache succeeds, read_fresh then rejects the entry it just
  # wrote, and git_get declines with no output and no reason — indistinguishable
  # from an unconfigured sandbox, and re-minting on every single operation.
  [ "$serve_until" -gt "$(now)" ] || die "the credential service returned a token expiring at $exp_iso, too soon to use. Check the sandbox clock."
  write_cache "$1" "$serve_until" "${username:-x-access-token}" "$tok" "$exp_epoch"
}

# Fills the cache for a key. Returns 1 to DECLINE — no config, or nothing
# usable in it — which the caller turns into a silent exit 0.
resolve() { # $1=key $2=purpose $3=host $4=repo (may be empty)
  [ -r "$CONFIG_FILE" ] || return 1

  # Read with jq, never sourced: this file holds a control-plane-supplied token,
  # and `. file` would execute whatever it contains.
  local static
  static=$(jq -r '.github_token // empty' "$CONFIG_FILE" 2>/dev/null)
  if [ -n "$static" ]; then
    local expiry
    expiry=$(( $(now) + STATIC_TTL ))
    write_cache "$1" "$expiry" "x-access-token" "$static" "$expiry" || return 1
    return 0
  fi

  local url token
  url=$(jq -r '.credentials.url // empty' "$CONFIG_FILE" 2>/dev/null)
  token=$(jq -r '.credentials.token // empty' "$CONFIG_FILE" 2>/dev/null)
  [ -n "$url" ] && [ -n "$token" ] || return 1

  fetch "$1" "$2" "$3" "$4" "$url" "$token"
}

# Prints the credential block for a key, from cache when fresh.
# Returns 1 to decline.
credential() { # $1=key $2=purpose $3=host $4=repo (may be empty)
  read_fresh "$1" && return 0

  acquire_lock "$1"
  # The process that held the lock may have just filled the cache. Re-check
  # before spending an API call.
  if read_fresh "$1"; then release_lock; return 0; fi

  if resolve "$@"; then
    release_lock
    read_fresh "$1"
    return $?
  fi
  release_lock
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

  check_cache_dir
  credential "git|$host|$repo" git "$host" "$repo" || exit 0
  printf 'quit=1\n'
}

git_erase() {
  cat >/dev/null
  check_cache_dir
  # Git calls erase after a 401. Drop the whole directory rather than globbing:
  # lock directories live here too, and a partial clear would leave a rejected
  # token in play for some other key.
  #
  # That includes the lock directories of processes still running, so an erase
  # concurrent with a mint can hand the same lock path to a third process while
  # the first still believes it holds it, and the first's release_lock then
  # removes the third's lock. It costs a duplicate API call, never a corrupt
  # entry, and it needs a 401 to land mid-mint; erasing a rejected token
  # promptly is worth more than that.
  rm -rf "${CACHE_DIR:?}"
  return 0
}

# The shim cannot know which repo a given `gh` command targets, so `gh` always
# resolves against the task's default scope.
gh_token() {
  local out line
  check_cache_dir
  out=$(credential "api|github.com|" api "github.com" "") || exit 0
  while IFS= read -r line; do
    case "$line" in
      password=*) printf '%s\n' "${line#password=}"; return 0 ;;
    esac
  # A here-string rather than the three-line here-doc this replaced: same
  # behaviour (a here-doc delimiter is matched against the script source at
  # parse time, never against expanded content), one line instead of three.
  done <<<"$out"
  return 0
}

case "${1:-}" in
  git)
    case "${2:-}" in
      get)   git_get ;;
      store) cat >/dev/null ;;   # nothing to persist; must still exit 0
      erase) git_erase ;;
      *)     exit 0 ;;
    esac
    ;;
  gh) gh_token ;;
  *)  die "usage: throng-creds git <get|store|erase> | throng-creds gh" ;;
esac
