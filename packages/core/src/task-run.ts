import { join } from "node:path";
import type { GitResult } from "./bootstrap/git.js";
import { describeSetupFailure, redactTokens, type SetupResult } from "./bootstrap/setup.js";
import type { AdapterRegistry, EngineAdapter, ServerHandle } from "./engine/adapter.js";
import { Lifecycle } from "./lifecycle.js";
import { log } from "./log.js";
import type { FieldError, Manifest, UserIdentity, WorkspaceManifest } from "./manifest/types.js";
import { validate, validatePrepare } from "./manifest/validate.js";

/** Engine-agnostic boot dependencies. */
export interface BootDeps {
  /** Clone-or-resync, because a sandbox restored from a project snapshot already
   *  has every `dest` on disk and `git clone` fails outright when it does. */
  syncOrClone: (url: string, dest: string, ref: string) => Promise<GitResult>;
  runSetupCommands: (cwd: string, commands: string[]) => Promise<SetupResult>;
  writeCredentialConfig: (manifest: WorkspaceManifest) => void;
  /** Removes the credential config and every token minted from it, before a
   *  prepared workspace is snapshotted. */
  deleteCredentialConfig: () => void;
  injectGitIdentity: (identity: UserIdentity) => void;
  workspaceRoot: string;
}

/** What a control-server route does with an accepted, rejected or duplicate POST. */
export type BootAcceptance =
  | { ok: true; status: "booting" }
  | { ok: false; already: true }
  | { ok: false; errors: FieldError[] };

export type InitialiseResult = BootAcceptance;
export type PrepareResult = BootAcceptance;

/**
 * Which entry point a shared step is running under. Used only for diagnostics —
 * the log prefix, and the fallback `step` when an error names none — so that a
 * prepare failure is never reported as a boot step that never ran.
 */
type Phase = "boot" | "prepare";

export class TaskRun {
  readonly lifecycle = new Lifecycle();
  private serverHandle?: ServerHandle;

  constructor(
    private readonly deps: BootDeps,
    private readonly registry: AdapterRegistry,
  ) {}

