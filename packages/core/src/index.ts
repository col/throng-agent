export { startControlServer, buildServer, createControlApp, defaultBootDeps } from "./control/server.js";
export { TaskRun, type BootDeps, type InitialiseResult } from "./task-run.js";
export { Lifecycle, type LifecycleState, type StatusView, type FailureDetail } from "./lifecycle.js";
export { validate } from "./manifest/validate.js";
export type {
  RepoSpec,
  FieldError,
  BaseManifest,
  Manifest,
  ValidateResult,
} from "./manifest/types.js";
export type { EngineAdapter, ServerHandle, AgentResult } from "./engine/adapter.js";
export type { Env } from "./env.js";
export { clone, checkout, type GitResult, ASKPASS } from "./bootstrap/git.js";
export { runSetupCommands, type SetupResult } from "./bootstrap/setup.js";
export { injectGitCredentials } from "./bootstrap/git-credentials.js";
export { checkInitToken } from "./control/init-token.js";
export { log } from "./log.js";
