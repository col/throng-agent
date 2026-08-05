import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Manifest } from "@throng/agent-core";
import { ClaudeEngineAdapter } from "./adapter.js";
import { CLAUDE_AUTH_ALSO_SCRUB, CLAUDE_AUTH_SCHEMES } from "./config/credentials.js";
import type { ResolvedClaudeAgent } from "./manifest/claude-agent.js";

// Derived, not hand-maintained, so it can't drift from what applyAuth actually
// touches (see packages/core/src/manifest/auth.test.ts for the same idiom).
const CREDENTIAL_VARS = [...CLAUDE_AUTH_SCHEMES.map((s) => s.env), ...CLAUDE_AUTH_ALSO_SCRUB];

describe("ClaudeEngineAdapter", () => {
  // injectCredentials both mutates the credential env vars (via applyAuth) and
  // reads the real ~/.claude/settings.json (via assertNoAnthropicCredentialInSettings).
  // Snapshot/clear the former so a leaked deletion can't leak into whichever test
  // vitest's worker runs next, and point HOME at an empty temp dir so these tests
  // don't depend on — or fail on — whatever this machine's settings.json contains.
  let savedEnv: Record<string, string | undefined>;
  let savedHome: string | undefined;
  beforeEach(() => {
    savedEnv = Object.fromEntries(CREDENTIAL_VARS.map((n) => [n, process.env[n]]));
    for (const n of CREDENTIAL_VARS) delete process.env[n];
    savedHome = process.env.HOME;
    process.env.HOME = mkdtempSync(join(tmpdir(), "a2a-adapter-"));
  });
  afterEach(() => {
    for (const n of CREDENTIAL_VARS) {
      const v = savedEnv[n];
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
    }
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });

  it("validateAgent rejects a missing agent block", () => {
    const a = new ClaudeEngineAdapter();
    expect(a.validateAgent({}, {}).ok).toBe(false);
  });

  it("classifyBootError names plugins when a marketplace is configured", () => {
    const a = new ClaudeEngineAdapter();
    const manifest = {
      agent: { plugins: { local: [], marketplaces: { m: {} }, enabledPlugins: {}, unpinned: [] } },
    } as unknown as Manifest<ResolvedClaudeAgent>;
    expect(a.classifyBootError(new Error("plugin did not load"), manifest)).toBe("plugins");
    expect(a.classifyBootError(new Error("something else"), manifest)).toBe(undefined);
  });

  it("injectCredentials selects OAuth and clears an ambient API key and alsoScrub var", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ambient";
    process.env.ANTHROPIC_AUTH_TOKEN = "at-ambient";
    new ClaudeEngineAdapter().injectCredentials({
      platform: "claude",
      agent: {
        keys: {},
        plugins: { local: [], marketplaces: {}, enabledPlugins: {}, unpinned: [] },
        auth: { type: "oauth", token: "oat-x" },
      },
    } as unknown as Manifest<ResolvedClaudeAgent>);
    // The ambient key is the whole point: the SDK reads it off the environment,
    // so leaving it set would bill API credits despite the OAuth manifest.
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oat-x");
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    // ANTHROPIC_AUTH_TOKEN is never a valid manifest input, so it must be
    // cleared unconditionally — this is the only place that wiring is exercised
    // through the real adapter rather than a hand-built applyAuth call.
    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("injectCredentials selects the API key and clears an ambient OAuth token", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oat-ambient";
    new ClaudeEngineAdapter().injectCredentials({
      platform: "claude",
      agent: {
        keys: {},
        plugins: { local: [], marketplaces: {}, enabledPlugins: {}, unpinned: [] },
        auth: { type: "api_key", token: "sk-x" },
      },
    } as unknown as Manifest<ResolvedClaudeAgent>);
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-x");
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
});
