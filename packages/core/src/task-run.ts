import { join } from "node:path";
import type { GitResult } from "./bootstrap/git.js";
import { describeSetupFailure, redactTokens, type SetupResult } from "./bootstrap/setup.js";
import type { AdapterRegistry, EngineAdapter, ServerHandle } from "./engine/adapter.js";
import { Lifecycle } from "./lifecycle.js";
import { log } from "./log.js";
import type { BaseManifest, FieldError, Manifest, UserIdentity } from "./manifest/types.js";
import { validate } from "./manifest/validate.js";

/** Engine-agnostic boot dependencies. */
export interface BootDeps {
  clone: (url: string, dest: string) => Promise<GitResult>;
  checkout: (dest: string, ref: string) => Promise<GitResult>;
  runSetupCommands: (cwd: string, commands: string[]) => Promise<SetupResult>;
  writeCredentialConfig: (manifest: BaseManifest) => void;
  injectGitIdentity: (identity: UserIdentity) => void;
  workspaceRoot: string;
}

export type InitialiseResult =
  | { ok: true; status: "booting" }
  | { ok: false; already: true }
  | { ok: false; errors: FieldError[] };

export class TaskRun {
  readonly lifecycle = new Lifecycle();
  private serverHandle?: ServerHandle;

  constructor(
    private readonly deps: BootDeps,
    private readonly registry: AdapterRegistry,
  ) {}

  async initialise(payload: unknown): Promise<InitialiseResult> {
    if (this.lifecycle.state !== "uninitialised") {
      log.warn("initialise rejected: already initialised", { state: this.lifecycle.state });
      return { ok: false, already: true };
    }

    const result = validate(payload, this.registry);
    if (!result.ok) {
      log.warn("initialise rejected: manifest validation failed", {
        errors: result.errors.map((e) => e.field),
      });
      return { ok: false, errors: result.errors };
    }

    this.lifecycle.set("booting");
    log.info("initialise accepted; booting asynchronously", {
      platform: result.manifest.platform,
      repos: result.manifest.repos.length,
      setupCommands: result.manifest.setup_commands.length,
    });
    void this.boot(result.manifest, result.adapter);
    return { ok: true, status: "booting" };
  }

  private async boot(manifest: Manifest, adapter: EngineAdapter<any, any>): Promise<void> {
    try {
      // First, and before anything touches the network: cloning authenticates
      // through throng-creds, which reads this file on every cache miss. There
      // is no per-invocation credential environment any more.
      log.info("boot step: writing credential config", {
        mode: manifest.github_token ? "static" : manifest.credentials ? "api" : "none",
      });
      try {
        this.deps.writeCredentialConfig(manifest);
      } catch (err) {
        throw new StepError("credentials", err instanceof Error ? err.message : String(err));
      }

      this.lifecycle.set("cloning");
      log.info("boot step: cloning repos", { count: manifest.repos.length, workspace: this.deps.workspaceRoot });
      let primaryDest = "";
      for (const repo of manifest.repos) {
        const dest = join(this.deps.workspaceRoot, repo.dest);
        // `repos[].url` is whatever the caller sent, and the credential-in-URL
        // form (https://x-access-token:ghs_…@github.com/…) is still legal input
        // even though nothing in this runtime produces it any more. stdout leaves
        // the box, so it gets the same redaction as the failure messages below.
        log.info("cloning repo", { url: redactTokens(repo.url), ref: repo.ref, dest, primary: repo.primary });
        // Clone and checkout run WITH credentials in place, and this message
        // becomes the control plane's `instance.error_message` — the same sink
        // describeSetupFailure redacts. git does not normally echo a
        // helper-supplied password, but the sink is kept uniformly clean rather
        // than relying on reasoning about what git might print.
        const cloned = await this.deps.clone(repo.url, dest);
        if (!cloned.ok) {
          throw new StepError("cloning", `git clone failed for ${repo.dest} (exit ${cloned.code}): ${redactTokens(cloned.output).trim()}`);
        }
        const checked = await this.deps.checkout(dest, repo.ref);
        if (!checked.ok) {
          throw new StepError("cloning", `git checkout ${repo.ref} failed for ${repo.dest}: ${redactTokens(checked.output).trim()}`);
        }
        log.info("repo ready", { dest, ref: repo.ref });
        if (repo.primary) primaryDest = dest;
      }

      this.lifecycle.set("setup");
      // Setup commands now run WITH working git and gh, because the config
      // above is already in place. See describeSetupFailure: their output is
      // redacted before it leaves this process.
      log.info("boot step: running setup commands", { count: manifest.setup_commands.length, cwd: primaryDest });
      const setup = await this.deps.runSetupCommands(primaryDest, manifest.setup_commands);
      if (!setup.ok) {
        // `describeSetupFailure` carries the failing command, a decoded signal exit
        // (137 = OOM-killed, the common one) and the tail of its output — without
        // it the orchestrator only ever saw "(exit 137)" with no clue why.
        throw new StepError("setup", describeSetupFailure(setup));
      }

      log.info("boot step: injecting engine credentials and commit identity");
      adapter.injectCredentials(manifest);
      // Commit identity only. GitHub auth is no longer environment-based.
      this.deps.injectGitIdentity(manifest.user_identity);

      const config = adapter.buildAgentConfig(manifest, primaryDest);
      log.info("boot step: starting A2A server", { workingDirectory: primaryDest });
      try {
        this.serverHandle = await adapter.createA2AServer(config);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const step = adapter.classifyBootError?.(err, manifest) ?? "agent";
        throw new StepError(step, message);
      }
      this.lifecycle.set("ready");
      log.info("boot complete; agent is ready");
    } catch (err) {
      const detail =
        err instanceof StepError
          ? { step: err.step, message: err.message }
          : { step: "boot", message: err instanceof Error ? err.message : String(err) };
      this.lifecycle.fail(detail);
      log.error("boot failed", { step: detail.step, message: detail.message });
      if (!(err instanceof StepError) && err instanceof Error && err.stack) {
        log.error("boot failure stack", { stack: err.stack });
      }
    }
  }

  async shutdown(): Promise<void> {
    await this.serverHandle?.shutdown();
  }
}

class StepError extends Error {
  constructor(readonly step: string, message: string) {
    super(message);
  }
}
