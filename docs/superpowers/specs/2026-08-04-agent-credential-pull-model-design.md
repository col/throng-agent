# Agent GitHub credentials: pull model

**Date:** 2026-08-04
**Status:** Approved
**Scope:** `throng-agent` image and `@throng/agent-core` only — the sandbox side
of the credential system. The Throng control plane's implementation of the
credentials API is specified here as a contract but built separately.

## Goal

Give an agent working `git` and `gh` for the whole of a task, however long that
task runs and however long it sits paused, without ever putting a
GitHub App installation token into the sandbox's process environment.

## Problem

Agents run in ephemeral E2B microVMs and need `git` and `gh` to act on the
user's behalf. The credentials are GitHub App installation tokens with a 1 hour
TTL. That expiry breaks two cases:

- long-running agent tasks that outlive the token
- tasks paused waiting on user input, which may resume hours or days later

Today `injectGitCredentials()` (`packages/core/src/bootstrap/git-credentials.ts`)
sets `GIT_ASKPASS`, `GIT_ASKPASS_TOKEN` and `GH_TOKEN` on `process.env` during
boot, and every subprocess the engine spawns inherits them. Refreshing that
token out-of-band cannot work: a process's environment is fixed at `execve()`,
so a long-running agent process will never observe a new value.

Setting the value at sandbox creation does not work either. The agent runtime is
started by `setStartCmd` during template build and captured in the snapshot
(`throng_e2b_templates/throng-agent/template.ts`), so E2B's `envs` at
`Sandbox.create` — which envd applies to processes *it* spawns — never reach it
or anything descended from it.

## Decision

Move from **push** (inject a token, try to refresh it) to **pull** (fetch a
token at the moment of use).

- `GH_TOKEN` is removed from the sandbox environment entirely.
- `git` uses a credential helper. `gh` is wrapped by a shim. Both invoke
  `throng-creds`, which returns a fresh token.
- The sandbox holds only a task-scoped identity token, which is useless outside
  the control plane, revocable per task, and bound server-side to an
  installation, a repo set and a permission set.

The agent can read that identity token. This is accepted: it grants nothing
beyond what the task's policy already allows, and it dies with the task.

### Static token escape hatch

`throng-creds` also honours a literal `github_token` supplied through
`/api/initialise`, and prefers it over the credentials API when both are
present. This exists so the image and template can be exercised standalone,
without the Throng platform.

Crucially it is honoured **inside the helper**, not by a second code path. The
git config, the `gh` shim, PATH resolution, `credential.useHttpPath`,
`/dev/shm/throng` permissions and the credential protocol are byte-identical in both
modes; only the final step differs — read a file versus POST. A standalone test
therefore exercises the production wiring, which is the entire point of having
the escape hatch.

## Architecture

### Artefacts

All shipped in the agent image (`throng-agent/Dockerfile`), so the image remains
the single unit of promotion that `template.ts` already depends on.

| Path | What it is |
|---|---|
| `/usr/local/bin/throng-creds` | the helper, entirely in bash |
| `/usr/local/bin/gh` | bash shim → `exec env GH_TOKEN="$(throng-creds gh)" gh.real "$@"`, or `exec env -u GH_TOKEN gh.real "$@"` when the helper declines |
| `/usr/local/bin/gh.real` | the real `gh` binary — the Dockerfile's existing `install` target, renamed |

Because the Dockerfile owns both `gh` names, the PATH-ordering hazard is
designed out rather than verified: nothing else installs a `gh` into this image.

Both scripts use `#!/bin/bash`, not `#!/bin/sh` — Debian's `sh` is dash, which
lacks the parameter expansion the fast path relies on.

The Dockerfile gains `curl` and `jq` (~5MB), and nothing else: single-flight uses
`mkdir`, so no `flock` and no `util-linux` dependency.

