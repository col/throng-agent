import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homeDir } from "../env.js";
import type { WorkspaceManifest } from "../manifest/types.js";

/**
 * Where throng-creds reads its configuration. The env var exists for tests.
 *
 * Under $HOME because the sandbox runs unprivileged: E2B's envd starts it as
 * uid 1000, while `docker run` honours the image's USER (root). /run — the
 * original location — is tmpfs owned root:root mode 0755, so `mkdir /run/throng`
 * is EACCES under E2B, and pre-creating it in the image is no help because /run
 * is mounted fresh at boot. $HOME needs no privilege on either host, and unlike
 * /dev/shm (mode 1777) its parent is owned by the user — /home/user is
 * user:user 755 — so nothing running as another uid can squat the directory.
 *
 * The trade is that $HOME is disk-backed rather than tmpfs, so the credential
 * does land on a persisted layer, which /run and /dev/shm were both chosen to
 * avoid. Accepted: E2B snapshots memory on pause anyway, so tmpfs bought less
 * than it looked like it did, and this design already accepts that the agent
 * can read the token (see the spec's "Decision").
 *
 * `||`, not `??`: bash reads this same override as `${THRONG_CONFIG:-…}`, where
 * an empty value falls back to the default. An empty string here would
 * otherwise be a path of "", so the runtime and the helper would disagree about
 * whether the sandbox is configured at all.
 */
export const CONFIG_PATH = process.env.THRONG_CONFIG || join(homeDir(), ".throng", "config.json");

/**
 * Writes the configuration `throng-creds` reads on a cache miss.
 *
 * A file rather than environment variables, because the agent runtime is
 * started during template build and captured in the snapshot: a process's
 * environment is fixed at execve(), long before any per-task value exists. A
 * freshly spawned throng-creds reads this at the moment of use, so there is no
 * inheritance chain to get wrong.
 *
 * JSON rather than shell-sourced assignments: this file holds a
 * control-plane-supplied token, and sourcing it would execute whatever it
 * contains.
 *
 * Called before cloning, because cloning now authenticates through the helper.
 */
export function writeCredentialConfig(manifest: WorkspaceManifest, path = CONFIG_PATH): void {
  const config: Record<string, unknown> = {};
  if (manifest.credentials) config.credentials = manifest.credentials;
  if (manifest.github_token) config.github_token = manifest.github_token;

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  // Both `mode` options apply only when the call CREATES the thing; an existing
  // directory or file keeps whatever bits it had. Since this file holds a live
  // token, chmod both unconditionally rather than trusting that we made them.
  chmodSync(dirname(path), 0o700);
  chmodSync(path, 0o600);
}

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
 *
 * The config is deleted before the cache, deliberately and not just as written
 * order: config.json holds the long-lived instance identity token, which can
 * mint further GitHub credentials, while the cache holds only short-lived
 * tokens already derived from it — so removing the ability to mint more comes
 * first. That ordering cannot protect against an `rmSync` that throws for an
 * unrelated OS reason (permissions, a busy mount) after the first delete
 * succeeds; there is no atomic way to remove both. Either throw fails the
 * `/api/prepare` call, so no snapshot is taken from a sandbox left half wiped.
 *
 * That ordering also bounds — without closing — the concurrent case: a
 * throng-creds invocation spawned by a setup command can have read config.json
 * before the wipe and write its minted token into the cache after it, leaving a
 * live token behind. Config-first means no NEW helper can mint after the first
 * delete, so the exposure is at most the round trips already in flight, and the
 * post-condition below catches any that land before it runs.
 *
 * **Removing the cache is load-bearing for throng-creds.sh, not merely tidy.**
 * The helper gives a literal `github_token` a 10-year cache TTL (`STATIC_TTL`),
 * which was safe when a sandbox's config was written exactly once. Prepare and
 * restore break that: this run writes token A and may mint a decade-long cache
 * entry from it, and the restored sandbox's `/api/initialise` writes a different
 * token B to the same path. Wiping both together here is what stops an entry
 * minted from A outliving A — narrowing this to `configPath` alone would leave
 * every task in the project authenticating as the prepare instance, silently and
 * for ten years. `STATIC_TTL` carries the same note pointing back here.
 */
export function deleteCredentialConfig(
  configPath = CONFIG_PATH,
  cachePath = credsCachePath(),
): void {
  assertDeletableCacheDir(cachePath, configPath);
  rmSync(configPath, { force: true });
  rmSync(cachePath, { recursive: true, force: true });

  // Checked, not assumed. The caller turns "did not throw" into "safe to
  // snapshot", so this is the one function whose silent partial success would
  // put a live token into an image every task in the project boots from.
  // `rmSync` with `force` swallows ENOENT but not every way a path can survive a
  // delete — an immutable file, a busy mount point, a directory repopulated by a
  // throng-creds invocation still in flight — so the post-condition is verified
  // rather than inferred from the absence of an exception.
  if (existsSync(configPath) || existsSync(cachePath)) {
    throw new Error(
      `credential wipe left ${existsSync(configPath) ? configPath : cachePath} on disk`,
    );
  }
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
  // "write-once" is once per boot, not once per sandbox image: a snapshot
  // restore rewrites this file with a different token at /api/initialise. Within
  // one run it still holds — nothing re-mints the identity, so losing the file
  // takes away the only identity this run will ever have.
  if (same(dirname(configPath))) refuse("it holds the write-once credential config");
  const home = process.env.HOME;
  const workspace = process.env.WORKSPACE_DIR || (home ? join(home, "workspace") : "");
  if (same(workspace)) refuse("it is the workspace the repos were cloned into");
  if (same("/dev/shm")) refuse("it is a tmpfs mount shared with the whole sandbox");
}
