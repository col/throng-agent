import type { Env } from "../env.js";
import type { Manifest } from "../manifest/types.js";
import type { FieldError } from "../manifest/types.js";

/** Minimal handle every engine's A2A server returns. */
export interface ServerHandle {
  shutdown(): Promise<void>;
}

export type AgentResult<TAgent> =
  | { ok: true; agent: TAgent }
  | { ok: false; errors: FieldError[] };

/**
 * The single contract between @throng/agent-core and an engine variant.
 * Core drives the whole init pipeline and calls the adapter only for the
 * engine-specific slices: validating the `agent` block + engine credentials,
 * injecting those credentials, building the engine's server config, and
 * starting the engine's A2A server.
 *
 * TAgent  — the resolved, engine-shaped payload stored on `manifest.agent`.
 * TConfig — the engine server config produced from the manifest.
 */
export interface EngineAdapter<TAgent = unknown, TConfig = unknown> {
  /** Validate + resolve the engine-specific parts of the raw manifest.
   *  Receives the full raw input so it can read `agent` and any engine
   *  credential fields (e.g. anthropic_api_key). Returns typed field errors
   *  that core folds into the 400 response. */
  validateAgent(input: Record<string, unknown>, env: Env): AgentResult<TAgent>;

  /** Inject the engine credential(s) into the process and run engine preflight. */
  injectCredentials(manifest: Manifest<TAgent>): void;

  /** Build the engine server config from the resolved manifest. */
  buildAgentConfig(manifest: Manifest<TAgent>, primaryDest: string): TConfig;

  /** Start the engine's A2A server. */
  createA2AServer(config: TConfig): Promise<ServerHandle>;

  /** Optional: refine the failed boot step (e.g. "plugins") from an error.
   *  Returns undefined to accept core's default ("agent"). */
  classifyBootError?(err: unknown, manifest: Manifest<TAgent>): string | undefined;
}
