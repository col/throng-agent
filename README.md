![Throng Agent logo](docs/logo.png)

# Throng Agent

Throng Agent packages common agentic coding platforms (Claude Code, Codex etc.) and provides a consistent interface via the [A2A (Agent to Agent) protocol](https://github.com/a2aproject/A2A).

It's designed to be configured at runtime via an initialise API that allows you to specify the configuration and credentials necessary for it to complete real development tasks. One prebuilt image can be launched and configured with many different agent configurations without rebuilds or redeploys.

Throng agent works best when run on a platform such as [E2B.dev](https://e2b.dev/) that provides ephemeral sandbox environments to run your agentic coding tasks.

## Initialisation

`POST /api/initialise` takes a JSON manifest that specifies:
- A list of repositories the agent can access
- A list of setup commands to configure the environment
- A GitHub token for the agent to checkout repos, raise PRs etc.
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
  "github_token": "ghp_…",     // top-level; clones repos and authenticates `gh`
  "user_identity": {           // optional — the identity commits are made under
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
  model and is passed through as-is. It takes one of three shapes:
  - `{ "type": "adaptive" }`
  - `{ "type": "disabled" }`
  - `{ "type": "enabled", "budget_tokens": 4096 }` — the legacy
    extended-thinking shape (`budget_tokens` must be an integer `>= 1024`).
    Current models (Opus 4.7/4.8, Sonnet 5, Fable 5) reject this form; they
    use `adaptive` together with `effort` instead.
- **`effort`** is optional and sets the reasoning effort level: one of
  `low`, `medium`, `high`, `xhigh`, `max`.

### `github_token` and `user_identity`

- **`github_token`** clones the repos and authenticates the `gh` CLI (exported as
  `GH_TOKEN`). It falls back to the `GITHUB_TOKEN` env var, and a blank string
  counts as absent. A repo entry's own `token` still wins for that repo.
- **`user_identity`** is optional, as are both of its fields. `name` and `email`
  become the commit identity, exported as `GIT_{AUTHOR,COMMITTER}_{NAME,EMAIL}` for
  every command the agent runs. Without an identity from some source git refuses to
  commit at all ("Author identity unknown"), and an agent will improvise one.
  The field names mirror git's own `[user]` config section, which is what they
  become — `name` rather than `username` deliberately, since in GitHub's vocabulary
  a username is the account handle (`octocat`), not a display name.

The two are independent: a commit identity is a git concept, unrelated to which
token pushes the work, so a manifest may carry either, both, or neither. Nothing is
written to `~/.gitconfig` — the identity, the git credential helper and `GH_TOKEN`
all live in the process environment for the life of the sandbox.

## What's in the box?

This repo mostly just provides the initialise API and a thin layer over the agent platforms, which are exposed as A2A servers by the [a2a-wrapper](https://github.com/shashikanth-gs/a2a-wrapper) project.

## Packages

| Path                    | Package                | Role |
| ----------------------- | ---------------------- | ---- |
| `packages/core`         | `@throng/agent-core`   | Shared init/manifest/control-API runtime. Owns the lifecycle state machine, the control HTTP API, git/setup bootstrap, generic manifest validation, boot orchestration, and the process entrypoint. Published to npm (public). |
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
