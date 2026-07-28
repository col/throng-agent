# throng-agent

Monorepo for Throng's A2A agent runtimes. A shared, published library
(`@throng/agent-core`) owns the whole init pipeline once; each engine ships as a
thin deployable variant that plugs its engine-specific behaviour into core
through a single `EngineAdapter` seam.

One Node process per variant exposes two HTTP surfaces: a **control server**
(`CONTROL_PORT`, default `8080`) that boots warm and holds the lifecycle state
machine, and an **A2A server** that starts only after a successful
`POST /api/initialise` (validate manifest → clone repos → run setup → inject
credentials → start the engine's A2A server).

## Packages

| Path                    | Package                | Role |
| ----------------------- | ---------------------- | ---- |
| `packages/core`         | `@throng/agent-core`   | Shared init/manifest/control-API runtime. Owns the lifecycle state machine, the control HTTP API, git/setup bootstrap, generic manifest validation, boot orchestration, and the process entrypoint. Published to npm (public). |
| `throng-agent-claude`   | `throng-agent-claude`  | Claude Code engine variant over [`@col/a2a-claude`](https://github.com/col/a2a-wrapper). Behavioural parity with the standalone `throng-agent-claude` repo. |
| `throng-agent-codex`    | `throng-agent-codex`   | Codex engine variant over `a2a-codex` (working stub). |

### `@throng/agent-core`

Core drives the entire init pipeline and is engine-agnostic. It validates the
generic manifest skeleton (`repos`, `github_token`, `throng_api_token`,
`setup_commands` and the cross-field repo rules), runs the generic boot steps
(clone → checkout → setup → inject git credentials → build config → serve), and
exposes the control API (`/healthz`, `GET /api/status`, `POST /api/initialise`).
Engine-specific work is delegated to an adapter.

### Variants

A variant is small: it implements `EngineAdapter` for its engine and provides a
one-line entrypoint that hands the adapter to core's `startControlServer`. For
example, `throng-agent-claude/src/index.ts` is essentially:

```ts
import { startControlServer } from "@throng/agent-core";
import { ClaudeEngineAdapter } from "./adapter.js";

startControlServer(new ClaudeEngineAdapter());
```

Variants pin `@throng/agent-core` to an exact version so a published core can't
drift under them.

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

1. Create a `throng-agent-gemini/` package that depends on `@throng/agent-core`
   (pinned exact) and its A2A library.
2. Implement `EngineAdapter` in `throng-agent-gemini/src/adapter.ts`, plus an
   agent-block validator that returns the resolved payload.
3. Add the thin `startControlServer(new GeminiEngineAdapter())` entrypoint in
   `src/index.ts`.

No core changes are required — the workspace picks up any `throng-agent-*`
directory automatically.

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

- Design spec: `throng_agent_claude/docs/superpowers/specs/2026-07-28-throng-agent-monorepo-design.md`
- Implementation plan: `throng_agent_claude/docs/superpowers/plans/2026-07-28-throng-agent-monorepo.md`
