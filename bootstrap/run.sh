#!/usr/bin/env bash
# Prompt City: the shootout (/play: a 3D team shooter, third and first person, one city for up to 100 players online,
# game server in game/), the arena (/arena), /job in one command, prices from PICK_PRICES / MINT_PRICE_USD, the Solana
# Explorer link on devnet.
# Run by .github/workflows/bootstrap.yml: applies the change, runs the tests, commits and pushes, removes bootstrap/.
set -euo pipefail
[ -f bootstrap/shoot.b64 ] || { echo "bootstrap/shoot.b64 is missing: upload both files in one commit"; exit 1; }
base64 -d bootstrap/shoot.b64 | gunzip | git apply --whitespace=nowarn -
npm ci
node -e "import('./server/src/assets.js').then((m) => console.log(m.unpackCollection(process.cwd())))"
npm test
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add -A -- . ':!bootstrap'
git commit -m 'The shootout: a 3D team shooter for Citizens (game/ on Cloudflare), the arena, /job in one command, $2 prices' \
  -m '/play: a 3D city by the bay (three.js), the camera behind the shoulder or first person (V); the Citizen wears its NFT face and outfit. One map, up to 100 players online, a wait for a seat when full. Two crews, rounds of 2:30; WASD like a shooter, mouse look, click, R, Tab score, a radar; a bullet by stars 14/17/20/25/34 of 100 HP; kills in live rounds reported by the game server (signed) and paid like arena kills. /arena: one fighter per account (a Citizen it owns), damage by stars (10/12/14/17/20 of 100 HP); a kill pays 50 $PROMPT x victim stars / killer stars (+10% a kill in a row), at most 1,500 a day and 3 paid kills of one victim a day; the season top 10 (airdrop at the token launch). /arena-city in the chat. /job pays at once, no choices. The Solana Explorer link for Citizens on devnet.' \
  -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E9VTZtyfQvzndJy2BngB9P'
git push
rm -rf bootstrap
echo done
