# Throng Agent Monorepo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure `throng_agent_claude` into a fresh `throng_agent` monorepo — a shared, published `@throng/agent-core` library plus one deployable package per engine (`throng-agent-claude` at behavioural parity with today; `throng-agent-codex` as a working stub) — so the manifest / initialise-API logic lives once.

**Architecture:** `@throng/agent-core` owns the whole init pipeline (lifecycle, control HTTP API, git/setup bootstrap, generic manifest validation, boot orchestration, process entrypoint). Engine-specific behaviour is supplied through an `EngineAdapter` interface each variant implements over its a2a library. Mirrors the upstream `a2a-wrapper` monorepo: npm workspaces + Turborepo + Changesets, shared code under `packages/`, deployables as top-level `throng-agent-*` dirs.

**Tech Stack:** TypeScript (ESM, NodeNext), Node 20, Express, Vitest, Turborepo, Changesets, `@col/a2a-claude`, `a2a-codex`.

---

## Conventions for executors

- **New repo location:** `/Users/col/projects/throng_platform/throng_agent/`. The
  **source repo** to port from is `/Users/col/projects/throng_platform/throng_agent_claude/`
  (referred to below as `SRC`). Read files from `SRC` as needed.
- **Ports are copy-and-adjust, not rewrite.** When a step says "port `SRC/src/x.ts`",
  copy that file's exact contents to the target path and change only the imports
  named in the step. Carry the matching `SRC/test/...` file the same way. Do not
  paraphrase working code.
- **Import rewrites:** inside `packages/core`, intra-core imports keep relative
  paths. In variant packages, imports that used to point at core modules become
  `@throng/agent-core`.
- **Every task ends green:** run the named command, see it pass, then commit.
- **Commit style:** conventional commits, one per task (or per red/green cycle
  where a task has several).

---

## File structure (target)

```
throng_agent/
  package.json                       # private root; workspaces ["packages/*","throng-agent-*"]
  turbo.json
  tsconfig.base.json
  .changeset/config.json
  .gitignore  .npmrc  .mise.toml
  .github/workflows/ci.yml
  packages/core/
    package.json  tsconfig.json  README.md
    src/
      index.ts                       # public exports
      log.ts
      lifecycle.ts
      env.ts                         # Env type
      control/server.ts              # createControlApp + startControlServer + main
      control/init-token.ts
      bootstrap/git.ts  bootstrap/setup.ts  bootstrap/askpass.sh
      manifest/types.ts              # RepoSpec, BaseManifest, Manifest<TAgent>, FieldError, ValidateResult
      manifest/validate.ts           # generic validation, delegates agent to adapter
      engine/adapter.ts              # EngineAdapter, ServerHandle, AgentResult
      task-run.ts                    # BootDeps + TaskRun<TAgent,TConfig>
    src/__tests__/monorepo/          # no-duplicates, publish-config, tsconfig-consistency
  throng-agent-claude/
    package.json  tsconfig.json  Dockerfile  .dockerignore  .npmrc
    src/
      index.ts                       # startControlServer(new ClaudeEngineAdapter())
      adapter.ts                     # ClaudeEngineAdapter
      config/build.ts  config/credentials.ts  config/plugins.ts
      manifest/claude-agent.ts       # validateClaudeAgent → ResolvedClaudeAgent
  throng-agent-codex/
    package.json  tsconfig.json  Dockerfile  .dockerignore  .npmrc
    src/
      index.ts                       # startControlServer(new CodexEngineAdapter())
      adapter.ts                     # CodexEngineAdapter
      config/build.ts  config/credentials.ts
      manifest/codex-agent.ts        # validateCodexAgent → ResolvedCodexAgent
```

---

## Phase 0 — Monorepo scaffold

### Task 1: Create the repo and root workspace config

**Files:**
- Create: `throng_agent/package.json`, `turbo.json`, `tsconfig.base.json`,
  `.changeset/config.json`, `.gitignore`, `.npmrc`, `.mise.toml`

- [ ] **Step 1: Init repo**

```bash
mkdir -p /Users/col/projects/throng_platform/throng_agent
cd /Users/col/projects/throng_platform/throng_agent
git init -q
```

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "throng-agent",
  "version": "0.0.0",
  "private": true,
  "description": "Monorepo for Throng A2A agent runtimes (core + engine variants)",
  "type": "module",
  "workspaces": ["packages/*", "throng-agent-*"],
  "scripts": {
    "build": "turbo run build",
    "test": "turbo run test",
    "typecheck": "turbo run typecheck",
    "clean": "turbo run clean",
    "changeset": "changeset",
    "version-packages": "changeset version",
    "release": "turbo run build && changeset publish"
  },
  "devDependencies": {
    "@changesets/cli": "^2.27.0",
    "turbo": "^2.5.0"
  },
  "packageManager": "npm@10.9.2",
  "engines": { "node": ">=20" }
}
```

- [ ] **Step 3: Write `turbo.json`**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "typecheck": { "dependsOn": ["^build"], "outputs": [] },
    "test": { "dependsOn": ["^build"], "outputs": [] },
    "clean": { "cache": false }
  }
}
```

- [ ] **Step 4: Write `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "sourceMap": true,
    "resolveJsonModule": true
  }
}
```

- [ ] **Step 5: Write `.changeset/config.json`**

```json
{
  "$schema": "https://unpkg.com/@changesets/config@3.0.0/schema.json",
  "changelog": "@changesets/cli/changelog",
  "commit": false,
  "fixed": [],
  "linked": [],
  "access": "public",
  "baseBranch": "main",
  "updateInternalDependencies": "patch",
  "ignore": []
}
```

- [ ] **Step 6: Copy `.gitignore`, `.npmrc`, `.mise.toml` from SRC**

```bash
cp /Users/col/projects/throng_platform/throng_agent_claude/.gitignore ./.gitignore
cp /Users/col/projects/throng_platform/throng_agent_claude/.npmrc ./.npmrc
cp /Users/col/projects/throng_platform/throng_agent_claude/.mise.toml ./.mise.toml
```

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "chore: scaffold throng_agent monorepo (workspaces + turbo + changesets)"
```

---

## Phase 1 — `@throng/agent-core`

### Task 2: Core package skeleton

**Files:**
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`,
  `packages/core/vitest.config.ts`, `packages/core/README.md`

- [ ] **Step 1: Write `packages/core/package.json`**

```json
{
  "name": "@throng/agent-core",
  "version": "0.1.0",
  "description": "Shared init/manifest/control-API runtime for Throng A2A agent variants.",
  "type": "module",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "types": "./dist/index.d.ts",
  "main": "./dist/index.js",
  "files": ["dist"],
  "scripts": {
    "build": "tsc && cp src/bootstrap/askpass.sh dist/bootstrap/askpass.sh && chmod +x dist/bootstrap/askpass.sh",
    "typecheck": "tsc --noEmit",
    "test": "vitest --run",
    "clean": "rm -rf dist"
  },
  "peerDependencies": { "express": "^4.18.2" },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^20.10.0",
    "@types/supertest": "^7.2.0",
    "express": "^4.18.2",
    "supertest": "^7.2.2",
    "typescript": "^5.3.0",
    "vitest": "^1.6.0"
  },
  "engines": { "node": ">=20" },
  "publishConfig": { "access": "public" },
  "license": "MIT"
}
```

- [ ] **Step 2: Write `packages/core/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "src/**/__tests__/**", "src/**/*.test.ts"]
}
```

- [ ] **Step 3: Write `packages/core/vitest.config.ts`** (copy from `SRC/vitest.config.ts`)

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["src/**/*.test.ts", "src/**/__tests__/**/*.test.ts"] },
});
```

- [ ] **Step 4: Write a one-line `packages/core/README.md`**

```markdown
# @throng/agent-core

Shared init/manifest/control-API runtime for Throng A2A agent variants.
```

- [ ] **Step 5: Install workspace deps and commit**

```bash
cd /Users/col/projects/throng_platform/throng_agent && npm install
git add -A && git commit -m "chore(core): add @throng/agent-core package skeleton"
```

Expected: `npm install` links the workspace with no build errors.

---

### Task 3: Port leaf utilities (`log`, `env`, `init-token`, `bootstrap/*`)

These are engine-agnostic and move verbatim. `env.ts` is new (a shared `Env` type).

**Files:**
- Create: `packages/core/src/log.ts`, `packages/core/src/env.ts`,
  `packages/core/src/control/init-token.ts`, `packages/core/src/bootstrap/git.ts`,
  `packages/core/src/bootstrap/setup.ts`, `packages/core/src/bootstrap/askpass.sh`
- Tests: `packages/core/src/control/init-token.test.ts`,
  `packages/core/src/bootstrap/git.test.ts`, `packages/core/src/bootstrap/setup.test.ts`

- [ ] **Step 1: Port the modules**

Copy verbatim (no import changes needed — all use `node:` builtins only):
- `SRC/src/log.ts` → `packages/core/src/log.ts`
- `SRC/src/control/init-token.ts` → `packages/core/src/control/init-token.ts`
- `SRC/src/bootstrap/git.ts` → `packages/core/src/bootstrap/git.ts`
- `SRC/src/bootstrap/setup.ts` → `packages/core/src/bootstrap/setup.ts`
- `SRC/src/bootstrap/askpass.sh` → `packages/core/src/bootstrap/askpass.sh`

- [ ] **Step 2: Create `packages/core/src/env.ts`**

```ts
/** Environment map used for manifest fallback resolution. */
export type Env = Record<string, string | undefined>;
```

- [ ] **Step 3: Port the tests**

Copy `SRC/test/control/init-token.test.ts`, `SRC/test/bootstrap/git.test.ts`,
`SRC/test/bootstrap/setup.test.ts` to sit next to their modules under
`packages/core/src/...` (e.g. `packages/core/src/control/init-token.test.ts`).
Adjust each test's import of the module-under-test to the new relative path
(e.g. `../../control/init-token.js` → `./init-token.js`).

- [ ] **Step 4: Run tests**

Run: `cd /Users/col/projects/throng_platform/throng_agent && npm test -w @throng/agent-core`
Expected: init-token, git, setup suites PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(core): port log, env, init-token, git and setup bootstrap"
```

