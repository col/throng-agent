---
"throng-agent-codex": patch
---

Declare a `software-development` skill on the agent card. A2A v1.0 requires `skills` to hold at
least one entry, and a2a-codex's default is an empty array, so the card was invalid for v1.0
clients.
