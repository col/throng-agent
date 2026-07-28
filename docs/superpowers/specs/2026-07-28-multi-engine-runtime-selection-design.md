# Multi-Engine Runtime Selection — Design

**Date:** 2026-07-28
**Status:** Approved (pending user spec review)
**Repo:** `throng_agent` monorepo

## Problem

Today each engine ships as its own deployable image (`throng-agent-claude`,
`throng-agent-codex`), with the engine fixed at build time. That's the one part
of the agent still configured at build time rather than at runtime — everything
else (repos, credentials, model, permission mode, plugins) is supplied through
the `POST /api/initialise` manifest. We want the engine to become a runtime
choice too: **one `throng-agent` image containing all engines, with the engine
selected per-initialise via the manifest.** This gives a single artifact to
build/scan/patch and a pool of identical warm containers, any of which can become
any engine on demand.

We also want to keep the door open to publish lean per-engine images again later,
without an architectural change.

## Decision summary

- The manifest's `agent` object gains a required `platform` field (`"claude"`,
  `"codex"`, …) selecting the engine, and a generic `api_key` field replacing the
  per-engine `anthropic_api_key` / `openai_api_key`.
- `@throng/agent-core` routes on `agent.platform` through an **adapter registry**
  instead of a single injected adapter.
- A new deployable **`throng-agent`** app package wires the registry and owns the
  single Dockerfile. The existing `throng-agent-claude` / `throng-agent-codex`
  packages become pure adapter **libraries** (their `index.ts` + `Dockerfile` are
  removed).
- The engine adapters stay separate library packages, so re-adding a per-engine
  image later is a ~5-line entrypoint + a Dockerfile, not a refactor.

## Manifest shape

```jsonc
{
  "repos": [ /* unchanged */ ],
  "setup_commands": [ /* unchanged */ ],
  "github_token": "…",       // unchanged, top-level (workspace provisioning)
  "throng_api_token": "…",   // unchanged, top-level
  "agent": {
    "platform": "claude",    // NEW — required; selects the adapter
    "api_key": "sk-…",       // NEW — generic LLM key; adapter maps to its SDK env var
    "model": "…",            // engine-specific (as today)
    "permission_mode": "…",  // engine-specific (claude)
    "plugins": [ /* … */ ]   // engine-specific (claude)
  }
}
```

Removed: top-level `anthropic_api_key` and the codex `openai_api_key`.
`github_token` / `throng_api_token` stay top-level — they are workspace/platform
concerns, not the LLM credential.

Rationale for placing `platform` and `api_key` **inside `agent`**: they are part
of the agent's definition, kept together with the engine's other options. Core
treats `agent.platform` as the single reserved sub-field it reads to route;
everything else in `agent` remains the selected adapter's opaque payload.

## Core (`@throng/agent-core`) changes

### Adapter registry + routing
- `EngineAdapter<TAgent, TConfig>` is unchanged in shape (still
  `validateAgent` / `injectCredentials` / `buildAgentConfig` / `createA2AServer` /
  optional `classifyBootError`).
- `validate(input, registry, env)` where `registry: Record<string, EngineAdapter>`:
  1. `input` must be an object; `input.agent` must be an object.
  2. Read `agent.platform`. If missing, not a string, or not a key of `registry`,
     return `400` with `[{ field: "agent.platform", reason: "must be one of <keys>" }]`.
  3. Select `adapter = registry[platform]`.
  4. Delegate the rest of the `agent` block + generic key to
     `adapter.validateAgent(input, env)` exactly as today.
  5. Generic manifest validation (repos, tokens, setup_commands, cross-field
     rules) is unchanged.
  6. On success return `{ ok: true, manifest, adapter }` — the resolved manifest
     plus the selected adapter, so boot doesn't re-look-up.
- `Manifest<TAgent>` gains a resolved top-level `platform: string`. Core lifts the
  routing tag out of the raw `agent` object into a known place on the resolved
  manifest (for logging/status). The adapter's resolved `TAgent` payload stays
  engine-specific and does not carry `platform`.

### TaskRun
- Constructed with the registry: `new TaskRun(bootDeps, registry)`.
- `initialise` calls `validate(payload, registry)`; on success it stashes the
  returned selected adapter (`this.selectedAdapter`) and uses it for the whole
  boot (`injectCredentials` / `buildAgentConfig` / `createA2AServer` /
  `classifyBootError`).

### Entry points
- `startControlServer(registry)` and `buildServer(registry)` take the registry
  instead of a single adapter. `createControlApp({ taskRun })` and
  `defaultBootDeps()` are unchanged.

