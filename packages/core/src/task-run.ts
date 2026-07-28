import { join } from "node:path";
import type { GitResult } from "./bootstrap/git.js";
import type { SetupResult } from "./bootstrap/setup.js";
import type { EngineAdapter, ServerHandle } from "./engine/adapter.js";
import { Lifecycle } from "./lifecycle.js";
import { log } from "./log.js";
import type { FieldError, Manifest } from "./manifest/types.js";
import { validate } from "./manifest/validate.js";

/** Engine-agnostic boot dependencies. */
export interface BootDeps {
  clone: (url: string, dest: string, token: string | null) => Promise<GitResult>;
  checkout: (dest: string, ref: string) => Promise<GitResult>;
  runSetupCommands: (cwd: string, commands: string[]) => Promise<SetupResult>;
  injectGitCredentials: (token: string | null) => void;
  workspaceRoot: string;
}

export type InitialiseResult =
  | { ok: true; status: "booting" }
  | { ok: false; already: true }
  | { ok: false; errors: FieldError[] };

export class TaskRun<TAgent = unknown, TConfig = unknown> {
  readonly lifecycle = new Lifecycle();
  private serverHandle?: ServerHandle;

  constructor(
    private readonly deps: BootDeps,
    private readonly adapter: EngineAdapter<TAgent, TConfig>,
  ) {}

  async initialise(payload: unknown): Promise<InitialiseResult> {
    if (this.lifecycle.state !== "uninitialised") {
      log.warn("initialise rejected: already initialised", { state: this.lifecycle.state });
      return { ok: false, already: true };
    }

    const result = validate<TAgent>(payload, this.adapter);
    if (!result.ok) {
      log.warn("initialise rejected: manifest validation failed", {
        errors: result.errors.map((e) => e.field),
      });
      return { ok: false, errors: result.errors };
    }

    this.lifecycle.set("booting");
    log.info("initialise accepted; booting asynchronously", {
      repos: result.manifest.repos.length,
      setupCommands: result.manifest.setup_commands.length,
    });
    void this.boot(result.manifest);
    return { ok: true, status: "booting" };
  }

  private async boot(manifest: Manifest<TAgent>): Promise<void> {
    try {
      this.lifecycle.set("cloning");
      log.info("boot step: cloning repos", { count: manifest.repos.length, workspace: this.deps.workspaceRoot });
      let primaryDest = "";
      for (const repo of manifest.repos) {
        const dest = join(this.deps.workspaceRoot, repo.dest);
        log.info("cloning repo", { url: repo.url, ref: repo.ref, dest, primary: repo.primary, authenticated: repo.token !== null });
        const cloned = await this.deps.clone(repo.url, dest, repo.token);
        if (!cloned.ok) {
          throw new StepError("cloning", `git clone failed for ${repo.dest} (exit ${cloned.code}): ${cloned.output.trim()}`);
        }
        const checked = await this.deps.checkout(dest, repo.ref);
        if (!checked.ok) {
          throw new StepError("cloning", `git checkout ${repo.ref} failed for ${repo.dest}: ${checked.output.trim()}`);
        }
        log.info("repo ready", { dest, ref: repo.ref });
        if (repo.primary) primaryDest = dest;
      }

      this.lifecycle.set("setup");
      log.info("boot step: running setup commands", { count: manifest.setup_commands.length, cwd: primaryDest });
      const setup = await this.deps.runSetupCommands(primaryDest, manifest.setup_commands);
      if (!setup.ok) {
        throw new StepError("setup", `setup command failed: ${setup.command} (exit ${setup.code})`);
      }

      log.info("boot step: injecting credentials and building agent config");
      this.adapter.injectCredentials(manifest);
      // The GitHub token reaches git subprocesses (incl. any the engine spawns).
      this.deps.injectGitCredentials(manifest.github_token);

      const config = this.adapter.buildAgentConfig(manifest, primaryDest);
      log.info("boot step: starting A2A server", { workingDirectory: primaryDest });
      try {
        this.serverHandle = await this.adapter.createA2AServer(config);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const step = this.adapter.classifyBootError?.(err, manifest) ?? "agent";
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