---

### Task 4: Port the lifecycle state machine

**Files:**
- Create: `packages/core/src/lifecycle.ts`
- Test: `packages/core/src/lifecycle.test.ts`

- [ ] **Step 1: Port `SRC/src/lifecycle.ts` → `packages/core/src/lifecycle.ts`** verbatim.
- [ ] **Step 2: Port `SRC/test/lifecycle.test.ts` → `packages/core/src/lifecycle.test.ts`**, adjusting the import to `./lifecycle.js`.
- [ ] **Step 3: Run:** `npm test -w @throng/agent-core -- lifecycle` → Expected: PASS.
- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(core): port lifecycle state machine"
```

---

### Task 5: Define the `EngineAdapter` contract

This is the new seam. It is generic over the engine's resolved-agent payload
`TAgent` and its server config `TConfig`.

**Files:**
- Create: `packages/core/src/engine/adapter.ts`
- Test: `packages/core/src/engine/adapter.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import type { EngineAdapter, ServerHandle } from "./adapter.js";

describe("EngineAdapter contract", () => {
  it("a minimal adapter satisfies the interface", async () => {
    const handle: ServerHandle = { shutdown: async () => {} };
    const adapter: EngineAdapter<{ model: string }, { port: number }> = {
      validateAgent: () => ({ ok: true, agent: { model: "x" } }),
      injectCredentials: () => {},
      buildAgentConfig: () => ({ port: 3030 }),
      createA2AServer: async () => handle,
    };
    const r = adapter.validateAgent({}, {});
    expect(r.ok).toBe(true);
    expect(await adapter.createA2AServer({ port: 3030 })).toBe(handle);
  });
});
```

- [ ] **Step 2: Run:** `npm test -w @throng/agent-core -- adapter` → Expected: FAIL (module not found).

- [ ] **Step 3: Implement `packages/core/src/engine/adapter.ts`**

```ts
import type { Env } from "../env.js";
import type { Manifest } from "../manifest/types.js";
import type { FieldError } from "../manifest/types.js";

/** Minimal handle every engine's A2A server returns. */
export interface ServerHandle {
  shutdown(): Promise<void>;
}

export type AgentResult<TAgent> =
  | { ok: true; agent: TAgent }
  | { ok: false; errors: FieldError[] };

/**
 * The single contract between @throng/agent-core and an engine variant.
 * Core drives the whole init pipeline and calls the adapter only for the
 * engine-specific slices: validating the `agent` block + engine credentials,
 * injecting those credentials, building the engine's server config, and
 * starting the engine's A2A server.
 *
 * TAgent  — the resolved, engine-shaped payload stored on `manifest.agent`.
 * TConfig — the engine server config produced from the manifest.
 */
export interface EngineAdapter<TAgent = unknown, TConfig = unknown> {
  /** Validate + resolve the engine-specific parts of the raw manifest.
   *  Receives the full raw input so it can read `agent` and any engine
   *  credential fields (e.g. anthropic_api_key). Returns typed field errors
   *  that core folds into the 400 response. */
  validateAgent(input: Record<string, unknown>, env: Env): AgentResult<TAgent>;

  /** Inject the engine credential(s) into the process and run engine preflight. */
  injectCredentials(manifest: Manifest<TAgent>): void;

  /** Build the engine server config from the resolved manifest. */
  buildAgentConfig(manifest: Manifest<TAgent>, primaryDest: string): TConfig;

  /** Start the engine's A2A server. */
  createA2AServer(config: TConfig): Promise<ServerHandle>;

  /** Optional: refine the failed boot step (e.g. "plugins") from an error.
   *  Returns undefined to accept core's default ("agent"). */
  classifyBootError?(err: unknown, manifest: Manifest<TAgent>): string | undefined;
}
```

- [ ] **Step 4: Run:** `npm test -w @throng/agent-core -- adapter` → Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(core): define EngineAdapter contract"
```

---

### Task 6: Generic manifest types

**Files:**
- Create: `packages/core/src/manifest/types.ts`

- [ ] **Step 1: Write `packages/core/src/manifest/types.ts`**

```ts
export interface RepoSpec {
  url: string;
  ref: string;
  dest: string;
  primary: boolean;
  token: string | null;
}

export interface FieldError {
  field: string;
  reason: string;
}

/** Engine-agnostic manifest skeleton owned by core. */
export interface BaseManifest {
  repos: RepoSpec[];
  github_token: string | null;
  setup_commands: string[];
  throng_api_token: string | null;
}

/** Full manifest = generic skeleton + the engine's resolved agent payload. */
export interface Manifest<TAgent = unknown> extends BaseManifest {
  agent: TAgent;
}

export type ValidateResult<TAgent = unknown> =
  | { ok: true; manifest: Manifest<TAgent> }
  | { ok: false; errors: FieldError[] };
```

- [ ] **Step 2: Typecheck:** `npm run typecheck -w @throng/agent-core` → Expected: PASS (adapter.ts now resolves its type imports).
- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat(core): add generic manifest types"
```

---

### Task 7: Generic manifest validation (delegates `agent` to the adapter)

Core validates `repos`, `github_token`, `throng_api_token`, `setup_commands`,
and the cross-field repo rules. It hands the raw input to
`adapter.validateAgent` for the engine-specific parts and stores the resolved
payload on `manifest.agent`.

**Files:**
- Create: `packages/core/src/manifest/validate.ts`
- Test: `packages/core/src/manifest/validate.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { validate } from "./validate.js";
import type { EngineAdapter } from "../engine/adapter.js";

// A trivial adapter: requires agent to be an object, echoes it as the payload.
const echoAdapter: Pick<EngineAdapter<Record<string, unknown>>, "validateAgent"> = {
  validateAgent: (input) => {
    if (typeof input.agent !== "object" || input.agent === null) {
      return { ok: false, errors: [{ field: "agent", reason: "is required" }] };
    }
    return { ok: true, agent: input.agent as Record<string, unknown> };
  },
};

const okInput = {
  repos: [{ url: "https://x/y", ref: "main", dest: "y", primary: true }],
  agent: { model: "m" },
};

describe("validate (generic core)", () => {
  it("rejects a non-object manifest", () => {
    const r = validate(42, echoAdapter as EngineAdapter, {});
    expect(r.ok).toBe(false);
  });

  it("requires exactly one primary repo", () => {
    const r = validate(
      { repos: [{ url: "https://x/y", ref: "main", dest: "y", primary: false }], agent: {} },
      echoAdapter as EngineAdapter,
      {},
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "repos[].primary")).toBe(true);
  });

  it("delegates agent validation to the adapter", () => {
    const r = validate({ ...okInput, agent: undefined }, echoAdapter as EngineAdapter, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "agent")).toBe(true);
  });

  it("builds a manifest with the adapter's resolved agent payload", () => {
    const r = validate(okInput, echoAdapter as EngineAdapter, {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.repos[0].primary).toBe(true);
      expect(r.manifest.agent).toEqual({ model: "m" });
    }
  });
});
```

- [ ] **Step 2: Run:** `npm test -w @throng/agent-core -- validate` → Expected: FAIL (module not found).

- [ ] **Step 3: Implement `packages/core/src/manifest/validate.ts`**

Start from `SRC/src/manifest/validate.ts` and make these changes:
1. Add a third parameter `adapter: EngineAdapter` (first param `input`, second `env`, third `adapter`) — signature `validate(input, adapter, env = process.env)`.
2. **Delete** the whole `agent`-block section (the `permission_mode`/`model`/`resolvePlugins` logic) and the `anthropic_api_key` entry from the token loop. Replace with a call to `adapter.validateAgent(input, env)`, pushing its errors on failure and capturing its resolved payload on success.
3. Keep `validateRepos`, the generic token loop (`throng_api_token`, `github_token` only), `setup_commands`, and the cross-field block unchanged.
4. Rewrite `build()` to return the generic `Manifest<unknown>` skeleton plus `agent: <resolved payload>`; drop `plugins` and `anthropic_api_key`.

Full file:

```ts
import type { Env } from "../env.js";
import type { EngineAdapter } from "../engine/adapter.js";
import type { BaseManifest, FieldError, Manifest, RepoSpec, ValidateResult } from "./types.js";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const blankToNil = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v : null;

