# Context manifests — curated per-agent read-lists

One file per subagent type: `manifests/<subagent_type>.jsonl` — named for the
`subagent_type` the Task tool is invoked with (e.g. `reviewer.jsonl`). On every Task
dispatch, `hooks/subagent-context.mjs` prepends the rows to the dispatch prompt as a
**read list** — paths + reasons, never inlined content. The subagent holds Read and
fetches the files itself; the list just guarantees it knows what to fetch.

## Grammar

One JSON object per line:

```
{"file": "<repo-relative path>", "reason": "<why this agent should always read it>"}
```

- Rows **without** a `file` key are seeds/comments — skipped by the hook (the shipped
  files carry one seed row each).
- A malformed line is skipped with a stderr note — it never blocks a dispatch (fail-open).
- Caps: the first **100** file-rows are read; the injected preamble tops out at **8 KB**
  (overflow drops rows from the end, with a stderr warning) — keep lists short and
  load-bearing, not exhaustive.
- Missing manifest ⇒ the dispatch still gets the active-task header, just no read list.

## Curation

Team-curated markdown-adjacent state: edit by hand, commit with the journal. Good rows
are the files that agent should **always** see regardless of the task — the keystone
contract, the spec section it reviews against, the test conventions file. Task-specific
context belongs in the dispatch prompt itself, not here. Component-owner agents added
via the roster get a manifest by dropping `<agent-name>.jsonl` next to these.
