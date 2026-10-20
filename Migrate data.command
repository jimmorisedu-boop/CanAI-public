#!/bin/zsh
# Double-click to copy boards, files, and the key from an older CanAI folder.
cd "$(dirname "$0")"
./migrate-data.command
exit_code=$?
print -r -- ""
read -k 1 "?Press any key…"
exit $exit_code
