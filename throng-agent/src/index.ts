import { startControlServer } from "@throng/agent-core";
import { createRegistry } from "./registry.js";

startControlServer(createRegistry());