const nonEmptyString = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? null : "must be a non-empty string";

export function validate<TAgent>(
  input: unknown,
  adapter: EngineAdapter<TAgent>,
  env: Env = process.env,
): ValidateResult<TAgent> {
  if (!isObject(input)) {
    return { ok: false, errors: [{ field: "manifest", reason: "must be a JSON object" }] };
  }
  const errors: FieldError[] = [];

  validateRepos(input.repos, errors);

  // Engine-specific validation (agent block + engine credentials) is delegated.
  const agentResult = adapter.validateAgent(input, env);
  if (!agentResult.ok) errors.push(...agentResult.errors);

  // Generic token fields (type-only). Engine credentials are the adapter's job.
  for (const f of ["throng_api_token", "github_token"]) {
    if (f in input && typeof input[f] !== "string") {
      errors.push({ field: f, reason: "must be a string" });
    }
  }

  if ("setup_commands" in input) {
    const list = input.setup_commands;
    if (!Array.isArray(list)) {
      errors.push({ field: "setup_commands", reason: "must be a list of strings" });
    } else if (!list.every((c) => typeof c === "string" && c.trim() !== "")) {
      errors.push({ field: "setup_commands", reason: "each entry must be a non-empty string" });
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  // Cross-field rules run only after all per-field checks pass.
  const repos = input.repos as Array<Record<string, unknown>>;
  const cross: FieldError[] = [];
  const primaries = repos.filter((r) => r.primary === true).length;
  if (primaries !== 1) {
    cross.push({
      field: "repos[].primary",
      reason: `exactly one repo must be marked primary: true (got ${primaries})`,
    });
  }
  const dests = repos.map((r) => r.dest);
  if (new Set(dests).size !== dests.length) {
    cross.push({ field: "repos[].dest", reason: "dest values must be unique across repos" });
  }
  if (cross.length > 0) return { ok: false, errors: cross };

  // agentResult is ok here (errors would have returned above).
  const agent = (agentResult as { ok: true; agent: TAgent }).agent;
  return { ok: true, manifest: buildManifest(input, repos, env, agent) };
}

function validateRepos(value: unknown, errors: FieldError[]): void {
  if (value === undefined) {
    errors.push({ field: "repos", reason: "is required" });
    return;
  }
  if (!Array.isArray(value)) {
    errors.push({ field: "repos", reason: "must be a list" });
    return;
  }
  if (value.length === 0) {
    errors.push({ field: "repos", reason: "must contain at least one entry" });
    return;
  }
  value.forEach((repo, i) => {
    if (!isObject(repo)) {
      errors.push({ field: `repos[${i}]`, reason: "must be an object" });
      return;
    }
    const url = repo.url;
    if (typeof url !== "string" || !url.startsWith("https://")) {
      errors.push({ field: `repos[${i}].url`, reason: "must start with https://" });
    }
    if (nonEmptyString(repo.ref)) errors.push({ field: `repos[${i}].ref`, reason: "must be a non-empty string" });
    const dest = repo.dest;
    if (typeof dest !== "string" || dest.trim() === "") {
      errors.push({ field: `repos[${i}].dest`, reason: "must be a non-empty relative path string" });
    } else if (dest.startsWith("/")) {
      errors.push({ field: `repos[${i}].dest`, reason: "must be a relative path (absolute paths are rejected)" });
    } else if (dest.split("/").includes("..")) {
      errors.push({ field: `repos[${i}].dest`, reason: "must not contain '..' path segments" });
    }
    if (typeof repo.primary !== "boolean") {
      errors.push({ field: `repos[${i}].primary`, reason: "must be a boolean" });
    }
    if ("token" in repo && typeof repo.token !== "string") {
      errors.push({ field: `repos[${i}].token`, reason: "must be a string" });
    }
  });
}

function buildManifest<TAgent>(
  input: Record<string, unknown>,
  repos: Array<Record<string, unknown>>,
  env: Env,
  agent: TAgent,
): Manifest<TAgent> {
  const defaultToken = blankToNil(input.github_token) ?? blankToNil(env.GITHUB_TOKEN);
  const specs: RepoSpec[] = repos.map((r) => ({
    url: r.url as string,
    ref: r.ref as string,
    dest: r.dest as string,
    primary: r.primary as boolean,
    token: blankToNil(r.token) ?? defaultToken,
  }));
  const base: BaseManifest = {
    repos: specs,
    github_token: defaultToken,
    setup_commands: (input.setup_commands as string[] | undefined) ?? [],
    throng_api_token: blankToNil(input.throng_api_token) ?? blankToNil(env.THRONG_API_TOKEN),
  };
  return { ...base, agent };
}
```

- [ ] **Step 4: Run:** `npm test -w @throng/agent-core -- validate` → Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(core): generic manifest validation delegating agent to adapter"
```

---

### Task 8: Boot orchestration (`TaskRun` over `BootDeps` + adapter)

Core keeps the generic boot steps (clone → checkout → setup → inject git creds
→ build → serve) and delegates the engine steps to the adapter. Engine-specific
concerns (Anthropic key injection, settings guard, plugin-failure step naming)
leave core entirely.

**Files:**
- Create: `packages/core/src/task-run.ts`
- Test: `packages/core/src/task-run.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { TaskRun, type BootDeps } from "./task-run.js";
import type { EngineAdapter, ServerHandle } from "./engine/adapter.js";

const handle: ServerHandle = { shutdown: vi.fn(async () => {}) };

function deps(over: Partial<BootDeps> = {}): BootDeps {
  return {
    clone: vi.fn(async () => ({ ok: true, output: "" })),
    checkout: vi.fn(async () => ({ ok: true, output: "" })),
    runSetupCommands: vi.fn(async () => ({ ok: true })),
    injectGitCredentials: vi.fn(() => {}),
    workspaceRoot: "/workspace",
    ...over,
  };
}

function adapter(over: Partial<EngineAdapter> = {}): EngineAdapter {
  return {
    validateAgent: () => ({ ok: true, agent: {} }),
    injectCredentials: vi.fn(() => {}),
    buildAgentConfig: vi.fn(() => ({})),
    createA2AServer: vi.fn(async () => handle),
    ...over,
  };
}

const okPayload = {
  repos: [{ url: "https://x/y", ref: "main", dest: "y", primary: true }],
  agent: {},
};

async function settle() {
  await new Promise((r) => setTimeout(r, 0));
}

describe("TaskRun", () => {
  it("rejects a second initialise", async () => {
    const tr = new TaskRun(deps(), adapter());
    await tr.initialise(okPayload);
    const second = await tr.initialise(okPayload);
    expect(second.ok).toBe(false);
    if (!second.ok) expect("already" in second && second.already).toBe(true);
  });

  it("returns 202 booting on a valid manifest and reaches ready", async () => {
    const a = adapter();
    const tr = new TaskRun(deps(), a);
    const r = await tr.initialise(okPayload);
    expect(r).toEqual({ ok: true, status: "booting" });
    await settle();
    expect(tr.lifecycle.status().state).toBe("ready");
    expect(a.createA2AServer).toHaveBeenCalledOnce();
  });

  it("fails with the adapter-classified step on server start error", async () => {
    const a = adapter({
      createA2AServer: async () => { throw new Error("plugin did not load"); },
      classifyBootError: () => "plugins",
    });
    const tr = new TaskRun(deps(), a);
    await tr.initialise(okPayload);
    await settle();
    const status = tr.lifecycle.status();
    expect(status.state).toBe("failed");
    expect(status.error?.step).toBe("plugins");
  });
});
```

- [ ] **Step 2: Run:** `npm test -w @throng/agent-core -- task-run` → Expected: FAIL (module not found).

- [ ] **Step 3: Implement `packages/core/src/task-run.ts`**

Adapt from `SRC/src/task-run.ts`, applying: `TaskRunDeps` → generic `BootDeps`
(drop the engine members), `TaskRun` becomes generic and takes `adapter` as a
second constructor arg, `validate` is called with the adapter, the credential /
plugin blocks in `boot()` are replaced by `adapter.injectCredentials` and
`adapter.classifyBootError`.

```ts
import { join } from "node:path";
import type { GitResult } from "./bootstrap/git.js";
import type { SetupResult } from "./bootstrap/setup.js";
import type { EngineAdapter, ServerHandle } from "./engine/adapter.js";
import { Lifecycle } from "./lifecycle.js";
import { log } from "./log.js";
import type { FieldError, Manifest } from "./manifest/types.js";
import { validate } from "./manifest/validate.js";

/** Engine-agnostic boot dependencies. */
export interface BootDeps {
  clone: (url: string, dest: string, token: string | null) => Promise<GitResult>;
  checkout: (dest: string, ref: string) => Promise<GitResult>;
  runSetupCommands: (cwd: string, commands: string[]) => Promise<SetupResult>;
  injectGitCredentials: (token: string | null) => void;
  workspaceRoot: string;
}

export type InitialiseResult =
  | { ok: true; status: "booting" }
  | { ok: false; already: true }
  | { ok: false; errors: FieldError[] };

export class TaskRun<TAgent = unknown, TConfig = unknown> {
  readonly lifecycle = new Lifecycle();
  private serverHandle?: ServerHandle;

  constructor(
    private readonly deps: BootDeps,
    private readonly adapter: EngineAdapter<TAgent, TConfig>,
  ) {}

  async initialise(payload: unknown): Promise<InitialiseResult> {
    if (this.lifecycle.state !== "uninitialised") {
      log.warn("initialise rejected: already initialised", { state: this.lifecycle.state });
      return { ok: false, already: true };
    }

    const result = validate<TAgent>(payload, this.adapter);
    if (!result.ok) {
      log.warn("initialise rejected: manifest validation failed", {
        errors: result.errors.map((e) => e.field),
      });
      return { ok: false, errors: result.errors };
    }

    this.lifecycle.set("booting");
    log.info("initialise accepted; booting asynchronously", {
      repos: result.manifest.repos.length,
      setupCommands: result.manifest.setup_commands.length,
    });
    void this.boot(result.manifest);
    return { ok: true, status: "booting" };
  }

  private async boot(manifest: Manifest<TAgent>): Promise<void> {
    try {
      this.lifecycle.set("cloning");
      log.info("boot step: cloning repos", { count: manifest.repos.length, workspace: this.deps.workspaceRoot });
      let primaryDest = "";
      for (const repo of manifest.repos) {
        const dest = join(this.deps.workspaceRoot, repo.dest);
        log.info("cloning repo", { url: repo.url, ref: repo.ref, dest, primary: repo.primary, authenticated: repo.token !== null });
        const cloned = await this.deps.clone(repo.url, dest, repo.token);
        if (!cloned.ok) {
          throw new StepError("cloning", `git clone failed for ${repo.dest} (exit ${cloned.code}): ${cloned.output.trim()}`);
        }
        const checked = await this.deps.checkout(dest, repo.ref);
        if (!checked.ok) {
          throw new StepError("cloning", `git checkout ${repo.ref} failed for ${repo.dest}: ${checked.output.trim()}`);
        }
        log.info("repo ready", { dest, ref: repo.ref });
        if (repo.primary) primaryDest = dest;
      }

      this.lifecycle.set("setup");
      log.info("boot step: running setup commands", { count: manifest.setup_commands.length, cwd: primaryDest });
      const setup = await this.deps.runSetupCommands(primaryDest, manifest.setup_commands);
      if (!setup.ok) {
        throw new StepError("setup", `setup command failed: ${setup.command} (exit ${setup.code})`);
      }

      log.info("boot step: injecting credentials and building agent config");
      this.adapter.injectCredentials(manifest);
      // The GitHub token reaches git subprocesses (incl. any the engine spawns).
      this.deps.injectGitCredentials(manifest.github_token);

      const config = this.adapter.buildAgentConfig(manifest, primaryDest);
      log.info("boot step: starting A2A server", { workingDirectory: primaryDest });
      try {
        this.serverHandle = await this.adapter.createA2AServer(config);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const step = this.adapter.classifyBootError?.(err, manifest) ?? "agent";
        throw new StepError(step, message);
      }
      this.lifecycle.set("ready");
      log.info("boot complete; agent is ready");
    } catch (err) {
      const detail =
        err instanceof StepError
          ? { step: err.step, message: err.message }
          : { step: "boot", message: err instanceof Error ? err.message : String(err) };
      this.lifecycle.fail(detail);
      log.error("boot failed", { step: detail.step, message: detail.message });
      if (!(err instanceof StepError) && err instanceof Error && err.stack) {
        log.error("boot failure stack", { stack: err.stack });
      }
    }
  }

  async shutdown(): Promise<void> {
    await this.serverHandle?.shutdown();
  }
}

class StepError extends Error {
  constructor(readonly step: string, message: string) {
    super(message);
  }
}
```

- [ ] **Step 4: Run:** `npm test -w @throng/agent-core -- task-run` → Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(core): boot orchestration over BootDeps + EngineAdapter"
```

---

### Task 9: Control server + `startControlServer` entrypoint

Core owns the whole HTTP surface. `createControlApp` takes a `TaskRun`;
`startControlServer(adapter)` wires generic `BootDeps` from env, builds the app,
and listens — the variant entrypoint is a one-liner.

**Files:**
- Create: `packages/core/src/control/server.ts`
- Test: `packages/core/src/control/server.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createControlApp } from "./server.js";
import { TaskRun, type BootDeps } from "../task-run.js";
import type { EngineAdapter, ServerHandle } from "../engine/adapter.js";

const handle: ServerHandle = { shutdown: async () => {} };
const bootDeps: BootDeps = {
  clone: async () => ({ ok: true, output: "" }),
  checkout: async () => ({ ok: true, output: "" }),
  runSetupCommands: async () => ({ ok: true }),
  injectGitCredentials: () => {},
  workspaceRoot: "/workspace",
};
const adapter: EngineAdapter = {
  validateAgent: (input) =>
    typeof input.agent === "object" && input.agent !== null
      ? { ok: true, agent: input.agent }
      : { ok: false, errors: [{ field: "agent", reason: "is required" }] },
  injectCredentials: () => {},
  buildAgentConfig: () => ({}),
  createA2AServer: async () => handle,
};

const app = () => createControlApp({ taskRun: new TaskRun(bootDeps, adapter) });

describe("control server", () => {
  it("GET /healthz → ok", async () => {
    const res = await request(app()).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("GET /api/status → uninitialised", async () => {
    const res = await request(app()).get("/api/status");
    expect(res.body.state).toBe("uninitialised");
  });

  it("POST /api/initialise with bad manifest → 400 field errors", async () => {
    const res = await request(app()).post("/api/initialise").send({ repos: [] });
    expect(res.status).toBe(400);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("POST /api/initialise valid → 202 booting", async () => {
    const res = await request(app())
      .post("/api/initialise")
      .send({ repos: [{ url: "https://x/y", ref: "main", dest: "y", primary: true }], agent: {} });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: "booting" });
  });

  it("rejects unauthorized when THRONG_INIT_TOKEN set", async () => {
    const prev = process.env.THRONG_INIT_TOKEN;
    process.env.THRONG_INIT_TOKEN = "secret";
    try {
      const res = await request(app()).post("/api/initialise").send({ agent: {} });
      expect(res.status).toBe(401);
    } finally {
      process.env.THRONG_INIT_TOKEN = prev;
    }
  });
});
```

- [ ] **Step 2: Run:** `npm test -w @throng/agent-core -- control/server` → Expected: FAIL.

- [ ] **Step 3: Implement `packages/core/src/control/server.ts`**

Port the Express app from `SRC/src/control/server.ts` verbatim, then add
`startControlServer` + `main`-style listen. The `ControlAppOptions` change: it
now takes a required `taskRun` (constructed by the caller with its adapter).

```ts
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { clone, checkout } from "../bootstrap/git.js";
import { runSetupCommands } from "../bootstrap/setup.js";
import { injectGitCredentials } from "../bootstrap/git-credentials.js";
import type { EngineAdapter } from "../engine/adapter.js";
import { log } from "../log.js";
import { TaskRun, type BootDeps } from "../task-run.js";
import { checkInitToken } from "./init-token.js";

export interface ControlAppOptions {
  taskRun: TaskRun;
}

export function createControlApp(opts: ControlAppOptions): Express {
  const taskRun = opts.taskRun;
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/api/status", (_req, res) => {
    res.json(taskRun.lifecycle.status());
  });

  app.post("/api/initialise", async (req, res) => {
    log.info("POST /api/initialise received");
    if (!checkInitToken(process.env.THRONG_INIT_TOKEN, req.headers.authorization)) {
      log.warn("POST /api/initialise rejected: unauthorized (bad or missing THRONG_INIT_TOKEN)");
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const result = await taskRun.initialise(req.body);
    if (result.ok) {
      res.status(202).json({ status: result.status });
    } else if ("already" in result) {
      res.status(409).json({ error: "already_initialised" });
    } else {
      res.status(400).json(result.errors);
    }
  });

  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof SyntaxError && "body" in (err as object)) {
      res.status(400).json([{ field: "manifest", reason: "invalid JSON body" }]);
      return;
    }
    next(err);
  });

  return app;
}

