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
`/run/throng` permissions and the credential protocol are byte-identical in both
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
| `/usr/local/bin/gh` | bash shim → `exec env GH_TOKEN="$(throng-creds gh)" gh.real "$@"` |
| `/usr/local/bin/gh.real` | the real `gh` binary — the Dockerfile's existing `install` target, renamed |

Because the Dockerfile owns both `gh` names, the PATH-ordering hazard is
designed out rather than verified: nothing else installs a `gh` into this image.

Both scripts use `#!/bin/bash`, not `#!/bin/sh` — Debian's `sh` is dash, which
lacks the parameter expansion the fast path relies on.

The Dockerfile gains `curl` and `jq` (~5MB). `flock` is already present via
`util-linux`.

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

`GIT_TERMINAL_PROMPT=0` continues to be set by the runtime on `process.env` and
inherited by every child. It is not a credential, so the env-freezing objection
does not apply to it.

### Boot sequence

```
initialise → write /run/throng/config.json     ← moved to the front
           → clone repos                        ← unauthenticated at the call site
           → run setup commands                 ← now have working git + gh
           → inject commit identity + engine credentials
           → start A2A server
```

The credential write moves to the very front because cloning now depends on it.
`deps.clone()` loses its `token` parameter and its askpass environment.
`askpass.sh`, the `ASKPASS` export and `injectGitCredentials()` are deleted.
`injectGitIdentity()` is untouched — commit identity was always a separate
concern from which token pushes the work, and stays environment-based.

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
`ghs_`, `ghp_`, `gho_` and `ghu_` prefixed strings.

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

Two things then actively favour bash:

- **`flock` is a real syscall wrapper**, one line. Node has no binding for it,
  so single-flight would be a hand-rolled `O_CREAT|O_EXCL` lockfile with backoff
  and a staleness break — and the staleness break is precisely what misbehaves
  under contention.
- **`curl --retry 2` already covers transient retry**, including 5xx and
  connection-refused, so retry and backoff logic stops needing to exist.

What this gives up is type safety on the resolution path and stringier error
message construction. Two things need care in review: splitting status from body
via `-w '\n%{http_code}'` is brittle when a response has no trailing newline,
and `set -euo pipefail` interacts badly with the `read` loop that parses stdin.

If the resolution logic ever grows — multiple hosts, per-repo policy, GHES, a
token map — moving it to Node is a contained rewrite of one file, with the test
suite already in place.

### Fast path and slow path

The two tiers survive the merge, as paths within one script rather than a
language boundary. A cache hit must be fast, because git invokes the helper on
every remote operation; it must therefore fork nothing — no `jq`, no `date -d`,
no `sha256sum`. The cache format is designed to make that possible.

### Cache format

`/run/throng/cache/<sanitised-key>`:

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

A cache hit is therefore: one `read`, one integer compare, one string compare,
one `tail`.

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
rejected. It never touches the slow path.

`gh` mode resolves `api|github.com|` and prints the bare token. The shim cannot
know which repo a given `gh` command targets, so `gh` always resolves against the
task's default scope.

### Resolution order

On a cache miss, under the lock:

1. No readable `/run/throng/config.json` → **decline**: exit 0 with no output.
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

`flock` on a per-key lock file, then **re-check the cache under the lock** — the
process that blocked will find the entry the winner just wrote, and must not
fetch again.

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

Only transient classes retry. A 4xx returns immediately.

The 403 wording matters because an agent that cannot distinguish "not allowed"
from "auth failed, retry" may work around the first by doing something worse:
committing to a different repo, force-pushing elsewhere, rewriting history.

### `gh` shim edge case

If `throng-creds gh` yields nothing — declined, or failed — the shim `exec`s
`gh.real` **without setting `GH_TOKEN` at all**, rather than setting it to the
empty string. `gh` then produces its own idiomatic "not logged in" error instead
of a confusing auth rejection. The helper's stderr has already been printed.

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

`credentials` must be an object with non-blank string `url` and `token`. Errors
are reported as `credentials.url` and `credentials.token`, matching the existing
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
does not begin receiving 400s) but ignored, with a single `log.warn` naming the
repo. `RepoSpec` loses its `token` field; `BaseManifest` gains
`credentials: CredentialsConfig | null`.

### Config file

Written to `/run/throng/config.json`, mode `0600`, inside `/run/throng` at
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
  git's `password_expiry_utc`.
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
path into a running sandbox, and `/run/throng/config.json` is write-once.

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

`/run` is tmpfs and the image sets no `USER`, so both the runtime and the
agent's shells should run as root, making mode `0600` correct and the uid
concern moot. This must be confirmed against a live E2B sandbox — including that
tmpfs contents survive pause and resume — before the design relies on it.

If the agent turns out to run as a different uid, the fallback is `/run/throng`
at `0711` with the file at `0644`: readable by the agent, still not listable.
`/run/throng/cache` must be writable by whichever uid runs `git` and `gh`.

## Out of scope

- The control plane's implementation of the credentials API.
- A credential rotation endpoint.
- The hardened variant, in which the agent cannot read the identity token at
  all, because a self-hosted MITM proxy mints per request. The same pull model
  works behind it: the `git`/`gh` consumer contract does not change, only where
  the fetch happens. (E2B's declarative `network.rules` transforms are
  static-value and therefore the wrong shape for an hourly-expiring credential.)
- GitHub Enterprise Server hosts.
