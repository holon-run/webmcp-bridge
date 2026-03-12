#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SKILL_DIR="${ROOT_DIR}/skills/webmcp-bridge"
SKILL_FILE="${SKILL_DIR}/SKILL.md"
OPENAI_FILE="${SKILL_DIR}/agents/openai.yaml"

fail() { printf '[validate] error: %s\n' "$*" >&2; exit 1; }
need_cmd() { command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"; }

need_cmd rg

for f in \
  "$SKILL_FILE" \
  "$OPENAI_FILE" \
  "${SKILL_DIR}/references/usage-patterns.md" \
  "${SKILL_DIR}/references/source-modes.md" \
  "${SKILL_DIR}/references/link-patterns.md" \
  "${SKILL_DIR}/references/troubleshooting.md" \
  "${SKILL_DIR}/scripts/ensure-links.sh"; do
  [[ -f "$f" ]] || fail "missing required file: $f"
done

rg -q '^name:\s*webmcp-bridge\s*$' "$SKILL_FILE" || fail 'invalid skill name'
rg -q '^description:\s*.+' "$SKILL_FILE" || fail 'missing description'
rg -q 'command -v <site>-webmcp-cli' "$SKILL_FILE" || fail 'missing CLI link-first check'
rg -q 'command -v <site>-webmcp-ui' "$SKILL_FILE" || fail 'missing UI link-first check'
rg -q '<site>-webmcp-cli -h' "$SKILL_FILE" || fail 'missing help-first usage'
rg -q '<site>-webmcp-cli <operation> -h' "$SKILL_FILE" || fail 'missing operation help example'
rg -q '<site>-webmcp-cli <operation> field=value' "$SKILL_FILE" || fail 'missing key=value example'
rg -q "<site>-webmcp-cli <operation> '\{" "$SKILL_FILE" || fail 'missing positional JSON example'
rg -q '~/.uxc/webmcp-profile/<site>' "$SKILL_FILE" || fail 'missing profile convention'

if rg -q -- '(^|[[:space:]])(list|describe|call)([[:space:]]|$)|--input-json|--args .*[{]' "$SKILL_FILE" "${SKILL_DIR}/references"; then
  fail 'found banned legacy invocation patterns'
fi

echo 'skills/webmcp-bridge validation passed'