/** Generic boot deps assembled from the environment. */
export function defaultBootDeps(): BootDeps {
  return {
    clone,
    checkout,
    runSetupCommands,
    injectGitCredentials,
    workspaceRoot: process.env.WORKSPACE_DIR ?? "/workspace",
  };
}

export function buildServer<TAgent, TConfig>(adapter: EngineAdapter<TAgent, TConfig>): Express {
  return createControlApp({ taskRun: new TaskRun(defaultBootDeps(), adapter) });
}

/** The variant entrypoint: `startControlServer(new MyEngineAdapter())`. */
export function startControlServer<TAgent, TConfig>(adapter: EngineAdapter<TAgent, TConfig>): void {
  const port = Number(process.env.CONTROL_PORT ?? 8080);
  const app = buildServer(adapter);
  app.listen(port, "0.0.0.0", () => {
    log.info("control server listening", { port });
  });
}
```

Note: this references `../bootstrap/git-credentials.js` (`injectGitCredentials`).
Create it in the next step.

- [ ] **Step 4: Create `packages/core/src/bootstrap/git-credentials.ts`**

Extract the generic `injectGitCredentials` from `SRC/src/config/credentials.ts`
(it depends only on `ASKPASS` from `git.ts`):

```ts
import { ASKPASS } from "./git.js";

