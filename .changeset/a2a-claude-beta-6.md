---
"throng-agent-claude": minor
---

Move `@col/a2a-claude` to `0.2.1-beta.6`, which adds `claude.outputFormat` — structured JSON output constrained to a caller-supplied JSON Schema. No behaviour changes for agents that do not set it; the field is absent from Throng's generated config unless a manifest asks for it.
