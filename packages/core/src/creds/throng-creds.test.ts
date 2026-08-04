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
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";

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

interface Stub {
  url: string;
  requests: Array<{
    method: string | undefined;
    path: string | undefined;
    body: string;
    auth: string | undefined;
    contentType: string | undefined;
    idempotency: string | undefined;
  }>;
  close: () => Promise<void>;
}

/** A stand-in for POST /v1/credentials/github. `reply` decides each response. */
async function stubApi(
  reply: (n: number) => { status: number; body: unknown },
): Promise<Stub> {
  const requests: Stub["requests"] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({
        // The stub answers any method on any path, so the method and URL are
        // recorded and asserted rather than assumed: POST /v1/credentials/github
        // is the hardest part of this contract to change later.
        method: req.method,
        path: req.url,
        body,
        auth: req.headers.authorization,
        contentType: req.headers["content-type"],
        idempotency: req.headers["idempotency-key"] as string | undefined,
      });
      const { status, body: payload } = reply(requests.length);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const stubs: Stub[] = [];
afterEach(async () => {
  while (stubs.length) await stubs.pop()!.close();
});

async function api(reply: (n: number) => { status: number; body: unknown }): Promise<Stub> {
  const s = await stubApi(reply);
  stubs.push(s);
  return s;
}

// The username is deliberately NOT "x-access-token": that is the script's own
// fallback, so an identical value here would let a hardcoded literal pass for
// working server-to-cache plumbing.
const okBody = (token: string, expiresAt: string) => ({
  username: "bot-user",
  token,
  expires_at: expiresAt,
  scope: { repos: ["acme/app"], permissions: { contents: "write" } },
});

const isoIn = (seconds: number) =>
  new Date(Date.now() + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

describe("throng-creds credentials API", () => {
  it("mints a token, sends the task identity, and caches the result", async () => {
    const dir = sandbox();
    const stub = await api(() => ({ status: 200, body: okBody("ghs_minted", isoIn(3600)) }));
    writeConfig(dir, { credentials: { url: stub.url, token: "task-tok" } });

    const r = await run(dir, ["git", "get"], { stdin: getStdin("acme/app.git") });

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("password=ghs_minted");
    expect(r.stdout).toContain("username=bot-user");
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0].method).toBe("POST");
    expect(stub.requests[0].path).toBe("/v1/credentials/github");
    expect(stub.requests[0].auth).toBe("Bearer task-tok");
    expect(stub.requests[0].contentType).toBe("application/json");
    expect(stub.requests[0].idempotency).toBeTruthy();
    expect(JSON.parse(stub.requests[0].body)).toEqual({
      purpose: "git",
      host: "github.com",
      repo: "acme/app",
    });
  });

  it("omits repo entirely for gh, so the server applies the default scope", async () => {
    const dir = sandbox();
    const stub = await api(() => ({ status: 200, body: okBody("ghs_api", isoIn(3600)) }));
    writeConfig(dir, { credentials: { url: stub.url, token: "task-tok" } });

    await run(dir, ["gh"]);

    expect(JSON.parse(stub.requests[0].body)).toEqual({ purpose: "api", host: "github.com" });
  });

  // serve_until is expires_at minus skew, so the fast path needs no ISO parsing
  // and no arithmetic of its own.
  it("writes serve_until 300s before the true expiry", async () => {
    const dir = sandbox();
    const expiresAt = isoIn(3600);
    const stub = await api(() => ({ status: 200, body: okBody("ghs_x", expiresAt) }));
    writeConfig(dir, { credentials: { url: stub.url, token: "task-tok" } });

    await run(dir, ["git", "get"], { stdin: getStdin("acme/app.git") });

    const lines = readFileSync(join(dir, "cache", "git_github.com_acme_app"), "utf8").split("\n");
    const trueExpiry = Math.floor(new Date(expiresAt).getTime() / 1000);
    expect(Number(lines[0])).toBe(trueExpiry - 300);
    expect(lines[1]).toBe("git|github.com|acme/app");
    expect(lines).toContain(`password_expiry_utc=${trueExpiry}`);
  });

  it("does not call the API twice for the same key", async () => {
    const dir = sandbox();
    const stub = await api(() => ({ status: 200, body: okBody("ghs_once", isoIn(3600)) }));
    writeConfig(dir, { credentials: { url: stub.url, token: "task-tok" } });

    await run(dir, ["git", "get"], { stdin: getStdin("acme/app.git") });
    const second = await run(dir, ["git", "get"], { stdin: getStdin("acme/app.git") });

    expect(second.stdout).toContain("password=ghs_once");
    expect(stub.requests).toHaveLength(1);
  });

  it("403 is permanent, names the repo, and tells the agent not to work around it", async () => {
    const dir = sandbox();
    const stub = await api(() => ({
      status: 403,
      body: { message: "acme/secret is not in this task's grant" },
    }));
    writeConfig(dir, { credentials: { url: stub.url, token: "task-tok" } });

    const r = await run(dir, ["git", "get"], { stdin: getStdin("acme/secret.git") });

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("acme/secret");
    expect(r.stderr).toContain("will not change on retry");
    expect(r.stderr).toContain("different repository or remote");
    expect(r.stderr).toContain("is not in this task's grant");
    expect(stub.requests).toHaveLength(1); // never retried
  });

  it("401 reports a revoked or completed task", async () => {
    const dir = sandbox();
    const stub = await api(() => ({ status: 401, body: {} }));
    writeConfig(dir, { credentials: { url: stub.url, token: "task-tok" } });

    const r = await run(dir, ["git", "get"], { stdin: getStdin("acme/app.git") });

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("revoked or completed");
    expect(stub.requests).toHaveLength(1);
  });

  it("429 is described as transient and retryable", async () => {
    const dir = sandbox();
    const stub = await api(() => ({ status: 429, body: {} }));
    writeConfig(dir, { credentials: { url: stub.url, token: "task-tok" } });

    const r = await run(dir, ["git", "get"], { stdin: getStdin("acme/app.git") });

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("transient");
    expect(r.stderr).toContain("retry the same command");
  });

  it("retries a 5xx and succeeds when the retry does", async () => {
    const dir = sandbox();
    const stub = await api((n) =>
      n === 1
        ? { status: 503, body: {} }
        : { status: 200, body: okBody("ghs_afterretry", isoIn(3600)) },
    );
    writeConfig(dir, { credentials: { url: stub.url, token: "task-tok" } });

    const r = await run(dir, ["git", "get"], { stdin: getStdin("acme/app.git") });

    expect(r.stdout).toContain("password=ghs_afterretry");
    expect(stub.requests.length).toBeGreaterThanOrEqual(2);
  });

  it("reports an unreachable service as transient", async () => {
    const dir = sandbox();
    writeConfig(dir, { credentials: { url: "http://127.0.0.1:1", token: "task-tok" } });

    const r = await run(dir, ["git", "get"], { stdin: getStdin("acme/app.git") });

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("transient");
  });

  it("rejects a 200 that omits expires_at rather than caching forever", async () => {
    const dir = sandbox();
    const stub = await api(() => ({ status: 200, body: { username: "x", token: "ghs_x" } }));
    writeConfig(dir, { credentials: { url: stub.url, token: "task-tok" } });

    const r = await run(dir, ["git", "get"], { stdin: getStdin("acme/app.git") });

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("expires_at");
  });

  // Unlike expires_at, a missing username has one safe universal value.
  it("falls back to x-access-token when the server omits username", async () => {
    const dir = sandbox();
    const stub = await api(() => ({
      status: 200,
      body: { token: "ghs_nouser", expires_at: isoIn(3600) },
    }));
    writeConfig(dir, { credentials: { url: stub.url, token: "task-tok" } });

    const r = await run(dir, ["git", "get"], { stdin: getStdin("acme/app.git") });

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("username=x-access-token");
    expect(r.stdout).toContain("password=ghs_nouser");
  });

  // A 404 — a mistyped credentials.url, or an API version bump — is the
  // likeliest unclassified status, and it never succeeds. Telling the agent to
  // retry it is the same mislabelling the 403 message exists to avoid.
  it("describes an unclassified 4xx as permanent, not transient", async () => {
    const dir = sandbox();
    const stub = await api(() => ({ status: 404, body: {} }));
    writeConfig(dir, { credentials: { url: stub.url, token: "task-tok" } });

    const r = await run(dir, ["git", "get"], { stdin: getStdin("acme/app.git") });

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("404");
    expect(r.stderr).toContain("retrying will not help");
    // The exact phrase the 5xx branch uses, and the one that would mislead here.
    expect(r.stderr).not.toContain("This is transient");
    expect(stub.requests).toHaveLength(1);
  });

  // serve_until would land in the past, so write_cache would succeed and
  // read_fresh would then reject the entry it had just written — declining with
  // no output and no reason, and re-minting on every operation.
  it("refuses a token that expires within the skew window", async () => {
    const dir = sandbox();
    const stub = await api(() => ({ status: 200, body: okBody("ghs_toosoon", isoIn(60)) }));
    writeConfig(dir, { credentials: { url: stub.url, token: "task-tok" } });

    const r = await run(dir, ["git", "get"], { stdin: getStdin("acme/app.git") });

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("too soon to use");
    expect(existsSync(join(dir, "cache", "git_github.com_acme_app"))).toBe(false);
  });
});
