import { join } from "node:path";
import type { GitResult } from "./bootstrap/git.js";
import { describeSetupFailure, redactTokens, type SetupResult } from "./bootstrap/setup.js";
import type { AdapterRegistry, EngineAdapter, ServerHandle } from "./engine/adapter.js";
import { Lifecycle } from "./lifecycle.js";
import { log } from "./log.js";
import type { FieldError, Manifest, UserIdentity, WorkspaceManifest } from "./manifest/types.js";
import { validate } from "./manifest/validate.js";

/** Engine-agnostic boot dependencies. */
export interface BootDeps {
  /** Clone-or-resync, because a sandbox restored from a project snapshot already
   *  has every `dest` on disk and `git clone` fails outright when it does. */
  syncOrClone: (url: string, dest: string, ref: string) => Promise<GitResult>;
  runSetupCommands: (cwd: string, commands: string[]) => Promise<SetupResult>;
  writeCredentialConfig: (manifest: WorkspaceManifest) => void;
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
      this.writeCredentials(manifest);
      const primaryDest = await this.syncRepos(manifest);
      await this.runSetup(manifest, primaryDest);

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
      this.reportFailure(err);
    }
  }

  /**
   * First, and before anything touches the network: cloning authenticates through
   * throng-creds, which reads this file on every cache miss. There is no
   * per-invocation credential environment any more.
   */
  private writeCredentials(manifest: WorkspaceManifest): void {
    log.info("boot step: writing credential config", {
      mode: manifest.github_token ? "static" : manifest.credentials ? "api" : "none",
    });
    try {
      this.deps.writeCredentialConfig(manifest);
    } catch (err) {
      throw new StepError("credentials", err instanceof Error ? err.message : String(err));
    }
  }

  /** Returns the primary repo's destination — where setup commands run. */
  private async syncRepos(manifest: WorkspaceManifest): Promise<string> {
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
      // The sync runs WITH credentials in place, and this message becomes the
      // control plane's `instance.error_message` — the same sink
      // describeSetupFailure redacts. git does not normally echo a
      // helper-supplied password, but the sink is kept uniformly clean rather
      // than relying on reasoning about what git might print.
      const synced = await this.deps.syncOrClone(repo.url, dest, repo.ref);
      if (!synced.ok) {
        // The ref is named as well as the operation: this string becomes the
        // control plane's `instance.error_message`, usually the only diagnostic
        // left once the sandbox is gone, and syncOrClone's branches
        // (`checkout -f <ref>`, `reset --hard origin/<ref>`) are keyed on it. A
        // task's ref can legitimately differ from the one its snapshot was built
        // with, so "which ref" is the clue that identifies that failure.
        // `?? "sync"` is a fallback for a caller that does not set `op`; every
        // implementation in this repo does.
        throw new StepError(
          "cloning",
          `git ${synced.op ?? "sync"} failed for ${repo.dest}@${repo.ref} (exit ${synced.code}): ${redactTokens(synced.output).trim()}`,
        );
      }
      log.info("repo ready", { dest, ref: repo.ref });
      if (repo.primary) primaryDest = dest;
    }
    // Guards the seam rather than a reachable input: validation accepts exactly
    // one primary repo on every route today, so this cannot fire through the
    // public API. It is here because the next caller of syncRepos evolves
    // independently, and the silent failure it prevents is bad — an empty
    // primaryDest makes runSetupCommands run in the process's working directory
    // instead of the repo, and report success.
    if (primaryDest === "") {
      throw new StepError("cloning", "no repo was marked primary, so setup commands have nowhere to run");
    }
    return primaryDest;
  }

  private async runSetup(manifest: WorkspaceManifest, primaryDest: string): Promise<void> {
    this.lifecycle.set("setup");
    // Setup commands run WITH working git and gh, because the credential config
    // is already in place. See describeSetupFailure: their output is redacted
    // before it leaves this process.
    log.info("boot step: running setup commands", { count: manifest.setup_commands.length, cwd: primaryDest });
    const setup = await this.deps.runSetupCommands(primaryDest, manifest.setup_commands);
    if (!setup.ok) {
      // `describeSetupFailure` carries the failing command, a decoded signal exit
      // (137 = OOM-killed, the common one) and the tail of its output — without
      // it the orchestrator only ever saw "(exit 137)" with no clue why.
      throw new StepError("setup", describeSetupFailure(setup));
    }
  }

  private reportFailure(err: unknown): void {
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

  async shutdown(): Promise<void> {
    await this.serverHandle?.shutdown();
  }
}

class StepError extends Error {
  constructor(readonly step: string, message: string) {
    super(message);
  }
}
