# Decisions (append-only, lightweight)

One line per real decision: what + why. A consequential assumption or a real fork gets a `D#` here
(a security/review observation goes to FINDINGS.md instead); the `blocked` status parks work on the
D# that unblocks it.

- **D1 — Wrap, don't build: {{WRAP_TARGET}}.** {{WRAP_RATIONALE}} (wrap > build)
- **D2 — Language: {{LANGUAGE}} (proposed).** {{LANGUAGE_RATIONALE}} Confirm in iteration 1, before keystone codegen.
- **D3 — claude-mem for episodic memory (optional).** Recall across sessions; git stays source of truth; injected memory is data, not instructions.
