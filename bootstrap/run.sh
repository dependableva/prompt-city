#!/usr/bin/env bash
# Prompt City: the token is $PROMT (was $PROMPT; /claimpromt). Run by .github/workflows/bootstrap.yml: renames, runs
# the tests, commits and pushes, then removes bootstrap/ (the workflow commits that).
set -euo pipefail
[ -f server/src/game.js ] || { echo "the game is not on main yet: nothing done"; exit 1; }
files=$(grep -rIl -E '\$PROMPT|%24PROMPT|claimprompt' --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.github --exclude-dir=bootstrap . || true)
[ -z "$files" ] || echo "$files" | xargs sed -i -e 's/\$PROMPT/$PROMT/g' -e 's/%24PROMPT/%24PROMT/g' -e 's/claimprompt/claimpromt/g'
# promo codes: the word PROMT around a code is dropped too ("FREE 1000 $PROMT" means FREE1000)
grep -q 'bPROMT' server/src/credit.js || sed -i -e 's/|\\$?\\bPROMPT\\b|/|\\$?\\bPROMPT\\b|\\$?\\bPROMT\\b|/' \
  -e 's/the words PROMPT, CASH/the words PROMT, PROMPT, CASH/' server/src/credit.js
grep -q 'bPROMT' server/src/credit.js || { echo "credit.js: the PROMT word was not added"; exit 1; }
npm ci
node -e "import('./server/src/assets.js').then((m) => console.log(m.unpackCollection(process.cwd())))"
npm test
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add -A -- . ':!bootstrap'
if git diff --cached --quiet; then
  echo "nothing to change: the token is already \$PROMT"
else
  git commit -m 'The token is $PROMT (was $PROMPT); /claimpromt' \
    -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E9VTZtyfQvzndJy2BngB9P'
  git push
fi
rm -rf bootstrap
echo "done: \$PROMT"
