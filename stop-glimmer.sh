#!/usr/bin/env bash

PORT="${GLIMMER_PORT:-8080}"

PIDS="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"

if [ -z "$PIDS" ]; then
    echo "Ingen server kjører på port $PORT."
    exit 0
fi

for PID in $PIDS; do

    CMD="$(ps -p "$PID" -o command= 2>/dev/null || true)"

    if [[ "$CMD" == *"llama-server"* ]]; then
        echo "Stopper llama-server PID $PID..."
        kill "$PID"
    else
        echo "Port $PORT brukes av en annen prosess:"
        echo "$CMD"
        echo "Stopper den ikke."
    fi

done
