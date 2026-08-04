import { execFile } from "node:child_process";

export type GitResult = { ok: true; output: string } | { ok: false; code: number; output: string };

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
 * instead of a hang on a TTY that is not there.
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
