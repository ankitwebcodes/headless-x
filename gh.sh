#!/usr/bin/env bash
# helper: curl the GitHub API with the stored token (token read from file, never on the command line)
read -r TOKEN < /c/Users/ankit/AppData/Local/Temp/tok.txt
curl.exe -sS -H "Authorization: token $TOKEN" "$@"
