#!/bin/sh
set -eu
cd -- "$(dirname -- "$0")/../../.."
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22.13 or newer is required." >&2
  exit 1
fi
exec node server.mjs
