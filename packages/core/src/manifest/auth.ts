import type { Env } from "../env.js";
import type { FieldError } from "./types.js";

/**
 * One credential mode an engine accepts. The ordered list an adapter declares
 * is, at once: the accepted `agent.auth.type` values, the env-fallback sources
 * in precedence order, the injection target for the selected type, and the
 * scrub set for every type that was not selected. Keeping them as one
 * declaration is what stops the four from drifting apart.
 */
export interface AuthScheme {
  type: string;
  env: string;
}

/** A resolved credential. `token` is guaranteed trimmed and non-blank. */
export interface ResolvedAuth {
  type: string;
  token: string;
}

export type AuthResolution =
  | { ok: true; auth: ResolvedAuth | null }
  | { ok: false; errors: FieldError[] };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const blankToNil = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;

/**
 * Resolves the one credential an engine will use: the manifest's `agent.auth`
 * block if present, else the first non-blank env var walking `schemes` in
 * order, else null.
 *
 * An `auth` block short-circuits the environment entirely, valid or not — a
 * caller who stated their intent and got it wrong should see the 400, not have
 * a different billing mode silently substituted, which is the failure this
 * whole shape exists to prevent.
 *
 * A blank token is an error rather than being coerced to absent. The old
 * `api_key` was a bare string with no way to signal intent, so coercion was the
 * only option; an explicit block that names a type and then carries no token is
 * unambiguously a caller bug.
 */
export function resolveAuth(
  agent: Record<string, unknown>,
  env: Env,
  schemes: AuthScheme[],
): AuthResolution {
  const block = agent.auth;
  if (block !== undefined) {
    if (!isObject(block)) {
      return { ok: false, errors: [{ field: "agent.auth", reason: "must be an object" }] };
    }
    const errors: FieldError[] = [];
    const scheme = schemes.find((s) => s.type === block.type);
    if (!scheme) {
      errors.push({
        field: "agent.auth.type",
        reason: `must be one of ${schemes.map((s) => s.type).join("/")}`,
      });
    }
    const token = blankToNil(block.token);
    if (token === null) {
      errors.push({ field: "agent.auth.token", reason: "must be a non-empty string" });
    }
    // Both guards re-tested together so TypeScript narrows; `errors` is
    // non-empty whenever either failed.
    if (!scheme || token === null) return { ok: false, errors };
    return { ok: true, auth: { type: scheme.type, token } };
  }

  for (const scheme of schemes) {
    const token = blankToNil(env[scheme.env]);
    if (token !== null) return { ok: true, auth: { type: scheme.type, token } };
  }
  return { ok: true, auth: null };
}

/**
 * Puts the resolved credential into the process environment and removes every
 * competing one.
 *
 * The scrub is the point of this function. The Agent SDK reads its credential
 * off the process environment, and the A2A wrappers hand it a copy of
 * `process.env` — so a key that is merely ambient in the sandbox (baked into the
 * image, passed with a host `-e`, left by an earlier configuration) reaches the
 * engine even when the manifest never mentioned it, and the run silently bills
 * the wrong account. Precedence between the competing variables is internal to
 * the engine and not a documented contract, so it is not relied on: the losing
 * variables are removed outright.
 *
 * Safe to call during initialise because the wrappers snapshot `process.env`
 * per query, long after this has run.
 *
 * A null `auth` scrubs nothing: nothing was selected, so nothing is claimed and
 * whatever the operator put in the environment is left as they left it.
 */
export function applyAuth(
  auth: ResolvedAuth | null,
  schemes: AuthScheme[],
  alsoScrub: string[] = [],
): void {
  if (auth === null) return;
  const selected = schemes.find((s) => s.type === auth.type);
  if (!selected) {
    throw new Error(`no auth scheme is registered for type '${auth.type}'`);
  }
  // Scrub every candidate including the selected one, then set — so the result
  // is correct even if a scrub name ever collided with the injection target.
  for (const name of [...schemes.map((s) => s.env), ...alsoScrub]) {
    delete process.env[name];
  }
  process.env[selected.env] = auth.token;
}
