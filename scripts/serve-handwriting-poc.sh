#!/usr/bin/env bash
set -euo pipefail

script_dir=${BASH_SOURCE[0]%/*}
if [[ "$script_dir" == "${BASH_SOURCE[0]}" ]]; then
  script_dir=.
fi
repo_root=$(cd -- "$script_dir/.." && pwd -P)
web_dir="$repo_root/web-client"
lock_file="$web_dir/package-lock.json"
lock_stamp="$web_dir/node_modules/.ppoker-digits-poc-package-lock.sha256"

for command_name in node npm; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$command_name" >&2
    exit 1
  fi
done

node -e '
  const [major, minor, patch] = process.versions.node.split(".").map(Number);
  const supported =
    (major === 22 && (minor > 22 || (minor === 22 && patch >= 2))) ||
    (major === 24 && minor >= 15) ||
    major === 26;
  if (!supported) {
    console.error(`Node ${process.versions.node} is unsupported; use Node ^22.22.2 || ^24.15.0 || >=26.0.0 <27`);
    process.exit(1);
  }
'

npm_version=$(npm --version)
if [[ "$npm_version" != 12.0.* ]]; then
  printf 'npm %s is unsupported; use npm 12.0.x (locked version: 12.0.0)\n' "$npm_version" >&2
  exit 1
fi

lock_hash=$(node -e '
  const { createHash } = require("node:crypto");
  const { readFileSync } = require("node:fs");
  process.stdout.write(createHash("sha256").update(readFileSync(process.argv[1])).digest("hex"));
' "$lock_file")

dependencies_current=false
if [[ -r "$lock_stamp" ]] &&
  [[ "$(<"$lock_stamp")" == "$lock_hash" ]] &&
  [[ -x "$web_dir/node_modules/.bin/vite" ]] &&
  npm --prefix "$web_dir" ls --all --silent >/dev/null 2>&1; then
  dependencies_current=true
fi

if [[ "$dependencies_current" == false ]]; then
  printf 'Installing locked web dependencies with npm ci...\n'
  npm --prefix "$web_dir" ci
  printf '%s\n' "$lock_hash" >"$lock_stamp"
else
  printf 'Locked web dependencies are current.\n'
fi

printf 'Building the handwriting POC and preparing self-hosted ORT assets...\n'
npm --prefix "$web_dir" run build

printf 'Starting the handwriting POC on the LAN; use a Network URL printed by Vite on the phone.\n'
cd -- "$web_dir"
exec "$web_dir/node_modules/.bin/vite" preview --host 0.0.0.0 "$@"
