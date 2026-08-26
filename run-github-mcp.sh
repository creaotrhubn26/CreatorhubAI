#!/usr/bin/env bash

set -euo pipefail

IMAGE="ghcr.io/github/github-mcp-server:v1.11.0"

for command in gh docker; do
    if ! command -v "$command" >/dev/null 2>&1; then
        echo "GitHub MCP requires $command on PATH." >&2
        exit 1
    fi
done

if ! docker info >/dev/null 2>&1; then
    echo "GitHub MCP requires a running Docker daemon." >&2
    exit 1
fi

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "GitHub MCP image is not installed: $IMAGE" >&2
    echo "Pull the pinned image explicitly before enabling this integration." >&2
    exit 1
fi

GITHUB_PERSONAL_ACCESS_TOKEN="$(gh auth token --hostname github.com)"
export GITHUB_PERSONAL_ACCESS_TOKEN

exec docker run --interactive --rm \
    --env GITHUB_PERSONAL_ACCESS_TOKEN \
    --env GITHUB_READ_ONLY=1 \
    --env GITHUB_LOCKDOWN_MODE=1 \
    --env GITHUB_TOOLSETS=context,repos,pull_requests,actions,code_security \
    "$IMAGE"
