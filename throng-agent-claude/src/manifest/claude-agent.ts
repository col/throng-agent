import type { AgentResult, Env, FieldError } from "@throng/agent-core";
import { EMPTY_PLUGINS, resolvePlugins, type ResolvedPlugins } from "../config/plugins.js";

const PERMISSION_MODES = new Set(["acceptEdits", "dontAsk", "plan", "bypassPermissions"]);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const blankToNil = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v : null;

/** The resolved, Claude-shaped agent payload stored on `manifest.agent`. */
export interface ResolvedClaudeAgent {
  /** Raw agent keys (model, tools, system prompts, max_turns, permission_mode). */
  keys: Record<string, unknown>;
  plugins: ResolvedPlugins;
  anthropic_api_key: string | null;
}

export function validateClaudeAgent(
  input: Record<string, unknown>,
  env: Env,
): AgentResult<ResolvedClaudeAgent> {
  const errors: FieldError[] = [];
  let plugins: ResolvedPlugins = EMPTY_PLUGINS;

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
    const resolution = resolvePlugins(a.plugins);
    if (resolution.ok) plugins = resolution.resolved;
    else errors.push(...resolution.errors);
  }

  if ("anthropic_api_key" in input && typeof input.anthropic_api_key !== "string") {
    errors.push({ field: "anthropic_api_key", reason: "must be a string" });
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    agent: {
      keys: (input.agent as Record<string, unknown>) ?? {},
      plugins,
      anthropic_api_key: blankToNil(input.anthropic_api_key) ?? blankToNil(env.ANTHROPIC_API_KEY),
    },
  };
}
