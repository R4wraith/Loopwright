# {{PROJECT_NAME}} — what it is

{{ONE_LINE}}

## Shape
- **Keystone — {{KEYSTONE}}:** the one contract everything binds to. Build it first; keep it small, versioned, and validated.
{{COMPONENT_BULLETS}}
- **Wrap, don't build:** {{WRAP_NOTE}}

## Scope
{{SCOPE_IN}} first. {{SCOPE_LATER}} is later — {{SEAM}} is the seam that keeps it cheap to add.

## Build order

_The ordered plan. The loop's `no_task` / `done` routing picks the next task from THIS order (highest
leverage first) — each milestone M# and its tasks trace back here. Keep it current; it is the map the
loop steers by when no task is active._

{{BUILD_ORDER}}

## Backlog (speculative)

_Larger architectural directions proposed by a `/dream` brainstorm land here, each tagged
`[dream/speculative]`. Candidates only — never a build-order commitment until a human or the loop's
orient step promotes one in. Empty until the first `/dream` run._
