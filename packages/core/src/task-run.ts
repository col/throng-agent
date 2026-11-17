import { dirname, join } from "node:path";
import type { GitResult } from "./bootstrap/git.js";
import { describeSetupFailure, redactTokens, type SetupOptions, type SetupResult } from "./bootstrap/setup.js";
import type { AdapterRegistry, EngineAdapter, ServerHandle } from "./engine/adapter.js";
import { Lifecycle } from "./lifecycle.js";
import { log } from "./log.js";
import { startMcpProxy, type McpProxyHandle } from "./mcp-proxy/index.js";
import type { AttachmentSpec, FieldError, Manifest, UserIdentity, WorkspaceManifest } from "./manifest/types.js";
import { validate, validatePrepare } from "./manifest/validate.js";

/** Name of the directory attachments are downloaded into, a sibling of the
 *  working directory — so the system-prompt convention `../attachments/<name>`
 *  resolves correctly regardless of the working directory's own name. */
const ATTACHMENTS_DIRNAME = "attachments";

/**
 * Environment variable names a project's `env` and `secrets` may not set. Each
 * is read by something that must see the sandbox's own value, not the
 * project's, and nothing downstream of the manifest would notice an override:
 *
 * - Engine credentials, which the adapter's `injectCredentials` selects and
 *   whose competitors it scrubs: `CLAUDE_AUTH_SCHEMES` and
 *   `CLAUDE_AUTH_ALSO_SCRUB` in `throng-agent-claude/src/config/credentials.ts`,
 *   `CODEX_AUTH_SCHEMES` in `throng-agent-codex/src/config/credentials.ts`. A
 *   project value here would rebill the run to an account nobody chose. Core
 *   cannot import the adapters, so the names are literal; each adapter's test
 *   suite asserts its own names are a subset of this set.
 * - The `throng-creds` handshake: `HOME`, `THRONG_CONFIG`, `THRONG_CREDS_CACHE`
 *   and `WORKSPACE_DIR` (see `creds/config.ts`, `creds/throng-creds.sh`). git
 *   starts the helper from the agent's shells after boot, and it locates the
 *   credential config through these in the environment it inherits.
 * - `PATH`, through which the engine SDK finds its own binary.
 * - `THRONG_INIT_TOKEN`, which `control/server.ts` reads on EVERY request to
 *   the control routes, not once at config build. `checkInitToken` treats a
 *   blank value as "no auth configured", so a project setting it to "" would
 *   switch off control-route authentication for the rest of the sandbox's life.
 *
 * Ordering is the other half of the guarantee, and it covers less than it may
 * appear to. `applyProjectEnv` runs after `buildAgentConfig`, so a variable
 * read while the config is built has already been read: `A2A_PORT`,
 * `ADVERTISE_HOST`, `ADVERTISE_PROTOCOL`, `WORKSPACE_DIR`, and the wrapper's
 * `loadEnvOverrides` keys such as `PORT` and `LOG_LEVEL`. Those may be left
 * out of this set. Anything read lazily, after boot, sees the project's value
 * and must be listed here instead — which is why `THRONG_INIT_TOKEN` is.
 *
 * Mirrored on the control plane by
 * `Throng.Projects.Project.Validations.EnvironmentVariableKeys` in throngx,
 * which rejects these at save time so the user learns there. This set is the
 * guarantee and that one the courtesy: a stale server list cannot break it.
 */
export const RESERVED_ENV_KEYS: ReadonlySet<string> = new Set([
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "HOME",
  "THRONG_CONFIG",
  "THRONG_CREDS_CACHE",
  "WORKSPACE_DIR",
  "PATH",
  "THRONG_INIT_TOKEN",
]);

/**
 * The project variables to apply: `env`, then `secrets` over it, minus
 * `RESERVED_ENV_KEYS`. Validation rejects a key present in both maps, so the
 * merge order only matters if that guard is ever removed — and then the
 * redacted side wins. A skipped key is logged by NAME; the value is never
 * logged, because for `secrets` the value is the credential.
 */
