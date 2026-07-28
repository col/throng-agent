# Multi-Engine Runtime Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the engine a runtime choice — one deployable `throng-agent` image containing all engines, with the engine selected per-`initialise` via `agent.platform`, a single generic `agent.api_key`, and the unused `throng_api_token` removed.

**Architecture:** `@throng/agent-core` routes on `agent.platform` through an adapter registry (`Record<string, EngineAdapter>`) instead of a single injected adapter; it validates the one reserved sub-field `agent.platform` and delegates the rest of `agent` to the selected adapter. Each adapter resolves the generic `agent.api_key` (via a shared `resolveApiKey` helper, falling back to its SDK env var) and maps it onto its SDK's env var. A new `throng-agent` app package wires the registry and owns the single Dockerfile; `throng-agent-claude` / `throng-agent-codex` become pure adapter libraries.

**Tech Stack:** TypeScript (ESM, NodeNext), Node 20, Express, Vitest, Turborepo, `@col/a2a-claude`, `a2a-codex`.

---

## Conventions for executors

- **Repo:** `/Users/col/projects/throng_platform/throng_agent/` (the monorepo). All work happens here.
- **Auth for installs:** the workspace includes `throng-agent-claude` → private `@col/a2a-claude`. Any `npm install`/`npm ci` must be prefixed `GITHUB_TOKEN="$(gh auth token)" …`. Plain `npm run build|test|typecheck` need no token. If `gh auth token` is empty, STOP and report BLOCKED.
- **TDD:** write each test first, run it, confirm the expected failure, then implement, then confirm pass. (Type-only-import tests are runtime-erased and may pass before their module exists — in that case confirm "red" by the module's absence, then proceed.)
- **Commits:** conventional messages, one per task. No `Co-Authored-By` trailers.
- **Design spec:** `docs/superpowers/specs/2026-07-28-multi-engine-runtime-selection-design.md`.

---

## File map

**Core (`packages/core/src`)**
- Create `manifest/api-key.ts` — `resolveApiKey` helper.
- Modify `manifest/types.ts` — drop `throng_api_token`; add `platform` to `Manifest`; add `adapter` to `ValidateResult` success.
- Modify `engine/adapter.ts` — add `AdapterRegistry` type.
- Modify `manifest/validate.ts` — registry routing on `agent.platform`; drop `throng_api_token`; return selected adapter.
- Modify `task-run.ts` — constructor takes the registry; boot uses the platform-selected adapter.
- Modify `control/server.ts` — `buildServer` / `startControlServer` take the registry.
- Modify `index.ts` — export `resolveApiKey`, `AdapterRegistry`.

**Adapters** (`throng-agent-claude/src`, `throng-agent-codex/src`)
- `manifest/{claude,codex}-agent.ts` — resolve `agent.api_key` via `resolveApiKey`; drop the per-engine key field.
- `adapter.ts` — `injectCredentials` reads `manifest.agent.api_key`.
- Package conversion to libraries (package.json/tsconfig/index barrel; remove `index.ts` entrypoint + `Dockerfile`).

**New app** (`throng-agent/`)
- `package.json`, `tsconfig.json`, `vitest.config.ts`, `.npmrc`, `Dockerfile`, `.dockerignore`.
- `src/registry.ts`, `src/index.ts`, `src/index.test.ts`, `src/integration/*` (moved boot tests).

**Root**
- `package.json` — rename to `throng-agent-root`; widen `workspaces` glob to `throng-agent*`.

---

## Phase 1 — Core: registry routing, generic key, platform

### Task 1: `resolveApiKey` helper

**Files:**
- Create: `packages/core/src/manifest/api-key.ts`
- Test: `packages/core/src/manifest/api-key.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { resolveApiKey } from "./api-key.js";

describe("resolveApiKey", () => {
  it("prefers the manifest agent.api_key", () => {
    expect(resolveApiKey({ api_key: "sk-manifest" }, { ANTHROPIC_API_KEY: "sk-env" }, ["ANTHROPIC_API_KEY"]))
      .toBe("sk-manifest");
  });
  it("falls back to the first non-blank env var", () => {
    expect(resolveApiKey({}, { OPENAI_API_KEY: "sk-env" }, ["OPENAI_API_KEY"])).toBe("sk-env");
  });
  it("treats a blank manifest value as absent", () => {
    expect(resolveApiKey({ api_key: "  " }, { ANTHROPIC_API_KEY: "sk-env" }, ["ANTHROPIC_API_KEY"]))
      .toBe("sk-env");
  });
  it("returns null when nothing is set", () => {
    expect(resolveApiKey({}, {}, ["ANTHROPIC_API_KEY"])).toBe(null);
  });
});
```

- [ ] **Step 2: Run:** `npm test -w @throng/agent-core -- api-key` → Expected: FAIL (module not found).

- [ ] **Step 3: Implement `packages/core/src/manifest/api-key.ts`**

```ts
import type { Env } from "../env.js";

const blankToNil = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v : null;

/**
 * Resolves the generic `agent.api_key` for an engine: the manifest value if
 * present and non-blank, else the first non-blank value among the engine's
 * fallback env vars (e.g. ANTHROPIC_API_KEY), else null. The env target is
 * engine-specific, so each adapter passes its own SDK env var(s) as fallback.
 */
export function resolveApiKey(
  agent: Record<string, unknown>,
  env: Env,
  fallbackEnvVars: string[],
): string | null {
  const fromManifest = blankToNil(agent.api_key);
  if (fromManifest) return fromManifest;
  for (const name of fallbackEnvVars) {
    const v = blankToNil(env[name]);
    if (v) return v;
  }
  return null;
}
```

- [ ] **Step 4: Run:** `npm test -w @throng/agent-core -- api-key` → Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/core/src/manifest/api-key.ts packages/core/src/manifest/api-key.test.ts
git commit -m "feat(core): add resolveApiKey helper for the generic agent.api_key"
```

---

### Task 2: Manifest types + `AdapterRegistry`

**Files:**
- Modify: `packages/core/src/manifest/types.ts`, `packages/core/src/engine/adapter.ts`

- [ ] **Step 1: Edit `packages/core/src/manifest/types.ts`**

Remove `throng_api_token` from `BaseManifest`; add `platform` to `Manifest`; add `adapter` to the `ValidateResult` success arm. Full new file:

```ts
import type { EngineAdapter } from "../engine/adapter.js";

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
}

