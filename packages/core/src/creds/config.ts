import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homeDir } from "../env.js";
import type { BaseManifest } from "../manifest/types.js";

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
export function writeCredentialConfig(manifest: BaseManifest, path = CONFIG_PATH): void {
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
 */
export function deleteCredentialConfig(
  configPath = CONFIG_PATH,
  cachePath = credsCachePath(),
): void {
  assertDeletableCacheDir(cachePath, configPath);
  rmSync(configPath, { force: true });
  rmSync(cachePath, { recursive: true, force: true });
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
  if (same(dirname(configPath))) refuse("it holds the write-once credential config");
  const home = process.env.HOME;
  const workspace = process.env.WORKSPACE_DIR || (home ? join(home, "workspace") : "");
  if (same(workspace)) refuse("it is the workspace the repos were cloned into");
  if (same("/dev/shm")) refuse("it is a tmpfs mount shared with the whole sandbox");
}
