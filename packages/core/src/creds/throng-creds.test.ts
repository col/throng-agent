import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
