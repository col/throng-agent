# Project Snapshots — Agent Side (`/api/prepare`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a sandbox warm a project's workspace — repos cloned, `setup_commands` run — without initialising an agent, so the control plane can snapshot the result and boot every task in that project from it.

**Architecture:** Two changes in `packages/core`, both no-ops for existing boots. `bootstrap/git.ts` gains `syncOrClone(url, dest, ref)`, which clones when `dest` is absent and fetch/checkout/resets when it is already the right work tree — so a restored snapshot survives the clone step, which `git clone <url> <dest>` cannot. `TaskRun` gains `prepare()` behind a new `POST /api/prepare`: it runs the same credential-write / sync / setup steps `boot()` runs (literally the same private methods, so the two paths cannot drift), then deletes the credential config and the token cache and settles at a new terminal lifecycle state, `prepared`. `/api/initialise`'s one-shot guard relaxes to allow exactly one initialise from `prepared`.

**Tech Stack:** TypeScript (ESM, `NodeNext`, `strict`), Vitest, npm workspaces + Turborepo, Changesets.

**Spec:** §5 of `/Users/col/projects/throng_platform/throngx/docs/superpowers/specs/2026-08-06-project-snapshots-design.md` (control-plane repo). The control-plane half is `throngx` PR #112, branch `feat/project-snapshots`.

---

## Orientation for the implementer

You are working in `/Users/col/projects/throng_platform/throng_agent` on branch
`feat/project-snapshots-prepare`. It is an npm-workspaces monorepo:

| Path | Package |
| --- | --- |
| `packages/core` | `@throng/agent-core` — manifest validation, control API, lifecycle, git/setup bootstrap |
| `throng-agent-claude` | `throng-agent-claude` — Claude engine adapter |
| `throng-agent-codex` | `throng-agent-codex` — Codex engine adapter |
| `throng-agent` | `throng-agent` — the deployable app that wires adapters into a registry |

**Running tests.** Core's own tests need no build:

```bash
npm test -w @throng/agent-core                 # all of core
npm test -w @throng/agent-core -- git          # filters by filename substring
```

The adapter and app packages import `@throng/agent-core` through its **built
`dist/`**, so core must be rebuilt before their tests see a new export. Turbo
handles that via `dependsOn: ["^build"]` — always use the turbo form for them:

```bash
npx turbo run test --filter=throng-agent
npm test                                       # everything
npm run typecheck                              # everything
```

**Style notes from the existing code, which you should match.** Validators
accumulate `FieldError[]` and return them all at once rather than throwing on the
first problem — a caller with two bad fields gets one complete `400`. Guards test
*presence*, not truthiness (`"agent" in input`), so an explicit `null` is caught
rather than waved through. Non-null assertions (`!`) are not used; narrow with a
guard instead. Comments explain *why*, not *what*, and are used where a decision
is non-obvious — this codebase comments heavily and you should too, but only
where there is a real reason to record.

**The wire contract you are building against.** `Throng.Agents.Manifest.Resolve.prepare_payload/2`
produces exactly this today. Keys whose value is `nil` are dropped entirely:

```json
{
  "repos": [
    { "url": "https://github.com/acme/web.git", "ref": "main", "dest": "web", "primary": true }
  ],
  "setup_commands": ["mise install", "mix deps.get"],
  "credentials": { "url": "https://…/api/credentials", "token": "<instance identity token>" },
  "github_token": null
}
```

Exactly one of `credentials` and `github_token` is ever present — the pull model
in production, a static installation token in dev and test. There is no `agent`
block and no `user_identity`, and their absence is load-bearing: a snapshot is
shared by every task in the project and is stored by E2B, so no task-specific
configuration and no LLM credential may be baked into one.

**What the control plane does with the responses.** `Throng.Agents.Control.prepare/3`
POSTs to `/api/prepare` and maps **both 202 and 409** to `:ok`, because its Oban
retry must be safe to run twice. `Control.HTTP`'s `@states` map decodes
`"prepared"` → `:prepared`, and the boot poller maps that to a healthy idle
instance. The snapshot is taken only once the agent reports `prepared`.

---

## Four places this plan follows the code rather than the spec

Report these back; §5 was written before either half existed.

1. **`git reset --hard origin/<ref>` is conditional, not unconditional.** `ref` is
   a free-form string. A tag or a SHA has no `origin/<ref>`, so an unconditional
   reset would fail the boot for any task not using a branch. Task 1 gates it on
   `git rev-parse --verify origin/<ref>` resolving; a non-branch ref gets
   fetch + checkout and no reset, which is exactly today's behaviour.
2. **The sync branch's checkout is `git checkout -f`.** `mix deps.get` and
   `npm ci` rewrite *tracked* lockfiles, so a restored snapshot normally has a
   dirty work tree, and plain `git checkout <ref>` aborts rather than switch
   branches over conflicting local edits. `-f` discards modifications to *tracked*
   files only; it does not touch untracked files, so the no-`git clean` rule the
   spec insists on is intact and `_build`/`deps`/`node_modules` survive.
3. **"a work tree whose `origin` matches `url`" is a normalised compare.** A bare
   string compare treats `…/web` and `…/web.git` as a mismatch and throws the
   whole snapshot away. Task 1 compares with userinfo, trailing `/` and trailing
   `.git` stripped.
4. **`user_identity` is rejected by `/api/prepare`, not ignored.** The spec only
   requires rejecting `agent`. Same rule and same reason: a prepare manifest
   carrying an initialise-only field is an initialise manifest sent to the wrong
   route, and a `git config --global` write is exactly what §4 keeps out of a
   shared image. `prepare_payload/2` never sends it, so this cannot break the real
   caller. It is one `if` in Task 4 if you'd rather it were ignored.

---

## File structure

**Create**

- `packages/core/src/bootstrap/git-sync.test.ts` — `syncOrClone` against real git
  repositories in temp dirs. Its own file rather than growing `git.test.ts`:
  `syncOrClone` needs fixtures (a source repo that gains commits, untracked build
  output, a mismatched remote) that the two-case `clone`/`checkout` suite does not.

**Modify**

- `packages/core/src/bootstrap/git.ts` — add `syncOrClone`; add an optional `op`
  to the failure variant of `GitResult`.
- `packages/core/src/lifecycle.ts` — add `prepared` to `LifecycleState`.
- `packages/core/src/lifecycle.test.ts` — pin `prepared` as a reportable state.
- `packages/core/src/creds/config.ts` — add `credsCachePath()` and
  `deleteCredentialConfig()`; widen `writeCredentialConfig` to a `WorkspaceManifest`.
- `packages/core/src/creds/config.test.ts` — cover both.
- `packages/core/src/manifest/types.ts` — add `WorkspaceManifest`, make
  `BaseManifest` extend it, add `PrepareValidateResult`.
- `packages/core/src/manifest/validate.ts` — extract the workspace half of
  `validate()` into shared helpers; add `validatePrepare()`. One file keeps
  owning manifest validation, which is what makes "one implementation serves both
  routes" structural rather than a convention.
- `packages/core/src/manifest/validate.test.ts` — add a `validatePrepare` suite.
- `packages/core/src/task-run.ts` — `BootDeps` swaps `clone`/`checkout` for
  `syncOrClone` and gains `deleteCredentialConfig`; `boot()` splits into three
  private steps that `prepare()` reuses; `initialise()`'s guard relaxes; new
  `prepare()`.
- `packages/core/src/task-run.test.ts` — update the fake deps; add prepare suites.
- `packages/core/src/control/server.ts` — `POST /api/prepare`; `defaultBootDeps`
  wires `syncOrClone` and `deleteCredentialConfig`.
- `packages/core/src/control/server.test.ts` — update the fake deps; add route cases.
- `packages/core/src/index.ts` — export the new surface.
- `throng-agent/src/integration/boot.test.ts` — update the fake deps.
- `README.md` — document `/api/prepare`, `prepared`, and the credential wipe.
- `.changeset/project-snapshots-prepare.md` — new changeset.

---

## Task 1: `syncOrClone`

**Files:**
- Modify: `packages/core/src/bootstrap/git.ts`
- Create: `packages/core/src/bootstrap/git-sync.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/bootstrap/git-sync.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { syncOrClone } from "./git.js";

const tmpRoots: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "a2a-sync-"));
  tmpRoots.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpRoots) execFileSync("rm", ["-rf", d]);
});

/** A source repo on `main` with one commit. Served over file:// like git.test.ts. */
function makeSourceRepo(): string {
  const dir = tmp();
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir });
  git("init", "-q");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), "one");
  git("add", "-A");
  git("commit", "-qm", "one");
  git("branch", "-M", "main");
  return dir;
}

function commitTo(src: string, content: string): void {
  const git = (...a: string[]) => execFileSync("git", a, { cwd: src });
  writeFileSync(join(src, "README.md"), content);
  git("add", "-A");
  git("commit", "-qm", content);
}

const readme = (dest: string) => readFileSync(join(dest, "README.md"), "utf8");
const originOf = (dest: string) =>
  execFileSync("git", ["config", "--get", "remote.origin.url"], { cwd: dest }).toString().trim();

/** Untracked build output plus a locally modified tracked file — what a prepared
 *  snapshot's work tree actually looks like when a task boots from it. */
function dirtyWorkspace(dest: string): void {
  mkdirSync(join(dest, "_build"), { recursive: true });
  writeFileSync(join(dest, "_build", "artifact"), "compiled");
  writeFileSync(join(dest, "README.md"), "locally modified");
}

describe("syncOrClone (dest absent)", () => {
  it("clones and checks out the ref", async () => {
    const src = makeSourceRepo();
    execFileSync("git", ["checkout", "-qb", "feature"], { cwd: src });
    commitTo(src, "on-feature");
    execFileSync("git", ["checkout", "-q", "main"], { cwd: src });
    const dest = join(tmp(), "web");

    const r = await syncOrClone(`file://${src}`, dest, "feature");

    expect(r.ok).toBe(true);
    expect(readme(dest)).toBe("on-feature");
  });

  it("returns a failure result (never throws) on a bad ref", async () => {
    const src = makeSourceRepo();
    const dest = join(tmp(), "web");

    const r = await syncOrClone(`file://${src}`, dest, "no-such-ref");

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).not.toBe(0);
      expect(r.op).toBe("checkout");
    }
  });
});