export function projectEnv(manifest: WorkspaceManifest): Record<string, string> {
  const merged = { ...(manifest.env ?? {}), ...(manifest.secrets ?? {}) };
  return Object.fromEntries(
    Object.entries(merged).filter(([key]) => {
      if (!RESERVED_ENV_KEYS.has(key)) return true;
      log.warn("project env key skipped", { key });
      return false;
    }),
  );
}

/** Engine-agnostic boot dependencies. */
export interface BootDeps {
  /** Clone-or-resync, because a sandbox restored from a project snapshot already
   *  has every `dest` on disk and `git clone` fails outright when it does. */
  syncOrClone: (url: string, dest: string, ref: string) => Promise<GitResult>;
  /** `opts.env` is the full environment setup commands see — the only route by
   *  which project variables reach them on the prepare path. */
  runSetupCommands: (cwd: string, commands: string[], opts?: SetupOptions) => Promise<SetupResult>;
  writeCredentialConfig: (manifest: WorkspaceManifest) => void;
  /** Removes the credential config and every token minted from it, before a
   *  prepared workspace is snapshotted. */
  deleteCredentialConfig: () => void;
  injectGitIdentity: (identity: UserIdentity) => void;
  /** Creates `workspaceRoot` if it is absent. Recursive and idempotent.
   *
   *  Needed because nothing else creates it: today the directory exists only as
   *  a side effect of `git clone` creating its destination's parents, so a
   *  manifest with no repos would point the agent at a path that is not there.
   *  Injected rather than called directly so the test suite's fake workspace
   *  root — a path that does not exist and cannot be created on a developer
   *  machine — stays inert. */
  ensureWorkspace: (dir: string) => void;
  workspaceRoot: string;
  /** Downloads task attachments into `dir` (a sibling of the working directory). */
  downloadAttachments: (attachments: AttachmentSpec[], dir: string) => Promise<void>;
  /** Starts the loopback proxy for `mcp_servers` entries carrying a `proxy`
   *  block. Defaults to the real one; injected so tests never bind a port. */
  startMcpProxy?: typeof startMcpProxy;
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
  private mcpProxy?: McpProxyHandle;

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
      envCount: Object.keys(result.manifest.env ?? {}).length,
      secretCount: Object.keys(result.manifest.secrets ?? {}).length,
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
      envCount: Object.keys(result.manifest.env ?? {}).length,
      secretCount: Object.keys(result.manifest.secrets ?? {}).length,
    });
    void this.prepareWorkspace(result.manifest);
    return { ok: true, status: "booting" };
  }

  private async prepareWorkspace(manifest: WorkspaceManifest): Promise<void> {
    try {
      // The same methods boot() calls, with only the log prefix differing —
      // "boot step: cloning repos" from a run that never boots an agent sends an
      // operator looking for the wrong thing. A defaulted parameter rather than a
      // second copy of these methods: the shared call path is what keeps a
      // snapshot build and the task boot that restores from it from drifting.
      //
      // The returned working directory and attachments directory are discarded
      // here on purpose: a prepare builds a filesystem image and never starts an
      // agent, so nothing after this point needs to know where one would have
      // run. A `WorkspaceManifest` also carries no attachments, so nothing
      // downloads on this path regardless.
      this.writeCredentials(manifest, "prepare");
      await this.materialiseWorkspace(manifest, "prepare");

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
      //
      // Project `env` and `secrets` need no equivalent step: on this path they
      // reach setup commands only through runSetup's explicit `env` option and
      // never enter `process.env`, so `process.env` holds no project value and
      // a sandbox restored from the snapshot inherits none. That is the
      // environment only, not the heap: like the token above, the parsed
      // manifest (secret values included) may still be unreclaimed garbage in
      // the captured memory.
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
      const { workingDirectory, attachmentsDir } = await this.materialiseWorkspace(manifest);

      log.info("boot step: injecting engine credentials and commit identity");
      adapter.injectCredentials(manifest);
      // Commit identity only. GitHub auth is no longer environment-based.
      this.deps.injectGitIdentity(manifest.user_identity);

      // Only granted when something was actually downloaded there — an
      // attachments-less task must not hand the agent a directory that
      // doesn't exist.
      const extraDirs = (manifest.attachments ?? []).length > 0 ? [attachmentsDir] : [];
      const engineManifest = await this.startMcpProxy(manifest);
      const config = adapter.buildAgentConfig(engineManifest, workingDirectory, extraDirs);
      this.applyProjectEnv(manifest);
      log.info("boot step: starting A2A server", { workingDirectory });
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
      await this.closeMcpProxy();
      this.reportFailure(err);
    }
  }

  /**
   * Writes the project's variables into this process's environment, so every
   * SDK query the server runs, and every shell the agent opens, inherits them.
   * Boot only: `prepareWorkspace` must never call this (spec §5.3).
   *
   * The position in `boot()` is load-bearing on both sides:
   *
   * - AFTER `buildAgentConfig`, because settings read while the config is
   *   built (`A2A_PORT`, `ADVERTISE_HOST`, `ADVERTISE_PROTOCOL`,
   *   `WORKSPACE_DIR`, the wrapper's `loadEnvOverrides` keys such as `PORT` and
   *   `LOG_LEVEL`) have then already been read. Applied earlier, a project
   *   variable of the same name would reconfigure the agent server. This
   *   protects ONLY settings read during config build: anything read lazily
   *   sees the project's value, so it has to be in `RESERVED_ENV_KEYS`
   *   (`THRONG_INIT_TOKEN` is there for that reason). Also after
   *   `injectCredentials`, so together with the
   *   reserved credential names the adapter's "selected credential wins,
   *   competitors scrubbed" guarantee cannot be disturbed.
   * - BEFORE `createA2AServer`, because what the server spawns inherits the
   *   environment as it stands when it starts.
   *
   * Moving this call in either direction breaks one of those silently; the
   * spy-ordered tests in task-run.test.ts ("project env") pin it.
   */
  private applyProjectEnv(manifest: Manifest): void {
    const vars = projectEnv(manifest);
    log.info("boot step: applying project environment", { count: Object.keys(vars).length });
    Object.assign(process.env, vars);
  }

  /**
   * Proxied `mcp_servers` entries hold no credential, so the engine is pointed
   * at a loopback proxy that fetches one per request. Returns the manifest the
   * engine should see; unchanged when nothing is proxied. The message is static
   * because it reaches `error_message` and the cause could carry a header value.
   */
  private async startMcpProxy(manifest: Manifest): Promise<Manifest> {
    const servers = manifest.mcp_servers ?? {};
    if (!Object.values(servers).some((s) => s.proxy !== undefined)) return manifest;

    log.info("boot step: starting MCP proxy");
    try {
      const start = this.deps.startMcpProxy ?? startMcpProxy;
      this.mcpProxy = await start(servers, manifest.credentials);
    } catch {
      throw new StepError("mcp", "failed to start the MCP proxy");
    }
    return { ...manifest, mcp_servers: this.mcpProxy.engineServers };
  }

  private async closeMcpProxy(): Promise<void> {
    const proxy = this.mcpProxy;
    this.mcpProxy = undefined;
    try {
      await proxy?.close();
    } catch {
      log.error("mcp proxy close failed");
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

  /**
   * Brings the workspace to the state an agent (or a snapshot) can be handed:
   * decide where the agent runs, put the repos on disk, then run the setup
   * commands there. Returns that working directory.
   *
   * One method rather than three calls at each of the two call sites, because
   * the ORDER is a correctness property and this is the only place that has to
   * be trusted to keep it. Setup commands must run after the clone — they are
   * `mise install` and `npm ci` against a tree that has to exist — and until
   * this refactor that was enforced by the type system: `runSetup` took the
   * destination that only a completed `syncRepos` could return, so the two
   * could not be reordered or interleaved without a compile error. Splitting
   * resolution out removed that data dependency, and a comment is a weaker
   * guarantee than a signature. Returning the directory from the method that
   * also performs the steps restores it: a caller cannot obtain a working
   * directory without having awaited the whole sequence.
   *
   * `phase` only labels the logs — a prepare run that never boots an agent must
   * not emit "boot step: cloning repos" at an operator hunting a failure.
   *
   * Also resolves and populates the attachments directory, a sibling of the
   * working directory: `workspaceRoot/<primary-dest>` -> `workspaceRoot/attachments`.
   * A sibling, not a subdirectory of the working directory, because the working
   * directory is a git checkout the agent's own commands operate on, and the
   * system-prompt convention pointing the agent at attachments is the fixed
   * relative path `../attachments/<name>` — that only resolves correctly if the
   * two directories are siblings. Downloading happens here, alongside cloning
   * and setup, for the same reason those live in one method: order is a
   * correctness property (attachments must exist before the agent that reads
   * them starts), and this is the one place trusted to keep it. A prepare run
   * passes no attachments (see `WorkspaceManifest` vs `Manifest`), so the
   * download is unconditionally skipped there.
   */
  private async materialiseWorkspace(
    manifest: WorkspaceManifest,
    phase: Phase = "boot",
  ): Promise<{ workingDirectory: string; attachmentsDir: string }> {
    // Resolved before the clone, so a manifest with no primary repo fails having
    // done nothing rather than after pulling every repo over the network.
    const workingDirectory = resolveWorkingDirectory(manifest, this.deps.workspaceRoot);
    const attachmentsDir = join(dirname(workingDirectory), ATTACHMENTS_DIRNAME);
    await this.syncRepos(manifest, phase);
    await this.runSetup(manifest, workingDirectory, phase);

    const attachments = manifest.attachments ?? [];
    if (attachments.length > 0) {
      this.lifecycle.set("setup");
      log.info(`${phase} step: downloading attachments`, { count: attachments.length, dir: attachmentsDir });
      try {
        await this.deps.downloadAttachments(attachments, attachmentsDir);
      } catch (err) {
        throw new StepError("attachments", err instanceof Error ? err.message : String(err));
      }
    }

    return { workingDirectory, attachmentsDir };
  }

  /** Clones or resyncs every repo in the manifest. The working directory is
   *  resolved separately, by resolveWorkingDirectory. */
  private async syncRepos(manifest: WorkspaceManifest, phase: Phase = "boot"): Promise<void> {
    this.lifecycle.set("cloning");
    log.info(`${phase} step: cloning repos`, { count: manifest.repos.length, workspace: this.deps.workspaceRoot });
    // Unconditional, not guarded on an empty repo list: it is idempotent where
    // `git clone` would have created the directory anyway, and load-bearing
    // where there are no repos to create it.
    try {
      this.deps.ensureWorkspace(this.deps.workspaceRoot);
    } catch (err) {
      throw new StepError("cloning", err instanceof Error ? err.message : String(err));
    }
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
    }
  }

  private async runSetup(manifest: WorkspaceManifest, cwd: string, phase: Phase = "boot"): Promise<void> {
    this.lifecycle.set("setup");
    // Setup commands run WITH working git and gh, because the credential config
    // is already in place. See describeSetupFailure: their output is redacted
    // before it leaves this process.
    log.info(`${phase} step: running setup commands`, { count: manifest.setup_commands.length, cwd });
    // Project variables reach setup through an explicit environment, never by
    // mutating `process.env`: this runs on the prepare path too, where anything
    // in `process.env` at `prepared` is captured into the snapshot's memory and
    // resurrected in every sandbox restored from it (spec §5.3). Merged over
    // `process.env` rather than replacing it, so PATH and HOME still resolve.
    const secretValues = Object.values(manifest.secrets ?? {});
    const setup = await this.deps.runSetupCommands(cwd, manifest.setup_commands, {
      env: { ...process.env, ...projectEnv(manifest) },
      secretValues,
    });
    if (!setup.ok) {
      // `describeSetupFailure` carries the failing command, a decoded signal exit
      // (137 = OOM-killed, the common one) and the tail of its output — without
      // it the orchestrator only ever saw "(exit 137)" with no clue why. The
      // secret values go with it: the message becomes the control plane's
      // `instance.error_message`, and a command that echoes its environment
      // would otherwise carry them there.
      throw new StepError("setup", describeSetupFailure(setup, secretValues));
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
    try {
      await this.serverHandle?.shutdown();
    } finally {
      await this.closeMcpProxy();
    }
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
