import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertNoAnthropicCredentialInSettings,
  injectAnthropicKey,
  CLAUDE_AUTH_ALSO_SCRUB,
  CLAUDE_AUTH_SCHEMES,
} from "./credentials.js";

const tmp = () => mkdtempSync(join(tmpdir(), "a2a-cred-"));

/** Writes a settings.json with the given `env` block and returns its path. */
const settingsWith = (env: Record<string, unknown>) => {
  const p = join(tmp(), "settings.json");
  writeFileSync(p, JSON.stringify({ env }));
  return p;
};

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

describe("CLAUDE_AUTH_SCHEMES", () => {
  it("lists oauth before api_key, so an exported OAuth token wins the env tier", () => {
    expect(CLAUDE_AUTH_SCHEMES).toEqual([
      { type: "oauth", env: "CLAUDE_CODE_OAUTH_TOKEN" },
      { type: "api_key", env: "ANTHROPIC_API_KEY" },
    ]);
  });

  it("scrubs ANTHROPIC_AUTH_TOKEN without accepting it as a source", () => {
    expect(CLAUDE_AUTH_ALSO_SCRUB).toEqual(["ANTHROPIC_AUTH_TOKEN"]);
    expect(CLAUDE_AUTH_SCHEMES.map((s) => s.env)).not.toContain("ANTHROPIC_AUTH_TOKEN");
  });
});

describe("injectAnthropicKey", () => {
  it("sets process.env when a key is given", () => {
    injectAnthropicKey("sk-test");
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-test");
  });

  it("leaves env untouched when key is null", () => {
    injectAnthropicKey(null);
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
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
});
