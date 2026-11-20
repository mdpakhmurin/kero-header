#!/bin/sh
set -eu
cd -- "$(dirname -- "$0")/../../.."

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed. Install Docker with Compose and try again." >&2
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

docker compose up -d --build --wait --wait-timeout 90
echo
echo "Kero Header is running. Published address:"
docker compose port editor 3210
echo "Open http://localhost at the port shown above, or PUBLIC_ORIGIN from .env."
echo "Use sh launch/docker/linux/stop.sh to stop the editor."
