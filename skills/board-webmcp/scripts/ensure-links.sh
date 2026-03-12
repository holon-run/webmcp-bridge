#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf '[board-webmcp] error: %s\n' "$*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

shell_join() {
  local out=""
  local arg
  for arg in "$@"; do
    if [[ -n "$out" ]]; then
      out+=" "
    fi
    printf -v out '%s%q' "$out" "$arg"
  done
  printf '%s\n' "$out"
}

need_cmd uxc
need_cmd npx

url="https://board.holon.run"
profile="$HOME/.uxc/webmcp-profile/board"
link_dir=""
local_mcp_command="${WEBMCP_LOCAL_MCP_COMMAND:-npx -y @webmcp-bridge/local-mcp}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url)
      [[ $# -ge 2 ]] || fail 'missing value for --url'
      url="$2"
      shift 2
      ;;
    --profile)
      [[ $# -ge 2 ]] || fail 'missing value for --profile'
      profile="$2"
      shift 2
      ;;
    --dir)
      [[ $# -ge 2 ]] || fail 'missing value for --dir'
      link_dir="$2"
      shift 2
      ;;
    --local-mcp-command)
      [[ $# -ge 2 ]] || fail 'missing value for --local-mcp-command'
      local_mcp_command="$2"
      shift 2
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

mkdir -p "$profile"
link_command=(uxc link)
if [[ -n "$link_dir" ]]; then
  mkdir -p "$link_dir"
  link_command+=(--dir "$link_dir")
fi
read -r -a launcher_parts <<< "$local_mcp_command"
cli_args=("${launcher_parts[@]}" --url "$url" --headless --no-auto-login-fallback --user-data-dir "$profile")
ui_args=("${launcher_parts[@]}" --url "$url" --no-headless --user-data-dir "$profile")

cli_command="$(shell_join "${cli_args[@]}")"
ui_command="$(shell_join "${ui_args[@]}")"

"${link_command[@]}" board-webmcp-cli "$cli_command" --daemon-exclusive "$profile" --force >/dev/null
"${link_command[@]}" board-webmcp-ui "$ui_command" --daemon-exclusive "$profile" --force >/dev/null

printf 'linked %s -> %s\n' 'board-webmcp-cli' "$cli_command"
printf 'linked %s -> %s\n' 'board-webmcp-ui' "$ui_command"
printf 'profile %s\n' "$profile"
