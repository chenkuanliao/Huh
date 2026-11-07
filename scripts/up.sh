#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
args=(-f compose.yaml)
if [[ -f compose.host-gpu.yaml ]]; then
  args+=(-f compose.host-gpu.yaml)
fi
docker compose "${args[@]}" up -d --build "$@"
