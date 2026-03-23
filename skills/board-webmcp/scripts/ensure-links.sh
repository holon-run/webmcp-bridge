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
daemon_idle_ttl="${WEBMCP_DAEMON_IDLE_TTL:-}"

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
link_args=("${launcher_parts[@]}" --url "$url" --headless --no-auto-login-fallback --user-data-dir "$profile")

link_value="$(shell_join "${link_args[@]}")"

link_install_args=(board-webmcp-cli "$link_value" --daemon-exclusive "$profile")
if [[ -n "$daemon_idle_ttl" ]]; then
  link_install_args+=(--daemon-idle-ttl "$daemon_idle_ttl")
fi
link_install_args+=(--force)

"${link_command[@]}" "${link_install_args[@]}" >/dev/null

printf 'linked %s -> %s\n' 'board-webmcp-cli' "$link_value"
printf 'profile %s\n' "$profile"
