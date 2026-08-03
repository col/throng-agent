# Expose Claude `thinking` + `effort` via the initialise API

**Date:** 2026-08-03
**Status:** Approved
**Scope:** `throng-agent-claude` package only. No changes to `@col/a2a-claude`.

## Goal

Let callers of the Throng Agent `POST /api/initialise` endpoint set Claude's
extended-thinking controls through the embedded `agent` object. The `a2a-claude`
wrapper already supports `model.thinking` and `model.effort` end-to-end (manifest
config → SDK `query()` options → the Claude Agent SDK, which supports both
natively). The only gap is that Throng's translation layer
(`throng-agent-claude/src/config/build.ts`) maps a fixed, hardcoded list of
`agent.*` keys onto the wrapper's `claude` config, and neither `thinking` nor
`effort` is in that list. This change wires both through.

## Background

- The initialise endpoint is `POST /api/initialise`
  (`packages/core/src/control/server.ts`), handled by `TaskRun.initialise()`
  (`packages/core/src/task-run.ts`).
- Core validation delegates the engine-specific `agent` block to the adapter's
  `validateAgent()` after reading only the reserved `agent.platform` key
  (`packages/core/src/manifest/validate.ts`).
- For `platform: "claude"`, the resolved payload type is `ResolvedClaudeAgent`
  (`throng-agent-claude/src/manifest/claude-agent.ts`), whose `keys:
  Record<string, unknown>` holds the raw, loosely-typed `agent` object.
  `validateClaudeAgent` validates only a subset of fields and passes the rest
  through in `keys`.
- `buildAgentConfig` (`throng-agent-claude/src/config/build.ts`) maps a fixed
  set of `keys` onto the wrapper's `claude` config, then calls
  `resolveConfig(undefined, overrides)`.
- In the wrapper, `thinking` and `effort` live **inside** `claude.model` (the
  `ClaudeModelConfig` object: `{ name, fallback, thinking, effort }`), and reach
  the SDK via `buildQueryOptions` in
  `a2a-claude/src/claude/client-factory.ts`.

## New agent fields

Both optional; snake_case to match the manifest's existing convention
(`permission_mode`, `max_turns`, `system_prompt_append`). Omitting them leaves
the wrapper/SDK defaults untouched.

```jsonc
"agent": {
  "platform": "claude",
  "model": "claude-opus-4-8",
  "thinking": { "type": "adaptive" },   // or {"type":"disabled"}
                                         // or {"type":"enabled","budget_tokens":10000}
  "effort": "high"                       // "low" | "medium" | "high" | "xhigh" | "max"
}
```

The wrapper's target shape (`a2a-claude` `ClaudeModelConfig`):

```ts
thinking?: { type: "adaptive" } | { type: "disabled" } | { type: "enabled"; budgetTokens: number };
effort?: "low" | "medium" | "high" | "xhigh" | "max";
```

Note the snake→camel difference on the enabled form: manifest `budget_tokens`
maps to wrapper `budgetTokens`.

## Changes

All in `throng-agent-claude`.

### 1. Validation — `src/manifest/claude-agent.ts` (`validateClaudeAgent`)

Add, in the existing lightweight style (accumulate `FieldError`s, keep the raw
value in `keys`):

- **`effort`**: if present, must be one of
  `low` / `medium` / `high` / `xhigh` / `max`; otherwise push
  `{ field: "agent.effort", reason: "must be one of low/medium/high/xhigh/max" }`.
- **`thinking`**: if present, must be an object whose `type` is one of
  `adaptive` / `disabled` / `enabled`. When `type === "enabled"`,
  `budget_tokens` must be a number ≥ 1024 (matching the wrapper's JSON-schema
  minimum). Errors use fields `agent.thinking` / `agent.thinking.type` /
  `agent.thinking.budget_tokens` as appropriate.

Introduce module-level constants alongside the existing `PERMISSION_MODES`:
`EFFORT_LEVELS` and `THINKING_TYPES` sets.

### 2. Mapping — `src/config/build.ts` (`buildAgentConfig`)

- Build the `claude.model` group by accumulating `name` (existing behaviour),
  `thinking`, and `effort`. Set `claude.model` only when at least one is present
  — this preserves today's behaviour where an absent model leaves the wrapper
  default in place, and correctly handles thinking/effort supplied without an
  explicit model.
- Convert the enabled form's `budget_tokens` → `budgetTokens`;
  `adaptive` / `disabled` pass straight through (they carry only `type`).
- Type the model object as `NonNullable<ClaudeConfig["model"]>`. Add `ClaudeConfig`
  to the existing import from `@col/a2a-claude` (`ClaudeModelConfig` is not
  exported by the wrapper).

Sketch:

```ts
const model: NonNullable<ClaudeConfig["model"]> = {};
if (typeof a.model === "string") model.name = a.model;
if (isObject(a.thinking)) {
  const t = a.thinking as Record<string, unknown>;
  model.thinking =
    t.type === "enabled"
      ? { type: "enabled", budgetTokens: t.budget_tokens as number }
      : { type: t.type as "adaptive" | "disabled" };
}
if (typeof a.effort === "string") model.effort = a.effort as NonNullable<ClaudeConfig["model"]>["effort"];
if (Object.keys(model).length > 0) claude.model = model;
```

(`isObject` helper mirrors the one in `claude-agent.ts`.)

### 3. Tests

Extend the existing colocated tests.

- **`src/config/build.test.ts`**: `thinking` for each type; the
  `budget_tokens → budgetTokens` conversion on the enabled form; `effort`
  mapping; `thinking`/`effort` supplied with no `model` (model object still
  created); neither present (no `claude.model` unless a model name is set).
- **`src/manifest/claude-agent.test.ts`**: valid `effort` and valid `thinking`
  (each type) accepted; invalid `effort`; invalid `thinking.type`; `enabled`
  with missing `budget_tokens`; `enabled` with `budget_tokens` < 1024;
  `thinking` not an object.

### 4. Docs — `README.md`

Add `thinking` and `effort` to the documented agent keys, with the accepted
shapes and a one-line note that the `enabled`/`budget_tokens` form is the legacy
extended-thinking shape (rejected by current models, which use `adaptive` +
`effort`).

## Data flow

`agent.thinking` / `agent.effort`
→ `validateClaudeAgent` (validate shape, retain in `keys`)
→ `buildAgentConfig` (map into `claude.model.thinking` / `.effort`, snake→camel
  for the budget)
→ `resolveConfig`
→ wrapper `buildQueryOptions`
→ SDK `query()`.

## Non-goals

- No changes to `@col/a2a-claude`.
- **Shape validation only, not model compatibility.** Throng does not reject the
  `enabled` form on models that no longer accept it (Opus 4.7/4.8, Sonnet 5,
  Fable 5). Throng does not own the model-capability matrix; the SDK returns the
  400 at runtime. This matches the existing permissive treatment of the
  loosely-typed agent object.
- Not exposing the other currently-unwired `ClaudeConfig` fields (`fallback`,
  `agents`, `skills`, `sandbox`, `mcp`, `outputFormat`, `maxBudgetUsd`,
  `additionalDirectories`, `contextFile`, `contextPrompt`) — separate scope.
