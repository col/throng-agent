---
"@throng/agent-core": minor
---

Route third-party MCP servers through a local credential-fetching proxy.

An `mcp_servers` entry may now carry `proxy: { server_id, credentials_url? }`. At boot, when any entry
has one, the runtime starts a loopback HTTP proxy and hands the engine
`http://127.0.0.1:<port>/mcp/<name>` in place of the real URL. For each request the proxy obtains a
short-lived credential, forwards upstream with it, and retries once on a `401` after refetching. With
`credentials_url`, it POSTs `{ server, server_id, url }` to that endpoint, authenticated with the
top-level `credentials.token`, and expects `{ headers, expires_at }`; without it, the entry's inline
`headers` are used (development mode). Credentials are cached until shortly before `expires_at`, and
re-checked at least every few minutes. No header value or token is ever logged.

The manifest is validated at initialise: `proxy.server_id` is required, `proxy.credentials_url` must be
`https://` and needs a `credentials` block, and a proxied entry with neither that nor `headers` is
rejected. A proxy that fails to start fails the boot at step `mcp`; `shutdown()` closes it.

New exports: `startMcpProxy`, the `McpProxy` manifest type. `BootDeps` gains an optional
`startMcpProxy`, defaulting to the real one, so existing consumers need no change.