describe("syncOrClone (dest is the same repo)", () => {
  // The whole point of the feature: the untracked build output IS the speedup,
  // so `reset --hard` must bring the tracked tree up to date without touching it.
  it("fetches and resets to origin without removing untracked build output", async () => {
    const src = makeSourceRepo();
    const dest = join(tmp(), "web");
    await syncOrClone(`file://${src}`, dest, "main");
    dirtyWorkspace(dest);
    commitTo(src, "two");

    const r = await syncOrClone(`file://${src}`, dest, "main");

    expect(r.ok).toBe(true);
    expect(readme(dest)).toBe("two");
    expect(readFileSync(join(dest, "_build", "artifact"), "utf8")).toBe("compiled");
  });

  // A ".git" suffix, a trailing slash or an embedded credential are all the same
  // remote. Treating them as a mismatch would delete the workspace and re-clone
  // it, which is precisely the cost this feature exists to avoid.
  it("treats a .git suffix as the same remote rather than re-cloning", async () => {
    const src = makeSourceRepo();
    const dest = join(tmp(), "web");
    await syncOrClone(`file://${src}`, dest, "main");
    writeFileSync(join(dest, "marker"), "survives");

    const r = await syncOrClone(`file://${src}.git`, dest, "main");

    expect(r.ok).toBe(true);
    expect(existsSync(join(dest, "marker"))).toBe(true);
  });

  // `ref` is a free-form string: a tag or SHA has no origin/<ref>, so the reset
  // is skipped rather than failing the boot. Checkout has already put the work
  // tree at an exact commit by then.
  it("checks out a tag without failing on the missing origin/<ref>", async () => {
    const src = makeSourceRepo();
    execFileSync("git", ["tag", "v1"], { cwd: src });
    const dest = join(tmp(), "web");
    await syncOrClone(`file://${src}`, dest, "main");
    writeFileSync(join(dest, "marker"), "survives");

    const r = await syncOrClone(`file://${src}`, dest, "v1");

    expect(r.ok).toBe(true);
    expect(existsSync(join(dest, "marker"))).toBe(true);
    expect(readme(dest)).toBe("one");
  });
});

