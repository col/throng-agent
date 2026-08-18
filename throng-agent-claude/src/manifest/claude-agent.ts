import { resolveAuth, type AgentResult, type Env, type FieldError, type ResolvedAuth } from "@throng/agent-core";
import { CLAUDE_AUTH_SCHEMES } from "../config/credentials.js";
import { EMPTY_PLUGINS, resolvePlugins, type ResolvedPlugins } from "../config/plugins.js";

const PERMISSION_MODES = new Set(["acceptEdits", "dontAsk", "plan", "bypassPermissions"]);
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);
const THINKING_TYPES = new Set(["adaptive", "disabled", "enabled"]);
const OUTPUT_FORMAT_TYPES = new Set(["json_schema"]);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The resolved, Claude-shaped agent payload stored on `manifest.agent`. */
export interface ResolvedClaudeAgent {
  /**
   * Raw agent keys (model, tools, system prompts, max_turns, permission_mode),
   * minus `auth` — the plaintext credential already lives resolved on `auth`
   * below, so leaving a second, raw copy here would just be a long-lived
   * plaintext secret sitting in a bag nothing needs it to be in.
   */
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
    // Duplicates a2a-claude's own shape check on purpose. The wrapper validates
    // in initialize(), so a bad value there fails the boot after initialise has
    // already returned 200; validating here turns it into a field-level 400 at
    // the API boundary, matching every other agent key. The `schema` body is
    // deliberately not inspected — Throng does not own JSON Schema validity, and
    // the SDK reports an unusable schema at turn time.
    if ("output_format" in a) {
      const o = a.output_format;
      if (!isObject(o) || !OUTPUT_FORMAT_TYPES.has(o.type as string)) {
        errors.push({
          field: "agent.output_format",
          reason: "must be an object with type json_schema",
        });
      } else if (!isObject(o.schema)) {
        errors.push({
          field: "agent.output_format.schema",
          reason: "must be a JSON Schema object",
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
  // Non-mutating: `a` is `input.agent`, which belongs to the caller.
  const { auth: _auth, ...keys } = a;
  return { ok: true, agent: { keys, plugins, auth } };
}
