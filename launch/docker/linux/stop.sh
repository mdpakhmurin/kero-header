#!/bin/sh
set -eu
cd -- "$(dirname -- "$0")/../../.."

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed." >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose is required." >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running or your user has no access to it." >&2
  exit 1
fi

docker compose down
echo "Kero Header is stopped. Your data is preserved."
