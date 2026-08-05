import { afterEach, describe, expect, it } from "vitest";
import { applyAuth, resolveAuth, type AuthResolution, type AuthScheme } from "./auth.js";

const SCHEMES: AuthScheme[] = [
  { type: "oauth", env: "CLAUDE_CODE_OAUTH_TOKEN" },
  { type: "api_key", env: "ANTHROPIC_API_KEY" },
];

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
    for (const scheme of SCHEMES) {
      const token = `tok-${scheme.type}`;
      expect(auth(resolveAuth({ auth: { type: scheme.type, token } }, {}, SCHEMES)))
        .toEqual({ type: scheme.type, token });
    }
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
    const r = resolveAuth({ auth: "sk-1" }, {}, SCHEMES);
    expect(fields(r)).toEqual(["agent.auth"]);
    if (!r.ok) expect(r.errors[0].reason).toBe("must be an object");
    expect(fields(resolveAuth({ auth: null }, {}, SCHEMES))).toEqual(["agent.auth"]);
    expect(fields(resolveAuth({ auth: [] }, {}, SCHEMES))).toEqual(["agent.auth"]);
  });

  it("rejects a type the table does not list, naming the accepted ones", () => {
    const r = resolveAuth({ auth: { type: "nope", token: "x" } }, {}, SCHEMES);
    expect(fields(r)).toEqual(["agent.auth.type"]);
    if (!r.ok) expect(r.errors[0].reason).toBe("must be one of oauth/api_key");
  });

  it("rejects a missing type", () => {
    expect(fields(resolveAuth({ auth: { token: "x" } }, {}, SCHEMES))).toEqual(["agent.auth.type"]);
  });

  it("rejects a missing, non-string or blank token", () => {
    const r = resolveAuth({ auth: { type: "oauth" } }, {}, SCHEMES);
    expect(fields(r)).toEqual(["agent.auth.token"]);
    if (!r.ok) expect(r.errors[0].reason).toBe("must be a non-empty string");
    expect(fields(resolveAuth({ auth: { type: "oauth", token: 5 } }, {}, SCHEMES))).toEqual(["agent.auth.token"]);
    expect(fields(resolveAuth({ auth: { type: "oauth", token: "  " } }, {}, SCHEMES))).toEqual(["agent.auth.token"]);
  });

  it("trims surrounding whitespace from a resolved token", () => {
    expect(auth(resolveAuth({ auth: { type: "oauth", token: "  oat-1  \n" } }, {}, SCHEMES)))
      .toEqual({ type: "oauth", token: "oat-1" });
    expect(auth(resolveAuth({}, { ANTHROPIC_API_KEY: "\tsk-env\n" }, SCHEMES)))
      .toEqual({ type: "api_key", token: "sk-env" });
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

const CREDENTIAL_VARS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];
const ALSO_SCRUB = ["ANTHROPIC_AUTH_TOKEN"];

describe("applyAuth", () => {
  // applyAuth deletes keys, not just sets them, so the whole set is restored.
  const saved = Object.fromEntries(CREDENTIAL_VARS.map((n) => [n, process.env[n]]));
  afterEach(() => {
    for (const n of CREDENTIAL_VARS) {
      const v = saved[n];
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
    }
  });

  it("sets the selected variable", () => {
    applyAuth({ type: "oauth", token: "oat-1" }, SCHEMES, ALSO_SCRUB);
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oat-1");
  });

  it("clears a competing scheme variable that was already set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ambient";
    applyAuth({ type: "oauth", token: "oat-1" }, SCHEMES, ALSO_SCRUB);
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oat-1");
  });

  it("clears an alsoScrub variable, which is never a fallback source", () => {
    process.env.ANTHROPIC_AUTH_TOKEN = "at-ambient";
    applyAuth({ type: "oauth", token: "oat-1" }, SCHEMES, ALSO_SCRUB);
    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("clears the OAuth token when the api_key mode is selected", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oat-ambient";
    applyAuth({ type: "api_key", token: "sk-1" }, SCHEMES, ALSO_SCRUB);
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-1");
  });

  it("leaves the environment untouched when nothing was resolved", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ambient";
    applyAuth(null, SCHEMES, ALSO_SCRUB);
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ambient");
  });

  it("defaults alsoScrub to empty", () => {
    applyAuth({ type: "api_key", token: "sk-1" }, SCHEMES);
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-1");
  });

  it("throws when the type has no scheme in the table", () => {
    expect(() => applyAuth({ type: "nope", token: "x" }, SCHEMES)).toThrow(/nope/);
  });
});
