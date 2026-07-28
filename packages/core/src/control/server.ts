import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { clone, checkout } from "../bootstrap/git.js";
import { runSetupCommands } from "../bootstrap/setup.js";
import { injectGitCredentials } from "../bootstrap/git-credentials.js";
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

/** Generic boot deps assembled from the environment. */
export function defaultBootDeps(): BootDeps {
  return {
    clone,
    checkout,
    runSetupCommands,
    injectGitCredentials,
    workspaceRoot: process.env.WORKSPACE_DIR ?? "/workspace",
  };
}

export function buildServer(registry: AdapterRegistry): Express {
  return createControlApp({ taskRun: new TaskRun(defaultBootDeps(), registry) });
}

/** The app entrypoint: `startControlServer({ claude: new ClaudeEngineAdapter(), … })`. */
export function startControlServer(registry: AdapterRegistry): void {
  const port = Number(process.env.CONTROL_PORT ?? 8080);
  const app = buildServer(registry);
  app.listen(port, "0.0.0.0", () => {
    log.info("control server listening", { port });
  });
}
