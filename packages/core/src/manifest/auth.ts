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

/** A resolved credential. `token` is guaranteed non-blank. */
export interface ResolvedAuth {
  type: string;
  token: string;
}

export type AuthResolution =
  | { ok: true; auth: ResolvedAuth | null }
  | { ok: false; errors: FieldError[] };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const nonBlank = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v : null;

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
    const token = nonBlank(block.token);
    if (token === null) {
      errors.push({ field: "agent.auth.token", reason: "must be a non-empty string" });
    }
    // Both guards re-tested together so TypeScript narrows; `errors` is
    // non-empty whenever either failed.
    if (!scheme || token === null) return { ok: false, errors };
    return { ok: true, auth: { type: scheme.type, token } };
  }

  for (const scheme of schemes) {
    const token = nonBlank(env[scheme.env]);
    if (token !== null) return { ok: true, auth: { type: scheme.type, token } };
  }
  return { ok: true, auth: null };
}
