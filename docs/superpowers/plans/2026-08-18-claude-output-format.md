# Claude `output_format` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose a new optional `agent.output_format` manifest key that constrains a Claude agent's turn output to a JSON Schema, by mapping it onto `a2a-claude`'s `claude.outputFormat`.

**Architecture:** Follows the path every other Claude option takes — validate the shape at the manifest boundary (`validateClaudeAgent`), map snake_case to camelCase in `buildAgentConfig`, and let the wrapper do the rest. The `schema` body is passed through verbatim; nothing in Throng inspects or rewrites it.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), vitest, turbo, changesets. Package: `throng-agent-claude`.

**Spec:** `docs/superpowers/specs/2026-08-18-claude-output-format-design.md`

---

## Conventions you need to know

- **Working directory** for all commands is the repo root: `/Users/col/projects/throng_platform/throng_agent`, unless a step says otherwise.
- **Imports use `.js` specifiers** even for TypeScript sources (`./claude-agent.js`). This is an ESM package; a bare `./claude-agent` will not resolve.
- **`npm install` / `npm ci` need a token** because `@col/a2a-claude` is a private GitHub Packages dependency. Always prefix with `GITHUB_TOKEN="$(gh auth token)"`. Plain `build` / `typecheck` / `test` do **not** need one.
- **Turbo caches** build/typecheck/test results. A `cached` result is a real pass. Add `--force` if you need a genuine re-run.
- **Tests are colocated** with sources (`src/config/build.test.ts` sits next to `src/config/build.ts`).
- The package under test is `throng-agent-claude`. To run one test file:
  `cd throng-agent-claude && npx vitest --run src/manifest/claude-agent.test.ts`

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `throng-agent-claude/package.json` | Dependency pins | Modify — bump `@col/a2a-claude` |
| `throng-agent-claude/src/manifest/claude-agent.ts` | Validate the manifest `agent` block, return `FieldError`s | Modify — add `output_format` validation |
| `throng-agent-claude/src/manifest/claude-agent.test.ts` | Tests for the above | Modify — add validation cases |
| `throng-agent-claude/src/config/build.ts` | Map validated `keys` onto the wrapper's `claude` config | Modify — map `output_format` → `outputFormat` |
| `throng-agent-claude/src/config/build.test.ts` | Tests for the above | Modify — add mapping cases |
| `README.md` | Manifest documentation | Modify — document the new key |
| `.changeset/*.md` | Release notes | Create — two changesets |

No new files. No changes to `packages/core`, `throng-agent`, or `throng-agent-codex`.

---

### Task 1: Bump `@col/a2a-claude` to `0.2.1-beta.6`

The new `outputFormat` field does not exist on `ClaudeConfig` in `0.2.1-beta.5`, so this must land before any code references it.

**Files:**
- Modify: `throng-agent-claude/package.json`
- Modify: `package-lock.json` (generated — do not hand-edit)

- [ ] **Step 1: Edit the dependency pin**

In `throng-agent-claude/package.json`, in the `dependencies` block, change:

```json
"@col/a2a-claude": "0.2.1-beta.5",
```

to:

```json
"@col/a2a-claude": "0.2.1-beta.6",
```

- [ ] **Step 2: Install so the lockfile updates**

Run:

```bash
GITHUB_TOKEN="$(gh auth token)" npm install
```

Expected: completes without a 401. If `gh auth token` prints nothing, stop and report — the `@col` scope will 401 and nothing further will work.

- [ ] **Step 3: Verify the new type is actually present**

Run:

```bash
grep -n "outputFormat" node_modules/@col/a2a-claude/dist/config/types.d.ts
```

Expected: a line containing `outputFormat?: ClaudeOutputFormat;`. If this prints nothing, the wrong version installed — stop and report.

- [ ] **Step 4: Confirm the workspace still builds**

Run:

```bash
npm run build && npm run typecheck
```

Expected: both report all tasks successful.

- [ ] **Step 5: Commit**

```bash
git add throng-agent-claude/package.json package-lock.json
git commit -m "chore(claude): move to @col/a2a-claude@0.2.1-beta.6"
```

---

### Task 2: Validate `agent.output_format`

**Files:**
- Modify: `throng-agent-claude/src/manifest/claude-agent.ts`
- Test: `throng-agent-claude/src/manifest/claude-agent.test.ts`

- [ ] **Step 1: Write the failing tests**

Append these cases inside the existing `describe("validateClaudeAgent", ...)` block in `src/manifest/claude-agent.test.ts`, before its closing `});`:

