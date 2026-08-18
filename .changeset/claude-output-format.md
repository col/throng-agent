---
"throng-agent-claude": minor
---

Add `agent.output_format`, a new optional initialise key that constrains a Claude turn's output to a JSON Schema.

```jsonc
"agent": {
  "platform": "claude",
  "output_format": { "type": "json_schema", "schema": { /* … */ } }
}
```

Throng validates the wrapper shape only — `type` must be `json_schema` and `schema` must be an object — and returns a field-level 400 from `POST /api/initialise` when either is wrong. The schema body itself is forwarded verbatim: it is never inspected or key-transformed, so JSON Schema's own vocabulary survives intact, and an invalid schema surfaces from the SDK at turn time rather than at initialise. Omitting the key leaves the wrapper's freeform-text default in place, so no existing manifest changes behaviour.

Two operational notes for anyone enabling it. The structured result arrives as an additive `application/json` data part on the `response` artifact, but the text part is still published and now carries the JSON payload instead of prose — a consumer reading only the text part will see JSON. And an unsatisfiable schema fails the turn with "Structured output retries exhausted." rather than degrading to freeform output, so a schema bug looks like a model failure unless you know to check.
