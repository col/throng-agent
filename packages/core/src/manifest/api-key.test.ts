import { describe, expect, it } from "vitest";
import { resolveApiKey } from "./api-key.js";

describe("resolveApiKey", () => {
  it("prefers the manifest agent.api_key", () => {
    expect(resolveApiKey({ api_key: "sk-manifest" }, { ANTHROPIC_API_KEY: "sk-env" }, ["ANTHROPIC_API_KEY"]))
      .toBe("sk-manifest");
  });
  it("falls back to the first non-blank env var", () => {
    expect(resolveApiKey({}, { OPENAI_API_KEY: "sk-env" }, ["OPENAI_API_KEY"])).toBe("sk-env");
  });
  it("treats a blank manifest value as absent", () => {
    expect(resolveApiKey({ api_key: "  " }, { ANTHROPIC_API_KEY: "sk-env" }, ["ANTHROPIC_API_KEY"]))
      .toBe("sk-env");
  });
  it("returns null when nothing is set", () => {
    expect(resolveApiKey({}, {}, ["ANTHROPIC_API_KEY"])).toBe(null);
  });
});
