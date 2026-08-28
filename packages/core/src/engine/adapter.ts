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
   *  Receives the full raw input so it can read `agent`, including its
   *  `auth` block, which each engine resolves against its own scheme table.
   *  Returns typed field errors that core folds into the 400 response. */
  validateAgent(input: Record<string, unknown>, env: Env): AgentResult<TAgent>;

  /** Inject the engine credential(s) into the process and run engine preflight. */
  injectCredentials(manifest: Manifest<TAgent>): void;

  /** Build the engine server config from the resolved manifest.
   *
   *  `workingDirectory` is the primary repo's destination, or the workspace root
   *  when the manifest carries no repos — so it is not necessarily a repository.
   *  See resolveWorkingDirectory.
   *
   *  `additionalDirectories` grants the engine access to directories outside
   *  `workingDirectory` — today, the sibling `attachments/` dir task-run.ts
   *  populates at boot when the manifest carries attachments. Optional, and
   *  defaulted by core to `[]`, so an adapter that has no notion of additional
   *  directories yet (see the codex adapter) stays a valid implementation of
   *  this interface unchanged. */
  buildAgentConfig(manifest: Manifest<TAgent>, workingDirectory: string, additionalDirectories?: string[]): TConfig;

  /** Start the engine's A2A server. */
  createA2AServer(config: TConfig): Promise<ServerHandle>;

  /** Optional: refine the failed boot step (e.g. "plugins") from an error.
   *  Returns undefined to accept core's default ("agent"). */
  classifyBootError?(err: unknown, manifest: Manifest<TAgent>): string | undefined;
}

/**
 * A registry of engine adapters keyed by platform name (the `agent.platform`
 * value). Values use `any` type args because the map is heterogeneous — each
 * adapter is strongly typed internally, but they don't share a payload type.
 */
export type AdapterRegistry = Record<string, EngineAdapter<any, any>>;
