/** Environment map used for manifest fallback resolution. */
export type Env = Record<string, string | undefined>;

/**
 * The runtime's home directory, read from `$HOME` and from nothing else.
 *
 * Deliberately not `os.homedir()`. That returns `$HOME` when it is set but
 * falls back to the passwd entry when it is not, and bash's `$HOME` has no such
 * fallback. Everything this resolves is a handshake with a process the runtime
 * does not spawn: the runtime writes `$HOME/.throng/config.json`, and
 * `throng-creds` — bash, started by git, in a shell the agent opened an hour
 * later — reads it. If the two ever resolved `~` differently the runtime would
 * write one file and the helper would look for another, and the helper's
 * contract for "no config" is to decline silently. The symptom would be a
 * correctly initialised sandbox quietly cloning unauthenticated: the same
 * silent-decline failure class as the bug this replaced. Reading the same
 * variable the shell reads is what makes that divergence impossible.
 *
 * Unset is fatal rather than defaulted, for the same reason. `${HOME}/.throng`
 * with an empty HOME is `/.throng`, which is root-owned and uncreatable as
 * uid 1000 — precisely the failure being fixed — and `os.homedir()`'s passwd
 * fallback would instead resolve to something the helper cannot see. E2B sets
 * `HOME=/home/user` and Docker sets it from the image's `USER`, so there is no
 * legitimate caller without one; anything that really needs another location
 * sets `THRONG_CONFIG` / `THRONG_CREDS_CACHE` / `WORKSPACE_DIR`, which are
 * checked first and never reach here.
 *
 * The rule is about paths shared with another process, not about `os.homedir()`
 * being wrong in general. `throng-agent-claude`'s settings probe still uses it,
 * legitimately: nothing else reads that path, and an unreadable file there is
 * already treated as "fine", so a disagreement costs a missed check rather than
 * a broken handshake — and throwing would be worse than the miss.
 */
export function homeDir(): string {
  const home = process.env.HOME;
  // Empty counts as unset, matching bash's `${HOME:-}`. The two sides must agree
  // on what "not set" means as well as on the value.
  if (home === undefined || home === "") {
    throw new Error(
      "HOME is unset. The agent runtime resolves its credential config, cache and " +
        "workspace under $HOME, and throng-creds reads the same variable from bash — " +
        "there is no fallback the two would agree on. Set HOME, or set THRONG_CONFIG, " +
        "THRONG_CREDS_CACHE and WORKSPACE_DIR explicitly.",
    );
  }
  if (!home.startsWith("/")) {
    throw new Error(`HOME must be an absolute path, got '${home}'.`);
  }
  return home;
}
