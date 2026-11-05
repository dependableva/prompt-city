#!/usr/bin/env bash
# Prompt City: the "Today's job" box on the site reads as one paragraph again. Run by .github/workflows/bootstrap.yml.
set -euo pipefail
git apply --whitespace=nowarn - <<'PATCH'
diff --git a/site/index.html b/site/index.html
index 5065647..fff53dc 100644
--- a/site/index.html
+++ b/site/index.html
@@ -148,5 +148,6 @@ select { background: var(--panel); color: var(--cream); border: 2px solid var(--
 .city .story { color: var(--cream); line-height: 1.5; }
 .city .ways { display: flex; flex-wrap: wrap; gap: 6px; }
-.city .ways code, .city .cmd code { color: var(--gold); font-weight: 700; }
+.city .ways code, .city .how code { color: var(--gold); font-weight: 700; }
+.city .how { line-height: 1.6; }
 .city ol { margin: 0; padding-left: 20px; display: grid; gap: 4px; }
 .city li { color: var(--cream); } .city li small { color: var(--dim); }
@@ -651,5 +652,5 @@ async function loadCity() {
     el('cJob').innerHTML = `<h3>Today's job</h3><b class="px" style="font-size:18px">${esc(job.title)}</b><div class="story">${esc(job.story)}</div>
       <div class="ways">${job.approaches.map((a) => `<a class="btn ghost" href="${claudeLink('/job ' + a.key)}" target="_blank" rel="noopener" title="${esc(a.does)}">${esc(a.label)}</a>`).join('')}</div>
-      <div class="note cmd">type <code>/job</code> in your AI · XP raises your wanted level: ${job.levels.map((x, i) => `${'★'.repeat(i + 1)} ${x.toLocaleString('en-US')}`).join(' · ')} XP.
+      <div class="note how">type <code>/job</code> in your AI · XP raises your wanted level: ${job.levels.map((x, i) => `${'★'.repeat(i + 1)} ${x.toLocaleString('en-US')}`).join(' · ')} XP.
         Pick a Citizen by its looks (<code>/find-city</code>, Street ${fmt(job.pick_prices.Street)} … Legend ${fmt(job.pick_prices.Legend)} $CASH), craft 3 into 1 (<code>/craft-city</code>, ${fmt(job.craft_fee)} $CASH)${job.export.enabled ? `, take one to Solana (<code>/export-city</code>, ${fmt(job.export.fee)} $CASH)` : ''}.</div>`;
   }
PATCH
npm ci
node -e "import('./server/src/assets.js').then((m) => console.log(m.unpackCollection(process.cwd())))"
npm test
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add -A -- . ':!bootstrap'
git commit -m "Site: the Today's job box reads as one paragraph" \
  -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E9VTZtyfQvzndJy2BngB9P'
git push
rm -rf bootstrap
echo done