Two build-time smoke checks follow the install, so a broken helper fails the
build rather than the first clone: `throng-creds git store </dev/null` proves
the script parses and exits 0, and `gh --version` proves the shim resolves
`gh.real` and declines cleanly with no config present. The second reaches the
cache path and so creates `/dev/shm/throng`; a following `rm -rf /dev/shm/throng`
keeps that build-time side effect out of the shipped image, which must start with
nothing configured. (Belt and braces: BuildKit mounts `/dev/shm` as a fresh tmpfs
for each `RUN`, so the directory cannot reach the layer even without the `rm`.
That is a property of the builder rather than of the Dockerfile, so the `rm`
stays.)

### Git configuration

Written at image build time with `git config --system`, so it is a constant
rather than something `/api/initialise` must get right:

```
credential.helper                    = /usr/local/bin/throng-creds git
credential.useHttpPath               = true
url."https://github.com/".insteadOf  = git@github.com:
```

`useHttpPath` is required, not optional: without it git never sends `path=` to
the helper, so no request can name a repo and everything collapses to the task's
default scope.

The helper is referenced by absolute path because git invokes helpers via
`/bin/sh` and `/usr/local/bin` may not be on that PATH.

`GIT_TERMINAL_PROMPT=0` moves into the image as an `ENV`, alongside the git
config and for the same reason: it is a constant. It used to be set by
`injectGitCredentials()` on the runtime's `process.env`, where every child
inherited it — but that function is deleted here, and its replacement in
`bootstrap/git.ts` passes the variable only in the environment of the runtime's
own clone and checkout subprocesses. The agent's `git push` an hour later is not
descended from any of them, so nothing would reach it.

That gap matters. When the helper declines or dies — a 403, an unreachable
service, an unconfigured sandbox — git falls back to asking for a username.
Without a TTY that is an immediate error; with one it blocks, and the README's
standalone recipe reaches into the container over `docker exec`. A blocked git
operation is the worst outcome this design has. As an `ENV` it reaches every
process in the sandbox regardless of what spawned it, and it closes the only
path by which an interactive credential could be typed in.

It is not a credential, so the env-freezing objection that rules out `GH_TOKEN`
does not apply to it. `bootstrap/git.ts` keeps its per-subprocess copy as well,
so that module is correct outside the image, where its unit tests run.

### Boot sequence

```
initialise → write /dev/shm/throng/config.json     ← moved to the front
           → clone repos                        ← unauthenticated at the call site
           → run setup commands                 ← now have working git + gh
           → inject commit identity + engine credentials
           → start A2A server
```

The credential write moves to the very front because cloning now depends on it.
`deps.clone()` loses its `token` parameter and its askpass environment.
`askpass.sh`, the `ASKPASS` export and `injectGitCredentials()` are deleted.
`injectGitIdentity()` is untouched — commit identity was always a separate
concern from which token pushes the work, and stays environment-based. With the
credential half gone, `bootstrap/git-credentials.ts` is left holding only that
function and is renamed `bootstrap/git-identity.ts` to match.

If writing the config file fails, boot fails immediately with a new
`credentials` step, before any clone is attempted. A clone that fails on auth
surfaces the helper's stderr through git's output, which the existing
`StepError("cloning", …)` already captures.

### Consequence: setup commands gain credentials

Setup commands now run after the config is written, so `git` and `gh` work
inside them. `npm install` against a git URL, `git submodule update`, or
fetching a sibling repo all begin to work.

This is deliberate. The isolation it gives up was thinner than it looked — a
setup command could already read the whole workspace — and the failure mode of
preserving it is worse: a setup command needing a private submodule fails with
an opaque git auth error at a point where the token demonstrably exists.