/**
 * Full manifest = generic skeleton + the resolved platform tag (lifted out of
 * the raw `agent` object during validation) + the engine's resolved agent payload.
 */
export interface Manifest<TAgent = unknown> extends BaseManifest {
  platform: string;
  agent: TAgent;
}

export type ValidateResult<TAgent = unknown> =
  | { ok: true; manifest: Manifest<TAgent>; adapter: EngineAdapter<TAgent> }
  | { ok: false; errors: FieldError[] };
```

- [ ] **Step 2: Edit `packages/core/src/engine/adapter.ts`**

Add an `AdapterRegistry` type at the end of the file (after the `EngineAdapter` interface):

```ts
/**
 * A registry of engine adapters keyed by platform name (the `agent.platform`
 * value). Values use `any` type args because the map is heterogeneous — each
 * adapter is strongly typed internally, but they don't share a payload type.
 */
export type AdapterRegistry = Record<string, EngineAdapter<any, any>>;
```

- [ ] **Step 3: Typecheck:** `npm run typecheck -w @throng/agent-core` → Expected: FAIL — `validate.ts` and `task-run.ts` still reference the old shapes. That's expected; the next tasks fix them. (Do not commit yet.)

*(No commit — Tasks 2–5 land together as a coherent core refactor; commit at the end of Task 5's green.)*

---

### Task 3: `validate` — registry routing on `agent.platform`

**Files:**
- Modify: `packages/core/src/manifest/validate.ts`
- Test: `packages/core/src/manifest/validate.test.ts` (rewrite)

- [ ] **Step 1: Replace `packages/core/src/manifest/validate.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { validate } from "./validate.js";
import type { AgentResult, EngineAdapter } from "../engine/adapter.js";

// Echo adapter: assumes core already checked agent-is-object + platform;
// echoes the raw agent object as its resolved payload.
const echo: EngineAdapter<Record<string, unknown>> = {
  validateAgent: (input): AgentResult<Record<string, unknown>> => ({
    ok: true,
    agent: input.agent as Record<string, unknown>,
  }),
  injectCredentials: () => {},
  buildAgentConfig: () => ({}),
  createA2AServer: async () => ({ shutdown: async () => {} }),
};
const registry = { test: echo };

const okInput = {
  repos: [{ url: "https://x/y", ref: "main", dest: "y", primary: true }],
  agent: { platform: "test", model: "m" },
};

