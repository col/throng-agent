# Expose Claude `output_format` (structured output) via the initialise API

**Date:** 2026-08-18
**Status:** Approved
**Scope:** `throng-agent-claude` package only. No changes to `@col/a2a-claude`.

## Goal

Let callers of `POST /api/initialise` constrain a Claude agent's turn output to a
JSON Schema, through a new optional `agent.output_format` key. The `a2a-claude`
wrapper gained the underlying support in
[a2a-wrapper#33](https://github.com/shashikanth-gs/a2a-wrapper/pull/33), shipped
in `0.2.1-beta.6`. The only gap is Throng's translation layer
(`throng-agent-claude/src/config/build.ts`), which maps a fixed list of `agent.*`
keys onto the wrapper's `claude` config and does not include the new field.

This is the follow-up to the final non-goal of
`2026-08-03-expose-claude-thinking-effort-design.md`, which listed `outputFormat`
among the unwired `ClaudeConfig` fields deferred to a separate scope.

## Background

- Core validation delegates the engine-specific `agent` block to the adapter's
  `validateAgent()` (`packages/core/src/manifest/validate.ts`). For
  `platform: "claude"` that is `validateClaudeAgent`
  (`throng-agent-claude/src/manifest/claude-agent.ts`), which validates a subset
  of fields and passes the rest through in `keys: Record<string, unknown>`.
- Validation failures return HTTP 400 with `[{ field, reason }]` from the
  initialise route (`packages/core/src/control/server.ts`), synchronously, before
  any boot work happens. A manifest that validates returns 202 and boots
  asynchronously, so a failure raised during boot is not visible on the
  initialise response.
- `buildAgentConfig` (`throng-agent-claude/src/config/build.ts`) maps `keys` onto
  the wrapper's `claude` config, then calls `resolveConfig(undefined, overrides)`.
- In `0.2.1-beta.6` the wrapper exposes `outputFormat` as a top-level
  `ClaudeConfig` field, a sibling of `model` / `thinking` / `effort`, and
  forwards it to the SDK in `buildQueryOptions` (`claude/client-factory.ts`).

### Wrapper behaviour when `outputFormat` is set

- The SDK constrains the model's output to `schema`. On a successful turn the
  wrapper publishes the parsed object as an **additive** `application/json` data
  part on the `response` artifact, alongside the usual text part
  (`publishFinalArtifactWithData` / `publishLastChunkMarkerWithData` in
  `claude/executor.js`).
- The text part is still published, first, so text-only clients are unaffected.
  It carries the SDK's `result` string. What that string contains under a
  structured format is **not** established here: `result` and `structured_output`
  are independent fields on `SDKResultSuccess`, and nothing in the SDK or wrapper
  documents `result` being replaced by the JSON payload. Do not assert either way
  in operator-facing docs without observing a real turn.
- The data part is conditional. `responseParts` in the wrapper's
  `claude/structured-artifact.js` appends it only when the structured value is a
  non-null, **non-array** object. A schema whose top level is an array or scalar
  produces no data part at all.
- A new turn failure mode appears: the SDK retries when output does not satisfy
  the schema, and on exhaustion emits `error_max_structured_output_retries`,
  which the wrapper maps to a failed turn with
  *"Structured output retries exhausted."*

## New agent field

Optional; snake_case to match the manifest's existing convention
(`permission_mode`, `max_turns`, `system_prompt_append`). Omitting it leaves the
wrapper/SDK default — freeform text — untouched.

```jsonc
"agent": {
  "platform": "claude",
  "output_format": {
    "type": "json_schema",       // the only value the SDK supports
    "schema": {                  // any JSON Schema object
      "type": "object",
      "properties": { "status": { "type": "string" } },
      "required": ["status"],
      "additionalProperties": false
    }
  }
}
```

The wrapper's target shape (`a2a-claude` `ClaudeOutputFormat`):

```ts
export type ClaudeOutputFormat = {
  type: "json_schema";
  schema: Record<string, unknown>;
};
```

Only the outer key is renamed (`output_format` → `outputFormat`). Unlike
`thinking.budget_tokens` → `budgetTokens`, **the `schema` body is passed through
verbatim** — its keys (`additionalProperties`, `patternProperties`, …) are JSON
Schema's own vocabulary, and rewriting them would corrupt the schema.

## Changes

All in `throng-agent-claude`.

### 1. Dependency — `package.json`

Bump `@col/a2a-claude` from `0.2.1-beta.5` to `0.2.1-beta.6`.

### 2. Validation — `src/manifest/claude-agent.ts` (`validateClaudeAgent`)

Add, in the existing style (accumulate `FieldError`s, keep the raw value in
`keys`), mirroring the two-level `thinking` validator:

- **not an object**, or `type !== "json_schema"` →
  `{ field: "agent.output_format", reason: "must be an object with type json_schema" }`
- **`schema` missing, not an object, or an array** →
  `{ field: "agent.output_format.schema", reason: "must be a JSON Schema object" }`

Introduce a module-level `OUTPUT_FORMAT_TYPES` set alongside the existing
`PERMISSION_MODES` / `EFFORT_LEVELS` / `THINKING_TYPES`.

This duplicates the wrapper's own `validateConfig()` shape check, which is a
deliberate trade-off. The wrapper's check runs inside `initialize()` during
`createA2AServer`, so a malformed value surfaces as a *boot failure* after
initialise has already returned 200. Validating here instead returns a
field-level 400 at the API boundary, before a sandbox boots — consistent with
how `permission_mode`, `model`, `effort` and `thinking` are already handled. The
accepted cost is that a future wrapper release adding a second output-format
type would be blocked by this whitelist until it is updated here too.

### 3. Mapping — `src/config/build.ts` (`buildAgentConfig`)

Attach the field only when the manifest set it, matching the surrounding
per-field style, so an absent value falls through to the wrapper default:

```ts
if (a.output_format && typeof a.output_format === "object") {
  claude.outputFormat = a.output_format as NonNullable<ClaudeConfig["outputFormat"]>;
}
```

The type is derived from `ClaudeConfig`, which is already imported here.
`ClaudeOutputFormat` itself is **not** exported from the wrapper's package root
(`index.d.ts` re-exports only `AgentConfig`, `ClaudeConfig`,
`ClaudePermissionMode`, `FeatureFlags` and the MCP config types), so importing it
by name would not compile — the same constraint the `thinking`/`effort` work hit
with `ClaudeModelConfig`.

### 4. Tests

Extend the existing colocated tests.

- **`src/manifest/claude-agent.test.ts`**: a valid `output_format` is accepted
  and retained on `keys`; absent is accepted; `"nope"` / `[]` / `null` rejected
  on `agent.output_format`; `{ "type": "text" }` rejected on
  `agent.output_format`; `type: "json_schema"` with `schema` missing / a string /
  an array rejected on `agent.output_format.schema`; a nested schema
  (`properties`, `required`, `additionalProperties: false`) survives deep-equal.
- **`src/config/build.test.ts`**: `output_format` present →
  `config.claude.outputFormat` deep-equals it, including nested schema keys
  (guards the no-key-transform rule); absent → `outputFormat` is `undefined`.

### 5. Docs — `README.md`

- Add `output_format` to the manifest example block (~line 50) as an
  engine-specific (claude) key.
- Add an `### output_format (claude)` section after `### thinking and effort
  (claude)` covering: the accepted shape; that `schema` is passed through
  verbatim and is not validated as JSON Schema by Throng; that the structured
  result arrives as an additive JSON data part alongside the text part, and that
  the text part becomes the JSON payload rather than prose; and that an
  unsatisfiable schema fails the turn with *"Structured output retries
  exhausted."* rather than degrading to freeform output.

### 6. Changesets

Two changesets in the PR: the `0.2.1-beta.6` dependency bump, and the
`output_format` feature.

## Data flow

`agent.output_format`
→ `validateClaudeAgent` (validate shape, retain in `keys`)
→ `buildAgentConfig` (map to `claude.outputFormat`, schema body untouched)
→ `resolveConfig`
→ wrapper `validateConfig` (re-checks shape at boot)
→ wrapper `buildQueryOptions`
→ SDK `query()` `Options.outputFormat`
→ `result.structured_output` → additive `application/json` part on the `response`
  artifact.

## Non-goals

- **No default schema.** Throng ships no built-in `output_format`. Agents get
  freeform text unless a manifest asks otherwise; deciding the schema is the
  manifest producer's job, not this repo's.
- **Shape validation only, not schema validation.** Throng checks that `schema`
  is an object and passes it through. It does not verify the schema is valid
  JSON Schema, nor that a model can satisfy it — the SDK surfaces those at turn
  time. This matches the existing permissive treatment of the loosely-typed
  agent object.
- No changes to `@col/a2a-claude`.
- No changes to `throng-agent-codex` — `output_format` is claude-specific.
- Not exposing the other still-unwired `ClaudeConfig` fields (`fallbackModel`,
  `agents`, `skills`, `sandbox`, `mcp`, `maxBudgetUsd`, `additionalDirectories`,
  `contextFile`, `contextPrompt`) — separate scope.