describe("syncOrClone (dest exists but is not this repo)", () => {
  it("removes a work tree pointing at a different remote and clones fresh", async () => {
    const a = makeSourceRepo();
    const b = makeSourceRepo();
    commitTo(b, "from-b");
    const dest = join(tmp(), "web");
    await syncOrClone(`file://${a}`, dest, "main");
    writeFileSync(join(dest, "stale"), "x");

    const r = await syncOrClone(`file://${b}`, dest, "main");

    expect(r.ok).toBe(true);
    expect(existsSync(join(dest, "stale"))).toBe(false);
    expect(readme(dest)).toBe("from-b");
    expect(originOf(dest)).toBe(`file://${b}`);
  });

  it("removes a plain directory in the way and clones fresh", async () => {
    const src = makeSourceRepo();
    const dest = join(tmp(), "web");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "stale"), "x");

    const r = await syncOrClone(`file://${src}`, dest, "main");

    expect(r.ok).toBe(true);
    expect(existsSync(join(dest, "stale"))).toBe(false);
    expect(readme(dest)).toBe("one");
  });

  // Guards against resolving the origin from an ENCLOSING repository: `git config
  // --get remote.origin.url` walks up, so a plain directory inside a checkout
  // would otherwise report its parent's remote and be treated as a match.
  it("does not mistake a subdirectory of another repo for a work tree", async () => {
    const src = makeSourceRepo();
    const outer = makeSourceRepo();
    execFileSync("git", ["remote", "add", "origin", `file://${src}`], { cwd: outer });
    const dest = join(outer, "web");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "stale"), "x");

    const r = await syncOrClone(`file://${src}`, dest, "main");

    expect(r.ok).toBe(true);
    expect(existsSync(join(dest, "stale"))).toBe(false);
    expect(existsSync(join(dest, ".git"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @throng/agent-core -- git-sync`
Expected: FAIL — `syncOrClone` is not exported by `./git.js`.

- [ ] **Step 3: Implement `syncOrClone`**

In `packages/core/src/bootstrap/git.ts`, change the imports and the `GitResult`
type at the top of the file:

```ts
import { execFile } from "node:child_process";
import { existsSync, realpathSync, rmSync } from "node:fs";

/**
 * `op` names the git subcommand that failed, so a caller can say which step of a
 * multi-command sync went wrong. Optional: the single-command helpers below have
 * only one answer and do not set it.
 */
export type GitResult =
  | { ok: true; output: string }
  | { ok: false; code: number; output: string; op?: string };
```

Then append to the end of the file:

```ts
/**
 * Bring `dest` to `ref` from `url`, whether or not `dest` already exists.
 *
 * `clone` alone cannot: it fails outright when `dest` exists, and on a sandbox
 * restored from a project snapshot `dest` always exists. One implementation
 * serves both `/api/prepare` and `/api/initialise`, so a snapshot build and the
 * task boot that restores from it cannot drift.
 *
 * | dest                                | action |
 * | ---                                 | --- |
 * | absent                              | clone, then checkout — today's behaviour |
 * | a work tree whose origin is `url`   | fetch · checkout · reset --hard origin/<ref> |
 * | anything else                       | remove it, then clone fresh |
 *
 * Deliberately no `git clean`. The untracked `_build`, `deps` and `node_modules`
 * a snapshot build leaves behind are the entire point of the snapshot; cleaning
 * them throws away the speedup this exists to deliver.
 */
export async function syncOrClone(url: string, dest: string, ref: string): Promise<GitResult> {
  if (!existsSync(dest)) return cloneFresh(url, dest, ref);

  const origin = await worktreeOrigin(dest);
  if (origin !== null && sameRemote(origin, url)) return sync(dest, ref);

  // Not this repository: a stale directory from a previous project layout, a
  // repo that was re-pointed at a different remote, or a plain directory in the
  // way. `dest` is always `workspaceRoot` + a validated relative path with no
  // `..` segments (see validateRepos), so this cannot escape the workspace.
  try {
    rmSync(dest, { recursive: true, force: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, code: 1, op: "remove", output: `could not remove ${dest}: ${message}` };
  }
  return cloneFresh(url, dest, ref);
}

async function cloneFresh(url: string, dest: string, ref: string): Promise<GitResult> {
  const cloned = await clone(url, dest);
  if (!cloned.ok) return { ...cloned, op: "clone" };
  const checked = await checkout(dest, ref);
  return checked.ok ? checked : { ...checked, op: "checkout" };
}

async function sync(dest: string, ref: string): Promise<GitResult> {
  // `origin`, not `url`: they are the same remote by the time we get here, and
  // the stored one is what the work tree's refs are already tracking.
  const fetched = await run(["fetch", "origin"], { cwd: dest, env: noPrompt() });
  if (!fetched.ok) return { ...fetched, op: "fetch" };

  // `-f` because a prepared workspace is normally dirty: `mix deps.get` and
  // `npm ci` rewrite tracked lockfiles, and a plain checkout refuses to switch
  // branches over them. It discards modifications to TRACKED files only —
  // untracked build output is untouched, which is what keeps the no-`git clean`
  // rule true.
  const checked = await run(["checkout", "-f", ref], { cwd: dest, env: noPrompt() });
  if (!checked.ok) return { ...checked, op: "checkout" };

  // `ref` is a free-form string. A tag or a SHA has no `origin/<ref>`, and the
  // checkout above has already put the work tree at an exact commit, so the
  // reset is skipped rather than failing the whole boot on a ref that is not a
  // branch. `--quiet` suppresses the "unknown revision" line; `^{commit}` keeps
  // a same-named file or directory from resolving.
  const upstream = `origin/${ref}`;
  const resolved = await run(["rev-parse", "--verify", "--quiet", `${upstream}^{commit}`], { cwd: dest });
  if (!resolved.ok) return checked;

  const reset = await run(["reset", "--hard", upstream], { cwd: dest, env: noPrompt() });
  return reset.ok ? reset : { ...reset, op: "reset" };
}

/**
 * The origin URL of the work tree rooted exactly at `dest`, or null when `dest`
 * is not one.
 *
 * The top-level check is not redundant with reading the config: both `rev-parse`
 * and `config --get` walk UP from `cwd`, so a plain directory inside a checkout
 * would otherwise report the enclosing repository's remote and be treated as a
 * match — leaving a directory that has no `.git` of its own where a clone should be.
 */
async function worktreeOrigin(dest: string): Promise<string | null> {
  const top = await run(["rev-parse", "--show-toplevel"], { cwd: dest });
  if (!top.ok) return null;
  try {
    // realpath both sides: `--show-toplevel` prints the physical path, and on
    // macOS the temp directories these tests run in are reached through a symlink.
    if (realpathSync(top.output.trim()) !== realpathSync(dest)) return null;
  } catch {
    return null;
  }
  const origin = await run(["config", "--get", "remote.origin.url"], { cwd: dest });
  if (!origin.ok) return null;
  return origin.output.trim() || null;
}

const sameRemote = (a: string, b: string): boolean => normaliseRemote(a) === normaliseRemote(b);

/**
 * Two spellings of one remote compare equal: `…/web` and `…/web.git` are the
 * same repository, and a credential-in-URL form
 * (`https://x-access-token:ghs_…@github.com/…`) is still legal input. A false
 * mismatch is expensive — it deletes the workspace and clones from scratch,
 * which is exactly the cost a snapshot exists to avoid.
 */
function normaliseRemote(url: string): string {
  return url
    .trim()
    .replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/@]*@/, "$1")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w @throng/agent-core -- git`
Expected: PASS — both `git.test.ts` and `git-sync.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/bootstrap/git.ts packages/core/src/bootstrap/git-sync.test.ts
git commit -m "feat(git): add syncOrClone for workspaces that may already exist"
```

---

## Task 2: The `prepared` lifecycle state

**Files:**
- Modify: `packages/core/src/lifecycle.ts:1`
- Modify: `packages/core/src/lifecycle.test.ts`

- [ ] **Step 1: Write the failing test**

Append to the `describe("Lifecycle", …)` block in `packages/core/src/lifecycle.test.ts`:

```ts
  // `prepared` is a terminal REST state, not a failure state: a snapshot is taken
  // here, and the sandbox restored from it still accepts one /api/initialise.
  // GET /api/status has to report it, because the control plane's poller is what
  // decides the snapshot is ready to capture.
  it("reports prepared as a plain state, with no error", () => {
    const l = new Lifecycle();
    l.set("prepared");
    expect(l.status()).toEqual({ state: "prepared" });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @throng/agent-core -- lifecycle`
Expected: FAIL — a type error on `l.set("prepared")` (`"prepared"` is not assignable to the parameter type).

- [ ] **Step 3: Add the state**

In `packages/core/src/lifecycle.ts`, line 1:

```ts
export type LifecycleState =
  | "uninitialised"
  | "booting"
  | "cloning"
  | "setup"
  | "prepared"
  | "ready"
  | "failed";
```

`set()` already accepts every state but `failed`, so nothing else changes.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w @throng/agent-core -- lifecycle`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/lifecycle.ts packages/core/src/lifecycle.test.ts
git commit -m "feat(lifecycle): add the terminal prepared state"
```

---

## Task 3: `deleteCredentialConfig`

The security boundary. The snapshot is stored by E2B and every task in the
project boots from it, so the credential config and every token `throng-creds`
minted from it must be gone before the image is captured.

**Files:**
- Modify: `packages/core/src/creds/config.ts`
- Modify: `packages/core/src/creds/config.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/creds/config.test.ts`:

```ts
describe("credsCachePath", () => {
  const originalCache = process.env.THRONG_CREDS_CACHE;
  const originalHome = process.env.HOME;
  afterEach(() => {
    if (originalCache === undefined) delete process.env.THRONG_CREDS_CACHE;
    else process.env.THRONG_CREDS_CACHE = originalCache;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  // Must agree with throng-creds.sh's ${THRONG_CREDS_CACHE:-$HOME/.throng/cache}:
  // the runtime deletes what the helper writes, and a disagreement would leave
  // live tokens in the snapshot while every test still passed.
  it("defaults to $HOME/.throng/cache", () => {
    delete process.env.THRONG_CREDS_CACHE;
    process.env.HOME = "/home/user";

    expect(credsCachePath()).toBe("/home/user/.throng/cache");
  });

  it("honours THRONG_CREDS_CACHE, and treats a blank value as unset", () => {
    process.env.HOME = "/home/user";
    process.env.THRONG_CREDS_CACHE = "/mnt/cache";
    expect(credsCachePath()).toBe("/mnt/cache");
    process.env.THRONG_CREDS_CACHE = "";
    expect(credsCachePath()).toBe("/home/user/.throng/cache");
  });
});

describe("deleteCredentialConfig", () => {
  function populated(): { config: string; cache: string } {
    const dir = mkdtempSync(join(tmpdir(), "throng-wipe-"));
    const config = join(dir, ".throng", "config.json");
    const cache = join(dir, ".throng", "cache");
    writeCredentialConfig(manifest({ credentials: { url: "https://cp", token: "tok" } }), config);
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "git_github.com_acme_app"), "9999999999\nkey\nusername=x\npassword=ghs_live\n");
    return { config, cache };
  }

  it("removes the config file and the whole cache directory", () => {
    const { config, cache } = populated();

    deleteCredentialConfig(config, cache);

    expect(existsSync(config)).toBe(false);
    expect(existsSync(cache)).toBe(false);
  });

  // Called on the failure path too, and a second call must not turn a failed
  // prepare into a different error.
  it("is a no-op when there is nothing to delete", () => {
    const { config, cache } = populated();
    deleteCredentialConfig(config, cache);

    expect(() => deleteCredentialConfig(config, cache)).not.toThrow();
  });

  // Same rm -rf on the same operator-supplied variable that throng-creds.sh's
  // check_cache_dir guards, so it refuses the same values. A refusal must leave
  // the config in place rather than half-wiping: the caller turns the throw into
  // a failed prepare, and a half-wipe would be reported as a success.
  it.each([
    ["a relative path", () => "relative/cache"],
    ["the filesystem root", () => "/"],
    ["a top-level directory", () => "/cache"],
    ["a path containing ..", () => "/home/user/../cache"],
    ["/dev/shm", () => "/dev/shm"],
  ])("refuses %s and deletes nothing", (_label, cacheFor) => {
    const { config } = populated();

    expect(() => deleteCredentialConfig(config, cacheFor())).toThrow(/refusing/);
    expect(existsSync(config)).toBe(true);
  });

  it("refuses $HOME, the config directory and the workspace", () => {
    const { config } = populated();
    const home = dirname(dirname(config));
    const savedHome = process.env.HOME;
    const savedWorkspace = process.env.WORKSPACE_DIR;
    process.env.HOME = home;
    delete process.env.WORKSPACE_DIR;
    try {
      expect(() => deleteCredentialConfig(config, home)).toThrow(/\$HOME/);
      expect(() => deleteCredentialConfig(config, dirname(config))).toThrow(/credential config/);
      expect(() => deleteCredentialConfig(config, join(home, "workspace"))).toThrow(/workspace/);
      process.env.WORKSPACE_DIR = "/mnt/work";
      expect(() => deleteCredentialConfig(config, "/mnt/work")).toThrow(/workspace/);
      expect(existsSync(config)).toBe(true);
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedWorkspace === undefined) delete process.env.WORKSPACE_DIR;
      else process.env.WORKSPACE_DIR = savedWorkspace;
    }
  });
});
```

Extend the imports at the top of that file to cover what these cases use:

```ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { credsCachePath, deleteCredentialConfig, writeCredentialConfig } from "./config.js";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @throng/agent-core -- creds/config`
Expected: FAIL — `credsCachePath` and `deleteCredentialConfig` are not exported.

- [ ] **Step 3: Implement both**

Append to `packages/core/src/creds/config.ts`:

```ts
/**
 * Where throng-creds caches the tokens it mints. Mirrors the helper's
 * `${THRONG_CREDS_CACHE:-$HOME/.throng/cache}` exactly — the runtime deletes what
 * the helper writes, and a disagreement would leave live tokens in a snapshot.
 *
 * A function, not a module constant like CONFIG_PATH: resolving `$HOME` at import
 * would throw for a consumer that sets THRONG_CONFIG and has no HOME, which is a
 * supported configuration today.
 */
export function credsCachePath(): string {
  return process.env.THRONG_CREDS_CACHE || join(homeDir(), ".throng", "cache");
}

/**
 * Removes the credential config and every token minted from it.
 *
 * This is a security boundary, not tidiness. `/api/prepare` calls it before
 * reporting `prepared`, and what it leaves behind is captured into an E2B
 * snapshot that every task in the project boots from — so a token that survives
 * here is a token shared with every future task, stored on E2B's infrastructure.
 *
 * Validates before it deletes: a refusal must not leave the config gone and the
 * cache intact, because the caller reports the throw as a failed prepare and a
 * half-wipe would then be indistinguishable from a clean one.
 */
export function deleteCredentialConfig(
  configPath = CONFIG_PATH,
  cachePath = credsCachePath(),
): void {
  assertDeletableCacheDir(cachePath, configPath);
  rmSync(configPath, { force: true });
  rmSync(cachePath, { recursive: true, force: true });
}

/**
 * The same refusals `throng-creds.sh`'s `check_cache_dir` makes, for the same
 * reason: this is an `rm -rf` on a path that comes from an operator-supplied
 * environment variable, and `${CACHE_DIR:?}` only rejects an empty value, never a
 * dangerous one. Nothing makes an arbitrary path safe; these are the values that
 * end a machine or a task.
 */
function assertDeletableCacheDir(cachePath: string, configPath: string): void {
  // Collapse repeated and trailing slashes first: every check below is a string
  // compare between two operator-supplied values, and "/cache/" has the same
  // parent as "/run/cache" until it is normalised.
  const dir = cachePath.replace(/\/{2,}/g, "/").replace(/(.)\/+$/, "$1");
  const refuse = (why: string): never => {
    throw new Error(`refusing '${cachePath}' as the credential cache directory: ${why}.`);
  };

  if (!dir.startsWith("/")) refuse("it is not an absolute path");
  const segments = dir.split("/");
  if (segments.includes(".") || segments.includes("..")) refuse("it contains '.' or '..'");
  // Two segments minimum: "/", "/cache" and "/tmp" are refused,
  // "/home/user/.throng/cache" — the default — is not.
  if (segments.length < 3) refuse("it is too close to the filesystem root");

  const same = (other: string | undefined): boolean =>
    other !== undefined && other !== "" && other.replace(/\/{2,}/g, "/").replace(/(.)\/+$/, "$1") === dir;

  if (same(process.env.HOME)) refuse("it is $HOME, which also holds the credential config and the workspace");
  if (same(dirname(configPath))) refuse("it holds the write-once credential config");
  const home = process.env.HOME;
  const workspace = process.env.WORKSPACE_DIR || (home ? join(home, "workspace") : "");
  if (same(workspace)) refuse("it is the workspace the repos were cloned into");
  if (same("/dev/shm")) refuse("it is a tmpfs mount shared with the whole sandbox");
}
```

Extend the `node:fs` import at the top of the same file:

```ts
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w @throng/agent-core -- creds/config`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/creds/config.ts packages/core/src/creds/config.test.ts
git commit -m "feat(creds): add deleteCredentialConfig for the snapshot wipe"
```

---

## Task 4: `validatePrepare`

**Files:**
- Modify: `packages/core/src/manifest/types.ts`
- Modify: `packages/core/src/manifest/validate.ts`
- Modify: `packages/core/src/manifest/validate.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/manifest/validate.test.ts`:

```ts
// The exact body Throng.Agents.Manifest.Resolve.prepare_payload/2 produces.
// Keys whose value is nil are dropped by the control plane, so github_token is
// absent here rather than null.
const preparePayload = {
  repos: [{ url: "https://github.com/acme/web.git", ref: "main", dest: "web", primary: true }],
  setup_commands: ["mise install", "mix deps.get"],
  credentials: { url: "https://cp.example/api/credentials", token: "identity-token" },
};

describe("validatePrepare", () => {
  const errorsOf = (input: unknown) => {
    const r = validatePrepare(input);
    if (r.ok) throw new Error("expected validation to fail");
    return r.errors;
  };

  // An explicit empty env, like the initialise token cases: github_token falls
  // back to GITHUB_TOKEN, so a developer with one set would otherwise fail this.
  it("accepts the control plane's prepare payload", () => {
    const r = validatePrepare(preparePayload, {});

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.repos).toEqual([
        { url: "https://github.com/acme/web.git", ref: "main", dest: "web", primary: true },
      ]);
      expect(r.manifest.setup_commands).toEqual(["mise install", "mix deps.get"]);
      expect(r.manifest.credentials).toEqual({
        url: "https://cp.example/api/credentials",
        token: "identity-token",
      });
      expect(r.manifest.github_token).toBeNull();
      // The type has no user_identity, and the built manifest must not grow one:
      // git identity is a per-task /api/initialise concern and a `git config
      // --global` write does not belong in an image shared by every task.
      expect("user_identity" in r.manifest).toBe(false);
    }
  });

  it("accepts the standalone form with a static github_token", () => {
    const { credentials, ...rest } = preparePayload;
    const r = validatePrepare({ ...rest, github_token: "ghp_static" }, {});

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.github_token).toBe("ghp_static");
      expect(r.manifest.credentials).toBeNull();
    }
  });

  // Rejected rather than ignored. A snapshot is shared by every task in the
  // project and is stored by E2B, so no agent configuration and no LLM credential
  // may be baked into one. The control plane guarantees that by construction —
  // prepare_payload/2 never references these fields — so a manifest carrying one
  // is an initialise manifest sent to the wrong route, and saying so is more
  // useful than silently building a snapshot the caller misunderstands.
  it("rejects an agent block", () => {
    const fields = errorsOf({ ...preparePayload, agent: { platform: "claude" } }).map((e) => e.field);
    expect(fields).toContain("agent");
  });

  // Presence, not truthiness: an explicit null is still a caller that thinks this
  // route takes an agent.
  it("rejects an explicitly null agent block", () => {
    expect(errorsOf({ ...preparePayload, agent: null }).map((e) => e.field)).toContain("agent");
  });

  it("rejects a user_identity block", () => {
    const fields = errorsOf({ ...preparePayload, user_identity: { name: "A", email: "a@b.c" } }).map(
      (e) => e.field,
    );
    expect(fields).toContain("user_identity");
  });

  it("applies the same repo rules as initialise", () => {
    expect(errorsOf({ ...preparePayload, repos: [] }).map((e) => e.field)).toContain("repos");
    expect(errorsOf({ repos: preparePayload.repos.map((r) => ({ ...r, primary: false })) }).map((e) => e.field))
      .toContain("repos[].primary");
    expect(errorsOf({ ...preparePayload, repos: [{ ...preparePayload.repos[0], url: "http://x/y" }] })
      .map((e) => e.field)).toContain("repos[0].url");
  });

  it("applies the same credentials and setup_commands rules as initialise", () => {
    expect(errorsOf({ ...preparePayload, credentials: { url: "https://cp/", token: "t" } })
      .map((e) => e.field)).toContain("credentials.url");
    expect(errorsOf({ ...preparePayload, setup_commands: [""] }).map((e) => e.field))
      .toContain("setup_commands");
  });

  it("rejects a non-object body", () => {
    expect(errorsOf(42).map((e) => e.field)).toEqual(["manifest"]);
  });
});
```

Update that file's import line:

```ts
import { validate, validatePrepare } from "./validate.js";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @throng/agent-core -- manifest/validate`
Expected: FAIL — `validatePrepare` is not exported.

- [ ] **Step 3: Add the types**

In `packages/core/src/manifest/types.ts`, replace the `BaseManifest` interface
with:

```ts
/**
 * The workspace half of a manifest: everything needed to put repositories and
 * their dependencies on disk, and nothing about the agent that will use them.
 *
 * `/api/prepare` sends exactly this, and a snapshot built from it is shared by
 * every task in the project — so the absence of `agent` and `user_identity` is
 * a property of the type, not a convention the two routes have to remember.
 */
