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
  - Platform API Key
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
    "api_key": "sk-…",         // generic LLM key; the adapter maps it to its SDK env var
    "model": "…",              // engine-specific
    "permission_mode": "plan", // engine-specific (claude)
    "thinking": { "type": "adaptive" }, // engine-specific (claude)
    "effort": "high",          // engine-specific (claude)
    "plugins": []              // engine-specific (claude)
  }
}
```

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
  which POSTs to `<url>/v1/credentials/github` with `token` as its bearer
  identity and gets back a short-lived, repo-scoped installation token. Nothing
  is cached beyond its expiry, and no GitHub credential is ever placed in the
  process environment — an environment is fixed at `execve()`, so a token put
  there at boot could never be refreshed, which is what broke long-running and
  paused tasks. `url` must start with `https://` and must not end in a trailing
  slash (the helper appends the path to it verbatim); both are rejected at
  validation as `credentials.url`.
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
  username is the account handle (`octocat`), not a display name.

Credentials and identity are independent: a commit identity is a git concept,
unrelated to which token pushes the work, so a manifest may carry either, both,
or neither.

`repos[].token` is still accepted but ignored. `throng-creds` scopes every
request to the repo git is talking to, which a static per-repo token cannot.

Whichever mode is in play, `/api/initialise` writes what the helper needs to
`/dev/shm/throng/config.json` (mode `0600`, in a `0700` directory) and the
credential cache lives in `/dev/shm/throng/cache`. `/dev/shm` is tmpfs, so no
credential reaches a persisted filesystem, and it is writable without privilege —
which matters because the same image runs as root under `docker run` but as
`uid 1000` under E2B, where `/run` (the original location) is root-owned and
unwritable. Both paths can be overridden with `THRONG_CONFIG` and
`THRONG_CREDS_CACHE`.

### Running standalone

```bash
docker run -d -p 8080:8080 -p 3030:3030 --name throng-agent ghcr.io/col/throng-agent:latest

curl -X POST localhost:8080/api/initialise -H 'content-type: application/json' -d '{
  "repos": [{"url":"https://github.com/acme/app","ref":"main","dest":"app","primary":true}],
  "github_token": "ghp_…",
  "agent": {"platform":"claude","api_key":"sk-…"}
}'
```

Then confirm the credential wiring end to end:

```bash
docker exec throng-agent bash -lc 'cd /workspace/app && git fetch && gh auth status'
```

Note that plain `docker run` starts the container as root, because the image sets
no `USER`. E2B does not honour `USER` and runs the sandbox as `uid 1000`, so a
standalone run is **not** a faithful reproduction of production for anything that
writes outside `/workspace`. Add `--user 1000:1000` to reproduce that half — it is
what a credential-path bug hid behind once already.

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
