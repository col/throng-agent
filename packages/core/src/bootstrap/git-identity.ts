import type { UserIdentity } from "../manifest/types.js";

/**
 * Sets the identity commits are made under, via `GIT_{AUTHOR,COMMITTER}_{NAME,EMAIL}`
 * — which git honours over `user.name`/`user.email` config. Env rather than
 * `git config --global` keeps this per-run and writes nothing into the sandbox's
 * home directory.
 *
 * Identity is a git concept, independent of which token pushes the work, so it
 * stays environment-based even though credentials no longer are: a name is not a
 * secret and never needs refreshing.
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
