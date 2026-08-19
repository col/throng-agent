import { resolveConfig, type AgentConfig, type ClaudeConfig, type ClaudePermissionMode } from "@col/a2a-claude";
import type { Manifest } from "@throng/agent-core";
import type { ResolvedClaudeAgent } from "../manifest/claude-agent.js";

/**
 * Builds a fully-defaulted a2a-claude config: a Throng base (name + full
 * host isolation + a deterministic bind) overlaid with the manifest's `agent`
 * keys and the primary repo as the working directory. `resolveConfig(undefined,
 * overrides)` applies a2a-claude's own DEFAULTS underneath our overrides.
 *
 * The `server` block is pinned explicitly (rather than left to a2a-claude's
 * env-var merge) so a container's HOSTNAME/PORT can never perturb the bind —
 * the A2A server must always listen on 0.0.0.0. A2A_PORT / ADVERTISE_HOST /
 * ADVERTISE_PROTOCOL are the intentional, Throng-controlled overrides —
 * ADVERTISE_PROTOCOL=https lets a TLS-terminating edge proxy (e.g. an E2B
 * sandbox) advertise https URLs in the agent card even though the process
 * itself serves plain http.
 */
export function buildAgentConfig(
  manifest: Manifest<ResolvedClaudeAgent>,
  workingDirectory: string,
): Required<AgentConfig> {
  const a = manifest.agent.keys;
  const claude: NonNullable<AgentConfig["claude"]> = {
    workingDirectory,
    // "project" is required for the SDK to load CLAUDE.md files from the
    // working directory — that's the whole reason it's here. It also pulls in
    // the repo's committed `.claude/settings.json`, which is intended: a repo
    // that ships agent settings should get them. "user" and "local" stay off,
    // so the host's ~/.claude and any untracked .claude/settings.local.json
    // never leak in.
    settingSources: ["project"],
  };

  // Model and the reasoning controls are three sibling fields on ClaudeConfig:
  // `model` is a plain string, with `thinking` and `effort` alongside it. Each
  // is attached only when the manifest set it, so anything absent falls through
  // to the wrapper's own default.
  if (typeof a.model === "string") claude.model = a.model;
  if (a.thinking && typeof a.thinking === "object") {
    const t = a.thinking as Record<string, unknown>;
    // The `enabled` form renames snake_case budget_tokens -> the SDK's
    // budgetTokens; adaptive/disabled carry only `type`. `display` is left
    // unset on purpose: the wrapper fills in "summarized" whenever thinking
    // sideband events are on, which is what makes them carry any text at all.
    claude.thinking =
      t.type === "enabled"
        ? { type: "enabled", budgetTokens: t.budget_tokens as number }
        : { type: t.type as "adaptive" | "disabled" };
  }
  if (typeof a.effort === "string") {
    claude.effort = a.effort as ClaudeConfig["effort"];
  }
  if (typeof a.permission_mode === "string") {
    claude.permissionMode = a.permission_mode as ClaudePermissionMode;
    // bypassPermissions grants Claude unrestricted tool access; the SDK requires
    // this companion flag or it throws at startup. Safe only because each agent
    // runs in an isolated, Throng-controlled container.
    if (a.permission_mode === "bypassPermissions") claude.dangerouslyAllowBypassPermissions = true;
  }
  // Marketplace plugins go to the settings-backed channel the SDK installs
  // from (see src/config/plugins.ts). Pre-installed plugin directories are not
  // supported — a2a-claude exposes no such field.
  const { marketplaces, enabledPlugins } = manifest.agent.plugins;
  if (Object.keys(marketplaces).length > 0) {
    claude.marketplaces = marketplaces;
    claude.enabledPlugins = enabledPlugins;
  }

  if (typeof a.system_prompt_append === "string") claude.systemPromptAppend = a.system_prompt_append;
  if (typeof a.custom_system_prompt === "string") claude.customSystemPrompt = a.custom_system_prompt;
  if (Array.isArray(a.allowed_tools)) claude.allowedTools = a.allowed_tools as string[];
  if (Array.isArray(a.disallowed_tools)) claude.disallowedTools = a.disallowed_tools as string[];
  if (typeof a.max_turns === "number") claude.maxTurns = a.max_turns;

  // Structured output. Only the outer key is renamed — the schema body is JSON
  // Schema's own vocabulary and is forwarded verbatim. Left unset when absent so
  // the wrapper's freeform-text default holds.
  if (a.output_format && typeof a.output_format === "object") {
    claude.outputFormat = a.output_format as NonNullable<ClaudeConfig["outputFormat"]>;
  }

  const overrides: Partial<AgentConfig> = {
    agentCard: {
      name: "Throng Agent A2A Claude",
      description: "Throng-controlled, Claude-Code-backed A2A agent.",
    },
    server: {
      hostname: "0.0.0.0",
      port: Number(process.env.A2A_PORT ?? 3030),
      advertiseHost: process.env.ADVERTISE_HOST ?? "localhost",
      advertiseProtocol: (process.env.ADVERTISE_PROTOCOL ?? "https") as "http" | "https",
    },
    claude,
    // A Throng turn has no useful upper bound — a long build, a slow test suite
    // or a deep refactor can legitimately run for hours, and cutting one off
    // mid-flight loses the work. 0 disables the wrapper's prompt timeout
    // entirely (a2a-claude >= 0.2.1-beta.3 treats any value <= 0 that way).
    // Cancellation still works: the runtime aborts the turn on demand.
    //
    // Since a2a-claude 0.2.1-beta.7 the wrapper holds a Task open in `working`
    // while Claude reports background work in flight, so a Task can span
    // several SDK rounds. With the timeout off, cancellation is that Task's
    // only automatic release — if the background set never empties the Task
    // stays `working` and blocks later turns on the same contextId. Accepted:
    // the alternative is killing hours-long legitimate work.
    timeouts: { prompt: 0 },
  };

  return resolveConfig(undefined, overrides);
}
