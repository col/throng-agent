import { createA2AServer, type AgentConfig, type ServerHandle as ClaudeServerHandle } from "@col/a2a-claude";
import type { AgentResult, EngineAdapter, Env, Manifest, ServerHandle } from "@throng/agent-core";
import { log } from "@throng/agent-core";
import { buildAgentConfig } from "./config/build.js";
import { assertNoAnthropicKeyInSettings, injectAnthropicKey } from "./config/credentials.js";
import { validateClaudeAgent, type ResolvedClaudeAgent } from "./manifest/claude-agent.js";

// Message shapes owned by a2a-claude's plugin preflight; a miss only coarsens
// the reported step, never a wrong success.
const PLUGIN_FAILURE = /did not load|plugin preflight/i;

export class ClaudeEngineAdapter
  implements EngineAdapter<ResolvedClaudeAgent, Required<AgentConfig>>
{
  validateAgent(input: Record<string, unknown>, env: Env): AgentResult<ResolvedClaudeAgent> {
    return validateClaudeAgent(input, env);
  }

  injectCredentials(manifest: Manifest<ResolvedClaudeAgent>): void {
    assertNoAnthropicKeyInSettings();
    injectAnthropicKey(manifest.agent.api_key);
    if (manifest.agent.api_key === null) {
      log.warn("no api_key in manifest; agent requests will fail unless another auth path is configured");
    }
    const { marketplaces, local, unpinned, enabledPlugins } = manifest.agent.plugins;
    const marketplaceCount = Object.keys(marketplaces).length;
    if (marketplaceCount > 0 || local.length > 0) {
      log.info("plugins configured", {
        marketplaces: marketplaceCount,
        marketplacePlugins: Object.keys(enabledPlugins).length,
        localPlugins: local.length,
      });
    }
    if (unpinned.length > 0) {
      log.warn("marketplace plugins are unpinned; pin each marketplace with a branch or tag ref for reproducible runs", {
        plugins: unpinned,
      });
    }
  }

  buildAgentConfig(manifest: Manifest<ResolvedClaudeAgent>, primaryDest: string): Required<AgentConfig> {
    return buildAgentConfig(manifest, primaryDest);
  }

  async createA2AServer(config: Required<AgentConfig>): Promise<ServerHandle> {
    // Core's generic boot log can't know about permission mode; surface it here
    // so operators keep the visibility the pre-monorepo boot log gave them.
    log.info("starting Claude A2A server", { permissionMode: config.claude?.permissionMode });
    const handle: ClaudeServerHandle = await createA2AServer(config);
    return handle;
  }

  classifyBootError(err: unknown, manifest: Manifest<ResolvedClaudeAgent>): string | undefined {
    const message = err instanceof Error ? err.message : String(err);
    const hasMarketplaces = Object.keys(manifest.agent.plugins.marketplaces).length > 0;
    return hasMarketplaces && PLUGIN_FAILURE.test(message) ? "plugins" : undefined;
  }
}
