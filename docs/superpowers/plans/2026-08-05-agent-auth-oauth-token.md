# `agent.auth` + `CLAUDE_CODE_OAUTH_TOKEN` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the manifest's bare `agent.api_key` string with a tagged `agent.auth: { type, token }` block, so a Claude task can be billed against a Claude Code subscription via `CLAUDE_CODE_OAUTH_TOKEN`, and so selecting one credential type provably clears the competing ones.

**Architecture:** Core gains `resolveAuth` (validate the manifest block, else walk an ordered env-fallback list) and `applyAuth` (scrub every credential variable, then set the selected one). Each adapter declares a single ordered `AuthScheme[]` table that simultaneously defines the accepted `type` values, the env-fallback order, the injection target, and the scrub set. Claude's table lists `oauth` before `api_key`; Codex's lists `api_key` only.

**Tech Stack:** TypeScript (ESM, `NodeNext`, `strict`), Vitest, npm workspaces + Turborepo, Changesets.

**Spec:** `docs/superpowers/specs/2026-08-05-agent-auth-oauth-token-design.md`

---

## Orientation for the implementer

You are working in `/Users/col/projects/throng_platform/throng_agent` on branch
`feat/agent-auth-oauth-token`. It is an npm-workspaces monorepo:

| Path | Package |
| --- | --- |
| `packages/core` | `@throng/agent-core` — manifest validation, control API, lifecycle |
| `throng-agent-claude` | `throng-agent-claude` — Claude engine adapter |
| `throng-agent-codex` | `throng-agent-codex` — Codex engine adapter |
| `throng-agent` | `throng-agent` — the deployable app that wires adapters into a registry |

**Running tests.** Core's own tests need no build:

```bash
npm test -w @throng/agent-core -- auth        # filters by filename substring
```

The adapter packages import `@throng/agent-core` through its **built `dist/`**,
so core must be rebuilt before their tests see a new export. Turbo handles that
via `dependsOn: ["^build"]` — always use the turbo form for adapter packages:

```bash
npx turbo run test --filter=throng-agent-claude
npx turbo run test --filter=throng-agent-codex
npm test                                       # everything
npm run typecheck                              # everything
```

**Style notes from the existing code, which you should match.** Validators
accumulate `FieldError[]` and return them all at once rather than throwing on
the first problem — a caller with two bad fields gets one complete `400`.
Non-null assertions (`!`) are not used; narrow with a guard instead. Comments
explain *why*, not *what*, and are used where a decision is non-obvious.

**Definition of "credential variable" in this plan:** `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY`.

---

## File structure

**Create**

- `packages/core/src/manifest/auth.ts` — `AuthScheme`, `ResolvedAuth`,
  `AuthResolution`, `resolveAuth`, `applyAuth`. One responsibility: turning a
  manifest agent block plus an environment into exactly one credential, and
  putting that credential into the process. Replaces `api-key.ts` entirely.
- `packages/core/src/manifest/auth.test.ts` — replaces `api-key.test.ts`.

**Modify**

- `packages/core/src/index.ts` — swap the `resolveApiKey` export for the auth exports.
- `packages/core/src/engine/adapter.ts:27` — doc comment naming `anthropic_api_key`.
- `throng-agent-claude/src/config/credentials.ts` — drop `injectAnthropicKey`; add
  `CLAUDE_AUTH_SCHEMES` and `CLAUDE_AUTH_ALSO_SCRUB`; broaden the settings guard.
- `throng-agent-claude/src/manifest/claude-agent.ts` — `api_key` → `auth`.
- `throng-agent-claude/src/adapter.ts` — `injectCredentials` calls `applyAuth`.
- `throng-agent-codex/src/config/credentials.ts` — drop `injectOpenAIKey`; add
  `CODEX_AUTH_SCHEMES`.
- `throng-agent-codex/src/manifest/codex-agent.ts` — `api_key` → `auth`.
- `throng-agent-codex/src/adapter.ts` — `injectCredentials` calls `applyAuth`.
- Test fixtures carrying `api_key`: `throng-agent-claude/src/config/build.test.ts`,
  `throng-agent-claude/src/adapter.test.ts`,
  `throng-agent-claude/src/manifest/claude-agent.test.ts`,
  `throng-agent-claude/src/config/credentials.test.ts`,
  `throng-agent-codex/src/config/build.test.ts`,
  `throng-agent-codex/src/adapter.test.ts`,
  `throng-agent-codex/src/manifest/codex-agent.test.ts`,
  `throng-agent/src/integration/boot.test.ts`.
- `README.md` — manifest example, a new `auth` subsection, the standalone recipe.

**Delete**

- `packages/core/src/manifest/api-key.ts`
- `packages/core/src/manifest/api-key.test.ts`

The two old `resolveApiKey` call sites keep working until Task 6, so every
commit before it is green on its own.

---

## Task 1: Core — `resolveAuth`

**Files:**
- Create: `packages/core/src/manifest/auth.ts`
- Create: `packages/core/src/manifest/auth.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/manifest/auth.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveAuth, type AuthResolution, type AuthScheme } from "./auth.js";

const SCHEMES: AuthScheme[] = [
  { type: "oauth", env: "CLAUDE_CODE_OAUTH_TOKEN" },
  { type: "api_key", env: "ANTHROPIC_API_KEY" },
];
const API_KEY_ONLY: AuthScheme[] = [{ type: "api_key", env: "OPENAI_API_KEY" }];

/** Unwraps a successful resolution, failing the test with the errors if not. */
const auth = (r: AuthResolution) => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.errors)}`);
  return r.auth;
};
/** The field names of a failed resolution, in the order they were reported. */
const fields = (r: AuthResolution) => (r.ok ? [] : r.errors.map((e) => e.field));

