import { ASKPASS } from "./git.js";
import type { UserIdentity } from "../manifest/types.js";

/**
 * Exposes the GitHub token to git subprocesses (repo clones pass askpass env
 * per-invocation, but subprocesses an engine spawns inherit this process's
 * environment). The token stays in env; askpass.sh holds no secret.
 *
 * `GH_TOKEN` carries the same token under the name the `gh` CLI reads. Without it
 * an agent finds `gh` installed but logged out and falls back to raw
 * api.github.com calls, scraping the token out of git's credential helper to do so
 * (observed live). `GITHUB_TOKEN` is deliberately NOT set: `gh` prefers `GH_TOKEN`,
 * and the other name is one many unrelated tools also read.
 */
export function injectGitCredentials(token: string | null): void {
  if (!token) return;
  process.env.GIT_ASKPASS = ASKPASS;
  process.env.GIT_ASKPASS_USERNAME = "x-access-token";
  process.env.GIT_ASKPASS_TOKEN = token;
  process.env.GIT_TERMINAL_PROMPT = "0";
  process.env.GH_TOKEN = token;
}

/**
 * Sets the identity commits are made under, via `GIT_{AUTHOR,COMMITTER}_{NAME,EMAIL}`
 * — which git honours over `user.name`/`user.email` config. Env rather than
 * `git config --global` keeps this per-run and writes nothing into the sandbox's
 * home directory.
 *
 * Separate from the credential above because it is a separate thing: identity is a
 * git concept, independent of which token pushes the work. A manifest may carry
 * either, both, or neither. With no identity from any source git refuses to commit
 * ("Author identity unknown"), which an agent then works around by inventing one.
 */
export function injectGitIdentity(identity: UserIdentity): void {
  // Author and committer are set together: git needs both, and a run where they
  // disagree would be confusing to attribute.
  if (identity.name) {
    process.env.GIT_AUTHOR_NAME = identity.name;
    process.env.GIT_COMMITTER_NAME = identity.name;
  }

  if (identity.email) {
    process.env.GIT_AUTHOR_EMAIL = identity.email;
    process.env.GIT_COMMITTER_EMAIL = identity.email;
  }
}