/**
 * Exposes the GitHub token to git subprocesses (repo clones pass askpass env
 * per-invocation, but subprocesses an engine spawns inherit this process's
 * environment). The token stays in env; askpass.sh holds no secret.
 */
export function injectGitCredentials(token: string | null): void {
  if (!token) return;
  process.env.GIT_ASKPASS = ASKPASS;
  process.env.GIT_ASKPASS_USERNAME = "x-access-token";
  process.env.GIT_ASKPASS_TOKEN = token;
  process.env.GIT_TERMINAL_PROMPT = "0";
}
```

- [ ] **Step 5: Run:** `npm test -w @throng/agent-core -- control/server` → Expected: PASS.
- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(core): control server + startControlServer entrypoint"
```

---

### Task 10: Core public exports

**Files:**
- Create: `packages/core/src/index.ts`

- [ ] **Step 1: Write `packages/core/src/index.ts`**

```ts
export { startControlServer, buildServer, createControlApp, defaultBootDeps } from "./control/server.js";
export { TaskRun, type BootDeps, type InitialiseResult } from "./task-run.js";
export { Lifecycle, type LifecycleState, type StatusView, type FailureDetail } from "./lifecycle.js";
export { validate } from "./manifest/validate.js";
export type {
  RepoSpec,
  FieldError,
  BaseManifest,
  Manifest,
  ValidateResult,
} from "./manifest/types.js";
export type { EngineAdapter, ServerHandle, AgentResult } from "./engine/adapter.js";
export type { Env } from "./env.js";
export { clone, checkout, type GitResult, ASKPASS } from "./bootstrap/git.js";
export { runSetupCommands, type SetupResult } from "./bootstrap/setup.js";
export { injectGitCredentials } from "./bootstrap/git-credentials.js";
export { checkInitToken } from "./control/init-token.js";
export { log } from "./log.js";
```

- [ ] **Step 2: Build:** `npm run build -w @throng/agent-core` → Expected: compiles, emits `dist/` with `askpass.sh` copied.
- [ ] **Step 3: Full core test run:** `npm test -w @throng/agent-core` → Expected: all suites PASS.
- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(core): public package exports; core builds green"
```

---

## Phase 2 — `throng-agent-claude` (parity)

### Task 11: Claude variant package skeleton

**Files:**
- Create: `throng-agent-claude/package.json`, `throng-agent-claude/tsconfig.json`,
  `throng-agent-claude/vitest.config.ts`, `throng-agent-claude/.npmrc`

- [ ] **Step 1: Write `throng-agent-claude/package.json`**

```json
{
  "name": "throng-agent-claude",
  "version": "0.2.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit",
    "test": "vitest --run"
  },
  "dependencies": {
    "@throng/agent-core": "0.1.0",
    "@col/a2a-claude": "0.2.0",
    "express": "^4.18.2"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^20.10.0",
    "@types/supertest": "^7.2.0",
    "supertest": "^7.2.2",
    "typescript": "^5.3.0",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 2: Write `throng-agent-claude/tsconfig.json`**

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "src/**/*.test.ts", "src/**/__tests__/**"]
}
```

- [ ] **Step 3: Write `throng-agent-claude/vitest.config.ts`** (same as core's).
- [ ] **Step 4: Copy `.npmrc`:** `cp SRC/.npmrc throng-agent-claude/.npmrc`.
- [ ] **Step 5: Install + commit**

```bash
cd /Users/col/projects/throng_platform/throng_agent && npm install
git add -A && git commit -m "chore(claude): add throng-agent-claude package skeleton"
```

Expected: workspace resolves `@throng/agent-core` to the local package.

---

### Task 12: Port Claude plugin resolution

`config/plugins.ts` is Claude Code-specific and moves into the variant unchanged
except its `FieldError` import now comes from core.

**Files:**
- Create: `throng-agent-claude/src/config/plugins.ts`
- Test: `throng-agent-claude/src/config/plugins.test.ts`

- [ ] **Step 1: Port `SRC/src/config/plugins.ts`** → target path. Change the import
  `import type { FieldError } from "../manifest/types.js";` to
  `import type { FieldError } from "@throng/agent-core";`. Everything else verbatim.
- [ ] **Step 2: Port `SRC/test/config/plugins.test.ts`** → `throng-agent-claude/src/config/plugins.test.ts`, adjusting the import of the module-under-test to `./plugins.js`.
- [ ] **Step 3: Run:** `npm test -w throng-agent-claude -- plugins` → Expected: PASS.
- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(claude): port plugin/marketplace resolution"
```

---

### Task 13: Port Claude credentials (Anthropic key + settings guard)

`injectGitCredentials` already lives in core; only the Anthropic-specific pieces
move here.

**Files:**
- Create: `throng-agent-claude/src/config/credentials.ts`
- Test: `throng-agent-claude/src/config/credentials.test.ts`

- [ ] **Step 1: Write `throng-agent-claude/src/config/credentials.ts`**

Take `SRC/src/config/credentials.ts` and remove `injectGitCredentials` (now in
core) and its `ASKPASS` import. Keep `injectAnthropicKey` and
`assertNoAnthropicKeyInSettings` verbatim:

```ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Sets ANTHROPIC_API_KEY in-process (once per sandbox). No-op when key is null. */
export function injectAnthropicKey(key: string | null): void {
  if (key) process.env.ANTHROPIC_API_KEY = key;
}

/**
 * Guards against ~/.claude/settings.json pinning env.ANTHROPIC_API_KEY, which
 * the SDK would give precedence over our per-process key. Absent/unreadable/
 * unparseable settings are treated as fine.
 */
export function assertNoAnthropicKeyInSettings(
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
  if (env && env.ANTHROPIC_API_KEY) {
    throw new Error(
      `${settingsPath} sets env.ANTHROPIC_API_KEY, which overrides the per-process key. Remove it.`,
    );
  }
}
```

- [ ] **Step 2: Port `SRC/test/config/credentials.test.ts`** → target, dropping any
  `injectGitCredentials` cases (those now belong to core; if present, move them to
  a core `git-credentials` test in a follow-up — do **not** delete coverage
  silently, note it in the commit body). Adjust the import to `./credentials.js`.
- [ ] **Step 3: Run:** `npm test -w throng-agent-claude -- credentials` → Expected: PASS.
- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(claude): port Anthropic key injection + settings guard"
```

---

### Task 14: Claude agent-block validation

Extract the Claude-specific `agent` validation that used to live inside core's
`validate()` into a variant function returning a resolved payload.

**Files:**
- Create: `throng-agent-claude/src/manifest/claude-agent.ts`
- Test: `throng-agent-claude/src/manifest/claude-agent.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { validateClaudeAgent } from "./claude-agent.js";

