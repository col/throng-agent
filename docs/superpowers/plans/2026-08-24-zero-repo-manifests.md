# Zero-Repo Manifests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept `repos: []` on `/api/initialise` and `/api/prepare`, so a task can boot into an empty workspace for agents whose job is to create a project from scratch.

**Architecture:** Two validation rules relax (the empty-array rejection, and exactly-one-primary becoming conditional on a non-empty list). Working-directory resolution moves out of the clone loop into an exported pure function that returns the workspace root when there are no repos. `BootDeps` gains an injected `ensureWorkspace` so the workspace root exists even when no `git clone` creates it.

**Tech Stack:** TypeScript (ESM, NodeNext), Vitest, Turborepo, Changesets. Package: `@throng/agent-core` at `packages/core`.

---

## Background an engineer needs

**The two rules that block an empty list.** Removing only the length check achieves nothing. `validate.ts:213` rejects `repos.length === 0`, and `crossFieldRepoErrors` (`validate.ts:188-202`) then rejects it again because zero repos means zero repos with `primary: true`, and the rule demands exactly one. Both must change together or the caller trades one confusing 400 for another.

**Why the working directory is load-bearing.** `syncRepos` currently accumulates `primaryDest` through the clone loop and throws if it is still `""` at the end. That value is the cwd for `setup_commands` *and* the `workingDirectory` passed to `adapter.buildAgentConfig`. With no repos there is no primary, so it needs to resolve to `workspaceRoot`.

**Why `ensureWorkspace` is injected rather than a bare `mkdirSync`.** `packages/core/src/task-run.test.ts:18` builds fake deps with `workspaceRoot: "/home/user/workspace"`. That path does not exist on macOS and cannot be created there (`/home` is not writable). A direct `mkdirSync` inside `syncRepos` would make the existing suite fail on a developer machine. Every other side effect in `BootDeps` is injected for exactly this reason.

**Running tests.** From the repo root:
- Whole suite: `npm test`
- One file: `npx vitest run packages/core/src/manifest/validate.test.ts`
- One test by name: `npx vitest run packages/core/src/task-run.test.ts -t "zero-repo"`

Turborepo caches results, so a re-run with unchanged inputs prints `cached`. Add `--force` to `npm test` to genuinely re-execute. `npx vitest run` always executes.

