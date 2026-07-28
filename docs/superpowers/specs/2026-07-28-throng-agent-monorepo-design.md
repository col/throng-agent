# Throng Agent Monorepo — Design

**Date:** 2026-07-28
**Status:** Approved (pending user spec review)

## Problem

`throng_agent_claude` wraps the `@col/a2a-claude` library and adds a manifest +
`/api/initialise` control API for configuring the agent at boot. We now need a
sibling that does the same thing over the `a2a-codex` library (maintained
upstream at `shashikanth-gs/a2a-wrapper`), with Gemini and other engines to
follow.

We do **not** want to duplicate the manifest / initialise-API logic per engine,
and we do not want to fragment the work across many loosely-related repos.

## Decision

Build a **single `throng_agent` monorepo** that mirrors the structure and
tooling of the upstream `a2a-wrapper` monorepo: a shared, published `core`
library plus one deployable package per engine. This is a **fresh repository**;
the current `throng_agent_claude` repo is archived once the Claude variant is
green in the monorepo.

### Reference: how `a2a-wrapper` is organised

- **npm workspaces** — root `package.json` with `"workspaces": ["packages/*", "a2a-*"]`.
- **Turborepo** (`turbo.json`) — `build`/`test`/`typecheck` all `dependsOn: ["^build"]`
  so `core` builds before variants; `dist/**` is the cached build output.
- **Changesets** (`.changeset/`) — independent per-package semver and
  `changeset publish` to npm.
- **Layout split** — shared library at `packages/core/` (published as the scoped
  `@a2a-wrapper/core`, its own semver); each engine variant is a **top-level
  `a2a-<name>/` directory** with its own version, `bin`, `Dockerfile`,
  entrypoint, `agents/`, `schemas/`.
- **Dependency direction** — every variant depends on `@a2a-wrapper/core` at an
  exact pinned version (resolved to the local workspace package during dev).
  Core declares shared runtime deps (`express`, `uuid`, `@a2a-js/sdk`) as
  **peerDependencies**; each variant provides them plus its engine SDK.
- Core ships **monorepo-guard tests**: `no-duplicates`, `publish-config`,
  `tsconfig-consistency`.

## Target layout

```
throng_agent/
  package.json          # private root; workspaces: ["packages/*", "throng-agent-*"]
  turbo.json            # build/test/typecheck dependsOn ["^build"], cache dist/**
  .changeset/           # per-package semver
  packages/
    core/               # @throng/agent-core — published library
  throng-agent-claude/  # deployable variant → core + @col/a2a-claude
  throng-agent-codex/   # deployable variant → core + a2a-codex (upstream)
```

Shared code under `packages/`; deployable variants as top-level
`throng-agent-*` directories — exactly the a2a-wrapper split.

**Package names / scope:** core publishes as `@throng/agent-core` (requires the
`throng` npm org). Variants are unscoped deployable packages
(`throng-agent-claude`, `throng-agent-codex`), versioned independently and
shipped primarily as Docker images.

## The core / variant boundary: `EngineAdapter`

The current code already has the seam — `TaskRunDeps` in `task-run.ts`. We
formalise it as an **`EngineAdapter`** interface that `core` defines and each
variant implements. Core owns the entire init / manifest / control-API
pipeline and calls the adapter only for the engine-specific slices.

```ts
// packages/core — the contract
interface EngineAdapter {
  /** Validate + type the engine-specific `agent` block and engine credential(s).
   *  Returns the resolved, engine-shaped agent config or field errors (→ 400). */
  validateAgent(agent: unknown, env: Env): Result<ResolvedAgent, FieldError[]>;

  /** Inject the engine credential into the process (e.g. ANTHROPIC_API_KEY) and
   *  run any engine-specific preflight guards. */
  injectCredentials(manifest: Manifest): void;

  /** Build the engine-shaped server config from the validated manifest. */
  buildAgentConfig(manifest: Manifest, primaryDest: string): EngineConfig;

  /** Start the underlying a2a server; returns a handle with shutdown(). */
  createA2AServer(config: EngineConfig): Promise<ServerHandle>;
}
```

`ResolvedAgent` / `EngineConfig` / `ServerHandle` are generic over the engine —
core treats them opaquely and only the adapter knows their concrete shape.

### What lives where

**`@throng/agent-core` (shared, published):**

- `lifecycle` — the boot state machine.
- `control/server` — Express app: `/healthz`, `/api/status`, `/api/initialise`.
- `control/init-token` — bearer-token auth for `/api/initialise`.
- `bootstrap/{git,setup,askpass}` — clone/checkout, setup commands, askpass shim.
- `manifest` — generic field validation (`repos[]`, `github_token`,
  `setup_commands`, `throng_api_token`) + cross-field rules (exactly one
  `primary`, unique `dest`). Delegates the `agent` block + engine credentials to
  `adapter.validateAgent()`.
