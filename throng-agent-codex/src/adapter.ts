import { createA2AServer, type AgentConfig, type ServerHandle as CodexServerHandle } from "a2a-codex";
import type { AgentResult, EngineAdapter, Env, Manifest, ServerHandle } from "@throng/agent-core";
import { applyAuth, log } from "@throng/agent-core";
import { buildAgentConfig } from "./config/build.js";
import { CODEX_AUTH_SCHEMES } from "./config/credentials.js";
import { validateCodexAgent, type ResolvedCodexAgent } from "./manifest/codex-agent.js";

export class CodexEngineAdapter
  implements EngineAdapter<ResolvedCodexAgent, Required<AgentConfig>>
{
  validateAgent(input: Record<string, unknown>, env: Env): AgentResult<ResolvedCodexAgent> {
    return validateCodexAgent(input, env);
  }

  injectCredentials(manifest: Manifest<ResolvedCodexAgent>): void {
    applyAuth(manifest.agent.auth, CODEX_AUTH_SCHEMES);
    if (manifest.agent.auth === null) {
      log.warn("no agent.auth in manifest; agent requests will fail unless another auth path is configured");
    }
  }

  buildAgentConfig(manifest: Manifest<ResolvedCodexAgent>, primaryDest: string): Required<AgentConfig> {
    return buildAgentConfig(manifest, primaryDest);
  }

  async createA2AServer(config: Required<AgentConfig>): Promise<ServerHandle> {
    // Core's generic boot log can't know about the codex sandbox/approval knobs;
    // surface them here so operators keep the visibility they'd expect.
    log.info("starting Codex A2A server", {
      sandboxMode: config.codex?.sandboxMode,
      approvalPolicy: config.codex?.approvalPolicy,
    });
    const handle: CodexServerHandle = await createA2AServer(config);
    return handle;
  }
}
