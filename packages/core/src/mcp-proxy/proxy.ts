import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { CredentialsConfig, McpHttpServer, McpProxy } from "../manifest/types.js";
import { log } from "../log.js";
import { CredentialCache, McpCredentialError, throngFetcher } from "./credential-cache.js";

/** Request headers forwarded to the upstream; everything else is dropped. */
const FORWARDED_REQUEST_HEADERS = [
  "content-type",
  "accept",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
] as const;

/** Upstream response headers copied back to the engine. */
const FORWARDED_RESPONSE_HEADERS = ["content-type", "mcp-session-id"] as const;

const MAX_BODY_BYTES = 16 * 1024 * 1024;
const JSON_RPC_CREDENTIAL_ERROR = -32001;
const JSON_RPC_UPSTREAM_ERROR = -32002;

export interface McpProxyHandle {
  /** The servers to hand to the engine: proxied entries point at the loopback. */
  engineServers: Record<string, McpHttpServer>;
  close(): Promise<void>;
}

type ProxiedServer = McpHttpServer & { proxy: McpProxy };

function isProxied(server: McpHttpServer): server is ProxiedServer {
  return server.proxy !== undefined;
}

const REJECTED_CREDENTIALS =
  "The MCP server rejected Throng's credentials. Reconnect it in Throng organisation settings.";

class BodyTooLargeError extends Error {}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BodyTooLargeError());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** The JSON-RPC id of a single request body, or null (batches, non-JSON, empty). */
function requestId(body: Buffer): string | number | null {
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const id = (parsed as { id?: unknown }).id;
      if (typeof id === "string" || typeof id === "number") return id;
    }
  } catch {
    // not JSON
  }
  return null;
}

function sendJsonRpcError(
  res: ServerResponse,
  status: number,
  id: string | number | null,
  code: number,
  message: string,
): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
}

/**
 * Starts the loopback MCP proxy. Proxied servers are rewritten to
 * `http://127.0.0.1:<port>/mcp/<name>`; the proxy forwards each request to the
 * real upstream with credentials injected, so the engine never holds one.
 * Entries without `proxy` pass through to the engine unchanged.
 *
 * Header values and tokens are never logged.
 */
export async function startMcpProxy(
  servers: Record<string, McpHttpServer>,
  credentials: CredentialsConfig | null,
): Promise<McpProxyHandle> {
  const proxied = new Map<string, ProxiedServer>();
  for (const [name, server] of Object.entries(servers)) {
    if (isProxied(server)) proxied.set(name, server);
  }

  const cache = new CredentialCache((name) => throngFetcher(proxied.get(name)!, name, credentials));

  const httpServer = createServer((req, res) => {
    handle(req, res).catch(() => {
      // Only a bug can land here; the message could carry anything, so log none of it.
      log.error("mcp proxy: unexpected handler failure");
      sendJsonRpcError(res, 500, null, JSON_RPC_UPSTREAM_ERROR, "MCP proxy failed");
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const match = /^\/mcp\/([^/?]+)(?:\?.*)?$/.exec(req.url ?? "");
    const name = match ? decodeNameSafely(match[1]!) : null;
    const server = name !== null ? proxied.get(name) : undefined;
    if (!server || name === null) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
      return;
    }

    let body: Buffer;
    try {
      body = await readBody(req);
    } catch (e) {
      if (e instanceof BodyTooLargeError) {
        res.writeHead(413, { "content-type": "text/plain" });
        res.end("Request body too large");
      } else {
        res.destroy();
      }
      return;
    }
    const id = requestId(body);

    // Cancel the upstream request if the engine goes away before we finish.
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });

    const send = async (): Promise<Response> => {
      const credentialHeaders = await cache.get(name);
      const headers: Record<string, string> = {};
      for (const h of FORWARDED_REQUEST_HEADERS) {
        const v = req.headers[h];
        if (typeof v === "string") headers[h] = v;
      }
      // Credentials go on last so the engine can never override them.
      for (const [k, v] of Object.entries(credentialHeaders)) {
        for (const existing of Object.keys(headers)) {
          if (existing.toLowerCase() === k.toLowerCase()) delete headers[existing];
        }
        headers[k] = v;
      }
      return fetch(server.url, {
        method: req.method,
        headers,
        body: body.length > 0 && req.method !== "GET" && req.method !== "HEAD" ? new Uint8Array(body) : undefined,
        signal: abort.signal,
        redirect: "manual",
      });
    };

    let upstream: Response;
    try {
      upstream = await send();
      if (upstream.status === 401) {
        // Nothing has been written to the engine yet, so one retry is safe.
        await upstream.body?.cancel().catch(() => {});
        cache.invalidate(name);
        upstream = await send();
      }
      if (upstream.status === 401) {
        // Still rejected with fresh credentials. Passing the 401 on would invite
        // the engine to start its own OAuth discovery against the loopback.
        await upstream.body?.cancel().catch(() => {});
        log.warn("mcp proxy: upstream rejected credentials", { server: name });
        sendJsonRpcError(res, 502, id, JSON_RPC_CREDENTIAL_ERROR, REJECTED_CREDENTIALS);
        return;
      }
    } catch (e) {
      if (abort.signal.aborted) return;
      if (e instanceof McpCredentialError) {
        log.warn("mcp proxy: credentials unavailable", { server: name });
        sendJsonRpcError(res, 502, id, JSON_RPC_CREDENTIAL_ERROR, e.message);
      } else {
        log.warn("mcp proxy: upstream request failed", { server: name });
        sendJsonRpcError(res, 502, id, JSON_RPC_UPSTREAM_ERROR, "Could not reach the MCP server");
      }
      return;
    }

    const outHeaders: Record<string, string> = {};
    for (const h of FORWARDED_RESPONSE_HEADERS) {
      const v = upstream.headers.get(h);
      if (v !== null) outHeaders[h] = v;
    }
    res.writeHead(upstream.status, outHeaders);
    if (!upstream.body) {
      res.end();
      return;
    }
    const stream = Readable.fromWeb(upstream.body as WebReadableStream<Uint8Array>);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (httpServer.address() as { port: number }).port;

  const engineServers: Record<string, McpHttpServer> = {};
  for (const [name, server] of Object.entries(servers)) {
    engineServers[name] = isProxied(server)
      ? { type: "http", url: `http://127.0.0.1:${port}/mcp/${encodeURIComponent(name)}` }
      : server;
  }

  return {
    engineServers,
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        httpServer.closeAllConnections();
      }),
  };
}

function decodeNameSafely(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}