- `task-run` — the boot orchestration (clone → setup → inject → build → serve),
  driven entirely through generic bootstrap deps + the `EngineAdapter`.
- `startControlServer(adapter)` / `buildServer(adapter)` / `main()` — the process
  entrypoint. **The whole HTTP server lives once, in core.**
- `log`.
- Monorepo-guard tests (`no-duplicates`, `publish-config`, `tsconfig-consistency`),
  ported from a2a-wrapper.

**`throng-agent-claude` (deployable variant):**

- `ClaudeEngineAdapter` implementing `EngineAdapter` over `@col/a2a-claude`.
- `config/build.ts` — `buildAgentConfig` producing the a2a-claude `AgentConfig`
  (model, permission modes, tools, system-prompt fields, plugins).
- `config/credentials.ts` — `injectAnthropicKey` + `assertNoAnthropicKeyInSettings`
  (Claude Code `settings.json` guard). These are Claude Code concepts, not Throng
  concepts, so they move out of core.
- `config/plugins.ts` — Claude Code plugin/marketplace resolution
  (`agent.plugins` → `claude.plugins` + `claude.marketplaces` +
  `claude.enabledPlugins`). Claude-specific; lives in the variant.
- `src/index.ts` — ~3 lines: `startControlServer(new ClaudeEngineAdapter())`.
- `Dockerfile`, entrypoint, `agents/`, `schemas/`.

**`throng-agent-codex` (deployable variant):**

- `CodexEngineAdapter` implementing `EngineAdapter` over the upstream `a2a-codex`.
- Codex-shaped `agent` block validation + Codex credential injection (e.g.
  `OPENAI_API_KEY`) + `buildAgentConfig` for the Codex server config.
- `src/index.ts` — `startControlServer(new CodexEngineAdapter())`.
- `Dockerfile`, entrypoint, `agents/`, `schemas/`.

### Manifest split (the anti-duplication payoff)

The manifest is validated **once** in core. Core handles the shared skeleton:

- Generic: `repos[]` + full per-repo validation, `github_token`,
  `setup_commands`, `throng_api_token`, cross-field rules.
- Engine-specific: the `agent` object and the engine credential field are handed
  to `adapter.validateAgent()`, which returns typed field errors that core folds
  into the same `400` response contract.

A bad `agent.plugins` entry (Claude) or a bad Codex sandbox option is therefore
still a `400` naming the offending field — but the surrounding pipeline,
lifecycle, auth, and HTTP contract are never rewritten per engine.

## Tooling

npm workspaces + Turborepo + Changesets, adopted verbatim from a2a-wrapper.

- Root `package.json`: `build`/`test`/`typecheck`/`clean` via `turbo run …`;
  `changeset` / `version-packages` / `release` scripts.
- `core` published to npm as `@throng/agent-core` with `publishConfig.access:
  public`; shared runtime deps as `peerDependencies`.
- Variants version independently and ship as Docker images (they may also be
  published if ever useful, but the deploy path is the image tag).

## Migration plan (fresh repo)

1. Scaffold `throng_agent`: root `package.json` (workspaces), `turbo.json`,
   `.changeset/`, shared `tsconfig` base, CI.
2. Extract generic modules from the current `src/` into `packages/core/src`:
   `lifecycle`, `control/`, `bootstrap/`, `log`, generic `manifest` validation,
   and `task-run` refactored to drive an `EngineAdapter`. Define + export the
   `EngineAdapter` contract and `startControlServer`. Port the matching tests.
3. Build `throng-agent-claude`: `ClaudeEngineAdapter` wrapping the current
   `config/build.ts`, `config/credentials.ts`, `config/plugins.ts`; thin
   `index.ts`; `Dockerfile`/entrypoint carried over. Port Claude-specific tests.
   Achieve behavioural parity with today's `throng_agent_claude`.
4. Stub `throng-agent-codex`: `CodexEngineAdapter` over the upstream `a2a-codex`,
   Codex-shaped `agent` validation + credential injection + config build.
   Minimal boot-parity test.
5. Port the monorepo-guard tests into core; wire Changesets + CI publish.
6. Archive `throng_agent_claude` once the Claude variant is green.

## Non-goals

- No behaviour change to the Claude variant's manifest contract or boot
  semantics — this is a restructure, not a redesign of the init API.
- No premature Gemini/other-engine packages; the `EngineAdapter` seam is the
  extension point and future engines are added the same way as Codex.

## Open items

- Confirm ownership/availability of the `throng` npm org before first
  `@throng/agent-core` publish.
- Decide whether to import history from `throng_agent_claude` via `git subtree`
  or start the monorepo with a clean initial commit (default: clean commit,
  with a pointer back to the archived repo).
