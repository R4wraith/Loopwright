# CODEMAP — code-structure awareness (Tier 2)

_Curated, not exhaustive. Only modules and symbols with real contracts or coupling belong here — if
this lists everything it's worthless and stale by morning. Updated at the loop's **Record** step, in
the same commit as the code it describes. Git wins over memory: if a row drifts from the code, that's
a `.claude/FINDINGS.md` `F#` (`codemap-drift`) — verified against reality, not trusted blindly._

`Codemap-Scale: codemap-only`   <!-- codemap-only | +lsp-mcp | +graph — escalation ladder is in CLAUDE.md's "Memory" section. Promotions are logged as a DECISIONS.md `D#`. -->

## Modules

Coarse index: one row per module/package with a real boundary. Seeded from `.claude/DESIGN.md`'s
components at scaffold time — replace the template row below with one row per real component (add
more rows as needed, delete it if there's nothing to seed yet); kept current by the component-owner
of each module.

Example row (delete once real modules exist):
`| detection | src/detect/ | scores inbound events | normalizer, rules |`

| module | path | responsibility | depends on |
|--------|------|----------------|------------|
| {{MODULE}} | {{PATH}} | {{RESPONSIBILITY}} | {{DEPENDS_ON}} |
<!-- ^ scaffold-filled from DESIGN.md's components — this row is expected to be replaced, unlike Key symbols below. -->

## Key symbols

Fine index: only symbols with a real contract or coupling worth one hop — not every function.
`depends on` / `callers` are the coupling edges (a poor-man's call graph): keep them **direct,
load-bearing** edges only; do not transitively close them (that's rung 3's job, not a human's).
`contract` is the one-line behavioural promise (types + key invariant) that lets the loop reason
about a symbol *without opening the file* — this is the payload. `notes` cross-links Tier 1: cite
`F#`/`L#`/`D#` so a finding or hard-won lesson about a symbol is one hop from the structure.

Left empty at scaffold time (no real symbols yet) — populated as the build adds them, exactly like
`FINDINGS.md`. Do not fabricate a row here just to fill a placeholder.

Example row (delete once real symbols exist):
`| Detector.score | method | detection | Event → float[0,1]; pure, no I/O | pipeline.run | hot path |`

| symbol | kind | module | contract (in → out / invariant) | callers | notes |
|--------|------|--------|--------------------------------|---------|-------|
