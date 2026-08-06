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
