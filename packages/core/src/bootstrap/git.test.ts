import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkout, clone } from "./git.js";

const tmpRoots: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "a2a-git-"));
  tmpRoots.push(d);
  return d;
}

// Build a local source repo with two commits on different refs.
function makeSourceRepo(): string {
  const dir = tmp();
  const run = (...a: string[]) => execFileSync("git", a, { cwd: dir });
  run("init", "-q");
  run("config", "user.email", "t@t.t");
  run("config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), "one");
  run("add", "-A");
  run("commit", "-qm", "one");
  run("branch", "-M", "main");
  run("checkout", "-qb", "feature");
  writeFileSync(join(dir, "README.md"), "two");
  run("add", "-A");
  run("commit", "-qm", "two");
  run("checkout", "-q", "main");
  return dir;
}

afterAll(() => {
  for (const d of tmpRoots) execFileSync("rm", ["-rf", d]);
});

describe("git clone/checkout", () => {
  it("clones a repo and checks out a ref", async () => {
    const src = makeSourceRepo();
    const dest = join(tmp(), "work");
    const c = await clone(`file://${src}`, dest, null);
    expect(c.ok).toBe(true);
    const co = await checkout(dest, "feature");
    expect(co.ok).toBe(true);
    const head = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dest }).toString().trim();
    expect(head).toBe("feature");
  });

  it("returns an error result (never throws) on a bad ref", async () => {
    const src = makeSourceRepo();
    const dest = join(tmp(), "work2");
    await clone(`file://${src}`, dest, null);
    const co = await checkout(dest, "no-such-ref");
    expect(co.ok).toBe(false);
    if (!co.ok) expect(co.code).not.toBe(0);
  });
});
