import { resolveAuth, type AgentResult, type Env, type FieldError, type ResolvedAuth } from "@throng/agent-core";
import { CLAUDE_AUTH_SCHEMES } from "../config/credentials.js";
import { EMPTY_PLUGINS, resolvePlugins, type ResolvedPlugins } from "../config/plugins.js";

const PERMISSION_MODES = new Set(["acceptEdits", "dontAsk", "plan", "bypassPermissions"]);
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);
const THINKING_TYPES = new Set(["adaptive", "disabled", "enabled"]);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The resolved, Claude-shaped agent payload stored on `manifest.agent`. */
export interface ResolvedClaudeAgent {
  /** Raw agent keys (model, tools, system prompts, max_turns, permission_mode). */
  keys: Record<string, unknown>;
  plugins: ResolvedPlugins;
  auth: ResolvedAuth | null;
}

export function validateClaudeAgent(
  input: Record<string, unknown>,
  env: Env,
): AgentResult<ResolvedClaudeAgent> {
  const errors: FieldError[] = [];
  let plugins: ResolvedPlugins = EMPTY_PLUGINS;
  let auth: ResolvedAuth | null = null;

  if (!("agent" in input)) {
    errors.push({ field: "agent", reason: "is required" });
  } else if (!isObject(input.agent)) {
    errors.push({ field: "agent", reason: "must be an object" });
  } else {
    const a = input.agent;
    if ("permission_mode" in a && !PERMISSION_MODES.has(a.permission_mode as string)) {
      errors.push({
        field: "agent.permission_mode",
        reason: "must be one of acceptEdits/dontAsk/plan/bypassPermissions",
      });
    }
    if ("model" in a && typeof a.model !== "string") {
      errors.push({ field: "agent.model", reason: "must be a string" });
    }
    if ("effort" in a && !EFFORT_LEVELS.has(a.effort as string)) {
      errors.push({ field: "agent.effort", reason: "must be one of low/medium/high/xhigh/max" });
    }
    if ("thinking" in a) {
      const t = a.thinking;
      if (!isObject(t) || !THINKING_TYPES.has(t.type as string)) {
        errors.push({
          field: "agent.thinking",
          reason: "must be an object with type adaptive/disabled/enabled",
        });
      } else if (
        t.type === "enabled" &&
        (typeof t.budget_tokens !== "number" || !Number.isInteger(t.budget_tokens) || t.budget_tokens < 1024)
      ) {
        errors.push({
          field: "agent.thinking.budget_tokens",
          reason: "must be an integer >= 1024 when type is enabled",
        });
      }
    }
    const resolution = resolvePlugins(a.plugins);
    if (resolution.ok) plugins = resolution.resolved;
    else errors.push(...resolution.errors);

    const authResult = resolveAuth(a, env, CLAUDE_AUTH_SCHEMES);
    if (authResult.ok) auth = authResult.auth;
    else errors.push(...authResult.errors);
  }

  if (errors.length > 0) return { ok: false, errors };

  const a = (input.agent as Record<string, unknown>) ?? {};
  return { ok: true, agent: { keys: a, plugins, auth } };
}