```ts
  it("accepts a valid output_format and keeps it on keys", () => {
    const outputFormat = {
      type: "json_schema",
      schema: { type: "object", properties: { status: { type: "string" } } },
    };
    const r = validateClaudeAgent({ agent: { output_format: outputFormat } }, {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent.keys.output_format).toEqual(outputFormat);
  });

  it("accepts an agent with no output_format", () => {
    const r = validateClaudeAgent({ agent: {} }, {});
    expect(r.ok).toBe(true);
    if (r.ok) expect("output_format" in r.agent.keys).toBe(false);
  });

  // A JSON Schema body is passed through verbatim — its keys are JSON Schema's
  // own vocabulary, so nothing here may rename them the way thinking's
  // budget_tokens -> budgetTokens is renamed.
  it("preserves a nested schema body exactly", () => {
    const schema = {
      type: "object",
      properties: {
        status: { type: "string", enum: ["completed", "blocked"] },
        documents_created: { type: "array", items: { type: "string" } },
      },
      required: ["status"],
      additionalProperties: false,
    };
    const r = validateClaudeAgent({ agent: { output_format: { type: "json_schema", schema } } }, {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.agent.keys.output_format as Record<string, unknown>).schema).toEqual(schema);
    }
  });

  it.each([["a string", "nope"], ["an array", []], ["null", null]])(
    "rejects an output_format that is %s",
    (_label, value) => {
      const r = validateClaudeAgent({ agent: { output_format: value } }, {});
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.some((e) => e.field === "agent.output_format")).toBe(true);
    },
  );

  it("rejects an output_format type the SDK does not support", () => {
    const r = validateClaudeAgent(
      { agent: { output_format: { type: "text", schema: {} } } },
      {},
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "agent.output_format")).toBe(true);
  });

  it.each([["missing", undefined], ["a string", "{}"], ["an array", []]])(
    "rejects an output_format whose schema is %s",
    (_label, schema) => {
      const r = validateClaudeAgent(
        { agent: { output_format: { type: "json_schema", schema } } },
        {},
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.errors.some((e) => e.field === "agent.output_format.schema")).toBe(true);
      }
    },
  );
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd throng-agent-claude && npx vitest --run src/manifest/claude-agent.test.ts
```

Expected: FAIL. The `rejects…` cases fail because no validation exists yet, so `r.ok` is `true` where `false` is expected. The three `accepts`/`preserves` cases should already pass — `keys` is a pass-through bag.

- [ ] **Step 3: Add the validation**

In `src/manifest/claude-agent.ts`, add a constant alongside the existing sets near the top of the file (after `THINKING_TYPES`):

```ts
const OUTPUT_FORMAT_TYPES = new Set(["json_schema"]);
```

Then, inside `validateClaudeAgent`, in the `else` branch that already validates `permission_mode` / `model` / `effort` / `thinking`, add this block immediately after the `thinking` block and before `const resolution = resolvePlugins(a.plugins);`:

```ts
    // Duplicates a2a-claude's own shape check on purpose. The wrapper validates
    // in initialize(), so a bad value there fails the boot after initialise has
    // already returned 200; validating here turns it into a field-level 400 at
    // the API boundary, matching every other agent key. The `schema` body is
    // deliberately not inspected — Throng does not own JSON Schema validity, and
    // the SDK reports an unusable schema at turn time.
    if ("output_format" in a) {
      const o = a.output_format;
      if (!isObject(o) || !OUTPUT_FORMAT_TYPES.has(o.type as string)) {
        errors.push({
          field: "agent.output_format",
          reason: "must be an object with type json_schema",
        });
      } else if (!isObject(o.schema)) {
        errors.push({
          field: "agent.output_format.schema",
          reason: "must be a JSON Schema object",
        });
      }
    }
```

`isObject` already exists in this file and rejects `null` and arrays, so no extra guards are needed.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd throng-agent-claude && npx vitest --run src/manifest/claude-agent.test.ts
```

Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add throng-agent-claude/src/manifest/claude-agent.ts throng-agent-claude/src/manifest/claude-agent.test.ts
git commit -m "feat(claude): validate agent.output_format on initialise"
```

---

### Task 3: Map `output_format` onto `claude.outputFormat`

**Files:**
- Modify: `throng-agent-claude/src/config/build.ts`
- Test: `throng-agent-claude/src/config/build.test.ts`

- [ ] **Step 1: Write the failing tests**

Append these cases inside the existing `describe("buildAgentConfig", ...)` block in `src/config/build.test.ts`, before its closing `});`:

