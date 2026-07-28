import { describe, expect, it } from "vitest";
import { checkInitToken } from "./init-token.js";

describe("checkInitToken", () => {
  it("allows any request when THRONG_INIT_TOKEN is unset/blank (open posture)", () => {
    expect(checkInitToken(undefined, "")).toBe(true);
    expect(checkInitToken("", "Bearer whatever")).toBe(true);
  });

  it("allows a matching bearer token", () => {
    expect(checkInitToken("s3cret", "Bearer s3cret")).toBe(true);
  });

  it("rejects a missing or mismatched token when configured", () => {
    expect(checkInitToken("s3cret", "")).toBe(false);
    expect(checkInitToken("s3cret", "Bearer nope")).toBe(false);
    expect(checkInitToken("s3cret", "s3cret")).toBe(false); // no Bearer prefix
  });
});