It does invalidate the assumption recorded in `setup.ts` ("Setup runs before any
credential injection, so the output cannot contain the manifest's tokens").
Setup command output is captured verbatim into the control plane's
`instance.error_message`, so `describeSetupFailure` gains a redaction pass over
`ghp_`, `gho_`, `ghu_`, `ghs_` and `ghr_` prefixed strings — applied before the
output is truncated to its tail, so a token straddling the cut cannot survive in
halves, and applied to the full output that is logged as well as to the message.

The same redaction is applied to clone and checkout output, which now also runs
with credentials in place and lands in the same sink. git does not normally echo
a helper-supplied password, but the sink is kept uniformly clean rather than
resting on reasoning about what git might print.

## `throng-creds`

### One language

The helper is a single bash script. An earlier draft split it — bash for cache
hits, Node for everything else — on the grounds that HTTP, expiry parsing, error
classification and single-flight deserved unit tests.

That split was dropped once it became clear that `git get` must parse stdin
before it can do anything at all, because the cache key derives from `host` and
`path`. Parsing consumes stdin, so the parsed values would have to be handed to
Node as arguments — which put the credential protocol, decline rules, key
derivation and output format in bash regardless, and left Node with a couple of
hundred lines of linear work. A spawn-and-assert test harness was needed for the
bash side either way, and extending it with a stub HTTP server costs about what
injecting a fake fetch into a Node CLI would have.

One thing then actively favours bash:

- **`curl --retry 2` already covers transient retry**, including 5xx and
  connection-refused, so retry and backoff logic stops needing to exist.

An earlier version of this section claimed a second: that `flock` is a one-line
syscall wrapper in bash and has no Node binding, so Node would have to hand-roll
a lockfile with a staleness break, which is the part that misbehaves under
contention. That argument does not survive. `flock` is util-linux only and
absent on macOS, where this repo's tests run locally, and a lock that can only
be exercised in CI is a lock whose regressions are found late — so an atomic
`mkdir` on a lock directory was taken instead, which bash and Node can both do.
That means the hand-rolled staleness break exists after all. It is bounded, and
its residual race is stated and accepted under "Single-flight" below.

What this gives up is type safety on the resolution path and stringier error
message construction. Two things needed care in review: splitting status from
body via `-w '\n%{http_code}'` is brittle when a response has no trailing
newline, and `set -euo pipefail` interacts badly with the `read` loop that parses
stdin. Both landed as expected — status and body are split on the *last*
newline with a `${resp##*…}` / `${resp%…*}` pair, which stays correct for an
empty or newline-free body because `-w` always appends one; and the script runs
`set -uo pipefail` with no `-e`, because a credential helper must decide for
itself what is a decline and what is fatal.

If the resolution logic ever grows — multiple hosts, per-repo policy, GHES, a
token map — moving it to Node is a contained rewrite of one file, with the test
suite already in place.

The script is written to bash 3.2, not bash 5. The image runs 5.2, but the suite
spawns `bash` and macOS ships 3.2 — so no `mapfile`, no `exec {fd}>`, no
`printf '%(%s)T'`, no associative arrays. Note this is a portability choice with
no production consumer: the image's bash is 5.2, so the constraint exists only
so the suite runs on any developer machine. Because `bash` on PATH may be a
newer Homebrew build, verifying it requires explicitly running against
`/bin/bash`.

### Fast path and slow path

The two tiers survive the merge, as paths within one script rather than a
language boundary. A cache hit must be fast, because git invokes the helper on
every remote operation; it must therefore fork at most once. The one fork is
`date +%s`; the fork-free `printf '%(%s)T'` needs bash 4.2 and macOS ships bash
3.2, which the test suite runs against. No `jq`, no `date -d`, no `sha256sum`,
no expiry arithmetic. The cache format is designed to make that possible.

### Cache format

`/dev/shm/throng/cache/<sanitised-key>`:

```
1754286260                    ← serve_until: expires_at MINUS skew, precomputed
api|github.com|acme/app       ← canonical key this entry was minted for
username=x-access-token
password=ghs_…
password_expiry_utc=1754286560
```

Line 1 carries `expires_at - 300s` rather than the raw expiry, so the fast path
needs no ISO-8601 parsing and no arithmetic — its entire freshness test is
`serve_until > now`. Skew is applied once, on write.

Line 2 exists because filenames are the canonical key with unsafe characters
replaced (`[^A-Za-z0-9._-]` → `_`), computed with `${raw//…}` and no fork. That
sanitising can collide — `acme/app` and `acme_app` map to the same filename — so
the fast path string-compares line 2 against the key it wants. A mismatch falls
through to the slow path, which rewrites the entry. Cheaper than hashing, and
correct.

A cache hit is therefore: `read`s in the shell, one integer compare, one string
compare, and the single `date +%s` fork. No `tail`, no `jq`.

The slow path writes via a temp file and `mv` within the same directory, so the
fast path can never observe a half-written file.

### Credential protocol

`get` parses `key=value` lines from stdin to EOF, then:

- declines — exit 0, no output — unless `protocol=https` and
  `host=github.com`. Other hosts fall through to git's own behaviour; GitHub
  Enterprise Server is a deliberate non-goal, extensible through the config file
  later.
- derives `repo` by stripping the leading `/` and any trailing `.git` from
  `path`.
- resolves cache key `git|<host>|<repo>`.
- emits `username`, `password`, `password_expiry_utc`, `quit=1`.

`store` drains stdin and exits 0 — nothing to persist, but it must not fail.

`erase` drains stdin, removes the cache and exits 0. Git calls this after a 401,
so the next operation re-mints rather than replaying a token GitHub has already
rejected. It never touches the slow path. It removes the cache *directory* whole
rather than globbing its entries: lock directories live there too, and a partial
clear would leave a rejected token in play under some other key. The cost is
that an erase concurrent with a mint can delete a live lock, which costs a
duplicate API call and never a corrupt entry.

Because `erase` is an `rm -rf` of whatever `THRONG_CREDS_CACHE` names, the modes
that touch the cache first check it: absolute, no `.` or `..` segment, and at
least two path segments, so `/`, `/tmp` and any bare top-level directory are
refused. `${CACHE_DIR:?}` alone would only have caught empty or unset. `git
store` deliberately skips the check — git's protocol gives it no way to report a
failure and it reads and writes nothing — which is also what makes it usable as
the Dockerfile's build-time smoke check.

`gh` mode resolves `api|github.com|` and prints the bare token. The shim cannot
know which repo a given `gh` command targets, so `gh` always resolves against the
task's default scope.

### Resolution order

On a cache miss, under the lock:

1. No readable `/dev/shm/throng/config.json` → **decline**: exit 0 with no output.
   Public clones keep working in an uninitialised sandbox, which is what they
   did before this change.
2. `github_token` present → serve it with both `serve_until` and
   `password_expiry_utc` set to `now + 10y`. No HTTP, ever. The far-future
   expiry means a standalone sandbox takes the slow path exactly once per key
   for its whole life, and every call after that is a fast-path hit.
3. `credentials` present → `POST /v1/credentials/github`.
4. Neither → decline.

Step 2 before step 3 is the static-token precedence rule.

`config.json` is read with `jq`, never sourced. It is the one place a
shell-sourced format would have been an injection hazard, and JSON removes the
question.

### Single-flight

Required despite the fast path: N parallel git operations at boot all miss
simultaneously, and GitHub rate-limits installation-token creation hard.

An atomic `mkdir` on a per-key lock directory, then **re-check the cache under
the lock** — the process that blocked will find the entry the winner just wrote,
and must not fetch again. The wait is bounded (`LOCK_TICKS`, default 75 × 0.2s =
15s, overridable via `THRONG_CREDS_LOCK_TICKS` for tests); after it, the caller
proceeds *without* the lock, because a duplicate API call is a better outcome
than a git operation stalled behind a dead owner.

`mkdir` rather than `flock`: `flock` is util-linux and absent on macOS, where
this repo's tests run locally, and a lock that can only be exercised in CI is a
lock whose regressions are found late.

A lock whose owner was `SIGKILL`ed (the OOM killer is the likely cause in a
memory-capped sandbox) is reclaimed: after a full `LOCK_TICKS` of observed no
progress, a lock whose mtime is older than `LOCK_STALE_MIN` is removed and the
wait restarts once. Without this, an orphaned lock is strictly worse than no
lock at all — every waiter still times out and still mints, so the full stampede
returns, plus 15s of latency each, plus a warning on the agent's stderr, and it
recurs indefinitely because the only other recovery is a `git credential erase`
that requires a 401 which may never come. A live holder cannot outlast curl's
own ceiling, so anything older is provably stale.

The residual race is that two waiters can both time out, both judge the lock
stale, and both remove it — so one deletes the other's fresh lock. The window is
sub-millisecond and no `mkdir`-based break can eliminate it. It is accepted
because its worst case equals the status quo it replaces: two mints instead of
one, with `write_cache`'s atomic rename meaning no corruption either way.

`THRONG_CREDS_LOCK_TICKS` is validated rather than trusted. A non-numeric or
absurdly large value would make the per-tick comparison error every iteration,
so the timeout branch would never be reached and the helper would wait forever —
the worst failure a credential helper has, since it stalls the git operation
that called it. Anything that is not one to five digits falls back to the
default with a warning.

### Error messages

Helper stderr is inherited by both `git` and the `gh` shim, so it reaches the
agent's terminal, and it prints before git's generic
`could not read Username` line. These messages are therefore agent-facing UX and
are written as such:

- **403** — names the repo, states that this is a policy decision which will not
  change on retry, and says explicitly that the operation must not be retried
  against a different repository or remote. The server's `message` is appended.
- **401** — task identity rejected; the task may have been revoked or completed.
- **429 / 5xx / network**, after two retries with backoff — states that the
  credential service is temporarily unreachable and that the *same* command
  should be retried.
- **any other status** — a 404 from a mistyped `credentials.url` or an API
  version bump is the likeliest — says explicitly that this is a configuration
  or protocol error and that retrying will not help. Describing it as transient
  would send the agent into a retry loop that can never succeed.

Only transient classes retry. A 4xx returns immediately.

Retry is `curl --retry 2` bounded by both `--max-time 10` and
`--retry-max-time 20`. The second is not optional: `--max-time` bounds each
transfer but not the sleeps between attempts, and curl obeys `Retry-After` when
retrying, so a routine `Retry-After: 60` would otherwise stall a git fetch for
minutes with no output at all.

The 403 wording matters because an agent that cannot distinguish "not allowed"
from "auth failed, retry" may work around the first by doing something worse:
committing to a different repo, force-pushing elsewhere, rewriting history.

### `gh` shim edge case

If `throng-creds gh` yields nothing — declined, or failed — the shim `exec`s
`gh.real` **without setting `GH_TOKEN` at all**, rather than setting it to the
empty string. `gh` then produces its own idiomatic "not logged in" error instead
of a confusing auth rejection. The helper's stderr has already been printed.

That path is `exec env -u GH_TOKEN gh.real "$@"`, not a bare `exec`: not setting
`GH_TOKEN` is not the same as it being absent. Anything that exported one into
the shim's environment — a leftover boot-time injection, a developer's shell —
would otherwise be inherited, and a stale token would silently win on precisely
the path documented to produce a clean "not logged in". `env -u` is in both GNU
coreutils and macOS.

## Manifest

`POST /api/initialise` gains one optional block. `github_token` keeps its
current meaning and its existing `GITHUB_TOKEN` environment fallback, which is
what makes a bare `docker run` work.

```jsonc
{
  "repos": [{ "url": "…", "ref": "…", "dest": "…", "primary": true }],
  "credentials": { "url": "https://…", "token": "…" },
  "github_token": "ghp_…",   // static; wins over `credentials` when present
  "user_identity": { "name": "…", "email": "…" },
  "setup_commands": ["…"],
  "agent": { "platform": "claude", "…": "…" }
}
```

`credentials` must be an object with non-blank string `url` and `token`. Both
fields are required when the block is present: a half-configured helper would
fail at the first clone rather than at initialise, which is much harder to
diagnose. `url` must additionally start with `https://` — the endpoint hands
back live GitHub and control-plane tokens, so it is never appropriate in the
clear — and must not end in a trailing slash, because `throng-creds`
concatenates it raw into `"$url/v1/credentials/github"` and the resulting double
slash 404s on most servers rather than being rejected outright. Rejecting at
initialise, where the operator gets a precise field error, beats normalising and
hoping the result still matches what the control plane serves. Errors are
reported as `credentials.url` and `credentials.token`, matching the existing
`FieldError` convention.

### `repos[].token` is retired

The control plane's `Manifest.build/1` assigns every repo the *same* installation
token reference, and `primary_token/1` sets top-level `github_token` to
`repos[0].token`. The three fields are one token wearing three hats, so the
per-repo field carries no distinct information.

Under the pull model the helper already scopes per repo — `useHttpPath` means
every request names its repo and the server narrows the token to it — which is
strictly better than a static per-repo token.

`repos[].token` is therefore still **accepted** (so an unchanged control plane
does not begin receiving 400s) but ignored, with a single `log.warn` carrying
the repo's index. `RepoSpec` loses its `token` field; `BaseManifest` gains
`credentials: CredentialsConfig | null`.

### Config file

Written to `/dev/shm/throng/config.json`, mode `0600`, inside `/dev/shm/throng` at
`0700`, alongside `cache/`:

```json
{
  "credentials": { "url": "https://…", "token": "…" },
  "github_token": "ghp_…"
}
```

JSON read with `jq`, rather than shell-sourced environment assignments. Sourcing
a file that holds a control-plane-supplied token is an injection hazard —
`set -a; . file` executes whatever it contains — and it is avoidable for the cost
of one `jq` call on the slow path only. A structured format also carries nested
values later without inventing an environment-variable naming scheme.

It is written once, at initialise, and never rewritten. See "Identity token
lifetime" below.

**Why `/dev/shm` and not `/run`.** This design originally put both files under
`/run/throng`, and the first integration test died at boot with
`EACCES: permission denied, mkdir '/run/throng'`. E2B's envd runs the sandbox as
`uid=1000(user)`, and `/run` is tmpfs owned `root:root` mode `755`. `/dev/shm` is
tmpfs as well — so a credential still never lands on a persisted filesystem, which
was the whole reason for choosing `/run` — but it is mode `1777`, so it is
writable without privilege, and it behaves identically under `docker run` and
under E2B. Pre-creating `/run/throng` in the Dockerfile is not an alternative:
`/run` is tmpfs and is mounted fresh at boot, so an image-time directory does not
survive. `sudo mkdir /run/throng` was rejected because it would make the runtime
depend on sudoers membership for a boot step; the runtime should need no
privilege at all.

`/dev/shm` being world-writable does not weaken the file: the directory is created
`0700` and the file `0600` by the same code as before, and `/dev/shm`'s sticky bit
stops another uid removing or renaming what we create. A different uid could
pre-create `/dev/shm/throng` to make `writeCredentialConfig`'s `chmod` fail, but
that fails the boot at the credentials step rather than leaking anything, and
there is no boundary to cross in the first place: the runtime, `git`, `gh` and the
agent's own shells all run as the same uid, and the agent is already allowed to
read the identity token (see "Decision"). One consequence is that
`check_cache_dir` names `/dev/shm` explicitly as a refused value — its two-segment
depth rule refuses `/run` for free but not `/dev/shm`, which is now the parent of
the default cache path and therefore the plausible mis-set.

## Credentials API contract

Specified here because the sandbox is its consumer and this is the artefact
hardest to change later. Implemented separately in the control plane.

```
POST /v1/credentials/github
Authorization: Bearer <task token>
Idempotency-Key: <uuid>

{ "purpose": "git" | "api",
  "host": "github.com",
  "repo": "owner/name" }        // optional; omitted → task default scope
```

```
200 { "username": "x-access-token",
      "token": "ghs_…",
      "expires_at": "2026-08-04T06:11:00Z",
      "scope": { "repos": ["owner/name"],
                 "permissions": { "contents": "write", "pull_requests": "write" } } }

401  task identity invalid or revoked
403  { "message": "…" }  repo not in this task's grant — message surfaces to the agent
429  rate limited
```

### Requirements

- **`expires_at` is mandatory.** The client cannot cache without it, and without
  caching the installation-token creation limit is exhausted. It also populates
  git's `password_expiry_utc`. It must be ISO-8601 with a `Z` suffix, and it
  must be more than the 300s skew away: a token expiring sooner would be written
  with `serve_until` already in the past, so the helper would decline with no
  output on the very entry it just minted. The client rejects that case loudly
  instead, naming the clock as a suspect.
- **Scope per request, not per session.** A multi-repo task gets one token per
  repo, not one token spanning all of them.
- **`purpose` selects the permission set.** `git` needs `contents:write`; `api`
  needs whatever `gh` subcommands the task is allowed to run.
- **Default scope must cover private plugin marketplaces.** Claude Code clones
  `claude.marketplaces` itself at startup, and those repos are not the task's
  working repos. Public marketplaces never reach the helper (see below), so this
  applies to private ones only.
- **Server-side cache** keyed by (installation, repo set, permissions), roughly
  50 minutes. The client's 300s skew and this TTL must not fight.
- **403 messages are agent-facing.** They appear in the agent's terminal and are
  the only signal distinguishing "not allowed" from "auth failed, retry".
- **Log every issuance** with task ID, repo and purpose. This is the audit trail
  of what the agent touched, attributable per task rather than per App.

### Identity token lifetime

The task token must remain valid for the task's **entire lifetime, including
pauses**. It is retired by revocation, never by expiry. There is no rotation
path into a running sandbox, and `/dev/shm/throng/config.json` is write-once.

This is a decision, not an oversight: the alternative is a rotation endpoint,
and it was judged not worth building until the assumption is shown to be wrong.

It is low-regret. Because `git` and `gh` never see the identity token, adding a
rotation endpoint later is purely additive — the consumer contract, the image
wiring and the template are identical either way. Only the config file's
write-once property and the cache-flush-on-rotation logic would change.

## Why public repos are mostly unaffected

For HTTPS, git tries the request unauthenticated first and only invokes the
credential helper after a 401. This is why cloning a public repo never prompts.

Consequences:

- Public plugin marketplaces never reach the helper at all.
- Public repo clones work in an uninitialised sandbox, which is what makes
  "decline when unconfigured" the correct behaviour rather than a compromise.

`gh` is the opposite: the shim always needs a token and there is no lazy path,
which is why `gh` always resolves against the default scope.

## Testing

**`throng-creds` (vitest, spawn-and-assert — the bulk).** Each case runs the
real script against a temp `THRONG_CONFIG` and cache directory, with a stub HTTP
server standing in for the credentials API. Two groups:

*Protocol and fast path, no server needed* — cache hit; expired miss; key
mismatch; malformed cache file; stdin parsing; decline on non-HTTPS and on a
non-`github.com` host; repo derivation with and without a trailing `.git`;
`store` exits 0; `erase` clears the cache; `gh` mode prints a bare token.

*Resolution and slow path, against the stub* — decline when unconfigured; static
token precedence over `credentials`; `serve_until` computed from `expires_at`;
cache written atomically and reused on the next call; 401/403/429/5xx messages
and exit statuses; transient classes retried, 4xx not; concurrent invocations
producing exactly one upstream request.

That last case is the one to write first — it is the only test that would catch
a lock regression, and a stampede is silent until GitHub starts rate-limiting.

Everything the suite needs to redirect is an environment variable with a
production-correct default, so nothing is installed and no path is stubbed in
the script itself: `THRONG_CONFIG` and `THRONG_CREDS_CACHE` for the two file
locations, `THRONG_CREDS_LOCK_TICKS` to shorten the 15s lock wait, and
`THRONG_CREDS_BIN` / `GH_REAL_BIN` so the `gh` shim can be pointed at the
checked-out script and a fake `gh`.

**Integration:** extend `throng-agent/src/integration/boot.test.ts` for the
reordered boot and the config write.

**Template smoke:** extend `throng_e2b_templates/throng-agent/smoke.ts` to assert
that `throng-creds` and the `gh` shim exist and decline cleanly in an
uninitialised sandbox.

**Manual standalone:** `docker run` the image, `POST /api/initialise` with only
`github_token`, then clone a private repo, `gh auth status`, `gh pr create`.
This is the escape hatch working end to end, and it is written up as a
repeatable procedure in the README.

## To verify during implementation

**Settled, and it was settled wrongly the first time — read this before trusting
a `docker run` result again.** This section previously read: "The image sets no
`USER` and runs as uid 0, confirmed against a real container build … the uid
concern is moot." Both halves of that were false in production, and the first
integration test failed at boot with
`EACCES: permission denied, mkdir '/run/throng'`.

The verification was a false negative because of *how* it was run. `docker run`
honours the image's `USER`, and this image sets none, so it ran as root and
`mkdir /run/throng` succeeded. **E2B does not honour it**: envd starts the
sandbox process as `uid=1000(user)`. The same image therefore runs under two
different uids depending on the host, and only one of them can write `/run`.
Confirmed against a live E2B sandbox:

- `id` → `uid=1000(user) gid=1000(user) groups=1000(user),27(sudo)`
- `/run` → tmpfs, `root:root`, `755`; `mkdir /run/throng` → Permission denied
- `/run/user/1000` does not exist and `XDG_RUNTIME_DIR` is unset
- `/dev/shm` → tmpfs, `root:root`, `1777`, writable by `user`
- `/tmp` and `/var/tmp` → `1777` but disk-backed, not tmpfs
- passwordless sudo works, but the runtime does not use it

The fix moves both files to `/dev/shm/throng` (see "Config file" for the full
rationale and the rejected alternatives). Mode `0600` on the file inside a `0700`
directory is unchanged and still correct; the `0711` / `0644` fallback
contemplated here is still not needed, because a single uid still runs the
runtime, `git`, `gh` and the agent's shells — it is 1000 under E2B and 0 under
`docker run`, not a mix of both within one host.

The general lesson, which is the part worth carrying to the next feature: a
container check that does not pin the uid proves nothing about E2B. Anything that
writes outside the workspace must be exercised with `docker run --user 1000:1000`
as well as plain `docker run`.

**Still open.** That the contents of `/dev/shm` survive pause and resume in a live
E2B sandbox. This has not been confirmed against a running sandbox, and moving off
`/run` does not change the question — both are tmpfs. If the cache does not survive
a resume the design still works: the next operation takes the slow path and
re-mints. But if `/dev/shm/throng/config.json` does not survive, the sandbox loses
its identity token with no way to be handed another, since the file is write-once
(see "Identity token lifetime").

## Out of scope

- The control plane's implementation of the credentials API.
- A credential rotation endpoint.
- The hardened variant, in which the agent cannot read the identity token at
  all, because a self-hosted MITM proxy mints per request. The same pull model
  works behind it: the `git`/`gh` consumer contract does not change, only where
  the fetch happens. (E2B's declarative `network.rules` transforms are
  static-value and therefore the wrong shape for an hourly-expiring credential.)
- GitHub Enterprise Server hosts.