export interface WorkspaceManifest {
  repos: RepoSpec[];
  /** Pull mode. Null in standalone mode, where `github_token` is used instead. */
  credentials: CredentialsConfig | null;
  /** A literal token. Takes precedence over `credentials` when both are set. */
  github_token: string | null;
  setup_commands: string[];
}

/** Engine-agnostic manifest skeleton owned by core: a workspace plus the commit
 *  identity the task's work is attributed to. */
export interface BaseManifest extends WorkspaceManifest {
  user_identity: UserIdentity;
}
```

and append, next to `ValidateResult`:

```ts
export type PrepareValidateResult =
  | { ok: true; manifest: WorkspaceManifest }
  | { ok: false; errors: FieldError[] };
```

- [ ] **Step 4: Extract the shared validation and add `validatePrepare`**

In `packages/core/src/manifest/validate.ts`, update the type import:

```ts
import type {
  BaseManifest,
  CredentialsConfig,
  FieldError,
  Manifest,
  PrepareValidateResult,
  RepoSpec,
  ValidateResult,
  WorkspaceManifest,
} from "./types.js";
```

Replace the body of `validate()` (lines 15–93) with:

```ts
export function validate(
  input: unknown,
  registry: AdapterRegistry,
  env: Env = process.env,
): ValidateResult {
  if (!isObject(input)) {
    return { ok: false, errors: [{ field: "manifest", reason: "must be a JSON object" }] };
  }
  const errors: FieldError[] = [];

  validateWorkspace(input, errors);

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

  validateUserIdentity(input.user_identity, errors);

  if (errors.length > 0) return { ok: false, errors };

  // Cross-field rules run only after all per-field checks pass.
  const repos = input.repos as Array<Record<string, unknown>>;
  const cross = crossFieldRepoErrors(repos);
  if (cross.length > 0) return { ok: false, errors: cross };

  // adapter + agentResult are defined and ok here (errors would have returned
  // above). Guard the invariant explicitly rather than assume it.
  if (!adapter || !agentResult || !agentResult.ok) {
    return { ok: false, errors: [{ field: "agent", reason: "could not be resolved" }] };
  }
  const platform = (input.agent as Record<string, unknown>).platform as string;
  return { ok: true, manifest: buildManifest(input, repos, platform, agentResult.agent, env), adapter };
}

/**
 * The `/api/prepare` manifest: a workspace and nothing else.
 *
 * Shares every per-field and cross-field rule with `validate` above, so the
 * snapshot build and the task boot that restores from it cannot disagree about
 * what a repo list means.
 */
export function validatePrepare(input: unknown, env: Env = process.env): PrepareValidateResult {
  if (!isObject(input)) {
    return { ok: false, errors: [{ field: "manifest", reason: "must be a JSON object" }] };
  }
  const errors: FieldError[] = [];

  validateWorkspace(input, errors);

  // Rejected, not ignored. A snapshot is shared by every task in the project and
  // is stored by E2B, so nothing task-specific and no LLM credential may be baked
  // into one. The control plane guarantees that by construction —
  // prepare_payload/2 never references these fields — so a manifest that carries
  // one is an initialise manifest sent to the wrong route, and a 400 says that
  // where silently ignoring it would build a snapshot the caller misunderstands.
  //
  // Presence, not truthiness: an explicit null is the same mistake.
  if ("agent" in input) {
    errors.push({
      field: "agent",
      reason: "must not be sent to /api/prepare: a snapshot is shared by every task in the project and carries no agent configuration or credential",
    });
  }
  if ("user_identity" in input) {
    errors.push({
      field: "user_identity",
      reason: "must not be sent to /api/prepare: the commit identity is injected per task by /api/initialise",
    });
  }

  if (errors.length > 0) return { ok: false, errors };

  const repos = input.repos as Array<Record<string, unknown>>;
  const cross = crossFieldRepoErrors(repos);
  if (cross.length > 0) return { ok: false, errors: cross };

  return { ok: true, manifest: buildWorkspaceManifest(input, repos, env) };
}

