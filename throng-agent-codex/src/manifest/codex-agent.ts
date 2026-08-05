import { resolveAuth, type AgentResult, type Env, type FieldError, type ResolvedAuth } from "@throng/agent-core";
import { CODEX_AUTH_SCHEMES } from "../config/credentials.js";

const SANDBOX_MODES = new Set(["read-only", "workspace-write", "danger-full-access"]);
const APPROVAL_POLICIES = new Set(["never", "on-request", "on-failure", "untrusted"]);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The resolved, Codex-shaped agent payload stored on `manifest.agent`. */
export interface ResolvedCodexAgent {
  keys: Record<string, unknown>;
  auth: ResolvedAuth | null;
}

export function validateCodexAgent(
  input: Record<string, unknown>,
  env: Env,
): AgentResult<ResolvedCodexAgent> {
  const errors: FieldError[] = [];
  let auth: ResolvedAuth | null = null;

  if (!("agent" in input)) {
    errors.push({ field: "agent", reason: "is required" });
  } else if (!isObject(input.agent)) {
    errors.push({ field: "agent", reason: "must be an object" });
  } else {
    const a = input.agent;
    if ("model" in a && typeof a.model !== "string") {
      errors.push({ field: "agent.model", reason: "must be a string" });
    }
    if ("sandbox_mode" in a && !SANDBOX_MODES.has(a.sandbox_mode as string)) {
      errors.push({
        field: "agent.sandbox_mode",
        reason: "must be one of read-only/workspace-write/danger-full-access",
      });
    }
    if ("approval_policy" in a && !APPROVAL_POLICIES.has(a.approval_policy as string)) {
      errors.push({
        field: "agent.approval_policy",
        reason: "must be one of never/on-request/on-failure/untrusted",
      });
    }
    const authResult = resolveAuth(a, env, CODEX_AUTH_SCHEMES);
    if (authResult.ok) auth = authResult.auth;
    else errors.push(...authResult.errors);
  }

  if (errors.length > 0) return { ok: false, errors };

  const a = (input.agent as Record<string, unknown>) ?? {};
  return { ok: true, agent: { keys: a, auth } };
}
