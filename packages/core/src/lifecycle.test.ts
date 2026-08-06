import { describe, expect, it } from "vitest";
import { Lifecycle } from "./lifecycle.js";

describe("Lifecycle", () => {
  it("starts uninitialised", () => {
    const l = new Lifecycle();
    expect(l.state).toBe("uninitialised");
    expect(l.status()).toEqual({ state: "uninitialised" });
  });

  it("advances through states", () => {
    const l = new Lifecycle();
    l.set("booting");
    l.set("cloning");
    expect(l.state).toBe("cloning");
  });

  it("records failure with structured detail", () => {
    const l = new Lifecycle();
    l.fail({ step: "cloning", message: "repo unreachable" });
    expect(l.state).toBe("failed");
    expect(l.status()).toEqual({ state: "failed", error: { step: "cloning", message: "repo unreachable" } });
  });

  // `prepared` is a terminal REST state, not a failure state: a snapshot is taken
  // here, and the sandbox restored from it still accepts one /api/initialise.
  // GET /api/status has to report it, because the control plane's poller is what
  // decides the snapshot is ready to capture.
  it("reports prepared as a plain state, with no error", () => {
    const l = new Lifecycle();
    l.set("prepared");
    expect(l.status()).toEqual({ state: "prepared" });
  });
});
