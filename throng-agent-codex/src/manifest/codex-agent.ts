import type { AgentResult, Env, FieldError } from "@throng/agent-core";

const SANDBOX_MODES = new Set(["read-only", "workspace-write", "danger-full-access"]);
const APPROVAL_POLICIES = new Set(["never", "on-request", "on-failure", "untrusted"]);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const blankToNil = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v : null;

/** The resolved, Codex-shaped agent payload stored on `manifest.agent`. */
export interface ResolvedCodexAgent {
  /** Raw agent keys (model, sandbox_mode, approval_policy, web_search_mode, etc.). */
  keys: Record<string, unknown>;
  openai_api_key: string | null;
}

export function validateCodexAgent(
  input: Record<string, unknown>,
  env: Env,
): AgentResult<ResolvedCodexAgent> {
  const errors: FieldError[] = [];

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
  }

  if ("openai_api_key" in input && typeof input.openai_api_key !== "string") {
    errors.push({ field: "openai_api_key", reason: "must be a string" });
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    agent: {
      keys: (input.agent as Record<string, unknown>) ?? {},
      openai_api_key: blankToNil(input.openai_api_key) ?? blankToNil(env.OPENAI_API_KEY),
    },
  };
}