/** Every per-field rule both routes share. */
function validateWorkspace(input: Record<string, unknown>, errors: FieldError[]): void {
  validateRepos(input.repos, errors);

  if ("github_token" in input && typeof input.github_token !== "string") {
    errors.push({ field: "github_token", reason: "must be a string" });
  }

  validateCredentials(input.credentials, errors);

  if ("setup_commands" in input) {
    const list = input.setup_commands;
    if (!Array.isArray(list)) {
      errors.push({ field: "setup_commands", reason: "must be a list of strings" });
    } else if (!list.every((c) => typeof c === "string" && c.trim() !== "")) {
      errors.push({ field: "setup_commands", reason: "each entry must be a non-empty string" });
    }
  }
}

/** Rules that need every repo at once; run only after the per-field ones pass. */
function crossFieldRepoErrors(repos: Array<Record<string, unknown>>): FieldError[] {
  const errors: FieldError[] = [];
  const primaries = repos.filter((r) => r.primary === true).length;
  if (primaries !== 1) {
    errors.push({
      field: "repos[].primary",
      reason: `exactly one repo must be marked primary: true (got ${primaries})`,
    });
  }
  const dests = repos.map((r) => r.dest);
  if (new Set(dests).size !== dests.length) {
    errors.push({ field: "repos[].dest", reason: "dest values must be unique across repos" });
  }
  return errors;
}
```

Note the `github_token` block moved out of `validate()` into `validateWorkspace`,
and the two cross-field rules moved into `crossFieldRepoErrors`. Delete both from
`validate()`; the version above already has them removed. `validateRepos`,
`validateUserIdentity` and `validateCredentials` are unchanged.

Then replace `buildManifest` at the bottom of the file with:

```ts
function buildWorkspaceManifest(
  input: Record<string, unknown>,
  repos: Array<Record<string, unknown>>,
  env: Env,
): WorkspaceManifest {
  const specs: RepoSpec[] = repos.map((r) => ({
    url: r.url as string,
    ref: r.ref as string,
    dest: r.dest as string,
    primary: r.primary as boolean,
  }));
  const creds = isObject(input.credentials) ? input.credentials : null;
  const credentials: CredentialsConfig | null = creds
    ? { url: creds.url as string, token: creds.token as string }
    : null;
  return {
    repos: specs,
    credentials,
    github_token: blankToNil(input.github_token) ?? blankToNil(env.GITHUB_TOKEN),
    setup_commands: (input.setup_commands as string[] | undefined) ?? [],
  };
}