### Shared credential helper
- New export `resolveApiKey(agent, env, fallbackEnvVars): string | null` returns
  `agent.api_key` (blank→null) ?? the first non-blank value among
  `fallbackEnvVars` ?? null. This keeps the manifest *field* uniform while the
  *env var* stays per-engine. Adapters call it.

## Adapter changes (small)

Each adapter's `validateAgent` resolves the key via
`resolveApiKey(agent, env, [<its SDK env var>])` and stores the result in its
resolved payload. `injectCredentials` sets that SDK env var from the resolved
key.

- **Claude:** fallback env var `ANTHROPIC_API_KEY`; `injectCredentials` sets
  `process.env.ANTHROPIC_API_KEY`. `assertNoAnthropicKeyInSettings` stays here.
  The old `anthropic_api_key` field handling is deleted.
- **Codex:** fallback env var `OPENAI_API_KEY`; `injectCredentials` sets
  `process.env.OPENAI_API_KEY`. The old `openai_api_key` field handling is deleted.

Adapters do **not** read `platform` (core already routed on it). Keeping each
adapter's SDK env var as the fallback preserves the operator convenience of
setting `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` in the container env when the
manifest omits `api_key`.

## Packaging

### New deployable: `throng-agent`
- Directory `throng-agent/`; package name `throng-agent` (the shipped artifact).
- Depends on `@throng/agent-core` + both adapter packages.
- `src/index.ts`:
  ```ts
  import { startControlServer } from "@throng/agent-core";
  import { ClaudeEngineAdapter } from "throng-agent-claude";
  import { CodexEngineAdapter } from "throng-agent-codex";

  startControlServer({
    claude: new ClaudeEngineAdapter(),
    codex: new CodexEngineAdapter(),
  });
  ```
- Owns the single Dockerfile (the monorepo-root build that installs the workspace
  and builds core + both adapters + this app; runtime `CMD` runs
  `throng-agent/dist/index.js`).

### Adapter libraries
- `throng-agent-claude` / `throng-agent-codex` lose their `index.ts` and
  `Dockerfile`; they export their adapter and validators as libraries. They stay
  private workspace packages, consumed by the `throng-agent` app.

### Workspace mechanics
- The monorepo root `package.json` is renamed from `throng-agent` to
  `throng-agent-monorepo` (npm workspaces require unique names; the deployable now
  claims `throng-agent`). Root stays `private: true`.
- The `workspaces` glob becomes `["packages/*", "throng-agent*"]` so it matches
  the new `throng-agent/` app plus the `throng-agent-*` adapter libraries.

### Door left open (per-engine images later)
Re-introducing a lean single-engine image is: add a tiny package (or a second
Docker target) whose `index.ts` wires just one adapter —
`startControlServer({ claude: new ClaudeEngineAdapter() })` — plus a Dockerfile.
No core or adapter changes. The spec calls this out so the option is not lost.

## Error handling

- Missing / non-string / unregistered `agent.platform` → `400`
  `[{ field: "agent.platform", reason: "must be one of claude, codex" }]`.
- All existing validation contracts (repos, tokens, setup, engine-specific agent
  keys) are unchanged.
- Boot never starts an engine that isn't in the registry.

## Testing

- **Core:** registry routing (each platform selects the right adapter); the
  missing/unknown-platform `400` paths; `validate` returning the selected adapter;
  `resolveApiKey` precedence (manifest value → env fallback → null); `Manifest`
  carries resolved `platform`.
- **Adapters:** `validateAgent` resolves `api_key` with the correct SDK env
  fallback; `injectCredentials` sets the correct env var; the removed per-engine
  key field no longer appears.
- **`throng-agent` app:** the entrypoint registers both engines; a manifest with
  `platform: "claude"` boots the Claude adapter and `platform: "codex"` the Codex
  adapter (mirror the existing integration/boot tests, now driven through the
  registry).

## Docs

- README: manifest examples and the credential section updated for
  `agent.platform` / `agent.api_key`; the "one `throng-agent` image, engine chosen
  at initialise" story replaces the per-variant framing; keep the a2a-wrapper and
  fork sections.
- Note the per-engine-image escape hatch in the README packaging section.

## Non-goals

- No env-var engine selection (`THRONG_ENGINE` etc.) — engine is manifest-only.
- No per-engine images built now (only the escape hatch is preserved).
- No change to the A2A protocol surface, lifecycle states, or the control API
  routes — only the manifest schema and the core routing seam change.
- No support for multiple LLM keys per engine yet; if an engine later needs more,
  its adapter reads additional fields from its own `agent` block.
