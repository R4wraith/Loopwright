#!/usr/bin/env bash
# GUI smoke-shot TEMPLATE (SP7/F8) — a project fills in the TODOs below; the harness never
# runs this unmodified. Unit tests + a green `check.sh`/`run-tests.sh` verify LOGIC, not
# what actually renders — they miss the class of bug where the component behaves correctly
# but ships visually broken (the Lumen build shipped exactly this: a Settings panel with no
# CSS class applied, so it rendered as unstyled/overlapping HTML while every unit test and
# code review passed clean). A screenshot + a couple of cheap layout-invariant assertions
# catches that class of regression that logic-only verification structurally cannot.
#
# When this runs (see .claude/commands/loop.md's T3/milestone verify tier): GUI projects run
# `bash .claude/scripts/gui-smoke.sh` at milestone verify, alongside the full spine.
# Non-GUI projects: leave this file as the stub — it is opt-in, not wired into check.sh or
# run-tests.sh, and does nothing destructive if run un-filled-in (see the guard below).
#
# What a filled-in version should do, end to end:
#   1. Launch the app's dev server (or a built preview) in the background.
#   2. Wait for it to be ready (poll a health endpoint / port, don't sleep-and-hope).
#   3. Screenshot the key screen(s) — a headless browser tool (Playwright, Puppeteer, or
#      the claude-in-chrome skill) is the usual choice; anything that produces a real
#      rendered screenshot works.
#   4. Assert basic layout invariants against the screenshot/DOM: no zero-size/overlapping
#      elements where content is expected, no unstyled-HTML fallback (e.g. a component
#      missing its CSS class renders with browser-default styling — that's detectable),
#      key interactive elements are visible/in-viewport.
#   5. Tear down the dev server (trap on EXIT so a failure mid-script doesn't leak it).
#
# TODO(project): replace every TODO marker below with real commands for this project's
# stack. Until filled in, this script is a documented no-op-with-a-loud-reminder — it does
# NOT silently report PASS on a project it hasn't actually been wired up for.

root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$root" || { echo "cannot resolve project root" >&2; exit 1; }
set -uo pipefail

# TODO(project): flip this to 1 once the steps below are filled in for this project's GUI stack.
FILLED_IN=0

if [ "$FILLED_IN" -ne 1 ]; then
  echo "gui-smoke: TEMPLATE STUB — not yet wired up for this project (see header TODOs)."
  echo "gui-smoke: SKIP (not a failure — but a GUI project must fill this in before relying on it at milestone verify)."
  exit 0
fi

server_pid=""
cleanup() {
  # TODO(project): kill the dev server started below, if any.
  [ -n "$server_pid" ] && kill "$server_pid" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# TODO(project): start the dev server, e.g.:
#   npm run dev & server_pid=$!
# TODO(project): wait for readiness, e.g. poll `curl -sf http://localhost:PORT` in a loop
#   with a bounded timeout — never an unconditional `sleep N`.
# TODO(project): screenshot the key screen(s), e.g. via Playwright/Puppeteer or the
#   claude-in-chrome skill, saving to a known path for the assertions below.
# TODO(project): assert layout invariants against the screenshot/DOM — at minimum: no
#   zero-size/overlapping key elements, no unstyled-HTML fallback, key controls in-viewport.

echo "gui-smoke: PASS"
exit 0
