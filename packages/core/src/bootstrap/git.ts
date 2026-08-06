import { execFile } from "node:child_process";
import { lstatSync, realpathSync, rmSync } from "node:fs";

/**
 * `op` names the git subcommand that failed, so a caller can say which step of a
 * multi-command sync went wrong. Optional: the single-command helpers below have
 * only one answer and do not set it.
 */
export type GitResult =
  | { ok: true; output: string }
  | { ok: false; code: number; output: string; op?: string };

function run(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv }): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd: opts.cwd, env: opts.env, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const output = `${stdout}${stderr}`;
      if (err) {
        const code = typeof (err as { code?: number }).code === "number" ? (err as { code: number }).code : 1;
        resolve({ ok: false, code, output });
      } else {
        resolve({ ok: true, output });
      }
    });
  });
}

/**
 * `GIT_TERMINAL_PROMPT=0` turns a missing credential into an immediate error
 * instead of a prompt — an error without a TTY, a hang with one.
 *
 * This covers only the runtime's OWN subprocesses. The agent's `git push` an
 * hour later is not descended from this process, so the guarantee that matters
 * in production is `startControlServer()` setting the same variable on the
 * runtime's `process.env`, which every process in the sandbox then inherits.
 * (The image's `ENV GIT_TERMINAL_PROMPT=0` is kept too, but E2B's runtime
 * environment inherits no image ENV, so it only covers `docker run`.) This is
 * kept anyway: it costs nothing, it makes the clone/checkout path correct when
 * this module is used outside the runtime — where these unit tests run — and it
 * does not depend on either of the other two to be true.
 */
const noPrompt = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_TERMINAL_PROMPT: "0" });

/**
 * Full clone (no --depth) so any branch/tag/SHA can be checked out afterward.
 *
 * No token parameter: authentication is git's system credential helper
 * (`throng-creds`, configured in the image), which mints a token scoped to this
 * repo at the moment of the fetch.
 */
export function clone(url: string, dest: string): Promise<GitResult> {
  return run(["clone", url, dest], { env: noPrompt() });
}

export function checkout(dest: string, ref: string): Promise<GitResult> {
  return run(["checkout", ref], { cwd: dest, env: noPrompt() });
}

export function revParseHead(dest: string): Promise<GitResult> {
  return run(["rev-parse", "HEAD"], { cwd: dest });
}

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
  // `lstatSync`, not `existsSync`: `existsSync` follows symlinks, so a dangling
  // one at `dest` would read as "absent" even though the directory entry is
  // real — `clone` then fails outright with "could not create work tree dir:
  // File exists". `lstatSync` looks at the entry itself, so a dangling symlink
  // falls through to the "not this repo" branch below and gets removed. A
  // valid symlink to a matching work tree still resolves to that work tree in
  // `worktreeOrigin` (which does follow it) and still syncs, unchanged.
  if (lstatSync(dest, { throwIfNoEntry: false }) === undefined) return cloneFresh(url, dest, ref);

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
