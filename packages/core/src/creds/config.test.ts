import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
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
  // A pre-existing /run/throng with looser bits would otherwise leave the token
  // file readable to anyone who can traverse the directory.
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
