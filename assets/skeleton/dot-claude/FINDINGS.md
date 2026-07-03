# FINDINGS (active security & review findings)

The tracked findings ledger — security findings, review findings, threat-model/abuse cases.
Each row is one finding; the `status` column is what the milestone gate reads.

- **sev:** blocker | high | med | low | nit
- **status:** open → planned → fixed → verified → closed  (plus: accepted [needs a rationale] | wontfix)
- **GATE (checked at every milestone boundary):** no `blocker` or `high` row may be in any status
  other than `verified`, `closed`, or `accepted`. Assert with `.claude/scripts/check-gate.sh`.
  Note: `wontfix` does NOT satisfy the gate for a `blocker`/`high` — to leave one unresolved you must
  consciously mark it `accepted` with a rationale.
- **type (free-form; suggested AppSec vocabulary, SP2):** the `type` column stays free-form — the
  gate only reads `sev`+`status`, so adding a type never needs a schema/script change. Suggested set
  for AppSec rows emitted by `threat-modeler` (design-time: STRIDE + abuse/misuse) and
  `appsec-reviewer` (code-time: OWASP sweep + adjudication): `threat`, `abuse-case`, `misuse-case`,
  `injection`, `authz`, `crypto`, `deserialize`, `ssrf`, `path-traversal`, `secret`, `dos`.
- **`type: performance` is first-class (SP6, perf gate).** A budget breach found by
  `performance-engineer` is filed as an ordinary `F#` row with `type: performance` (`sev: high` if
  it blocks the milestone, `med`/`low` otherwise) — no separate perf gate script exists or is
  needed: `.claude/scripts/check-gate.sh` already fails the milestone boundary on any unresolved
  `blocker`/`high` row regardless of `type`, so a `type: performance` row rides the exact same
  rule. The `measured`/`budget` numbers a perf row references live in `.claude/PERF.md`, not in
  this table.

Example row (delete once real findings exist):
`| F1 | high | injection | verified | parametrize the query | reviewer | appsec-reviewer |`

| ID | sev | type | status | mitigation | verified | source |
|----|-----|------|--------|------------|----------|--------|
