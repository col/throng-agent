import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAuth } from "@throng/agent-core";
import {
  assertNoAnthropicCredentialInSettings,
  CLAUDE_AUTH_ALSO_SCRUB,
  CLAUDE_AUTH_SCHEMES,
} from "./credentials.js";

const tmp = () => mkdtempSync(join(tmpdir(), "a2a-cred-"));

/** Writes a settings.json with the given top-level contents and returns its path. */
const settingsFile = (contents: Record<string, unknown>) => {
  const p = join(tmp(), "settings.json");
  writeFileSync(p, JSON.stringify(contents));
  return p;
};

/** Writes a settings.json with the given `env` block and returns its path. */
const settingsWith = (env: Record<string, unknown>) => settingsFile({ env });

describe("CLAUDE_AUTH_SCHEMES", () => {
  it("lists oauth before api_key, so an exported OAuth token wins the env tier", () => {
    expect(
      resolveAuth({}, { CLAUDE_CODE_OAUTH_TOKEN: "oat", ANTHROPIC_API_KEY: "sk" }, CLAUDE_AUTH_SCHEMES),
    ).toEqual({ ok: true, auth: { type: "oauth", token: "oat" } });
  });

  it("scrubs ANTHROPIC_AUTH_TOKEN without accepting it as a source", () => {
    expect(
      CLAUDE_AUTH_SCHEMES.map((s) => s.env).filter((e) => CLAUDE_AUTH_ALSO_SCRUB.includes(e)),
    ).toEqual([]);
  });

  it("has a unique type per scheme", () => {
    const types = CLAUDE_AUTH_SCHEMES.map((s) => s.type);
    expect(new Set(types).size).toBe(types.length);
  });
});

describe("assertNoAnthropicCredentialInSettings", () => {
  it("passes when the settings file is absent", () => {
    expect(() => assertNoAnthropicCredentialInSettings(join(tmp(), "settings.json"))).not.toThrow();
  });

  it("passes when the settings file is unparseable", () => {
    const p = join(tmp(), "settings.json");
    writeFileSync(p, "{not json");
    expect(() => assertNoAnthropicCredentialInSettings(p)).not.toThrow();
  });

  it("passes when settings pins nothing credential-shaped", () => {
    expect(() => assertNoAnthropicCredentialInSettings(settingsWith({ FOO: "bar" }))).not.toThrow();
  });

  it("passes when settings has no env block at all", () => {
    const p = join(tmp(), "settings.json");
    writeFileSync(p, JSON.stringify({ model: "claude-opus-5" }));
    expect(() => assertNoAnthropicCredentialInSettings(p)).not.toThrow();
  });

  it("throws when settings pins env.ANTHROPIC_API_KEY", () => {
    expect(() => assertNoAnthropicCredentialInSettings(settingsWith({ ANTHROPIC_API_KEY: "sk-oops" })))
      .toThrow(/ANTHROPIC_API_KEY/);
  });

  it("throws when settings pins env.CLAUDE_CODE_OAUTH_TOKEN", () => {
    expect(() => assertNoAnthropicCredentialInSettings(settingsWith({ CLAUDE_CODE_OAUTH_TOKEN: "oat-oops" })))
      .toThrow(/CLAUDE_CODE_OAUTH_TOKEN/);
  });

  it("throws when settings pins env.ANTHROPIC_AUTH_TOKEN", () => {
    expect(() => assertNoAnthropicCredentialInSettings(settingsWith({ ANTHROPIC_AUTH_TOKEN: "at-oops" })))
      .toThrow(/ANTHROPIC_AUTH_TOKEN/);
  });

  it("throws when settings pins env.ANTHROPIC_API_KEY to an empty string", () => {
    // A settings `env` block replaces the inherited variable rather than
    // merging with it, so an empty pin erases the credential we just set and
    // reads as unset — exactly as dangerous as pinning a real value.
    expect(() => assertNoAnthropicCredentialInSettings(settingsWith({ ANTHROPIC_API_KEY: "" })))
      .toThrow(/ANTHROPIC_API_KEY/);
  });

  it("reports every pinned credential, not just the first", () => {
    let message = "";
    try {
      assertNoAnthropicCredentialInSettings(
        settingsWith({ ANTHROPIC_API_KEY: "sk-oops", CLAUDE_CODE_OAUTH_TOKEN: "oat-oops" }),
      );
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/ANTHROPIC_API_KEY/);
    expect(message).toMatch(/CLAUDE_CODE_OAUTH_TOKEN/);
  });

  it("throws when settings names a top-level apiKeyHelper", () => {
    // Outranks CLAUDE_CODE_OAUTH_TOKEN in Claude Code's own precedence and
    // isn't an environment variable, so applyAuth's scrub can't touch it.
    expect(() => assertNoAnthropicCredentialInSettings(settingsFile({ apiKeyHelper: "/bin/get-key.sh" })))
      .toThrow(/apiKeyHelper/);
  });
});
