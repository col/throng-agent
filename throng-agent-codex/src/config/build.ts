import { resolveConfig, type AgentConfig, type CodexConfig } from "a2a-codex";
import type { Manifest } from "@throng/agent-core";
import type { ResolvedCodexAgent } from "../manifest/codex-agent.js";

/**
 * Builds a fully-defaulted a2a-codex config: a Throng base (name + full host
 * isolation + a deterministic bind) overlaid with the manifest's `agent` keys
 * and the primary repo as the working directory. `resolveConfig(undefined,
 * overrides)` applies a2a-codex's own DEFAULTS underneath our overrides.
 *
 * The `server` block is pinned explicitly (rather than left to a2a-codex's
 * env-var merge) so a container's HOSTNAME/PORT can never perturb the bind —
 * the A2A server must always listen on 0.0.0.0. A2A_PORT / ADVERTISE_HOST /
 * ADVERTISE_PROTOCOL are the intentional, Throng-controlled overrides —
 * ADVERTISE_PROTOCOL=https lets a TLS-terminating edge proxy (e.g. an E2B
 * sandbox) advertise https URLs in the agent card even though the process
 * itself serves plain http.
 */
export function buildAgentConfig(
  manifest: Manifest<ResolvedCodexAgent>,
  workingDirectory: string,
): Required<AgentConfig> {
  const a = manifest.agent.keys;
  const codex: CodexConfig = { workingDirectory };

  if (typeof a.model === "string") codex.model = a.model;
  if (typeof a.sandbox_mode === "string") {
    codex.sandboxMode = a.sandbox_mode as CodexConfig["sandboxMode"];
  }
  if (typeof a.approval_policy === "string") {
    codex.approvalPolicy = a.approval_policy as CodexConfig["approvalPolicy"];
  }
  if (typeof a.network_access_enabled === "boolean") {
    codex.networkAccessEnabled = a.network_access_enabled;
  }
  if (typeof a.web_search_mode === "string") {
    codex.webSearchMode = a.web_search_mode as CodexConfig["webSearchMode"];
  }
  if (typeof a.developer_instructions === "string") {
    codex.developerInstructions = a.developer_instructions;
  }
  if (Array.isArray(a.additional_directories)) {
    codex.additionalDirectories = a.additional_directories as string[];
  }

  const overrides: Partial<AgentConfig> = {
    agentCard: {
      name: "Throng Agent A2A Codex",
      description: "Throng-controlled, Codex-backed A2A agent.",
    },
    server: {
      hostname: "0.0.0.0",
      port: Number(process.env.A2A_PORT ?? 3030),
      advertiseHost: process.env.ADVERTISE_HOST ?? "localhost",
      advertiseProtocol: (process.env.ADVERTISE_PROTOCOL ?? "https") as "http" | "https",
    },
    codex,
  };

  return resolveConfig(undefined, overrides);
}