function buildManifest(
  input: Record<string, unknown>,
  repos: Array<Record<string, unknown>>,
  platform: string,
  agent: unknown,
  env: Env,
): Manifest {
  // A blank name/email is treated as absent, the same way a blank token is: git
  // rejects an empty ident, so passing one through would only fail later.
  const identity = isObject(input.user_identity) ? input.user_identity : {};
  const base: BaseManifest = {
    ...buildWorkspaceManifest(input, repos, env),
    user_identity: { name: blankToNil(identity.name), email: blankToNil(identity.email) },
  };
  return { ...base, platform, agent };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w @throng/agent-core -- manifest/validate`
Expected: PASS — the new `validatePrepare` suite and every existing `validate` case.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/manifest/types.ts packages/core/src/manifest/validate.ts packages/core/src/manifest/validate.test.ts
git commit -m "feat(manifest): add validatePrepare over a shared workspace validator"
```

---

## Task 5: `boot()` uses `syncOrClone`

Swaps two `BootDeps` entries for one and splits `boot()` into the steps Task 6
reuses. Behaviour is unchanged for existing boots: `dest` is always absent on a
task sandbox that did not restore from a snapshot, which is `syncOrClone`'s clone
branch.

**Files:**
- Modify: `packages/core/src/task-run.ts`
- Modify: `packages/core/src/task-run.test.ts`
- Modify: `packages/core/src/creds/config.ts:45` (widen one parameter type)
- Modify: `packages/core/src/control/server.ts:4,75-86`
- Modify: `packages/core/src/control/server.test.ts:8-15`
- Modify: `throng-agent/src/integration/boot.test.ts:23-32`

- [ ] **Step 1: Update the failing tests**

In `packages/core/src/task-run.test.ts`, replace the `clone` and `checkout`
entries of the `deps()` factory with one `syncOrClone`:

```ts
function deps(over: Partial<BootDeps> = {}): BootDeps {
  return {
    syncOrClone: vi.fn(async () => ({ ok: true, output: "" })),
    runSetupCommands: vi.fn(async () => ({ ok: true })),
    writeCredentialConfig: vi.fn(() => {}),
    injectGitIdentity: vi.fn(() => {}),
    workspaceRoot: "/home/user/workspace",
    ...over,
  };
}
```

In the same file, replace the `"writes the credential config before cloning"`
case's `clone` stub, the two redaction cases and the `"clones without a token
argument"` case with:

```ts
  it("writes the credential config before cloning", async () => {
    const order: string[] = [];
    const d = deps({
      writeCredentialConfig: vi.fn(() => void order.push("config")),
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
    await tr.initialise(okPayload);
    await settle();

    expect(order).toEqual(["config", "clone", "setup"]);
  });
```

```ts
  // Sync runs WITH credentials in place under the pull model, and its output
  // lands verbatim in the control plane's instance.error_message — the same sink
  // the setup path already redacts. `op` names which git command failed, which is
  // the only thing lost by collapsing clone and checkout into one dep.
  it.each([
    ["clone", "fatal: could not read Username for 'https://ghs_0123456789abcdefghij@github.com'"],
    ["checkout", "error: pathspec not found; remote was https://x-access-token:ghp_0123456789abcdefghij@github.com"],
  ])("redacts tokens out of a %s failure message", async (op, output) => {
    const d = deps({ syncOrClone: vi.fn(async () => ({ ok: false, code: 128, op, output })) });

    const tr = new TaskRun(d, { claude: adapter() });
    await tr.initialise(okPayload);
    await settle();

    const status = tr.lifecycle.status();
    expect(status.error?.step).toBe("cloning");
    expect(status.error?.message).toContain(`git ${op} failed`);
    expect(status.error?.message).toContain("[REDACTED]");
    expect(status.error?.message).not.toMatch(/gh[ps]_0123456789abcdefghij/);
  });

  it("syncs each repo with its url, destination and ref", async () => {
    const d = deps();
    const tr = new TaskRun(d, { claude: adapter() });
    await tr.initialise(okPayload);
    await settle();

    expect(d.syncOrClone).toHaveBeenCalledWith("https://x/y", "/home/user/workspace/y", "main");
  });
```

In `packages/core/src/control/server.test.ts`, replace the `bootDeps` literal:

```ts
const bootDeps: BootDeps = {
  syncOrClone: async () => ({ ok: true, output: "" }),
  runSetupCommands: async () => ({ ok: true }),
  writeCredentialConfig: () => {},
  injectGitIdentity: () => {},
  workspaceRoot: "/home/user/workspace",
};
```

In `throng-agent/src/integration/boot.test.ts`, replace the `fakeDeps` body:

```ts
function fakeDeps(): BootDeps {
  return {
    syncOrClone: vi.fn(async () => ({ ok: true, output: "" })),
    runSetupCommands: vi.fn(async () => ({ ok: true })),
    writeCredentialConfig: vi.fn(() => {}),
    injectGitIdentity: vi.fn(() => {}),
    workspaceRoot: "/home/user/workspace",
  };
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @throng/agent-core -- task-run`
Expected: FAIL — `syncOrClone` is not a `BootDeps` property, and the deps object
is missing the required `clone`/`checkout`.

- [ ] **Step 3: Rewrite `BootDeps` and `boot()`**

In `packages/core/src/task-run.ts`, replace the imports and `BootDeps`:

```ts
import { join } from "node:path";
import type { GitResult } from "./bootstrap/git.js";
import { describeSetupFailure, redactTokens, type SetupResult } from "./bootstrap/setup.js";
import type { AdapterRegistry, EngineAdapter, ServerHandle } from "./engine/adapter.js";
import { Lifecycle } from "./lifecycle.js";
import { log } from "./log.js";
import type { FieldError, Manifest, UserIdentity, WorkspaceManifest } from "./manifest/types.js";
import { validate } from "./manifest/validate.js";

/** Engine-agnostic boot dependencies. */
export interface BootDeps {
  /** Clone-or-resync, because a sandbox restored from a project snapshot already
   *  has every `dest` on disk and `git clone` fails outright when it does. */
  syncOrClone: (url: string, dest: string, ref: string) => Promise<GitResult>;
  runSetupCommands: (cwd: string, commands: string[]) => Promise<SetupResult>;
  writeCredentialConfig: (manifest: WorkspaceManifest) => void;
  injectGitIdentity: (identity: UserIdentity) => void;
  workspaceRoot: string;
}
```

Replace the `boot` method (lines 58–139) with the split version:

```ts
  private async boot(manifest: Manifest, adapter: EngineAdapter<any, any>): Promise<void> {
    try {
      this.writeCredentials(manifest);
      const primaryDest = await this.syncRepos(manifest);
      await this.runSetup(manifest, primaryDest);

      log.info("boot step: injecting engine credentials and commit identity");
      adapter.injectCredentials(manifest);
      // Commit identity only. GitHub auth is no longer environment-based.
      this.deps.injectGitIdentity(manifest.user_identity);

      const config = adapter.buildAgentConfig(manifest, primaryDest);
      log.info("boot step: starting A2A server", { workingDirectory: primaryDest });
      try {
        this.serverHandle = await adapter.createA2AServer(config);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const step = adapter.classifyBootError?.(err, manifest) ?? "agent";
        throw new StepError(step, message);
      }
      this.lifecycle.set("ready");
      log.info("boot complete; agent is ready");
    } catch (err) {
      this.failFrom(err);
    }
  }

  /**
   * First, and before anything touches the network: cloning authenticates through
   * throng-creds, which reads this file on every cache miss. There is no
   * per-invocation credential environment any more.
   */
  private writeCredentials(manifest: WorkspaceManifest): void {
    log.info("boot step: writing credential config", {
      mode: manifest.github_token ? "static" : manifest.credentials ? "api" : "none",
    });
    try {
      this.deps.writeCredentialConfig(manifest);
    } catch (err) {
      throw new StepError("credentials", err instanceof Error ? err.message : String(err));
    }
  }

  /** Returns the primary repo's destination — where setup commands run. */
  private async syncRepos(manifest: WorkspaceManifest): Promise<string> {
    this.lifecycle.set("cloning");
    log.info("boot step: cloning repos", { count: manifest.repos.length, workspace: this.deps.workspaceRoot });
    let primaryDest = "";
    for (const repo of manifest.repos) {
      const dest = join(this.deps.workspaceRoot, repo.dest);
      // `repos[].url` is whatever the caller sent, and the credential-in-URL
      // form (https://x-access-token:ghs_…@github.com/…) is still legal input
      // even though nothing in this runtime produces it any more. stdout leaves
      // the box, so it gets the same redaction as the failure messages below.
      log.info("cloning repo", { url: redactTokens(repo.url), ref: repo.ref, dest, primary: repo.primary });
      // The sync runs WITH credentials in place, and this message becomes the
      // control plane's `instance.error_message` — the same sink
      // describeSetupFailure redacts. git does not normally echo a
      // helper-supplied password, but the sink is kept uniformly clean rather
      // than relying on reasoning about what git might print.
      const synced = await this.deps.syncOrClone(repo.url, dest, repo.ref);
      if (!synced.ok) {
        throw new StepError(
          "cloning",
          `git ${synced.op ?? "sync"} failed for ${repo.dest} (exit ${synced.code}): ${redactTokens(synced.output).trim()}`,
        );
      }
      log.info("repo ready", { dest, ref: repo.ref });
      if (repo.primary) primaryDest = dest;
    }
    return primaryDest;
  }

  private async runSetup(manifest: WorkspaceManifest, primaryDest: string): Promise<void> {
    this.lifecycle.set("setup");
    // Setup commands run WITH working git and gh, because the credential config
    // is already in place. See describeSetupFailure: their output is redacted
    // before it leaves this process.
    log.info("boot step: running setup commands", { count: manifest.setup_commands.length, cwd: primaryDest });
    const setup = await this.deps.runSetupCommands(primaryDest, manifest.setup_commands);
    if (!setup.ok) {
      // `describeSetupFailure` carries the failing command, a decoded signal exit
      // (137 = OOM-killed, the common one) and the tail of its output — without
      // it the orchestrator only ever saw "(exit 137)" with no clue why.
      throw new StepError("setup", describeSetupFailure(setup));
    }
  }

  private failFrom(err: unknown): void {
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
```

- [ ] **Step 4: Widen `writeCredentialConfig` to a `WorkspaceManifest`**

`defaultBootDeps` hands it whatever `BootDeps` declares, which is now a
`WorkspaceManifest` — and the function only ever reads `credentials` and
`github_token`, neither of which is the part `BaseManifest` adds. In
`packages/core/src/creds/config.ts`, change the signature and the type import:

```ts
import type { WorkspaceManifest } from "../manifest/types.js";
```

```ts
export function writeCredentialConfig(manifest: WorkspaceManifest, path = CONFIG_PATH): void {
```

Every existing caller passes a `BaseManifest`, which still satisfies it.

- [ ] **Step 5: Wire the real implementation**

In `packages/core/src/control/server.ts`, change the git import on line 4 and the
`defaultBootDeps` return:

```ts
import { syncOrClone } from "../bootstrap/git.js";
```

```ts
  return {
    syncOrClone,
    runSetupCommands,
    writeCredentialConfig: (manifest) => writeCredentialConfig(manifest),
    injectGitIdentity,
    // `||` rather than `??` so a blank WORKSPACE_DIR falls back instead of
    // resolving every clone destination against "".
    workspaceRoot: process.env.WORKSPACE_DIR || join(homeDir(), "workspace"),
  };
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -w @throng/agent-core && npx turbo run test --filter=throng-agent && npm run typecheck`
Expected: PASS everywhere.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/task-run.ts packages/core/src/task-run.test.ts packages/core/src/creds/config.ts packages/core/src/control/server.ts packages/core/src/control/server.test.ts throng-agent/src/integration/boot.test.ts
git commit -m "refactor(task-run): boot through syncOrClone and split its steps"
```

---

## Task 6: `TaskRun.prepare()` and the relaxed initialise guard

**Files:**
- Modify: `packages/core/src/task-run.ts`
- Modify: `packages/core/src/task-run.test.ts`
- Modify: `packages/core/src/control/server.test.ts:8-15` (fake deps gain `deleteCredentialConfig`)
- Modify: `throng-agent/src/integration/boot.test.ts:23-32` (same)

- [ ] **Step 1: Write the failing tests**

In `packages/core/src/task-run.test.ts`, add `deleteCredentialConfig` to the
`deps()` factory:

```ts
function deps(over: Partial<BootDeps> = {}): BootDeps {
  return {
    syncOrClone: vi.fn(async () => ({ ok: true, output: "" })),
    runSetupCommands: vi.fn(async () => ({ ok: true })),
    writeCredentialConfig: vi.fn(() => {}),
    deleteCredentialConfig: vi.fn(() => {}),
    injectGitIdentity: vi.fn(() => {}),
    workspaceRoot: "/home/user/workspace",
    ...over,
  };
}
```

and append these suites:

```ts
const preparePayload = {
  repos: [{ url: "https://x/y", ref: "main", dest: "y", primary: true }],
  setup_commands: ["mise install"],
  credentials: { url: "https://cp.example/api/credentials", token: "identity-token" },
};

describe("TaskRun.prepare", () => {
  it("reaches prepared without starting an agent", async () => {
    const claude = adapter();
    const d = deps();
    const tr = new TaskRun(d, { claude });

    const r = await tr.prepare(preparePayload);
    expect(r).toEqual({ ok: true, status: "booting" });
    await settle();

    expect(tr.lifecycle.status().state).toBe("prepared");
    expect(d.syncOrClone).toHaveBeenCalledWith("https://x/y", "/home/user/workspace/y", "main");
    expect(d.runSetupCommands).toHaveBeenCalledWith("/home/user/workspace/y", ["mise install"]);
    // Nothing task-specific and no LLM credential may reach a snapshot, and the
    // A2A server must not be serving in an image every task boots from.
    expect(claude.createA2AServer).not.toHaveBeenCalled();
    expect(claude.injectCredentials).not.toHaveBeenCalled();
    expect(d.injectGitIdentity).not.toHaveBeenCalled();
  });

  // The wipe is the last thing before `prepared`, because the control plane
  // snapshots the moment it sees that state.
  it("deletes the credential config after setup and before reporting prepared", async () => {
    const order: string[] = [];
    const d = deps({
      writeCredentialConfig: vi.fn(() => void order.push("config")),
      syncOrClone: vi.fn(async () => {
        order.push("clone");
        return { ok: true, output: "" };
      }),
      runSetupCommands: vi.fn(async () => {
        order.push("setup");
        return { ok: true };
      }),
      deleteCredentialConfig: vi.fn(() => void order.push("wipe")),
    });
    const tr = new TaskRun(d, { claude: adapter() });

    await tr.prepare(preparePayload);
    await settle();

    expect(order).toEqual(["config", "clone", "setup", "wipe"]);
    expect(tr.lifecycle.status().state).toBe("prepared");
  });

  it("wipes credentials even when setup fails, and reports the failure", async () => {
    const d = deps({
      runSetupCommands: vi.fn(async () => ({
        ok: false as const,
        command: "mise install",
        code: 1,
        signal: null,
        output: "boom",
      })),
    });
    const tr = new TaskRun(d, { claude: adapter() });

    await tr.prepare(preparePayload);
    await settle();

    expect(tr.lifecycle.status().state).toBe("failed");
    expect(tr.lifecycle.status().error?.step).toBe("setup");
    expect(d.deleteCredentialConfig).toHaveBeenCalled();
  });

  // A snapshot that still has a live credential in it is worse than no snapshot,
  // so a wipe that cannot be proved to have happened fails the prepare.
  it("fails prepare when the wipe throws", async () => {
    const d = deps({
      deleteCredentialConfig: vi.fn(() => {
        throw new Error("refusing '/' as the credential cache directory: it is too close to the filesystem root.");
      }),
    });
    const tr = new TaskRun(d, { claude: adapter() });

    await tr.prepare(preparePayload);
    await settle();

    const status = tr.lifecycle.status();
    expect(status.state).toBe("failed");
    expect(status.error?.step).toBe("credentials");
    expect(status.error?.message).toContain("refusing");
  });

  it("rejects a manifest carrying an agent block", async () => {
    const tr = new TaskRun(deps(), { claude: adapter() });

    const r = await tr.prepare({ ...preparePayload, agent: { platform: "claude" } });

    expect(r.ok).toBe(false);
    if (!r.ok && "errors" in r) expect(r.errors.some((e) => e.field === "agent")).toBe(true);
  });

  // The control plane's Oban retry maps 409 to :ok, so a second prepare must be
  // rejected rather than re-run over a workspace it is already preparing.
  it("rejects a second prepare", async () => {
    const tr = new TaskRun(deps(), { claude: adapter() });
    await tr.prepare(preparePayload);

    const second = await tr.prepare(preparePayload);

    expect(second.ok).toBe(false);
    if (!second.ok) expect("already" in second && second.already).toBe(true);
  });
});

describe("TaskRun.initialise from prepared", () => {
  async function prepared(d: BootDeps, registry: { claude: EngineAdapter<any, any> }): Promise<TaskRun> {
    const tr = new TaskRun(d, registry);
    await tr.prepare(preparePayload);
    await settle();
    expect(tr.lifecycle.status().state).toBe("prepared");
    return tr;
  }

  // A snapshot preserves memory, so it preserves lifecycle state: a restored
  // sandbox starts at `prepared` and must still accept its one real initialise.
  it("accepts exactly one initialise, then 409s", async () => {
    const claude = adapter();
    const tr = await prepared(deps(), { claude });

    const first = await tr.initialise(okPayload);
    await settle();
    const second = await tr.initialise(okPayload);

    expect(first).toEqual({ ok: true, status: "booting" });
    expect(tr.lifecycle.status().state).toBe("ready");
    expect(claude.createA2AServer).toHaveBeenCalledOnce();
    expect(second.ok).toBe(false);
    if (!second.ok) expect("already" in second && second.already).toBe(true);
  });

  it("re-syncs repos and re-runs setup on the restored workspace", async () => {
    const d = deps();
    const tr = await prepared(d, { claude: adapter() });

    await tr.initialise(okPayload);
    await settle();

    expect(d.syncOrClone).toHaveBeenCalledTimes(2);
    expect(d.injectGitIdentity).toHaveBeenCalledOnce();
  });
});
```

Add the real-filesystem wipe assertion at the end of the same file. It is the one
case that proves the boundary rather than the code path:

```ts
// The security boundary, asserted against the real filesystem rather than a
// mock. What survives this call is what E2B captures into an image that every
// task in the project boots from.
describe("TaskRun.prepare credential wipe (real filesystem)", () => {
  it("leaves no credential config and no token cache behind", async () => {
    const home = mkdtempSync(join(tmpdir(), "throng-prepare-"));
    const configPath = join(home, ".throng", "config.json");
    const cachePath = join(home, ".throng", "cache");
    const d = deps({
      writeCredentialConfig: (m) => writeCredentialConfig(m, configPath),
      deleteCredentialConfig: () => deleteCredentialConfig(configPath, cachePath),
      // Stand in for throng-creds minting a token during the clone.
      syncOrClone: async () => {
        mkdirSync(cachePath, { recursive: true });
        writeFileSync(join(cachePath, "git_github.com_acme_web"), "9999999999\nk\nusername=x\npassword=ghs_live\n");
        return { ok: true, output: "" };
      },
    });

    const tr = new TaskRun(d, { claude: adapter() });
    await tr.prepare(preparePayload);
    await settle();

    expect(tr.lifecycle.status().state).toBe("prepared");
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(cachePath)).toBe(false);
    expect(readdirSync(join(home, ".throng"))).toEqual([]);
  });
});
```

Add the imports this file now needs:

```ts
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteCredentialConfig, writeCredentialConfig } from "./creds/config.js";
import { TaskRun, type BootDeps } from "./task-run.js";
import type { EngineAdapter, ServerHandle } from "./engine/adapter.js";
```

Add `deleteCredentialConfig: () => {}` to the fake deps in
`packages/core/src/control/server.test.ts` and
`vi.fn(() => {})` for it in `throng-agent/src/integration/boot.test.ts`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @throng/agent-core -- task-run`
Expected: FAIL — `tr.prepare` is not a function, and `deleteCredentialConfig` is
not a `BootDeps` property.

