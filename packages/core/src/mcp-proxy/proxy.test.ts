import { describe, it, expect, afterEach } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { McpHttpServer } from "../manifest/types.js";
import { startMcpProxy } from "./proxy.js";
import { throngFetcher, McpCredentialError } from "./credential-cache.js";

interface Seen {
  method: string | undefined;
  path: string | undefined;
  headers: IncomingMessage["headers"];
  body: string;
}

interface Stub {
  url: string;
  seen: Seen[];
  close: () => Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function stub(handler: (req: IncomingMessage, res: ServerResponse, seen: Seen[], body: string) => void): Promise<Stub> {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, path: req.url, headers: req.headers, body });
      handler(req, res, seen, body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const s: Stub = {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
  cleanups.push(s.close);
  return s;
}

function json(res: ServerResponse, status: number, payload: unknown, extra: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...extra });
  res.end(JSON.stringify(payload));
}

/** A credentials endpoint handing out `Bearer tok<n>` tokens. */
async function credsApi(reply?: (n: number) => { status: number; body: unknown }) {
  return stub((_req, res, seen) => {
    const n = seen.length;
    const r = reply?.(n) ?? {
      status: 200,
      body: {
        headers: { authorization: `Bearer tok${n}` },
        expires_at: new Date(Date.now() + 300_000).toISOString(),
      },
    };
    json(res, r.status, r.body);
  });
}

async function proxyFor(upstream: Stub, creds: Stub, extra: Record<string, McpHttpServer> = {}) {
  const servers: Record<string, McpHttpServer> = {
    notion: {
      type: "http",
      url: `${upstream.url}/mcp`,
      proxy: { server_id: "srv-1", credentials_url: `${creds.url}/api/v1/mcp/credentials` },
    },
    ...extra,
  };
  const proxy = await startMcpProxy(servers, { url: "unused", token: "inst-token" });
  cleanups.push(() => proxy.close());
  return proxy;
}

function rpc(id: number | string = 1) {
  return JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list" });
}

