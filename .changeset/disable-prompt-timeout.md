---
"throng-agent-claude": minor
---

Disable the A2A wrapper's prompt timeout, so a Claude turn is no longer cut off after ten minutes.

`@col/a2a-claude` bounds every turn with `timeouts.prompt`, defaulting to `600000` ms, and until now
Throng left that default in place. A Throng turn has no useful upper bound — a long build, a slow
test suite or a deep refactor can legitimately run for hours — and when the bound elapsed the turn
was aborted and the task published as `failed`, losing whatever work was in flight. There was no
partial result and no way to resume; the only signal was a `Prompt timed out after 600000ms` status.

`buildAgentConfig` now sets `timeouts: { prompt: 0 }`. The wrapper dependency moves to
`0.2.1-beta.3`, which is the version that gives `0` its meaning: earlier versions armed the timer
unconditionally, so `0` (and any negative value) was coerced by `setTimeout` to the next tick and
aborted the turn almost immediately — strictly worse than the default. On `0.2.1-beta.3` any value
`<= 0` disables the bound and the turn runs until it completes.

Cancellation is unaffected and remains the way to stop a running turn: the runtime aborts through the
wrapper's `AbortController`, which never depended on the timeout. The one behaviour to be aware of is
that turns are serialized per A2A `contextId`, so a turn that genuinely never finishes now holds its
context's queue until it is cancelled, where previously the timeout would eventually free it.