```ts
  it("maps output_format onto the wrapper's outputFormat", () => {
    const outputFormat = {
      type: "json_schema",
      schema: { type: "object", properties: { status: { type: "string" } } },
    };
    const cfg = buildAgentConfig(manifest({ output_format: outputFormat }), "/work/app");
    expect(cfg.claude.outputFormat).toEqual(outputFormat);
  });

  // Only the outer key is renamed. The schema body carries JSON Schema's own
  // vocabulary (additionalProperties, required, …) and must survive untouched.
  it("passes the schema body through without rewriting its keys", () => {
    const schema = {
      type: "object",
      properties: {
        status: { type: "string", enum: ["completed", "blocked"] },
        documents_created: { type: "array", items: { type: "string" } },
      },
      required: ["status"],
      additionalProperties: false,
    };
    const cfg = buildAgentConfig(
      manifest({ output_format: { type: "json_schema", schema } }),
      "/work/app",
    );
    expect(cfg.claude.outputFormat?.schema).toEqual(schema);
  });

  // Absent means "wrapper default" — freeform text — not an empty format object.
  it("leaves outputFormat unset when the manifest omits it", () => {
    const cfg = buildAgentConfig(manifest({}), "/work/app");
    expect(cfg.claude.outputFormat).toBeUndefined();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd throng-agent-claude && npx vitest --run src/config/build.test.ts
```

Expected: FAIL on the first two cases with `expected undefined to deeply equal { type: 'json_schema', … }`. The third case passes already.

- [ ] **Step 3: Add the mapping**

In `src/config/build.ts`, add this immediately after the `if (typeof a.max_turns === "number") claude.maxTurns = a.max_turns;` line:

```ts
  // Structured output. Only the outer key is renamed — the schema body is JSON
  // Schema's own vocabulary and is forwarded verbatim. Left unset when absent so
  // the wrapper's freeform-text default holds.
  if (a.output_format && typeof a.output_format === "object") {
    claude.outputFormat = a.output_format as NonNullable<ClaudeConfig["outputFormat"]>;
  }
```

`ClaudeConfig` is already imported at the top of this file, so no import change is needed. Do **not** try to import `ClaudeOutputFormat` — the wrapper does not export it from its package root and the build will fail.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd throng-agent-claude && npx vitest --run src/config/build.test.ts
```

Expected: PASS, all cases.

- [ ] **Step 5: Run the full suite and typecheck**

```bash
cd /Users/col/projects/throng_platform/throng_agent && npm run typecheck && npm test
```

Expected: all tasks successful, no failures anywhere in the workspace.

- [ ] **Step 6: Commit**

```bash
git add throng-agent-claude/src/config/build.ts throng-agent-claude/src/config/build.test.ts
git commit -m "feat(claude): map agent.output_format to claude.outputFormat"
```

---

### Task 4: Document the key in the README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add the key to the manifest example**

In the JSONC manifest example near the top of `README.md`, inside the `"agent"` block, add a line after `"effort": "high",          // engine-specific (claude)`:

```jsonc
    "output_format": {         // engine-specific (claude) — structured output
      "type": "json_schema",
      "schema": { "type": "object" }
    },
```

- [ ] **Step 2: Add the explanatory section**

Insert this new section immediately after the existing `### thinking and effort (claude)` section and immediately before `### credentials, github_token and user_identity`:

````markdown
### `output_format` (claude)

Optional. Constrains the model's turn output to a JSON Schema. Omit it and the
agent returns freeform text, which is the default.

```jsonc
"output_format": {
  "type": "json_schema",   // the only type the SDK supports
  "schema": { /* any JSON Schema object */ }
}
```

Throng validates the wrapper shape only — that `type` is `json_schema` and that
`schema` is an object. The schema body is forwarded to the SDK **verbatim**; it
is never inspected or key-transformed, so JSON Schema's own vocabulary
(`additionalProperties`, `patternProperties`, …) survives intact. A schema that
is not valid JSON Schema is reported by the SDK at turn time, not at initialise.

Two consequences worth knowing before you enable it:

- **The text part becomes JSON.** On success the parsed object is published as an
  additive `application/json` data part on the `response` artifact, but the text
  part is still published and now carries the JSON payload rather than prose. A
  consumer reading only the text part gets JSON, not a natural-language summary.
- **An unsatisfiable schema fails the turn.** The SDK retries when output does
  not match, and on exhaustion the turn fails with *"Structured output retries
  exhausted."* It does not fall back to freeform text. A schema that no output
  can satisfy — for example one whose `required` names a property that
  `properties` never declares while `additionalProperties` is `false` — fails
  every turn. Diagnose this as a schema bug, not a model problem.
