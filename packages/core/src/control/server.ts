import type { Server } from "node:http";
import { join } from "node:path";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { syncOrClone } from "../bootstrap/git.js";
import { runSetupCommands } from "../bootstrap/setup.js";
import { injectGitIdentity } from "../bootstrap/git-identity.js";
import { writeCredentialConfig } from "../creds/config.js";
import { homeDir } from "../env.js";
import type { AdapterRegistry } from "../engine/adapter.js";
import { log } from "../log.js";
import { TaskRun, type BootDeps } from "../task-run.js";
import { checkInitToken } from "./init-token.js";

export interface ControlAppOptions {
  taskRun: TaskRun;
}

export function createControlApp(opts: ControlAppOptions): Express {
  const taskRun = opts.taskRun;
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/api/status", (_req, res) => {
    res.json(taskRun.lifecycle.status());
  });

  app.post("/api/initialise", async (req, res) => {
    log.info("POST /api/initialise received");
    if (!checkInitToken(process.env.THRONG_INIT_TOKEN, req.headers.authorization)) {
      log.warn("POST /api/initialise rejected: unauthorized (bad or missing THRONG_INIT_TOKEN)");
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const result = await taskRun.initialise(req.body);
    if (result.ok) {
      res.status(202).json({ status: result.status });
    } else if ("already" in result) {
      res.status(409).json({ error: "already_initialised" });
    } else {
      res.status(400).json(result.errors);
    }
  });

  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof SyntaxError && "body" in (err as object)) {
      res.status(400).json([{ field: "manifest", reason: "invalid JSON body" }]);
      return;
    }
    next(err);
  });

  return app;
}

/**
 * Generic boot deps assembled from the environment.
 *
 * `$HOME/workspace`, not `/workspace`. Creating a top-level directory needs
 * root, and E2B's envd runs the sandbox as uid 1000 — `mkdir /workspace` there
 * is Permission denied, and `/workspace` does not exist in the E2B image to
 * begin with. `docker run` honours the image's USER (root here) and so never
 * showed it.
 *
 * `WORKSPACE_DIR` stays: it is the documented way to put the workspace
 * somewhere else, and it still works wherever the runtime's environment is
 * under the caller's control. What it cannot be is the *delivery mechanism* in
 * E2B — the runtime process there is started during template build and captured
 * in the snapshot, so neither the template's `setEnvs` nor the image's `ENV`
 * reach it. The default has to be right on its own.
 */
export function defaultBootDeps(): BootDeps {
  return {
    syncOrClone,
    runSetupCommands,
    writeCredentialConfig: (manifest) => writeCredentialConfig(manifest),
    injectGitIdentity,
    // `||` rather than `??` so a blank WORKSPACE_DIR falls back instead of
    // resolving every clone destination against "".
    workspaceRoot: process.env.WORKSPACE_DIR || join(homeDir(), "workspace"),
  };
}

export function buildServer(registry: AdapterRegistry): Express {
  return createControlApp({ taskRun: new TaskRun(defaultBootDeps(), registry) });
}

/**
 * The app entrypoint: `startControlServer({ claude: new ClaudeEngineAdapter(), … })`.
 *
 * Returns the listening server so a caller — in practice the test suite — can
 * shut it down.
 */
export function startControlServer(registry: AdapterRegistry): Server {
  // First statement, before anything can fork. When throng-creds declines or
  // dies — a 403, an unreachable service, an unconfigured sandbox — git falls
  // back to asking for a username: an immediate error without a TTY, and a
  // permanent block with one, which is the worst outcome this design has.
  //
  // Set here, this covers the runtime and everything DESCENDED from it — the
  // engine, the shells it opens, the agent's `git push` an hour into the task —
  // which is what the deleted injectGitCredentials() used to arrange. It is
  // precisely not a whole-sandbox guarantee: a shell E2B's envd starts is a
  // sibling of this process, not a child, and inherits nothing from here. The
  // image covers that case twice over, with `ENV GIT_TERMINAL_PROMPT=0` (which
  // reaches `docker exec` but not E2B, since the resumed runtime inherits no
  // image ENV — verified on a live sandbox, where not even LANG survives) and
  // with /etc/profile.d/throng.sh, which any login shell reads whoever started
  // it. Three mechanisms because no single one of them covers everything.
  //
  // Here rather than at module scope so that importing this module — which
  // buildServer and createControlApp do, and which the test suite does — has no
  // global side effect. Nothing spawns a child before this line: the control
  // server has to be listening and take an /api/initialise before any clone,
  // setup command or engine process exists.
  process.env.GIT_TERMINAL_PROMPT = "0";
  // `||`, matching WORKSPACE_DIR above: `Number("")` is 0, so `??` would turn a
  // blank CONTROL_PORT into "listen on a random port" — reachable by nothing,
  // and silent. The value never arrives from the image or the template under
  // E2B, so this default is what actually runs there.
  const port = Number(process.env.CONTROL_PORT || 8080);
  const app = buildServer(registry);
  return app.listen(port, "0.0.0.0", () => {
    log.info("control server listening", { port });
  });
}
