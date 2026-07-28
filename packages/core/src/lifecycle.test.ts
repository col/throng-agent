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
});
