#!/usr/bin/env bash

ROOT="$HOME/AI/muse-glimmer"
PORT="${GLIMMER_PORT:-8080}"

if ! lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Muse Glimmer kjører ikke."
    exit 1
fi

echo "Muse Glimmer kjører."
echo
curl -s "http://127.0.0.1:$PORT/health"
echo