describe("startMcpProxy", () => {
  it("injects fetched headers and forwards body", async () => {
    const upstream = await stub((_req, res) => json(res, 200, { ok: true }));
    const creds = await credsApi();
    const proxy = await proxyFor(upstream, creds);

    const res = await fetch(proxy.engineServers.notion!.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: rpc(),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(upstream.seen).toHaveLength(1);
    expect(upstream.seen[0]!.method).toBe("POST");
    expect(upstream.seen[0]!.path).toBe("/mcp");
    expect(upstream.seen[0]!.body).toBe(rpc());
    expect(upstream.seen[0]!.headers.authorization).toBe("Bearer tok1");
    expect(upstream.seen[0]!.headers["content-type"]).toBe("application/json");

    // The credentials request carries the instance token and the server identity.
    expect(creds.seen[0]!.method).toBe("POST");
    expect(creds.seen[0]!.path).toBe("/api/v1/mcp/credentials");
    expect(creds.seen[0]!.headers.authorization).toBe("Bearer inst-token");
    expect(JSON.parse(creds.seen[0]!.body)).toEqual({
      server: "notion",
      server_id: "srv-1",
      url: `${upstream.url}/mcp`,
    });
  });

  it("rewrites proxied entries and passes non-proxied ones through untouched", async () => {
    const plain: McpHttpServer = { type: "http", url: "https://example.com/mcp", headers: { authorization: "Bearer plain" } };
    const upstream = await stub((_req, res) => json(res, 200, {}));
    const creds = await credsApi();
    const proxy = await proxyFor(upstream, creds, { plain });

    expect(proxy.engineServers.plain).toEqual(plain);
    expect(proxy.engineServers.notion).toEqual({
      type: "http",
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/notion$/),
    });
  });

  it("strips non-allowlisted request headers", async () => {
    const upstream = await stub((_req, res) => json(res, 200, {}));
    const creds = await credsApi();
    const proxy = await proxyFor(upstream, creds);

    await fetch(proxy.engineServers.notion!.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "session=secret",
        authorization: "Bearer engine-supplied",
        "x-custom": "nope",
        "mcp-protocol-version": "2025-06-18",
      },
      body: rpc(),
    });

    const h = upstream.seen[0]!.headers;
    expect(h.cookie).toBeUndefined();
    expect(h["x-custom"]).toBeUndefined();
    expect(h.authorization).toBe("Bearer tok1"); // credential wins over the engine's
    expect(h["mcp-protocol-version"]).toBe("2025-06-18");
  });

  it("streams SSE events without buffering", async () => {
    let secondSent = false;
    const upstream = await stub((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: one\n\n");
      setTimeout(() => {
        secondSent = true;
        res.write("data: two\n\n");
        res.end();
      }, 200);
    });
    const creds = await credsApi();
    const proxy = await proxyFor(upstream, creds);

    const res = await fetch(proxy.engineServers.notion!.url, {
      headers: { accept: "text/event-stream" },
    });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    const firstSentBeforeSecond = !secondSent;
    expect(decoder.decode(first.value)).toContain("data: one");
    expect(firstSentBeforeSecond).toBe(true);

    let rest = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += decoder.decode(value);
    }
    expect(rest).toContain("data: two");
  });

  it("retries once on 401 with a refetched token", async () => {
    const upstream = await stub((req, res) => {
      if (req.headers.authorization === "Bearer tok1") return json(res, 401, { error: "expired" });
      json(res, 200, { ok: true });
    });
    const creds = await credsApi();
    const proxy = await proxyFor(upstream, creds);

    const res = await fetch(proxy.engineServers.notion!.url, { method: "POST", headers: { "content-type": "application/json" }, body: rpc() });

    expect(res.status).toBe(200);
    expect(upstream.seen.map((s) => s.headers.authorization)).toEqual(["Bearer tok1", "Bearer tok2"]);
    expect(upstream.seen[1]!.body).toBe(rpc()); // body replayed
    expect(creds.seen).toHaveLength(2);
  });

  it("does not retry twice, and turns the final 401 into a credential error", async () => {
    const upstream = await stub((_req, res) =>
      json(res, 401, { error: "nope" }, { "www-authenticate": 'Bearer resource_metadata="https://x/prm"' }),
    );
    const creds = await credsApi();
    const proxy = await proxyFor(upstream, creds);

    const res = await fetch(proxy.engineServers.notion!.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: rpc(4),
    });

    // Not a 401: the engine must not start its own OAuth discovery against the loopback.
    expect(res.status).toBe(502);
    expect(res.headers.get("www-authenticate")).toBeNull();
    expect(await res.json()).toEqual({
      jsonrpc: "2.0",
      id: 4,
      error: {
        code: -32001,
        message: "The MCP server rejected Throng's credentials. Reconnect it in Throng organisation settings.",
      },
    });
    expect(upstream.seen).toHaveLength(2);
    expect(creds.seen).toHaveLength(2);
  });

  it("answers an oversized request body with 413 and never calls upstream", async () => {
    const upstream = await stub((_req, res) => json(res, 200, {}));
    const creds = await credsApi();
    const proxy = await proxyFor(upstream, creds);

    const res = await fetch(proxy.engineServers.notion!.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new Uint8Array(16 * 1024 * 1024 + 1),
    });

    expect(res.status).toBe(413);
    expect(await res.text()).toBe("Request body too large");
    expect(upstream.seen).toHaveLength(0);
    expect(creds.seen).toHaveLength(0);
  });

  it("returns a JSON-RPC error with Throng's message when credentials 409", async () => {
    const upstream = await stub((_req, res) => json(res, 200, {}));
    const creds = await credsApi(() => ({ status: 409, body: { message: "Reconnect Notion in Throng" } }));
    const proxy = await proxyFor(upstream, creds);

    const res = await fetch(proxy.engineServers.notion!.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: rpc(7),
    });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32001, message: "Reconnect Notion in Throng" },
    });
    expect(upstream.seen).toHaveLength(0);
  });

  it("uses a null id when the request body is not a single JSON-RPC request", async () => {
    const upstream = await stub((_req, res) => json(res, 200, {}));
    const creds = await credsApi(() => ({ status: 503, body: {} }));
    const proxy = await proxyFor(upstream, creds);

    const res = await fetch(proxy.engineServers.notion!.url, { method: "GET" });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { id: unknown; error: { code: number; message: string } };
    expect(body.id).toBeNull();
    expect(body.error.code).toBe(-32001);
    expect(body.error.message.length).toBeGreaterThan(0);
  });

  it("propagates mcp-session-id both ways", async () => {
    const upstream = await stub((req, res) => {
      json(res, 200, {}, { "mcp-session-id": "sess-from-upstream", "x-leak": "no" });
      void req;
    });
    const creds = await credsApi();
    const proxy = await proxyFor(upstream, creds);

    const res = await fetch(proxy.engineServers.notion!.url, {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-session-id": "sess-from-engine" },
      body: rpc(),
    });

    expect(upstream.seen[0]!.headers["mcp-session-id"]).toBe("sess-from-engine");
    expect(res.headers.get("mcp-session-id")).toBe("sess-from-upstream");
    expect(res.headers.get("x-leak")).toBeNull();
  });

  it("returns 404 for unknown server names", async () => {
    const upstream = await stub((_req, res) => json(res, 200, {}));
    const creds = await credsApi();
    const proxy = await proxyFor(upstream, creds);
    const base = proxy.engineServers.notion!.url.replace(/\/notion$/, "");

    expect((await fetch(`${base}/nope`, { method: "POST", body: "{}" })).status).toBe(404);
    expect((await fetch(`${base}/__proto__`, { method: "POST", body: "{}" })).status).toBe(404);
    expect((await fetch(base.replace("/mcp", "/other"), { method: "POST", body: "{}" })).status).toBe(404);
    expect(upstream.seen).toHaveLength(0);
  });

  it("aborts the upstream request when the client disconnects", async () => {
    let upstreamClosed!: () => void;
    const closed = new Promise<void>((r) => (upstreamClosed = r));
    const upstream = await stub((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: one\n\n");
      res.on("close", () => upstreamClosed());
    });
    const creds = await credsApi();
    const proxy = await proxyFor(upstream, creds);

    const ac = new AbortController();
    const res = await fetch(proxy.engineServers.notion!.url, { signal: ac.signal });
    await res.body!.getReader().read();
    ac.abort();
    await closed;
  });

  it("close() stops accepting connections", async () => {
    const upstream = await stub((_req, res) => json(res, 200, {}));
    const creds = await credsApi();
    const proxy = await proxyFor(upstream, creds);
    const url = proxy.engineServers.notion!.url;
    await proxy.close();
    await expect(fetch(url)).rejects.toThrow();
  });

  it("serves inline-header proxy entries without calling Throng", async () => {
    const upstream = await stub((_req, res) => json(res, 200, {}));
    const proxy = await startMcpProxy(
      {
        inline: {
          type: "http",
          url: `${upstream.url}/mcp`,
          headers: { authorization: "Bearer inline" },
          proxy: { server_id: "srv-2" },
        },
      },
      null,
    );
    cleanups.push(() => proxy.close());

    await fetch(proxy.engineServers.inline!.url, { method: "POST", body: rpc() });
    expect(upstream.seen[0]!.headers.authorization).toBe("Bearer inline");
  });
});