Only `npm install` / `npm ci` need a token (`GITHUB_TOKEN="$(gh auth token)" npm ci`). `npm test`, `npm run build`, `npm run typecheck` do not.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/core/src/manifest/validate.ts` | Manifest shape and cross-field rules for both routes | Modify: `validateRepos` (drop length check), `crossFieldRepoErrors` (guard primary rule) |
| `packages/core/src/manifest/validate.test.ts` | Validation tests | Modify one assertion, add cases |
| `packages/core/src/task-run.ts` | Boot/prepare orchestration, `BootDeps` | Modify: add exported `resolveWorkingDirectory`, add `ensureWorkspace` to `BootDeps`, strip `primaryDest` out of `syncRepos` |
| `packages/core/src/task-run.test.ts` | Orchestration tests | Add `ensureWorkspace` to fakes, add zero-repo cases |
| `packages/core/src/control/server.ts` | `defaultBootDeps` wiring | Modify: implement `ensureWorkspace` |
| `packages/core/src/index.ts` | Package surface | Modify: export `resolveWorkingDirectory` |
| `.changeset/zero-repo-manifests.md` | Release note | Create |

`resolveWorkingDirectory` lives in `task-run.ts` rather than a new file because it throws `StepError`, which is module-private there (`task-run.ts:316`), and because it is one small function tightly coupled to the boot sequence. It is exported so it can be unit-tested without constructing a `TaskRun`.

---

### Task 1: Validation accepts an empty repo list

**Files:**
- Modify: `packages/core/src/manifest/validate.ts:204-216` (`validateRepos`) and `:188-202` (`crossFieldRepoErrors`)
- Test: `packages/core/src/manifest/validate.test.ts`

- [ ] **Step 1: Write the failing tests**

In `packages/core/src/manifest/validate.test.ts`, add a new `describe` block after the `describe("validate (registry routing)", ...)` block that ends at line 61:

```typescript
describe("validate (empty repo list)", () => {
  it("accepts repos: [] with a valid agent block", () => {
    const r = validate({ repos: [], agent: { platform: "test", model: "m" } }, registry);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.repos).toEqual([]);
  });

  // The pair matters. Dropping the primary rule outright rather than making it
  // conditional would also pass the case above, and would let a real multi-repo
  // manifest through with no primary — which syncRepos has no cwd for.
  it("still requires exactly one primary when repos is non-empty", () => {
    const r = validate(
      { repos: [{ url: "https://x/y", ref: "main", dest: "y", primary: false }], agent: { platform: "test" } },
      registry,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "repos[].primary")).toBe(true);
  });

  it("still requires the repos key to be present", () => {
    const r = validate({ agent: { platform: "test", model: "m" } }, registry);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContainEqual({ field: "repos", reason: "is required" });
  });

  it("still rejects a non-array repos", () => {
    const r = validate({ repos: {}, agent: { platform: "test", model: "m" } }, registry);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContainEqual({ field: "repos", reason: "must be a list" });
  });

  it("accepts repos: [] on prepare too", () => {
    const r = validatePrepare({ repos: [] }, {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.repos).toEqual([]);
  });

  it("still requires the repos key on prepare", () => {
    const r = validatePrepare({}, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContainEqual({ field: "repos", reason: "is required" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/src/manifest/validate.test.ts -t "empty repo list"`

Expected: FAIL. The two "accepts" cases fail because `validate`/`validatePrepare` return `ok: false` with a `repos` error. The three "still" cases pass already — they pin behaviour that must not regress.

- [ ] **Step 3: Drop the length rejection**

In `packages/core/src/manifest/validate.ts`, in `validateRepos`, delete this block (currently lines 213-216):

```typescript
  if (value.length === 0) {
    errors.push({ field: "repos", reason: "must contain at least one entry" });
    return;
  }
```

Leave the `undefined` and non-array branches above it exactly as they are — `repos` stays a required key, and a non-array is still a 400.

- [ ] **Step 4: Make the primary rule conditional**

In the same file, replace `crossFieldRepoErrors` (currently lines 187-202) with:

```typescript
/** Rules that need every repo at once; run only after the per-field ones pass. */
function crossFieldRepoErrors(repos: Array<Record<string, unknown>>): FieldError[] {
  const errors: FieldError[] = [];
  // Empty is legal: a task may start from a bare workspace, and an agent whose
  // job is to create the project chooses the layout itself. The primary rule is
  // about which of SEVERAL repos the agent runs in, so with none there is
  // nothing for it to decide — see resolveWorkingDirectory, which answers
  // "where does the agent run" with the workspace root in that case.
  if (repos.length > 0) {
    const primaries = repos.filter((r) => r.primary === true).length;
    if (primaries !== 1) {
      errors.push({
        field: "repos[].primary",
        reason: `exactly one repo must be marked primary: true (got ${primaries})`,
      });
    }
  }
  const dests = repos.map((r) => r.dest);
  if (new Set(dests).size !== dests.length) {
    errors.push({ field: "repos[].dest", reason: "dest values must be unique across repos" });
  }
  return errors;
}
```

The dest-uniqueness check stays outside the guard: it is already a no-op on an empty array, and nesting it would imply otherwise.

- [ ] **Step 5: Invert the stale prepare assertion**

`packages/core/src/manifest/validate.test.ts:320` currently asserts that an empty list is an error on prepare. In the `it("applies the same repo rules as initialise", ...)` test, replace this line:

```typescript
    expect(errorsOf({ ...preparePayload, repos: [] }).map((e) => e.field)).toContain("repos");
```

with:

```typescript
    expect(errorsOf({ ...preparePayload, repos: [] })).toEqual([]);
```

The surrounding two assertions in that test (all-`primary: false`, and an `http://` url) stay unchanged — they are still the point of the test.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run packages/core/src/manifest/validate.test.ts`

Expected: PASS, all tests in the file.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/manifest/validate.ts packages/core/src/manifest/validate.test.ts
git commit -m "feat(core): accept an empty repos list on both routes"
```

---

### Task 2: `resolveWorkingDirectory`

**Files:**
- Modify: `packages/core/src/task-run.ts` (add the function; do not wire it in yet)
- Modify: `packages/core/src/index.ts:2-8` (export it)
- Test: `packages/core/src/task-run.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/src/task-run.test.ts`. The existing import on line 6 is `import { TaskRun, type BootDeps } from "./task-run.js";` — change it to:

```typescript
import { TaskRun, resolveWorkingDirectory, type BootDeps } from "./task-run.js";
```

Then add this `describe` block at the end of the file:

```typescript
describe("resolveWorkingDirectory", () => {
  const root = "/home/user/workspace";
  const manifest = (repos: Array<{ url: string; ref: string; dest: string; primary: boolean }>) =>
    ({ repos, credentials: null, github_token: null, setup_commands: [] }) as any;

  it("returns the primary repo's destination", () => {
    const m = manifest([
      { url: "https://x/a", ref: "main", dest: "a", primary: false },
      { url: "https://x/b", ref: "main", dest: "b", primary: true },
    ]);
    expect(resolveWorkingDirectory(m, root)).toBe("/home/user/workspace/b");
  });

  it("returns the workspace root when there are no repos", () => {
    expect(resolveWorkingDirectory(manifest([]), root)).toBe(root);
  });

  // Unreachable through the public API — validation demands exactly one primary
  // for a non-empty list — but the silent failure it prevents is bad: an empty
  // cwd makes runSetupCommands run in the process's own directory and report
  // success.
  it("throws when a non-empty list has no primary", () => {
    const m = manifest([{ url: "https://x/a", ref: "main", dest: "a", primary: false }]);
    expect(() => resolveWorkingDirectory(m, root)).toThrow(/no repo was marked primary/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/src/task-run.test.ts -t "resolveWorkingDirectory"`

Expected: FAIL at import — `resolveWorkingDirectory` is not exported from `./task-run.js`.

- [ ] **Step 3: Write the implementation**

In `packages/core/src/task-run.ts`, add this function immediately before the `class StepError` declaration at line 316:

```typescript
/**
 * Where the agent runs, and where `setup_commands` run: the primary repo's
 * destination, or the workspace root when the manifest carries no repos.
 *
 * Separate from `syncRepos` — which only clones — because these are two
 * questions, and only one of them has an answer that depends on the network
 * having succeeded. Keeping the resolution pure also means the no-primary case
 * below is a function contract rather than a loop invariant over a mutable
 * accumulator, and it is testable without mocking git.
 */
export function resolveWorkingDirectory(manifest: WorkspaceManifest, workspaceRoot: string): string {
  // An empty workspace is legal input: the agent's job may be to create the
  // project. The workspace root is where cloned repos live, so a repository the
  // agent creates there is in the layout a later task's manifest will expect.
  if (manifest.repos.length === 0) return workspaceRoot;

  const primary = manifest.repos.find((r) => r.primary);
  // Guards the seam rather than a reachable input: validation accepts exactly
  // one primary for a non-empty list on both routes, so this cannot fire through
  // the public API. It is here because the silent failure it prevents is bad —
  // an empty working directory makes runSetupCommands run in the process's own
  // working directory instead of the repo, and report success.
  if (!primary) {
    throw new StepError("cloning", "no repo was marked primary, so setup commands have nowhere to run");
  }
  return join(workspaceRoot, primary.dest);
}
```

`join` is already imported at `task-run.ts:1`, and `WorkspaceManifest` at line 7. No new imports.

- [ ] **Step 4: Export it from the package root**

In `packages/core/src/index.ts`, the block starting at line 2 exports from `./task-run.js`. Add `resolveWorkingDirectory` to that export list, keeping the existing entries. For example, if the block reads:

```typescript
export {
  TaskRun,
  type BootDeps,
  ...
} from "./task-run.js";
```

make it:

```typescript
export {
  TaskRun,
  resolveWorkingDirectory,
  type BootDeps,
  ...
} from "./task-run.js";
```

Read the existing block first and preserve every entry already there — do not retype it from memory.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run packages/core/src/task-run.test.ts -t "resolveWorkingDirectory"`

Expected: PASS, 3 tests.

- [ ] **Step 6: Verify nothing else broke**

Run: `npx vitest run packages/core && npm run typecheck`

Expected: PASS. `syncRepos` still has its own copy of the logic at this point — that is intentional and gets removed in Task 4.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/task-run.ts packages/core/src/task-run.test.ts packages/core/src/index.ts
git commit -m "feat(core): add resolveWorkingDirectory"
```

---

### Task 3: `ensureWorkspace` dep

**Files:**
- Modify: `packages/core/src/task-run.ts:11-22` (`BootDeps`) and `:231-233` (`syncRepos`)
- Modify: `packages/core/src/control/server.ts:95-106` (`defaultBootDeps`)
- Test: `packages/core/src/task-run.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/core/src/task-run.test.ts`, add `ensureWorkspace` to the fake deps factory (currently lines 11-21) so it reads:

```typescript
function deps(over: Partial<BootDeps> = {}): BootDeps {
  return {
    syncOrClone: vi.fn(async () => ({ ok: true, output: "" })),
    runSetupCommands: vi.fn(async () => ({ ok: true })),
    writeCredentialConfig: vi.fn(() => {}),
    deleteCredentialConfig: vi.fn(() => {}),
    injectGitIdentity: vi.fn(() => {}),
    ensureWorkspace: vi.fn(() => {}),
    workspaceRoot: "/home/user/workspace",
    ...over,
  };
}
```

Then add this test inside the existing `describe("TaskRun", ...)` block:

```typescript
  it("ensures the workspace root exists before cloning", async () => {
    const d = deps();
    const tr = new TaskRun(d, { claude: adapter() });
    await tr.initialise(okPayload);
    await settle();
    expect(d.ensureWorkspace).toHaveBeenCalledWith("/home/user/workspace");
  });

  it("fails the boot when the workspace cannot be created", async () => {
    const d = deps({
      ensureWorkspace: vi.fn(() => {
        throw new Error("EACCES: permission denied");
      }),
    });
    const tr = new TaskRun(d, { claude: adapter() });
    await tr.initialise(okPayload);
    await settle();
    const status = tr.lifecycle.status();
    expect(status.state).toBe("failed");
    expect(d.syncOrClone).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/src/task-run.test.ts -t "workspace"`

Expected: FAIL. The first test fails because `ensureWorkspace` is never called; TypeScript also reports `ensureWorkspace` is not a property of `BootDeps`.

- [ ] **Step 3: Add the dep to the interface**

In `packages/core/src/task-run.ts`, inside `interface BootDeps`, add this member immediately before `workspaceRoot`:

```typescript
  /** Creates `workspaceRoot` if it is absent. Recursive and idempotent.
   *
   *  Needed because nothing else creates it: today the directory exists only as
   *  a side effect of `git clone` creating its destination's parents, so a
   *  manifest with no repos would point the agent at a path that is not there.
   *  Injected rather than called directly so the test suite's fake workspace
   *  root — a path that does not exist and cannot be created on a developer
   *  machine — stays inert. */
  ensureWorkspace: (dir: string) => void;
```

- [ ] **Step 4: Call it at the top of `syncRepos`**

In the same file, in `syncRepos`, immediately after the `log.info(\`${phase} step: cloning repos\`, …)` call (line 233) and before `let primaryDest = "";`, insert:

```typescript
    // Unconditional, not guarded on an empty repo list: it is idempotent where
    // `git clone` would have created the directory anyway, and load-bearing
    // where there are no repos to create it.
    try {
      this.deps.ensureWorkspace(this.deps.workspaceRoot);
    } catch (err) {
      throw new StepError("cloning", err instanceof Error ? err.message : String(err));
    }
```

- [ ] **Step 5: Implement it in `defaultBootDeps`**

In `packages/core/src/control/server.ts`, add `mkdirSync` to the `node:fs` imports. If the file has no `node:fs` import yet, add at the top:

```typescript
import { mkdirSync } from "node:fs";
```

Then in the object returned by `defaultBootDeps`, add before `workspaceRoot`:

```typescript
    ensureWorkspace: (dir) => mkdirSync(dir, { recursive: true }),
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run packages/core/src/task-run.test.ts`

Expected: PASS, whole file.

- [ ] **Step 7: Fix the other `BootDeps` construction site**

`ensureWorkspace` is a required member, so every place that builds a `BootDeps` literal now fails to compile. There is one besides the test factory in Step 1: `packages/core/src/control/server.test.ts:8`. Add the member to it so the literal reads:

```typescript
const bootDeps: BootDeps = {
  syncOrClone: async () => ({ ok: true, output: "" }),
  runSetupCommands: async () => ({ ok: true }),
  writeCredentialConfig: () => {},
  deleteCredentialConfig: () => {},
  injectGitIdentity: () => {},
  ensureWorkspace: () => {},
  workspaceRoot: "/home/user/workspace",
};
```

Then confirm there are no others:

```bash
npm run typecheck
grep -rn "BootDeps" --include="*.ts" packages throng-agent-claude throng-agent-codex | grep -v node_modules
```

Expected: typecheck PASSes. If it still reports a missing `ensureWorkspace` somewhere, add `ensureWorkspace: () => {}` there too and re-run.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/task-run.ts packages/core/src/task-run.test.ts packages/core/src/control/server.ts
git commit -m "feat(core): create the workspace root via an injected ensureWorkspace dep"
```

---

### Task 4: Wire the resolver in and strip `primaryDest` out of `syncRepos`

**Files:**
- Modify: `packages/core/src/task-run.ts:120-135` (`prepareWorkspace`), `:187-212` (`boot`), `:230-275` (`syncRepos`)
- Test: `packages/core/src/task-run.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/task-run.test.ts`, inside `describe("TaskRun", ...)`:

```typescript
  it("resolves the working directory before cloning, not after", async () => {
    const order: string[] = [];
    const d = deps({
      ensureWorkspace: vi.fn(() => {
        order.push("ensure");
      }),
      syncOrClone: vi.fn(async () => {
        order.push("clone");
        return { ok: true, output: "" };
      }),
      runSetupCommands: vi.fn(async () => {
        order.push("setup");
        return { ok: true };
      }),
    });
    const tr = new TaskRun(d, { claude: adapter() });
    await tr.initialise({ ...okPayload, setup_commands: ["mise install"] });
    await settle();
    expect(order).toEqual(["ensure", "clone", "setup"]);
    expect(d.runSetupCommands).toHaveBeenCalledWith("/home/user/workspace/y", ["mise install"]);
  });
```

- [ ] **Step 2: Run the test to verify current behaviour**

Run: `npx vitest run packages/core/src/task-run.test.ts -t "before cloning"`

Expected: PASS. This test pins behaviour that must survive the refactor — the observable order is unchanged. Its value is as a regression guard for Steps 3-5, which is why it is written first even though it is green.

- [ ] **Step 3: Make `syncRepos` clone only**

In `packages/core/src/task-run.ts`, change the `syncRepos` signature and body. Replace the doc comment and signature (lines 230-234):

```typescript
  /** Returns the primary repo's destination — where setup commands run. */
  private async syncRepos(manifest: WorkspaceManifest, phase: Phase = "boot"): Promise<string> {
```

with:

```typescript
  /** Clones or resyncs every repo in the manifest. The working directory is
   *  resolved separately, by resolveWorkingDirectory. */
  private async syncRepos(manifest: WorkspaceManifest, phase: Phase = "boot"): Promise<void> {
```

Delete the `let primaryDest = "";` line. Delete the `if (repo.primary) primaryDest = dest;` line at the end of the loop body. Delete the whole trailing block — the comment at lines 265-270 plus:

```typescript
    if (primaryDest === "") {
      throw new StepError("cloning", "no repo was marked primary, so setup commands have nowhere to run");
    }
    return primaryDest;
```

Keep the `ensureWorkspace` call from Task 3, the `log.info` calls, and the `syncOrClone` failure handling exactly as they are. The `primary: repo.primary` field in the per-repo `log.info` at line 241 stays — it is still useful diagnostics.

- [ ] **Step 4: Call the resolver in `boot`**

In `boot`, replace these two lines (190-191):

```typescript
      const primaryDest = await this.syncRepos(manifest);
      await this.runSetup(manifest, primaryDest);
```

with:

```typescript
      // Before the clone, so a manifest with no primary repo fails having done
      // nothing rather than after pulling every repo over the network.
      const workingDirectory = resolveWorkingDirectory(manifest, this.deps.workspaceRoot);
      await this.syncRepos(manifest);
      await this.runSetup(manifest, workingDirectory);
```

Then update the two later uses in `boot` (lines 198-199) from `primaryDest` to `workingDirectory`:

```typescript
      const config = adapter.buildAgentConfig(manifest, workingDirectory);
      log.info("boot step: starting A2A server", { workingDirectory });
```

- [ ] **Step 5: Call the resolver in `prepareWorkspace`**

In `prepareWorkspace`, replace these two lines (128-129):

```typescript
      const primaryDest = await this.syncRepos(manifest, "prepare");
      await this.runSetup(manifest, primaryDest, "prepare");
```

with:

```typescript
      const workingDirectory = resolveWorkingDirectory(manifest, this.deps.workspaceRoot);
      await this.syncRepos(manifest, "prepare");
      await this.runSetup(manifest, workingDirectory, "prepare");
```

- [ ] **Step 6: Rename the `runSetup` parameter**

`runSetup` (line 277) takes a parameter named `primaryDest`, which is now wrong — with no repos it is the workspace root. Rename it and the two uses in its body:

```typescript
  private async runSetup(manifest: WorkspaceManifest, cwd: string, phase: Phase = "boot"): Promise<void> {
    this.lifecycle.set("setup");
    // Setup commands run WITH working git and gh, because the credential config
    // is already in place. See describeSetupFailure: their output is redacted
    // before it leaves this process.
    log.info(`${phase} step: running setup commands`, { count: manifest.setup_commands.length, cwd });
    const setup = await this.deps.runSetupCommands(cwd, manifest.setup_commands);
```

Leave the rest of the method body unchanged.

- [ ] **Step 7: Run the tests and typecheck**

Run: `npx vitest run packages/core && npm run typecheck`

Expected: PASS. Every existing test keeps passing — this task changes structure, not behaviour, for any manifest with a primary repo.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/task-run.ts packages/core/src/task-run.test.ts
git commit -m "refactor(core): resolve the working directory outside the clone loop"
```

---

### Task 5: End-to-end zero-repo behaviour

**Files:**
- Test: `packages/core/src/task-run.test.ts`
- Test: `packages/core/src/control/server.test.ts`

No production code should change in this task. If a test here fails, the fix belongs in Tasks 1-4 — say so rather than patching the test to match.

- [ ] **Step 1: Write the boot-path tests**

Add to `packages/core/src/task-run.test.ts`, inside `describe("TaskRun", ...)`:

```typescript
  it("boots a zero-repo manifest and runs the agent in the workspace root", async () => {
    const d = deps();
    const claude = adapter();
    const tr = new TaskRun(d, { claude });
    const r = await tr.initialise({ repos: [], agent: { platform: "claude" } });
    expect(r).toEqual({ ok: true, status: "booting" });
    await settle();
    expect(tr.lifecycle.status().state).toBe("ready");
    expect(d.syncOrClone).not.toHaveBeenCalled();
    expect(d.ensureWorkspace).toHaveBeenCalledWith("/home/user/workspace");
    expect(claude.buildAgentConfig).toHaveBeenCalledWith(expect.anything(), "/home/user/workspace");
  });

  it("runs a zero-repo manifest's setup commands in the workspace root", async () => {
    const d = deps();
    const tr = new TaskRun(d, { claude: adapter() });
    await tr.initialise({ repos: [], agent: { platform: "claude" }, setup_commands: ["mise install"] });
    await settle();
    expect(d.runSetupCommands).toHaveBeenCalledWith("/home/user/workspace", ["mise install"]);
  });

  it("prepares a zero-repo manifest and still wipes credentials", async () => {
    const d = deps();
    const tr = new TaskRun(d, { claude: adapter() });
    const r = await tr.prepare({ repos: [], setup_commands: ["mise install"] });
    expect(r).toEqual({ ok: true, status: "booting" });
    await settle();
    expect(tr.lifecycle.status().state).toBe("prepared");
    expect(d.runSetupCommands).toHaveBeenCalledWith("/home/user/workspace", ["mise install"]);
    expect(d.deleteCredentialConfig).toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run them**

Run: `npx vitest run packages/core/src/task-run.test.ts -t "zero-repo"`

Expected: PASS, 3 tests. If `prepare` is named differently on `TaskRun`, read the class and use the real method name — check with `grep -n "async prepare\|async initialise" packages/core/src/task-run.ts`.

- [ ] **Step 3: Clarify the misleading existing test**

`packages/core/src/control/server.test.ts:32` reads:

```typescript
  it("POST /api/initialise bad manifest → 400 list", async () => {
    const res = await request(app()).post("/api/initialise").send({ repos: [] });
```

This still passes — but for a different reason than before. The 400 now comes from the missing `agent` block, not the empty repo list. Rename it so the next reader is not misled into thinking an empty list is still rejected:

```typescript
  it("POST /api/initialise missing agent block → 400 list", async () => {
    const res = await request(app()).post("/api/initialise").send({ repos: [] });
```

Leave the body and assertions unchanged.

- [ ] **Step 4: Add the HTTP-level tests**

Add to `packages/core/src/control/server.test.ts`, inside `describe("control server", ...)`, after the existing `POST /api/initialise valid → 202 booting` test:

```typescript
  it("POST /api/initialise with repos: [] → 202 booting", async () => {
    const res = await request(app()).post("/api/initialise").send({ repos: [], agent: { platform: "claude" } });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: "booting" });
  });

  it("POST /api/prepare with repos: [] → 202 booting", async () => {
    const res = await request(app()).post("/api/prepare").send({ repos: [] });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: "booting" });
  });
```

Note that `app()` builds a fresh `TaskRun` per call, which matters because a `TaskRun` accepts only one initialise. If the prepare test fails on the response shape, read the existing `POST /api/prepare valid → 202 booting` test just below line 58 and match its assertions exactly — it is the authority on what that route returns.

- [ ] **Step 5: Run the whole suite**

Run: `npm test -- --force`

Expected: PASS. `--force` bypasses the Turborepo cache so every package genuinely re-executes.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/task-run.test.ts packages/core/src/control/server.test.ts
git commit -m "test(core): cover zero-repo boot, prepare and routes"
```

---

### Task 6: Changeset

**Files:**
- Create: `.changeset/zero-repo-manifests.md`

- [ ] **Step 1: Write the changeset**

`@throng/agent-core` gains behaviour and `BootDeps` gains a required member, so this is a `minor` with a breaking note for direct `BootDeps` constructors — the same shape as `.changeset/project-snapshots-prepare.md`.

Create `.changeset/zero-repo-manifests.md`:

```markdown
---
"@throng/agent-core": minor
---

Accept an empty `repos` list on `/api/initialise` and `/api/prepare`, so a task can boot into an empty
workspace. Whether a task needs a repository is the consumer's decision: an agent asked to create a new
project from scratch — scaffold it, `git init` it, create the remote — has nothing to clone, and until
now could not be booted at all.

`repos` remains a required key and must still be a list; only emptiness becomes legal. An absent `repos`
is still `{"repos", "is required"}`, so a control plane that drops the field fails loudly rather than
silently booting an agent with nothing checked out. The exactly-one-`primary` rule now applies only to a
non-empty list — with no repos there is nothing for it to choose between. Both routes change together,
because `validate` and `validatePrepare` share every repo rule precisely so a snapshot build and the
task boot that restores from it cannot disagree about what a repo list means; a zero-repo prepare is a
legitimate way to warm a toolchain cache into a snapshot from `setup_commands` alone.

With no repos, the agent's working directory and the `setup_commands` cwd are the workspace root
(`$HOME/workspace`, or `WORKSPACE_DIR`). A repository the agent creates there lands in the same layout a
later task's manifest expects. For Claude, `settingSources: ["project"]` then finds no `CLAUDE.md` and no
`.claude/settings.json`, because there is no project yet.

Working-directory resolution moves out of the clone loop into a new exported
`resolveWorkingDirectory(manifest, workspaceRoot)`, which returns the primary repo's destination or the
workspace root. It also now runs *before* the clone rather than after it, so a non-empty manifest with no
primary repo fails having done nothing instead of after fetching every repo over the network. No
reachable input changes: validation rejects such a manifest on both routes.

Nothing else relaxes. `repos[].dest` still rejects `"."`, the `credentials` and `github_token` rules are
untouched, and a non-array `repos` is still a `400`.

**Breaking (consumers constructing `BootDeps` directly):** `BootDeps` gains a required
`ensureWorkspace: (dir: string) => void`, called unconditionally before the clone loop.
`defaultBootDeps()` supplies `mkdirSync(dir, { recursive: true })`. It is needed because nothing else
creates the workspace root — the directory has only ever existed as a side effect of `git clone`
creating its destination's parents, which no longer happens when there are no repos. It is a dep rather
than a direct `mkdirSync` so a caller can point the runtime at a workspace it manages itself, and so the
test suite's fake workspace root stays inert.
```

- [ ] **Step 2: Verify the changeset parses**

Run: `npx changeset status`

Expected: it lists `@throng/agent-core` as bumping `minor`. If the command errors on the frontmatter, fix the package name to match `packages/core/package.json`'s `name` field exactly.

- [ ] **Step 3: Full verification**

Run: `npm run build && npm run typecheck && npm test -- --force`

Expected: all three PASS.

- [ ] **Step 4: Commit**

```bash
git add .changeset/zero-repo-manifests.md
git commit -m "chore: changeset for zero-repo manifests"
```

---

## Definition of done

- `repos: []` is accepted on both routes; an absent or non-array `repos` is still a 400.
- A non-empty list still requires exactly one `primary: true`.
- A zero-repo initialise reaches `ready` with the agent's working directory set to the workspace root, and never calls `syncOrClone`.
- A zero-repo prepare reaches `prepared` and still wipes credentials.
- `ensureWorkspace` is called for every manifest, and a failure fails the boot at the `cloning` step.
- `resolveWorkingDirectory` is exported and unit-tested for all three cases.
- `npm run build`, `npm run typecheck` and `npm test -- --force` all pass.
- A changeset exists describing the behaviour change and the `BootDeps` break.