````

- [ ] **Step 3: Verify the rendering**

Run:

```bash
grep -n "output_format" README.md
```

Expected: matches in both the manifest example and the new section heading.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document agent.output_format"
```

---

### Task 5: Add the changesets

Two separate changesets — the dependency move and the feature are independently meaningful in a changelog.

**Files:**
- Create: `.changeset/a2a-claude-beta-6.md`
- Create: `.changeset/claude-output-format.md`

- [ ] **Step 1: Write the dependency changeset**

Create `.changeset/a2a-claude-beta-6.md`:

```markdown
---
"throng-agent-claude": minor
---

Move `@col/a2a-claude` to `0.2.1-beta.6`, which adds `claude.outputFormat` — structured JSON output constrained to a caller-supplied JSON Schema. No behaviour changes for agents that do not set it; the field is absent from Throng's generated config unless a manifest asks for it.
```

- [ ] **Step 2: Write the feature changeset**

Create `.changeset/claude-output-format.md`:

````markdown
---
"throng-agent-claude": minor
---

Add `agent.output_format`, a new optional initialise key that constrains a Claude turn's output to a JSON Schema.

```jsonc
"agent": {
  "platform": "claude",
  "output_format": { "type": "json_schema", "schema": { /* … */ } }
}
```

Throng validates the wrapper shape only — `type` must be `json_schema` and `schema` must be an object — and returns a field-level 400 from `POST /api/initialise` when either is wrong. The schema body itself is forwarded verbatim: it is never inspected or key-transformed, so JSON Schema's own vocabulary survives intact, and an invalid schema surfaces from the SDK at turn time rather than at initialise. Omitting the key leaves the wrapper's freeform-text default in place, so no existing manifest changes behaviour.

Two operational notes for anyone enabling it. The structured result arrives as an additive `application/json` data part on the `response` artifact, but the text part is still published and now carries the JSON payload instead of prose — a consumer reading only the text part will see JSON. And an unsatisfiable schema fails the turn with "Structured output retries exhausted." rather than degrading to freeform output, so a schema bug looks like a model failure unless you know to check.
````

- [ ] **Step 3: Verify changesets parse**

```bash
npx changeset status
```

Expected: reports `throng-agent-claude` with a pending bump. A parse error here means the frontmatter is malformed.

- [ ] **Step 4: Commit**

```bash
git add .changeset/a2a-claude-beta-6.md .changeset/claude-output-format.md
git commit -m "chore: changesets for output_format"
```

---

### Task 6: Final verification and PR

**Files:** none modified.

- [ ] **Step 1: Run the full check suite from a clean cache**

```bash
cd /Users/col/projects/throng_platform/throng_agent && npm run build && npm run typecheck && npm test -- --force
```

Expected: all three succeed. `--force` bypasses the turbo cache so every test genuinely re-runs. Record the actual test counts from the output — do not claim a pass without reading it.

- [ ] **Step 2: Review the full diff**

```bash
git diff main...HEAD
```

Expected: changes confined to `throng-agent-claude/`, `README.md`, `.changeset/`, `package-lock.json`, and the spec/plan docs. Anything outside that list is unintended — stop and report.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feat/claude-output-format
```

Then open a PR against `main` titled `feat(claude): expose agent.output_format for structured output`, with a body covering: what the key does, the validation contract, the verbatim schema pass-through, the two operational consequences (text part becomes JSON; unsatisfiable schema fails the turn), and a link to the spec.

---

## Definition of done

- `npm run build`, `npm run typecheck`, `npm test -- --force` all pass from the repo root.
- `agent.output_format` is validated at initialise and mapped to `claude.outputFormat`.
- A manifest without `output_format` produces a config with `outputFormat` undefined.
- A nested schema body round-trips deep-equal through both validation and mapping.
- README documents the key, its validation contract, and both operational consequences.
- Two changesets present; `npx changeset status` parses cleanly.
- PR open against `main`.

## Out of scope

Do not implement any of these, even if they seem natural:

- A default or built-in schema. Throng ships none — the manifest producer decides.
- Validating the `schema` body as JSON Schema.
- Any change to `@col/a2a-claude`, `packages/core`, `throng-agent`, or `throng-agent-codex`.
- Wiring any other unexposed `ClaudeConfig` field.
- The throng-agent pre-release or the `throng_e2b_templates` repin — those follow PR approval, via the `release` skill.
