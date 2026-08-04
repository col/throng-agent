import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./throng-creds.sh", import.meta.url));

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

const tmpRoots: string[] = [];

/** A fresh sandbox: its own config path and cache dir, so tests never collide. */
export function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "throng-creds-"));
  tmpRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

/** Spawn the real script. `bash` from PATH is bash 3.2 on macOS — deliberate. */
export function run(
  dir: string,
  args: string[],
  opts: { stdin?: string; env?: Record<string, string> } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(
      "bash",
      [SCRIPT, ...args],
      {
        env: {
          ...process.env,
          THRONG_CONFIG: join(dir, "config.json"),
          THRONG_CREDS_CACHE: join(dir, "cache"),
          ...opts.env,
        },
      },
      (err, stdout, stderr) => {
        const code = err ? ((err as { code?: number }).code ?? 1) : 0;
        resolve({ stdout, stderr, code });
      },
    );
    child.stdin?.end(opts.stdin ?? "");
  });
}

/** Write a cache entry directly, so fast-path tests need no server. */
export function seedCache(
  dir: string,
  key: string,
  opts: { serveUntil: number; token: string; keyLine?: string },
): void {
  const cache = join(dir, "cache");
  mkdirSync(cache, { recursive: true });
  const file = join(cache, key.replace(/[^A-Za-z0-9._-]/g, "_"));
  writeFileSync(
    file,
    [
      String(opts.serveUntil),
      opts.keyLine ?? key,
      "username=x-access-token",
      `password=${opts.token}`,
      `password_expiry_utc=${opts.serveUntil + 300}`,
      "",
    ].join("\n"),
  );
}

export const soon = () => Math.floor(Date.now() / 1000) + 3600;
export const past = () => Math.floor(Date.now() / 1000) - 60;

/** git speaks to a credential helper in `key=value` lines ended by a blank line. */
const getStdin = (path: string) =>
  `protocol=https\nhost=github.com\npath=${path}\n\n`;

describe("throng-creds fast path", () => {
  it("serves a fresh cache entry without touching the network", async () => {
    const dir = sandbox();
    seedCache(dir, "git|github.com|acme/app", { serveUntil: soon(), token: "ghs_cached" });

    const r = await run(dir, ["git", "get"], { stdin: getStdin("acme/app.git") });

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("username=x-access-token");
    expect(r.stdout).toContain("password=ghs_cached");
    expect(r.stdout).toContain("quit=1");
  });

  it("ignores an entry past its serve window", async () => {
    const dir = sandbox();
    seedCache(dir, "git|github.com|acme/app", { serveUntil: past(), token: "ghs_stale" });

    const r = await run(dir, ["git", "get"], { stdin: getStdin("acme/app.git") });

    // No config file, so the slow path declines: exit 0 and no credential.
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("ghs_stale");
  });

  it("ignores an entry whose recorded key does not match (filename collision)", async () => {
    const dir = sandbox();
    // "acme/app" and "acme_app" both sanitise to the filename "acme_app".
    seedCache(dir, "git|github.com|acme/app", {
      serveUntil: soon(),
      token: "ghs_wrongrepo",
      keyLine: "git|github.com|acme_app",
    });

    const r = await run(dir, ["git", "get"], { stdin: getStdin("acme/app.git") });

    expect(r.stdout).not.toContain("ghs_wrongrepo");
  });

  it("ignores a malformed cache file rather than serving garbage", async () => {
    const dir = sandbox();
    mkdirSync(join(dir, "cache"), { recursive: true });
    writeFileSync(join(dir, "cache", "git_github.com_acme_app"), "not-a-number\nwhatever\n");

    const r = await run(dir, ["git", "get"], { stdin: getStdin("acme/app.git") });

    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("password=");
  });
});

