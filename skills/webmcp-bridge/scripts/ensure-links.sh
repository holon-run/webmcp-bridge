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

remove_file_if_exists() {
  local path="$1"
  if [[ -n "$path" && ( -e "$path" || -L "$path" ) && -L "$path" ]]; then
    rm -f "$path"
  fi
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
daemon_idle_ttl="${WEBMCP_DAEMON_IDLE_TTL:-}"

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

link_name="${name}-webmcp-cli"
legacy_ui_link_name="${name}-webmcp-ui"
link_command=(uxc link)
if [[ -n "$link_dir" ]]; then
  mkdir -p "$link_dir"
  link_command+=(--dir "$link_dir")
fi

read -r -a launcher_parts <<< "$local_mcp_command"
link_args=("${launcher_parts[@]}" "${source_args[@]}" --headless --no-auto-login-fallback --user-data-dir "$profile")

link_value="$(shell_join "${link_args[@]}")"

link_install_args=("$link_name" "$link_value" --daemon-exclusive "$profile")
if [[ -n "$daemon_idle_ttl" ]]; then
  link_install_args+=(--daemon-idle-ttl "$daemon_idle_ttl")
fi
link_install_args+=(--force)

"${link_command[@]}" "${link_install_args[@]}" >/dev/null

if [[ -n "$link_dir" ]]; then
  remove_file_if_exists "$link_dir/$legacy_ui_link_name"
else
  remove_file_if_exists "$HOME/.local/bin/$legacy_ui_link_name"
fi

printf 'linked %s -> %s\n' "$link_name" "$link_value"
printf 'profile %s\n' "$profile"
