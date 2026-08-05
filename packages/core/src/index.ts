export { startControlServer, buildServer, createControlApp, defaultBootDeps } from "./control/server.js";
export { TaskRun, type BootDeps, type InitialiseResult } from "./task-run.js";
export { Lifecycle, type LifecycleState, type StatusView, type FailureDetail } from "./lifecycle.js";
export { validate } from "./manifest/validate.js";
export { resolveApiKey } from "./manifest/api-key.js";
export {
  resolveAuth,
  applyAuth,
  type AuthScheme,
  type ResolvedAuth,
  type AuthResolution,
} from "./manifest/auth.js";
export type {
  RepoSpec,
  FieldError,
  BaseManifest,
  Manifest,
  ValidateResult,
  UserIdentity,
  CredentialsConfig,
} from "./manifest/types.js";
export type { EngineAdapter, ServerHandle, AgentResult, AdapterRegistry } from "./engine/adapter.js";
export { homeDir, type Env } from "./env.js";
export { clone, checkout, type GitResult } from "./bootstrap/git.js";
export { runSetupCommands, describeSetupFailure, redactTokens, type SetupResult } from "./bootstrap/setup.js";
export { injectGitIdentity } from "./bootstrap/git-identity.js";
export { writeCredentialConfig, CONFIG_PATH } from "./creds/config.js";
export { checkInitToken } from "./control/init-token.js";
export { log } from "./log.js";
