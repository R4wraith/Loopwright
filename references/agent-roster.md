# Agent roster — spine + component-owners

The roster has two parts: a fixed **spine** every project needs, and **component-owners** you generate one-per-subsystem.

## How to derive the roster
1. Keep the five spine agents as-is (they're already in `assets/skeleton/dot-claude/agents/`).
2. For each major component from the interview (Step 1), create one component-owner agent from the template below.
3. Name them `<area>-engineer` or `<area>-architect` (use `-architect` for the keystone owner).
4. 3–6 component-owners is the sweet spot. Fewer → under-decomposed; more → group related ones.

## The spine (already shipped, generic — don't regenerate)
- **reviewer** — independent, **read-only** (no Edit/Write, so it can't "fix to pass"); reviews correctness + security; gives a go/no-go. Separation of duties: the auditor isn't the author.
- **test-engineer** — unit/integration/e2e + fuzzing any parser of untrusted input; never weakens a test to pass.
- **integrator** — assembles the parts into the real artifact and runs end-to-end smoke tests; a slice isn't done until it works assembled.
- **release-manager** — git hygiene: feature branches, small Conventional Commits, merges only when green; never destructive git.
- **performance-engineer** — budgets/benchmarks/profiles the hot path; keeps heavy work off it.

## Component-owner template
Create `agents/<name>.md` for each component:

```markdown
---
name: {{COMPONENT_NAME}}
description: Owns {{WHAT_IT_OWNS}}. Use for {{WHEN_TO_USE}}.
tools: Read, Write, Edit, MultiEdit, Grep, Glob, Bash
model: sonnet
---
You own {{WHAT_IT_OWNS}}.
- {{KEY_RESPONSIBILITY_1}}
- {{KEY_RESPONSIBILITY_2}}
- {{KEY_RESPONSIBILITY_3}}
{{CONSTRAINTS — include "this parses untrusted input: validate, bound allocations, never panic on garbage" if it touches external input; note any contract it must honor with the keystone}}
Keep it as simple as it can be while doing its job. Report what you built and any impact on the keystone or other components.
```

Guidance for filling it:
- The **keystone owner** is special — mark it `-architect`, and its brief should stress: small, versioned, validated, codegen-friendly, the thing everything binds to.
- Give each component-owner a **clear boundary** so two agents don't fight over the same files.
- If a component parses external/untrusted input, say so explicitly — it changes how it's written and tested.
- **Model routing (SP3):** the template default is `model: sonnet` — routine component-owners execute non-keystone code; risk is caught at verify (the opus `reviewer`), not by the owner's own model. Set `model: opus` on the keystone `-architect` owner (it owns the contract everything binds to) and on any owner of a component that parses untrusted input or holds a keystone-level contract. Don't set every component-owner to opus — that's the "Opus everywhere" posture this template deliberately avoids.
- **Codemap ownership (SP-mem, Tier 2):** each component-owner keeps `.claude/CODEMAP.md` current for the module(s) it owns — the scaffolder seeds the Modules table from `DESIGN.md`'s components at materialize time; the owner updates its rows (contracts, `depends on`/`callers` edges) at the loop's Record step whenever its module's boundary or public contract changes.

## Example (from the AgentBox project)
Spine (all five) + four component-owners:
- `schema-architect` (keystone owner — the event schema)
- `sensor-integrator` (wraps Tetragon; builds the normalizer)
- `detection-engineer` (the detection multiplexer: regex/YARA/Sigma)
- `forensic-reviewer-engineer` (the periodic LLM review pass)

See `worked-example.md` for the full briefs.
