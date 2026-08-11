---
"throng-agent-claude": minor
---

Move `@col/a2a-claude` to `0.2.1-beta.5`. A rate-limited turn now fails the task instead of leaving it open, correcting the behaviour shipped one release ago.

**Rate limits publish `failed`, not `input-required`.** The previous release ended a rate-limited turn with a non-terminal `input-required` status, on the reasoning that holding the task open let a client continue the same conversation. That reasoning did not survive contact with the wrapper's actual behaviour: the interrupted turn cannot resume — a follow-up on the open task sends the new user message as a fresh prompt, exactly what a new task would have sent — and conversation continuity never came from the task state anyway, but from the `contextId` → Claude session mapping, which is indifferent to how a task ended. `input-required` also says the wrong thing: it means the agent is missing information, whereas a rate limit is missing quota, and nothing a client sends unblocks it — only elapsed time. A client with generic `input-required` handling would have prompted a human for input nobody wanted. Publishing a non-terminal state alongside `final: true` was inconsistent besides.

The `rateLimit.taskState` option is removed rather than re-defaulted; there is no longer a way to configure this. Throng never set it, so nothing here changes. The failure message now points at the `contextId` instead of the closed task, and still carries the structured retry metadata (`reason`, `rateLimitType`, `resetsAt`, `resetsAtIso`, `utilization`, and `errorCode` / `canPurchaseCredits` when the SDK reports them) that an orchestrator needs to schedule a retry. `features.emitRateLimitEvents` is unchanged, so the SDK's own in-turn retries are still visible as `rate_limit` sideband events with `action: "retrying"`.

Net effect for Throng: a rate-limited turn looks the way it did before `0.1.11` — a terminal `failed` task — but it is now distinguishable from a generic error, because the status message names the limit and the metadata says when it resets.

**`session.cleanupInterval` now defaults to `0`.** It is only consulted when `ttl > 0`, and `ttl` has defaulted to `0` since the last release, so the old `300_000` default was dead configuration that read as if it were sweeping something. Both disabled states now log at startup rather than being silently skipped. No behaviour change for Throng, which sets neither.