describe("validate (registry routing)", () => {
  it("rejects a non-object manifest", () => {
    expect(validate(42, registry).ok).toBe(false);
  });
  it("rejects a missing agent block", () => {
    const r = validate({ repos: okInput.repos }, registry);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "agent")).toBe(true);
  });
  it("rejects a missing platform", () => {
    const r = validate({ ...okInput, agent: { model: "m" } }, registry);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "agent.platform")).toBe(true);
  });
  it("rejects an unknown platform", () => {
    const r = validate({ ...okInput, agent: { platform: "nope" } }, registry);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "agent.platform")).toBe(true);
  });
  it("requires exactly one primary repo", () => {
    const r = validate(
      { agent: { platform: "test" }, repos: [{ url: "https://x/y", ref: "main", dest: "y", primary: false }] },
      registry,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "repos[].primary")).toBe(true);
  });
  it("builds a manifest with resolved platform + selected adapter", () => {
    const r = validate(okInput, registry);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.platform).toBe("test");
      expect(r.manifest.agent).toEqual({ platform: "test", model: "m" });
      expect(r.adapter).toBe(echo);
      expect("throng_api_token" in r.manifest).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run:** `npm test -w @throng/agent-core -- manifest/validate` → Expected: FAIL (old signature).

- [ ] **Step 3: Replace `packages/core/src/manifest/validate.ts`**

```ts
import type { Env } from "../env.js";
import type { AdapterRegistry, EngineAdapter } from "../engine/adapter.js";
import type { BaseManifest, FieldError, Manifest, RepoSpec, ValidateResult } from "./types.js";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const blankToNil = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v : null;

const nonEmptyString = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? null : "must be a non-empty string";

export function validate(
  input: unknown,
  registry: AdapterRegistry,
  env: Env = process.env,
): ValidateResult {
  if (!isObject(input)) {
    return { ok: false, errors: [{ field: "manifest", reason: "must be a JSON object" }] };
  }
  const errors: FieldError[] = [];

  validateRepos(input.repos, errors);

  // Routing: core reads exactly one reserved sub-field, agent.platform, to pick
  // the adapter. Everything else in `agent` is the selected adapter's payload.
  let adapter: EngineAdapter<any, any> | undefined;
  if (!("agent" in input)) {
    errors.push({ field: "agent", reason: "is required" });
  } else if (!isObject(input.agent)) {
    errors.push({ field: "agent", reason: "must be an object" });
  } else {
    const platform = input.agent.platform;
    if (typeof platform !== "string" || !(platform in registry)) {
      errors.push({
        field: "agent.platform",
        reason: `must be one of ${Object.keys(registry).join(", ")}`,
      });
    } else {
      adapter = registry[platform];
    }
  }

  // Delegate the rest of the agent block to the selected adapter (only when one
  // was resolved — otherwise the routing errors above already explain the 400).
  const agentResult = adapter ? adapter.validateAgent(input, env) : undefined;
  if (agentResult && !agentResult.ok) errors.push(...agentResult.errors);

  if ("github_token" in input && typeof input.github_token !== "string") {
    errors.push({ field: "github_token", reason: "must be a string" });
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

  // adapter + agentResult are defined and ok here (errors would have returned
  // above). Guard the invariant explicitly rather than assume it.
  if (!adapter || !agentResult || !agentResult.ok) {
    return { ok: false, errors: [{ field: "agent", reason: "could not be resolved" }] };
  }
  const platform = (input.agent as Record<string, unknown>).platform as string;
  return { ok: true, manifest: buildManifest(input, repos, platform, agentResult.agent, env), adapter };
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

function buildManifest(
  input: Record<string, unknown>,
  repos: Array<Record<string, unknown>>,
  platform: string,
  agent: unknown,
  env: Env,
): Manifest {
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
  };
  return { ...base, platform, agent };
}
```

Note: `buildManifest` still takes `env` for the `github_token` fallback (`env.GITHUB_TOKEN`), keeping it injectable in tests; the only removal is the `throng_api_token` field and its `THRONG_API_TOKEN` fallback.

- [ ] **Step 4: Run:** `npm test -w @throng/agent-core -- manifest/validate` → Expected: PASS.

*(No commit yet — continues into Task 4.)*

---

### Task 4: `TaskRun` — construct with the registry, boot via the selected adapter

**Files:**
- Modify: `packages/core/src/task-run.ts`
- Test: `packages/core/src/task-run.test.ts` (rewrite)

- [ ] **Step 1: Replace `packages/core/src/task-run.test.ts`**

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

function adapter(over: Partial<EngineAdapter<any, any>> = {}): EngineAdapter<any, any> {
  return {
    validateAgent: (input: any) => ({ ok: true, agent: input.agent }),
    injectCredentials: vi.fn(() => {}),
    buildAgentConfig: vi.fn(() => ({})),
    createA2AServer: vi.fn(async () => handle),
    ...over,
  };
}

const okPayload = {
  repos: [{ url: "https://x/y", ref: "main", dest: "y", primary: true }],
  agent: { platform: "claude" },
};
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("TaskRun", () => {
  it("rejects a second initialise", async () => {
    const tr = new TaskRun(deps(), { claude: adapter() });
    await tr.initialise(okPayload);
    const second = await tr.initialise(okPayload);
    expect(second.ok).toBe(false);
    if (!second.ok) expect("already" in second && second.already).toBe(true);
  });

  it("boots via the platform-selected adapter and reaches ready", async () => {
    const claude = adapter();
    const tr = new TaskRun(deps(), { claude });
    const r = await tr.initialise(okPayload);
    expect(r).toEqual({ ok: true, status: "booting" });
    await settle();
    expect(tr.lifecycle.status().state).toBe("ready");
    expect(claude.createA2AServer).toHaveBeenCalledOnce();
  });

  it("routes to the adapter named by agent.platform", async () => {
    const claude = adapter();
    const codex = adapter();
    const tr = new TaskRun(deps(), { claude, codex });
    await tr.initialise({ ...okPayload, agent: { platform: "codex" } });
    await settle();
    expect(codex.createA2AServer).toHaveBeenCalledOnce();
    expect(claude.createA2AServer).not.toHaveBeenCalled();
  });

  it("rejects an unknown platform", async () => {
    const tr = new TaskRun(deps(), { claude: adapter() });
    const r = await tr.initialise({ ...okPayload, agent: { platform: "nope" } });
    expect(r.ok).toBe(false);
    if (!r.ok && "errors" in r) expect(r.errors.some((e) => e.field === "agent.platform")).toBe(true);
  });

  it("fails with the adapter-classified step on server start error", async () => {
    const claude = adapter({
      createA2AServer: async () => { throw new Error("plugin did not load"); },
      classifyBootError: () => "plugins",
    });
    const tr = new TaskRun(deps(), { claude });
    await tr.initialise(okPayload);
    await settle();
    expect(tr.lifecycle.status().error?.step).toBe("plugins");
  });
});
```

- [ ] **Step 2: Run:** `npm test -w @throng/agent-core -- task-run` → Expected: FAIL (constructor signature).

- [ ] **Step 3: Edit `packages/core/src/task-run.ts`**

Change imports, the class generics/constructor, `initialise`, and `boot`. Apply these edits:

Replace the import of `EngineAdapter` + `validate` + `Manifest`:
```ts
import type { AdapterRegistry, EngineAdapter, ServerHandle } from "./engine/adapter.js";
import { Lifecycle } from "./lifecycle.js";
import { log } from "./log.js";
import type { FieldError, Manifest } from "./manifest/types.js";
import { validate } from "./manifest/validate.js";
```

Replace the class header + constructor:
```ts
export class TaskRun {
  readonly lifecycle = new Lifecycle();
  private serverHandle?: ServerHandle;

  constructor(
    private readonly deps: BootDeps,
    private readonly registry: AdapterRegistry,
  ) {}
```

Replace `initialise`:
```ts
  async initialise(payload: unknown): Promise<InitialiseResult> {
    if (this.lifecycle.state !== "uninitialised") {
      log.warn("initialise rejected: already initialised", { state: this.lifecycle.state });
      return { ok: false, already: true };
    }

    const result = validate(payload, this.registry);
    if (!result.ok) {
      log.warn("initialise rejected: manifest validation failed", {
        errors: result.errors.map((e) => e.field),
      });
      return { ok: false, errors: result.errors };
    }

    this.lifecycle.set("booting");
    log.info("initialise accepted; booting asynchronously", {
      platform: result.manifest.platform,
      repos: result.manifest.repos.length,
      setupCommands: result.manifest.setup_commands.length,
    });
    void this.boot(result.manifest, result.adapter);
    return { ok: true, status: "booting" };
  }
```

Change the `boot` signature to accept the selected adapter and use it (replace `this.adapter.` with `adapter.`):
```ts
  private async boot(manifest: Manifest, adapter: EngineAdapter<any, any>): Promise<void> {
```
Inside `boot`, replace the three `this.adapter.` call sites so they read:
```ts
      adapter.injectCredentials(manifest);
```
```ts
      const config = adapter.buildAgentConfig(manifest, primaryDest);
```
```ts
        this.serverHandle = await adapter.createA2AServer(config);
```
and the classify line:
```ts
        const step = adapter.classifyBootError?.(err, manifest) ?? "agent";
```
Everything else in `boot` (clone/checkout/setup loop, StepError handling, logs) is unchanged.

- [ ] **Step 4: Run:** `npm test -w @throng/agent-core -- task-run` → Expected: PASS.

*(No commit yet — continues into Task 5.)*

---

### Task 5: Control server takes the registry

**Files:**
- Modify: `packages/core/src/control/server.ts`
- Test: `packages/core/src/control/server.test.ts` (rewrite)

- [ ] **Step 1: Replace `packages/core/src/control/server.test.ts`**

```ts
import request from "supertest";
import { describe, expect, it } from "vitest";
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
const adapter: EngineAdapter<any, any> = {
  validateAgent: (i: any) => ({ ok: true, agent: i.agent }),
  injectCredentials: () => {},
  buildAgentConfig: () => ({}),
  createA2AServer: async () => handle,
};
const app = () => createControlApp({ taskRun: new TaskRun(bootDeps, { claude: adapter }) });
const goodRepos = [{ url: "https://x/y", ref: "main", dest: "y", primary: true }];

describe("control server", () => {
  it("GET /healthz → ok", async () => {
    expect((await request(app()).get("/healthz")).body).toEqual({ status: "ok" });
  });
  it("GET /api/status → uninitialised", async () => {
    expect((await request(app()).get("/api/status")).body.state).toBe("uninitialised");
  });
  it("POST /api/initialise bad manifest → 400 list", async () => {
    const res = await request(app()).post("/api/initialise").send({ repos: [] });
    expect(res.status).toBe(400);
    expect(Array.isArray(res.body)).toBe(true);
  });
  it("POST /api/initialise unknown platform → 400", async () => {
    const res = await request(app()).post("/api/initialise").send({ repos: goodRepos, agent: { platform: "nope" } });
    expect(res.status).toBe(400);
  });
  it("POST /api/initialise valid → 202 booting", async () => {
    const res = await request(app()).post("/api/initialise").send({ repos: goodRepos, agent: { platform: "claude" } });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: "booting" });
  });
  it("401 when THRONG_INIT_TOKEN set", async () => {
    const prev = process.env.THRONG_INIT_TOKEN;
    process.env.THRONG_INIT_TOKEN = "secret";
    try {
      const res = await request(app()).post("/api/initialise").send({ agent: { platform: "claude" } });
      expect(res.status).toBe(401);
    } finally {
      if (prev === undefined) delete process.env.THRONG_INIT_TOKEN;
      else process.env.THRONG_INIT_TOKEN = prev;
    }
  });
});
```

- [ ] **Step 2: Run:** `npm test -w @throng/agent-core -- control/server` → Expected: FAIL.

- [ ] **Step 3: Edit `packages/core/src/control/server.ts`**

Change the `EngineAdapter` import to `AdapterRegistry`, and make `buildServer` / `startControlServer` take the registry:

Replace the adapter import line:
```ts
import type { AdapterRegistry } from "../engine/adapter.js";
```
Replace `buildServer` and `startControlServer`:
```ts
export function buildServer(registry: AdapterRegistry): Express {
  return createControlApp({ taskRun: new TaskRun(defaultBootDeps(), registry) });
}

/** The app entrypoint: `startControlServer({ claude: new ClaudeEngineAdapter(), … })`. */
export function startControlServer(registry: AdapterRegistry): void {
  const port = Number(process.env.CONTROL_PORT ?? 8080);
  const app = buildServer(registry);
  app.listen(port, "0.0.0.0", () => {
    log.info("control server listening", { port });
  });
}
```
`createControlApp` and `defaultBootDeps` are unchanged.

- [ ] **Step 4: Run:** `npm test -w @throng/agent-core -- control/server` → Expected: PASS.

*(No commit yet — Task 6 finalizes and commits the whole core refactor.)*

---

### Task 6: Core exports + green

**Files:**
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Edit `packages/core/src/index.ts`**

Add `resolveApiKey` and `AdapterRegistry` to the exports. Insert after the existing `validate` export line:
```ts
export { resolveApiKey } from "./manifest/api-key.js";
```
and change the adapter export line to include `AdapterRegistry`:
```ts
export type { EngineAdapter, ServerHandle, AgentResult, AdapterRegistry } from "./engine/adapter.js";
```

- [ ] **Step 2: Build + typecheck + full test:**

Run: `npm run build -w @throng/agent-core && npm run typecheck -w @throng/agent-core && npm test -w @throng/agent-core`
Expected: compiles; all suites PASS (api-key, validate, task-run, control/server, plus the unchanged lifecycle/git/setup/init-token/adapter/monorepo suites).

- [ ] **Step 3: Commit the core refactor**

```bash
git add packages/core
git commit -m "feat(core): route on agent.platform via an adapter registry; drop throng_api_token; generic resolveApiKey"
```

---

## Phase 2 — Adapters use the generic `agent.api_key`

### Task 7: Claude adapter — generic key

**Files:**
- Modify: `throng-agent-claude/src/manifest/claude-agent.ts`, `throng-agent-claude/src/adapter.ts`
- Test: `throng-agent-claude/src/manifest/claude-agent.test.ts`, `throng-agent-claude/src/adapter.test.ts`

- [ ] **Step 1: Replace `throng-agent-claude/src/manifest/claude-agent.ts`**

`anthropic_api_key` → generic `api_key` resolved via `resolveApiKey` (fallback `ANTHROPIC_API_KEY`), validated as a string inside `agent`:

```ts
import { resolveApiKey, type AgentResult, type Env, type FieldError } from "@throng/agent-core";
import { EMPTY_PLUGINS, resolvePlugins, type ResolvedPlugins } from "../config/plugins.js";

const PERMISSION_MODES = new Set(["acceptEdits", "dontAsk", "plan", "bypassPermissions"]);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The resolved, Claude-shaped agent payload stored on `manifest.agent`. */
export interface ResolvedClaudeAgent {
  /** Raw agent keys (model, tools, system prompts, max_turns, permission_mode). */
  keys: Record<string, unknown>;
  plugins: ResolvedPlugins;
  api_key: string | null;
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
    if ("api_key" in a && typeof a.api_key !== "string") {
      errors.push({ field: "agent.api_key", reason: "must be a string" });
    }
    const resolution = resolvePlugins(a.plugins);
    if (resolution.ok) plugins = resolution.resolved;
    else errors.push(...resolution.errors);
  }

  if (errors.length > 0) return { ok: false, errors };

  const a = (input.agent as Record<string, unknown>) ?? {};
  return {
    ok: true,
    agent: { keys: a, plugins, api_key: resolveApiKey(a, env, ["ANTHROPIC_API_KEY"]) },
  };
}
```

- [ ] **Step 2: Edit `throng-agent-claude/src/adapter.ts`**

In `injectCredentials`, replace the two `manifest.agent.anthropic_api_key` reads with `manifest.agent.api_key`, and reword the warning:
```ts
    injectAnthropicKey(manifest.agent.api_key);
    if (manifest.agent.api_key === null) {
      log.warn("no api_key in manifest; agent requests will fail unless another auth path is configured");
    }
