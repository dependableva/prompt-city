#!/usr/bin/env bash
# Prompt City: guns by stars in the shootout and smoother movement. Run by .github/workflows/bootstrap.yml: applies the
# change, runs the tests, commits and pushes, removes bootstrap/.
set -euo pipefail
[ -f bootstrap/guns.b64 ] || { echo "bootstrap/guns.b64 is missing"; exit 1; }
base64 -d bootstrap/guns.b64 | gunzip | git apply --whitespace=nowarn -
npm ci
node -e "import('./server/src/assets.js').then((m) => console.log(m.unpackCollection(process.cwd())))"
npm test
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add -A -- . ':!bootstrap'
git commit -m 'The shootout: a gun for each number of stars, smoother movement' \
  -m 'Street a pistol, Hustler an SMG, Boss a shotgun (7 pellets), Kingpin an assault rifle, Legend a marksman rifle: more stars, more damage a second; each with its own look, sound and magazine. The page compares the server position with where it was when it sent the input the server applied (numbered inputs), instead of pulling toward a position a ping old; it shows fps and ping and switches to fast graphics by itself on a slow computer.' \
  -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E9VTZtyfQvzndJy2BngB9P'
git push
rm -rf bootstrap
echo done
