![Throng Agent logo](docs/logo.png)

# Throng Agent

Throng Agent packages common agentic coding platforms (Claude Code, Codex etc.) and provides a consistent interface via the [A2A (Agent to Agent) protocol](https://github.com/a2aproject/A2A).

It's designed to be configured at runtime via an initialise API that allows you to specify the configuration and credentials necessary for it to complete real development tasks. One prebuilt image can be launched and configured with many different agent configurations without rebuilds or redeploys.

Throng agent works best when run on a platform such as [E2B.dev](https://e2b.dev/) that provides ephemeral sandbox environments to run your agentic coding tasks.

## Initialisation

`POST /api/initialise` takes a JSON manifest that specifies:
- A list of repositories the agent can access
- A list of setup commands to configure the environment
- Credentials: either a control-plane endpoint to fetch short-lived GitHub tokens from, or a static token
- Agent configuration:
  - Platform type (claude, codex, etc.)
  - Auth (a tagged credential — API key or, for claude, an OAuth token)
  - Model
  - Plugins

### Manifest Example

```jsonc
{
  "repos": [
    { "url": "https://github.com/acme/app", "ref": "main", "dest": "app", "primary": true }
  ],
  "setup_commands": ["npm install"],
  "credentials": {                    // pull mode: where to fetch GitHub tokens
    "url": "https://control-plane.example",
    "token": "…"                      // task-scoped identity
  },
  "github_token": "ghp_…",            // static; wins over `credentials`
  "user_identity": {                  // optional — the identity commits are made under
    "name": "Throng Bot",
    "email": "bot@throng.dev"
  },
  "agent": {
    "platform": "claude",      // required — selects the engine adapter (claude | codex)
    "auth": {                  // the one credential; see below
      "type": "api_key",       // claude: api_key | oauth — codex: api_key
      "token": "sk-…"
    },
    "model": "…",              // engine-specific
    "permission_mode": "plan", // engine-specific (claude)
    "thinking": { "type": "adaptive" }, // engine-specific (claude)
    "effort": "high",          // engine-specific (claude)
    "plugins": []              // engine-specific (claude)
  }
}
```

### `agent.auth`

The single credential the engine runs under, tagged with its own type:

```jsonc
"auth": { "type": "oauth", "token": "sk-ant-oat01-…" }
```

| `type` | Engines | Becomes | Billing |
| --- | --- | --- | --- |
| `api_key` | claude, codex | `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | API credits |
| `oauth` | claude | `CLAUDE_CODE_OAUTH_TOKEN` | the token owner's Claude Code subscription |

`oauth` takes the kind of token `claude setup-token` mints. An engine rejects a
`type` it does not accept — `codex` with `oauth` is a `400` on `agent.auth.type`.
Both fields are required and `token` must be non-blank; there is no coercion of a
blank token to "absent", because silently switching billing mode is exactly the
failure this shape exists to prevent. An invalid `auth` block is a `400` and
never falls back to the environment — a caller who stated an intent and got it
wrong sees the error, rather than a different billing mode being silently
substituted underneath them. The token is trimmed before use, on both the
manifest and the env-fallback path below, so a copy-pasted trailing newline
never reaches the SDK's environment.

`auth` may be omitted, in which case the credential falls back to the
environment: `CLAUDE_CODE_OAUTH_TOKEN` then `ANTHROPIC_API_KEY` for claude,
`OPENAI_API_KEY` for codex. OAuth is checked first — a sandbox carrying both is
already an odd configuration, and exporting an OAuth token is an unambiguous
request for subscription billing. As with the other env fallbacks, this is a
standalone-`docker run` convenience: under E2B the runtime is resumed with a
scrubbed environment. If `auth` is omitted and nothing is set in the environment
either, that is not an error: boot proceeds, and the run logs a warning that
requests will fail unless another auth path is configured.

**For claude, selecting a type clears the others.** The Agent SDK reads its
credential off the process environment and the A2A wrappers hand it a copy of
`process.env`, so an `ANTHROPIC_API_KEY` that is merely ambient in the sandbox —
baked into the image, passed with a host `-e`, left by an earlier configuration
— would reach Claude Code even though the manifest asked for OAuth, and the run
would silently bill API credits. Whichever type is selected, `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` are all removed from the
environment before the winner is set, so the billing mode is a guarantee rather
than a bet on the engine's internal precedence. When nothing is resolved at all
— no `auth` block and nothing set in the environment — the scheme variables are
left untouched: none of them held a non-blank value, so none of them are
cleared, and an ambient `ANTHROPIC_API_KEY` survives. `ANTHROPIC_AUTH_TOKEN` is
the exception: it is never a legitimate credential source, so it is scrubbed
regardless of whether a type was selected. Codex has no such extra variable and
a single-entry scheme table, so under codex only `OPENAI_API_KEY` is ever
touched, and nothing at all is scrubbed when nothing resolves.

Before any of that runs, a `~/.claude/settings.json` that *mentions*
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or `CLAUDE_CODE_OAUTH_TOKEN` in its
`env` block is a hard boot error, checking key presence rather than truthiness —
a settings `env` block replaces the inherited variable rather than merging with
it, so even `{ "ANTHROPIC_API_KEY": "" }` would erase the credential about to be
set and read to Claude Code as unset, letting it fall through to the next rung
of its own precedence exactly as a deleted variable would. A top-level
`apiKeyHelper` is rejected too — checked by truthiness, so `""` passes — because
it outranks `CLAUDE_CODE_OAUTH_TOKEN` in Claude Code's own precedence and
survives the scrub above, since it isn't an environment variable at all.

`agent.api_key` was the previous form and is **gone**, not deprecated.
`resolveAuth` branches only on `agent.auth`, so a manifest still sending
`api_key` has it neither read nor rejected — it is ignored entirely. The
credential still falls through to the environment, then to none, exactly as if
`auth` were absent: nothing fails, and boot proceeds with the same warning
described above. That fallback is the hazard, not a safety net: under a
`docker run` carrying an ambient `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`,
a stale `api_key` manifest resolves a credential from whichever variable is set
— potentially in a different billing mode than the one the stale field named —
with nothing to flag that the field was ignored. Update any manifest still using
it.

### `thinking` and `effort` (claude)

- **`thinking`** is optional. It controls extended thinking on the Claude
  model. It takes one of three shapes:
  - `{ "type": "adaptive" }`
  - `{ "type": "disabled" }`
  - `{ "type": "enabled", "budget_tokens": 4096 }` — the legacy
    extended-thinking shape (`budget_tokens` must be an integer `>= 1024`).
    Current models (Opus 4.7/4.8, Sonnet 5, Fable 5) reject this form; they
    use `adaptive` together with `effort` instead.
- **`effort`** is optional and sets the reasoning effort level: one of
  `low`, `medium`, `high`, `xhigh`, `max`.

### `credentials`, `github_token` and `user_identity`

- **`credentials`** is how the agent gets GitHub tokens in production. `git` uses
  a credential helper and `gh` is wrapped by a shim; both call `throng-creds`,
  which POSTs to `url` — the complete endpoint, used verbatim — with `token` as
  its bearer identity and gets back a short-lived, repo-scoped installation
  token. The path lives control-plane-side, so an API version bump needs no
  change to the sandbox image. Nothing
  is cached beyond its expiry, and no GitHub credential is ever placed in the
  process environment — an environment is fixed at `execve()`, so a token put
  there at boot could never be refreshed, which is what broke long-running and
  paused tasks. `url` must start with `https://` and must not end in a trailing
  slash (it is sent exactly as given, and a trailing slash is a different route);
  both are rejected at validation as `credentials.url`.
- **`github_token`** is a literal token, and **takes precedence over
  `credentials`** when both are present. It exists so the image can be run
  standalone, without the Throng platform. It is honoured inside `throng-creds`
  rather than by a separate code path, so a standalone run exercises the same
  wiring production uses. It falls back to the `GITHUB_TOKEN` env var, and a
  blank string counts as absent.
- **`user_identity`** is optional, as are both of its fields. `name` and `email`
  become the commit identity, exported as `GIT_{AUTHOR,COMMITTER}_{NAME,EMAIL}`
  for every command the agent runs. Without an identity from some source git
  refuses to commit at all ("Author identity unknown"), and an agent will
  improvise one. The field names mirror git's own `[user]` config section —
  `name` rather than `username` deliberately, since in GitHub's vocabulary a
  username is the account handle (`octocat`), not a display name. It is an
  initialise-only field: `/api/prepare` rejects it, for the reasons in
  *Preparing a workspace* below.

Credentials and identity are independent: a commit identity is a git concept,
unrelated to which token pushes the work, so a manifest may carry either, both,
or neither.

`repos[].token` is still accepted but ignored. `throng-creds` scopes every
request to the repo git is talking to, which a static per-repo token cannot.

Whichever mode is in play, `/api/initialise` — and `/api/prepare` — writes what
the helper needs to `$HOME/.throng/config.json` (mode `0600`, in a `0700`
directory) and the credential cache lives in `$HOME/.throng/cache`. Repos are
cloned into `$HOME/workspace`. `/api/prepare` deletes both `$HOME/.throng` paths
again before it finishes, since what it leaves on disk is captured into an image
every task in the project boots from; see *Preparing a workspace* below.

`$HOME` because the sandbox runs unprivileged: the same image runs as root under
`docker run` but as `uid 1000` under E2B, where `/run` (the original location) is
root-owned and unwritable, `/workspace` cannot be created at all, and `/dev/shm`
(the intermediate one) is world-writable. `$HOME` needs no privilege and its
parent is owned by the user, so nothing can squat the directory. The trade is
that it is disk-backed, so the identity token does land on a persisted layer —
accepted, because E2B snapshots memory on pause anyway and the design already
assumes the agent can read that token.

`HOME` itself must be set, and both the runtime and the bash helper read that
variable and nothing else — deliberately, since Node's `os.homedir()` falls back
to the passwd entry and bash's `$HOME` does not, and a disagreement would leave
the runtime writing a file the helper never looks at. An unset `HOME` is a hard
error rather than a fallback.

All three paths can be overridden: `THRONG_CONFIG`, `THRONG_CREDS_CACHE` and
`WORKSPACE_DIR`. Note that under E2B these are overrides only, not a delivery
mechanism — the runtime process there is captured in the template snapshot and is
resumed with a scrubbed environment that carries neither the image's `ENV` nor
the template's `setEnvs`. Anything the runtime must have comes from a code
default, from `/api/initialise`, or from a file.

### Running standalone

```bash
docker run -d -p 8080:8080 -p 3030:3030 --name throng-agent ghcr.io/col/throng-agent:latest

curl -X POST localhost:8080/api/initialise -H 'content-type: application/json' -d '{
  "repos": [{"url":"https://github.com/acme/app","ref":"main","dest":"app","primary":true}],
  "github_token": "ghp_…",
  "agent": {"platform":"claude","auth":{"type":"api_key","token":"sk-…"}}
}'
```

Then confirm the credential wiring end to end:

```bash
docker exec throng-agent bash -lc 'cd ~/workspace/app && git fetch && gh auth status'
```

Plain `docker run` is **not** a faithful reproduction of production, in two ways
that have each hidden a bug already:

- It starts the container as **root**, because the image sets no `USER`. E2B does
  not honour `USER` and runs the sandbox as `uid 1000`. Add `--user 1000:1000`.
- It **inherits the image's `ENV`**. The E2B runtime inherits none of it, so a
  variable set only in the Dockerfile is present under `docker run` and absent in
  production. Strip them with a bare `-e NAME` (no `=`) for each of the three the
  image sets — `CONTROL_PORT`, `GIT_TERMINAL_PROMPT`, `LANG` — with the same name
  unset on the host, which makes Docker drop it entirely. `--env-file /dev/null`
  does *not* do this: it suppresses nothing the image itself sets.

Both together, which is what production actually looks like:

```bash
docker run -d -p 8080:8080 -p 3030:3030 --name throng-agent \
  --user 1000:1000 -e HOME=/home/node -e USER=node \
  -e PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  -e CONTROL_PORT -e GIT_TERMINAL_PROMPT -e LANG \
  ghcr.io/col/throng-agent:latest
```

(`node:20-slim` already has a `node` user at uid 1000 with `/home/node`, which
stands in for E2B's `user`/`/home/user`.)

## Preparing a workspace (project snapshots)

`POST /api/prepare` warms a sandbox's workspace without initialising an agent, so
the sandbox can be snapshotted and every later task booted from the result with
its repositories, toolchains and dependency caches already on disk.

```jsonc
{
  "repos": [
    { "url": "https://github.com/acme/app", "ref": "main", "dest": "app", "primary": true }
  ],
  "setup_commands": ["npm install"],
  "credentials": { "url": "https://…/api/credentials", "token": "…" }
}
```

It takes the workspace half of the initialise manifest — `repos`,
`setup_commands`, and `credentials` or `github_token` — and **rejects** `agent`
and `user_identity` with a `400`. A snapshot is shared by every task in the
project and is stored by the sandbox provider, so no agent configuration, no LLM
credential and no commit identity may be baked into one; a manifest carrying them
is an initialise manifest sent to the wrong route.

Every other field is validated by exactly the rules `/api/initialise` applies,
with one addition: a `repos[].url` that embeds a credential
(`https://x-access-token:ghs_…@github.com/…`) is a `400` here, though it stays
legal on `/api/initialise`. git writes the clone URL verbatim into
`<dest>/.git/config`, which sits inside the workspace the snapshot captures and
is the one place the credential wipe below cannot reach.

It responds `202 {"status":"booting"}` and reports progress through the same
`GET /api/status` states as `/api/initialise` (`booting`, `cloning`, `setup`),
settling at a new terminal state, **`prepared`**. Before reporting it, the
credential config and the whole token cache are deleted and then re-checked to be
gone — if that deletion fails, so does the prepare. It never injects engine
credentials and never starts the A2A server. A second `/api/prepare` is a `409`,
which the control plane treats as success, because the job that drives it has to
be safe to retry.

That wipe covers what the agent runtime itself writes — `$HOME/.throng` — and
nothing else. `setup_commands` run **with live credentials by design**, so
anything one of them chooses to persist elsewhere in `$HOME` (an `~/.npmrc` with
a registry token, a `~/.config/gh/hosts.yml` from a `gh auth login`, a
`~/.git-credentials` from a command that sets `credential.helper store`) lands in
the snapshot untouched: the wipe does not go looking for it. Nothing on the
default path does this — the image configures only `throng-creds`, whose `store`
mode discards what git hands it — so this is a property of the commands a project
supplies, and worth checking before enabling snapshots for one.

`prepared` is a rest state, not a failure state: a sandbox restored from a
snapshot resumes there and accepts exactly one `/api/initialise`, which is what
configures the agent for a specific task. A second one still gets a `409`.

Repositories are synced rather than cloned blind, on both routes: an absent
destination is cloned and checked out as before, a destination that is already a
work tree for the same remote is fetched, force-checked-out and reset to
`origin/<ref>`, and anything else — a different remote, a plain directory, a
dangling symlink — is removed and cloned fresh. `checkout -f` because a prepared
workspace is normally dirty (`npm ci` and `mix deps.get` rewrite tracked
lockfiles, and a plain checkout refuses to switch branches over them); it
discards modifications to **tracked** files only. There is deliberately no
`git clean` — the untracked `_build`, `deps` and `node_modules` a prepare leaves
behind are the entire point of a snapshot. A `ref` that is not a branch (a tag or
a SHA) is checked out and not reset, since it has no `origin/<ref>` to reset to.

## What's in the box?

This repo mostly just provides the initialise API and a thin layer over the agent platforms, which are exposed as A2A servers by the [a2a-wrapper](https://github.com/shashikanth-gs/a2a-wrapper) project.

## Packages

| Path                    | Package                | Role |
| ----------------------- | ---------------------- | ---- |
| `packages/core`         | `@throng/agent-core`   | Shared init/manifest/control-API runtime. Owns the lifecycle state machine, the control HTTP API, git/setup bootstrap, generic manifest validation, boot orchestration, the process entrypoint, and the `throng-creds` credential helper and `gh` shim (`src/creds/*.sh`) that the image installs. Published to npm (public). |
| `throng-agent`          | `throng-agent`         | The deployable all-in-one image. Wires every engine adapter into a registry and selects one per-`initialise` via `agent.platform`. Owns the single Dockerfile; runtime `CMD` runs `throng-agent/dist/index.js`. |
| `throng-agent-claude`   | `throng-agent-claude`  | Claude Code adapter **library** over [`@col/a2a-claude`](https://github.com/col/a2a-wrapper) — a temporary fork of `a2a-claude`. Exports `ClaudeEngineAdapter`; consumed by the `throng-agent` app. |
| `throng-agent-codex`    | `throng-agent-codex`   | Codex adapter **library** over the upstream [`a2a-codex`](https://github.com/shashikanth-gs/a2a-wrapper/tree/main/a2a-codex). Exports `CodexEngineAdapter`; consumed by the `throng-agent` app. |

### Adding a new engine (e.g. Gemini)

1. Create a `throng-agent-gemini/` adapter **library** that depends on
   `@throng/agent-core` (pinned exact) and its A2A library.
2. Implement `EngineAdapter` in `throng-agent-gemini/src/adapter.ts`, plus an
   agent-block validator that returns the resolved payload, and export the adapter
   from the package barrel (`src/index.ts`).
3. Add it to the `throng-agent` app's `createRegistry()` under its platform key:

   ```ts
   return {
     claude: new ClaudeEngineAdapter(),
     codex: new CodexEngineAdapter(),
     gemini: new GeminiEngineAdapter(),
   };
   ```

No core changes are required — routing is data-driven off the registry keys, and
the workspace picks up any `throng-agent*` directory automatically.

## Workspace commands

Tooling is npm workspaces + [Turborepo](https://turbo.build) + [Changesets](https://github.com/changesets/changesets).

```bash
npm run build       # turbo run build across all packages
npm run typecheck   # turbo run typecheck
npm test            # turbo run test
npm run changeset   # record a version bump / changelog entry
```

### Installing

The `throng-agent-claude` variant temporarily depends on `@col/a2a-claude`, published to GitHub Packages. GitHub Packages requires authentication for **all** npm downloads — even public packages — so installs need a token with `read:packages` regardless of the package's visibility:

```bash
export GITHUB_TOKEN=$(gh auth token)
npm ci
```