describe("resolveAuth", () => {
  it("prefers the manifest auth block over every env var", () => {
    const r = resolveAuth(
      { auth: { type: "oauth", token: "oat-manifest" } },
      { CLAUDE_CODE_OAUTH_TOKEN: "oat-env", ANTHROPIC_API_KEY: "sk-env" },
      SCHEMES,
    );
    expect(auth(r)).toEqual({ type: "oauth", token: "oat-manifest" });
  });

  it("accepts each type the table lists", () => {
    expect(auth(resolveAuth({ auth: { type: "api_key", token: "sk-1" } }, {}, SCHEMES)))
      .toEqual({ type: "api_key", token: "sk-1" });
  });

  it("falls back through the env vars in table order", () => {
    const r = resolveAuth(
      {},
      { CLAUDE_CODE_OAUTH_TOKEN: "oat-env", ANTHROPIC_API_KEY: "sk-env" },
      SCHEMES,
    );
    expect(auth(r)).toEqual({ type: "oauth", token: "oat-env" });
  });

  it("falls through to a later env var when the earlier one is unset", () => {
    expect(auth(resolveAuth({}, { ANTHROPIC_API_KEY: "sk-env" }, SCHEMES)))
      .toEqual({ type: "api_key", token: "sk-env" });
  });

  it("skips blank env values", () => {
    const r = resolveAuth({}, { CLAUDE_CODE_OAUTH_TOKEN: "   ", ANTHROPIC_API_KEY: "sk-env" }, SCHEMES);
    expect(auth(r)).toEqual({ type: "api_key", token: "sk-env" });
  });

  it("returns null when nothing is set anywhere", () => {
    expect(auth(resolveAuth({}, {}, SCHEMES))).toBe(null);
  });

  it("rejects an auth block that is not an object", () => {
    expect(fields(resolveAuth({ auth: "sk-1" }, {}, SCHEMES))).toEqual(["agent.auth"]);
    expect(fields(resolveAuth({ auth: null }, {}, SCHEMES))).toEqual(["agent.auth"]);
    expect(fields(resolveAuth({ auth: [] }, {}, SCHEMES))).toEqual(["agent.auth"]);
  });

  it("rejects a type the table does not list, naming the accepted ones", () => {
    const r = resolveAuth({ auth: { type: "oauth", token: "x" } }, {}, API_KEY_ONLY);
    expect(fields(r)).toEqual(["agent.auth.type"]);
    if (!r.ok) expect(r.errors[0].reason).toBe("must be one of api_key");
  });

  it("rejects a missing type", () => {
    expect(fields(resolveAuth({ auth: { token: "x" } }, {}, SCHEMES))).toEqual(["agent.auth.type"]);
  });

  it("rejects a missing, non-string or blank token", () => {
    expect(fields(resolveAuth({ auth: { type: "oauth" } }, {}, SCHEMES))).toEqual(["agent.auth.token"]);
    expect(fields(resolveAuth({ auth: { type: "oauth", token: 5 } }, {}, SCHEMES))).toEqual(["agent.auth.token"]);
    expect(fields(resolveAuth({ auth: { type: "oauth", token: "  " } }, {}, SCHEMES))).toEqual(["agent.auth.token"]);
  });

  it("reports a bad type and a bad token together", () => {
    expect(fields(resolveAuth({ auth: { type: "nope", token: "" } }, {}, SCHEMES)))
      .toEqual(["agent.auth.type", "agent.auth.token"]);
  });

  it("never falls back to the environment once an auth block is present", () => {
    const r = resolveAuth({ auth: { type: "nope", token: "x" } }, { ANTHROPIC_API_KEY: "sk-env" }, SCHEMES);
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @throng/agent-core -- auth`
Expected: FAIL — `Failed to resolve import "./auth.js"`.

- [ ] **Step 3: Write the minimal implementation**

Create `packages/core/src/manifest/auth.ts`:

```ts
import type { Env } from "../env.js";
import type { FieldError } from "./types.js";

/**
 * One credential mode an engine accepts. The ordered list an adapter declares
 * is, at once: the accepted `agent.auth.type` values, the env-fallback sources
 * in precedence order, the injection target for the selected type, and the
 * scrub set for every type that was not selected. Keeping them as one
 * declaration is what stops the four from drifting apart.
 */
export interface AuthScheme {
  type: string;
  env: string;
}

/** A resolved credential. `token` is guaranteed non-blank. */
export interface ResolvedAuth {
  type: string;
  token: string;
}

export type AuthResolution =
  | { ok: true; auth: ResolvedAuth | null }
  | { ok: false; errors: FieldError[] };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const nonBlank = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v : null;

/**
 * Resolves the one credential an engine will use: the manifest's `agent.auth`
 * block if present, else the first non-blank env var walking `schemes` in
 * order, else null.
 *
 * An `auth` block short-circuits the environment entirely, valid or not — a
 * caller who stated their intent and got it wrong should see the 400, not have
 * a different billing mode silently substituted, which is the failure this
 * whole shape exists to prevent.
 *
 * A blank token is an error rather than being coerced to absent. The old
 * `api_key` was a bare string with no way to signal intent, so coercion was the
 * only option; an explicit block that names a type and then carries no token is
 * unambiguously a caller bug.
 */
export function resolveAuth(
  agent: Record<string, unknown>,
  env: Env,
  schemes: AuthScheme[],
): AuthResolution {
  const block = agent.auth;
  if (block !== undefined) {
    if (!isObject(block)) {
      return { ok: false, errors: [{ field: "agent.auth", reason: "must be an object" }] };
    }
    const errors: FieldError[] = [];
    const scheme = schemes.find((s) => s.type === block.type);
    if (!scheme) {
      errors.push({
        field: "agent.auth.type",
        reason: `must be one of ${schemes.map((s) => s.type).join("/")}`,
      });
    }
    const token = nonBlank(block.token);
    if (token === null) {
      errors.push({ field: "agent.auth.token", reason: "must be a non-empty string" });
    }
    // Both guards re-tested together so TypeScript narrows; `errors` is
    // non-empty whenever either failed.
    if (!scheme || token === null) return { ok: false, errors };
    return { ok: true, auth: { type: scheme.type, token } };
  }

  for (const scheme of schemes) {
    const token = nonBlank(env[scheme.env]);
    if (token !== null) return { ok: true, auth: { type: scheme.type, token } };
  }
  return { ok: true, auth: null };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w @throng/agent-core -- auth`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/manifest/auth.ts packages/core/src/manifest/auth.test.ts
git commit -m "feat(core): resolve a tagged agent.auth credential"
```

---

## Task 2: Core — `applyAuth`, and export both

**Files:**
- Modify: `packages/core/src/manifest/auth.ts`
- Modify: `packages/core/src/manifest/auth.test.ts`
- Modify: `packages/core/src/index.ts:5`

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/manifest/auth.test.ts`, and add `afterEach` to the
existing vitest import so the first line reads
`import { afterEach, describe, expect, it } from "vitest";`:

```ts
const CREDENTIAL_VARS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];
const ALSO_SCRUB = ["ANTHROPIC_AUTH_TOKEN"];

describe("applyAuth", () => {
  // applyAuth deletes keys, not just sets them, so the whole set is restored.
  const saved = Object.fromEntries(CREDENTIAL_VARS.map((n) => [n, process.env[n]]));
  afterEach(() => {
    for (const n of CREDENTIAL_VARS) {
      const v = saved[n];
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
    }
  });

  it("sets the selected variable", () => {
    applyAuth({ type: "oauth", token: "oat-1" }, SCHEMES, ALSO_SCRUB);
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oat-1");
  });

  it("clears a competing scheme variable that was already set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ambient";
    applyAuth({ type: "oauth", token: "oat-1" }, SCHEMES, ALSO_SCRUB);
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oat-1");
  });

  it("clears an alsoScrub variable, which is never a fallback source", () => {
    process.env.ANTHROPIC_AUTH_TOKEN = "at-ambient";
    applyAuth({ type: "oauth", token: "oat-1" }, SCHEMES, ALSO_SCRUB);
    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("clears the OAuth token when the api_key mode is selected", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oat-ambient";
    applyAuth({ type: "api_key", token: "sk-1" }, SCHEMES, ALSO_SCRUB);
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-1");
  });

  it("leaves the environment untouched when nothing was resolved", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ambient";
    applyAuth(null, SCHEMES, ALSO_SCRUB);
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ambient");
  });

  it("defaults alsoScrub to empty", () => {
    applyAuth({ type: "api_key", token: "sk-1" }, SCHEMES);
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-1");
  });

  it("throws when the type has no scheme in the table", () => {
    expect(() => applyAuth({ type: "nope", token: "x" }, SCHEMES)).toThrow(/nope/);
  });
});
```

Update the import at the top of the file to pull in `applyAuth`:

```ts
import { applyAuth, resolveAuth, type AuthResolution, type AuthScheme } from "./auth.js";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @throng/agent-core -- auth`
Expected: FAIL — `applyAuth is not a function` / no export named `applyAuth`.

- [ ] **Step 3: Write the minimal implementation**

Append to `packages/core/src/manifest/auth.ts`:

```ts
/**
 * Puts the resolved credential into the process environment and removes every
 * competing one.
 *
 * The scrub is the point of this function. The Agent SDK reads its credential
 * off the process environment, and the A2A wrappers hand it a copy of
 * `process.env` — so a key that is merely ambient in the sandbox (baked into the
 * image, passed with a host `-e`, left by an earlier configuration) reaches the
 * engine even when the manifest never mentioned it, and the run silently bills
 * the wrong account. Precedence between the competing variables is internal to
 * the engine and not a documented contract, so it is not relied on: the losing
 * variables are removed outright.
 *
 * Safe to call during initialise because the wrappers snapshot `process.env`
 * per query, long after this has run.
 *
 * A null `auth` scrubs nothing: nothing was selected, so nothing is claimed and
 * whatever the operator put in the environment is left as they left it.
 */
export function applyAuth(
  auth: ResolvedAuth | null,
  schemes: AuthScheme[],
  alsoScrub: string[] = [],
): void {
  if (auth === null) return;
  const selected = schemes.find((s) => s.type === auth.type);
  if (!selected) {
    throw new Error(`no auth scheme is registered for type '${auth.type}'`);
  }
  // Scrub every candidate including the selected one, then set — so the result
  // is correct even if a scrub name ever collided with the injection target.
  for (const name of [...schemes.map((s) => s.env), ...alsoScrub]) {
    delete process.env[name];
  }
  process.env[selected.env] = auth.token;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w @throng/agent-core -- auth`
Expected: PASS, 19 tests.

- [ ] **Step 5: Export from the core barrel**

In `packages/core/src/index.ts`, **add** this line immediately after the
existing `resolveApiKey` export on line 5 (leave `resolveApiKey` in place — the
two adapters still import it and are migrated in Tasks 4 and 5):

```ts
export {
  resolveAuth,
  applyAuth,
  type AuthScheme,
  type ResolvedAuth,
  type AuthResolution,
} from "./manifest/auth.js";
```

- [ ] **Step 6: Verify the whole workspace still builds and passes**

Run: `npm run typecheck && npm test`
Expected: PASS across all four packages.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/manifest/auth.ts packages/core/src/manifest/auth.test.ts packages/core/src/index.ts
git commit -m "feat(core): apply a resolved credential, scrubbing competing env vars"
```

---

## Task 3: Claude — scheme table and a broadened settings guard

**Files:**
- Modify: `throng-agent-claude/src/config/credentials.ts`
- Modify: `throng-agent-claude/src/config/credentials.test.ts`

`injectAnthropicKey` is still imported by `src/adapter.ts`, so it stays until
Task 4. Only the guard is renamed and broadened here.

- [ ] **Step 1: Write the failing test**

Replace the whole of `throng-agent-claude/src/config/credentials.test.ts` with:

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertNoAnthropicCredentialInSettings,
  injectAnthropicKey,
  CLAUDE_AUTH_ALSO_SCRUB,
  CLAUDE_AUTH_SCHEMES,
} from "./credentials.js";

const tmp = () => mkdtempSync(join(tmpdir(), "a2a-cred-"));

/** Writes a settings.json with the given `env` block and returns its path. */
const settingsWith = (env: Record<string, unknown>) => {
  const p = join(tmp(), "settings.json");
  writeFileSync(p, JSON.stringify({ env }));
  return p;
};

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

describe("CLAUDE_AUTH_SCHEMES", () => {
  it("lists oauth before api_key, so an exported OAuth token wins the env tier", () => {
    expect(CLAUDE_AUTH_SCHEMES).toEqual([
      { type: "oauth", env: "CLAUDE_CODE_OAUTH_TOKEN" },
      { type: "api_key", env: "ANTHROPIC_API_KEY" },
    ]);
  });

  it("scrubs ANTHROPIC_AUTH_TOKEN without accepting it as a source", () => {
    expect(CLAUDE_AUTH_ALSO_SCRUB).toEqual(["ANTHROPIC_AUTH_TOKEN"]);
    expect(CLAUDE_AUTH_SCHEMES.map((s) => s.env)).not.toContain("ANTHROPIC_AUTH_TOKEN");
  });
});

describe("injectAnthropicKey", () => {
  it("sets process.env when a key is given", () => {
    injectAnthropicKey("sk-test");
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-test");
  });

  it("leaves env untouched when key is null", () => {
    injectAnthropicKey(null);
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe("assertNoAnthropicCredentialInSettings", () => {
  it("passes when the settings file is absent", () => {
    expect(() => assertNoAnthropicCredentialInSettings(join(tmp(), "settings.json"))).not.toThrow();
  });

  it("passes when the settings file is unparseable", () => {
    const p = join(tmp(), "settings.json");
    writeFileSync(p, "{not json");
    expect(() => assertNoAnthropicCredentialInSettings(p)).not.toThrow();
  });

  it("passes when settings pins nothing credential-shaped", () => {
    expect(() => assertNoAnthropicCredentialInSettings(settingsWith({ FOO: "bar" }))).not.toThrow();
  });

  it("passes when settings has no env block at all", () => {
    const p = join(tmp(), "settings.json");
    writeFileSync(p, JSON.stringify({ model: "claude-opus-5" }));
    expect(() => assertNoAnthropicCredentialInSettings(p)).not.toThrow();
  });

  it("throws when settings pins env.ANTHROPIC_API_KEY", () => {
    expect(() => assertNoAnthropicCredentialInSettings(settingsWith({ ANTHROPIC_API_KEY: "sk-oops" })))
      .toThrow(/ANTHROPIC_API_KEY/);
  });

  it("throws when settings pins env.CLAUDE_CODE_OAUTH_TOKEN", () => {
    expect(() => assertNoAnthropicCredentialInSettings(settingsWith({ CLAUDE_CODE_OAUTH_TOKEN: "oat-oops" })))
      .toThrow(/CLAUDE_CODE_OAUTH_TOKEN/);
  });

  it("throws when settings pins env.ANTHROPIC_AUTH_TOKEN", () => {
    expect(() => assertNoAnthropicCredentialInSettings(settingsWith({ ANTHROPIC_AUTH_TOKEN: "at-oops" })))
      .toThrow(/ANTHROPIC_AUTH_TOKEN/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx turbo run test --filter=throng-agent-claude`
Expected: FAIL — no export named `assertNoAnthropicCredentialInSettings`.

- [ ] **Step 3: Write the minimal implementation**

Replace `throng-agent-claude/src/config/credentials.ts` with:

```ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AuthScheme } from "@throng/agent-core";

/**
 * The credential modes the Claude engine accepts, in env-fallback precedence
 * order. OAuth first: a container carrying both variables is already an odd
 * configuration, and going to the trouble of exporting an OAuth token is an
 * unambiguous request for subscription billing.
 */
export const CLAUDE_AUTH_SCHEMES: AuthScheme[] = [
  { type: "oauth", env: "CLAUDE_CODE_OAUTH_TOKEN" },
  { type: "api_key", env: "ANTHROPIC_API_KEY" },
];

/**
 * A credential the SDK honours but the manifest does not accept as input, so it
 * is cleared without ever becoming a fallback source.
 */
export const CLAUDE_AUTH_ALSO_SCRUB = ["ANTHROPIC_AUTH_TOKEN"];

/** Every credential variable a settings file must not pin. */
const PINNABLE = [...CLAUDE_AUTH_SCHEMES.map((s) => s.env), ...CLAUDE_AUTH_ALSO_SCRUB];

/** Sets ANTHROPIC_API_KEY in-process (once per sandbox). No-op when key is null. */
export function injectAnthropicKey(key: string | null): void {
  if (key) process.env.ANTHROPIC_API_KEY = key;
}

/**
 * Guards against ~/.claude/settings.json pinning any Anthropic credential in its
 * `env` block, which the SDK gives precedence over our per-process value. All of
 * them are rejected regardless of which mode was selected: a pinned
 * CLAUDE_CODE_OAUTH_TOKEN overrides ours exactly as readily as a pinned API key
 * does, and either way the run is billed to an account nobody chose.
 *
 * Absent/unreadable/unparseable settings are treated as fine — the file is
 * optional, and a missed check costs less than refusing to boot over one.
 */
export function assertNoAnthropicCredentialInSettings(
  settingsPath: string = join(homedir(), ".claude", "settings.json"),
): void {
  let raw: string;
  try {
    raw = readFileSync(settingsPath, "utf-8");
  } catch {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  const env = (parsed as { env?: Record<string, unknown> } | null)?.env;
  if (!env) return;
  const pinned = PINNABLE.find((name) => env[name]);
  if (pinned) {
    throw new Error(
      `${settingsPath} sets env.${pinned}, which overrides the per-process credential. Remove it.`,
    );
  }
}
```

- [ ] **Step 4: Update the one remaining caller so the package compiles**

In `throng-agent-claude/src/adapter.ts`, change the import on line 5 and the
call on line 20:

```ts
import { assertNoAnthropicCredentialInSettings, injectAnthropicKey } from "./config/credentials.js";
```

```ts
    assertNoAnthropicCredentialInSettings();
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx turbo run test --filter=throng-agent-claude && npx turbo run typecheck --filter=throng-agent-claude`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add throng-agent-claude/src/config/credentials.ts throng-agent-claude/src/config/credentials.test.ts throng-agent-claude/src/adapter.ts
git commit -m "feat(claude): declare the auth scheme table, broaden the settings guard"
```

---

## Task 4: Claude — migrate the validator and adapter to `agent.auth`

**Files:**
- Modify: `throng-agent-claude/src/manifest/claude-agent.ts`
- Modify: `throng-agent-claude/src/manifest/claude-agent.test.ts`
- Modify: `throng-agent-claude/src/adapter.ts`
- Modify: `throng-agent-claude/src/adapter.test.ts`
- Modify: `throng-agent-claude/src/config/build.test.ts:16`
- Modify: `throng-agent-claude/src/config/credentials.test.ts` (drop the `injectAnthropicKey` block)
- Modify: `throng-agent/src/integration/boot.test.ts:25`

- [ ] **Step 1: Write the failing tests**

In `throng-agent-claude/src/manifest/claude-agent.test.ts`, **replace** the three
existing `api_key` tests (`"resolves api_key from agent.api_key"`, `"falls back
to ANTHROPIC_API_KEY when agent.api_key is absent"`, `"rejects a non-string
agent.api_key"`) with:

```ts
  it("resolves an oauth auth block", () => {
    const r = validateClaudeAgent({ agent: { auth: { type: "oauth", token: "oat-1" } } }, {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent.auth).toEqual({ type: "oauth", token: "oat-1" });
  });

  it("resolves an api_key auth block", () => {
    const r = validateClaudeAgent({ agent: { auth: { type: "api_key", token: "sk-1" } } }, {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent.auth).toEqual({ type: "api_key", token: "sk-1" });
  });

  it("falls back to CLAUDE_CODE_OAUTH_TOKEN ahead of ANTHROPIC_API_KEY", () => {
    const r = validateClaudeAgent({ agent: {} }, {
      CLAUDE_CODE_OAUTH_TOKEN: "oat-env",
      ANTHROPIC_API_KEY: "sk-env",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent.auth).toEqual({ type: "oauth", token: "oat-env" });
  });

  it("resolves no auth when neither the manifest nor the env carries one", () => {
    const r = validateClaudeAgent({ agent: {} }, {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent.auth).toBe(null);
  });

  it("rejects an auth type the engine does not accept", () => {
    const r = validateClaudeAgent({ agent: { auth: { type: "chatgpt", token: "x" } } }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "agent.auth.type")).toBe(true);
  });

  it("reports an auth error alongside an unrelated agent error in one result", () => {
    const r = validateClaudeAgent({ agent: { auth: { type: "oauth" }, effort: "nope" } }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.map((e) => e.field).sort()).toEqual(["agent.auth.token", "agent.effort"]);
    }
  });
```

In the same file, the existing plugin test at line ~36 passes
`{ agent: { plugins: [{ path: "/opt/p" }], api_key: "sk" } }` — change
`api_key: "sk"` to `auth: { type: "api_key", token: "sk" } `.

In `throng-agent-claude/src/adapter.test.ts`, **replace** the
`"injectCredentials sets ANTHROPIC_API_KEY"` test with:

```ts
  it("injectCredentials selects OAuth and clears an ambient API key", () => {
    const saved = { api: process.env.ANTHROPIC_API_KEY, oat: process.env.CLAUDE_CODE_OAUTH_TOKEN };
    process.env.ANTHROPIC_API_KEY = "sk-ambient";
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    try {
      new ClaudeEngineAdapter().injectCredentials({
        platform: "claude",
        agent: {
          keys: {},
          plugins: { local: [], marketplaces: {}, enabledPlugins: {}, unpinned: [] },
          auth: { type: "oauth", token: "oat-x" },
        },
      } as unknown as Manifest<ResolvedClaudeAgent>);
      // The ambient key is the whole point: the SDK reads it off the environment,
      // so leaving it set would bill API credits despite the OAuth manifest.
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oat-x");
      expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    } finally {
      if (saved.api === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved.api;
      if (saved.oat === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = saved.oat;
    }
  });

  it("injectCredentials selects the API key and clears an ambient OAuth token", () => {
    const saved = { api: process.env.ANTHROPIC_API_KEY, oat: process.env.CLAUDE_CODE_OAUTH_TOKEN };
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oat-ambient";
    delete process.env.ANTHROPIC_API_KEY;
    try {
      new ClaudeEngineAdapter().injectCredentials({
        platform: "claude",
        agent: {
          keys: {},
          plugins: { local: [], marketplaces: {}, enabledPlugins: {}, unpinned: [] },
          auth: { type: "api_key", token: "sk-x" },
        },
      } as unknown as Manifest<ResolvedClaudeAgent>);
      expect(process.env.ANTHROPIC_API_KEY).toBe("sk-x");
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    } finally {
      if (saved.api === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved.api;
      if (saved.oat === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = saved.oat;
    }
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx turbo run test --filter=throng-agent-claude`
Expected: FAIL — `r.agent.auth` is undefined and the injectCredentials tests find
`ANTHROPIC_API_KEY` still set to `"sk-ambient"`.

- [ ] **Step 3: Migrate the validator**

In `throng-agent-claude/src/manifest/claude-agent.ts`:

Change the imports at the top of the file to:

```ts
import { resolveAuth, type AgentResult, type Env, type FieldError, type ResolvedAuth } from "@throng/agent-core";
import { CLAUDE_AUTH_SCHEMES } from "../config/credentials.js";
import { EMPTY_PLUGINS, resolvePlugins, type ResolvedPlugins } from "../config/plugins.js";
```

Change the `api_key` field on the interface:

```ts
export interface ResolvedClaudeAgent {
  /** Raw agent keys (model, tools, system prompts, max_turns, permission_mode). */
  keys: Record<string, unknown>;
  plugins: ResolvedPlugins;
  auth: ResolvedAuth | null;
}
```

Add a second accumulator beside the existing `let plugins`:

```ts
  let plugins: ResolvedPlugins = EMPTY_PLUGINS;
  let auth: ResolvedAuth | null = null;
```

Delete the `api_key` string check:

```ts
    if ("api_key" in a && typeof a.api_key !== "string") {
      errors.push({ field: "agent.api_key", reason: "must be a string" });
    }
```

Add the auth resolution immediately after the `resolvePlugins` block, inside the
same `else` branch:

```ts
    const authResult = resolveAuth(a, env, CLAUDE_AUTH_SCHEMES);
    if (authResult.ok) auth = authResult.auth;
    else errors.push(...authResult.errors);
```

Change the success return:

```ts
  return { ok: true, agent: { keys: a, plugins, auth } };
```

- [ ] **Step 4: Migrate the adapter**

In `throng-agent-claude/src/adapter.ts`, change the two imports and the body of
`injectCredentials`:

```ts
import { applyAuth, log } from "@throng/agent-core";
import {
  assertNoAnthropicCredentialInSettings,
  CLAUDE_AUTH_ALSO_SCRUB,
  CLAUDE_AUTH_SCHEMES,
} from "./config/credentials.js";
```

```ts
  injectCredentials(manifest: Manifest<ResolvedClaudeAgent>): void {
    assertNoAnthropicCredentialInSettings();
    applyAuth(manifest.agent.auth, CLAUDE_AUTH_SCHEMES, CLAUDE_AUTH_ALSO_SCRUB);
    if (manifest.agent.auth === null) {
      log.warn("no agent.auth in manifest; agent requests will fail unless another auth path is configured");
    }
```

The rest of the method (the plugin logging) is unchanged. The file currently has
two imports from `@throng/agent-core`: a `import type { … }` line and a
`import { log }` line. Merge `applyAuth` into the **value** import (as shown);
leave the type-only import alone.

- [ ] **Step 5: Drop `injectAnthropicKey`**

It now has no callers. In `throng-agent-claude/src/config/credentials.ts`,
delete the function:

```ts
/** Sets ANTHROPIC_API_KEY in-process (once per sandbox). No-op when key is null. */
export function injectAnthropicKey(key: string | null): void {
  if (key) process.env.ANTHROPIC_API_KEY = key;
}
```

In `throng-agent-claude/src/config/credentials.test.ts`, delete the whole
`describe("injectAnthropicKey", …)` block and remove `injectAnthropicKey` from
the import list.

- [ ] **Step 6: Migrate the remaining fixtures**

`throng-agent-claude/src/config/build.test.ts:16` —
change `agent: { keys, plugins, api_key: null },` to
`agent: { keys, plugins, auth: null },`.

`throng-agent/src/integration/boot.test.ts:25` —
change `agent: { platform: "claude", api_key: "sk-test", permission_mode: "plan" },` to:

```ts
      agent: {
        platform: "claude",
        auth: { type: "api_key", token: "sk-test" },
        permission_mode: "plan",
      },
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx turbo run test --filter=throng-agent-claude --filter=throng-agent && npx turbo run typecheck --filter=throng-agent-claude --filter=throng-agent`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add throng-agent-claude throng-agent/src/integration/boot.test.ts
git commit -m "feat(claude): take credentials from agent.auth, clearing competing env vars"
```

---

## Task 5: Codex — migrate to `agent.auth`

**Files:**
- Modify: `throng-agent-codex/src/config/credentials.ts`
- Modify: `throng-agent-codex/src/manifest/codex-agent.ts`
- Modify: `throng-agent-codex/src/manifest/codex-agent.test.ts`
- Modify: `throng-agent-codex/src/adapter.ts`
- Modify: `throng-agent-codex/src/adapter.test.ts`
- Modify: `throng-agent-codex/src/config/build.test.ts:12`

- [ ] **Step 1: Write the failing tests**

In `throng-agent-codex/src/manifest/codex-agent.test.ts`, **replace** the two
existing `api_key` tests (`"resolves api_key from agent.api_key then
OPENAI_API_KEY"` and `"rejects a non-string agent.api_key"`) with:

```ts
  it("resolves an api_key auth block", () => {
    const r = validateCodexAgent({ agent: { auth: { type: "api_key", token: "sk-in" } } }, {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent.auth).toEqual({ type: "api_key", token: "sk-in" });
  });

  it("falls back to OPENAI_API_KEY", () => {
    const r = validateCodexAgent({ agent: {} }, { OPENAI_API_KEY: "sk-env" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent.auth).toEqual({ type: "api_key", token: "sk-env" });
  });

  it("resolves no auth when neither the manifest nor the env carries one", () => {
    const r = validateCodexAgent({ agent: {} }, {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent.auth).toBe(null);
  });

  it("rejects type oauth, which Codex does not accept", () => {
    const r = validateCodexAgent({ agent: { auth: { type: "oauth", token: "oat" } } }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "agent.auth.type")).toBe(true);
  });

  it("rejects a blank token", () => {
    const r = validateCodexAgent({ agent: { auth: { type: "api_key", token: "" } } }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "agent.auth.token")).toBe(true);
  });
```

In `throng-agent-codex/src/adapter.test.ts`, **replace** the
`"injectCredentials sets OPENAI_API_KEY"` test with:

```ts
  it("injectCredentials sets OPENAI_API_KEY from agent.auth", () => {
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      new CodexEngineAdapter().injectCredentials({
        platform: "codex",
        agent: { keys: {}, auth: { type: "api_key", token: "sk-c" } },
      } as unknown as Manifest<ResolvedCodexAgent>);
      expect(process.env.OPENAI_API_KEY).toBe("sk-c");
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev;
    }
  });

  it("injectCredentials leaves an ambient key alone when no auth was resolved", () => {
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-ambient";
    try {
      new CodexEngineAdapter().injectCredentials({
        platform: "codex",
        agent: { keys: {}, auth: null },
      } as unknown as Manifest<ResolvedCodexAgent>);
      expect(process.env.OPENAI_API_KEY).toBe("sk-ambient");
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev;
    }
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx turbo run test --filter=throng-agent-codex`
Expected: FAIL — `r.agent.auth` is undefined.

- [ ] **Step 3: Replace the credentials module with the scheme table**

Replace the whole of `throng-agent-codex/src/config/credentials.ts` with:

```ts
import type { AuthScheme } from "@throng/agent-core";

/**
 * The credential modes the Codex engine accepts. ChatGPT-subscription auth uses
 * an on-disk `auth.json` rather than an environment variable, so it has no place
 * in this table; `api_key` is the only mode.
 */
export const CODEX_AUTH_SCHEMES: AuthScheme[] = [{ type: "api_key", env: "OPENAI_API_KEY" }];
```

- [ ] **Step 4: Migrate the validator**

In `throng-agent-codex/src/manifest/codex-agent.ts`:

Change the import at the top of the file to:

```ts
import { resolveAuth, type AgentResult, type Env, type FieldError, type ResolvedAuth } from "@throng/agent-core";
import { CODEX_AUTH_SCHEMES } from "../config/credentials.js";
```

Change the interface:

```ts
export interface ResolvedCodexAgent {
  keys: Record<string, unknown>;
  auth: ResolvedAuth | null;
}
```

Add an accumulator immediately after `const errors: FieldError[] = [];`:

```ts
  let auth: ResolvedAuth | null = null;
```

Delete the `api_key` string check:

```ts
    if ("api_key" in a && typeof a.api_key !== "string") {
      errors.push({ field: "agent.api_key", reason: "must be a string" });
    }
```

and put the resolution in its place, still inside the same `else` branch:

```ts
    const authResult = resolveAuth(a, env, CODEX_AUTH_SCHEMES);
    if (authResult.ok) auth = authResult.auth;
    else errors.push(...authResult.errors);
```

Change the success return:

```ts
  return { ok: true, agent: { keys: a, auth } };
```

- [ ] **Step 5: Migrate the adapter**

In `throng-agent-codex/src/adapter.ts`, replace the `log` import, the
`injectOpenAIKey` import, and the body of `injectCredentials`:

```ts
import { applyAuth, log } from "@throng/agent-core";
import { CODEX_AUTH_SCHEMES } from "./config/credentials.js";
```

```ts
  injectCredentials(manifest: Manifest<ResolvedCodexAgent>): void {
    applyAuth(manifest.agent.auth, CODEX_AUTH_SCHEMES);
    if (manifest.agent.auth === null) {
      log.warn("no agent.auth in manifest; agent requests will fail unless another auth path is configured");
    }
  }
```

As with the Claude adapter, this file has both a `import type { … }` line and a
`import { log }` line from `@throng/agent-core`. Merge `applyAuth` into the
**value** import; leave the type-only import alone.

- [ ] **Step 6: Migrate the remaining fixture**

`throng-agent-codex/src/config/build.test.ts:12` — change
`agent: { keys, api_key: null },` to `agent: { keys, auth: null },`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx turbo run test --filter=throng-agent-codex && npx turbo run typecheck --filter=throng-agent-codex`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add throng-agent-codex
git commit -m "feat(codex): take credentials from agent.auth"
```

---

## Task 6: Core — delete `resolveApiKey`

**Files:**
- Delete: `packages/core/src/manifest/api-key.ts`
- Delete: `packages/core/src/manifest/api-key.test.ts`
- Modify: `packages/core/src/index.ts:5`
- Modify: `packages/core/src/engine/adapter.ts:27`

Both call sites are gone, so this is now dead code.

- [ ] **Step 1: Confirm there are no remaining references**

Run:

```bash
grep -rn "resolveApiKey\|api_key\|injectAnthropicKey\|injectOpenAIKey" packages throng-agent throng-agent-claude throng-agent-codex | grep -v "/node_modules/" | grep -v "/dist/"
```

Expected: only hits inside `packages/core/src/manifest/api-key.ts`,
`packages/core/src/manifest/api-key.test.ts`, the `index.ts` export line, and
the `engine/adapter.ts` doc comment. If anything else appears, migrate it before
continuing.

- [ ] **Step 2: Delete the module and its test**

```bash
git rm packages/core/src/manifest/api-key.ts packages/core/src/manifest/api-key.test.ts
```

- [ ] **Step 3: Remove the export**

In `packages/core/src/index.ts`, delete line 5:

```ts
export { resolveApiKey } from "./manifest/api-key.js";
```

- [ ] **Step 4: Fix the stale doc comment**

In `packages/core/src/engine/adapter.ts`, the `validateAgent` doc comment names a
field that no longer exists. Replace:

```ts
  /** Validate + resolve the engine-specific parts of the raw manifest.
   *  Receives the full raw input so it can read `agent` and any engine
   *  credential fields (e.g. anthropic_api_key). Returns typed field errors
   *  that core folds into the 400 response. */
```

with:

```ts
  /** Validate + resolve the engine-specific parts of the raw manifest.
   *  Receives the full raw input so it can read `agent`, including its
   *  `auth` block, which each engine resolves against its own scheme table.
   *  Returns typed field errors that core folds into the 400 response. */
```

- [ ] **Step 5: Run the whole workspace**

Run: `npm run typecheck && npm test`
Expected: PASS across all four packages, with no reference to `api-key.js`.

- [ ] **Step 6: Commit**

```bash
git add packages/core
git commit -m "refactor(core): drop resolveApiKey, superseded by resolveAuth"
```

---

## Task 7: Docs and changeset

**Files:**
- Modify: `README.md`
- Create: `.changeset/agent-auth-block.md`

- [ ] **Step 1: Update the manifest example**

In `README.md`, in the "Manifest Example" block, replace the line:

```jsonc
    "api_key": "sk-…",         // generic LLM key; the adapter maps it to its SDK env var
```

with:

```jsonc
    "auth": {                  // the one credential; see below
      "type": "api_key",       // claude: api_key | oauth — codex: api_key
      "token": "sk-…"
    },
```

- [ ] **Step 2: Add an `auth` subsection**

In `README.md`, insert a new section immediately **before** the existing
`### `thinking` and `effort` (claude)` heading:

````markdown
### `agent.auth`

The single credential the engine runs under, tagged with its own type:

```jsonc
"auth": { "type": "oauth", "token": "sk-ant-oat01-…" }
```

| `type` | Engines | Becomes | Billing |
| --- | --- | --- | --- |
| `api_key` | claude, codex | `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | API credits |
| `oauth` | claude | `CLAUDE_CODE_OAUTH_TOKEN` | the token owner's Claude Code subscription |

`oauth` takes the kind of token `claude setup-token` mints. An engine rejects a
`type` it does not accept — `codex` with `oauth` is a `400` on `agent.auth.type`.
Both fields are required and `token` must be non-blank; there is no coercion of a
blank token to "absent", because silently switching billing mode is exactly the
failure this shape exists to prevent.

`auth` may be omitted, in which case the credential falls back to the
environment: `CLAUDE_CODE_OAUTH_TOKEN` then `ANTHROPIC_API_KEY` for claude,
`OPENAI_API_KEY` for codex. OAuth is checked first — a sandbox carrying both is
already an odd configuration, and exporting an OAuth token is an unambiguous
request for subscription billing. As with the other env fallbacks, this is a
standalone-`docker run` convenience: under E2B the runtime is resumed with a
scrubbed environment.

**Selecting a type clears the others.** The Agent SDK reads its credential off
the process environment and the A2A wrappers hand it a copy of `process.env`, so
an `ANTHROPIC_API_KEY` that is merely ambient in the sandbox — baked into the
image, passed with a host `-e`, left by an earlier configuration — would reach
Claude Code even though the manifest asked for OAuth, and the run would silently
bill API credits. Whichever type is selected, `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` are all removed from the
environment before the winner is set, so the billing mode is a guarantee rather
than a bet on the engine's internal precedence. A `~/.claude/settings.json` that
pins any of the three in its `env` block is a hard boot error for the same
reason: the SDK would give it precedence over the per-process value.

`agent.api_key` was the previous form and is **gone**, not deprecated — a
manifest still sending it resolves no credential at all.
````

- [ ] **Step 3: Update the standalone recipe**

In `README.md`, in the "Running standalone" `curl` block, replace:

```
  "agent": {"platform":"claude","api_key":"sk-…"}
```

with:

```
  "agent": {"platform":"claude","auth":{"type":"api_key","token":"sk-…"}}
```

- [ ] **Step 4: Write the changeset**

Create `.changeset/agent-auth-block.md`:

```markdown
---
"@throng/agent-core": minor
"throng-agent-claude": minor
"throng-agent-codex": minor
---

Replace the manifest's `agent.api_key` with a tagged `agent.auth` block, and support billing a
Claude task against a Claude Code subscription.

```jsonc
"agent": { "platform": "claude", "auth": { "type": "oauth", "token": "sk-ant-oat01-…" } }
```

`type` is `api_key` or `oauth` for claude and `api_key` only for codex; it selects which environment
variable the token becomes (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY`). One
tagged value rather than two sibling fields means two credentials are not expressible, so there is
no precedence rule to get wrong.

Selecting a type now **clears the competing variables**. The Agent SDK reads its credential off the
process environment and the A2A wrappers pass it a copy of `process.env`, so an `ANTHROPIC_API_KEY`
that was merely ambient in the sandbox reached Claude Code even when the manifest never mentioned
it — an OAuth run would silently bill API credits. `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and
`CLAUDE_CODE_OAUTH_TOKEN` are all removed before the selected one is set, so the billing mode no
longer depends on the engine's undocumented internal precedence. The `~/.claude/settings.json`
guard was widened to all three names for the same reason.

**Breaking:** `agent.api_key` is removed with no alias or deprecation window — a manifest still
sending it resolves no credential and boots with the "requests will fail" warning. Library
consumers: `resolveApiKey` is replaced by `resolveAuth` / `applyAuth`, and the resolved payloads
(`ResolvedClaudeAgent`, `ResolvedCodexAgent`) carry `auth: ResolvedAuth | null` instead of
`api_key: string | null`.
```

- [ ] **Step 5: Verify the whole workspace one last time**

Run: `npm run typecheck && npm test && npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add README.md .changeset/agent-auth-block.md
git commit -m "docs: document agent.auth and the credential scrub"
```

---

## Verification

Run all of these from the repo root and confirm each passes before calling the
work done:

```bash
npm run typecheck
npm test
npm run build
```

Then confirm the old surface is fully gone:

```bash
grep -rn "resolveApiKey\|api_key\|injectAnthropicKey\|injectOpenAIKey" \
  packages throng-agent throng-agent-claude throng-agent-codex \
  | grep -v "/node_modules/" | grep -v "/dist/"
```

Expected: **no output.** Source paths only — `README.md`, `.changeset/` and
`docs/` all mention `agent.api_key` legitimately, when describing its removal.
