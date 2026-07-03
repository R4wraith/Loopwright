# PERF (performance budgets & measurements — SP6)

Companion ledger to `FINDINGS.md`, same posture: ships empty, filled during the build. `performance-engineer` records the numbers here that back any `type: performance` row in `FINDINGS.md`. A budget breach is filed as an `F#` row in `FINDINGS.md` (`sev: high` if it blocks the milestone, `med`/`low` otherwise) — `check-gate.sh` already fails the milestone boundary on an unresolved `blocker`/`high` row regardless of `type`, so no separate perf gate exists.

**SP6 owns the gate mechanism (reusing `FINDINGS.md`) and this template's existence only.** *What* gets measured, which components get budgets at all, and the benchmark harness that produces the `measured` column are project/SP3 territory — this file's schema is deliberately provisional, not over-designed.

| component | metric | budget | measured | status | F# |
|-----------|--------|--------|----------|--------|----|
