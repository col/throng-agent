import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { credsCachePath, deleteCredentialConfig, writeCredentialConfig } from "./config.js";
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

const target = () => join(mkdtempSync(join(tmpdir(), "throng-cfg-")), ".throng", "config.json");

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
  // token file readable to anyone who can traverse it. Less pressing under $HOME
  // than it was under a world-writable /dev/shm — the parent is owned by the
  // user now, so nothing else can create the directory first — but the guarantee
  // should not rest on the parent's mode, which is not this code's to control.
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
//
// That the default agrees with the one throng-creds.sh computes is asserted
// behaviourally, in throng-creds.test.ts: both sides are expressions over $HOME
// now, and the failure worth catching is the two expressions evaluating to
// different files, which no source-string match can see.
describe("CONFIG_PATH", () => {
  const originalConfig = process.env.THRONG_CONFIG;
  const originalHome = process.env.HOME;

  afterEach(() => {
    restore("THRONG_CONFIG", originalConfig);
    restore("HOME", originalHome);
    vi.resetModules();
  });

  function restore(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  // The constant is evaluated at import, so the env has to be set before the
  // module is loaded — hence the reset and the dynamic import.
  async function reimport(): Promise<string> {
    vi.resetModules();
    return (await import("./config.js")).CONFIG_PATH;
  }

  it("defaults to $HOME/.throng/config.json when THRONG_CONFIG is unset", async () => {
    delete process.env.THRONG_CONFIG;
    process.env.HOME = "/home/user";

    expect(await reimport()).toBe("/home/user/.throng/config.json");
  });

  it("still honours THRONG_CONFIG when it is set", async () => {
    process.env.THRONG_CONFIG = "/somewhere/else/config.json";

    expect(await reimport()).toBe("/somewhere/else/config.json");
  });

  // The hazard the whole $HOME choice turns on. Node's os.homedir() falls back
  // to the passwd entry when HOME is unset and bash's $HOME does not, so a
  // fallback of any kind risks the runtime writing one file while the helper
  // reads another — and the helper's contract for "no config" is to decline
  // silently, which is indistinguishable from an uninitialised sandbox. Failing
  // at import is loud, immediate, and happens before the server ever listens.
  it("throws rather than resolving to /.throng when HOME is unset", async () => {
    delete process.env.THRONG_CONFIG;
    delete process.env.HOME;

    await expect(reimport()).rejects.toThrow(/HOME is unset/);
  });

  // Empty is unset, because that is what bash's ${HOME:-} means. If the two
  // sides disagreed about this they would disagree about the path.
  it("treats an empty HOME as unset", async () => {
    delete process.env.THRONG_CONFIG;
    process.env.HOME = "";

    await expect(reimport()).rejects.toThrow(/HOME is unset/);
  });

  it("rejects a relative HOME", async () => {
    delete process.env.THRONG_CONFIG;
    process.env.HOME = "home/user";

    await expect(reimport()).rejects.toThrow(/absolute path/);
  });

  // ...but an explicit override needs no HOME at all: `||` short-circuits, so a
  // consumer that sets THRONG_CONFIG never reaches the resolution above. Same
  // shape as bash's ${THRONG_CONFIG:-…}, which only expands its default when the
  // override is absent.
  it("does not require HOME when THRONG_CONFIG is set", async () => {
    delete process.env.HOME;
    process.env.THRONG_CONFIG = "/somewhere/else/config.json";

    expect(await reimport()).toBe("/somewhere/else/config.json");
  });

  it("treats an empty THRONG_CONFIG as unset, as ${THRONG_CONFIG:-…} does", async () => {
    process.env.THRONG_CONFIG = "";
    process.env.HOME = "/home/user";

    expect(await reimport()).toBe("/home/user/.throng/config.json");
  });
});

describe("credsCachePath", () => {
  const originalCache = process.env.THRONG_CREDS_CACHE;
  const originalHome = process.env.HOME;
  afterEach(() => {
    if (originalCache === undefined) delete process.env.THRONG_CREDS_CACHE;
    else process.env.THRONG_CREDS_CACHE = originalCache;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  // Must agree with throng-creds.sh's ${THRONG_CREDS_CACHE:-$HOME/.throng/cache}:
  // the runtime deletes what the helper writes, and a disagreement would leave
  // live tokens in the snapshot while every test still passed.
  it("defaults to $HOME/.throng/cache", () => {
    delete process.env.THRONG_CREDS_CACHE;
    process.env.HOME = "/home/user";

    expect(credsCachePath()).toBe("/home/user/.throng/cache");
  });

  it("honours THRONG_CREDS_CACHE, and treats a blank value as unset", () => {
    process.env.HOME = "/home/user";
    process.env.THRONG_CREDS_CACHE = "/mnt/cache";
    expect(credsCachePath()).toBe("/mnt/cache");
    process.env.THRONG_CREDS_CACHE = "";
    expect(credsCachePath()).toBe("/home/user/.throng/cache");
  });
});

describe("deleteCredentialConfig", () => {
  function populated(): { config: string; cache: string } {
    const dir = mkdtempSync(join(tmpdir(), "throng-wipe-"));
    const config = join(dir, ".throng", "config.json");
    const cache = join(dir, ".throng", "cache");
    writeCredentialConfig(manifest({ credentials: { url: "https://cp", token: "tok" } }), config);
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "git_github.com_acme_app"), "9999999999\nkey\nusername=x\npassword=ghs_live\n");
    return { config, cache };
  }

  it("removes the config file and the whole cache directory", () => {
    const { config, cache } = populated();

    deleteCredentialConfig(config, cache);

    expect(existsSync(config)).toBe(false);
    expect(existsSync(cache)).toBe(false);
  });

  // Called on the failure path too, and a second call must not turn a failed
  // prepare into a different error.
  it("is a no-op when there is nothing to delete", () => {
    const { config, cache } = populated();
    deleteCredentialConfig(config, cache);

    expect(() => deleteCredentialConfig(config, cache)).not.toThrow();
  });

  // Same rm -rf on the same operator-supplied variable that throng-creds.sh's
  // check_cache_dir guards, so it refuses the same values. A refusal must leave
  // the config in place rather than half-wiping: the caller turns the throw into
  // a failed prepare, and a half-wipe would be reported as a success.
  it.each([
    ["a relative path", () => "relative/cache"],
    ["the filesystem root", () => "/"],
    ["a top-level directory", () => "/cache"],
    ["a path containing ..", () => "/home/user/../cache"],
    ["/dev/shm", () => "/dev/shm"],
  ])("refuses %s and deletes nothing", (_label, cacheFor) => {
    const { config } = populated();

    expect(() => deleteCredentialConfig(config, cacheFor())).toThrow(/refusing/);
    expect(existsSync(config)).toBe(true);
  });

  it("refuses $HOME, the config directory and the workspace", () => {
    const { config } = populated();
    const home = dirname(dirname(config));
    const savedHome = process.env.HOME;
    const savedWorkspace = process.env.WORKSPACE_DIR;
    process.env.HOME = home;
    delete process.env.WORKSPACE_DIR;
    try {
      expect(() => deleteCredentialConfig(config, home)).toThrow(/\$HOME/);
      expect(() => deleteCredentialConfig(config, dirname(config))).toThrow(/credential config/);
      expect(() => deleteCredentialConfig(config, join(home, "workspace"))).toThrow(/workspace/);
      process.env.WORKSPACE_DIR = "/mnt/work";
      expect(() => deleteCredentialConfig(config, "/mnt/work")).toThrow(/workspace/);
      expect(existsSync(config)).toBe(true);
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedWorkspace === undefined) delete process.env.WORKSPACE_DIR;
      else process.env.WORKSPACE_DIR = savedWorkspace;
    }
  });
});