describe("validateClaudeAgent", () => {
  it("requires the agent block", () => {
    const r = validateClaudeAgent({}, {});
    expect(r.ok).toBe(false);
  });

  it("rejects an unknown permission mode", () => {
    const r = validateClaudeAgent({ agent: { permission_mode: "nope" } }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "agent.permission_mode")).toBe(true);
  });

  it("resolves anthropic_api_key from env when absent", () => {
    const r = validateClaudeAgent({ agent: {} }, { ANTHROPIC_API_KEY: "sk-env" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent.anthropic_api_key).toBe("sk-env");
  });

  it("resolves plugins into channels", () => {
    const r = validateClaudeAgent(
      { agent: { plugins: [{ path: "/opt/p" }] }, anthropic_api_key: "sk" },
      {},
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent.plugins.local).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run:** `npm test -w throng-agent-claude -- claude-agent` → Expected: FAIL.

- [ ] **Step 3: Implement `throng-agent-claude/src/manifest/claude-agent.ts`**

Move the `agent`-block logic deleted from core's `validate()` here, plus resolve
`anthropic_api_key`. The resolved payload is the Claude-shaped `agent` used by
`buildAgentConfig`.

```ts
import type { AgentResult, Env, FieldError } from "@throng/agent-core";
import { EMPTY_PLUGINS, resolvePlugins, type ResolvedPlugins } from "../config/plugins.js";

const PERMISSION_MODES = new Set(["acceptEdits", "dontAsk", "plan", "bypassPermissions"]);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const blankToNil = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v : null;

/** The resolved, Claude-shaped agent payload stored on `manifest.agent`. */
export interface ResolvedClaudeAgent {
  /** Raw agent keys (model, tools, system prompts, max_turns, permission_mode). */
  keys: Record<string, unknown>;
  plugins: ResolvedPlugins;
  anthropic_api_key: string | null;
}

export function validateClaudeAgent(
  input: Record<string, unknown>,
  env: Env,
): AgentResult<ResolvedClaudeAgent> {
  const errors: FieldError[] = [];
  let plugins: ResolvedPlugins = EMPTY_PLUGINS;

  if (!("agent" in input)) {
    errors.push({ field: "agent", reason: "is required" });
  } else if (!isObject(input.agent)) {
    errors.push({ field: "agent", reason: "must be an object" });
  } else {
    const a = input.agent;
    if ("permission_mode" in a && !PERMISSION_MODES.has(a.permission_mode as string)) {
      errors.push({
        field: "agent.permission_mode",
        reason: "must be one of acceptEdits/dontAsk/plan/bypassPermissions",
      });
    }
    if ("model" in a && typeof a.model !== "string") {
      errors.push({ field: "agent.model", reason: "must be a string" });
    }
    const resolution = resolvePlugins(a.plugins);
    if (resolution.ok) plugins = resolution.resolved;
    else errors.push(...resolution.errors);
  }

  if ("anthropic_api_key" in input && typeof input.anthropic_api_key !== "string") {
    errors.push({ field: "anthropic_api_key", reason: "must be a string" });
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    agent: {
      keys: (input.agent as Record<string, unknown>) ?? {},
      plugins,
      anthropic_api_key: blankToNil(input.anthropic_api_key) ?? blankToNil(env.ANTHROPIC_API_KEY),
    },
  };
}
```

- [ ] **Step 4: Run:** `npm test -w throng-agent-claude -- claude-agent` → Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(claude): Claude agent-block validation + credential resolution"
```

---

### Task 15: Port `buildAgentConfig` (now reading the resolved payload)

**Files:**
- Create: `throng-agent-claude/src/config/build.ts`
- Test: `throng-agent-claude/src/config/build.test.ts`

- [ ] **Step 1: Implement `throng-agent-claude/src/config/build.ts`**

Adapt `SRC/src/config/build.ts`: its input is now `Manifest<ResolvedClaudeAgent>`.
Read agent keys from `manifest.agent.keys`, plugins from `manifest.agent.plugins`.
The header comment and the `resolveConfig`/`server` block stay identical.

```ts
import { resolveConfig, type AgentConfig, type ClaudePermissionMode } from "@col/a2a-claude";
import type { Manifest } from "@throng/agent-core";
import type { ResolvedClaudeAgent } from "../manifest/claude-agent.js";

export function buildAgentConfig(
  manifest: Manifest<ResolvedClaudeAgent>,
  workingDirectory: string,
): Required<AgentConfig> {
  const a = manifest.agent.keys;
  const claude: NonNullable<AgentConfig["claude"]> = {
    workingDirectory,
    settingSources: ["project"],
  };

  if (typeof a.model === "string") claude.model = { name: a.model };
  if (typeof a.permission_mode === "string") {
    claude.permissionMode = a.permission_mode as ClaudePermissionMode;
    if (a.permission_mode === "bypassPermissions") claude.dangerouslyAllowBypassPermissions = true;
  }
  const { local, marketplaces, enabledPlugins } = manifest.agent.plugins;
  if (local.length > 0) claude.plugins = local;
  if (Object.keys(marketplaces).length > 0) {
    claude.marketplaces = marketplaces;
    claude.enabledPlugins = enabledPlugins;
  }

  if (typeof a.system_prompt_append === "string") claude.systemPromptAppend = a.system_prompt_append;
  if (typeof a.custom_system_prompt === "string") claude.customSystemPrompt = a.custom_system_prompt;
  if (Array.isArray(a.allowed_tools)) claude.allowedTools = a.allowed_tools as string[];
  if (Array.isArray(a.disallowed_tools)) claude.disallowedTools = a.disallowed_tools as string[];
  if (typeof a.max_turns === "number") claude.maxTurns = a.max_turns;

  const overrides: Partial<AgentConfig> = {
    agentCard: {
      name: "Throng Agent A2A Claude",
      description: "Throng-controlled, Claude-Code-backed A2A agent.",
    },
    server: {
      hostname: "0.0.0.0",
      port: Number(process.env.A2A_PORT ?? 3030),
      advertiseHost: process.env.ADVERTISE_HOST ?? "localhost",
      advertiseProtocol: (process.env.ADVERTISE_PROTOCOL ?? "https") as "http" | "https",
    },
    claude,
  };

  return resolveConfig(undefined, overrides);
}
```

- [ ] **Step 2: Port `SRC/test/config/build.test.ts`** → target. Update every place
  that built a `Manifest` to use the new shape: agent keys under
  `agent.keys`, plugins under `agent.plugins`, and `anthropic_api_key` under
  `agent.anthropic_api_key`. Import `Manifest` from `@throng/agent-core` and
  `buildAgentConfig` from `./build.js`.
- [ ] **Step 3: Run:** `npm test -w throng-agent-claude -- build` → Expected: PASS.
- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(claude): buildAgentConfig over resolved Claude payload"
```

---

### Task 16: `ClaudeEngineAdapter`

Ties the variant together and implements the core contract.

**Files:**
- Create: `throng-agent-claude/src/adapter.ts`
- Test: `throng-agent-claude/src/adapter.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { ClaudeEngineAdapter } from "./adapter.js";
import type { Manifest } from "@throng/agent-core";
import type { ResolvedClaudeAgent } from "./manifest/claude-agent.js";

describe("ClaudeEngineAdapter", () => {
  it("validateAgent rejects a missing agent block", () => {
    const a = new ClaudeEngineAdapter();
    expect(a.validateAgent({}, {}).ok).toBe(false);
  });

  it("classifyBootError names plugins when a marketplace is configured", () => {
    const a = new ClaudeEngineAdapter();
    const manifest = {
      agent: { plugins: { local: [], marketplaces: { m: {} }, enabledPlugins: {}, unpinned: [] } },
    } as unknown as Manifest<ResolvedClaudeAgent>;
    expect(a.classifyBootError(new Error("plugin did not load"), manifest)).toBe("plugins");
    expect(a.classifyBootError(new Error("something else"), manifest)).toBe(undefined);
  });

  it("injectCredentials sets ANTHROPIC_API_KEY", () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const a = new ClaudeEngineAdapter();
      a.injectCredentials({
        agent: { keys: {}, plugins: { local: [], marketplaces: {}, enabledPlugins: {}, unpinned: [] }, anthropic_api_key: "sk-x" },
      } as unknown as Manifest<ResolvedClaudeAgent>);
      expect(process.env.ANTHROPIC_API_KEY).toBe("sk-x");
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});
```

- [ ] **Step 2: Run:** `npm test -w throng-agent-claude -- adapter` → Expected: FAIL.

- [ ] **Step 3: Implement `throng-agent-claude/src/adapter.ts`**

```ts
import { createA2AServer, type AgentConfig, type ServerHandle as ClaudeServerHandle } from "@col/a2a-claude";
import type { AgentResult, EngineAdapter, Env, Manifest, ServerHandle } from "@throng/agent-core";
import { log } from "@throng/agent-core";
import { buildAgentConfig } from "./config/build.js";
import { assertNoAnthropicKeyInSettings, injectAnthropicKey } from "./config/credentials.js";
import { validateClaudeAgent, type ResolvedClaudeAgent } from "./manifest/claude-agent.js";

// Message shapes owned by a2a-claude's plugin preflight; a miss only coarsens
// the reported step, never a wrong success.
const PLUGIN_FAILURE = /did not load|plugin preflight/i;

export class ClaudeEngineAdapter
  implements EngineAdapter<ResolvedClaudeAgent, Required<AgentConfig>>
{
  validateAgent(input: Record<string, unknown>, env: Env): AgentResult<ResolvedClaudeAgent> {
    return validateClaudeAgent(input, env);
  }

  injectCredentials(manifest: Manifest<ResolvedClaudeAgent>): void {
    assertNoAnthropicKeyInSettings();
    injectAnthropicKey(manifest.agent.anthropic_api_key);
    if (manifest.agent.anthropic_api_key === null) {
      log.warn("no anthropic_api_key in manifest; agent requests will fail unless another auth path is configured");
    }
    const { marketplaces, local, unpinned, enabledPlugins } = manifest.agent.plugins;
    const marketplaceCount = Object.keys(marketplaces).length;
    if (marketplaceCount > 0 || local.length > 0) {
      log.info("plugins configured", {
        marketplaces: marketplaceCount,
        marketplacePlugins: Object.keys(enabledPlugins).length,
        localPlugins: local.length,
      });
    }
    if (unpinned.length > 0) {
      log.warn("marketplace plugins are unpinned; pin each marketplace with a branch or tag ref for reproducible runs", {
        plugins: unpinned,
      });
    }
  }

  buildAgentConfig(manifest: Manifest<ResolvedClaudeAgent>, primaryDest: string): Required<AgentConfig> {
    return buildAgentConfig(manifest, primaryDest);
  }

  async createA2AServer(config: Required<AgentConfig>): Promise<ServerHandle> {
    const handle: ClaudeServerHandle = await createA2AServer(config);
    return handle;
  }

  classifyBootError(err: unknown, manifest: Manifest<ResolvedClaudeAgent>): string | undefined {
    const message = err instanceof Error ? err.message : String(err);
    const hasMarketplaces = Object.keys(manifest.agent.plugins.marketplaces).length > 0;
    return hasMarketplaces && PLUGIN_FAILURE.test(message) ? "plugins" : undefined;
  }
}
```

- [ ] **Step 4: Run:** `npm test -w throng-agent-claude -- adapter` → Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(claude): ClaudeEngineAdapter implementing the core contract"
```

---

### Task 17: Variant entrypoint + Docker

**Files:**
- Create: `throng-agent-claude/src/index.ts`, `throng-agent-claude/Dockerfile`,
  `throng-agent-claude/.dockerignore`
- Test: `throng-agent-claude/src/index.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { buildServer } from "@throng/agent-core";
import { ClaudeEngineAdapter } from "./adapter.js";

describe("claude entrypoint", () => {
  it("buildServer with the Claude adapter yields an app that answers /healthz-shaped wiring", () => {
    const app = buildServer(new ClaudeEngineAdapter());
    expect(typeof app.listen).toBe("function");
  });
});
```

- [ ] **Step 2: Run:** `npm test -w throng-agent-claude -- index` → Expected: FAIL (index.ts missing).

- [ ] **Step 3: Write `throng-agent-claude/src/index.ts`**

```ts
import { startControlServer } from "@throng/agent-core";
import { ClaudeEngineAdapter } from "./adapter.js";

startControlServer(new ClaudeEngineAdapter());
```

- [ ] **Step 4: Write `throng-agent-claude/Dockerfile`**

Port `SRC/Dockerfile`, updating the build stage for the monorepo: the image is
built from the repo root context so it can install the workspace and build both
`@throng/agent-core` and this package. Replace the build stage with:

```dockerfile
# syntax=docker/dockerfile:1

# --- Build stage -------------------------------------------------------------
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json turbo.json tsconfig.base.json .npmrc ./
COPY packages/core/package.json ./packages/core/package.json
COPY throng-agent-claude/package.json ./throng-agent-claude/package.json
RUN --mount=type=secret,id=github_token \
    GITHUB_TOKEN="$(cat /run/secrets/github_token)" npm ci
COPY packages/core ./packages/core
COPY throng-agent-claude ./throng-agent-claude
RUN npm run build -w @throng/agent-core \
 && npm run build -w throng-agent-claude \
 && npm prune --omit=dev

# --- Runtime stage -----------------------------------------------------------
FROM node:20-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates git build-essential gpg wget \
 && install -dm 755 /etc/apt/keyrings \
 && wget -qO - https://mise.jdx.dev/gpg-key.pub \
      | gpg --dearmor -o /etc/apt/keyrings/mise-archive-keyring.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/mise-archive-keyring.gpg arch=$(dpkg --print-architecture)] https://mise.jdx.dev/deb stable main" \
      > /etc/apt/sources.list.d/mise.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends mise \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/core/package.json ./packages/core/package.json
COPY --from=build /app/throng-agent-claude/dist ./throng-agent-claude/dist
COPY --from=build /app/throng-agent-claude/package.json ./throng-agent-claude/package.json
ENV CONTROL_PORT=8080
EXPOSE 8080 3030
CMD ["node", "throng-agent-claude/dist/index.js"]
```

- [ ] **Step 5: Copy `.dockerignore`:** `cp SRC/.dockerignore throng-agent-claude/.dockerignore`.
- [ ] **Step 6: Run:** `npm test -w throng-agent-claude -- index` → Expected: PASS.
- [ ] **Step 7: Build + full variant test:** `npm run build -w throng-agent-claude && npm test -w throng-agent-claude` → Expected: PASS.
- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat(claude): entrypoint + monorepo Dockerfile"
```

---

### Task 18: Port Claude integration/smoke tests

**Files:**
- Test: `throng-agent-claude/src/integration/a2a-boot.test.ts`,
  `throng-agent-claude/src/integration/plugins-boot.test.ts`,
  `throng-agent-claude/src/smoke.test.ts`

- [ ] **Step 1: Port the three suites** from `SRC/test/integration/a2a-boot.test.ts`,
  `SRC/test/integration/plugins-boot.test.ts`, `SRC/test/smoke.test.ts`.
  Rewrite their manifest fixtures and wiring to the new API: construct a
  `TaskRun` (imported from `@throng/agent-core`) with `defaultBootDeps()` (or a
  fake `BootDeps`) and a `new ClaudeEngineAdapter()`, and drive it through
  `createControlApp`/`buildServer`. Where they asserted the injected
  `TaskRunDeps` members, assert against the adapter/BootDeps split instead.
- [ ] **Step 2: For `smoke.test.ts`'s version check:** the old test enforced
  `VERSION` in `SRC/src/index.ts` matched `package.json`. Since the variant no
  longer exports `VERSION`, drop that assertion or repoint it at the variant
  `package.json` version. Note the change in the commit body.
- [ ] **Step 3: Run:** `npm test -w throng-agent-claude` → Expected: all PASS.
- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "test(claude): port integration + smoke suites to the new API"
```

---

## Phase 3 — `throng-agent-codex` (working stub)

### Task 19: Codex variant skeleton

**Files:**
- Create: `throng-agent-codex/package.json`, `throng-agent-codex/tsconfig.json`,
  `throng-agent-codex/vitest.config.ts`, `throng-agent-codex/.npmrc`

- [ ] **Step 1: Confirm the upstream package + entrypoint names**

Run: `npm view a2a-codex version` and check its `main`/exports and how it
exposes a server factory + config type (the a2a-wrapper `a2a-codex` package).
Record the actual export names for use in Task 21.

- [ ] **Step 2: Write `throng-agent-codex/package.json`**

```json
{
  "name": "throng-agent-codex",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit",
    "test": "vitest --run --passWithNoTests"
  },
  "dependencies": {
    "@throng/agent-core": "0.1.0",
    "a2a-codex": "^1.6.1",
    "express": "^4.18.2"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^20.10.0",
    "@types/supertest": "^7.2.0",
    "supertest": "^7.2.2",
    "typescript": "^5.3.0",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 3: Write `throng-agent-codex/tsconfig.json`** (same shape as the Claude variant's).
- [ ] **Step 4: Write `vitest.config.ts`; copy `.npmrc`.**
- [ ] **Step 5: Install + commit**

```bash
cd /Users/col/projects/throng_platform/throng_agent && npm install
git add -A && git commit -m "chore(codex): add throng-agent-codex package skeleton"
```

---

### Task 20: Codex agent-block validation + credentials

**Files:**
- Create: `throng-agent-codex/src/manifest/codex-agent.ts`,
  `throng-agent-codex/src/config/credentials.ts`
- Test: `throng-agent-codex/src/manifest/codex-agent.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { validateCodexAgent } from "./codex-agent.js";

describe("validateCodexAgent", () => {
  it("requires the agent block", () => {
    expect(validateCodexAgent({}, {}).ok).toBe(false);
  });

  it("resolves openai_api_key from env", () => {
    const r = validateCodexAgent({ agent: {} }, { OPENAI_API_KEY: "sk-env" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent.openai_api_key).toBe("sk-env");
  });

  it("rejects a non-string model", () => {
    const r = validateCodexAgent({ agent: { model: 5 } }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "agent.model")).toBe(true);
  });
});
```

- [ ] **Step 2: Run:** `npm test -w throng-agent-codex -- codex-agent` → Expected: FAIL.

- [ ] **Step 3: Implement `throng-agent-codex/src/manifest/codex-agent.ts`**

```ts
import type { AgentResult, Env, FieldError } from "@throng/agent-core";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const blankToNil = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v : null;

/** The resolved, Codex-shaped agent payload stored on `manifest.agent`. */
export interface ResolvedCodexAgent {
  keys: Record<string, unknown>;
  openai_api_key: string | null;
}

export function validateCodexAgent(
  input: Record<string, unknown>,
  env: Env,
): AgentResult<ResolvedCodexAgent> {
  const errors: FieldError[] = [];

  if (!("agent" in input)) {
    errors.push({ field: "agent", reason: "is required" });
  } else if (!isObject(input.agent)) {
    errors.push({ field: "agent", reason: "must be an object" });
  } else if ("model" in input.agent && typeof input.agent.model !== "string") {
    errors.push({ field: "agent.model", reason: "must be a string" });
  }

  if ("openai_api_key" in input && typeof input.openai_api_key !== "string") {
    errors.push({ field: "openai_api_key", reason: "must be a string" });
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    agent: {
      keys: (input.agent as Record<string, unknown>) ?? {},
      openai_api_key: blankToNil(input.openai_api_key) ?? blankToNil(env.OPENAI_API_KEY),
    },
  };
}
```

- [ ] **Step 4: Implement `throng-agent-codex/src/config/credentials.ts`**

```ts
/** Sets OPENAI_API_KEY in-process (once per sandbox). No-op when key is null. */
export function injectOpenAIKey(key: string | null): void {
  if (key) process.env.OPENAI_API_KEY = key;
}
```

- [ ] **Step 5: Run:** `npm test -w throng-agent-codex -- codex-agent` → Expected: PASS.
- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(codex): agent-block validation + OpenAI credential resolution"
```

---

### Task 21: `CodexEngineAdapter` + entrypoint + Docker

Use the real `a2a-codex` export names recorded in Task 19. The example below
assumes a `createA2AServer(config)` factory and an `AgentConfig`-like type; adjust
to the actual API.

**Files:**
- Create: `throng-agent-codex/src/config/build.ts`, `throng-agent-codex/src/adapter.ts`,
  `throng-agent-codex/src/index.ts`, `throng-agent-codex/Dockerfile`,
  `throng-agent-codex/.dockerignore`
- Test: `throng-agent-codex/src/adapter.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { CodexEngineAdapter } from "./adapter.js";
import type { Manifest } from "@throng/agent-core";
import type { ResolvedCodexAgent } from "./manifest/codex-agent.js";

describe("CodexEngineAdapter", () => {
  it("validateAgent rejects a missing agent block", () => {
    expect(new CodexEngineAdapter().validateAgent({}, {}).ok).toBe(false);
  });

  it("injectCredentials sets OPENAI_API_KEY", () => {
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      new CodexEngineAdapter().injectCredentials({
        agent: { keys: {}, openai_api_key: "sk-c" },
      } as unknown as Manifest<ResolvedCodexAgent>);
      expect(process.env.OPENAI_API_KEY).toBe("sk-c");
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev;
    }
  });
});
```

- [ ] **Step 2: Run:** `npm test -w throng-agent-codex -- adapter` → Expected: FAIL.

- [ ] **Step 3: Implement `throng-agent-codex/src/config/build.ts`**

Build the Codex server config from `manifest.agent.keys` + `workingDirectory` +
the same env-driven `server` block as the Claude variant (0.0.0.0, A2A_PORT,
ADVERTISE_HOST/PROTOCOL). Shape the return to the real `a2a-codex` config type
from Task 19. Keep it minimal (model + working directory + server) for the stub.

```ts
import type { Manifest } from "@throng/agent-core";
import type { ResolvedCodexAgent } from "../manifest/codex-agent.js";

// Replace `CodexAgentConfig` with the real exported type from a2a-codex.
export interface CodexServerConfig {
  agentCard: { name: string; description: string };
  server: { hostname: string; port: number; advertiseHost: string; advertiseProtocol: "http" | "https" };
  codex: { workingDirectory: string; model?: string };
}

export function buildAgentConfig(
  manifest: Manifest<ResolvedCodexAgent>,
  workingDirectory: string,
): CodexServerConfig {
  const a = manifest.agent.keys;
  const codex: CodexServerConfig["codex"] = { workingDirectory };
  if (typeof a.model === "string") codex.model = a.model;

  return {
    agentCard: {
      name: "Throng Agent A2A Codex",
      description: "Throng-controlled, Codex-backed A2A agent.",
    },
    server: {
      hostname: "0.0.0.0",
      port: Number(process.env.A2A_PORT ?? 3030),
      advertiseHost: process.env.ADVERTISE_HOST ?? "localhost",
      advertiseProtocol: (process.env.ADVERTISE_PROTOCOL ?? "https") as "http" | "https",
    },
    codex,
  };
}
```

- [ ] **Step 4: Implement `throng-agent-codex/src/adapter.ts`**

```ts
import type { AgentResult, EngineAdapter, Env, Manifest, ServerHandle } from "@throng/agent-core";
import { log } from "@throng/agent-core";
// import { createA2AServer } from "a2a-codex"; // wire to the real factory (Task 19)
import { buildAgentConfig, type CodexServerConfig } from "./config/build.js";
import { injectOpenAIKey } from "./config/credentials.js";
import { validateCodexAgent, type ResolvedCodexAgent } from "./manifest/codex-agent.js";

export class CodexEngineAdapter
  implements EngineAdapter<ResolvedCodexAgent, CodexServerConfig>
{
  validateAgent(input: Record<string, unknown>, env: Env): AgentResult<ResolvedCodexAgent> {
    return validateCodexAgent(input, env);
  }

  injectCredentials(manifest: Manifest<ResolvedCodexAgent>): void {
    injectOpenAIKey(manifest.agent.openai_api_key);
    if (manifest.agent.openai_api_key === null) {
      log.warn("no openai_api_key in manifest; agent requests will fail unless another auth path is configured");
    }
  }

  buildAgentConfig(manifest: Manifest<ResolvedCodexAgent>, primaryDest: string): CodexServerConfig {
    return buildAgentConfig(manifest, primaryDest);
  }

  async createA2AServer(config: CodexServerConfig): Promise<ServerHandle> {
    // Wire to a2a-codex's real factory (see Task 19). Until then:
    const handle = await realCreateCodexServer(config);
    return handle;
  }
}

// Placeholder indirection so the adapter compiles; replace with the real import.
async function realCreateCodexServer(_config: CodexServerConfig): Promise<ServerHandle> {
  throw new Error("a2a-codex server factory not yet wired");
}
```

Once Task 19's findings are in hand, replace `realCreateCodexServer` with the
actual `a2a-codex` factory call and the `CodexServerConfig` type with the real
config type.

- [ ] **Step 5: Write `throng-agent-codex/src/index.ts`**

```ts
import { startControlServer } from "@throng/agent-core";
import { CodexEngineAdapter } from "./adapter.js";

startControlServer(new CodexEngineAdapter());
```

- [ ] **Step 6: Write `throng-agent-codex/Dockerfile`** — copy the Claude variant's
  Dockerfile, replacing every `throng-agent-claude` with `throng-agent-codex`.
- [ ] **Step 7: Copy `.dockerignore`.**
- [ ] **Step 8: Run:** `npm test -w throng-agent-codex && npm run build -w throng-agent-codex` → Expected: adapter test PASS, build compiles.
- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat(codex): CodexEngineAdapter, entrypoint, Dockerfile (server factory stubbed)"
```

---

## Phase 4 — Monorepo guards, CI, finalize

### Task 22: Monorepo-guard tests in core

Port the spirit of a2a-wrapper's `no-duplicates` / `publish-config` /
`tsconfig-consistency` guards.

**Files:**
- Test: `packages/core/src/__tests__/monorepo/publish-config.test.ts`,
  `packages/core/src/__tests__/monorepo/tsconfig-consistency.test.ts`

- [ ] **Step 1: Write `publish-config.test.ts`**

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "../../../../.."); // → throng_agent/
const read = (p: string) => JSON.parse(readFileSync(join(root, p), "utf-8"));

describe("publish config", () => {
  it("core is publishable and public", () => {
    const pkg = read("packages/core/package.json");
    expect(pkg.name).toBe("@throng/agent-core");
    expect(pkg.publishConfig?.access).toBe("public");
    expect(pkg.private).not.toBe(true);
  });

  it("variants pin core to an exact version", () => {
    for (const v of ["throng-agent-claude", "throng-agent-codex"]) {
      const pkg = read(`${v}/package.json`);
      expect(pkg.dependencies["@throng/agent-core"]).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});
```

- [ ] **Step 2: Write `tsconfig-consistency.test.ts`**

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "../../../../..");
const read = (p: string) => JSON.parse(readFileSync(join(root, p), "utf-8"));

describe("tsconfig consistency", () => {
  it("every package extends the base tsconfig", () => {
    for (const p of ["packages/core", "throng-agent-claude", "throng-agent-codex"]) {
      const ts = read(`${p}/tsconfig.json`);
      expect(ts.extends).toMatch(/tsconfig\.base\.json$/);
    }
  });
});
```

- [ ] **Step 3: Run:** `npm test -w @throng/agent-core -- monorepo` → Expected: PASS.
- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "test(core): monorepo publish + tsconfig consistency guards"
```

---

### Task 23: CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write `.github/workflows/ci.yml`**

```yaml
name: CI
on:
  push: { branches: [main] }
  pull_request:
jobs:
  build-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "20", cache: "npm" }
      - run: npm ci
      - run: npm run build
      - run: npm run typecheck
      - run: npm test
```

- [ ] **Step 2: Verify the whole workspace green locally**

Run: `cd /Users/col/projects/throng_platform/throng_agent && npm run build && npm run typecheck && npm test`
Expected: core + both variants build, typecheck, and test PASS.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "ci: build, typecheck and test the workspace"
```

---

### Task 24: Root README + archive pointer

**Files:**
- Create: `throng_agent/README.md`
- Modify: `SRC/README.md` (add archive/redirect banner — do this in the SRC repo)

- [ ] **Step 1: Write `throng_agent/README.md`** describing the monorepo: the
  `@throng/agent-core` library, the `throng-agent-claude` / `throng-agent-codex`
  variants, the `EngineAdapter` extension point (link the design + plan docs), and
  the workspace commands (`npm run build|test|typecheck`, `npm run changeset`).
- [ ] **Step 2: Add a banner to `SRC/README.md`** noting the repo is superseded by
  `throng_agent` and will be archived once the Claude variant ships from the
  monorepo. Commit that in the SRC repo separately.
- [ ] **Step 3: Commit (in throng_agent)**

```bash
git add -A && git commit -m "docs: monorepo README + engine-adapter overview"
```

---

## Self-review notes (author)

- **Spec coverage:** repo layout (Task 1), core boundary/`EngineAdapter` (Tasks 5–10),
  manifest split (Tasks 7, 14, 20), tooling turbo/changesets/workspaces (Tasks 1–2, 23),
  fresh-repo migration (all phases), monorepo guards (Task 22), Claude parity (Phase 2),
  Codex stub (Phase 3) — all covered.
- **Known follow-ups** (intentionally out of scope of the first green build):
  full `a2a-codex` server wiring (Task 21 leaves a labelled stub pending Task 19's
  findings) and the `git subtree` history-import decision (spec open item).
- **`@throng` npm org** must be reserved before `npm run release`; nothing in the
  plan publishes until then.