describe("throng-creds decline rules", () => {
  it("declines a non-HTTPS protocol so git falls through", async () => {
    const dir = sandbox();
    seedCache(dir, "git|github.com|acme/app", { serveUntil: soon(), token: "ghs_x" });

    const r = await run(dir, ["git", "get"], {
      stdin: "protocol=ssh\nhost=github.com\npath=acme/app.git\n\n",
    });

    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("declines a host other than github.com", async () => {
    const dir = sandbox();
    seedCache(dir, "git|gitlab.com|acme/app", { serveUntil: soon(), token: "ghs_x" });

    const r = await run(dir, ["git", "get"], {
      stdin: "protocol=https\nhost=gitlab.com\npath=acme/app.git\n\n",
    });

    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("derives the same repo with or without a trailing .git", async () => {
    const dir = sandbox();
    seedCache(dir, "git|github.com|acme/app", { serveUntil: soon(), token: "ghs_same" });

    const withSuffix = await run(dir, ["git", "get"], {
      stdin: "protocol=https\nhost=github.com\npath=acme/app.git\n\n",
    });
    const without = await run(dir, ["git", "get"], {
      stdin: "protocol=https\nhost=github.com\npath=acme/app\n\n",
    });

    expect(withSuffix.stdout).toContain("password=ghs_same");
    expect(without.stdout).toContain("password=ghs_same");
  });

  it("strips a leading slash from path", async () => {
    const dir = sandbox();
    seedCache(dir, "git|github.com|acme/app", { serveUntil: soon(), token: "ghs_slash" });

    const r = await run(dir, ["git", "get"], {
      stdin: "protocol=https\nhost=github.com\npath=/acme/app.git\n\n",
    });

    expect(r.stdout).toContain("password=ghs_slash");
  });

  it("falls back to the default scope when useHttpPath is off (no path sent)", async () => {
    const dir = sandbox();
    seedCache(dir, "git|github.com|", { serveUntil: soon(), token: "ghs_default" });

    const r = await run(dir, ["git", "get"], {
      stdin: "protocol=https\nhost=github.com\n\n",
    });

    expect(r.stdout).toContain("password=ghs_default");
  });
});

describe("throng-creds store/erase/gh", () => {
  it("store consumes stdin and exits 0 without persisting anything", async () => {
    const dir = sandbox();

    const r = await run(dir, ["git", "store"], {
      stdin: "protocol=https\nhost=github.com\nusername=x\npassword=y\n\n",
    });

    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(existsSync(join(dir, "cache"))).toBe(false);
  });

  // Git calls erase after a 401. Everything must go, so the next operation
  // re-mints rather than replaying a token GitHub has already rejected.
  it("erase clears the cache", async () => {
    const dir = sandbox();
    seedCache(dir, "git|github.com|acme/app", { serveUntil: soon(), token: "ghs_dead" });
    seedCache(dir, "api|github.com|", { serveUntil: soon(), token: "ghs_dead2" });

    const r = await run(dir, ["git", "erase"], {
      stdin: "protocol=https\nhost=github.com\n\n",
    });

    expect(r.code).toBe(0);
    expect(existsSync(join(dir, "cache")) ? readdirSync(join(dir, "cache")) : []).toEqual([]);
  });

  it("gh prints a bare token from the default-scope entry", async () => {
    const dir = sandbox();
    seedCache(dir, "api|github.com|", { serveUntil: soon(), token: "ghs_forgh" });

    const r = await run(dir, ["gh"]);

    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("ghs_forgh");
  });

  it("gh prints nothing and exits 0 when unconfigured", async () => {
    const dir = sandbox();

    const r = await run(dir, ["gh"]);

    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });
});

/** Write the config file throng-creds reads on a cache miss. */
function writeConfig(dir: string, config: Record<string, unknown>): void {
  writeFileSync(join(dir, "config.json"), JSON.stringify(config, null, 2));
}

describe("throng-creds config resolution", () => {
  it("declines silently when there is no config file", async () => {
    const dir = sandbox();

    const r = await run(dir, ["git", "get"], { stdin: getStdin("acme/app.git") });

    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
  });

  it("declines when the config carries neither a token nor credentials", async () => {
    const dir = sandbox();
    writeConfig(dir, {});

    const r = await run(dir, ["git", "get"], { stdin: getStdin("acme/app.git") });

    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("serves a static github_token and caches it", async () => {
    const dir = sandbox();
    writeConfig(dir, { github_token: "ghp_static" });

    const r = await run(dir, ["git", "get"], { stdin: getStdin("acme/app.git") });

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("password=ghp_static");
    expect(r.stdout).toContain("quit=1");

    // Far-future expiry: every later call is a fast-path hit, so a standalone
    // sandbox takes the slow path once per key for its whole life.
    const entry = readFileSync(join(dir, "cache", "git_github.com_acme_app"), "utf8");
    const serveUntil = Number(entry.split("\n")[0]);
    expect(serveUntil).toBeGreaterThan(Math.floor(Date.now() / 1000) + 365 * 24 * 3600);
  });

  it("serves the static token for gh as well", async () => {
    const dir = sandbox();
    writeConfig(dir, { github_token: "ghp_static" });

    const r = await run(dir, ["gh"]);

    expect(r.stdout.trim()).toBe("ghp_static");
  });

  it("prefers a static github_token over credentials", async () => {
    const dir = sandbox();
    writeConfig(dir, {
      github_token: "ghp_static",
      // Unreachable on purpose: if this were consulted the test would hang or fail.
      credentials: { url: "http://127.0.0.1:1", token: "task-tok" },
    });

    const r = await run(dir, ["git", "get"], { stdin: getStdin("acme/app.git") });

    expect(r.stdout).toContain("password=ghp_static");
  });
});
