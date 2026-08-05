---
"@throng/agent-core": minor
"throng-agent-claude": minor
"throng-agent-codex": minor
---

Replace `agent.api_key` with a tagged `agent.auth: { type, token }` block, so a Claude task can run
billed against a Claude Code subscription instead of API credits.

`type: "oauth"` takes the kind of token `claude setup-token` mints and lands as
`CLAUDE_CODE_OAUTH_TOKEN`; `type: "api_key"` is unchanged in effect, landing as `ANTHROPIC_API_KEY` for
claude and `OPENAI_API_KEY` for codex. Codex accepts `api_key` only. Both fields are required and
`token` must be non-blank — a blank token is a caller error, not coerced to absent, since silently
falling back to a different billing mode is exactly the failure this shape exists to prevent. The
resolved token is trimmed, on both the manifest and env-fallback paths, so a copy-pasted trailing
newline never reaches the SDK's environment. `auth` may still be omitted, falling back to the
environment (`CLAUDE_CODE_OAUTH_TOKEN` then `ANTHROPIC_API_KEY` for claude, `OPENAI_API_KEY` for
codex), then to no credential.

Selecting a type now clears the competing environment variables. The Agent SDK reads its credential
off the process environment and the A2A wrappers hand it a copy of `process.env`, so a key that is
merely ambient in the sandbox — baked into the image, passed with a host `-e`, left by an earlier
configuration — would otherwise reach the engine regardless of what the manifest asked for, and the
run would silently bill the wrong account. Whichever type is selected (or none), `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` are all removed from the environment before the
winner, if any, is set, so the billing mode is a guarantee rather than a bet on the engine's internal
precedence between them.

The claude settings guard (`assertNoAnthropicKeyInSettings` → `assertNoAnthropicCredentialInSettings`)
widens to match: a `~/.claude/settings.json` is now a hard boot error if its `env` block *mentions*
any of the three variables above (key presence, not truthiness — an empty pin erases the credential
just as effectively as a deleted one) or if it sets a top-level `apiKeyHelper`, which outranks
`CLAUDE_CODE_OAUTH_TOKEN` in Claude Code's own precedence and survives the environment scrub since it
isn't an environment variable at all.

**Breaking:** `agent.api_key` is removed outright, with no alias or deprecation window — a manifest
still sending it resolves no credential at all. For library consumers: core's `resolveApiKey`
(`src/manifest/api-key.ts`) is replaced by `resolveAuth`/`applyAuth` (`src/manifest/auth.ts`), and
`ResolvedClaudeAgent`/`ResolvedCodexAgent` carry `auth: ResolvedAuth | null` in place of
`api_key: string | null`.
