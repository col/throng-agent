# throng-agent

`throng-agent` runs a coding agent (Claude Code, Codex, and more to come) as a
long-lived service that is configured **at runtime, not at build time**. A
container boots empty and warm; a single `POST /api/initialise` call then supplies
everything the agent needs for a run — which repositories to clone, setup
commands, credentials, and the agent's own settings (model, permission mode,
tools, system prompt, plugins). Only after that does the A2A server start, bound
to the freshly provisioned workspace. The payoff: one prebuilt image can be
launched into many different agent configurations without rebuilds or redeploys.

Monorepo for Throng's A2A agent runtimes. A shared, published library
(`@throng/agent-core`) owns the whole init pipeline once; each engine ships as a
thin adapter library that plugs its engine-specific behaviour into core through a
single `EngineAdapter` seam. A single deployable `throng-agent` image bundles
every adapter into a registry and selects one per-`initialise` from
`agent.platform` — the engine is a runtime choice, not a build-time one.

The `throng-agent` Node process exposes two HTTP surfaces: a **control server**
(`CONTROL_PORT`, default `8080`) that boots warm and holds the lifecycle state
machine, and an **A2A server** that starts only after a successful
`POST /api/initialise` (validate manifest → select engine → clone repos → run
setup → inject credentials → start the engine's A2A server).

## The manifest

`POST /api/initialise` takes a JSON manifest. `github_token` stays top-level (a
workspace-provisioning concern); the engine is chosen inside `agent` via the
required `platform` field, and the LLM credential is the generic `agent.api_key`
(each adapter maps it onto its own SDK env var, e.g. `ANTHROPIC_API_KEY` /
`OPENAI_API_KEY`, and falls back to that env var when `api_key` is omitted):

```jsonc
{
  "repos": [
    { "url": "https://github.com/acme/app", "ref": "main", "dest": "app", "primary": true }
  ],
  "setup_commands": ["npm ci"],
  "github_token": "ghp_…",     // top-level; used to clone repos
  "agent": {
    "platform": "claude",      // required — selects the engine adapter (claude | codex)
    "api_key": "sk-…",         // generic LLM key; the adapter maps it to its SDK env var
    "model": "…",              // engine-specific
    "permission_mode": "plan", // engine-specific (claude)
    "plugins": []              // engine-specific (claude)
  }
}
```

A missing, non-string, or unregistered `agent.platform` fails closed with a `400`
(`[{ field: "agent.platform", reason: "must be one of claude, codex" }]`).

## Relationship to a2a-wrapper

Throng doesn't implement the A2A protocol itself. Each variant embeds a
per-platform wrapper library from
**[a2a-wrapper](https://github.com/shashikanth-gs/a2a-wrapper)** — an upstream
monorepo that provides spec-compliant A2A servers for a range of agent engines
(`a2a-claude`, `a2a-codex`, `a2a-copilot`, `a2a-opencode`, `a2a-antigravity`, …),
all built on a shared `@a2a-wrapper/core`. a2a-wrapper turns an engine into an
A2A server; **throng-agent adds the layer above it** — the manifest schema and
the `POST /api/initialise` control API that provision a workspace and configure
the agent at boot.

The stack per variant:

```
throng-agent-<engine>   ← manifest + /api/initialise control API  (this repo)
  └─ a2a-<engine>       ← A2A protocol server for that engine     (a2a-wrapper)
       └─ engine SDK    ← e.g. Claude Agent SDK, OpenAI Codex SDK
```

- **Codex** consumes the upstream `a2a-codex` package from npm directly.
- **Claude** *temporarily* consumes `@col/a2a-claude`, published from a **fork**
  ([col/a2a-wrapper](https://github.com/col/a2a-wrapper), branch
  `feat/a2a-claude`), because Throng's changes to the Claude wrapper haven't been
  merged upstream yet. Once they land in
  [shashikanth-gs/a2a-wrapper](https://github.com/shashikanth-gs/a2a-wrapper),
  this variant switches to the upstream `a2a-claude` package — at which point the
  `@col` scope and its GitHub Packages token requirement (see
  [Installing](#installing)) both go away.

## Packages

| Path                    | Package                | Role |
| ----------------------- | ---------------------- | ---- |
| `packages/core`         | `@throng/agent-core`   | Shared init/manifest/control-API runtime. Owns the lifecycle state machine, the control HTTP API, git/setup bootstrap, generic manifest validation, boot orchestration, and the process entrypoint. Published to npm (public). |
| `throng-agent`          | `throng-agent`         | The deployable all-in-one image. Wires every engine adapter into a registry and selects one per-`initialise` via `agent.platform`. Owns the single Dockerfile; runtime `CMD` runs `throng-agent/dist/index.js`. |
| `throng-agent-claude`   | `throng-agent-claude`  | Claude Code adapter **library** over [`@col/a2a-claude`](https://github.com/col/a2a-wrapper) — a temporary fork of `a2a-claude` (see [Relationship to a2a-wrapper](#relationship-to-a2a-wrapper)). Exports `ClaudeEngineAdapter`; consumed by the `throng-agent` app. |
| `throng-agent-codex`    | `throng-agent-codex`   | Codex adapter **library** over the upstream [`a2a-codex`](https://github.com/shashikanth-gs/a2a-wrapper/tree/main/a2a-codex). Exports `CodexEngineAdapter`; consumed by the `throng-agent` app. |

### `@throng/agent-core`

Core drives the entire init pipeline and is engine-agnostic. It validates the
generic manifest skeleton (`repos`, `github_token`, `setup_commands` and the
cross-field repo rules), reads the one reserved sub-field `agent.platform` to
route through the adapter registry, runs the generic boot steps (clone → checkout
→ setup → inject git credentials → build config → serve), and exposes the control
API (`/healthz`, `GET /api/status`, `POST /api/initialise`). Engine-specific work
is delegated to the selected adapter.

### The `throng-agent` app + engine registry

The engine is a **runtime** choice, not a build-time one: a single `throng-agent`
image bundles every adapter and picks one per-`initialise` from `agent.platform`.
The app wires the registry and hands it to core's `startControlServer`.
`throng-agent/src/registry.ts` returns the registry:

```ts
import type { AdapterRegistry } from "@throng/agent-core";
import { ClaudeEngineAdapter } from "throng-agent-claude";
import { CodexEngineAdapter } from "throng-agent-codex";

export function createRegistry(): AdapterRegistry {
  return {
    claude: new ClaudeEngineAdapter(),
    codex: new CodexEngineAdapter(),
  };
}
```

and `throng-agent/src/index.ts` is the one-line entrypoint:

```ts
import { startControlServer } from "@throng/agent-core";
import { createRegistry } from "./registry.js";

startControlServer(createRegistry()); // { claude, codex } keyed by agent.platform
```

The app and each adapter library pin `@throng/agent-core` to an exact version so a
published core can't drift under them.

## The `EngineAdapter` extension point

`EngineAdapter<TAgent, TConfig>` (in `packages/core/src/engine/adapter.ts`) is
the single contract between core and an engine. `TAgent` is the resolved,
engine-shaped payload stored on `manifest.agent`; `TConfig` is the engine's
server config. Core calls the adapter only for the engine-specific slices:

- `validateAgent(input, env)` — validate/resolve the `agent` block and engine
  credentials, returning typed field errors that core folds into the 400
  response.
- `injectCredentials(manifest)` — inject the engine credential(s) into the
  process and run any engine preflight.
- `buildAgentConfig(manifest, primaryDest)` — build the engine server config
  from the resolved manifest.
- `createA2AServer(config)` — start the engine's A2A server, returning a
  `ServerHandle`.
- `classifyBootError?(err, manifest)` — optionally refine the failed boot step.

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

### Per-engine image escape hatch

The single all-in-one image is the default, but a lean single-engine image stays
cheap to add later — no architectural change. Add a small package whose
`index.ts` wires a one-key registry plus its own Dockerfile:

```ts
import { startControlServer } from "@throng/agent-core";
import { ClaudeEngineAdapter } from "throng-agent-claude";

startControlServer({ claude: new ClaudeEngineAdapter() });
```

Because the adapters remain standalone libraries, this reuses them as-is — no core
or adapter changes.

## Workspace commands

Tooling is npm workspaces + [Turborepo](https://turbo.build) + [Changesets](https://github.com/changesets/changesets).

```bash
npm run build       # turbo run build across all packages
npm run typecheck   # turbo run typecheck
npm test            # turbo run test
npm run changeset   # record a version bump / changelog entry
```

### Installing

The `throng-agent-claude` variant depends on `@col/a2a-claude`, published to
GitHub Packages. GitHub Packages requires authentication for **all** npm
downloads — even public packages — so installs need a token with `read:packages`
regardless of the package's visibility:

```bash
export GITHUB_TOKEN=$(gh auth token)
npm ci
```

## Design & plan docs

- Design spec: `docs/superpowers/specs/2026-07-28-throng-agent-monorepo-design.md`
- Implementation plan: `docs/superpowers/plans/2026-07-28-throng-agent-monorepo.md`
