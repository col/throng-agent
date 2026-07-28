export type LifecycleState = "uninitialised" | "booting" | "cloning" | "setup" | "ready" | "failed";

export interface FailureDetail {
  step: string;
  message: string;
}

export interface StatusView {
  state: LifecycleState;
  error?: FailureDetail;
}

export class Lifecycle {
  state: LifecycleState = "uninitialised";
  private failure?: FailureDetail;

  set(state: Exclude<LifecycleState, "failed">): void {
    this.state = state;
  }

  fail(detail: FailureDetail): void {
    this.state = "failed";
    this.failure = detail;
  }

  status(): StatusView {
    return this.failure ? { state: this.state, error: this.failure } : { state: this.state };
  }
}
