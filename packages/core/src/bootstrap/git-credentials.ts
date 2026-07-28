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
