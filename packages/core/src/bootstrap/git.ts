import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ASKPASS = fileURLToPath(new URL("./askpass.sh", import.meta.url));

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

// null token (public/local repo) => no askpass env, behaves like plain clone.
function askpassEnv(token: string | null): NodeJS.ProcessEnv {
  if (!token) return { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  return {
    ...process.env,
    GIT_ASKPASS: ASKPASS,
    GIT_ASKPASS_USERNAME: "x-access-token",
    GIT_ASKPASS_TOKEN: token,
    GIT_TERMINAL_PROMPT: "0",
  };
}

/** Full clone (no --depth) so any branch/tag/SHA can be checked out afterward. */
export function clone(url: string, dest: string, token: string | null): Promise<GitResult> {
  return run(["clone", url, dest], { env: askpassEnv(token) });
}

export function checkout(dest: string, ref: string): Promise<GitResult> {
  return run(["checkout", ref], { cwd: dest, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
}

export function revParseHead(dest: string): Promise<GitResult> {
  return run(["rev-parse", "HEAD"], { cwd: dest });
}
