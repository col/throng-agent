# Expose Claude `thinking` + `effort` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the Claude `thinking` and `effort` reasoning controls from the Throng initialise API's embedded `agent` object through to the `a2a-claude` wrapper config.

**Architecture:** Two touch points in the `throng-agent-claude` package: shape-validate the two new fields in `validateClaudeAgent`, and map them into the wrapper's `claude.model` group in `buildAgentConfig`. The wrapper already forwards `model.thinking`/`model.effort` to the Claude Agent SDK — no wrapper changes. Validation is shape-only; the SDK enforces model/thinking compatibility at runtime.

**Tech Stack:** TypeScript (ESM), Vitest, npm workspaces + Turborepo. Package: `throng-agent-claude`. Wrapper dependency: `@col/a2a-claude`.

**Spec:** `docs/superpowers/specs/2026-08-03-expose-claude-thinking-effort-design.md`

---

## File Structure

- Modify: `throng-agent-claude/src/manifest/claude-agent.ts` — add `effort` + `thinking` shape validation to `validateClaudeAgent`.
- Modify: `throng-agent-claude/src/manifest/claude-agent.test.ts` — validation tests.
- Modify: `throng-agent-claude/src/config/build.ts` — map `effort` + `thinking` into `claude.model`.
- Modify: `throng-agent-claude/src/config/build.test.ts` — mapping tests.
- Modify: `README.md` — document the two new agent keys.

Run all commands from the repo root: `/Users/col/projects/throng_platform/throng_agent`. Test runner is Vitest; the package script is `npm test -w throng-agent-claude`.

---

### Task 1: Validate `effort` and `thinking` shape

**Files:**
- Modify: `throng-agent-claude/src/manifest/claude-agent.ts`
- Test: `throng-agent-claude/src/manifest/claude-agent.test.ts`

- [ ] **Step 1: Write the failing tests**

Append these `it(...)` blocks inside the existing `describe("validateClaudeAgent", ...)` block in `throng-agent-claude/src/manifest/claude-agent.test.ts` (before the closing `});`):

```ts
  it("accepts a valid effort level", () => {
    const r = validateClaudeAgent({ agent: { effort: "high" } }, {});
    expect(r.ok).toBe(true);
  });

  it("rejects an unknown effort level", () => {
    const r = validateClaudeAgent({ agent: { effort: "turbo" } }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "agent.effort")).toBe(true);
  });

  it("accepts adaptive and disabled thinking", () => {
    for (const type of ["adaptive", "disabled"]) {
      const r = validateClaudeAgent({ agent: { thinking: { type } } }, {});
      expect(r.ok).toBe(true);
    }
  });

  it("accepts enabled thinking with a budget", () => {
    const r = validateClaudeAgent({ agent: { thinking: { type: "enabled", budget_tokens: 2048 } } }, {});
    expect(r.ok).toBe(true);
  });

  it("rejects an unknown thinking type", () => {
    const r = validateClaudeAgent({ agent: { thinking: { type: "hard" } } }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "agent.thinking")).toBe(true);
  });

  it("rejects non-object thinking", () => {
    const r = validateClaudeAgent({ agent: { thinking: "adaptive" } }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "agent.thinking")).toBe(true);
  });

  it("rejects enabled thinking without a numeric budget", () => {
    const r = validateClaudeAgent({ agent: { thinking: { type: "enabled" } } }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "agent.thinking.budget_tokens")).toBe(true);
  });

  it("rejects enabled thinking with a budget below 1024", () => {
    const r = validateClaudeAgent({ agent: { thinking: { type: "enabled", budget_tokens: 500 } } }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "agent.thinking.budget_tokens")).toBe(true);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w throng-agent-claude -- claude-agent`
Expected: the new `effort`/`thinking` tests FAIL (the `reject...` cases return `ok: true` because nothing validates them yet).

- [ ] **Step 3: Add the validation**