- [ ] **Step 3: Implement `prepare()` and relax the guard**

In `packages/core/src/task-run.ts`, add the dep and the result types:

```ts
export interface BootDeps {
  /** Clone-or-resync, because a sandbox restored from a project snapshot already
   *  has every `dest` on disk and `git clone` fails outright when it does. */
  syncOrClone: (url: string, dest: string, ref: string) => Promise<GitResult>;
  runSetupCommands: (cwd: string, commands: string[]) => Promise<SetupResult>;
  writeCredentialConfig: (manifest: WorkspaceManifest) => void;
  /** Removes the credential config and every token minted from it, before a
   *  prepared workspace is snapshotted. */
  deleteCredentialConfig: () => void;
  injectGitIdentity: (identity: UserIdentity) => void;
  workspaceRoot: string;
}

/** What a control-server route does with an accepted, rejected or duplicate POST. */
export type BootAcceptance =
  | { ok: true; status: "booting" }
  | { ok: false; already: true }
  | { ok: false; errors: FieldError[] };

export type InitialiseResult = BootAcceptance;
export type PrepareResult = BootAcceptance;
```

Update the `validate` import to bring in `validatePrepare`:

```ts
import { validate, validatePrepare } from "./manifest/validate.js";
```

Relax the guard in `initialise()`:

```ts
  async initialise(payload: unknown): Promise<InitialiseResult> {
    // `prepared` is a rest state, not an initialised one: a sandbox restored from
    // a project snapshot resumes with the lifecycle the snapshot captured, and
    // that snapshot was deliberately taken before any agent existed. Everything
    // else that has left `uninitialised` is a second call against a live task.
    if (this.lifecycle.state !== "uninitialised" && this.lifecycle.state !== "prepared") {
      log.warn("initialise rejected: already initialised", { state: this.lifecycle.state });
      return { ok: false, already: true };
    }
```

Everything after that guard is unchanged. Then add `prepare()` and
`prepareWorkspace()` after `initialise()`:

