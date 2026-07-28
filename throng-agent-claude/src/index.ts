import { startControlServer } from "@throng/agent-core";
import { ClaudeEngineAdapter } from "./adapter.js";

startControlServer(new ClaudeEngineAdapter());
