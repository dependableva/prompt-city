#!/usr/bin/env bash
# Prompt City: the token is $PROMPT (was $PROMT); /claimprompt. Run by .github/workflows/bootstrap.yml: renames, runs
# the tests, commits and pushes, then removes bootstrap/ (the workflow commits that).
set -euo pipefail
files=$(grep -rIl -E '\$PROMT|%24PROMT|claimpromt' --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.github --exclude-dir=bootstrap . || true)
[ -z "$files" ] || echo "$files" | xargs sed -i -e 's/\$PROMT/$PROMPT/g' -e 's/%24PROMT/%24PROMPT/g' -e 's/claimpromt/claimprompt/g'
sed -i -e 's/|\\$?\\bPROMT\\b|/|/' -e 's/the words PROMT, PROMPT, CASH/the words PROMPT, CASH/' server/src/credit.js
npm ci
node -e "import('./server/src/assets.js').then((m) => console.log(m.unpackCollection(process.cwd())))"
npm test
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add -A -- . ':!bootstrap'
if git diff --cached --quiet; then
  echo "nothing to change: the token is already \$PROMPT"
else
  git commit -m 'The token is $PROMPT (was $PROMT); /claimprompt' \
    -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E9VTZtyfQvzndJy2BngB9P'
  git push
fi
rm -rf bootstrap
echo "done: \$PROMPT"
