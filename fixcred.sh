#!/usr/bin/env bash
# approve the stored token into git's credential helper for the correct owner
read -r TOKEN < /c/Users/ankit/AppData/Local/Temp/tok.txt
printf 'protocol=https\nhost=github.com\nusername=CodesFromAnkit\npassword=%s\n\n' "$TOKEN" | git credential approve
echo "credential approved for CodesFromAnkit@github.com"
