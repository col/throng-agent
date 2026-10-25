import type { CredentialsConfig, McpHttpServer, McpProxy } from "../manifest/types.js";

export interface FetchedCredentials {
  headers: Record<string, string>;
  /** Null: the headers never expire (inline manifest headers). */
  expiresAt: Date | null;
}

export type CredentialFetcher = (name: string) => Promise<FetchedCredentials>;

/**
 * A credential could not be obtained. The message is safe to show to the
 * engine (and so the model): it is either Throng's own static message or a
 * static fallback, never anything derived from a header or token.
 */
export class McpCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpCredentialError";
  }
}

const FETCH_TIMEOUT_MS = 10_000;
const MAX_MESSAGE_LENGTH = 300;

const FALLBACK_UNAVAILABLE = "Could not obtain credentials for this MCP server";
const FALLBACK_UNREACHABLE = "Could not reach Throng to obtain credentials for this MCP server";

interface Entry extends FetchedCredentials {}

/**
 * Per-server credential cache. Concurrent `get`s for one name share a single
 * fetch, and an entry is refetched once it is within `marginMs` of expiry.
 * Failures are never cached.
 */
export class CredentialCache {
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<Entry>>();
  private readonly marginMs: number;
  private readonly now: () => number;

  constructor(
    private readonly fetcher: CredentialFetcher,
    opts: { marginMs?: number; now?: () => number } = {},
  ) {
    this.marginMs = opts.marginMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  async get(name: string): Promise<Record<string, string>> {
    const entry = this.entries.get(name);
    if (entry && this.fresh(entry)) return { ...entry.headers };

    let pending = this.inflight.get(name);
    if (!pending) {
      pending = this.fetcher(name).then((fetched) => {
        if (this.inflight.get(name) === pending) this.entries.set(name, fetched);
        return fetched;
      });
      const mine = pending;
      const clear = () => {
        if (this.inflight.get(name) === mine) this.inflight.delete(name);
      };
      mine.then(clear, clear);
      this.inflight.set(name, pending);
    }
    return { ...(await pending).headers };
  }

  invalidate(name: string): void {
    this.entries.delete(name);
    this.inflight.delete(name);
  }

  private fresh(entry: Entry): boolean {
    return entry.expiresAt === null || this.now() < entry.expiresAt.getTime() - this.marginMs;
  }
}

/**
 * Builds the fetcher for one proxied server. With a `credentials_url` it asks
 * Throng for a short-lived credential (authenticated by the instance token);
 * otherwise it serves the manifest's inline `headers`.
 */
export function throngFetcher(
  server: McpHttpServer & { proxy: McpProxy },
  name: string,
  credentials: CredentialsConfig | null,
): Promise<FetchedCredentials> {
  const { credentials_url: credentialsUrl, server_id: serverId } = server.proxy;
  if (!credentialsUrl) {
    return Promise.resolve({ headers: { ...(server.headers ?? {}) }, expiresAt: null });
  }
  if (!credentials) return Promise.reject(new McpCredentialError(FALLBACK_UNAVAILABLE));
  return fetchFromThrong(credentialsUrl, credentials.token, name, serverId, server.url);
}

async function fetchFromThrong(
  credentialsUrl: string,
  token: string,
  name: string,
  serverId: string,
  upstreamUrl: string,
): Promise<FetchedCredentials> {
  let res: Response;
  try {
    res = await fetch(credentialsUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ server: name, server_id: serverId, url: upstreamUrl }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new McpCredentialError(FALLBACK_UNREACHABLE);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (res.status !== 200) {
    const message = (body as { message?: unknown } | null)?.message;
    throw new McpCredentialError(
      typeof message === "string" && message.length > 0
        ? message.slice(0, MAX_MESSAGE_LENGTH)
        : FALLBACK_UNAVAILABLE,
    );
  }

  const parsed = body as { headers?: unknown; expires_at?: unknown } | null;
  const headers = parsed?.headers;
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    throw new McpCredentialError(FALLBACK_UNAVAILABLE);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v !== "string") throw new McpCredentialError(FALLBACK_UNAVAILABLE);
    out[k] = v;
  }

  // A missing or unparsable expiry would otherwise mean "cache forever",
  // which is wrong for a short-lived credential: treat it as already expired.
  const expiresAt =
    typeof parsed?.expires_at === "string" ? new Date(parsed.expires_at) : new Date(0);
  return { headers: out, expiresAt: Number.isNaN(expiresAt.getTime()) ? new Date(0) : expiresAt };
}
