# The capture eval corpus

Every case here is a REAL capture from `raw_ingestions`, with the tool calls it
should produce. Regenerate the raw half with:

```
node scripts/eval-import.mjs            # writes/refreshes tests/corpus/*.json
node scripts/eval-import.mjs --limit 40
```

The importer only ever fills in `input` and `recorded` (what the pipeline
actually did, straight from `ai_actions`). **`expect` is hand-written** - it is
the contract, and seeding it from the recorded behaviour would encode the bug as
the expectation.

## Why the offline half is the valuable half

`tests/agent-eval.test.mjs` runs inside `npm test`, hermetically, for free. It
does NOT call a model. It replays each case's evidence through the real
deterministic layers:

```
classifyRequestKind -> expandToolCalls -> negation -> already-recorded -> notes
```

Most of this app's documented bugs lived in exactly those layers, not in the
model. On 2026-08-06 the brain routed a permanent diet change perfectly
(`update_plan_candidate` at 0.95) and `fan-out-expander` appended a 540 kcal meal
built from the instruction text. So the free, no-token run covers where the bugs
actually are.

## The one metric that must never drop

`must_not` precision. A hit is a hard zero for the case, no partial credit. A
phantom meal is the failure the owner actually experiences, and averaging it
against 199 passing cases is how it survives a green build.

## Adding a case

Every new bug becomes a file here BEFORE it becomes a code change.
