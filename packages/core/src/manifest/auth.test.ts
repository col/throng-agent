import { describe, expect, it } from "vitest";
import { resolveAuth, type AuthResolution, type AuthScheme } from "./auth.js";

const SCHEMES: AuthScheme[] = [
  { type: "oauth", env: "CLAUDE_CODE_OAUTH_TOKEN" },
  { type: "api_key", env: "ANTHROPIC_API_KEY" },
];
const API_KEY_ONLY: AuthScheme[] = [{ type: "api_key", env: "OPENAI_API_KEY" }];

/** Unwraps a successful resolution, failing the test with the errors if not. */
const auth = (r: AuthResolution) => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.errors)}`);
  return r.auth;
};
/** The field names of a failed resolution, in the order they were reported. */
const fields = (r: AuthResolution) => (r.ok ? [] : r.errors.map((e) => e.field));

describe("resolveAuth", () => {
  it("prefers the manifest auth block over every env var", () => {
    const r = resolveAuth(
      { auth: { type: "oauth", token: "oat-manifest" } },
      { CLAUDE_CODE_OAUTH_TOKEN: "oat-env", ANTHROPIC_API_KEY: "sk-env" },
      SCHEMES,
    );
    expect(auth(r)).toEqual({ type: "oauth", token: "oat-manifest" });
  });

  it("accepts each type the table lists", () => {
    expect(auth(resolveAuth({ auth: { type: "api_key", token: "sk-1" } }, {}, SCHEMES)))
      .toEqual({ type: "api_key", token: "sk-1" });
  });

  it("falls back through the env vars in table order", () => {
    const r = resolveAuth(
      {},
      { CLAUDE_CODE_OAUTH_TOKEN: "oat-env", ANTHROPIC_API_KEY: "sk-env" },
      SCHEMES,
    );
    expect(auth(r)).toEqual({ type: "oauth", token: "oat-env" });
  });

  it("falls through to a later env var when the earlier one is unset", () => {
    expect(auth(resolveAuth({}, { ANTHROPIC_API_KEY: "sk-env" }, SCHEMES)))
      .toEqual({ type: "api_key", token: "sk-env" });
  });

  it("skips blank env values", () => {
    const r = resolveAuth({}, { CLAUDE_CODE_OAUTH_TOKEN: "   ", ANTHROPIC_API_KEY: "sk-env" }, SCHEMES);
    expect(auth(r)).toEqual({ type: "api_key", token: "sk-env" });
  });

  it("returns null when nothing is set anywhere", () => {
    expect(auth(resolveAuth({}, {}, SCHEMES))).toBe(null);
  });

  it("rejects an auth block that is not an object", () => {
    expect(fields(resolveAuth({ auth: "sk-1" }, {}, SCHEMES))).toEqual(["agent.auth"]);
    expect(fields(resolveAuth({ auth: null }, {}, SCHEMES))).toEqual(["agent.auth"]);
    expect(fields(resolveAuth({ auth: [] }, {}, SCHEMES))).toEqual(["agent.auth"]);
  });

  it("rejects a type the table does not list, naming the accepted ones", () => {
    const r = resolveAuth({ auth: { type: "oauth", token: "x" } }, {}, API_KEY_ONLY);
    expect(fields(r)).toEqual(["agent.auth.type"]);
    if (!r.ok) expect(r.errors[0].reason).toBe("must be one of api_key");
  });

  it("rejects a missing type", () => {
    expect(fields(resolveAuth({ auth: { token: "x" } }, {}, SCHEMES))).toEqual(["agent.auth.type"]);
  });

  it("rejects a missing, non-string or blank token", () => {
    expect(fields(resolveAuth({ auth: { type: "oauth" } }, {}, SCHEMES))).toEqual(["agent.auth.token"]);
    expect(fields(resolveAuth({ auth: { type: "oauth", token: 5 } }, {}, SCHEMES))).toEqual(["agent.auth.token"]);
    expect(fields(resolveAuth({ auth: { type: "oauth", token: "  " } }, {}, SCHEMES))).toEqual(["agent.auth.token"]);
  });

  it("reports a bad type and a bad token together", () => {
    expect(fields(resolveAuth({ auth: { type: "nope", token: "" } }, {}, SCHEMES)))
      .toEqual(["agent.auth.type", "agent.auth.token"]);
  });

  it("never falls back to the environment once an auth block is present", () => {
    const r = resolveAuth({ auth: { type: "nope", token: "x" } }, { ANTHROPIC_API_KEY: "sk-env" }, SCHEMES);
    expect(r.ok).toBe(false);
  });
});
