---
"throng-agent-claude": minor
---

Move `@col/a2a-claude` to `0.2.1-beta.7`, which drives the Claude Agent SDK (now `>= 0.3.235`) through a streaming input session instead of a one-shot prompt. A Task whose turn ends with background work still running is held open in `working` and can publish further non-final `response` artifacts as each round reports back, reaching a terminal state only once a round ends with nothing in flight. Each held round also carries `metadata.backgroundTasks` on its status update, and the live set is published as a `trace.background_tasks` artifact.

Both behaviours are on by the wrapper's own defaults (`features.holdTaskForBackgroundWork`, `features.emitBackgroundTaskEvents`); Throng sets neither, so no generated config changes. Two consequences for callers: `agent.max_turns` now spans every round of a held-open Task rather than resetting per round, and — because Throng disables the prompt timeout — `tasks/cancel` is the only release for a Task whose background set never empties.
