#!/bin/sh
# The family gate: one list of checks, run by the pre-commit hook
# (GATE_SCOPE=commit) and by the shared CI workflow (full), so the two cannot
# drift apart. Modelled on initeai's scripts/gate-checks.sh.
#
#   sh scripts/family.sh gate [ref]
#
# ref: the record (debt, file sizes, lint) may not rise against it. The hook
# passes HEAD, CI passes the PR's base.
#
# Steps, in order, each a command from .inite/standards.json "commands" or
# the profile's default:
#   node/next: <pm> run lint, <pm> run typecheck, <pm> run test, [<pm> run build]
#   python:    ruff check ., mypy, python -m pytest -q
# then `inite-standards check`. On a commit the tests and the build are left
# to CI; GATE_BUILD=1 adds the build anywhere.
set -e
here=$(cd "$(dirname "$0")/.." && pwd)
std="node $here/bin/inite-standards.mjs"
ref="${1:-HEAD}"
scope="${GATE_SCOPE:-full}"

group() { if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::group::$1"; else echo "── $1"; fi; }
endgroup() { if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::endgroup::"; fi; }
run_step() {
  name="$1"
  cmd=$($std command "$name")
  [ -n "$cmd" ] || return 0
  group "$name: $cmd"
  sh -c "$cmd" || { endgroup; echo "✗ gate: $name failed ($cmd)" >&2; exit 1; }
  endgroup
}

# One heavy gate at a time on a machine (26.10.2026: three at once filled
# the owner's memory). CI runners are their own machines and skip it.
lock="${INITE_GATE_LOCK:-${XDG_CACHE_HOME:-$HOME/.cache}/inite-family/gate.lock}"
unlock() { [ "$(cat "$lock/pid" 2>/dev/null)" = "$$" ] && rm -rf "$lock"; return 0; }
if [ -z "${CI:-}" ] && [ "$scope" != commit ]; then
  mkdir -p "$(dirname "$lock")"
  said=0
  while ! mkdir "$lock" 2>/dev/null; do
    holder=$(cat "$lock/pid" 2>/dev/null || echo "")
    if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then rm -rf "$lock"; continue; fi
    [ "$said" = 0 ] && echo "gate: another family gate is running (pid ${holder:-?}); waiting." >&2 && said=1
    sleep 10
  done
  echo $$ >"$lock/pid"
  trap unlock EXIT INT TERM
fi

run_step lint
run_step typecheck
if [ "$scope" != commit ]; then
  run_step test
fi
if [ "${GATE_BUILD:-0}" = 1 ]; then
  run_step build
fi
group "standards"
$std check --against "$ref"
endgroup
