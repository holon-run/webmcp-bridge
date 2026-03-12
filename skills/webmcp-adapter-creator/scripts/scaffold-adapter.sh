#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf '[webmcp-adapter-creator] error: %s\n' "$*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TEMPLATE_DIR="${ROOT_DIR}/examples/adapter-template"

need_cmd cp
need_cmd mkdir
need_cmd perl

name=""
host=""
url=""
out_dir=""
display_name=""
package_name=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)
      [[ $# -ge 2 ]] || fail 'missing value for --name'
      name="$2"
      shift 2
      ;;
    --host)
      [[ $# -ge 2 ]] || fail 'missing value for --host'
      host="$2"
      shift 2
      ;;
    --url)
      [[ $# -ge 2 ]] || fail 'missing value for --url'
      url="$2"
      shift 2
      ;;
    --dir)
      [[ $# -ge 2 ]] || fail 'missing value for --dir'
      out_dir="$2"
      shift 2
      ;;
    --display-name)
      [[ $# -ge 2 ]] || fail 'missing value for --display-name'
      display_name="$2"
      shift 2
      ;;
    --package-name)
      [[ $# -ge 2 ]] || fail 'missing value for --package-name'
      package_name="$2"
      shift 2
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

[[ -n "$name" ]] || fail 'missing required --name'
[[ "$name" =~ ^[a-z0-9][a-z0-9-]*$ ]] || fail 'name must match ^[a-z0-9][a-z0-9-]*$'
[[ -n "$host" ]] || fail 'missing required --host'
[[ -n "$url" ]] || fail 'missing required --url'

if [[ -z "$out_dir" ]]; then
  out_dir="${ROOT_DIR}/packages/adapter-${name}"
fi
if [[ -z "$display_name" ]]; then
  display_name="$name"
fi
if [[ -z "$package_name" ]]; then
  package_name="@webmcp-bridge/adapter-${name}"
fi

[[ ! -e "$out_dir" ]] || fail "output path already exists: $out_dir"
mkdir -p "$out_dir/src"

cp "${TEMPLATE_DIR}/package.json" "$out_dir/package.json"
cp "${TEMPLATE_DIR}/tsconfig.json" "$out_dir/tsconfig.json"
cp "${TEMPLATE_DIR}/src/index.ts" "$out_dir/src/index.ts"

LC_ALL=C perl -0pi -e "s#\Q@webmcp-bridge/example-adapter-template\E#${package_name}#g" "$out_dir/package.json"
LC_ALL=C perl -0pi -e "s#\Qadapter-template\E#adapter-${name}#g" "$out_dir/src/index.ts"
LC_ALL=C perl -0pi -e "s#\QAdapter Template\E#${display_name}#g" "$out_dir/src/index.ts"
LC_ALL=C perl -0pi -e "s#\Qexample.com\E#${host}#g" "$out_dir/src/index.ts"
LC_ALL=C perl -0pi -e "s#\Qhttps://example.com\E#${url}#g" "$out_dir/src/index.ts"

printf 'scaffolded %s\n' "$out_dir"
printf 'package %s\n' "$package_name"
printf 'next: edit %s/src/index.ts\n' "$out_dir"
