import { startControlServer } from "@throng/agent-core";
import { CodexEngineAdapter } from "./adapter.js";

startControlServer(new CodexEngineAdapter());