```ts
  /**
   * Warm the workspace without initialising an agent: sync every repo, run the
   * project's setup commands, then delete the credential config and settle at
   * `prepared`, where the control plane snapshots the sandbox.
   *
   * Runs the same three steps `boot()` runs, through the same private methods, so
   * a snapshot build and the task boot that restores from it cannot drift.
   */
  async prepare(payload: unknown): Promise<PrepareResult> {
    if (this.lifecycle.state !== "uninitialised") {
      log.warn("prepare rejected: lifecycle has already left uninitialised", { state: this.lifecycle.state });
      return { ok: false, already: true };
    }

    const result = validatePrepare(payload);
    if (!result.ok) {
      log.warn("prepare rejected: manifest validation failed", {
        errors: result.errors.map((e) => e.field),
      });
      return { ok: false, errors: result.errors };
    }

    this.lifecycle.set("booting");
    log.info("prepare accepted; warming the workspace asynchronously", {
      repos: result.manifest.repos.length,
      setupCommands: result.manifest.setup_commands.length,
    });
    void this.prepareWorkspace(result.manifest);
    return { ok: true, status: "booting" };
  }

  private async prepareWorkspace(manifest: WorkspaceManifest): Promise<void> {
    try {
      this.writeCredentials(manifest);
      const primaryDest = await this.syncRepos(manifest);
      await this.runSetup(manifest, primaryDest);

      // A security boundary, not tidiness. Everything still on disk here is
      // captured into an E2B-stored image that every task in the project boots
      // from, so a surviving token would be shared with all of them. A wipe that
      // throws fails the prepare: a snapshot with a live credential in it is
      // worse than no snapshot.
      log.info("prepare step: deleting the credential config and token cache");
      try {
        this.deps.deleteCredentialConfig();
      } catch (err) {
        throw new StepError("credentials", err instanceof Error ? err.message : String(err));
      }

      this.lifecycle.set("prepared");
      log.info("prepare complete; workspace is ready to snapshot");
    } catch (err) {
      // Best effort on the failure path too: the control plane kills a failed
      // snapshot instance, but a token must not outlive the run that fetched it
      // merely because a setup command exited non-zero. The original failure is
      // what gets reported, so a second wipe error is swallowed deliberately.
      try {
        this.deps.deleteCredentialConfig();
      } catch (wipeErr) {
        log.error("credential wipe failed after a failed prepare", {
          message: wipeErr instanceof Error ? wipeErr.message : String(wipeErr),
        });
      }
      this.failFrom(err);
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w @throng/agent-core && npx turbo run test --filter=throng-agent && npm run typecheck`
Expected: PASS everywhere.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/task-run.ts packages/core/src/task-run.test.ts packages/core/src/control/server.test.ts throng-agent/src/integration/boot.test.ts
git commit -m "feat(task-run): add prepare() and allow one initialise from prepared"
```

---

## Task 7: `POST /api/prepare`

**Files:**
- Modify: `packages/core/src/control/server.ts`
- Modify: `packages/core/src/control/server.test.ts`

- [ ] **Step 1: Write the failing tests**

In `packages/core/src/control/server.test.ts`, add to the `describe("control
server", …)` block. Note that these need their own `TaskRun` per case — `app()`
builds a fresh one, but two requests in one case must share it, so keep a handle:

```ts
  it("POST /api/prepare valid → 202 booting", async () => {
    const res = await request(app())
      .post("/api/prepare")
      .send({ repos: goodRepos, setup_commands: ["mise install"] });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: "booting" });
  });

  it("POST /api/prepare with an agent block → 400 list", async () => {
    const res = await request(app())
      .post("/api/prepare")
      .send({ repos: goodRepos, agent: { platform: "claude" } });
    expect(res.status).toBe(400);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.map((e: { field: string }) => e.field)).toContain("agent");
  });

  // The control plane's Oban retry maps 409 to :ok, so this has to be a clean
  // "already done" rather than a 400 or a second run.
  it("POST /api/prepare twice → 409", async () => {
    const server = createControlApp({ taskRun: new TaskRun(bootDeps, { claude: adapter }) });
    await request(server).post("/api/prepare").send({ repos: goodRepos });

    const res = await request(server).post("/api/prepare").send({ repos: goodRepos });

    expect(res.status).toBe(409);
  });

  it("POST /api/prepare 401 when THRONG_INIT_TOKEN set", async () => {
    const prev = process.env.THRONG_INIT_TOKEN;
    process.env.THRONG_INIT_TOKEN = "secret";
    try {
      const res = await request(app()).post("/api/prepare").send({ repos: goodRepos });
      expect(res.status).toBe(401);
    } finally {
      if (prev === undefined) delete process.env.THRONG_INIT_TOKEN;
      else process.env.THRONG_INIT_TOKEN = prev;
    }
  });

  // What the control plane's boot poller reads to decide the sandbox is ready to
  // snapshot, and what an /api/initialise is then still allowed from.
  it("GET /api/status reports prepared, and /api/initialise still works from it", async () => {
    const server = createControlApp({ taskRun: new TaskRun(bootDeps, { claude: adapter }) });
    await request(server).post("/api/prepare").send({ repos: goodRepos });
    await new Promise((r) => setTimeout(r, 0));

    expect((await request(server).get("/api/status")).body.state).toBe("prepared");

    const init = await request(server)
      .post("/api/initialise")
      .send({ repos: goodRepos, agent: { platform: "claude" } });

    expect(init.status).toBe(202);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @throng/agent-core -- control/server`
Expected: FAIL — 404 on `/api/prepare`.

- [ ] **Step 3: Add the route and finish the deps**

In `packages/core/src/control/server.ts`, add the route after `/api/initialise`:

```ts
  // Warms the workspace for a project snapshot: no agent, no engine credential,
  // no A2A server. The control plane maps both 202 and 409 to :ok, because the
  // Oban job that drives this has to be safe to retry.
  app.post("/api/prepare", async (req, res) => {
    log.info("POST /api/prepare received");
    if (!checkInitToken(process.env.THRONG_INIT_TOKEN, req.headers.authorization)) {
      log.warn("POST /api/prepare rejected: unauthorized (bad or missing THRONG_INIT_TOKEN)");
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const result = await taskRun.prepare(req.body);
    if (result.ok) {
      res.status(202).json({ status: result.status });
    } else if ("already" in result) {
      res.status(409).json({ error: "already_prepared" });
    } else {
      res.status(400).json(result.errors);
    }
  });
```

Update the creds import and `defaultBootDeps`:

```ts
import { deleteCredentialConfig, writeCredentialConfig } from "../creds/config.js";
```

```ts
  return {
    syncOrClone,
    runSetupCommands,
    writeCredentialConfig: (manifest) => writeCredentialConfig(manifest),
    // No arguments: both paths resolve at call time from the same environment
    // throng-creds reads, so the runtime deletes exactly what the helper wrote.
    deleteCredentialConfig: () => deleteCredentialConfig(),
    injectGitIdentity,
    // `||` rather than `??` so a blank WORKSPACE_DIR falls back instead of
    // resolving every clone destination against "".
    workspaceRoot: process.env.WORKSPACE_DIR || join(homeDir(), "workspace"),
  };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w @throng/agent-core -- control/server`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/control/server.ts packages/core/src/control/server.test.ts
git commit -m "feat(control): add POST /api/prepare"
```

---

## Task 8: Public surface, docs and changeset

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `README.md`
- Create: `.changeset/project-snapshots-prepare.md`

- [ ] **Step 1: Export the new surface**

In `packages/core/src/index.ts`:

```ts
export { TaskRun, type BootDeps, type BootAcceptance, type InitialiseResult, type PrepareResult } from "./task-run.js";
export { validate, validatePrepare } from "./manifest/validate.js";
export { clone, checkout, syncOrClone, type GitResult } from "./bootstrap/git.js";
export { writeCredentialConfig, deleteCredentialConfig, credsCachePath, CONFIG_PATH } from "./creds/config.js";
```

and add `WorkspaceManifest` and `PrepareValidateResult` to the existing
`export type { … } from "./manifest/types.js"` block.

- [ ] **Step 2: Verify the package still builds and typechecks**

Run: `npm run build && npm run typecheck && npm test`
Expected: PASS everywhere.

- [ ] **Step 3: Document the route**

In `README.md`, after the `### Running standalone` subsection and before
`## What's in the box?`, add:

````markdown
## Preparing a workspace (project snapshots)

`POST /api/prepare` warms a sandbox's workspace without initialising an agent, so
the sandbox can be snapshotted and every later task booted from the result with
its repositories, toolchains and dependency caches already on disk.

```jsonc
{
  "repos": [
    { "url": "https://github.com/acme/app", "ref": "main", "dest": "app", "primary": true }
  ],
  "setup_commands": ["npm install"],
  "credentials": { "url": "https://…/api/credentials", "token": "…" }
}
```

It takes the workspace half of the initialise manifest — `repos`,
`setup_commands`, and `credentials` or `github_token` — and **rejects** `agent`
and `user_identity` with a `400`. A snapshot is shared by every task in the
project and is stored by the sandbox provider, so no agent configuration, no LLM
credential and no commit identity may be baked into one; a manifest carrying them
is an initialise manifest sent to the wrong route.

It responds `202 {"status":"booting"}` and reports progress through the same
`GET /api/status` states as `/api/initialise` (`cloning`, `setup`), settling at a
new terminal state, **`prepared`**. Before reporting it, the credential config and
the whole token cache are deleted — if that deletion fails, so does the prepare.
It never injects engine credentials and never starts the A2A server.

`prepared` is a rest state, not a failure state: a sandbox restored from a
snapshot resumes there and accepts exactly one `/api/initialise`, which is what
configures the agent for a specific task. A second one still gets a `409`.

Repositories are synced rather than cloned blind, on both routes: an absent
destination is cloned and checked out as before, a destination that is already a
work tree for the same remote is fetched, checked out and reset to
`origin/<ref>`, and anything else is removed and cloned fresh. There is
deliberately no `git clean` — the untracked `_build`, `deps` and `node_modules`
a prepare leaves behind are the entire point of a snapshot. A `ref` that is not a
branch (a tag or a SHA) is checked out and not reset, since it has no
`origin/<ref>` to reset to.
````

- [ ] **Step 4: Write the changeset**

Create `.changeset/project-snapshots-prepare.md`:

```markdown
---
"@throng/agent-core": minor
---

Add `POST /api/prepare` and a sync-aware clone, so a sandbox can be snapshotted with a project's
repositories and dependencies already in place and every task booted from that image.

`/api/prepare` takes the workspace half of a manifest — `repos`, `setup_commands`, and `credentials`
or `github_token` — writes the credential config, syncs the repos, runs the setup commands, then
deletes the credential config and the whole `throng-creds` token cache and settles at a new terminal
lifecycle state, `prepared`. It never injects engine credentials and never starts the A2A server. An
`agent` or `user_identity` block is rejected with a `400` rather than ignored: a snapshot is shared by
every task in the project and is stored by the sandbox provider, so a manifest carrying either is an
initialise manifest sent to the wrong route. The wipe is a security boundary — if it fails, the
prepare fails, because a snapshot with a live credential in it is worse than no snapshot.

`prepared` is a terminal *rest* state. A sandbox restored from a snapshot resumes with the lifecycle
the snapshot captured, so `/api/initialise`'s one-shot guard relaxes from "the lifecycle has left
`uninitialised`" to "…and is not `prepared`": a restored sandbox accepts exactly one initialise, and
everything after that guard is unchanged.

`bootstrap/git.ts` gains `syncOrClone(url, dest, ref)`, which both routes use in place of
`clone` + `checkout`, so the two cannot drift. An absent `dest` is cloned and checked out exactly as
before; a `dest` that is already a work tree for the same remote (compared with userinfo, a trailing
slash and a trailing `.git` normalised away) is fetched, force-checked-out and reset to
`origin/<ref>`; anything else is removed and cloned fresh. There is deliberately no `git clean` — the
untracked build output a prepare leaves behind is the entire point of the snapshot — and the reset is
skipped for a `ref` with no `origin/<ref>`, so a tag or SHA still works. Existing boots take the
clone branch and are unaffected.

**Breaking (consumers constructing `BootDeps` directly):** `BootDeps.clone` and `BootDeps.checkout`
are replaced by a single `syncOrClone(url, dest, ref)`, and `BootDeps.deleteCredentialConfig` is now
required. `defaultBootDeps()` supplies both. `clone` and `checkout` are still exported and unchanged.
`BaseManifest` now extends a new `WorkspaceManifest` (the same fields minus `user_identity`); nothing
that consumes a `BaseManifest` changes.
```

- [ ] **Step 5: Full verification**

Run: `npm run build && npm run typecheck && npm test`
Expected: PASS everywhere. Confirm the output before claiming completion.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/index.ts README.md .changeset/project-snapshots-prepare.md
git commit -m "docs: document /api/prepare and export the new surface"
```

---

## Definition of done

The four tests §9 of the design asks for, and where they live:

| Requirement | Test |
| --- | --- |
| `syncOrClone` across its three branches, including that `reset --hard` does not remove untracked build output | `bootstrap/git-sync.test.ts` |
| `/api/prepare` reaches `prepared`, leaves no credential config, and starts no A2A server | `task-run.test.ts` — `TaskRun.prepare` and the real-filesystem wipe suite; `control/server.test.ts` |
| `/api/initialise` succeeds once from `prepared` and returns `409` on a second call | `task-run.test.ts` — `TaskRun.initialise from prepared`; `control/server.test.ts` |
| A manifest carrying an `agent` block is rejected | `manifest/validate.test.ts`; `task-run.test.ts`; `control/server.test.ts` |

Plus: `npm run build && npm run typecheck && npm test` all green, and both changes
are no-ops for an existing boot — `syncOrClone` takes its clone branch when
`dest` is absent, which is every task sandbox not restored from a snapshot, and
`/api/prepare` is simply unused until the control plane's `snapshot_enabled`
toggle is turned on.
````