In `throng-agent-claude/src/manifest/claude-agent.ts`, add two constants directly below the existing `PERMISSION_MODES` line (line 4):

```ts
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);
const THINKING_TYPES = new Set(["adaptive", "disabled", "enabled"]);
```

Then, inside the `else` branch, immediately after the `api_key` check block (the `if ("api_key" in a && ...)` block, ending at the line with `}` before `const resolution = resolvePlugins(a.plugins);`), insert:

```ts
    if ("effort" in a && !EFFORT_LEVELS.has(a.effort as string)) {
      errors.push({ field: "agent.effort", reason: "must be one of low/medium/high/xhigh/max" });
    }
    if ("thinking" in a) {
      const t = a.thinking;
      if (!isObject(t) || !THINKING_TYPES.has(t.type as string)) {
        errors.push({
          field: "agent.thinking",
          reason: "must be an object with type adaptive/disabled/enabled",
        });
      } else if (t.type === "enabled" && (typeof t.budget_tokens !== "number" || t.budget_tokens < 1024)) {
        errors.push({
          field: "agent.thinking.budget_tokens",
          reason: "must be a number >= 1024 when type is enabled",
        });
      }
    }
```

(`isObject` is already defined at the top of this file — no new import needed.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w throng-agent-claude -- claude-agent`
Expected: PASS (all validation tests, old and new).

- [ ] **Step 5: Commit**

```bash
git add throng-agent-claude/src/manifest/claude-agent.ts throng-agent-claude/src/manifest/claude-agent.test.ts
git commit -m "feat(claude): validate agent.thinking and agent.effort shape"
```

---

### Task 2: Map `thinking` + `effort` into `claude.model`

**Files:**
- Modify: `throng-agent-claude/src/config/build.ts`
- Test: `throng-agent-claude/src/config/build.test.ts`

- [ ] **Step 1: Write the failing tests**

Append these `it(...)` blocks inside the existing `describe("buildAgentConfig", ...)` block in `throng-agent-claude/src/config/build.test.ts` (before the closing `});`):

```ts
  it("maps effort onto claude.model.effort", () => {
    const cfg = buildAgentConfig(manifest({ model: "claude-opus-4-8", effort: "xhigh" }), "/work/app");
    expect(cfg.claude.model.effort).toBe("xhigh");
  });

  it("maps adaptive thinking onto claude.model.thinking", () => {
    const cfg = buildAgentConfig(
      manifest({ model: "claude-opus-4-8", thinking: { type: "adaptive" } }),
      "/work/app",
    );
    expect(cfg.claude.model.thinking).toEqual({ type: "adaptive" });
  });

  it("renames budget_tokens to budgetTokens for enabled thinking", () => {
    const cfg = buildAgentConfig(
      manifest({ thinking: { type: "enabled", budget_tokens: 8000 } }),
      "/work/app",
    );
    expect(cfg.claude.model.thinking).toEqual({ type: "enabled", budgetTokens: 8000 });
  });

  it("creates the model group from thinking/effort even without a model name", () => {
    const cfg = buildAgentConfig(
      manifest({ thinking: { type: "disabled" }, effort: "low" }),
      "/work/app",
    );
    expect(cfg.claude.model.name).toBeUndefined();
    expect(cfg.claude.model.thinking).toEqual({ type: "disabled" });
    expect(cfg.claude.model.effort).toBe("low");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w throng-agent-claude -- build`
Expected: the four new tests FAIL (`cfg.claude.model.effort`/`.thinking` are undefined; the enabled test sees `budget_tokens`, not `budgetTokens`, since nothing maps them yet).

- [ ] **Step 3: Add the mapping**

In `throng-agent-claude/src/config/build.ts`, add `ClaudeConfig` to the existing wrapper import on line 1:

```ts
import { resolveConfig, type AgentConfig, type ClaudeConfig, type ClaudePermissionMode } from "@col/a2a-claude";
```

Then replace the single line 35:

```ts
  if (typeof a.model === "string") claude.model = { name: a.model };
```

with:

```ts
  // Model group: the model name plus the reasoning controls (thinking/effort)
  // that a2a-claude nests inside ClaudeModelConfig. Accumulate, then attach only
  // if something was set — an absent model still falls through to the wrapper
  // default, and thinking/effort work even without an explicit model name.
  const model: NonNullable<ClaudeConfig["model"]> = {};
  if (typeof a.model === "string") model.name = a.model;
  if (a.thinking && typeof a.thinking === "object") {
    const t = a.thinking as Record<string, unknown>;
    // The `enabled` form renames snake_case budget_tokens -> the SDK's
    // budgetTokens; adaptive/disabled carry only `type`.
    model.thinking =
      t.type === "enabled"
        ? { type: "enabled", budgetTokens: t.budget_tokens as number }
        : { type: t.type as "adaptive" | "disabled" };
  }
  if (typeof a.effort === "string") {
    model.effort = a.effort as NonNullable<ClaudeConfig["model"]>["effort"];
  }
  if (Object.keys(model).length > 0) claude.model = model;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w throng-agent-claude -- build`
Expected: PASS (all build tests, old and new).

- [ ] **Step 5: Commit**

```bash
git add throng-agent-claude/src/config/build.ts throng-agent-claude/src/config/build.test.ts
git commit -m "feat(claude): map agent.thinking and agent.effort into claude.model"
```

---

### Task 3: Document the new agent keys

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Find the agent-keys documentation**

Run: `grep -n "permission_mode\|max_turns\|system_prompt_append\|### .*agent\|agent keys\|agent object" README.md`
Expected: line numbers for the section that enumerates the `agent` block's keys.

- [ ] **Step 2: Add `thinking` and `effort`**

In the section that documents the `agent` keys (near `permission_mode` / `max_turns`), add entries for the two new keys. Match the surrounding format (list or table). The content to convey:

- `thinking` (optional, object) — extended-thinking control passed to the Claude model. One of `{ "type": "adaptive" }`, `{ "type": "disabled" }`, or `{ "type": "enabled", "budget_tokens": <integer >= 1024> }`. The `enabled`/`budget_tokens` form is the legacy extended-thinking shape and is rejected by current models (Opus 4.7/4.8, Sonnet 5, Fable 5), which use `adaptive` together with `effort`.
- `effort` (optional, string) — reasoning effort level: one of `low`, `medium`, `high`, `xhigh`, `max`.

If the doc shows an example `agent` block, add `"thinking": { "type": "adaptive" }` and `"effort": "high"` to it.

- [ ] **Step 3: Verify wording renders**

Run: `grep -n "thinking\|effort" README.md`
Expected: the new entries appear in the agent-keys section.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document agent.thinking and agent.effort keys"
```

---

### Task 4: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the package test suite**

Run: `npm test -w throng-agent-claude`
Expected: PASS — all suites green.

- [ ] **Step 2: Typecheck / build the package**

Run: `npm run build -w throng-agent-claude`
Expected: builds with no TypeScript errors. (If the repo uses a different check command, e.g. `npm run typecheck -w throng-agent-claude` or a root `turbo` task, run that instead — discover with `grep -n '"scripts"' -A20 throng-agent-claude/package.json`.)

- [ ] **Step 3: Confirm end-to-end wiring by inspection**

Confirm the data path is intact: `agent.thinking`/`agent.effort` → `validateClaudeAgent` (Task 1) → `buildAgentConfig` sets `claude.model.thinking`/`.effort` (Task 2) → `resolveConfig` → the wrapper's `buildQueryOptions` reads `claude.model?.thinking`/`claude.model?.effort` (`node_modules/@col/a2a-claude/dist/claude/client-factory.js`) → SDK `query()`. No code change needed here — this step is a read-only sanity check.
