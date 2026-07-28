import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertNoAnthropicKeyInSettings, injectAnthropicKey } from "./credentials.js";

const tmp = () => mkdtempSync(join(tmpdir(), "a2a-cred-"));

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
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

describe("assertNoAnthropicKeyInSettings", () => {
  it("passes when the settings file is absent", () => {
    expect(() => assertNoAnthropicKeyInSettings(join(tmp(), "settings.json"))).not.toThrow();
  });

  it("passes when settings has no env.ANTHROPIC_API_KEY", () => {
    const p = join(tmp(), "settings.json");
    writeFileSync(p, JSON.stringify({ env: { FOO: "bar" } }));
    expect(() => assertNoAnthropicKeyInSettings(p)).not.toThrow();
  });

  it("throws when settings pins env.ANTHROPIC_API_KEY", () => {
    const p = join(tmp(), "settings.json");
    writeFileSync(p, JSON.stringify({ env: { ANTHROPIC_API_KEY: "sk-oops" } }));
    expect(() => assertNoAnthropicKeyInSettings(p)).toThrow(/ANTHROPIC_API_KEY/);
  });
});
