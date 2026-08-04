import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeCredentialConfig } from "./config.js";
import type { BaseManifest } from "../manifest/types.js";

function manifest(over: Partial<BaseManifest> = {}): BaseManifest {
  return {
    repos: [],
    credentials: null,
    github_token: null,
    user_identity: { name: null, email: null },
    setup_commands: [],
    ...over,
  };
}

const target = () => join(mkdtempSync(join(tmpdir(), "throng-cfg-")), "run", "config.json");

describe("writeCredentialConfig", () => {
  it("writes the credentials block for pull mode", () => {
    const path = target();
    writeCredentialConfig(manifest({ credentials: { url: "https://cp", token: "tok" } }), path);

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      credentials: { url: "https://cp", token: "tok" },
    });
  });

  it("writes a static token for standalone mode", () => {
    const path = target();
    writeCredentialConfig(manifest({ github_token: "ghp_static" }), path);

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ github_token: "ghp_static" });
  });

  it("writes both when both are present, letting the helper apply precedence", () => {
    const path = target();
    writeCredentialConfig(
      manifest({ credentials: { url: "https://cp", token: "tok" }, github_token: "ghp_static" }),
      path,
    );

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      credentials: { url: "https://cp", token: "tok" },
      github_token: "ghp_static",
    });
  });

  // An empty object is still written: throng-creds treats "no config" and
  // "config with nothing usable" identically, and creating the file proves
  // the directory and permissions are right before the first clone needs them.
  it("writes an empty object when there is nothing to configure", () => {
    const path = target();
    writeCredentialConfig(manifest(), path);

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({});
  });

  it("creates the directory and keeps the file private", () => {
    const path = target();
    writeCredentialConfig(manifest({ github_token: "ghp_static" }), path);

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
  });

  // mkdirSync's `mode` applies only when it creates the directory — exactly the
  // limitation writeFileSync has, and the reason the file gets a follow-up chmod.
  // A pre-existing config directory with looser bits would otherwise leave the
  // token file readable to anyone who can traverse it. That is not theoretical
  // now that the directory lives under a world-writable /dev/shm.
  it("tightens an existing directory that was created world-readable", () => {
    const path = target();
    mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o755);

    writeCredentialConfig(manifest({ github_token: "ghp_static" }), path);

    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
  });

  // Same asymmetry on the file side, already guarded — pinned so it stays that way.
  it("tightens an existing config file that was created world-readable", () => {
    const path = target();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{}\n", { mode: 0o644 });

    writeCredentialConfig(manifest({ github_token: "ghp_static" }), path);

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("overwrites an existing file rather than appending", () => {
    const path = target();
    writeCredentialConfig(manifest({ github_token: "ghp_first" }), path);
    writeCredentialConfig(manifest({ github_token: "ghp_second" }), path);

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ github_token: "ghp_second" });
  });
});

// Every test above passes an explicit path, so none of them would have noticed
// that the production default was unwritable — and it was. E2B's envd runs the
// sandbox as uid 1000 while /run is tmpfs owned root:root 0755, so the first
// integration boot died on `mkdir /run/throng`. Development missed it because
// `docker run` honours the image's USER, which is root.
describe("CONFIG_PATH", () => {
  const original = process.env.THRONG_CONFIG;

  afterEach(() => {
    if (original === undefined) delete process.env.THRONG_CONFIG;
    else process.env.THRONG_CONFIG = original;
    vi.resetModules();
  });

  // The constant is evaluated at import, so the env has to be set before the
  // module is loaded — hence the reset and the dynamic import.
  async function reimport(): Promise<string> {
    vi.resetModules();
    return (await import("./config.js")).CONFIG_PATH;
  }

  it("defaults to /dev/shm/throng/config.json when THRONG_CONFIG is unset", async () => {
    delete process.env.THRONG_CONFIG;

    expect(await reimport()).toBe("/dev/shm/throng/config.json");
  });

  it("still honours THRONG_CONFIG when it is set", async () => {
    process.env.THRONG_CONFIG = "/somewhere/else/config.json";

    expect(await reimport()).toBe("/somewhere/else/config.json");
  });

  // The runtime writes this file and the bash helper reads it. If the two
  // defaults drift, a correctly initialised sandbox looks unconfigured: the
  // helper declines, and every clone silently falls back to unauthenticated.
  it("agrees with the default compiled into throng-creds.sh", async () => {
    delete process.env.THRONG_CONFIG;
    const script = readFileSync(
      fileURLToPath(new URL("./throng-creds.sh", import.meta.url)),
      "utf8",
    );

    expect(script).toContain(`CONFIG_FILE="\${THRONG_CONFIG:-${await reimport()}}"`);
  });
});