```
Nothing else in `adapter.ts` changes (`injectAnthropicKey` still sets `ANTHROPIC_API_KEY`).

- [ ] **Step 3: Update `throng-agent-claude/src/manifest/claude-agent.test.ts`**

Replace the `anthropic_api_key` cases with `api_key` ones. Change the two existing key tests to:
```ts
  it("resolves api_key from agent.api_key", () => {
    const r = validateClaudeAgent({ agent: { api_key: "sk-in" } }, {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent.api_key).toBe("sk-in");
  });

  it("falls back to ANTHROPIC_API_KEY when agent.api_key is absent", () => {
    const r = validateClaudeAgent({ agent: {} }, { ANTHROPIC_API_KEY: "sk-env" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent.api_key).toBe("sk-env");
  });

  it("rejects a non-string agent.api_key", () => {
    const r = validateClaudeAgent({ agent: { api_key: 5 } }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "agent.api_key")).toBe(true);
  });
```
Keep the existing "requires the agent block", "rejects an unknown permission mode", "resolves plugins into channels", "accepts bypassPermissions", and "reports a bad plugin entry alongside other agent errors" cases (the plugins one may set `anthropic_api_key: "sk"` at top level — remove that now-ignored field or move it to `agent.api_key`; it doesn't affect the assertion).

- [ ] **Step 4: Update `throng-agent-claude/src/adapter.test.ts`**

In the `injectCredentials sets ANTHROPIC_API_KEY` test, change the constructed manifest's agent payload from `anthropic_api_key: "sk-x"` to `api_key: "sk-x"`. The assertion (`process.env.ANTHROPIC_API_KEY === "sk-x"`) is unchanged. Also add `platform` to any `Manifest` fixtures if the test constructs a full `Manifest` (add `platform: "claude"` at the top level of the manifest object).

- [ ] **Step 5: Run:** `npm test -w throng-agent-claude -- claude-agent adapter` → Expected: PASS. Then `npm run typecheck -w throng-agent-claude` → PASS.

- [ ] **Step 6: Commit**

```bash
git add throng-agent-claude/src
git commit -m "feat(claude): resolve the generic agent.api_key (ANTHROPIC_API_KEY fallback)"
```

---

### Task 8: Codex adapter — generic key

**Files:**
- Modify: `throng-agent-codex/src/manifest/codex-agent.ts`, `throng-agent-codex/src/adapter.ts`
- Test: `throng-agent-codex/src/manifest/codex-agent.test.ts`, `throng-agent-codex/src/adapter.test.ts`

- [ ] **Step 1: Replace `throng-agent-codex/src/manifest/codex-agent.ts`**

`openai_api_key` → generic `api_key` via `resolveApiKey` (fallback `OPENAI_API_KEY`):

```ts
import { resolveApiKey, type AgentResult, type Env, type FieldError } from "@throng/agent-core";

const SANDBOX_MODES = new Set(["read-only", "workspace-write", "danger-full-access"]);
const APPROVAL_POLICIES = new Set(["never", "on-request", "on-failure", "untrusted"]);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The resolved, Codex-shaped agent payload stored on `manifest.agent`. */
export interface ResolvedCodexAgent {
  keys: Record<string, unknown>;
  api_key: string | null;
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
  } else {
    const a = input.agent;
    if ("model" in a && typeof a.model !== "string") {
      errors.push({ field: "agent.model", reason: "must be a string" });
    }
    if ("sandbox_mode" in a && !SANDBOX_MODES.has(a.sandbox_mode as string)) {
      errors.push({
        field: "agent.sandbox_mode",
        reason: "must be one of read-only/workspace-write/danger-full-access",
      });
    }
    if ("approval_policy" in a && !APPROVAL_POLICIES.has(a.approval_policy as string)) {
      errors.push({
        field: "agent.approval_policy",
        reason: "must be one of never/on-request/on-failure/untrusted",
      });
    }
    if ("api_key" in a && typeof a.api_key !== "string") {
      errors.push({ field: "agent.api_key", reason: "must be a string" });
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const a = (input.agent as Record<string, unknown>) ?? {};
  return {
    ok: true,
    agent: { keys: a, api_key: resolveApiKey(a, env, ["OPENAI_API_KEY"]) },
  };
}
```

- [ ] **Step 2: Edit `throng-agent-codex/src/adapter.ts`**

In `injectCredentials`, replace `manifest.agent.openai_api_key` (both references) with `manifest.agent.api_key` and reword the warning to `"no api_key in manifest; agent requests will fail unless another auth path is configured"`. `injectOpenAIKey` still sets `OPENAI_API_KEY`.

- [ ] **Step 3: Update `throng-agent-codex/src/manifest/codex-agent.test.ts`**

Replace the `openai_api_key` resolution case with:
```ts
  it("resolves api_key from agent.api_key then OPENAI_API_KEY", () => {
    expect((validateCodexAgent({ agent: { api_key: "sk-in" } }, {}) as any).agent.api_key).toBe("sk-in");
    const r = validateCodexAgent({ agent: {} }, { OPENAI_API_KEY: "sk-env" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent.api_key).toBe("sk-env");
  });
  it("rejects a non-string agent.api_key", () => {
    const r = validateCodexAgent({ agent: { api_key: 5 } }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "agent.api_key")).toBe(true);
  });
```
Keep the existing agent-required / model / sandbox_mode cases.

- [ ] **Step 4: Update `throng-agent-codex/src/adapter.test.ts`**

Change the injectCredentials test's manifest agent payload from `openai_api_key: "sk-c"` to `api_key: "sk-c"` (assertion on `process.env.OPENAI_API_KEY` unchanged); add `platform: "codex"` to any full `Manifest` fixture.

- [ ] **Step 5: Run:** `npm test -w throng-agent-codex && npm run typecheck -w throng-agent-codex` → Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add throng-agent-codex/src
git commit -m "feat(codex): resolve the generic agent.api_key (OPENAI_API_KEY fallback)"
```

---

## Phase 3 — Packaging: adapter libraries + the `throng-agent` app

### Task 9: Convert the variant packages to libraries

The adapter packages stop being deployables: remove their entrypoint + Dockerfile, add a library barrel + package metadata, and relocate their full-boot/server tests to the app (Task 10 re-creates them there).

**Files (both `throng-agent-claude` and `throng-agent-codex`):**
- Replace `src/index.ts` with a library barrel.
- Modify `package.json` (add `main`/`types`/`exports`; drop `start`), `tsconfig.json` (add `declaration`).
- Delete `Dockerfile`, `.dockerignore`.
- Delete the boot/server tests that will move to the app.

- [ ] **Step 1: Replace `throng-agent-claude/src/index.ts` with a barrel**

```ts
export { ClaudeEngineAdapter } from "./adapter.js";
export type { ResolvedClaudeAgent } from "./manifest/claude-agent.js";
```

- [ ] **Step 2: Replace `throng-agent-codex/src/index.ts` with a barrel**

```ts
export { CodexEngineAdapter } from "./adapter.js";
export type { ResolvedCodexAgent } from "./manifest/codex-agent.js";
```

- [ ] **Step 3: Edit `throng-agent-claude/package.json`**

Add library fields and drop the `start` script:
```json
{
  "name": "throng-agent-claude",
  "version": "0.2.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest --run",
    "clean": "rm -rf dist"
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

- [ ] **Step 4: Edit `throng-agent-codex/package.json`**

Same shape, codex values (keep `a2a-codex` dep, `--passWithNoTests` test script):
```json
{
  "name": "throng-agent-codex",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest --run --passWithNoTests",
    "clean": "rm -rf dist"
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

- [ ] **Step 5: Enable declaration output in both variant tsconfigs**

Edit `throng-agent-claude/tsconfig.json` and `throng-agent-codex/tsconfig.json` — set `declaration: true` so consumers get types:
```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src", "declaration": true },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "src/**/*.test.ts", "src/**/__tests__/**"]
}
```

- [ ] **Step 6: Remove deployable + relocating tests**

```bash
git rm throng-agent-claude/Dockerfile throng-agent-claude/.dockerignore
git rm throng-agent-claude/src/index.test.ts throng-agent-claude/src/smoke.test.ts
git rm throng-agent-claude/src/integration/a2a-boot.test.ts throng-agent-claude/src/integration/plugins-boot.test.ts
```
(Codex has no Dockerfile/index/integration tests beyond unit tests — check with `ls throng-agent-codex` and `git rm` its `Dockerfile`/`.dockerignore`/`src/index.test.ts` only if present.) These boot/server tests are re-created against the registry in the `throng-agent` app (Task 10).

- [ ] **Step 7: Build + typecheck both libraries**

Run: `npm run build -w throng-agent-claude -w throng-agent-codex && npm run typecheck -w throng-agent-claude -w throng-agent-codex && npm test -w throng-agent-claude -w throng-agent-codex`
Expected: both build (emitting `dist/index.d.ts`), typecheck, and their remaining unit tests PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(variants): make throng-agent-claude/codex pure adapter libraries"
```

---

### Task 10: New `throng-agent` app package

**Files:**
- Create: `throng-agent/package.json`, `throng-agent/tsconfig.json`, `throng-agent/vitest.config.ts`, `throng-agent/.npmrc`, `throng-agent/Dockerfile`, `throng-agent/.dockerignore`
- Create: `throng-agent/src/registry.ts`, `throng-agent/src/index.ts`, `throng-agent/src/index.test.ts`, `throng-agent/src/integration/boot.test.ts`
- Modify: the monorepo-guard tests in `packages/core/src/__tests__/monorepo/`

> Root install/glob changes are Task 11; this task creates files. Run installs with the `GITHUB_TOKEN="$(gh auth token)"` prefix.

- [ ] **Step 1: Write `throng-agent/package.json`**

```json
{
  "name": "throng-agent",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit",
    "test": "vitest --run",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@throng/agent-core": "0.1.0",
    "throng-agent-claude": "0.2.0",
    "throng-agent-codex": "0.1.0",
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

- [ ] **Step 2: Write `throng-agent/tsconfig.json`** (no `declaration` — it's an app)

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "src/**/*.test.ts", "src/**/__tests__/**"]
}
```

- [ ] **Step 3: Write `throng-agent/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["src/**/*.test.ts", "src/**/__tests__/**/*.test.ts"] },
});
```

- [ ] **Step 4: Copy `.npmrc`:** `cp throng-agent-claude/.npmrc throng-agent/.npmrc` (the `@col` GitHub Packages mapping — the app transitively installs `@col/a2a-claude`).

- [ ] **Step 5: Write `throng-agent/src/registry.ts`**

```ts
import type { AdapterRegistry } from "@throng/agent-core";
import { ClaudeEngineAdapter } from "throng-agent-claude";
import { CodexEngineAdapter } from "throng-agent-codex";

