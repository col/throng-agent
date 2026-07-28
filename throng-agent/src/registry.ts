import type { AdapterRegistry } from "@throng/agent-core";
import { ClaudeEngineAdapter } from "throng-agent-claude";
import { CodexEngineAdapter } from "throng-agent-codex";

/** All engines bundled into the throng-agent image, keyed by `agent.platform`. */
export function createRegistry(): AdapterRegistry {
  return {
    claude: new ClaudeEngineAdapter(),
    codex: new CodexEngineAdapter(),
  };
}
