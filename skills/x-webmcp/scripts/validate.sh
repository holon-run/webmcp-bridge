#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SKILL_DIR="${ROOT_DIR}/skills/x-webmcp"
SKILL_FILE="${SKILL_DIR}/SKILL.md"
OPENAI_FILE="${SKILL_DIR}/agents/openai.yaml"

fail() { printf '[validate] error: %s\n' "$*" >&2; exit 1; }
need_cmd() { command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"; }

need_cmd rg

for f in \
  "$SKILL_FILE" \
  "$OPENAI_FILE" \
  "${SKILL_DIR}/references/usage-patterns.md" \
  "${SKILL_DIR}/scripts/ensure-links.sh"; do
  [[ -f "$f" ]] || fail "missing required file: $f"
done

rg -q '^name:\s*x-webmcp\s*$' "$SKILL_FILE" || fail 'invalid skill name'
rg -q '^description:\s*.+' "$SKILL_FILE" || fail 'missing description'
rg -q 'command -v x-webmcp-cli' "$SKILL_FILE" || fail 'missing link-first check'
rg -q 'x-webmcp-cli -h' "$SKILL_FILE" || fail 'missing help-first usage'
rg -q 'grok.chat -h' "$SKILL_FILE" || fail 'missing Grok help example'
rg -q 'bridge.session.bootstrap' "$SKILL_FILE" || fail 'missing bootstrap guidance'
rg -q 'bridge.session.mode.set' "$SKILL_FILE" || fail 'missing headed-mode guidance'
rg -q '~/.uxc/webmcp-profile/x' "$SKILL_FILE" || fail 'missing profile convention'

if rg -q -- '(^|[[:space:]])(list|describe|call)([[:space:]]|$)|--input-json|--args .*[{]' "$SKILL_FILE" "${SKILL_DIR}/references"; then
  fail 'found banned legacy invocation patterns'
fi

echo 'skills/x-webmcp validation passed'
