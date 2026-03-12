#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf '[webmcp-bridge] error: %s\n' "$*" >&2
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

name=""
url=""
site=""
adapter_module=""
profile=""
browser=""
link_dir=""
local_mcp_command="${WEBMCP_LOCAL_MCP_COMMAND:-npx -y @webmcp-bridge/local-mcp}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)
      [[ $# -ge 2 ]] || fail 'missing value for --name'
      name="$2"
      shift 2
      ;;
    --url)
      [[ $# -ge 2 ]] || fail 'missing value for --url'
      url="$2"
      shift 2
      ;;
    --site)
      [[ $# -ge 2 ]] || fail 'missing value for --site'
      site="$2"
      shift 2
      ;;
    --adapter-module)
      [[ $# -ge 2 ]] || fail 'missing value for --adapter-module'
      adapter_module="$2"
      shift 2
      ;;
    --profile)
      [[ $# -ge 2 ]] || fail 'missing value for --profile'
      profile="$2"
      shift 2
      ;;
    --browser)
      [[ $# -ge 2 ]] || fail 'missing value for --browser'
      browser="$2"
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

[[ -n "$name" ]] || fail 'missing required --name'
[[ "$name" =~ ^[a-z0-9][a-z0-9-]*$ ]] || fail 'name must match ^[a-z0-9][a-z0-9-]*$'

if [[ -n "$site" && -n "$adapter_module" ]]; then
  fail 'use either --site or --adapter-module, not both'
fi
if [[ -z "$site" && -z "$adapter_module" && -z "$url" ]]; then
  fail 'missing source: provide --url or one of --site/--adapter-module'
fi
if [[ -z "$profile" ]]; then
  profile="$HOME/.uxc/webmcp-profile/$name"
fi
mkdir -p "$profile"

source_args=()
if [[ -n "$site" ]]; then
  source_args+=(--site "$site")
fi
if [[ -n "$adapter_module" ]]; then
  source_args+=(--adapter-module "$adapter_module")
fi
if [[ -n "$url" ]]; then
  source_args+=(--url "$url")
fi
if [[ -n "$browser" ]]; then
  source_args+=(--browser "$browser")
fi

cli_name="${name}-webmcp-cli"
ui_name="${name}-webmcp-ui"
link_command=(uxc link)
if [[ -n "$link_dir" ]]; then
  mkdir -p "$link_dir"
  link_command+=(--dir "$link_dir")
fi

read -r -a launcher_parts <<< "$local_mcp_command"
cli_args=("${launcher_parts[@]}" "${source_args[@]}" --headless --no-auto-login-fallback --user-data-dir "$profile")
ui_args=("${launcher_parts[@]}" "${source_args[@]}" --no-headless --user-data-dir "$profile")

cli_command="$(shell_join "${cli_args[@]}")"
ui_command="$(shell_join "${ui_args[@]}")"

"${link_command[@]}" "$cli_name" "$cli_command" --daemon-exclusive "$profile" --force >/dev/null
"${link_command[@]}" "$ui_name" "$ui_command" --daemon-exclusive "$profile" --force >/dev/null

printf 'linked %s -> %s\n' "$cli_name" "$cli_command"
printf 'linked %s -> %s\n' "$ui_name" "$ui_command"
printf 'profile %s\n' "$profile"
