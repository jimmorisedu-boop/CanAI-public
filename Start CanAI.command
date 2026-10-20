#!/bin/zsh
# Double-click this file in Finder to start CanAI.
# The implementation is in start.command, just as Windows uses start.ps1.
cd "$(dirname "$0")"
./start.command
exit_code=$?
print -r -- ""
print -r -- "You can close this window."
read -k 1 "?Press any key…"
exit $exit_code
