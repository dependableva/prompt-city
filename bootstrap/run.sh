#!/usr/bin/env bash
# Prompt City update: the token is renamed $PROMPT, and the game arrives (daily job and wanted level, crews, picking a
# Citizen by its looks, district drops, crafting 3 into 1, Citizens to Solana). Run by .github/workflows/bootstrap.yml:
# it renames, applies the patch, runs the tests, commits and pushes, then removes bootstrap/ (the workflow commits that).
set -euo pipefail
bash bootstrap/rename.sh
base64 -d bootstrap/changes.b64 | gunzip | git apply --whitespace=nowarn -
npm ci
node -e "import('./server/src/assets.js').then((m) => console.log(m.unpackCollection(process.cwd())))"
npm test
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add -A -- . ':!bootstrap'
git commit -m 'The game: $PROMPT, daily jobs and the wanted level, crews, picks, district drops, crafting, Citizens to Solana' \
  -m 'The token is $PROMPT (was $HEIST; /claimprompt). /job: a daily job for XP and $PROMPT; the wanted level (stars) gives pick discounts and opens Kingpin and Legend picks. /crew-city: crews and leaderboards. /find-city and /pick-city: mint exactly the Citizen you want at the price of its rarity. DISTRICTS: districts open for minting one by one. /craft-city: 3 Citizens of one rarity into 1 of the next. /export-city: a Citizen to a Solana wallet as a Metaplex Core NFT (EXPORT_KEY).' \
  -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E9VTZtyfQvzndJy2BngB9P'
git push
rm -rf bootstrap
echo "Prompt City update applied"
