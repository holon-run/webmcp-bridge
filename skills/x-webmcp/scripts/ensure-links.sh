#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

filtered_args=()
while (($#)); do
  case "$1" in
    --name|--site|--adapter-module|--url)
      shift
      if (($#)) && [[ "$1" != --* ]]; then
        shift
      fi
      ;;
    --name=*|--site=*|--adapter-module=*|--url=*)
      shift
      ;;
    *)
      filtered_args+=("$1")
      shift
      ;;
  esac
done

if ((${#filtered_args[@]} > 0)); then
  exec "${ROOT_DIR}/skills/webmcp-bridge/scripts/ensure-links.sh" --name x --site x "${filtered_args[@]}"
fi

exec "${ROOT_DIR}/skills/webmcp-bridge/scripts/ensure-links.sh" --name x --site x