describe("throngFetcher", () => {
  const server = (creds?: string): McpHttpServer & { proxy: { server_id: string; credentials_url?: string } } => ({
    type: "http",
    url: "https://mcp.example.com/mcp",
    proxy: { server_id: "srv-1", ...(creds ? { credentials_url: creds } : {}) },
  });

  it("parses headers and expires_at", async () => {
    const exp = new Date(Date.now() + 120_000);
    const creds = await credsApi(() => ({ status: 200, body: { headers: { authorization: "Bearer a" }, expires_at: exp.toISOString() } }));
    const out = await throngFetcher(server(`${creds.url}/c`), "notion", { url: "x", token: "t" });
    expect(out.headers).toEqual({ authorization: "Bearer a" });
    expect(out.expiresAt?.getTime()).toBe(exp.getTime());
  });

  it("returns inline headers with no expiry", async () => {
    const s = { ...server(), headers: { authorization: "Bearer inline" } };
    expect(await throngFetcher(s, "x", null)).toEqual({ headers: { authorization: "Bearer inline" }, expiresAt: null });
  });

  it("throws McpCredentialError with the response message", async () => {
    const creds = await credsApi(() => ({ status: 403, body: { message: "Not allowed" } }));
    await expect(throngFetcher(server(`${creds.url}/c`), "n", { url: "x", token: "t" })).rejects.toMatchObject({
      name: "McpCredentialError",
      message: "Not allowed",
    });
  });

  it("falls back to a static message when the body has none", async () => {
    const creds = await stub((_req, res) => {
      res.writeHead(503);
      res.end("<html>secret-ish upstream detail</html>");
    });
    const err = await throngFetcher(server(`${creds.url}/c`), "n", { url: "x", token: "t" }).catch((e) => e);
    expect(err).toBeInstanceOf(McpCredentialError);
    expect(err.message).not.toContain("secret-ish");
    expect(err.message.length).toBeGreaterThan(0);
  });

  it("throws when a credentials_url is set but there is no instance credential", async () => {
    await expect(throngFetcher(server("http://127.0.0.1:1/c"), "n", null)).rejects.toBeInstanceOf(McpCredentialError);
  });
});
