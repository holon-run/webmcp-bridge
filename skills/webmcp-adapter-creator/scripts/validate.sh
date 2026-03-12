#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SKILL_DIR="${ROOT_DIR}/skills/webmcp-adapter-creator"
SKILL_FILE="${SKILL_DIR}/SKILL.md"
OPENAI_FILE="${SKILL_DIR}/agents/openai.yaml"

fail() { printf '[validate] error: %s\n' "$*" >&2; exit 1; }
need_cmd() { command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"; }

need_cmd rg

for f in \
  "$SKILL_FILE" \
  "$OPENAI_FILE" \
  "${SKILL_DIR}/references/workflow.md" \
  "${SKILL_DIR}/references/network-discovery.md" \
  "${SKILL_DIR}/references/request-template-patterns.md" \
  "${SKILL_DIR}/references/testing.md" \
  "${SKILL_DIR}/scripts/scaffold-adapter.sh"; do
  [[ -f "$f" ]] || fail "missing required file: $f"
done

rg -q '^name:\s*webmcp-adapter-creator\s*$' "$SKILL_FILE" || fail 'invalid skill name'
rg -q '^description:\s*.+' "$SKILL_FILE" || fail 'missing description'
rg -q 'scaffold-adapter.sh --name <site> --host <host> --url <url>' "$SKILL_FILE" || fail 'missing scaffold workflow'
rg -q 'browser-side request execution' "$SKILL_FILE" || fail 'missing browser-side execution guidance'
rg -q 'request-template' "$SKILL_FILE" || fail 'missing request-template guidance'
rg -q '\$webmcp-bridge' "$SKILL_FILE" || fail 'missing bridge handoff guidance'
rg -q 'Do not add credential vaulting, secret replay, or auth bypass logic\.' "$SKILL_FILE" || fail 'missing auth safety guardrail'

echo 'skills/webmcp-adapter-creator validation passed'
