import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BaseManifest } from "../manifest/types.js";

/** Where throng-creds reads its configuration. The env var exists for tests. */
export const CONFIG_PATH = process.env.THRONG_CONFIG ?? "/run/throng/config.json";

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
  // writeFileSync's mode applies only when it creates the file; an existing one
  // keeps whatever it had.
  chmodSync(path, 0o600);
}