/** All engines bundled into the throng-agent image, keyed by `agent.platform`. */
export function createRegistry(): AdapterRegistry {
  return {
    claude: new ClaudeEngineAdapter(),
    codex: new CodexEngineAdapter(),
  };
}
```

- [ ] **Step 6: Write `throng-agent/src/index.ts`**

```ts
import { startControlServer } from "@throng/agent-core";
import { createRegistry } from "./registry.js";

startControlServer(createRegistry());
```

- [ ] **Step 7: Write the failing app test `throng-agent/src/index.test.ts`**

```ts
import request from "supertest";
import { describe, expect, it } from "vitest";
import { buildServer } from "@throng/agent-core";
import { createRegistry } from "./registry.js";

describe("throng-agent app registry", () => {
  it("registers both bundled engines", () => {
    expect(Object.keys(createRegistry()).sort()).toEqual(["claude", "codex"]);
  });

  it("buildServer(registry) answers the control endpoints", async () => {
    const app = buildServer(createRegistry());
    expect((await request(app).get("/healthz")).body).toEqual({ status: "ok" });
    expect((await request(app).get("/api/status")).body.state).toBe("uninitialised");
  });

  it("rejects a manifest with an unknown platform", async () => {
    const app = buildServer(createRegistry());
    const res = await request(app)
      .post("/api/initialise")
      .send({ repos: [{ url: "https://x/y", ref: "main", dest: "y", primary: true }], agent: { platform: "gemini" } });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 8: Run:** `npm test -w throng-agent -- index` → Expected: FAIL (workspace not yet installed / package unresolved). If it fails to resolve the workspace, that's expected until Task 11's install; proceed to write the integration test, then do the install in Task 11, then re-run. If the workspace already resolves (npm picked up the new dir), it should turn green after Task 11.

- [ ] **Step 9: Write `throng-agent/src/integration/boot.test.ts`** (the relocated claude boot test, now registry-driven)

```ts
import { describe, expect, it, vi } from "vitest";
import { TaskRun, type BootDeps } from "@throng/agent-core";
import { createRegistry } from "../registry.js";

// Drive a full boot through the registry with faked bootstrap deps, asserting
// the claude adapter is selected by agent.platform and the lifecycle reaches ready.
function fakeDeps(): BootDeps {
  return {
    clone: vi.fn(async () => ({ ok: true, output: "" })),
    checkout: vi.fn(async () => ({ ok: true, output: "" })),
    runSetupCommands: vi.fn(async () => ({ ok: true })),
    injectGitCredentials: vi.fn(() => {}),
    workspaceRoot: "/workspace",
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("throng-agent boot routing", () => {
  it("routes agent.platform=claude through the claude adapter to ready", async () => {
    const tr = new TaskRun(fakeDeps(), createRegistry());
    const res = await tr.initialise({
      repos: [{ url: "https://x/y", ref: "main", dest: "y", primary: true }],
      agent: { platform: "claude", api_key: "sk-test", permission_mode: "plan" },
    });
    expect(res).toEqual({ ok: true, status: "booting" });
    // Boot invokes the real ClaudeEngineAdapter.createA2AServer (@col/a2a-claude).
    // Allow the async boot to settle, then assert it did not fail on routing/validation.
    await settle();
    const state = tr.lifecycle.status().state;
    expect(["setup", "ready", "failed"]).toContain(state);
    // If it reached "failed", it must be an engine/agent step (real SDK), never a
    // routing/validation problem.
    if (state === "failed") {
      expect(tr.lifecycle.status().error?.step).not.toBe("boot");
    }
  });
});
```

Note: this exercises the real `@col/a2a-claude` `createA2AServer`, which may fail at the `agent` step without full Anthropic setup — the assertion only requires that routing/validation succeeded (state advanced past `cloning` and any failure is an engine step, not a routing error). If flakiness arises, gate the strict-ready assertion behind `process.env.ANTHROPIC_API_KEY` as the old `plugins-boot` test did.

- [ ] **Step 10: Update the monorepo-guard tests** in `packages/core/src/__tests__/monorepo/`

- `publish-config.test.ts`: extend the "variants pin core exact" loop to include the app:
  ```ts
  for (const v of ["throng-agent-claude", "throng-agent-codex", "throng-agent"]) {
  ```
- `tsconfig-consistency.test.ts`: extend the package list to include the app:
  ```ts
  for (const p of ["packages/core", "throng-agent-claude", "throng-agent-codex", "throng-agent"]) {
  ```
Read the current files first and adjust the exact array literals to match.

- [ ] **Step 11: Write `throng-agent/Dockerfile`** (the single multi-engine image; build the whole workspace via turbo for correct dependency order)

```dockerfile
# syntax=docker/dockerfile:1

# --- Build stage -------------------------------------------------------------
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json turbo.json tsconfig.base.json .npmrc ./
COPY packages/core/package.json ./packages/core/package.json
COPY throng-agent-claude/package.json ./throng-agent-claude/package.json
COPY throng-agent-codex/package.json ./throng-agent-codex/package.json
COPY throng-agent/package.json ./throng-agent/package.json
RUN --mount=type=secret,id=github_token \
    GITHUB_TOKEN="$(cat /run/secrets/github_token)" npm ci
COPY packages/core ./packages/core
COPY throng-agent-claude ./throng-agent-claude
COPY throng-agent-codex ./throng-agent-codex
COPY throng-agent ./throng-agent
RUN npm run build && npm prune --omit=dev

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
COPY --from=build /app/throng-agent-codex/dist ./throng-agent-codex/dist
COPY --from=build /app/throng-agent-codex/package.json ./throng-agent-codex/package.json
COPY --from=build /app/throng-agent/dist ./throng-agent/dist
COPY --from=build /app/throng-agent/package.json ./throng-agent/package.json
ENV CONTROL_PORT=8080
EXPOSE 8080 3030
CMD ["node", "throng-agent/dist/index.js"]
```

- [ ] **Step 12: Copy `.dockerignore`:** `cp throng-agent-claude/.dockerignore throng-agent/.dockerignore` if it still exists, else create one containing `node_modules` and `dist`. (Task 9 deleted claude's — so create `throng-agent/.dockerignore` with:)

```
node_modules
dist
```

- [ ] **Step 13: Commit (build/install verification happens in Task 11)**

```bash
git add throng-agent packages/core/src/__tests__/monorepo
git commit -m "feat(throng-agent): all-in-one app package wiring the engine registry + single Dockerfile"
```

---

### Task 11: Root workspace rename + full-workspace green

**Files:**
- Modify: `package.json` (root)

- [ ] **Step 1: Edit root `package.json`**

Rename the package and widen the glob so it matches both the new `throng-agent` app and the `throng-agent-*` libraries:
```json
{
  "name": "throng-agent-root",
  "version": "0.0.0",
  "private": true,
  "description": "Monorepo for Throng A2A agent runtimes (core + engine variants)",
  "type": "module",
  "workspaces": ["packages/*", "throng-agent*"],
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

- [ ] **Step 2: Reinstall the workspace**

Run: `GITHUB_TOKEN="$(gh auth token)" npm install`
Expected: links `throng-agent` and its `throng-agent-claude` / `throng-agent-codex` dependencies to the local workspace packages; `package-lock.json` updates.

- [ ] **Step 3: Whole-workspace verification**

Run: `npm run build && npm run typecheck && npm test`
Expected: all four packages (`@throng/agent-core`, `throng-agent-claude`, `throng-agent-codex`, `throng-agent`) build, typecheck, and test green — including the app's `index` + `boot` tests and the updated monorepo guards. If the app's `boot` integration test is flaky against the real SDK, apply the env gate noted in Task 10 Step 9.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: name monorepo root throng-agent-root; widen workspaces to throng-agent*"
```

---

## Phase 4 — Docs

### Task 12: README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the manifest/credential and packaging story**

Read the current `README.md` and apply:
1. **Packages table:** replace the `throng-agent-claude` / `throng-agent-codex` "engine variant" rows to describe them as adapter **libraries**, and add a `throng-agent` row: "The deployable all-in-one image; wires every engine adapter into a registry and selects one per-initialise via `agent.platform`."
2. **Variants / entrypoint section:** replace the per-variant `startControlServer(new ClaudeEngineAdapter())` example with the registry wiring:
   ```ts
   import { startControlServer } from "@throng/agent-core";
   import { createRegistry } from "./registry.js";
   startControlServer(createRegistry()); // { claude, codex } keyed by agent.platform
   ```
3. **Manifest examples:** show `agent.platform` (required) and `agent.api_key` (generic); remove any `anthropic_api_key` / `openai_api_key` / `throng_api_token` references.
4. **Adding a new engine:** update the steps — implement `EngineAdapter` in a new adapter library, then add it to the app's `createRegistry()` under its platform key (no core changes).
5. **Per-engine image escape hatch:** add a short note that a lean single-engine image is still cheap to add later — a package whose `index.ts` wires a one-key registry (`{ claude: new ClaudeEngineAdapter() }`) plus a Dockerfile.
6. **Installing section:** unchanged (GitHub Packages token note still applies).

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: single throng-agent image; agent.platform + agent.api_key manifest"
```

---

## Self-review notes (author)

- **Spec coverage:** manifest shape platform/api_key (Tasks 3, 7, 8), throng_api_token removal (Tasks 2, 3), registry routing + `Manifest.platform` + `validate` returns adapter (Tasks 2–4), `resolveApiKey` (Task 1), `startControlServer(registry)` (Task 5), adapters map generic key to SDK env var (Tasks 7, 8), `throng-agent` app + single Dockerfile (Task 10), adapter libraries (Task 9), root rename + glob (Task 11), fail-closed 400 (Tasks 3–5, 10), per-engine escape hatch documented (Task 12), tests (throughout) — all covered.
- **Type consistency:** `AdapterRegistry = Record<string, EngineAdapter<any,any>>`; `validate(input, registry, env)` → `ValidateResult` with `adapter`; `Manifest.platform`; `TaskRun(deps, registry)` → `boot(manifest, adapter)`; `resolveApiKey(agent, env, fallbackEnvVars)`; `ResolvedClaudeAgent.api_key` / `ResolvedCodexAgent.api_key`. Consistent across tasks.
- **Known follow-up:** CI auth for the private `@col/a2a-claude` (pre-existing, tracked separately) is unchanged by this plan.
