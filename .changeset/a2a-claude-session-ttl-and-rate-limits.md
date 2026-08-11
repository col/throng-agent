---
"throng-agent-claude": minor
---

Move `@col/a2a-claude` to `0.2.1-beta.4`, which stops sessions expiring mid-conversation and handles Claude rate limits as a pause rather than a failure.

**Sessions no longer expire.** `session.ttl` now defaults to `0`. Previously it defaulted to one hour measured from a conversation's **first** message — not its last — so any Throng conversation still going an hour after it started silently lost its `contextId` → Claude session mapping. The next turn began a brand-new Claude session with no memory of the work so far, mid-task, with nothing in the A2A stream to say why. Throng never set `session` explicitly, so it inherited that default; it now inherits `0` and a context resumes the same Claude session for the life of the sandbox.

The one consequence to know: if a Claude session's on-disk transcript is removed while the agent is running, the stale mapping is now pinned for the life of the process instead of being evicted within the hour, so turns on that context keep failing to resume until the container restarts. In a Throng sandbox the transcript lives and dies with the container, so this needs someone to delete it out from under a running agent.

**Rate limits end a turn as `input-required`, not `failed`.** A Claude rate-limit rejection previously fell through unrecognised and surfaced as a `failed` task with `"Error during execution."` — indistinguishable from a real error, and terminal, so the conversation could not be continued. The turn now ends with a non-terminal `input-required` status naming the limit type and reset time, plus structured metadata (`reason`, `rateLimitType`, `resetsAt`, `resetsAtIso`, `utilization`, and `errorCode` / `canPurchaseCredits` when the SDK reports them). The task stays open, so a client can continue the same task once the limit resets. `rateLimit.taskState` can force a terminal state for clients that cannot handle a non-terminal task; Throng leaves it at the default.

The SDK's own retries are unchanged and still run to exhaustion inside the turn — they are just visible now, as `rate_limit` sideband events with `action: "retrying"`. Note that rate-limit signals only reach the wrapper under claude.ai subscription auth; under an API key, Bedrock or Vertex the SDK never emits them.

No Throng-side configuration changed — `buildAgentConfig` sets neither `session` nor `rateLimit`, so both behaviours arrive through the wrapper's new defaults.
