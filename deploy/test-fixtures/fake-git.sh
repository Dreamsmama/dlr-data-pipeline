#!/usr/bin/env bash
set -u

count=0
if [[ -f "$COUNTER_FILE" ]]; then
  count="$(< "$COUNTER_FILE")"
fi
count=$((count + 1))
printf '%s' "$count" > "$COUNTER_FILE"
printf '%s\n' "$*" >> "$ARGS_FILE"
if (( count <= FAIL_UNTIL )); then
  exit 7
fi
