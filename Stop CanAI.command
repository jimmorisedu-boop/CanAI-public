#!/bin/zsh
# Double-click this file to stop CanAI.
cd "$(dirname "$0")"
./stop.command
exit_code=$?
print -r -- ""
read -k 1 "?Press any key…"
exit $exit_code