  async initialise(payload: unknown): Promise<InitialiseResult> {
    // `prepared` is a rest state, not an initialised one: a sandbox restored from
    // a project snapshot resumes with the lifecycle the snapshot captured, and
    // that snapshot was deliberately taken before any agent existed. Everything
    // else that has left `uninitialised` is a second call against a live task.
    if (this.lifecycle.state !== "uninitialised" && this.lifecycle.state !== "prepared") {
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

    // Nothing may `await` between the guard above and this line — see the longer
    // note in prepare(), which this shares: the synchronous run from the state
    // check to the transition is the whole of what makes the check atomic against
    // concurrent POSTs, and an `await` introduced in between would let two
    // callers past it and would break silently.
    this.lifecycle.set("booting");
    log.info("initialise accepted; booting asynchronously", {
      platform: result.manifest.platform,
      repos: result.manifest.repos.length,
      setupCommands: result.manifest.setup_commands.length,
    });
    void this.boot(result.manifest, result.adapter);
    return { ok: true, status: "booting" };
  }

  /**
   * Warm the workspace without initialising an agent: sync every repo, run the
   * project's setup commands, then delete the credential config and settle at
   * `prepared`, where the control plane snapshots the sandbox.
   *
   * Runs the same three steps `boot()` runs, through the same private methods, so
   * a snapshot build and the task boot that restores from it cannot drift.
   */
  async prepare(payload: unknown): Promise<PrepareResult> {
    if (this.lifecycle.state !== "uninitialised") {
      log.warn("prepare rejected: lifecycle has already left uninitialised", { state: this.lifecycle.state });
      return { ok: false, already: true };
    }

    const result = validatePrepare(payload);
    if (!result.ok) {
      log.warn("prepare rejected: manifest validation failed", {
        errors: result.errors.map((e) => e.field),
      });
      return { ok: false, errors: result.errors };
    }

    // Nothing may `await` between the guard above and this line. The run from
    // the state check to the transition is synchronous, and that is the whole of
    // what makes the check atomic against concurrent POSTs — express serves
    // requests on one thread, so a second prepare cannot observe `uninitialised`
    // once this has run. An `await` in between (validation becoming async, say)
    // would open a window in which two prepares both pass the guard, and it
    // would break silently.
    this.lifecycle.set("booting");
    log.info("prepare accepted; warming the workspace asynchronously", {
      repos: result.manifest.repos.length,
      setupCommands: result.manifest.setup_commands.length,
    });
    void this.prepareWorkspace(result.manifest);
    return { ok: true, status: "booting" };
  }

  private async prepareWorkspace(manifest: WorkspaceManifest): Promise<void> {
    try {
      // Same three methods boot() calls, with only the log prefix differing —
      // "boot step: cloning repos" from a run that never boots an agent sends an
      // operator looking for the wrong thing. A defaulted parameter rather than a
      // second copy of these methods: the shared call path is what keeps a
      // snapshot build and the task boot that restores from it from drifting.
      this.writeCredentials(manifest, "prepare");
      const primaryDest = await this.syncRepos(manifest, "prepare");
      await this.runSetup(manifest, primaryDest, "prepare");

      // A security boundary, not tidiness — and specifically the DISK half of
      // one. Everything still on disk here is captured into an E2B-stored image
      // that every task in the project boots from, so a token left in
      // $HOME/.throng would be shared with all of them. A wipe that throws fails
      // the prepare rather than reporting `prepared`, because a snapshot with a
      // live credential on its filesystem is worse than no snapshot.
      //
      // It does not close the memory half, and should not be read as if it did.
      // E2B captures memory and RESUMES the process, so at the instant `prepared`
      // is set the identity token is a live binding on this async frame and the
      // decoded request body is heap garbage V8 never zeroes — every restored
      // task sandbox therefore runs a process whose heap still holds the prepare
      // instance's token, readable through /proc/<pid>/mem. That is inherent to
      // snapshotting a live process and is not fixable here: JS strings are
      // immutable, and the lifecycle state the snapshot exists to preserve lives
      // in that same heap. What bounds it is the control plane (design spec
      // §5.3) destroying the snapshot instance immediately after capture, which
      // invalidates its identity token via VerifyInstanceToken — so the residue
      // is a credential that no longer authenticates. That argument covers the
      // pull-model `credentials.token` only: a literal `github_token`, used in
      // dev and standalone mode, has no equivalent revocation and a snapshot
      // built with one keeps a working credential in memory.
      //
      // A distinct step from the config WRITE below, deliberately: `step` plus
      // `error_message` is usually the only diagnostic left once the sandbox is
      // gone, and "could not write the config" is a harmless dead sandbox while
      // "could not wipe the config" means a sandbox may still be sitting there
      // with a live token on disk. Those want different responses.
      log.info("prepare step: deleting the credential config and token cache");
      try {
        this.deps.deleteCredentialConfig();
      } catch (err) {
        throw new StepError("credential-wipe", err instanceof Error ? err.message : String(err));
      }

      // Last, after the log line: the control plane acts on the state, snapshotting
      // as soon as it sees `prepared`, so nothing may run after the transition that
      // could throw and regress it to `failed` once a snapshot may already exist.
      log.info("prepare complete; workspace is ready to snapshot");
      this.lifecycle.set("prepared");
    } catch (err) {
      // Best effort on the failure path too: the control plane kills a failed
      // snapshot instance, but a token must not outlive the run that fetched it
      // merely because a setup command exited non-zero. The original failure is
      // what gets reported, so a second wipe error is swallowed deliberately.
      try {
        this.deps.deleteCredentialConfig();
      } catch (wipeErr) {
        log.error("credential wipe failed after a failed prepare", {
          message: wipeErr instanceof Error ? wipeErr.message : String(wipeErr),
        });
      }
      this.reportFailure(err, "prepare");
    }
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
  private writeCredentials(manifest: WorkspaceManifest, phase: Phase = "boot"): void {
    log.info(`${phase} step: writing credential config`, {
      mode: manifest.github_token ? "static" : manifest.credentials ? "api" : "none",
    });
    try {
      this.deps.writeCredentialConfig(manifest);
    } catch (err) {
      throw new StepError("credentials", err instanceof Error ? err.message : String(err));
    }
  }

  /** Returns the primary repo's destination — where setup commands run. */
  private async syncRepos(manifest: WorkspaceManifest, phase: Phase = "boot"): Promise<string> {
    this.lifecycle.set("cloning");
    log.info(`${phase} step: cloning repos`, { count: manifest.repos.length, workspace: this.deps.workspaceRoot });
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

  private async runSetup(manifest: WorkspaceManifest, primaryDest: string, phase: Phase = "boot"): Promise<void> {
    this.lifecycle.set("setup");
    // Setup commands run WITH working git and gh, because the credential config
    // is already in place. See describeSetupFailure: their output is redacted
    // before it leaves this process.
    log.info(`${phase} step: running setup commands`, { count: manifest.setup_commands.length, cwd: primaryDest });
    const setup = await this.deps.runSetupCommands(primaryDest, manifest.setup_commands);
    if (!setup.ok) {
      // `describeSetupFailure` carries the failing command, a decoded signal exit
      // (137 = OOM-killed, the common one) and the tail of its output — without
      // it the orchestrator only ever saw "(exit 137)" with no clue why.
      throw new StepError("setup", describeSetupFailure(setup));
    }
  }

  /**
   * `phase` names which entry point failed, for the case where nothing named a
   * step: a prepare run has no boot steps, so reporting `step: "boot"` for an
   * unexpected error would send an operator looking for something that never
   * ran. Steps raised by the shared private methods are already accurate for
   * both phases and pass through untouched.
   */
  private reportFailure(err: unknown, phase: Phase = "boot"): void {
    const detail =
      err instanceof StepError
        ? { step: err.step, message: err.message }
        : { step: phase, message: err instanceof Error ? err.message : String(err) };
    this.lifecycle.fail(detail);
    log.error(`${phase} failed`, { step: detail.step, message: detail.message });
    if (!(err instanceof StepError) && err instanceof Error && err.stack) {
      log.error(`${phase} failure stack`, { stack: err.stack });
    }
  }

  async shutdown(): Promise<void> {
    await this.serverHandle?.shutdown();
  }
}

/**
 * Where the agent runs, and where `setup_commands` run: the primary repo's
 * destination, or the workspace root when the manifest carries no repos.
 *
 * Separate from `syncRepos` — which only clones — because these are two
 * questions, and only one of them has an answer that depends on the network
 * having succeeded. Keeping the resolution pure also means the no-primary case
 * below is a function contract rather than a loop invariant over a mutable
 * accumulator, and it is testable without mocking git.
 */
export function resolveWorkingDirectory(manifest: WorkspaceManifest, workspaceRoot: string): string {
  // An empty workspace is legal input: the agent's job may be to create the
  // project. The workspace root is where cloned repos live, so a repository the
  // agent creates there is in the layout a later task's manifest will expect.
  if (manifest.repos.length === 0) return workspaceRoot;

  const primary = manifest.repos.find((r) => r.primary);
  // Guards the seam rather than a reachable input: validation accepts exactly
  // one primary for a non-empty list on both routes, so this cannot fire through
  // the public API. It is here because the silent failure it prevents is bad —
  // an empty working directory makes runSetupCommands run in the process's own
  // working directory instead of the repo, and report success.
  if (!primary) {
    throw new StepError("cloning", "no repo was marked primary, so setup commands have nowhere to run");
  }
  return join(workspaceRoot, primary.dest);
}

class StepError extends Error {
  constructor(readonly step: string, message: string) {
    super(message);
  }
}
