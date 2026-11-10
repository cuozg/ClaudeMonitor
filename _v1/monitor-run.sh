#!/bin/sh
# Run claude-monitor.py in watch mode for project dir $1.
# Retries while the project has no session log yet (first `claude` run in a new dir).
while ! python3 "$HOME/.claude/monitor/_v1/claude-monitor.py" "${1:-$PWD}" -w; do sleep 2; clear; done
