# PERF (performance budgets & measurements)

Companion ledger to `FINDINGS.md`, same posture: ships empty, filled during the build. The
performance specialist records the numbers here that back any `type: performance` row in
`FINDINGS.md`. A budget breach is filed as an `F#` row in `FINDINGS.md` (`sev: high` if it blocks the
milestone, `med`/`low` otherwise) — `check-gate.sh` already fails the milestone boundary on an
unresolved `blocker`/`high` row regardless of `type`, so no separate perf gate exists.

*What* gets measured, which components get budgets at all, and the benchmark harness that produces the
`measured` column are project territory — this file's schema is deliberately provisional, not
over-designed.

| component | metric | budget | measured | status | F# |
|-----------|--------|--------|----------|--------|----|
