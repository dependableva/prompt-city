#!/usr/bin/env bash
# Prompt City: /find-city shows the looks asked for (and the district once); the connector names itself prompt-city.
# Run by .github/workflows/bootstrap.yml: applies the change, runs the tests, commits and pushes, removes bootstrap/.
set -euo pipefail
git apply --whitespace=nowarn - <<'PATCH'
diff --git a/server/src/mcp.js b/server/src/mcp.js
index b2ac42c..3767762 100644
--- a/server/src/mcp.js
+++ b/server/src/mcp.js
@@ -105,5 +105,5 @@ export function transferTokenOk(userId, token) {
 export function buildMcpServer(db, userId, opts) {
   const { publicUrl, thumbsDir, deposits, withdrawals } = opts;
-  const server = new McpServer({ name: 'mcp-market', version: '0.3.0' }, { instructions: INSTRUCTIONS });
+  const server = new McpServer({ name: 'prompt-city', version: '0.3.0' }, { instructions: INSTRUCTIONS });
   const link = (id) => `${publicUrl}/nft/${id}`;
   // the NFT picture as image content, so the chat shows it inline. Read from disk; if the file isn't
@@ -174,4 +174,11 @@ export function buildMcpServer(db, userId, opts) {
     `${n.rarity ? ` · ${n.rarity}` : ''}${keyTraits(n) ? ` · ${keyTraits(n)}` : ''}` +
     (n.owner_addr ? ` · owner ${m.label(n.owner_addr, n.owner_name)}` : n.burned_at ? ' · burned' : n.exported_at ? ' · on Solana' : ' · not minted yet') + (n.price != null ? ` · listed at ${m.fmt(n.price)}` : '');
+  // a found Citizen's looks in one line: the traits asked for first, then the rest (not its rarity or district)
+  const lookOf = (n, pairs = []) => {
+    const asked = new Set(pairs.map(([t]) => String(t).toLowerCase()));
+    const rest = (n.attributes || []).filter((a) => a.trait_type !== 'Rarity' && a.trait_type !== 'Turf');
+    const first = rest.filter((a) => asked.has(String(a.trait_type).toLowerCase()));
+    return [...first, ...rest.filter((a) => !first.includes(a))].slice(0, Math.max(5, first.length)).map((a) => a.value).join(', ');
+  };
   const traitLines = (n) => (n.attributes || []).map((a) => `${a.trait_type}: ${a.value}${a.percent != null ? ` (${a.percent}% have it)` : ''}`).join('\n');
 
@@ -509,5 +516,5 @@ export function buildMcpServer(db, userId, opts) {
     return {
       ...ok(text(`${r.total.toLocaleString('en-US')} free Citizen${r.total === 1 ? '' : 's'} match. ${r.total > r.items.length ? `${r.items.length} of them:` : ''}\n` +
-        r.items.map((n) => `#${n.id} ${n.rarity} · ${turfOf(n.attributes)} · ${keyTraits(n)} · pick for ${priceOf(n)}`).join('\n') +
+        r.items.map((n) => `#${n.id} ${n.rarity} · ${turfOf(n.attributes)} · ${lookOf(n, pairs)} · pick for ${priceOf(n)}`).join('\n') +
         `\n\nYou are ${w.stars || '-'}${w.discount ? ` (${w.discount}% off picks)` : ''}. Pick one: /pick-city <number>`)),
       ...await card({ view: 'many', title: 'Free to pick', subtitle: `${r.total.toLocaleString('en-US')} match`, total: r.total }, items.map(cardItem)),
diff --git a/server/test/game.test.js b/server/test/game.test.js
index bdb8963..bafe17b 100644
--- a/server/test/game.test.js
+++ b/server/test/game.test.js
@@ -188,4 +188,10 @@ test('pick: find by looks, pay the price of the rarity less the level discount,
   assert.match(t.text, /free Citizens? match/);
   assert.match(t.text, /pick for 15 \$CASH/);
+  // the line shows the look asked for, and the district only once
+  for (const l of t.text.split('\n').filter((x) => /^#\d+ Boss/.test(x))) {
+    assert.match(l, /^#\d+ Boss · [^·]+ · Gold Chain[,· ]/, l);
+    const turf = l.split(' · ')[1];
+    assert.equal(l.split(turf).length - 1, 1, l);
+  }
   const pick = found.items[0];
   const before = Number(u.balance);
PATCH
npm ci
node -e "import('./server/src/assets.js').then((m) => console.log(m.unpackCollection(process.cwd())))"
npm test
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add -A -- . ':!bootstrap'
git commit -m '/find-city: the looks asked for first, the district once; the server is prompt-city' \
  -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E9VTZtyfQvzndJy2BngB9P'
git push
rm -rf bootstrap
echo done
